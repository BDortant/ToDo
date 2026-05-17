// =============================================================
// DB layer — SQLite via better-sqlite3 (synchronous).
//
// All write logic that used to live in the browser
// (priority shifting on Done, recurring task spawn, cleanup of
// old Done items) is owned here so it is consistent regardless
// of whether the change came from the web UI or the PocketDev
// chat tool.
// =============================================================
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

let db;

export function initDb(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, 'todo.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS todos (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            project_id TEXT,
            status TEXT NOT NULL DEFAULT 'To Do',
            overall_priority INTEGER NOT NULL,
            project_priority INTEGER NOT NULL,
            effort TEXT,
            deadline TEXT,
            assignee TEXT,
            notes TEXT,
            tags TEXT NOT NULL DEFAULT '[]',
            created_date TEXT NOT NULL,
            completed_date TEXT,
            is_recurring INTEGER NOT NULL DEFAULT 0,
            recurring_weeks INTEGER NOT NULL DEFAULT 1,
            recurring_days TEXT NOT NULL DEFAULT '[]',
            previous_status TEXT,
            previous_overall_priority INTEGER,
            previous_project_priority INTEGER,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_todos_project ON todos(project_id);
        CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status);
    `);

    return db;
}

// --- Serialization helpers ---------------------------------------

function rowToTodo(row) {
    if (!row) return null;
    return {
        id: row.id,
        title: row.title,
        projectId: row.project_id ?? '',
        status: row.status,
        overallPriority: row.overall_priority,
        projectPriority: row.project_priority,
        effort: row.effort ?? '',
        deadline: row.deadline ?? '',
        assignee: row.assignee ?? '',
        notes: row.notes ?? '',
        tags: safeParseArray(row.tags),
        createdDate: row.created_date,
        completedDate: row.completed_date ?? null,
        isRecurring: !!row.is_recurring,
        recurringWeeks: row.recurring_weeks,
        recurringDays: safeParseArray(row.recurring_days),
        previousStatus: row.previous_status ?? undefined,
        previousOverallPriority: row.previous_overall_priority ?? undefined,
        previousProjectPriority: row.previous_project_priority ?? undefined
    };
}

function rowToProject(row) {
    if (!row) return null;
    return { id: row.id, name: row.name };
}

function safeParseArray(s) {
    try {
        const v = JSON.parse(s ?? '[]');
        return Array.isArray(v) ? v : [];
    } catch {
        return [];
    }
}

function generateId() {
    return Date.now().toString(36) + crypto.randomBytes(4).toString('hex').slice(0, 6);
}

// --- Read APIs ---------------------------------------------------

export function listProjects() {
    return db.prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE').all().map(rowToProject);
}

export function listTodos() {
    return db.prepare('SELECT * FROM todos ORDER BY overall_priority ASC').all().map(rowToTodo);
}

export function getState() {
    const lastBackupRow = db.prepare("SELECT value FROM meta WHERE key='last_backup'").get();
    return {
        projects: listProjects(),
        todos: listTodos(),
        lastBackup: lastBackupRow ? lastBackupRow.value : null
    };
}

export function getTodo(id) {
    return rowToTodo(db.prepare('SELECT * FROM todos WHERE id = ?').get(id));
}

export function getProject(id) {
    return rowToProject(db.prepare('SELECT * FROM projects WHERE id = ?').get(id));
}

// --- Project mutations ------------------------------------------

export function createProject({ name }) {
    if (!name || !String(name).trim()) throw new HttpError(400, 'Project name is required');
    const id = generateId();
    db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run(id, String(name).trim());
    return getProject(id);
}

export function patchProject(id, patch) {
    const existing = getProject(id);
    if (!existing) throw new HttpError(404, 'Project not found');
    if (patch.name != null) {
        const trimmed = String(patch.name).trim();
        if (!trimmed) throw new HttpError(400, 'Project name cannot be empty');
        db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(trimmed, id);
    }
    return getProject(id);
}

export function deleteProject(id) {
    const tx = db.transaction(() => {
        const unassigned = db.prepare('SELECT id FROM todos WHERE project_id = ?').all(id).map(r => r.id);
        // FK ON DELETE SET NULL handles the cleanup, but we still report which ids were affected
        db.prepare('DELETE FROM projects WHERE id = ?').run(id);
        return unassigned;
    });
    const unassignedTodoIds = tx();
    return { ok: true, unassignedTodoIds };
}

// --- Todo create/update/delete ----------------------------------

const TODO_DEFAULTS = {
    status: 'To Do',
    effort: '',
    deadline: '',
    assignee: '',
    notes: '',
    tags: [],
    isRecurring: false,
    recurringWeeks: 1,
    recurringDays: []
};

export function createTodo(input) {
    if (!input || !input.title || !String(input.title).trim()) {
        throw new HttpError(400, 'Title is required');
    }

    const projectId = input.projectId || '';
    if (projectId && !getProject(projectId)) {
        // Allow lookup by name too, but the route layer should resolve that already.
        throw new HttpError(400, `Unknown projectId: ${projectId}`);
    }

    const status = input.status || TODO_DEFAULTS.status;
    const nowIso = new Date().toISOString();

    const id = input.id || generateId();
    const overallPriority = nextOverallPriority();
    const projectPriority = nextProjectPriority(projectId);

    const todo = {
        id,
        title: String(input.title).trim(),
        projectId,
        status,
        overallPriority,
        projectPriority,
        effort: input.effort ?? TODO_DEFAULTS.effort,
        deadline: input.deadline ?? TODO_DEFAULTS.deadline,
        assignee: typeof input.assignee === 'string' ? input.assignee.trim() : (input.assignee ?? ''),
        notes: input.notes ?? TODO_DEFAULTS.notes,
        tags: Array.isArray(input.tags) ? input.tags : TODO_DEFAULTS.tags,
        createdDate: nowIso,
        completedDate: status === 'Done' ? nowIso : null,
        isRecurring: !!input.isRecurring,
        recurringWeeks: clampWeeks(input.recurringWeeks),
        recurringDays: normalizeDays(input.recurringDays)
    };

    const tx = db.transaction(() => {
        insertTodoRow(todo);
        const spawned = (todo.status === 'Done' && todo.isRecurring) ? spawnNextRecurrence(todo) : null;
        if (todo.status === 'Done') shiftPriorityForDone(todo, true);
        return { todo: getTodo(todo.id), spawnedRecurrence: spawned ? getTodo(spawned.id) : null };
    });

    return tx();
}

export function patchTodo(id, patch) {
    const existing = getTodo(id);
    if (!existing) throw new HttpError(404, 'Todo not found');

    const tx = db.transaction(() => {
        const updates = {};
        let projectChanged = false;
        let newProjectPriority = existing.projectPriority;

        if (patch.title != null) updates.title = String(patch.title).trim();
        if (patch.effort !== undefined) updates.effort = patch.effort ?? '';
        if (patch.deadline !== undefined) updates.deadline = patch.deadline ?? '';
        if (patch.assignee !== undefined) {
            const a = patch.assignee ?? '';
            updates.assignee = (typeof a === 'string') ? a.trim() : a;
        }
        if (patch.notes !== undefined) updates.notes = patch.notes ?? '';
        if (patch.tags !== undefined) updates.tags = JSON.stringify(Array.isArray(patch.tags) ? patch.tags : []);
        if (patch.isRecurring !== undefined) updates.is_recurring = patch.isRecurring ? 1 : 0;
        if (patch.recurringWeeks !== undefined) updates.recurring_weeks = clampWeeks(patch.recurringWeeks);
        if (patch.recurringDays !== undefined) updates.recurring_days = JSON.stringify(normalizeDays(patch.recurringDays));

        if (patch.projectId !== undefined && patch.projectId !== existing.projectId) {
            if (patch.projectId && !getProject(patch.projectId)) {
                throw new HttpError(400, `Unknown projectId: ${patch.projectId}`);
            }
            updates.project_id = patch.projectId || null;
            // Put it at the end of the new project's list
            newProjectPriority = nextProjectPriority(patch.projectId || '');
            updates.project_priority = newProjectPriority;
            projectChanged = true;
        }

        // Status handling — auto completedDate + recurring spawn + priority shift
        let spawnedRecurrence = null;
        let priorityShifted = false;

        if (patch.status !== undefined && patch.status !== existing.status) {
            const newStatus = patch.status;
            updates.status = newStatus;

            const becameDone = newStatus === 'Done' && existing.status !== 'Done';
            const leftDone = existing.status === 'Done' && newStatus !== 'Done';

            if (becameDone) {
                updates.completed_date = new Date().toISOString();
                updates.previous_status = existing.status;
            } else if (leftDone) {
                updates.completed_date = null;
                updates.previous_status = null;
            }

            applyUpdates(id, updates);
            const after = getTodo(id);

            if (becameDone) {
                if (after.isRecurring) spawnedRecurrence = spawnNextRecurrence(after);
                shiftPriorityForDone(after, true);
                priorityShifted = true;
            } else if (leftDone) {
                shiftPriorityForDone(after, false);
                priorityShifted = true;
            }

            return {
                todo: getTodo(id),
                spawnedRecurrence: spawnedRecurrence ? getTodo(spawnedRecurrence.id) : null,
                priorityShifted,
                projectChanged
            };
        }

        applyUpdates(id, updates);
        return { todo: getTodo(id), spawnedRecurrence: null, priorityShifted: false, projectChanged };
    });

    return tx();
}

export function deleteTodo(id) {
    const existing = getTodo(id);
    if (!existing) throw new HttpError(404, 'Todo not found');
    db.prepare('DELETE FROM todos WHERE id = ?').run(id);
    return { ok: true, id };
}

// --- Priority shift (chat-friendly) ----------------------------
//
// Sets a todo's overallPriority (and projectPriority if it's in a
// project) to the requested integer position N, shifting every
// other todo to make room. 1 = top of the list.
// This is the single-todo cousin of reorderTodos — handy for the
// PocketDev chat tool which thinks in terms of "put this at #2".

export function setTodoPriority(id, newPriority) {
    const existing = getTodo(id);
    if (!existing) throw new HttpError(404, 'Todo not found');

    // Clamp the requested priority to the actual list bounds. Without
    // this, callers passing a too-large N create sparse rank values
    // (e.g. 1, 2, 999) and the contiguous-rank assumption breaks.
    const totalCount = db.prepare('SELECT COUNT(*) AS c FROM todos').get().c;
    const projectCount = existing.projectId
        ? db.prepare("SELECT COUNT(*) AS c FROM todos WHERE project_id = ?").get(existing.projectId).c
        : 0;
    const rawN = parseInt(newPriority, 10);
    const target = Math.max(1, Math.min(Number.isFinite(rawN) ? rawN : 1, Math.max(1, totalCount)));
    const targetProject = Math.max(1, Math.min(Number.isFinite(rawN) ? rawN : 1, Math.max(1, projectCount)));

    const tx = db.transaction(() => {
        const oldOverall = existing.overallPriority;

        if (target !== oldOverall) {
            if (target < oldOverall) {
                // Moving up: bump items in [target, old-1] down by 1
                db.prepare(`
                    UPDATE todos SET overall_priority = overall_priority + 1
                    WHERE id != ? AND overall_priority >= ? AND overall_priority < ?
                `).run(id, target, oldOverall);
            } else {
                // Moving down: shift items in [old+1, target] up by 1
                db.prepare(`
                    UPDATE todos SET overall_priority = overall_priority - 1
                    WHERE id != ? AND overall_priority > ? AND overall_priority <= ?
                `).run(id, oldOverall, target);
            }
            db.prepare('UPDATE todos SET overall_priority = ? WHERE id = ?').run(target, id);
        }

        // Mirror within the project too, if one is assigned.
        // Uses the project-specific clamp so a request like
        // "priority=10" on a project with 3 todos lands at #3, not #10.
        if (existing.projectId) {
            const oldProject = existing.projectPriority;
            if (targetProject !== oldProject) {
                if (targetProject < oldProject) {
                    db.prepare(`
                        UPDATE todos SET project_priority = project_priority + 1
                        WHERE id != ? AND project_id = ? AND project_priority >= ? AND project_priority < ?
                    `).run(id, existing.projectId, targetProject, oldProject);
                } else {
                    db.prepare(`
                        UPDATE todos SET project_priority = project_priority - 1
                        WHERE id != ? AND project_id = ? AND project_priority > ? AND project_priority <= ?
                    `).run(id, existing.projectId, oldProject, targetProject);
                }
                db.prepare('UPDATE todos SET project_priority = ? WHERE id = ?').run(targetProject, id);
            }
        }

        return getTodo(id);
    });
    return tx();
}

// --- Reorder ----------------------------------------------------

export function reorderTodos(updates) {
    if (!Array.isArray(updates)) throw new HttpError(400, 'Body must be an array');
    const tx = db.transaction(() => {
        const ids = [];
        for (const u of updates) {
            if (!u || !u.id) continue;
            const sets = [];
            const vals = [];
            if (u.overallPriority !== undefined) {
                sets.push('overall_priority = ?');
                vals.push(Number(u.overallPriority));
            }
            if (u.projectPriority !== undefined) {
                sets.push('project_priority = ?');
                vals.push(Number(u.projectPriority));
            }
            if (!sets.length) continue;
            vals.push(u.id);
            db.prepare(`UPDATE todos SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
            ids.push(u.id);
        }
        return ids.map(getTodo).filter(Boolean);
    });
    return tx();
}

// --- Cleanup ----------------------------------------------------

export function cleanupOldDone() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const cutoff = new Date(today);
    const dow = today.getDay();
    if (dow === 1) cutoff.setDate(cutoff.getDate() - 3);       // Mon -> Fri
    else if (dow === 0) cutoff.setDate(cutoff.getDate() - 2);  // Sun -> Fri
    else if (dow === 6) cutoff.setDate(cutoff.getDate() - 1);  // Sat -> Fri
    else cutoff.setDate(cutoff.getDate() - 1);                 // Weekday -> yesterday

    const cutoffIso = cutoff.toISOString();
    const rows = db.prepare("SELECT id FROM todos WHERE status='Done' AND completed_date IS NOT NULL AND completed_date < ?").all(cutoffIso);
    const ids = rows.map(r => r.id);
    if (ids.length) {
        const placeholders = ids.map(() => '?').join(',');
        db.prepare(`DELETE FROM todos WHERE id IN (${placeholders})`).run(...ids);
    }
    return { deletedIds: ids, cutoff: cutoffIso };
}

// --- Import / export -------------------------------------------

export function replaceState(state) {
    if (!state || typeof state !== 'object') throw new HttpError(400, 'Invalid state');
    const projects = Array.isArray(state.projects) ? state.projects : [];
    const todos = Array.isArray(state.todos) ? state.todos : [];

    const tx = db.transaction(() => {
        db.exec('DELETE FROM todos; DELETE FROM projects;');
        const insP = db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)');
        for (const p of projects) {
            if (!p || !p.id) continue;
            insP.run(p.id, String(p.name ?? ''));
        }
        for (const t of todos) {
            if (!t || !t.id) continue;
            insertTodoRow({
                id: t.id,
                title: t.title ?? '',
                projectId: t.projectId || '',
                status: t.status || 'To Do',
                overallPriority: Number.isFinite(t.overallPriority) ? t.overallPriority : nextOverallPriority(),
                projectPriority: Number.isFinite(t.projectPriority) ? t.projectPriority : 1,
                effort: t.effort ?? '',
                deadline: t.deadline ?? '',
                assignee: t.assignee ?? '',
                notes: t.notes ?? '',
                tags: Array.isArray(t.tags) ? t.tags : [],
                createdDate: t.createdDate || new Date().toISOString(),
                completedDate: t.completedDate || null,
                isRecurring: !!t.isRecurring,
                recurringWeeks: clampWeeks(t.recurringWeeks),
                recurringDays: normalizeDays(t.recurringDays)
            });
        }
        if (state.lastBackup) {
            db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_backup', ?)").run(state.lastBackup);
        }
        return { projectCount: projects.length, todoCount: todos.length };
    });

    return tx();
}

export function setLastBackup(iso) {
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_backup', ?)").run(iso);
}

// --- Internal helpers -------------------------------------------

function applyUpdates(id, updates) {
    const keys = Object.keys(updates);
    if (!keys.length) return;
    const sets = keys.map(k => `${k} = ?`).join(', ');
    const vals = keys.map(k => updates[k]);
    vals.push(id);
    db.prepare(`UPDATE todos SET ${sets} WHERE id = ?`).run(...vals);
}

function insertTodoRow(t) {
    db.prepare(`
        INSERT INTO todos (
            id, title, project_id, status, overall_priority, project_priority,
            effort, deadline, assignee, notes, tags,
            created_date, completed_date,
            is_recurring, recurring_weeks, recurring_days
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        t.id, t.title, t.projectId || null, t.status, t.overallPriority, t.projectPriority,
        t.effort || null, t.deadline || null, t.assignee || null, t.notes || null, JSON.stringify(t.tags || []),
        t.createdDate, t.completedDate || null,
        t.isRecurring ? 1 : 0, t.recurringWeeks, JSON.stringify(t.recurringDays || [])
    );
}

function nextOverallPriority() {
    const r = db.prepare('SELECT COUNT(*) AS c FROM todos').get();
    return r.c + 1;
}

function nextProjectPriority(projectId) {
    const r = db.prepare('SELECT COUNT(*) AS c FROM todos WHERE COALESCE(project_id, \'\') = ?').get(projectId || '');
    return r.c + 1;
}

function clampWeeks(v) {
    const n = parseInt(v, 10);
    if (Number.isNaN(n) || n < 1) return 1;
    return Math.min(n, 52);
}

function normalizeDays(v) {
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const d of v) {
        const n = parseInt(d, 10);
        if (Number.isInteger(n) && n >= 0 && n <= 6 && !out.includes(n)) out.push(n);
    }
    return out.sort((a, b) => a - b);
}

// --- Recurring spawn (ported from app.js spawnNextRecurrence) ---

function toLocalDateString(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function getNextMatchingDay(recurringDays) {
    const jsDayMap = [1, 2, 3, 4, 5, 6, 0]; // app 0=Mon..6=Sun -> JS getDay()
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = 0; i < 7; i++) {
        const candidate = new Date(today);
        candidate.setDate(candidate.getDate() + i);
        if (recurringDays.some(d => jsDayMap[d] === candidate.getDay())) {
            return toLocalDateString(candidate);
        }
    }
    return '';
}

function spawnNextRecurrence(todo) {
    if (!todo.isRecurring || !todo.recurringDays || todo.recurringDays.length === 0) return null;

    let baseDeadline = todo.deadline || getNextMatchingDay(todo.recurringDays);
    let newDeadline = '';

    if (baseDeadline) {
        const base = new Date(baseDeadline + 'T00:00:00');
        const baseAppDow = (base.getDay() + 6) % 7;
        const weeks = (Number.isInteger(todo.recurringWeeks) && todo.recurringWeeks > 0) ? todo.recurringWeeks : 1;
        const sortedDays = [...todo.recurringDays].sort((a, b) => a - b);
        const nextInWeek = sortedDays.find(d => d > baseAppDow);

        const candidate = new Date(base);
        if (nextInWeek !== undefined) {
            candidate.setDate(candidate.getDate() + (nextInWeek - baseAppDow));
        } else {
            const offset = -baseAppDow + weeks * 7 + sortedDays[0];
            candidate.setDate(candidate.getDate() + offset);
        }
        newDeadline = toLocalDateString(candidate);
    } else {
        newDeadline = getNextMatchingDay(todo.recurringDays);
    }

    const spawned = {
        id: generateId(),
        title: todo.title,
        projectId: todo.projectId || '',
        status: 'To Do',
        overallPriority: nextOverallPriority(),
        projectPriority: nextProjectPriority(todo.projectId || ''),
        effort: todo.effort || '',
        deadline: newDeadline,
        assignee: todo.assignee || '',
        notes: todo.notes || '',
        tags: Array.isArray(todo.tags) ? [...todo.tags] : [],
        createdDate: new Date().toISOString(),
        completedDate: null,
        isRecurring: true,
        recurringWeeks: todo.recurringWeeks,
        recurringDays: [...todo.recurringDays]
    };
    insertTodoRow(spawned);
    return spawned;
}

// --- Priority shift for Done (ported from movePriorityForDone) --

function shiftPriorityForDone(todo, markingDone) {
    if (markingDone) {
        // Save current priorities so we can restore later
        db.prepare(`
            UPDATE todos SET
                previous_overall_priority = overall_priority,
                previous_project_priority = project_priority
            WHERE id = ?
        `).run(todo.id);

        const oldOverall = todo.overallPriority;
        db.prepare('UPDATE todos SET overall_priority = overall_priority - 1 WHERE id != ? AND overall_priority > ?').run(todo.id, oldOverall);
        db.prepare('UPDATE todos SET overall_priority = 0 WHERE id = ?').run(todo.id);

        if (todo.projectId) {
            const oldProject = todo.projectPriority;
            db.prepare('UPDATE todos SET project_priority = project_priority - 1 WHERE id != ? AND project_id = ? AND project_priority > ?')
                .run(todo.id, todo.projectId, oldProject);
            db.prepare('UPDATE todos SET project_priority = 0 WHERE id = ?').run(todo.id);
        }
    } else {
        // Restore from saved priorities, shifting others to make room
        const after = getTodo(todo.id);
        const targetOverall = (after.previousOverallPriority && after.previousOverallPriority > 0) ? after.previousOverallPriority : 1;

        db.prepare('UPDATE todos SET overall_priority = overall_priority + 1 WHERE id != ? AND overall_priority >= ?').run(todo.id, targetOverall);
        db.prepare('UPDATE todos SET overall_priority = ?, previous_overall_priority = NULL WHERE id = ?').run(targetOverall, todo.id);

        if (todo.projectId) {
            const targetProject = (after.previousProjectPriority && after.previousProjectPriority > 0) ? after.previousProjectPriority : 1;
            db.prepare('UPDATE todos SET project_priority = project_priority + 1 WHERE id != ? AND project_id = ? AND project_priority >= ?')
                .run(todo.id, todo.projectId, targetProject);
            db.prepare('UPDATE todos SET project_priority = ?, previous_project_priority = NULL WHERE id = ?').run(targetProject, todo.id);
        } else {
            db.prepare('UPDATE todos SET previous_project_priority = NULL WHERE id = ?').run(todo.id);
        }
    }
}

// --- Project resolver (used by chat tool) -----------------------

export function resolveProject(needle) {
    if (!needle) return null;
    const byId = getProject(needle);
    if (byId) return byId;
    const byExactName = db.prepare('SELECT * FROM projects WHERE name = ? COLLATE NOCASE').get(needle);
    if (byExactName) return rowToProject(byExactName);
    const byFuzzy = db.prepare("SELECT * FROM projects WHERE name LIKE ? COLLATE NOCASE LIMIT 1").get(`%${needle}%`);
    return byFuzzy ? rowToProject(byFuzzy) : null;
}

// --- HTTP error ------------------------------------------------

export class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
