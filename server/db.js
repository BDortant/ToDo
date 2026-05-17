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

// ---------------------------------------------------------------
// Priority model
// ---------------------------------------------------------------
// `overall_priority` and `project_priority` are integer ranks
// that mean "position in the queue of work to do".
//
//   - Open items   -> contiguous 1..N (N = count of open todos)
//   - Off-queue    -> 0 (Done and Cancelled — both treated as
//                    "out of the queue", rendered as "—" in UI)
//
// After ANY mutation that could create a gap or duplicate,
// `normalize()` is called inside the same transaction to put
// the world back into the 1..N shape. This is the single
// source of truth for priorities — every other priority code
// path either prepares for normalize() or trusts that it ran.
// ---------------------------------------------------------------

const OFF_QUEUE_STATUSES = ['Done', 'Cancelled'];
const OFF_QUEUE_SET = new Set(OFF_QUEUE_STATUSES);
const OFF_QUEUE_SQL_LIST = OFF_QUEUE_STATUSES.map(s => `'${s}'`).join(', ');

function isOffQueue(status) {
    return OFF_QUEUE_SET.has(status);
}

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

    // Additive migrations — safe to re-run, only add column if missing.
    // SQLite doesn't have ADD COLUMN IF NOT EXISTS, so we check pragma first.
    ensureColumn('todos', 'updated_date', 'TEXT');
    ensureColumn('todos', 'snooze_until', 'TEXT'); // YYYY-MM-DD, NULL = not snoozed

    db.exec(`CREATE INDEX IF NOT EXISTS idx_todos_snooze ON todos(snooze_until);`);

    // Backfill updated_date for existing rows so the triage skill can
    // tell what's stale even for rows created before this column existed.
    db.prepare(
        'UPDATE todos SET updated_date = COALESCE(updated_date, completed_date, created_date) WHERE updated_date IS NULL'
    ).run();

    return db;
}

function ensureColumn(table, column, decl) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.find(c => c.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    }
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
        updatedDate: row.updated_date ?? row.created_date,
        completedDate: row.completed_date ?? null,
        snoozeUntil: row.snooze_until ?? null,
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
    const offQueue = isOffQueue(status);

    const id = input.id || generateId();
    // Off-queue items are born outside the queue (priority 0). Open items
    // go to the bottom of the queue. normalize() at the end keeps things tidy.
    const overallPriority = offQueue ? 0 : nextOverallPriority();
    const projectPriority = offQueue ? 0 : nextProjectPriority(projectId);

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
        updatedDate: nowIso,
        completedDate: offQueue ? nowIso : null,
        snoozeUntil: input.snoozeUntil || null,
        isRecurring: !!input.isRecurring,
        recurringWeeks: clampWeeks(input.recurringWeeks),
        recurringDays: normalizeDays(input.recurringDays)
    };

    const tx = db.transaction(() => {
        insertTodoRow(todo);
        const spawned = (offQueue && todo.isRecurring) ? spawnNextRecurrence(todo) : null;
        normalize();
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
        if (patch.snoozeUntil !== undefined) {
            // null / empty string = unsnooze; otherwise expect YYYY-MM-DD
            const v = patch.snoozeUntil;
            updates.snooze_until = (v && String(v).trim()) ? String(v).trim() : null;
        }

        if (patch.projectId !== undefined && patch.projectId !== existing.projectId) {
            if (patch.projectId && !getProject(patch.projectId)) {
                throw new HttpError(400, `Unknown projectId: ${patch.projectId}`);
            }
            updates.project_id = patch.projectId || null;
            // If item is open, place at bottom of the new project's queue;
            // if off-queue, project priority stays 0. normalize() at the end
            // re-ranks everything contiguously either way.
            updates.project_priority = isOffQueue(existing.status)
                ? 0
                : nextProjectPriority(patch.projectId || '');
            projectChanged = true;
        }

        // ----- Status handling --------------------------------------------------
        // Three relevant transitions:
        //   1. open  -> open      : no priority change
        //   2. open  -> off-queue : becameOffQueue — leave the queue
        //                          (save previous priorities, set both to 0)
        //                          + spawn recurrence if recurring
        //   3. off-queue -> open  : leftOffQueue — rejoin at previous slot
        //                          (clamp to current open-count, shift others
        //                           to make room)
        // After all branches, normalize() runs to ensure 1..N contiguity.
        let spawnedRecurrence = null;
        let priorityShifted = false;

        if (patch.status !== undefined && patch.status !== existing.status) {
            const newStatus = patch.status;
            const wasOff = isOffQueue(existing.status);
            const becomesOff = isOffQueue(newStatus);
            const becameOffQueue = !wasOff && becomesOff;
            const leftOffQueue = wasOff && !becomesOff;

            updates.status = newStatus;

            if (becameOffQueue) {
                updates.completed_date = new Date().toISOString();
                updates.previous_status = existing.status;
                updates.previous_overall_priority = existing.overallPriority || null;
                updates.previous_project_priority = existing.projectPriority || null;
                updates.overall_priority = 0;
                updates.project_priority = 0;
                priorityShifted = true;
            } else if (leftOffQueue) {
                updates.completed_date = null;
                updates.previous_status = null;
                // Restore priorities to their previous slots, clamped to the
                // size of the queue we're rejoining. If we don't have a stored
                // previous (legacy data, or item born off-queue), append at end.
                const openTotal = openCount(); // before this rejoin
                const openInProj = openCountInProject(existing.projectId || '');
                const prevO = existing.previousOverallPriority;
                const prevP = existing.previousProjectPriority;
                const targetOverall = prevO && prevO > 0
                    ? Math.min(prevO, openTotal + 1)
                    : openTotal + 1;
                const targetProject = prevP && prevP > 0
                    ? Math.min(prevP, openInProj + 1)
                    : openInProj + 1;
                // Make room: shift open items at >= target down by one
                db.prepare(
                    `UPDATE todos SET overall_priority = overall_priority + 1
                     WHERE id != ? AND status NOT IN (${OFF_QUEUE_SQL_LIST})
                     AND overall_priority >= ?`
                ).run(id, targetOverall);
                db.prepare(
                    `UPDATE todos SET project_priority = project_priority + 1
                     WHERE id != ? AND status NOT IN (${OFF_QUEUE_SQL_LIST})
                     AND COALESCE(project_id, '') = ?
                     AND project_priority >= ?`
                ).run(id, existing.projectId || '', targetProject);
                updates.overall_priority = targetOverall;
                updates.project_priority = targetProject;
                updates.previous_overall_priority = null;
                updates.previous_project_priority = null;
                priorityShifted = true;
            }
            // open -> open: no priority work needed

            applyUpdates(id, updates);

            if (becameOffQueue) {
                const after = getTodo(id);
                if (after.isRecurring) spawnedRecurrence = spawnNextRecurrence(after);
            }

            normalize();

            return {
                todo: getTodo(id),
                spawnedRecurrence: spawnedRecurrence ? getTodo(spawnedRecurrence.id) : null,
                priorityShifted,
                projectChanged
            };
        }

        applyUpdates(id, updates);
        // Project change without status change still re-ranks the affected projects.
        if (projectChanged) normalize();
        return { todo: getTodo(id), spawnedRecurrence: null, priorityShifted: false, projectChanged };
    });

    return tx();
}

export function deleteTodo(id) {
    const existing = getTodo(id);
    if (!existing) throw new HttpError(404, 'Todo not found');
    const tx = db.transaction(() => {
        db.prepare('DELETE FROM todos WHERE id = ?').run(id);
        // If the deleted item was in the queue, its slot now needs to be
        // closed. Off-queue items leave the queue unaffected.
        if (!isOffQueue(existing.status)) normalize();
    });
    tx();
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

    // Off-queue items don't have a meaningful priority — they sit at 0
    // and are sorted by completedDate. Refuse to set priority on them
    // instead of silently no-oping (normalize would just overwrite anyway).
    if (isOffQueue(existing.status)) {
        throw new HttpError(400, `Cannot set priority on a ${existing.status} item. Change its status first.`);
    }

    const tx = db.transaction(() => {
        // Clamp to the size of the open queue (in both spaces). Without
        // this, priority=99 on a 3-item list creates sparse ranks.
        const openTotal = openCount();
        const openInProj = openCountInProject(existing.projectId || '');
        const rawN = parseInt(newPriority, 10);
        const fallbackN = Number.isFinite(rawN) ? rawN : 1;
        const targetOverall = Math.max(1, Math.min(fallbackN, Math.max(1, openTotal)));
        const targetProject = Math.max(1, Math.min(fallbackN, Math.max(1, openInProj)));

        const oldOverall = existing.overallPriority;
        if (targetOverall !== oldOverall) {
            if (targetOverall < oldOverall) {
                db.prepare(
                    `UPDATE todos SET overall_priority = overall_priority + 1
                     WHERE id != ? AND status NOT IN (${OFF_QUEUE_SQL_LIST})
                     AND overall_priority >= ? AND overall_priority < ?`
                ).run(id, targetOverall, oldOverall);
            } else {
                db.prepare(
                    `UPDATE todos SET overall_priority = overall_priority - 1
                     WHERE id != ? AND status NOT IN (${OFF_QUEUE_SQL_LIST})
                     AND overall_priority > ? AND overall_priority <= ?`
                ).run(id, oldOverall, targetOverall);
            }
            db.prepare('UPDATE todos SET overall_priority = ? WHERE id = ?').run(targetOverall, id);
        }

        const oldProject = existing.projectPriority;
        if (targetProject !== oldProject) {
            if (targetProject < oldProject) {
                db.prepare(
                    `UPDATE todos SET project_priority = project_priority + 1
                     WHERE id != ? AND status NOT IN (${OFF_QUEUE_SQL_LIST})
                     AND COALESCE(project_id, '') = ?
                     AND project_priority >= ? AND project_priority < ?`
                ).run(id, existing.projectId || '', targetProject, oldProject);
            } else {
                db.prepare(
                    `UPDATE todos SET project_priority = project_priority - 1
                     WHERE id != ? AND status NOT IN (${OFF_QUEUE_SQL_LIST})
                     AND COALESCE(project_id, '') = ?
                     AND project_priority > ? AND project_priority <= ?`
                ).run(id, existing.projectId || '', oldProject, targetProject);
            }
            db.prepare('UPDATE todos SET project_priority = ? WHERE id = ?').run(targetProject, id);
        }

        // Defensive: normalize() ensures contiguity even if our targeted
        // shifts left a gap (e.g. duplicate input from a buggy client).
        normalize();
        return getTodo(id);
    });
    return tx();
}

// --- Snooze ----------------------------------------------------
//
// Snooze hides a todo from the active queue views until its
// `snoozeUntil` date passes. It's a presentation filter, not a
// state change — the todo keeps its priority slot and reappears
// in the queue automatically the next time its date is computed.

function tomorrowLocalDate() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

export function snoozeTodo(id, until) {
    const existing = getTodo(id);
    if (!existing) throw new HttpError(404, 'Todo not found');
    if (isOffQueue(existing.status)) {
        throw new HttpError(400, `Cannot snooze a ${existing.status} item.`);
    }
    // Default: tomorrow. Allow YYYY-MM-DD only (strict).
    const target = (until && String(until).trim()) ? String(until).trim() : tomorrowLocalDate();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) {
        throw new HttpError(400, `snoozeUntil must be YYYY-MM-DD, got: ${target}`);
    }
    applyUpdates(id, { snooze_until: target });
    return getTodo(id);
}

export function unsnoozeTodo(id) {
    const existing = getTodo(id);
    if (!existing) throw new HttpError(404, 'Todo not found');
    applyUpdates(id, { snooze_until: null });
    return getTodo(id);
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
        // Drag-to-reorder sends a batch the client computed locally.
        // normalize() cleans up any duplicates/gaps if the client was
        // working from stale data — defense in depth.
        normalize();
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
    // Include Cancelled too — both are off-queue, both are fair game for cleanup.
    const rows = db.prepare(
        `SELECT id FROM todos
         WHERE status IN (${OFF_QUEUE_SQL_LIST})
         AND completed_date IS NOT NULL AND completed_date < ?`
    ).all(cutoffIso);
    const ids = rows.map(r => r.id);
    if (ids.length) {
        const placeholders = ids.map(() => '?').join(',');
        db.prepare(`DELETE FROM todos WHERE id IN (${placeholders})`).run(...ids);
    }
    // Cleanup only removes off-queue items, which weren't in the queue.
    // Open list is unaffected — no normalize() needed. But it's cheap, so
    // run it anyway as a periodic tidy-up.
    normalize();
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
                updatedDate: t.updatedDate || t.createdDate || new Date().toISOString(),
                completedDate: t.completedDate || null,
                snoozeUntil: t.snoozeUntil || null,
                isRecurring: !!t.isRecurring,
                recurringWeeks: clampWeeks(t.recurringWeeks),
                recurringDays: normalizeDays(t.recurringDays)
            });
        }
        if (state.lastBackup) {
            db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_backup', ?)").run(state.lastBackup);
        }
        // Critical for migration: legacy data often has gaps + duplicates
        // in the priority field (see PR #7 discussion). normalize() fixes
        // these as part of the import so the new app starts from a clean
        // 1..N world.
        normalize();
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
    // Auto-bump updated_date on every real mutation so the triage skill
    // can spot stale items. Skip if the caller already set it (e.g. import).
    if (!('updated_date' in updates)) {
        updates = { ...updates, updated_date: new Date().toISOString() };
    }
    const finalKeys = Object.keys(updates);
    const sets = finalKeys.map(k => `${k} = ?`).join(', ');
    const vals = finalKeys.map(k => updates[k]);
    vals.push(id);
    db.prepare(`UPDATE todos SET ${sets} WHERE id = ?`).run(...vals);
}

function insertTodoRow(t) {
    db.prepare(`
        INSERT INTO todos (
            id, title, project_id, status, overall_priority, project_priority,
            effort, deadline, assignee, notes, tags,
            created_date, updated_date, completed_date, snooze_until,
            is_recurring, recurring_weeks, recurring_days
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        t.id, t.title, t.projectId || null, t.status, t.overallPriority, t.projectPriority,
        t.effort || null, t.deadline || null, t.assignee || null, t.notes || null, JSON.stringify(t.tags || []),
        t.createdDate, t.updatedDate || t.createdDate, t.completedDate || null, t.snoozeUntil || null,
        t.isRecurring ? 1 : 0, t.recurringWeeks, JSON.stringify(t.recurringDays || [])
    );
}

// Count of OPEN todos only (Done/Cancelled don't occupy queue slots).
function openCount() {
    return db.prepare(
        `SELECT COUNT(*) AS c FROM todos WHERE status NOT IN (${OFF_QUEUE_SQL_LIST})`
    ).get().c;
}

function openCountInProject(projectId) {
    return db.prepare(
        `SELECT COUNT(*) AS c FROM todos
         WHERE status NOT IN (${OFF_QUEUE_SQL_LIST})
         AND COALESCE(project_id, '') = ?`
    ).get(projectId || '').c;
}

// "Where does a new open todo go?" — at the bottom of the open queue.
function nextOverallPriority() {
    return openCount() + 1;
}

function nextProjectPriority(projectId) {
    return openCountInProject(projectId) + 1;
}

// Re-rank all open todos to 1..N contiguously (globally and within each
// project). All off-queue todos get priority 0. Tie-breaker on existing
// priority is `created_date` then `id` so the result is fully deterministic.
//
// Safe to call multiple times; idempotent.
function normalize() {
    // Overall ranks across all open todos
    const openOverall = db.prepare(
        `SELECT id FROM todos
         WHERE status NOT IN (${OFF_QUEUE_SQL_LIST})
         ORDER BY overall_priority ASC, created_date ASC, id ASC`
    ).all();
    const setOverall = db.prepare('UPDATE todos SET overall_priority = ? WHERE id = ?');
    openOverall.forEach((row, i) => setOverall.run(i + 1, row.id));

    // Off-queue items all get 0
    db.prepare(
        `UPDATE todos SET overall_priority = 0 WHERE status IN (${OFF_QUEUE_SQL_LIST})`
    ).run();

    // Per-project ranks (include the "no project" bucket for completeness)
    const projectIds = db.prepare(
        `SELECT DISTINCT COALESCE(project_id, '') AS pid FROM todos
         WHERE status NOT IN (${OFF_QUEUE_SQL_LIST})`
    ).all().map(r => r.pid);

    const setProject = db.prepare('UPDATE todos SET project_priority = ? WHERE id = ?');
    for (const pid of projectIds) {
        const rows = db.prepare(
            `SELECT id FROM todos
             WHERE status NOT IN (${OFF_QUEUE_SQL_LIST})
             AND COALESCE(project_id, '') = ?
             ORDER BY project_priority ASC, created_date ASC, id ASC`
        ).all(pid);
        rows.forEach((row, i) => setProject.run(i + 1, row.id));
    }
    db.prepare(
        `UPDATE todos SET project_priority = 0 WHERE status IN (${OFF_QUEUE_SQL_LIST})`
    ).run();
}

// Exposed so an admin can re-normalize without doing a fake mutation
// (used once after import to clean up legacy localStorage data).
export function normalizePriorities() {
    const tx = db.transaction(() => normalize());
    tx();
    return { ok: true };
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
