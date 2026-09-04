// Weekly update tab: rendering, todo suggestions, mail details, and the
// save lifecycle. The save tests are the important ones — every bug this
// feature actually had lost written work.
import {
    makeDom, loadWeekly, stubApp, stubFetch, httpError,
    section, check, report, tick, afterAutosave
} from './helpers.mjs';

const { window } = makeDom();

const today = new Date();
const dmy = `${today.getDate()}-${today.getMonth() + 1}-${today.getFullYear()}`;
const recent = new Date(Date.now() - 2 * 86400000).toISOString();

let TODOS = [];
stubApp(() => TODOS);
const Weekly = loadWeekly();

const container = window.document.getElementById('main-content');
const editor = () => window.document.getElementById('weekly-editor');
const preview = () => window.document.getElementById('weekly-preview');
const suggestions = () => window.document.getElementById('weekly-suggestions');

const EMPTY_META = { recipientsTo: '', recipientsCc: '', greeting: '', clientName: '', factsSlug: '' };

// A real keystroke updates the textarea, then fires oninput.
function type(text) {
    editor().value = text;
    Weekly.onInput(text);
}

// ---------------------------------------------------------------------------
section('mount and template');

TODOS = [
    { id: 'a1', projectId: 'P', title: 'D5456 staging deploy', status: 'In Progress', tags: ['weekly'], completedDate: null },
    { id: 'a2', projectId: 'P', title: 'D7057 estimate goedkeuring', status: 'Waiting on Client', tags: ['weekly'], completedDate: null },
    { id: 'a3', projectId: 'P', title: 'D5148 productkleur fix', status: 'Done', tags: ['weekly'], completedDate: recent },
    { id: 'a4', projectId: 'P', title: 'Oude klus', status: 'Done', tags: ['weekly'], completedDate: '2026-01-01T00:00:00Z' },
    { id: 'a5', projectId: 'P', title: 'Niet vermelden', status: 'To Do', tags: [], completedDate: null },
    { id: 'a6', projectId: 'P', title: 'Forced naar klant', status: 'In Progress', tags: ['wu:client'], completedDate: null },
    { id: 'a7', projectId: 'P', title: 'Overgeslagen', status: 'To Do', tags: ['weekly', 'wu:skip'], completedDate: null },
    { id: 'a8', projectId: 'OTHER', title: 'Ander project', status: 'To Do', tags: ['weekly'], completedDate: null }
];

stubFetch({
    'GET /meta': EMPTY_META,
    'GET /weekly': { projectId: 'P', markdown: '', updatedDate: null },
    'GET /weekly/archive': [],
    'PUT /weekly': { projectId: 'P', markdown: '', updatedDate: new Date().toISOString() }
});

await Weekly.mount('P', 'Hendrix', container);
await tick();

check('the editor is rendered', !!editor());
check('an empty project is seeded with the template', editor().value.includes('## Noemenswaardige (recente) ontwikkelingen'));
check('the template carries the signature', editor().value.includes('Bram Dortant'));
check('the subject uses the new format', editor().value.includes(`**Subject:** Hendrix - Wekelijkse update ${dmy}`),
    editor().value.split('\n').find(l => l.startsWith('**Subject:**')));
check('isMounted is true for this project', Weekly.isMounted('P'));
check('isMounted is false for another', !Weekly.isMounted('Q'));

// ---------------------------------------------------------------------------
section('preview');

check('the preview has content', preview().innerHTML.length > 100);
check('the To/Subject header is excluded', !preview().textContent.includes('Wekelijkse update'));
check('the mail body is included', preview().textContent.includes('Hierbij onze periodieke update'));
check('headings become <p><span> for Outlook', /<p style="margin:16px 0 4px[\s\S]*?<span style="font-family:Calibri/.test(preview().innerHTML));
check('table headers use the accent colour', preview().innerHTML.includes('background-color:#F7921E'));
check('no raw <h2> survives', !/<h2/i.test(preview().innerHTML));

// ---------------------------------------------------------------------------
section('raw HTML is escaped, not rendered');

const seeded = editor().value;
type('**To:** x\n\n---\n\nHallo <img src=x onerror="alert(1)"> einde\n\n<script>alert(2)<\/script>\n');
check('no <img> element is created', !/<img/i.test(preview().innerHTML), preview().innerHTML.slice(0, 160));
check('no <script> element is created', !/<script/i.test(preview().innerHTML));
check('the tag is still readable as text', preview().textContent.includes('<img src=x'));
check('ordinary markdown still renders', /<p style=/.test(preview().innerHTML));
type(seeded);

// ---------------------------------------------------------------------------
section('suggestions from todos');

const text = suggestions().textContent;
check('an untagged todo is excluded', !text.includes('Niet vermelden'));
check('wu:skip is excluded', !text.includes('Overgeslagen'));
check('another project is excluded', !text.includes('Ander project'));
check('a Done item older than the lookback is excluded', !text.includes('Oude klus'));
check('a recent Done item is included', text.includes('D5148 productkleur fix'));
check('an in-progress item is included', text.includes('D5456 staging deploy'));
check('a wu:* override implies inclusion', text.includes('Forced naar klant'));

const groups = [...suggestions().querySelectorAll('.weekly-suggest-group')].map(g => ({
    heading: g.querySelector('h4').textContent.trim(),
    items: [...g.querySelectorAll('li')].map(li => li.querySelector('.weekly-suggest-title').textContent.trim())
}));
const groupOf = (title) => (groups.find(g => g.items.includes(title)) || {}).heading;

check('Done maps to Noemenswaardige', groupOf('D5148 productkleur fix') === 'Noemenswaardige ontwikkelingen', groupOf('D5148 productkleur fix'));
check('Waiting on Client maps to Benodigde acties', groupOf('D7057 estimate goedkeuring') === 'Benodigde acties vanuit jullie', groupOf('D7057 estimate goedkeuring'));
check('In Progress maps to Geplande acties', groupOf('D5456 staging deploy') === 'Geplande acties vanuit ons', groupOf('D5456 staging deploy'));
check('an override beats the status mapping', groupOf('Forced naar klant') === 'Benodigde acties vanuit jullie', groupOf('Forced naar klant'));

// ---------------------------------------------------------------------------
section('inserting and removing bullets');

Weekly.insertSuggestion('us', 'a1');
let lines = editor().value.split('\n');
const usIdx = lines.findIndex(l => /^##\s+Geplande acties/.test(l));
const nextIdx = lines.findIndex((l, i) => i > usIdx && /^##\s/.test(l));
const usBlock = lines.slice(usIdx, nextIdx);

check('the bullet lands in the right section', usBlock.includes('- D5456 staging deploy'), usBlock.join(' | '));
check('a blank line is kept under the heading', usBlock[1] === '');
check('the bullet is above the signature',
    editor().value.indexOf('- D5456 staging deploy') < editor().value.indexOf('Met vriendelijke groet'));

Weekly.insertSuggestion('us', 'a1');
check('a second bullet stacks under the first', /- D5456 staging deploy\n- D5456 staging deploy/.test(editor().value));

const rowFor = (needle) => [...window.document.querySelectorAll('.weekly-suggest-group li')]
    .find(li => li.textContent.includes(needle));
check('the row is marked as in-draft', rowFor('D5456').classList.contains('mentioned'));
check('an unmentioned row is not', !rowFor('D7057').classList.contains('mentioned'));

Weekly.removeSuggestion('a1');
check('removal takes out every matching bullet', !editor().value.includes('- D5456 staging deploy'));
check('other sections are untouched', editor().value.includes('## Benodigde acties vanuit jullie (klant)'));
check('the row flips back to insertable', !rowFor('D5456').classList.contains('mentioned'));

// A mention in prose is not a bullet: removal must not guess at an edit.
Weekly.insertSuggestion('us', 'a1');
type(editor().value.replace('- D5456 staging deploy', 'Losse zin over D5456 zonder bullet.'));
check('a prose mention still counts as mentioned', rowFor('D5456').classList.contains('mentioned'));
Weekly.removeSuggestion('a1');
check('prose is left alone rather than mangled', editor().value.includes('Losse zin over D5456 zonder bullet.'));

// ---------------------------------------------------------------------------
section('untagging');

let patched = null;
global.App.setTodoTags = async (id, tags) => {
    patched = { id, tags };
    TODOS = TODOS.map(t => (t.id === id ? { ...t, tags } : t));
};
await Weekly.untagSuggestion('a2');
check('the weekly tag is stripped', patched && patched.id === 'a2' && !patched.tags.includes('weekly'), JSON.stringify(patched));
await Weekly.untagSuggestion('a6');
check('wu:* overrides are stripped too', patched && !patched.tags.some(t => t.startsWith('wu:')), JSON.stringify(patched));
check('the item leaves the list', !suggestions().textContent.includes('D7057 estimate goedkeuring'));

// ---------------------------------------------------------------------------
section('mail details prefill');

const META = {
    recipientsTo: 'Jules Seelen <jules@seelen.nl>',
    recipientsCc: 'Jasper Bauer <jasper@zeroplex.nl>',
    greeting: 'Jules',
    clientName: 'Hendrix Fruit',
    factsSlug: 'hendrix-fruit'
};
stubFetch({
    'GET /meta': META,
    'GET /weekly': { projectId: 'P2', markdown: '', updatedDate: null },
    'GET /weekly/archive': [],
    'PUT /weekly': {}
});
await Weekly.mount('P2', 'Hendrix', container);
await tick();

const filled = editor().value;
check('To is prefilled', filled.includes('**To:** Jules Seelen <jules@seelen.nl>'));
check('Cc is prefilled', filled.includes('**Cc:** Jasper Bauer <jasper@zeroplex.nl>'));
check('the greeting is prefilled', filled.includes('Hoi Jules,'));
check('the subject uses the client name', filled.includes(`**Subject:** Hendrix Fruit - Wekelijkse update ${dmy}`));
check('no placeholders are left', !filled.includes('{voornaam}') && !filled.includes('{vul de ontvanger'));

// Apply to draft rewrites the header lines of an existing draft.
type(filled.replace('**To:** Jules Seelen <jules@seelen.nl>', '**To:** iemand anders').replace('Hoi Jules,', 'Hoi Piet,'));
Weekly.applyMeta();
check('Apply rewrites To', editor().value.includes('**To:** Jules Seelen <jules@seelen.nl>'));
check('Apply rewrites the greeting', editor().value.includes('Hoi Jules,'));
check('Apply leaves the body prose alone', editor().value.includes('Bij situaties die urgentie verlangen'));
check('Apply leaves the signature alone', editor().value.includes('Bram Dortant'));

// An older draft still carrying placeholders is resolved on open.
const stale = `**To:** {vul de ontvanger(s) in}
**Cc:** {vul in of verwijder}
**Subject:** ZeroPlex - periodieke update Alex - week 35

---

Hoi {voornaam},

Handgeschreven zin die moet blijven staan.
`;
stubFetch({
    'GET /meta': META,
    'GET /weekly': { projectId: 'P3', markdown: stale, updatedDate: 'x' },
    'GET /weekly/archive': [],
    'PUT /weekly': {}
});
await Weekly.mount('P3', 'Alex', container);
await tick();
check('placeholders are resolved on open', editor().value.includes('**To:** Jules Seelen <jules@seelen.nl>'));
check('the greeting placeholder is resolved', editor().value.includes('Hoi Jules,'));
check('hand-written prose is preserved', editor().value.includes('Handgeschreven zin die moet blijven staan.'));
check('a legacy subject is left for Apply to fix', editor().value.includes('periodieke update Alex - week 35'));
Weekly.applyMeta();
check('Apply upgrades a legacy subject', editor().value.includes('**Subject:** Hendrix Fruit - Wekelijkse update ') && !editor().value.includes(' - week '));

// ---------------------------------------------------------------------------
section('$-patterns in stored values are inserted literally');

const DOLLAR = { recipientsTo: 'a$&b@example.com', recipientsCc: '', greeting: "O'$1Brien", clientName: 'A$`B', factsSlug: '' };
stubFetch({
    'GET /meta': DOLLAR,
    'GET /weekly': { projectId: 'P4', markdown: '', updatedDate: null },
    'GET /weekly/archive': [],
    'PUT /weekly': {}
});
await Weekly.mount('P4', 'Test', container);
await tick();
check('$& in a recipient survives the template', editor().value.includes('**To:** a$&b@example.com'),
    editor().value.split('\n')[0]);
check('$1 in a greeting survives', editor().value.includes("Hoi O'$1Brien,"));
check('$` in a client name survives', editor().value.includes('**Subject:** A$`B - Wekelijkse update '));

stubFetch({
    'GET /meta': DOLLAR,
    'GET /weekly': { projectId: 'P5', markdown: '**To:** {vul de ontvanger(s) in}\n\n---\n\nHoi {voornaam},\n', updatedDate: 'x' },
    'GET /weekly/archive': [],
    'PUT /weekly': {}
});
await Weekly.mount('P5', 'Test', container);
await tick();
check('$& survives the placeholder fill too', editor().value.includes('**To:** a$&b@example.com'));
check('$1 survives the placeholder fill too', editor().value.includes("Hoi O'$1Brien,"));

// ---------------------------------------------------------------------------
section('a failed final save is reported, not swallowed');

let alerts = [];
global.alert = (m) => alerts.push(m);

const base = '**To:** x\n\n---\n\nBestaande tekst\n';
stubFetch({
    'GET /meta': EMPTY_META,
    'GET /weekly': { projectId: 'P6', markdown: base, updatedDate: 'x' },
    'GET /weekly/archive': [],
    'PUT /weekly': {}
});
await Weekly.mount('P6', 'Hendrix', container);
await tick();

type(`${base}\n- Belangrijke bullet van dinsdag\n`);
stubFetch({ 'PUT /weekly': httpError() });
Weekly.unmount();
await tick(80);
check('the user is warned the edit was not saved', alerts.length === 1, JSON.stringify(alerts));
check('the warning names the project', alerts[0] && alerts[0].includes('Hendrix'), alerts[0]);
check('the warning says the edits were lost', alerts[0] && /not stored/i.test(alerts[0]));

alerts = [];
stubFetch({
    'GET /meta': EMPTY_META,
    'GET /weekly': { projectId: 'P6', markdown: base, updatedDate: 'x' },
    'GET /weekly/archive': [],
    'PUT /weekly': {}
});
await Weekly.mount('P6', 'Hendrix', container);
await tick();
type(`${base}\n- nog een bullet\n`);
Weekly.unmount();
await tick(80);
check('a successful final save stays silent', alerts.length === 0, JSON.stringify(alerts));

// ---------------------------------------------------------------------------
section('a draft left in the error state is retried on the way out');

alerts = [];
const puts = [];
let failPut = false;
stubFetch({
    'GET /meta': EMPTY_META,
    'GET /weekly': { projectId: 'P7', markdown: base, updatedDate: 'x' },
    'GET /weekly/archive': [],
    'PUT /weekly': (body) => {
        puts.push(body.markdown);
        return failPut ? httpError() : {};
    }
});
await Weekly.mount('P7', 'Hendrix', container);
await tick();
failPut = true;
type(`${base}\n- bullet die moet blijven\n`);
await afterAutosave();                       // the autosave fires and fails
const before = puts.length;
Weekly.unmount();                            // leave without typing again
await tick(80);
check('leaving retries the failed save', puts.length > before, `${before} -> ${puts.length}`);
check('the retry carries the unsaved text', puts[puts.length - 1].includes('bullet die moet blijven'));
check('the user is warned it failed again', alerts.length === 1 && /not stored/i.test(alerts[0]), JSON.stringify(alerts));

// ---------------------------------------------------------------------------
section('archiving waits for a save already on the wire');

let releasePut;
const putGate = new Promise(r => { releasePut = r; });
const calls = stubFetch({
    'GET /meta': EMPTY_META,
    'GET /weekly': { projectId: 'P8', markdown: '**To:** x\n\n---\n\nOude week\n', updatedDate: 'x' },
    'GET /weekly/archive': [],
    'PUT /weekly': async () => { await putGate; return {}; },
    'POST /weekly/archive': { archived: { id: 'a1' }, draft: { projectId: 'P8', markdown: 'NIEUWE WEEK' } }
});
await Weekly.mount('P8', 'Hendrix', container);
await tick();
type('**To:** x\n\n---\n\nOude week\n\n- late bullet\n');
await afterAutosave();                       // the PUT is now hanging

calls.length = 0;
const archiving = Weekly.archiveAndReset();
await tick();
check('the archive POST is held back', !calls.some(c => c.includes('POST')), calls.join(' | '));
releasePut();
await archiving;
check('the PUT completed before the archive POST',
    calls.indexOf('PUT /api/projects/P8/weekly') < calls.indexOf('POST /api/projects/P8/weekly/archive'), calls.join(' | '));
check('the editor lands on the new week', editor().value === 'NIEUWE WEEK', editor().value.slice(0, 60));

// ---------------------------------------------------------------------------
section('archiving is refused when the save did not land');

alerts = [];
let archivePosted = false;
stubFetch({
    'GET /meta': EMPTY_META,
    'GET /weekly': { projectId: 'P9', markdown: '**To:** x\n\n---\n\nOude tekst\n', updatedDate: 'x' },
    'GET /weekly/archive': [],
    'PUT /weekly': httpError(),
    'POST /weekly/archive': () => { archivePosted = true; return { archived: { id: 'a' }, draft: { markdown: 'NIEUW' } }; }
});
await Weekly.mount('P9', 'Hendrix', container);
await tick();
type('**To:** x\n\n---\n\nOude tekst\n\n- bullet die nog niet opgeslagen is\n');
await Weekly.archiveAndReset();
check('the archive POST is not sent', !archivePosted);
check('the user is told why', alerts.length === 1 && /not been saved/i.test(alerts[0]), JSON.stringify(alerts));
check('the unsaved text stays in the editor', editor().value.includes('bullet die nog niet opgeslagen is'));

// ---------------------------------------------------------------------------
section('a torn-down save does not consume the next session\'s save');

const sessionPuts = [];
let releaseA;
const gateA = new Promise(r => { releaseA = r; });
stubFetch({
    'GET /meta': EMPTY_META,
    'GET /weekly': { projectId: 'x', markdown: '**To:** x\n\n---\n\nbasis\n', updatedDate: 'x' },
    'GET /weekly/archive': [],
    'PUT /weekly': async (body) => {
        sessionPuts.push(body.markdown);
        if (body.markdown.includes('PROJECT A EDIT')) await gateA;
        return {};
    }
});
await Weekly.mount('PA', 'Alpha', container);
await tick();
type('**To:** x\n\n---\n\nbasis\n\n- PROJECT A EDIT\n');
await afterAutosave();                       // A's PUT is hanging
Weekly.unmount();                            // leave A mid-save
await Weekly.mount('PB', 'Beta', container); // straight into B
await tick();
type('**To:** x\n\n---\n\nbasis\n\n- PROJECT B EDIT\n');
releaseA();
await afterAutosave();
check("project A's edit reached the server", sessionPuts.some(t => t.includes('PROJECT A EDIT')));
check("project B's edit reached the server too", sessionPuts.some(t => t.includes('PROJECT B EDIT')),
    JSON.stringify(sessionPuts.map(t => t.slice(-18))));

// ---------------------------------------------------------------------------
section('a stale session cannot write into the one that replaced it');

let releaseFirst;
const firstLoad = new Promise(r => { releaseFirst = r; });
let loadNo = 0;
stubFetch({
    'GET /meta': EMPTY_META,
    'GET /weekly/archive': [],
    'GET /weekly': async () => {
        loadNo++;
        if (loadNo === 1) { await firstLoad; return { projectId: 'PC', markdown: 'OUDE TRAAG GELADEN TEKST', updatedDate: 'x' }; }
        return { projectId: 'PC', markdown: 'VERSE TEKST', updatedDate: 'y' };
    },
    'PUT /weekly': {}
});
const slowMount = Weekly.mount('PC', 'Hendrix', container);
await tick(20);
Weekly.unmount();                            // leave
await Weekly.mount('PC', 'Hendrix', container);   // and return to the SAME project
await tick();
check('the fresh load is showing', editor().value === 'VERSE TEKST', editor().value.slice(0, 40));
releaseFirst();
await slowMount;
await tick();
check('the abandoned load does not overwrite it', editor().value === 'VERSE TEKST', editor().value.slice(0, 40));

// ---------------------------------------------------------------------------
section('mail details cannot land on the wrong project');

let releaseMeta;
const metaGate = new Promise(r => { releaseMeta = r; });
stubFetch({
    'GET /meta': { projectId: 'x', recipientsTo: 'nha@example.nl', recipientsCc: '', greeting: 'Bart', clientName: '' },
    'PUT /meta': async () => {
        await metaGate;
        return { projectId: 'PD', recipientsTo: 'hendrix@example.nl', recipientsCc: '', greeting: 'Jules', clientName: '' };
    },
    'GET /weekly': { projectId: 'x', markdown: '**To:** nha@example.nl\n\n---\n\nNHA\n', updatedDate: 'x' },
    'GET /weekly/archive': [],
    'PUT /weekly': {}
});
await Weekly.mount('PD', 'Hendrix', container);
await tick();
const metaSave = Weekly.onMetaChange('recipientsTo', 'hendrix@example.nl');
await Weekly.mount('PE', 'NHA', container);   // switch project mid-save
await tick();
releaseMeta();
await metaSave;
await tick();
Weekly.applyMeta();
check("Hendrix's recipients do not leak into the NHA draft", !editor().value.includes('hendrix@example.nl'), editor().value.split('\n')[0]);
check('the NHA draft keeps its own recipients', editor().value.includes('nha@example.nl'), editor().value.split('\n')[0]);

// ---------------------------------------------------------------------------
section('mail-detail writes are applied in order');

const metaOrder = [];
let releaseSlowMeta;
const slowMeta = new Promise(r => { releaseSlowMeta = r; });
stubFetch({
    'GET /meta': EMPTY_META,
    'GET /weekly': { projectId: 'PF', markdown: '', updatedDate: null },
    'GET /weekly/archive': [],
    'PUT /weekly': {},
    'PUT /meta': async (body) => {
        if (body.recipientsTo === 'eerste@example.nl') await slowMeta;
        metaOrder.push(body.recipientsTo);
        return { ...EMPTY_META, recipientsTo: body.recipientsTo };
    }
});
await Weekly.mount('PF', 'Hendrix', container);
await tick();
const w1 = Weekly.onMetaChange('recipientsTo', 'eerste@example.nl');
const w2 = Weekly.onMetaChange('recipientsTo', 'tweede@example.nl');
releaseSlowMeta();
await Promise.all([w1, w2]);
check('writes reach the server in the order they were made',
    metaOrder.join(',') === 'eerste@example.nl,tweede@example.nl', metaOrder.join(','));
check('the last edit is the stored one', metaOrder[metaOrder.length - 1] === 'tweede@example.nl');

// ---------------------------------------------------------------------------
section('layout toggle');

Weekly.setLayout('preview');
check('the layout attribute follows the toggle', window.document.querySelector('.weekly-pane').dataset.layout === 'preview');
Weekly.setLayout('split');
check('and switches back', window.document.querySelector('.weekly-pane').dataset.layout === 'split');

report();
