// Shared test harness.
//
// These are not unit tests in the purist sense: they load the REAL frontend
// files into a jsdom document and drive them. That is deliberate. The bugs
// this app actually had were lifecycle bugs — a save landing after a project
// switch, a teardown consuming another session's dirty flag — and none of
// them are visible when you test a function in isolation with mocks.
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// --- assertions ------------------------------------------------------------

let pass = 0;
let fail = 0;

export function section(name) {
    console.log(`\n[${name}]`);
}

export function check(name, condition, detail) {
    if (condition) {
        pass++;
        console.log(`  ok   ${name}`);
    } else {
        fail++;
        console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
    }
}

export function report() {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
}

// --- environment -----------------------------------------------------------

/**
 * Build a jsdom document from the real index.html and expose the globals the
 * frontend closes over. `withApp` also loads app.js, which boots itself on
 * load and needs a working /api/state.
 */
export function makeDom({ withApp = false, css = false } = {}) {
    let html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
    if (css) {
        const style = fs.readFileSync(path.join(REPO, 'style.css'), 'utf8');
        html = html.replace('<link rel="stylesheet" href="style.css">', `<style>${style}</style>`);
    }

    const dom = new JSDOM(html, { url: 'http://localhost:8084', pretendToBeVisual: true });
    const { window } = dom;

    global.window = window;
    global.document = window.document;
    global.navigator = window.navigator;
    global.confirm = () => true;
    global.alert = () => {};
    window.document.execCommand = () => true;

    // marked, loaded the same way index.html does.
    const marked = fs.readFileSync(path.join(REPO, 'vendor', 'marked.min.js'), 'utf8');
    new Function('window', 'globalThis', marked).call(window, window, window);
    global.marked = window.marked;

    return { dom, window };
}

export function loadWeekly() {
    const src = fs.readFileSync(path.join(REPO, 'weekly.js'), 'utf8');
    const Weekly = new Function(`${src}; return Weekly;`)();
    global.Weekly = Weekly;
    global.window.Weekly = Weekly;
    return Weekly;
}

export function loadApp() {
    const src = fs.readFileSync(path.join(REPO, 'app.js'), 'utf8');
    const App = new Function(`${src}; return App;`)();
    global.App = App;
    global.window.App = App;
    return App;
}

/**
 * Minimal App stand-in for the weekly suite: weekly.js only reads todos and
 * the two escapers, so loading the whole task list would add noise.
 */
export function stubApp(getTodos) {
    const App = {
        getTodos,
        setTodoTags: async () => {},
        escapeHTML: (s) => {
            const d = global.window.document.createElement('div');
            d.textContent = s;
            return d.innerHTML;
        },
        escapeAttr: (s) => String(s ?? '')
            .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
            .replace(/</g, '&lt;').replace(/>/g, '&gt;')
    };
    global.App = App;
    global.window.App = App;
    return App;
}

// --- fetch stubbing --------------------------------------------------------

/**
 * Install a fetch stub. `routes` maps "METHOD /suffix" to either a value or a
 * function receiving the parsed request body. Anything unmatched returns {}.
 */
export function stubFetch(routes) {
    const calls = [];
    const impl = async (url, opts) => {
        const method = (opts && opts.method) || 'GET';
        const u = String(url);
        calls.push(`${method} ${u.replace(/^.*\/api/, '/api')}`);

        for (const [key, value] of Object.entries(routes)) {
            const [m, suffix] = key.split(' ');
            if (m !== method || !u.endsWith(suffix)) continue;
            const body = opts && opts.body ? JSON.parse(opts.body) : null;
            const result = typeof value === 'function' ? await value(body, u) : value;
            if (result && result.__error) {
                return { ok: false, status: result.status || 500, text: async () => JSON.stringify({ error: result.__error }) };
            }
            return { ok: true, status: 200, text: async () => JSON.stringify(result ?? {}) };
        }
        return { ok: true, status: 200, text: async () => '{}' };
    };
    global.fetch = impl;
    global.window.fetch = impl;
    return calls;
}

export const httpError = (message = 'backend down', status = 500) => ({ __error: message, status });

export const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));

// weekly.js debounces autosave by 800ms; anything waiting on a save must
// outlast that or it is testing the debounce rather than the save.
export const SAVE_DEBOUNCE_MS = 800;
export const afterAutosave = () => tick(SAVE_DEBOUNCE_MS + 300);
