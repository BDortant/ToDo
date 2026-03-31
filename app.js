// =============================================================
// STORAGE SERVICE
// All data access goes through this module. Currently uses
// localStorage. Designed so File System Access API can replace
// the internals without changing the rest of the app.
// =============================================================
const StorageService = (() => {
    const STORAGE_KEY = 'todo_app_data';

    // Default data structure
    function defaultData() {
        return {
            projects: [],
            todos: [],
            lastBackup: null
        };
    }

    return {
        // Load all data from storage
        load() {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return defaultData();
            try {
                return JSON.parse(raw);
            } catch {
                return defaultData();
            }
        },

        // Save all data to storage
        save(data) {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        },

        // Export data as a JSON string (for file download)
        exportJSON(data) {
            return JSON.stringify(data, null, 2);
        },

        // Parse imported JSON string back into data
        importJSON(jsonString) {
            return JSON.parse(jsonString);
        },

        // Get/set last backup timestamp
        getLastBackup(data) {
            return data.lastBackup;
        },

        setLastBackup(data, timestamp) {
            data.lastBackup = timestamp;
        }
    };
})();


// =============================================================
// APP — State, logic, and rendering
// =============================================================
const App = (() => {
    let data = StorageService.load();

    let currentView = 'all';           // 'all' or 'by-project'
    let selectedProjectId = null;      // filter in sidebar
    let editingTodoTags = [];          // temp tags for the form
    let draggedRowId = null;           // drag-to-reorder

    // --- Helpers ---
    function generateId() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    function persist() {
        StorageService.save(data);
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
            const rowClass = todo.status === 'Done' ? 'done' : (todo.status === 'Cancelled' ? 'cancelled' : '');
            // Status inline select
            const statusSelect = `<select class="inline-select" onchange="App.inlineUpdate('${todo.id}', 'status', this.value)">
                ${statusOptions.map(s => `<option value="${s}" ${todo.status === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>`;

            // Effort inline select
            const effortSelect = `<select class="inline-select" onchange="App.inlineUpdate('${todo.id}', 'effort', this.value)">
                ${effortOptions.map(e => `<option value="${e}" ${todo.effort === e ? 'selected' : ''}>${e ? e.charAt(0).toUpperCase() + e.slice(1) : '—'}</option>`).join('')}
            </select>`;

            // Deadline inline input
            const deadlineInput = `<input type="date" class="inline-input" value="${todo.deadline || ''}" onchange="App.inlineUpdate('${todo.id}', 'deadline', this.value)" style="width:130px">`;

            // Assignee inline input
            const assigneeInput = `<input type="text" class="inline-input" value="${todo.assignee ? escapeHTML(todo.assignee) : ''}" placeholder="—" onblur="App.inlineUpdate('${todo.id}', 'assignee', this.value)" onkeydown="if(event.key==='Enter'){this.blur()}" style="width:100px">`;

            html += `<tr class="${rowClass}" draggable="true"
                data-id="${todo.id}"
                ondragstart="App.onDragStart(event)"
                ondragover="App.onDragOver(event)"
                ondragleave="App.onDragLeave(event)"
                ondrop="App.onDrop(event)"
                ondragend="App.onDragEnd(event)">
                <td><input type="checkbox" ${todo.status === 'Done' ? 'checked' : ''} onchange="App.toggleDone('${todo.id}')" title="Mark as done"></td>
                <td style="color:#aaa">${todo.overallPriority || '—'}</td>
                <td style="color:#aaa">${todo.projectPriority || '—'}</td>
                <td><strong>${escapeHTML(todo.title)}</strong></td>
                ${showProject ? `<td>${escapeHTML(getProjectName(todo.projectId))}</td>` : ''}
                <td>${statusSelect}</td>
                <td>${effortSelect}</td>
                <td>${deadlineInput}</td>
                <td>${assigneeInput}</td>
                <td class="notes-cell clickable-cell" onclick="App.editNotes(this, '${todo.id}')">${todo.notes ? escapeHTML(todo.notes) : '—'}</td>
                <td>${(todo.tags || []).map(t => `<span class="tag">${escapeHTML(t)}</span>`).join(' ')}</td>
                <td>
                    <button class="btn-icon" onclick="App.openTodoModal('${todo.id}')" title="Edit">✏️</button>
                    <button class="btn-icon" onclick="App.deleteTodo('${todo.id}')" title="Delete">🗑️</button>
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
            return `<li class="project-item ${active}" onclick="App.selectProject('${p.id}')">
                <span>${escapeHTML(p.name)} <span class="project-count">${count}</span></span>
                <span class="project-item-actions">
                    <button class="btn-icon" onclick="event.stopPropagation(); App.openProjectModal('${p.id}')" title="Rename">✏️</button>
                    <button class="btn-icon" onclick="event.stopPropagation(); App.deleteProject('${p.id}')" title="Delete">🗑️</button>
                </span>
            </li>`;
        }).join('');

        // View toggle
        document.querySelectorAll('#view-toggle li').forEach(li => {
            li.classList.toggle('active', li.dataset.view === currentView);
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
        if (view === 'by-project') selectedProjectId = null;
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

    function saveProject(e) {
        e.preventDefault();
        const id = document.getElementById('project-id').value;
        const name = document.getElementById('project-name').value.trim();
        if (!name) return;

        if (id) {
            const project = data.projects.find(p => p.id === id);
            project.name = name;
        } else {
            data.projects.push({ id: generateId(), name });
        }

        persist();
        closeProjectModal();
        render();
    }

    function deleteProject(id) {
        const project = data.projects.find(p => p.id === id);
        if (!confirm(`Delete project "${project.name}"? Items in this project will become unassigned.`)) return;

        data.projects = data.projects.filter(p => p.id !== id);
        // Unassign todos from this project
        data.todos.forEach(t => {
            if (t.projectId === id) t.projectId = '';
        });

        if (selectedProjectId === id) selectedProjectId = null;
        persist();
        render();
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
        }

        renderTags();
        modal.classList.add('open');
        document.getElementById('todo-title').focus();
    }

    function closeTodoModal() {
        document.getElementById('todo-modal').classList.remove('open');
    }

    function saveTodo(e) {
        e.preventDefault();
        const id = document.getElementById('todo-id').value;
        const title = document.getElementById('todo-title').value.trim();
        if (!title) return;

        const newStatus = document.getElementById('todo-status').value;

        if (id) {
            const todo = data.todos.find(t => t.id === id);
            const oldStatus = todo.status;
            todo.title = title;
            todo.status = newStatus;
            // If project changed, put it at the end of the new project's list
            const newProjectId = document.getElementById('todo-project').value;
            if (todo.projectId !== newProjectId) {
                todo.projectPriority = data.todos.filter(t => t.projectId === newProjectId).length + 1;
            }
            todo.projectId = newProjectId;
            todo.effort = document.getElementById('todo-effort').value;
            todo.deadline = document.getElementById('todo-deadline').value;
            todo.assignee = document.getElementById('todo-assignee').value.trim();
            todo.notes = document.getElementById('todo-notes').value;
            todo.tags = [...editingTodoTags];

            // Auto-set completedDate when status changes to Done
            if (newStatus === 'Done' && oldStatus !== 'Done') {
                todo.completedDate = new Date().toISOString();
            } else if (newStatus !== 'Done') {
                todo.completedDate = null;
            }
        } else {
            data.todos.push({
                id: generateId(),
                title,
                projectId: document.getElementById('todo-project').value,
                status: newStatus,
                overallPriority: data.todos.length + 1,
                projectPriority: data.todos.filter(t => t.projectId === document.getElementById('todo-project').value).length + 1,
                effort: document.getElementById('todo-effort').value,
                deadline: document.getElementById('todo-deadline').value,
                assignee: document.getElementById('todo-assignee').value.trim(),
                notes: document.getElementById('todo-notes').value,
                tags: [...editingTodoTags],
                createdDate: new Date().toISOString(),
                completedDate: newStatus === 'Done' ? new Date().toISOString() : null
            });
        }

        persist();
        closeTodoModal();
        render();
    }

    function deleteTodo(id) {
        const todo = data.todos.find(t => t.id === id);
        if (!confirm(`Delete "${todo.title}"?`)) return;

        data.todos = data.todos.filter(t => t.id !== id);
        persist();
        render();
    }

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

    function inlineUpdate(id, field, value) {
        const todo = data.todos.find(t => t.id === id);
        if (!todo) return;

        if (field === 'status') {
            const oldStatus = todo.status;
            todo.status = value;
            if (value === 'Done' && oldStatus !== 'Done') {
                todo.previousStatus = oldStatus;
                todo.completedDate = new Date().toISOString();
                movePriorityForDone(todo, true);
            } else if (value !== 'Done' && oldStatus === 'Done') {
                todo.completedDate = null;
                delete todo.previousStatus;
                movePriorityForDone(todo, false);
            }
        } else {
            todo[field] = value;
        }

        persist();
        render();
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

    // Move a done item to the top of priority lists, or restore when un-done
    function movePriorityForDone(todo, markingDone) {
        if (markingDone) {
            // Save current priorities so we can restore later
            todo.previousOverallPriority = todo.overallPriority;
            todo.previousProjectPriority = todo.projectPriority;

            // Move to top: set to 0, shift others above the old position down to fill gap
            const oldOverall = todo.overallPriority;
            data.todos.forEach(t => {
                if (t !== todo && t.overallPriority > oldOverall) t.overallPriority--;
            });
            todo.overallPriority = 0;

            if (todo.projectId) {
                const oldProject = todo.projectPriority;
                data.todos.forEach(t => {
                    if (t !== todo && t.projectId === todo.projectId && t.projectPriority > oldProject) t.projectPriority--;
                });
                todo.projectPriority = 0;
            }
        } else {
            // Restore previous priorities, shifting others to make room
            const targetOverall = todo.previousOverallPriority || 1;
            data.todos.forEach(t => {
                if (t !== todo && t.overallPriority >= targetOverall) t.overallPriority++;
            });
            todo.overallPriority = targetOverall;

            if (todo.projectId) {
                const targetProject = todo.previousProjectPriority || 1;
                data.todos.forEach(t => {
                    if (t !== todo && t.projectId === todo.projectId && t.projectPriority >= targetProject) t.projectPriority++;
                });
                todo.projectPriority = targetProject;
            }

            delete todo.previousOverallPriority;
            delete todo.previousProjectPriority;
        }
    }

    function toggleDone(id) {
        const todo = data.todos.find(t => t.id === id);
        if (!todo) return;

        if (todo.status === 'Done') {
            todo.status = todo.previousStatus || 'To Do';
            todo.completedDate = null;
            delete todo.previousStatus;
            movePriorityForDone(todo, false);
        } else {
            todo.previousStatus = todo.status;
            todo.status = 'Done';
            todo.completedDate = new Date().toISOString();
            movePriorityForDone(todo, true);
        }

        persist();
        render();
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

    function onDrop(e) {
        e.preventDefault();
        e.currentTarget.classList.remove('drag-over-top', 'drag-over-bottom');
        const targetId = e.currentTarget.dataset.id;
        if (!draggedRowId || draggedRowId === targetId) return;

        const draggedTodo = data.todos.find(t => t.id === draggedRowId);
        const targetTodo = data.todos.find(t => t.id === targetId);
        if (!draggedTodo || !targetTodo) return;

        // Insert the dragged item at the target position, shifting others accordingly
        const useProjectPriority = currentView === 'by-project' || selectedProjectId;
        const key = useProjectPriority ? 'projectPriority' : 'overallPriority';

        const fromPos = draggedTodo[key];
        const toPos = targetTodo[key];

        // Get all todos that participate in this priority space
        const affected = useProjectPriority
            ? data.todos.filter(t => t.projectId === draggedTodo.projectId)
            : data.todos;

        if (fromPos < toPos) {
            // Dragging down: shift items between fromPos+1 and toPos up by 1
            affected.forEach(t => {
                if (t[key] > fromPos && t[key] <= toPos) t[key]--;
            });
        } else {
            // Dragging up: shift items between toPos and fromPos-1 down by 1
            affected.forEach(t => {
                if (t[key] >= toPos && t[key] < fromPos) t[key]++;
            });
        }
        draggedTodo[key] = toPos;

        persist();
        render();
    }

    function onDragEnd(e) {
        e.currentTarget.classList.remove('dragging');
        draggedRowId = null;
        document.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(el => el.classList.remove('drag-over-top', 'drag-over-bottom'));
    }

    // --- Export / Import ---
    function cleanup() {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Find the cutoff: start of last working day
        const cutoff = new Date(today);
        const dayOfWeek = today.getDay();
        if (dayOfWeek === 1) cutoff.setDate(cutoff.getDate() - 3);       // Monday -> Friday
        else if (dayOfWeek === 0) cutoff.setDate(cutoff.getDate() - 2);   // Sunday -> Friday
        else if (dayOfWeek === 6) cutoff.setDate(cutoff.getDate() - 1);   // Saturday -> Friday
        else cutoff.setDate(cutoff.getDate() - 1);                        // Weekday -> yesterday

        const toRemove = data.todos.filter(t =>
            t.status === 'Done' && t.completedDate && new Date(t.completedDate) < cutoff
        );

        if (toRemove.length === 0) {
            alert('Nothing to clean up.');
            return;
        }

        if (!confirm(`Remove ${toRemove.length} task(s) completed before ${cutoff.toLocaleDateString()}?`)) return;

        const removeIds = new Set(toRemove.map(t => t.id));
        data.todos = data.todos.filter(t => !removeIds.has(t.id));

        persist();
        render();
    }

    function exportData() {
        StorageService.setLastBackup(data, new Date().toISOString());
        persist();

        const json = StorageService.exportJSON(data);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `todo-backup-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);

        document.getElementById('backup-banner').classList.remove('show');
    }

    function importData(e) {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function(event) {
            try {
                const imported = StorageService.importJSON(event.target.result);
                if (!imported.projects || !imported.todos) {
                    throw new Error('Invalid format');
                }
                data = imported;
                persist();
                render();
                alert('Data imported successfully!');
            } catch {
                alert('Failed to import: invalid file format.');
            }
        };
        reader.readAsText(file);
        e.target.value = '';
    }

    // --- Auto-backup check ---
    function checkBackup() {
        const last = StorageService.getLastBackup(data);
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
    function init() {
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

        checkBackup();
        render();
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
        dismissBackupBanner
    };
})();
