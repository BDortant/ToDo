// =============================================================
// STORAGE SERVICE — HTTP API client
// All data access goes through this module. The backend is a
// small Node + SQLite server (see /server) that owns the
// authoritative state. Per-operation calls let the PocketDev
// chat tool and the browser UI mutate the same data safely.
// =============================================================
const StorageService = (() => {
    // Same-origin: the Node server hosts both /api and the static frontend.
    // Override via window.TODO_API_BASE if you ever split them.
    const BASE = (typeof window !== 'undefined' && window.TODO_API_BASE) || '';

    async function call(method, path, body) {
        const opts = { method, headers: { 'Accept': 'application/json' } };
        if (body !== undefined) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        const res = await fetch(BASE + path, opts);
        const text = await res.text();
        const data = text ? JSON.parse(text) : null;
        if (!res.ok) {
            const msg = (data && data.error) ? data.error : `HTTP ${res.status}`;
            const err = new Error(msg);
            err.status = res.status;
            throw err;
        }
        return data;
    }

    return {
        // --- Bulk ---
        loadAll() { return call('GET', '/api/state'); },
        exportAll() { return call('GET', '/api/export'); },
        importAll(state) { return call('POST', '/api/import', state); },

        // --- Projects ---
        createProject(p) { return call('POST', '/api/projects', p); },
        patchProject(id, patch) { return call('PATCH', `/api/projects/${encodeURIComponent(id)}`, patch); },
        deleteProject(id) { return call('DELETE', `/api/projects/${encodeURIComponent(id)}`); },

        // --- Todos ---
        createTodo(t) { return call('POST', '/api/todos', t); },
        patchTodo(id, patch) { return call('PATCH', `/api/todos/${encodeURIComponent(id)}`, patch); },
        deleteTodo(id) { return call('DELETE', `/api/todos/${encodeURIComponent(id)}`); },
        reorderTodos(updates) { return call('POST', '/api/todos/reorder', updates); },
        cleanup() { return call('POST', '/api/todos/cleanup'); },

        // --- Meta ---
        setLastBackup() { return call('POST', '/api/meta/last-backup', { iso: new Date().toISOString() }); }
    };
})();

// API status indicator — surfaces backend health in the header.
// Updates both the visual dot and the aria-live label so screen
// readers announce the change too.
const ApiStatus = (() => {
    let ok = true;
    function set(newOk) {
        if (ok === newOk) return;
        ok = newOk;
        const el = document.getElementById('api-status');
        if (!el) return;
        el.classList.toggle('online', ok);
        el.classList.toggle('offline', !ok);
        const onlineMsg = 'Backend online';
        const offlineMsg = 'Backend unreachable — changes will fail until reconnected';
        const msg = ok ? onlineMsg : offlineMsg;
        el.title = msg;
        el.setAttribute('aria-label', msg);
        const label = document.getElementById('api-status-label');
        if (label) label.textContent = msg;
    }
    return {
        markOk() { set(true); },
        markFail() { set(false); }
    };
})();


// =============================================================
// APP — State, logic, and rendering
// =============================================================
const App = (() => {
    let data = { projects: [], todos: [], lastBackup: null };

    let currentView = 'all';           // 'all' or 'by-project'
    let selectedProjectId = null;      // filter in sidebar
    let editingTodoTags = [];          // temp tags for the form
    let draggedRowId = null;           // drag-to-reorder
    let pollTimer = null;
    const POLL_MS = 10000;             // cross-client sync interval

    // Per-column sort + filter state.
    // - Text columns: string substring filter
    // - Enum columns: array of selected values (multi-select)
    let sortState = { key: 'overallPriority', dir: 'asc' };
    const colFilters = {
        title: '',           // text substring
        deadline: '',        // text substring
        assignee: '',        // text substring
        project: [],         // enum multi-select (project names)
        status: [],          // enum multi-select
        effort: [],          // enum multi-select (incl. '' for "no effort")
        tags: []             // enum multi-select (real tags + 'snoozed' virtual)
    };

    // Which filter popover is currently open (only one at a time).
    let openPopoverKey = null;

    // Reserved tags that ALWAYS appear in the tag filter dropdown, even when
    // no item currently carries them. 'snoozed' is a virtual filter that
    // matches items with snoozeUntil in the future (driven by the backend
    // snooze_until column, not a real tag).
    const RESERVED_FILTER_TAGS = ['delegatable', 'watching', 'snoozed'];

    // --- Helpers ---

    async function reloadState() {
        try {
            data = await StorageService.loadAll();
            ApiStatus.markOk();
            hideLoadError();
            return true;
        } catch (e) {
            ApiStatus.markFail();
            console.error('Failed to load state:', e);
            return false;
        }
    }

    // Full-screen error overlay shown only on first-load failure.
    // Without this, users would see an empty app and assume data is gone.
    function showLoadError(err) {
        const container = document.getElementById('main-content');
        if (!container) return;
        // Escape err.message before interpolating into innerHTML. Even though
        // this is a local-only tool, a malformed backend response (or a
        // compromised dependency) could send HTML/<script> content; rendering
        // it raw via innerHTML would execute it.
        const errText = err ? String(err.message || err) : '';
        container.innerHTML = `
            <div class="load-error">
                <h2>Cannot reach the ToDo backend</h2>
                <p>The app couldn't load your data from the API. Your data is safe — it's just unreachable right now.</p>
                <p>Make sure the server is running:</p>
                <pre>cd /workspace/zeroplex/ToDo
docker compose up -d</pre>
                <button class="btn btn-primary" onclick="App.retryInit()">Retry</button>
                ${errText ? `<details><summary>Error details</summary><pre>${escapeHTML(errText)}</pre></details>` : ''}
            </div>
        `;
    }

    function hideLoadError() {
        const el = document.querySelector('.load-error');
        if (el) el.remove();
    }

    async function retryInit() {
        const ok = await reloadState();
        if (ok) {
            checkBackup();
            render();
            startPolling();
        }
    }

    function reportError(prefix, e) {
        ApiStatus.markFail();
        console.error(prefix, e);
        alert(`${prefix}: ${e.message || e}`);
    }

    function startPolling() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(async () => {
            if (document.hidden) return;    // tab not visible
            if (isUserBusy()) return;       // mid-edit or dragging — don't trample
            try {
                const fresh = await StorageService.loadAll();
                data = fresh;
                ApiStatus.markOk();
                render();
            } catch (e) {
                ApiStatus.markFail();
            }
        }, POLL_MS);
    }

    // Returns true when re-rendering the table would destroy something
    // the user is actively doing. Polling skips these ticks; the next
    // tick (10s later) will pick up server changes naturally.
    function isUserBusy() {
        if (draggedRowId) return true;
        const ae = document.activeElement;
        if (!ae) return false;
        if (ae.tagName === 'TEXTAREA') return true;
        if (ae.tagName === 'INPUT' && ae.classList.contains('inline-input')) return true;
        // Also pause while either modal is open
        if (document.querySelector('.modal-backdrop.open')) return true;
        return false;
    }

    function statusToBadgeClass(status) {
        const map = {
            'To Do': 'badge-todo',
            'In Progress': 'badge-in-progress',
            'Waiting on Client': 'badge-waiting-client',
            'Waiting on Me': 'badge-waiting-me',
            'Waiting on Third Party': 'badge-waiting-third',
            'On Hold': 'badge-on-hold',
            'In Review': 'badge-in-review',
            'Done': 'badge-done',
            'Cancelled': 'badge-cancelled'
        };
        return map[status] || 'badge-todo';
    }

    function effortClass(effort) {
        return effort ? `effort-${effort}` : '';
    }

    function escapeHTML(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function escapeAttr(str) {
        if (str == null) return '';
        return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function getProjectName(projectId) {
        const p = data.projects.find(p => p.id === projectId);
        return p ? p.name : '—';
    }

    function getFilteredTodos(projectId) {
        let todos = data.todos;

        // Filter by project if specified
        if (projectId) {
            todos = todos.filter(t => t.projectId === projectId);
        }

        // Daily view: show done since last working day + open items planned for today
        const dailyMode = document.getElementById('filter-daily').checked;
        if (dailyMode) {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const tomorrow = new Date(today);
            tomorrow.setDate(tomorrow.getDate() + 1);

            // Find the last working day (skip weekends)
            // On Monday (day 1): go back to Friday (3 days)
            // On Sunday (day 0): go back to Friday (2 days)
            // On Saturday (day 6): go back to Friday (1 day)
            // Otherwise: go back 1 day
            const lastWorkDay = new Date(today);
            const dayOfWeek = today.getDay();
            if (dayOfWeek === 1) lastWorkDay.setDate(lastWorkDay.getDate() - 3);
            else if (dayOfWeek === 0) lastWorkDay.setDate(lastWorkDay.getDate() - 2);
            else lastWorkDay.setDate(lastWorkDay.getDate() - 1);

            const todayStr = today.toISOString().slice(0, 10);

            todos = todos.filter(t => {
                // Done items completed since last working day
                if (t.status === 'Done' && t.completedDate) {
                    const completed = new Date(t.completedDate);
                    return completed >= lastWorkDay && completed < tomorrow;
                }
                // All open items (not Done, not Cancelled)
                if (t.status !== 'Done' && t.status !== 'Cancelled') {
                    return true;
                }
                return false;
            });
        }

        // Hide done items
        const hideDone = document.getElementById('filter-hide-done').checked;
        if (hideDone) {
            todos = todos.filter(t => t.status !== 'Done');
        }

        // Filter by status
        const statusFilter = document.getElementById('filter-status').value;
        if (statusFilter) {
            todos = todos.filter(t => t.status === statusFilter);
        }

        // Filter by effort
        const effortFilter = document.getElementById('filter-effort').value;
        if (effortFilter) {
            todos = todos.filter(t => t.effort === effortFilter);
        }

        // Search
        const search = document.getElementById('filter-search').value.toLowerCase().trim();
        if (search) {
            todos = todos.filter(t =>
                t.title.toLowerCase().includes(search) ||
                (t.assignee && t.assignee.toLowerCase().includes(search)) ||
                (t.notes && t.notes.toLowerCase().includes(search)) ||
                (t.tags && t.tags.some(tag => tag.toLowerCase().includes(search)))
            );
        }

        return todos.slice();
    }

    // --- Build a todo table ---
    //
    // Pipeline: sort (per sortState) → per-column filter (per colFilters) → render.
    // Renders three rows in <thead>: column headers (clickable to sort) and a
    // filter row (text input or enum dropdown per column). Action column is
    // pinned right and shows context-aware buttons (snooze hidden for off-queue).
    function buildTable(todos, showProject, defaultSortKey) {
        // Default sort if the user hasn't picked one yet for this view.
        // 'project' view groups should default to projectPriority, otherwise overallPriority.
        if (defaultSortKey === 'project' && sortState.key === 'overallPriority') {
            // user hasn't overridden — default to projectPriority for this view
            // (we don't mutate sortState; just compute locally for default ordering)
        }
        const effectiveKey = (defaultSortKey === 'project' && sortState.key === 'overallPriority')
            ? 'projectPriority' : sortState.key;
        const effectiveDir = sortState.dir;

        // Sort: open items first, then off-queue (Done/Cancelled) at bottom.
        // Within open: by chosen column. Within off-queue: by completedDate desc.
        const isOff = t => t.status === 'Done' || t.status === 'Cancelled';
        todos = todos.slice().sort((a, b) => {
            const aOff = isOff(a), bOff = isOff(b);
            if (aOff !== bOff) return aOff ? 1 : -1;
            if (aOff && bOff) return String(b.completedDate || '').localeCompare(String(a.completedDate || ''));
            return compareByKey(a, b, effectiveKey, effectiveDir);
        });

        // Per-column filters (applied AFTER global filters in getFilteredTodos).
        // - Text columns: case-insensitive substring match
        // - Enum multi-select: include row if its value is in the selected array
        //   (empty array = no filter applied)
        const f = colFilters;
        const today = todayLocalISO();
        if (f.title)         todos = todos.filter(t => (t.title || '').toLowerCase().includes(f.title.toLowerCase()));
        if (f.deadline)      todos = todos.filter(t => (t.deadline || '').includes(f.deadline));
        if (f.assignee)      todos = todos.filter(t => (t.assignee || '').toLowerCase().includes(f.assignee.toLowerCase()));
        if (f.project.length) todos = todos.filter(t => f.project.includes(getProjectName(t.projectId)));
        if (f.status.length)  todos = todos.filter(t => f.status.includes(t.status));
        if (f.effort.length)  todos = todos.filter(t => f.effort.includes(t.effort || ''));
        if (f.tags.length) {
            todos = todos.filter(t => {
                for (const sel of f.tags) {
                    // 'snoozed' is a virtual filter — matches snoozed items via snoozeUntil
                    if (sel === 'snoozed') {
                        if (t.snoozeUntil && t.snoozeUntil > today) return true;
                    } else if ((t.tags || []).includes(sel)) {
                        return true;
                    }
                }
                return false;
            });
        }

        const statusOptions = ['To Do', 'In Progress', 'Waiting on Client', 'Waiting on Me', 'Waiting on Third Party', 'On Hold', 'In Review', 'Done', 'Cancelled'];
        const effortOptions = ['', 'small', 'medium', 'large'];

        // Header cell with sort indicator. Clicking toggles asc/desc.
        const sortIndicator = (key) => {
            if (sortState.key !== key) return '<span class="sort-indicator">↕</span>';
            return sortState.dir === 'asc'
                ? '<span class="sort-indicator active">↑</span>'
                : '<span class="sort-indicator active">↓</span>';
        };
        const th = (key, label, attrs = '') =>
            `<th class="sortable" ${attrs} onclick="App.sortBy('${key}')">${label} ${sortIndicator(key)}</th>`;

        // Filter cell renderers. `data-filter-key` lets the focus-preservation
        // helper re-attach focus to the same input after each render.

        // Text filter: case-insensitive substring match.
        const tfText = (key, placeholder = '') =>
            `<th><input type="text" class="col-filter" data-filter-key="${key}" value="${escapeAttr(colFilters[key])}" placeholder="${escapeAttr(placeholder)}" oninput="App.setColFilter('${key}', this.value)"></th>`;

        // Multi-select enum filter: button + popover with checkboxes.
        // Selected count shown on button. Click outside to close.
        const tfMulti = (key, options, labelFor) => {
            const selected = colFilters[key] || [];
            const isOpen = openPopoverKey === key;
            const btnLabel = selected.length === 0
                ? 'all'
                : (selected.length === 1
                    ? (labelFor ? labelFor(selected[0]) : (selected[0] || '—'))
                    : `${selected.length} selected`);
            const btnClass = selected.length > 0 ? 'col-filter-btn active' : 'col-filter-btn';
            return `<th class="multi-filter-cell">
                <button type="button" class="${btnClass}" data-filter-key="${key}" onclick="event.stopPropagation(); App.toggleFilterPopover('${key}')">
                    ${escapeHTML(btnLabel)} <span class="caret">▾</span>
                </button>
                <div class="col-filter-popover${isOpen ? ' open' : ''}" data-popover-key="${key}">
                    <label class="all-row">
                        <input type="checkbox" ${selected.length === 0 ? 'checked' : ''} onchange="App.clearColFilter('${key}')">
                        <em>(all)</em>
                    </label>
                    <div class="popover-options">
                        ${options.map(o => {
                            const label = labelFor ? labelFor(o) : (o || '—');
                            const isReserved = key === 'tags' && RESERVED_FILTER_TAGS.includes(o);
                            return `<label class="${isReserved ? 'reserved-tag' : ''}">
                                <input type="checkbox" value="${escapeAttr(o)}"
                                       ${selected.includes(o) ? 'checked' : ''}
                                       onchange="App.toggleColFilterValue('${key}', this.value)">
                                ${escapeHTML(label)}
                            </label>`;
                        }).join('')}
                    </div>
                </div>
            </th>`;
        };

        // Collect distinct values. Project from project list; tags merged with
        // reserved filter tags so delegatable/watching/snoozed always show.
        const distinctTagsSet = new Set([...RESERVED_FILTER_TAGS, ...data.todos.flatMap(t => t.tags || [])]);
        const distinctTags = [...distinctTagsSet].sort((a, b) => a.localeCompare(b));
        const projectFilterOptions = data.projects.slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(p => p.name);

        let html = `<table class="todo-table">
            <thead>
                <tr class="header-row">
                    <th style="width:30px"></th>
                    ${th('overallPriority', 'O#', 'style="width:34px" title="Overall Priority"')}
                    ${th('projectPriority', 'P#', 'style="width:34px" title="Project Priority"')}
                    ${th('title', 'Title')}
                    ${showProject ? th('project', 'Project') : ''}
                    ${th('status', 'Status')}
                    ${th('effort', 'Effort')}
                    ${th('deadline', 'Deadline')}
                    ${th('assignee', 'Assignee')}
                    <th>Notes</th>
                    <th>Tags</th>
                    <th style="width:120px">Actions</th>
                </tr>
                <tr class="filter-row">
                    <th></th>
                    <th></th>
                    <th></th>
                    ${tfText('title', 'filter…')}
                    ${showProject ? tfMulti('project', projectFilterOptions) : ''}
                    ${tfMulti('status', statusOptions)}
                    ${tfMulti('effort', effortOptions, o => o ? (o[0].toUpperCase() + o.slice(1)) : '—')}
                    ${tfText('deadline', 'YYYY-MM')}
                    ${tfText('assignee', 'filter…')}
                    <th></th>
                    ${tfMulti('tags', distinctTags)}
                    <th></th>
                </tr>
            </thead><tbody>`;

        // Empty-state: render as a single tbody row so the headers + filter
        // row stay visible. Previously we returned a separate <div>, which
        // wiped the filter inputs and locked the user out of typing more.
        if (todos.length === 0) {
            const colCount = 11 + (showProject ? 1 : 0);
            html += `<tr class="empty-row"><td colspan="${colCount}">
                <em>No matching to-do items. Adjust the filters above or click "+ New To-Do".</em>
            </td></tr></tbody></table>`;
            return html;
        }

        for (const todo of todos) {
            const safeId = escapeAttr(todo.id);
            const off = isOff(todo);
            const snoozed = todo.snoozeUntil && todo.snoozeUntil > todayLocalISO();
            const rowClass = [
                off ? (todo.status === 'Done' ? 'done' : 'cancelled') : '',
                snoozed ? 'snoozed' : ''
            ].filter(Boolean).join(' ');

            const statusSelect = `<select class="inline-select" onchange="App.inlineUpdate(this.closest('tr').dataset.id, 'status', this.value)">
                ${statusOptions.map(s => `<option value="${s}" ${todo.status === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>`;

            const effortSelect = `<select class="inline-select" onchange="App.inlineUpdate(this.closest('tr').dataset.id, 'effort', this.value)">
                ${effortOptions.map(e => `<option value="${e}" ${todo.effort === e ? 'selected' : ''}>${e ? e.charAt(0).toUpperCase() + e.slice(1) : '—'}</option>`).join('')}
            </select>`;

            let isOverdue = false;
            if (todo.deadline && !off) {
                const deadlineDate = new Date(todo.deadline + 'T00:00:00');
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                isOverdue = deadlineDate.getTime() < today.getTime();
            }
            const deadlineInput = `<input type="date" class="inline-input ${isOverdue ? 'overdue' : ''}" value="${escapeAttr(todo.deadline || '')}" onchange="App.inlineUpdate(this.closest('tr').dataset.id, 'deadline', this.value)" style="width:130px">`;

            const assigneeInput = `<input type="text" class="inline-input" value="${escapeAttr(todo.assignee)}" placeholder="—" onblur="App.inlineUpdate(this.closest('tr').dataset.id, 'assignee', this.value)" onkeydown="if(event.key==='Enter'){this.blur()}" style="width:100px">`;

            // Action column — context-aware:
            // - Snooze only for open, awake items
            // - Wake only for snoozed items
            // - Edit/Delete always
            const actions = [];
            if (!off) {
                if (snoozed) {
                    actions.push(`<button class="btn-icon" onclick="App.unsnoozeTodo('${safeId}')" title="Wake (currently snoozed until ${escapeAttr(todo.snoozeUntil)})">⏰</button>`);
                } else {
                    actions.push(`<button class="btn-icon" onclick="App.snoozeTodo('${safeId}')" title="Snooze">💤</button>`);
                }
            }
            actions.push(`<button class="btn-icon" onclick="App.openTodoModal('${safeId}')" title="Edit">✏️</button>`);
            actions.push(`<button class="btn-icon" onclick="App.deleteTodo('${safeId}')" title="Delete">🗑️</button>`);

            const snoozeBadge = snoozed
                ? `<span class="snooze-badge" title="Snoozed until ${escapeAttr(todo.snoozeUntil)}">💤 ${escapeHTML(todo.snoozeUntil)}</span>`
                : '';

            html += `<tr class="${rowClass}" draggable="true"
                data-id="${safeId}"
                ondragstart="App.onDragStart(event)"
                ondragover="App.onDragOver(event)"
                ondragleave="App.onDragLeave(event)"
                ondrop="App.onDrop(event)"
                ondragend="App.onDragEnd(event)">
                <td><input type="checkbox" ${todo.status === 'Done' ? 'checked' : ''} onchange="App.toggleDone(this.closest('tr').dataset.id)" title="Mark as done"></td>
                <td style="color:#aaa">${todo.overallPriority || '—'}</td>
                <td style="color:#aaa">${todo.projectPriority || '—'}</td>
                <td><strong>${escapeHTML(todo.title)}</strong> ${snoozeBadge}</td>
                ${showProject ? `<td>${escapeHTML(getProjectName(todo.projectId))}</td>` : ''}
                <td>${statusSelect}</td>
                <td>${effortSelect}</td>
                <td>${deadlineInput}</td>
                <td>${assigneeInput}</td>
                <td class="notes-cell clickable-cell" tabindex="0" onclick="App.editNotes(this, this.closest('tr').dataset.id)" onkeydown="if(event.target===this&&(event.key==='Enter'||event.key===' ')){event.preventDefault();App.editNotes(this,this.closest('tr').dataset.id)}">${todo.notes ? escapeHTML(todo.notes) : '—'}</td>
                <td>${(todo.tags || []).map(t => `<span class="tag">${escapeHTML(t)}</span>`).join(' ')}</td>
                <td class="actions-cell">${actions.join('')}</td>
            </tr>`;
        }

        html += '</tbody></table>';
        return html;
    }

    function todayLocalISO() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    // Generic comparator for the header-sort feature.
    // Numbers compare numerically; everything else as case-insensitive strings.
    function compareByKey(a, b, key, dir) {
        let av, bv;
        if (key === 'project') {
            av = getProjectName(a.projectId);
            bv = getProjectName(b.projectId);
        } else {
            av = a[key];
            bv = b[key];
        }
        if (typeof av === 'number' && typeof bv === 'number') {
            return dir === 'asc' ? (av || 999) - (bv || 999) : (bv || 999) - (av || 999);
        }
        const cmp = String(av || '').toLowerCase().localeCompare(String(bv || '').toLowerCase());
        return dir === 'asc' ? cmp : -cmp;
    }

    function sortBy(key) {
        if (sortState.key === key) {
            sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
        } else {
            sortState.key = key;
            sortState.dir = 'asc';
        }
        render();
    }

    function setColFilter(key, value) {
        // Text filters use a string; enum filters use an array (use toggle).
        colFilters[key] = value;
        // render() rebuilds the entire table including the filter inputs.
        // Without focus-preservation the input gets destroyed-and-recreated
        // on every keystroke, kicking the user out after typing one char.
        withPreservedFilterFocus(() => render());
    }

    // Toggle a value in an enum multi-select filter (status/effort/project/tags).
    function toggleColFilterValue(key, value) {
        const arr = colFilters[key];
        if (!Array.isArray(arr)) return;
        const idx = arr.indexOf(value);
        if (idx === -1) arr.push(value);
        else arr.splice(idx, 1);
        render();
    }

    // Clear all selections in an enum multi-select filter (= "all" / no filter).
    function clearColFilter(key) {
        if (Array.isArray(colFilters[key])) {
            colFilters[key].length = 0;
        } else {
            colFilters[key] = '';
        }
        render();
    }

    // Toggle the popover panel for a multi-select filter. Only one open at a
    // time. Closes when the user clicks outside (see init's document handler).
    function toggleFilterPopover(key) {
        openPopoverKey = openPopoverKey === key ? null : key;
        render();
    }

    // Save the currently-focused filter input, run a render, then restore
    // focus + cursor position on the freshly-rendered input. Identified by
    // the `data-filter-key` attribute we set on each filter input.
    function withPreservedFilterFocus(renderFn) {
        const ae = document.activeElement;
        const isFilterInput = !!(ae && ae.dataset && ae.dataset.filterKey);
        let savedKey = null, savedStart = null, savedEnd = null;
        if (isFilterInput) {
            savedKey = ae.dataset.filterKey;
            try { savedStart = ae.selectionStart; savedEnd = ae.selectionEnd; } catch {}
        }
        renderFn();
        if (savedKey) {
            const next = document.querySelector(`[data-filter-key="${savedKey}"]`);
            if (next) {
                next.focus();
                try {
                    if (next.type === 'text' && savedStart !== null) {
                        next.setSelectionRange(savedStart, savedEnd);
                    }
                } catch {}
            }
        }
    }

    async function snoozeTodo(id) {
        const until = prompt('Snooze until (YYYY-MM-DD)? Leave empty for tomorrow:', '') || '';
        try {
            const res = await fetch(`/api/todos/${encodeURIComponent(id)}/snooze`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ until })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            await reloadState();
            render();
        } catch (e) {
            reportError('Failed to snooze', e);
        }
    }

    async function unsnoozeTodo(id) {
        try {
            const res = await fetch(`/api/todos/${encodeURIComponent(id)}/unsnooze`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            await reloadState();
            render();
        } catch (e) {
            reportError('Failed to unsnooze', e);
        }
    }

    // --- Render ---
    function render() {
        // Sidebar: project list
        const projectList = document.getElementById('project-list');
        projectList.innerHTML = data.projects.map(p => {
            const count = data.todos.filter(t => t.projectId === p.id).length;
            const active = selectedProjectId === p.id ? 'active' : '';
            const safePid = escapeAttr(p.id);
            return `<li class="project-item ${active}" data-id="${safePid}" onclick="App.selectProject(this.dataset.id)">
                <span>${escapeHTML(p.name)} <span class="project-count">${count}</span></span>
                <span class="project-item-actions">
                    <button class="btn-icon" onclick="event.stopPropagation(); App.openProjectModal(this.closest('li').dataset.id)" title="Rename">✏️</button>
                    <button class="btn-icon" onclick="event.stopPropagation(); App.deleteProject(this.closest('li').dataset.id)" title="Delete">🗑️</button>
                </span>
            </li>`;
        }).join('');

        // View toggle — "All items" is active when no project selected.
        // Buttons (not <li>) carry the click handler so keyboard works.
        document.querySelectorAll('#view-toggle .view-toggle-btn').forEach(btn => {
            const isActive = btn.dataset.view === currentView && !(btn.dataset.view === 'all' && selectedProjectId);
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
            if (isActive) {
                btn.setAttribute('aria-current', 'page');
            } else {
                btn.removeAttribute('aria-current');
            }
        });

        // Main title
        const titleEl = document.getElementById('main-title');

        // Main content
        const container = document.getElementById('main-content');

        if (currentView === 'all') {
            if (selectedProjectId) {
                titleEl.textContent = getProjectName(selectedProjectId);
                const todos = getFilteredTodos(selectedProjectId);
                container.innerHTML = buildTable(todos, false, 'project');
            } else {
                titleEl.textContent = 'All items';
                const todos = getFilteredTodos(null);
                container.innerHTML = buildTable(todos, true, 'overall');
            }
        } else {
            // by-project view
            titleEl.textContent = 'By Project';
            let html = '';

            // Items without a project
            const unassigned = getFilteredTodos(null).filter(t => !t.projectId);
            if (unassigned.length > 0) {
                html += '<div class="project-group-header">No Project</div>';
                html += buildTable(unassigned, false, 'overall');
            }

            for (const project of data.projects) {
                const todos = getFilteredTodos(project.id);
                html += `<div class="project-group-header">${escapeHTML(project.name)}</div>`;
                if (todos.length === 0) {
                    html += '<div class="empty-state"><p>No items in this project.</p></div>';
                } else {
                    html += buildTable(todos, false, 'project');
                }
            }

            if (data.projects.length === 0 && unassigned.length === 0) {
                html = '<div class="empty-state"><p>Create a project to get started, or add items without a project.</p></div>';
            }

            container.innerHTML = html;
        }
    }

    // --- Views ---
    function setView(view) {
        currentView = view;
        selectedProjectId = null;
        render();
    }

    function selectProject(id) {
        currentView = 'all';
        selectedProjectId = selectedProjectId === id ? null : id;
        render();
    }

    // --- Project CRUD ---
    function openProjectModal(id) {
        const modal = document.getElementById('project-modal');
        const titleEl = document.getElementById('project-modal-title');
        const nameInput = document.getElementById('project-name');
        const idInput = document.getElementById('project-id');

        if (id) {
            const project = data.projects.find(p => p.id === id);
            titleEl.textContent = 'Rename Project';
            nameInput.value = project.name;
            idInput.value = id;
        } else {
            titleEl.textContent = 'New Project';
            nameInput.value = '';
            idInput.value = '';
        }

        modal.classList.add('open');
        nameInput.focus();
    }

    function closeProjectModal() {
        document.getElementById('project-modal').classList.remove('open');
    }

    async function saveProject(e) {
        e.preventDefault();
        const id = document.getElementById('project-id').value;
        const name = document.getElementById('project-name').value.trim();
        if (!name) return;

        try {
            if (id) {
                await StorageService.patchProject(id, { name });
            } else {
                await StorageService.createProject({ name });
            }
            await reloadState();
            closeProjectModal();
            render();
        } catch (e) {
            reportError('Failed to save project', e);
        }
    }

    async function deleteProject(id) {
        const project = data.projects.find(p => p.id === id);
        if (!project) return;
        if (!confirm(`Delete project "${project.name}"? Items in this project will become unassigned.`)) return;

        try {
            await StorageService.deleteProject(id);
            if (selectedProjectId === id) selectedProjectId = null;
            await reloadState();
            render();
        } catch (e) {
            reportError('Failed to delete project', e);
        }
    }

    // --- Todo CRUD ---
    function openTodoModal(id) {
        const modal = document.getElementById('todo-modal');
        const titleEl = document.getElementById('todo-modal-title');

        // Populate project dropdown
        const projectSelect = document.getElementById('todo-project');
        projectSelect.innerHTML = '<option value="">— No Project —</option>' +
            data.projects.map(p => `<option value="${p.id}">${escapeHTML(p.name)}</option>`).join('');

        if (id) {
            const todo = data.todos.find(t => t.id === id);
            titleEl.textContent = 'Edit To-Do';
            document.getElementById('todo-id').value = id;
            document.getElementById('todo-title').value = todo.title;
            document.getElementById('todo-project').value = todo.projectId || '';
            document.getElementById('todo-status').value = todo.status;
            document.getElementById('todo-effort').value = todo.effort || '';
            document.getElementById('todo-deadline').value = todo.deadline || '';
            document.getElementById('todo-assignee').value = todo.assignee || '';
            document.getElementById('todo-notes').value = todo.notes || '';
            document.getElementById('todo-snooze-until').value = todo.snoozeUntil || '';
            editingTodoTags = [...(todo.tags || [])];
            setRecurringFormValues(todo);
        } else {
            titleEl.textContent = 'New To-Do';
            document.getElementById('todo-id').value = '';
            document.getElementById('todo-title').value = '';
            document.getElementById('todo-project').value = selectedProjectId || '';
            document.getElementById('todo-status').value = 'To Do';
            document.getElementById('todo-effort').value = '';
            document.getElementById('todo-deadline').value = '';
            document.getElementById('todo-assignee').value = '';
            document.getElementById('todo-notes').value = '';
            document.getElementById('todo-snooze-until').value = '';
            editingTodoTags = [];
            setRecurringFormValues({ isRecurring: false, recurringWeeks: 1, recurringDays: [] });
        }

        renderTags();
        modal.classList.add('open');
        document.getElementById('todo-title').focus();
    }

    function closeTodoModal() {
        document.getElementById('todo-modal').classList.remove('open');
    }

    async function saveTodo(e) {
        e.preventDefault();
        const id = document.getElementById('todo-id').value;
        const title = document.getElementById('todo-title').value.trim();
        if (!title) return;

        const newStatus = document.getElementById('todo-status').value;
        const recurring = getRecurringFormValues();

        const payload = {
            title,
            projectId: document.getElementById('todo-project').value,
            status: newStatus,
            effort: document.getElementById('todo-effort').value,
            deadline: document.getElementById('todo-deadline').value,
            assignee: document.getElementById('todo-assignee').value.trim(),
            notes: document.getElementById('todo-notes').value,
            tags: [...editingTodoTags],
            snoozeUntil: document.getElementById('todo-snooze-until').value || null,
            isRecurring: recurring.isRecurring,
            recurringWeeks: recurring.recurringWeeks,
            recurringDays: recurring.recurringDays
        };

        try {
            if (id) {
                await StorageService.patchTodo(id, payload);
            } else {
                await StorageService.createTodo(payload);
            }
            await reloadState();
            closeTodoModal();
            render();
        } catch (e) {
            reportError('Failed to save todo', e);
        }
    }

    async function deleteTodo(id) {
        const todo = data.todos.find(t => t.id === id);
        if (!todo) return;
        if (!confirm(`Delete "${todo.title}"?`)) return;

        try {
            await StorageService.deleteTodo(id);
            await reloadState();
            render();
        } catch (e) {
            reportError('Failed to delete todo', e);
        }
    }

    function toggleRecurring() {
        const checked = document.getElementById('todo-recurring').checked;
        document.getElementById('recurring-section').classList.toggle('open', checked);
    }

    function getRecurringFormValues() {
        const isRecurring = document.getElementById('todo-recurring').checked;
        const rawWeeks = parseInt(document.getElementById('recurring-weeks').value, 10);
        const recurringWeeks = (isNaN(rawWeeks) || rawWeeks < 1) ? 1 : Math.min(rawWeeks, 52);
        const recurringDays = [];
        document.querySelectorAll('#recurring-days input:checked').forEach(cb => {
            const day = parseInt(cb.value, 10);
            if (!isNaN(day) && day >= 0 && day <= 6) recurringDays.push(day);
        });
        return { isRecurring, recurringWeeks, recurringDays };
    }

    function setRecurringFormValues(todo) {
        const isRecurring = todo.isRecurring || false;
        document.getElementById('todo-recurring').checked = isRecurring;
        document.getElementById('recurring-weeks').value = todo.recurringWeeks || 1;
        document.querySelectorAll('#recurring-days input').forEach(cb => {
            cb.checked = (todo.recurringDays || []).includes(parseInt(cb.value, 10));
        });
        document.getElementById('recurring-section').classList.toggle('open', isRecurring);
    }

    // Recurring-task spawn lives on the server (see server/db.js spawnNextRecurrence).
    // The server runs it inside the same transaction as the status change, so any client
    // that flips a recurring todo to Done — browser UI or PocketDev chat — gets the new
    // occurrence on the very next state reload.

    function toggleFilter(which) {
        const hideDone = document.getElementById('filter-hide-done');
        const daily = document.getElementById('filter-daily');

        // Mutually exclusive: uncheck the other
        if (which === 'hide-done' && hideDone.checked) {
            daily.checked = false;
        } else if (which === 'daily' && daily.checked) {
            hideDone.checked = false;
        }

        render();
    }

    async function inlineUpdate(id, field, value) {
        const todo = data.todos.find(t => t.id === id);
        if (!todo) return;

        try {
            await StorageService.patchTodo(id, { [field]: value });
            await reloadState();
            render();
        } catch (e) {
            reportError('Failed to update todo', e);
        }
    }

    function editNotes(cell, id) {
        const todo = data.todos.find(t => t.id === id);
        if (!todo) return;

        const textarea = document.createElement('textarea');
        textarea.className = 'inline-input';
        textarea.value = todo.notes || '';

        cell.textContent = '';
        cell.classList.remove('clickable-cell');
        cell.onclick = null;
        cell.appendChild(textarea);

        // Size the textarea to fit the content plus one extra line
        textarea.style.height = 'auto';
        textarea.style.height = (textarea.scrollHeight + 20) + 'px';
        textarea.focus();

        textarea.addEventListener('blur', () => {
            inlineUpdate(id, 'notes', textarea.value);
        });
    }

    // Priority shift on Done lives on the server (see server/db.js shiftPriorityForDone).
    // The server records previous priorities so an un-done restores correctly, even when
    // the toggle happens from a different client than the original Done.

    async function toggleDone(id) {
        const todo = data.todos.find(t => t.id === id);
        if (!todo) return;
        const newStatus = todo.status === 'Done' ? (todo.previousStatus || 'To Do') : 'Done';
        try {
            await StorageService.patchTodo(id, { status: newStatus });
            await reloadState();
            render();
        } catch (e) {
            reportError('Failed to toggle done', e);
        }
    }

    // --- Tags ---
    function renderTags() {
        const container = document.getElementById('tags-container');
        const input = document.getElementById('tags-input');

        // Remove existing tags (keep only the input)
        container.querySelectorAll('.tag').forEach(el => el.remove());

        editingTodoTags.forEach((tag, i) => {
            const el = document.createElement('span');
            el.className = 'tag';
            el.innerHTML = `${escapeHTML(tag)} <button type="button" onclick="App.removeTag(${i})">×</button>`;
            container.insertBefore(el, input);
        });
    }

    function removeTag(index) {
        editingTodoTags.splice(index, 1);
        renderTags();
    }

    // --- Drag to reorder ---
    function onDragStart(e) {
        draggedRowId = e.currentTarget.dataset.id;
        e.currentTarget.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
    }

    function onDragOver(e) {
        e.preventDefault();
        const row = e.currentTarget;
        row.classList.remove('drag-over-top', 'drag-over-bottom');

        // Determine drag direction to show the indicator on the correct side
        const targetId = row.dataset.id;
        const draggedTodo = data.todos.find(t => t.id === draggedRowId);
        const targetTodo = data.todos.find(t => t.id === targetId);
        if (!draggedTodo || !targetTodo) return;

        const useProjectPriority = currentView === 'by-project' || selectedProjectId;
        const key = useProjectPriority ? 'projectPriority' : 'overallPriority';

        if (draggedTodo[key] < targetTodo[key]) {
            row.classList.add('drag-over-bottom');
        } else {
            row.classList.add('drag-over-top');
        }
    }

    function onDragLeave(e) {
        e.currentTarget.classList.remove('drag-over-top', 'drag-over-bottom');
    }

    async function onDrop(e) {
        e.preventDefault();
        e.currentTarget.classList.remove('drag-over-top', 'drag-over-bottom');
        const targetId = e.currentTarget.dataset.id;
        if (!draggedRowId || draggedRowId === targetId) return;

        const draggedTodo = data.todos.find(t => t.id === draggedRowId);
        const targetTodo = data.todos.find(t => t.id === targetId);
        if (!draggedTodo || !targetTodo) return;

        const useProjectPriority = currentView === 'by-project' || selectedProjectId;
        const key = useProjectPriority ? 'projectPriority' : 'overallPriority';

        // In project-priority mode, refuse cross-project drops — the projectPriority
        // spaces are per-project, so renumbering against a row in a different
        // project would corrupt both projects' priority sequences.
        if (useProjectPriority && draggedTodo.projectId !== targetTodo.projectId) {
            draggedRowId = null;
            return;
        }

        const fromPos = draggedTodo[key];
        const toPos = targetTodo[key];

        const affected = useProjectPriority
            ? data.todos.filter(t => t.projectId === draggedTodo.projectId)
            : data.todos;

        // Compute the new priorities locally, then send a single bulk reorder request.
        const updates = [];
        if (fromPos < toPos) {
            affected.forEach(t => {
                if (t === draggedTodo) return;
                if (t[key] > fromPos && t[key] <= toPos) {
                    updates.push({ id: t.id, [key]: t[key] - 1 });
                }
            });
        } else {
            affected.forEach(t => {
                if (t === draggedTodo) return;
                if (t[key] >= toPos && t[key] < fromPos) {
                    updates.push({ id: t.id, [key]: t[key] + 1 });
                }
            });
        }
        updates.push({ id: draggedTodo.id, [key]: toPos });

        try {
            await StorageService.reorderTodos(updates);
            await reloadState();
            render();
        } catch (e) {
            reportError('Failed to reorder', e);
        }
    }

    function onDragEnd(e) {
        e.currentTarget.classList.remove('dragging');
        draggedRowId = null;
        document.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(el => el.classList.remove('drag-over-top', 'drag-over-bottom'));
    }

    // --- Export / Import ---
    async function cleanup() {
        // Server applies the same "before last working day" cutoff used previously.
        // We do a confirm here using the local count so the UX is unchanged.
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const cutoff = new Date(today);
        const dow = today.getDay();
        if (dow === 1) cutoff.setDate(cutoff.getDate() - 3);
        else if (dow === 0) cutoff.setDate(cutoff.getDate() - 2);
        else if (dow === 6) cutoff.setDate(cutoff.getDate() - 1);
        else cutoff.setDate(cutoff.getDate() - 1);

        const toRemove = data.todos.filter(t =>
            t.status === 'Done' && t.completedDate && new Date(t.completedDate) < cutoff
        );

        if (toRemove.length === 0) {
            alert('Nothing to clean up.');
            return;
        }

        if (!confirm(`Remove ${toRemove.length} task(s) completed before ${cutoff.toLocaleDateString()}?`)) return;

        try {
            const res = await StorageService.cleanup();
            await reloadState();
            render();
            alert(`Removed ${res.deletedIds.length} task(s).`);
        } catch (e) {
            reportError('Failed to clean up', e);
        }
    }

    async function exportData() {
        try {
            const state = await StorageService.exportAll();
            await StorageService.setLastBackup();
            const json = JSON.stringify(state, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `todo-backup-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);

            document.getElementById('backup-banner').classList.remove('show');
            await reloadState();
        } catch (e) {
            reportError('Failed to export', e);
        }
    }

    function importData(e) {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async function(event) {
            try {
                const imported = JSON.parse(event.target.result);
                if (!imported.projects || !imported.todos) {
                    throw new Error('Invalid format');
                }
                if (!confirm(`Import ${imported.projects.length} project(s) and ${imported.todos.length} todo(s)? This REPLACES all current data.`)) return;
                await StorageService.importAll(imported);
                await reloadState();
                render();
                alert('Data imported successfully!');
            } catch (err) {
                alert(`Failed to import: ${err.message || 'invalid file format'}`);
            }
        };
        reader.readAsText(file);
        e.target.value = '';
    }

    // --- Auto-backup check ---
    function checkBackup() {
        const last = data.lastBackup;
        if (!last) {
            // No backup has ever been made — only show banner if there's data
            if (data.todos.length > 0) {
                document.getElementById('backup-banner').classList.add('show');
            }
            return;
        }

        const hoursSince = (Date.now() - new Date(last).getTime()) / (1000 * 60 * 60);
        if (hoursSince >= 24) {
            document.getElementById('backup-banner').classList.add('show');
        }
    }

    function dismissBackupBanner() {
        document.getElementById('backup-banner').classList.remove('show');
    }

    // --- Init ---
    async function init() {
        // Tags input: add tag on Enter
        document.getElementById('tags-input').addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                const val = this.value.trim();
                if (val && !editingTodoTags.includes(val)) {
                    editingTodoTags.push(val);
                    renderTags();
                }
                this.value = '';
            }
        });

        // Close modals on backdrop click
        document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
            backdrop.addEventListener('click', function(e) {
                if (e.target === this) this.classList.remove('open');
            });
        });

        // Close modals on Escape
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                document.querySelectorAll('.modal-backdrop.open').forEach(m => m.classList.remove('open'));
                if (openPopoverKey) {
                    openPopoverKey = null;
                    render();
                }
            }
        });

        // Click-outside to close any open multi-select filter popover.
        document.addEventListener('click', function(e) {
            if (!openPopoverKey) return;
            if (e.target.closest('.col-filter-popover')) return;
            if (e.target.closest('.col-filter-btn')) return;
            openPopoverKey = null;
            render();
        });

        // Initial load from API. On failure, show a clear error overlay
        // instead of rendering an empty app (avoids "where did my data go?").
        const ok = await reloadState();
        if (!ok) {
            showLoadError(new Error('Initial /api/state request failed'));
            return; // Don't start polling — user will hit Retry
        }
        checkBackup();
        render();

        // Pick up changes made from the PocketDev chat tool
        startPolling();
    }

    // Start the app
    init();

    // Public API
    return {
        render,
        setView,
        selectProject,
        openProjectModal,
        closeProjectModal,
        saveProject,
        deleteProject,
        openTodoModal,
        closeTodoModal,
        saveTodo,
        deleteTodo,
        toggleRecurring,
        toggleDone,
        toggleFilter,
        inlineUpdate,
        editNotes,
        removeTag,
        onDragStart,
        onDragOver,
        onDragLeave,
        onDrop,
        onDragEnd,
        cleanup,
        exportData,
        importData,
        dismissBackupBanner,
        retryInit,
        sortBy,
        setColFilter,
        toggleColFilterValue,
        clearColFilter,
        toggleFilterPopover,
        snoozeTodo,
        unsnoozeTodo
    };
})();
