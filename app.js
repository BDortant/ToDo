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
        container.innerHTML = `
            <div class="load-error">
                <h2>Cannot reach the ToDo backend</h2>
                <p>The app couldn't load your data from the API. Your data is safe — it's just unreachable right now.</p>
                <p>Make sure the server is running:</p>
                <pre>cd /workspace/zeroplex/ToDo
docker compose up -d</pre>
                <button class="btn btn-primary" onclick="App.retryInit()">Retry</button>
                ${err ? `<details><summary>Error details</summary><pre>${(err.message || err) + ''}</pre></details>` : ''}
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
    function buildTable(todos, showProject, sortBy) {
        if (sortBy === 'project') {
            todos = todos.slice().sort((a, b) => (a.projectPriority ?? 999) - (b.projectPriority ?? 999));
        } else {
            todos = todos.slice().sort((a, b) => (a.overallPriority ?? 999) - (b.overallPriority ?? 999));
        }
        if (todos.length === 0) {
            return '<div class="empty-state"><p>No to-do items yet. Click "+ New To-Do" to get started.</p></div>';
        }

        const statusOptions = ['To Do', 'In Progress', 'Waiting on Client', 'Waiting on Me', 'Waiting on Third Party', 'On Hold', 'In Review', 'Done', 'Cancelled'];
        const effortOptions = ['', 'small', 'medium', 'large'];

        let html = `<table class="todo-table">
            <thead><tr>
                <th style="width:30px"></th>
                <th style="width:30px" title="Overall Priority">O#</th>
                <th style="width:30px" title="Project Priority">P#</th>
                <th>Title</th>
                ${showProject ? '<th>Project</th>' : ''}
                <th>Status</th>
                <th>Effort</th>
                <th>Deadline</th>
                <th>Assignee</th>
                <th>Notes</th>
                <th>Tags</th>
                <th style="width:80px">Actions</th>
            </tr></thead><tbody>`;

        for (const todo of todos) {
            const safeId = escapeAttr(todo.id);
            const rowClass = todo.status === 'Done' ? 'done' : (todo.status === 'Cancelled' ? 'cancelled' : '');
            // Status inline select
            const statusSelect = `<select class="inline-select" onchange="App.inlineUpdate(this.closest('tr').dataset.id, 'status', this.value)">
                ${statusOptions.map(s => `<option value="${s}" ${todo.status === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>`;

            // Effort inline select
            const effortSelect = `<select class="inline-select" onchange="App.inlineUpdate(this.closest('tr').dataset.id, 'effort', this.value)">
                ${effortOptions.map(e => `<option value="${e}" ${todo.effort === e ? 'selected' : ''}>${e ? e.charAt(0).toUpperCase() + e.slice(1) : '—'}</option>`).join('')}
            </select>`;

            // Deadline inline input — highlight red if overdue and not done
            let isOverdue = false;
            if (todo.deadline && todo.status !== 'Done' && todo.status !== 'Cancelled') {
                const deadlineDate = new Date(todo.deadline + 'T00:00:00');
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                isOverdue = deadlineDate.getTime() < today.getTime();
            }
            const deadlineInput = `<input type="date" class="inline-input ${isOverdue ? 'overdue' : ''}" value="${escapeAttr(todo.deadline || '')}" onchange="App.inlineUpdate(this.closest('tr').dataset.id, 'deadline', this.value)" style="width:130px">`;

            // Assignee inline input
            const assigneeInput = `<input type="text" class="inline-input" value="${escapeAttr(todo.assignee)}" placeholder="—" onblur="App.inlineUpdate(this.closest('tr').dataset.id, 'assignee', this.value)" onkeydown="if(event.key==='Enter'){this.blur()}" style="width:100px">`;

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
                <td><strong>${escapeHTML(todo.title)}</strong></td>
                ${showProject ? `<td>${escapeHTML(getProjectName(todo.projectId))}</td>` : ''}
                <td>${statusSelect}</td>
                <td>${effortSelect}</td>
                <td>${deadlineInput}</td>
                <td>${assigneeInput}</td>
                <td class="notes-cell clickable-cell" tabindex="0" onclick="App.editNotes(this, this.closest('tr').dataset.id)" onkeydown="if(event.target===this&&(event.key==='Enter'||event.key===' ')){event.preventDefault();App.editNotes(this,this.closest('tr').dataset.id)}">${todo.notes ? escapeHTML(todo.notes) : '—'}</td>
                <td>${(todo.tags || []).map(t => `<span class="tag">${escapeHTML(t)}</span>`).join(' ')}</td>
                <td>
                    <button class="btn-icon" onclick="App.openTodoModal(this.closest('tr').dataset.id)" title="Edit">✏️</button>
                    <button class="btn-icon" onclick="App.deleteTodo(this.closest('tr').dataset.id)" title="Delete">🗑️</button>
                </td>
            </tr>`;
        }

        html += '</tbody></table>';
        return html;
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

        // View toggle — "All Items" is only active when no project is selected
        document.querySelectorAll('#view-toggle li').forEach(li => {
            const isActive = li.dataset.view === currentView && !(li.dataset.view === 'all' && selectedProjectId);
            li.classList.toggle('active', isActive);
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
                titleEl.textContent = 'All Items';
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
            }
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
        retryInit
    };
})();
