// Task-list shell: the project tabs, the sidebar counts, and the handover
// between app.js and weekly.js. Loads both real files into jsdom.
import { makeDom, loadWeekly, loadApp, section, check, report, tick } from './helpers.mjs';

const { window } = makeDom();

const STATE = {
    projects: [
        { id: 'P1', name: 'Hendrix' },
        { id: 'P2', name: 'NHA' },
        { id: 'P3', name: 'Vitalve' },
        { id: 'P4', name: 'GMS' }
    ],
    todos: [
        // Hendrix: 1 open + 1 cancelled -> counts as 1, no waiting badge.
        todo('t1', 'D5456 staging', 'P1', 'In Progress', ['weekly']),
        todo('t4', 'Afgeblazen klus', 'P1', 'Cancelled'),
        // NHA: 1 open, and it is waiting on the client -> 1 open / 1 waiting, parked.
        todo('t6', 'NHA open klus', 'P2', 'Waiting on Client'),
        todo('t7', 'NHA afgerond', 'P2', 'Done'),
        // Vitalve: only a Done item -> reads 0, and is not "parked".
        todo('t3', 'Livegang afgerond', 'P3', 'Done'),
        // GMS: 3 open, of which 1 waiting on a third party.
        todo('t8', 'GMS klus A', 'P4', 'To Do'),
        todo('t9', 'GMS klus B', 'P4', 'Waiting on Me'),
        todo('t10', 'GMS klus C', 'P4', 'Waiting on Third Party'),
        // Unassigned: 1 open + 1 done, for the pinned "No Project" row.
        todo('t2', 'Los item', '', 'To Do'),
        todo('t5', 'Los afgerond', '', 'Done')
    ],
    lastBackup: null
};

function todo(id, title, projectId, status, tags = []) {
    const off = status === 'Done' || status === 'Cancelled';
    return {
        id, title, projectId, status, tags,
        overallPriority: off ? 0 : 1, projectPriority: off ? 0 : 1,
        effort: '', deadline: '', assignee: '', notes: '',
        createdDate: '2026-08-01T00:00:00Z',
        completedDate: status === 'Done' ? '2026-08-20T00:00:00Z' : null,
        snoozeUntil: null
    };
}

const impl = async (url, opts) => {
    const method = (opts && opts.method) || 'GET';
    let body = {};
    if (url === '/api/state') body = STATE;
    else if (/\/weekly$/.test(url) && method === 'GET') body = { projectId: 'P1', markdown: '', updatedDate: null };
    else if (/\/weekly\/archive$/.test(url)) body = [];
    else if (/\/meta$/.test(url)) body = { recipientsTo: '', recipientsCc: '', greeting: '', clientName: '', factsSlug: '' };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
};
global.fetch = impl;
window.fetch = impl;

const errors = [];
const realError = console.error;
console.error = (...a) => { errors.push(a.map(String).join(' ')); realError(...a); };

loadWeekly();
const App = loadApp();
await tick(100);              // let init()'s async load settle

const tabs = window.document.getElementById('project-tabs');
const filters = window.document.querySelector('.filters-bar');
const content = window.document.getElementById('main-content');

// ---------------------------------------------------------------------------
section('the tabs belong to a project, not to the shared views');

check('hidden when no project is selected', tabs.hidden === true);
check('the filter bar is visible', filters.hidden === false);
check('the table is rendered', !!content.querySelector('table.todo-table'));

App.selectProject('P1');
check('shown for a real project', tabs.hidden === false);
check('List is the active tab', tabs.querySelector('[data-tab="list"]').classList.contains('active'));
check('the filter bar is still visible', filters.hidden === false);

App.setProjectTab('weekly');
await tick(80);
check('Weekly becomes the active tab', tabs.querySelector('[data-tab="weekly"]').classList.contains('active'));
check('the filter bar is hidden on the weekly tab', filters.hidden === true);
check('the editor is mounted', !!window.document.getElementById('weekly-editor'));
check('the table is gone', !content.querySelector('table.todo-table'));
check('a weekly-tagged todo shows as a suggestion',
    window.document.getElementById('weekly-suggestions').textContent.includes('D5456 staging'));

const before = window.document.getElementById('weekly-editor');
window.document.getElementById('weekly-editor').focus();
App.render();
check('a re-render mid-edit does not replace the textarea', window.document.getElementById('weekly-editor') === before);

App.selectProject('P2');
await tick(80);
check('switching project stays on the weekly tab', tabs.querySelector('[data-tab="weekly"]').classList.contains('active'));
check('and remounts the editor', !!window.document.getElementById('weekly-editor'));

App.setView('by-project');
check('leaving a project hides the tabs', tabs.hidden === true);
check('the filter bar comes back', filters.hidden === false);
check('the tab resets to List', tabs.querySelector('[data-tab="list"]').classList.contains('active'));
check('by-project shows tables, not the editor',
    !window.document.getElementById('weekly-editor') && !!content.querySelector('table.todo-table'));

App.setView('all');
App.selectProject('__no_project__');
check('hidden for the pinned "No Project" entry', tabs.hidden === true);
App.selectProject('__no_project__');   // deselect

// ---------------------------------------------------------------------------
section('sidebar counts show open work only');

App.setView('all');
App.selectProject(null);

const rowFor = (name) => [...window.document.querySelectorAll('#project-list .project-item')]
    .find(el => el.textContent.includes(name));
const badges = (name) => [...rowFor(name).querySelectorAll('.project-count')].map(b => b.textContent.trim());

check('a project whose only todo is Done reads 0', badges('Vitalve')[0] === '0', badges('Vitalve').join(','));
check('a Cancelled item is not counted', badges('Hendrix')[0] === '1', badges('Hendrix').join(','));
check('1 open + 1 Done reads 1', badges('NHA')[0] === '1', badges('NHA').join(','));
check('the No Project row excludes its Done item', badges('No Project')[0] === '1', badges('No Project').join(','));

// ---------------------------------------------------------------------------
section('the waiting badge is a subset, not a second total');

const waitingBadge = (name) => rowFor(name).querySelector('.project-count.waiting');

check('NHA shows 1 open of which 1 waiting', badges('NHA').join(',') === '1,1', badges('NHA').join(','));
check('NHA is dimmed as fully parked', rowFor('NHA').classList.contains('parked'));
check('Hendrix shows only the open badge', badges('Hendrix').join(',') === '1', badges('Hendrix').join(','));
check('Hendrix is not parked', !rowFor('Hendrix').classList.contains('parked'));
check('GMS shows 3 open of which 1 waiting', badges('GMS').join(',') === '3,1', badges('GMS').join(','));
check('GMS is not parked', !rowFor('GMS').classList.contains('parked'));
check('Waiting on Me does not count as waiting on others', badges('GMS')[1] === '1');
check('a project with 0 open is not parked', !rowFor('Vitalve').classList.contains('parked'));
check('the waiting badge explains itself',
    /waiting on the client or a third party/.test(waitingBadge('NHA').getAttribute('title')));

// ---------------------------------------------------------------------------
section('finished rows carry no priority number');

App.selectProject('P3');
const cells = [...content.querySelectorAll('tbody tr td')].slice(1, 3).map(td => td.textContent.trim());
check('both priority columns render an em dash', cells.every(c => c === '—'), JSON.stringify(cells));
App.selectProject('P3');   // deselect

// ---------------------------------------------------------------------------
section('accessibility wiring');

App.setView('all');
App.selectProject('P1');
const listTab = tabs.querySelector('[data-tab="list"]');
const weeklyTab = tabs.querySelector('[data-tab="weekly"]');

check('each tab names the panel it controls',
    listTab.getAttribute('aria-controls') === 'main-content' && weeklyTab.getAttribute('aria-controls') === 'main-content');
check('the panel is a tabpanel', content.getAttribute('role') === 'tabpanel', content.getAttribute('role'));
check('the panel is labelled by the selected tab', content.getAttribute('aria-labelledby') === 'project-tab-list');

App.setProjectTab('weekly');
await tick(80);
check('the label follows the tab switch', content.getAttribute('aria-labelledby') === 'project-tab-weekly');
check('aria-selected follows too',
    weeklyTab.getAttribute('aria-selected') === 'true' && listTab.getAttribute('aria-selected') === 'false');

App.setView('by-project');
check('no orphan tabpanel role outside a project', !content.hasAttribute('role'));
check('no orphan label outside a project', !content.hasAttribute('aria-labelledby'));

const dialog = window.document.querySelector('#weekly-archive-modal .modal');
check('the archive overlay is a dialog', dialog.getAttribute('role') === 'dialog');
check('it is modal', dialog.getAttribute('aria-modal') === 'true');
check('it is named by its heading',
    dialog.getAttribute('aria-labelledby') === 'weekly-archive-title'
    && !!window.document.getElementById('weekly-archive-title'));

// ---------------------------------------------------------------------------
section('console');

check('nothing was logged as an error', errors.length === 0, errors.join('\n       '));

report();
