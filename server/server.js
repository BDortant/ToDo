// =============================================================
// Express app — serves the static frontend AND the /api/* routes
// for the ToDo application. Designed to run inside Docker on
// 127.0.0.1:PORT (default 8084). No auth — localhost only.
// =============================================================
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import {
    initDb,
    getState,
    createProject, patchProject, deleteProject,
    createTodo, patchTodo, deleteTodo, getTodo,
    reorderTodos, setTodoPriority, cleanupOldDone,
    replaceState, setLastBackup,
    normalizePriorities,
    resolveProject,
    HttpError
} from './db.js';

const PORT = Number(process.env.PORT || 8084);
const DATA_DIR = process.env.DATA_DIR || path.resolve('./data');
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.resolve('..');

initDb(DATA_DIR);

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// --- API ---------------------------------------------------------

app.get('/api/state', (_req, res) => {
    res.json(getState());
});

app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
});

// Projects
app.post('/api/projects', wrap((req) => createProject(req.body || {})));
app.patch('/api/projects/:id', wrap((req) => patchProject(req.params.id, req.body || {})));
app.delete('/api/projects/:id', wrap((req) => deleteProject(req.params.id)));

// Todos
app.post('/api/todos', wrap((req) => {
    const body = req.body || {};
    // Allow project resolution by name (handy for chat tool)
    if (body.project && !body.projectId) {
        const p = resolveProject(body.project);
        if (!p) throw new HttpError(400, `Unknown project: ${body.project}`);
        body.projectId = p.id;
        delete body.project;
    }
    return createTodo(body);
}));

app.patch('/api/todos/:id', wrap((req) => {
    const body = req.body || {};
    if (body.project && body.projectId === undefined) {
        const p = resolveProject(body.project);
        if (!p) throw new HttpError(400, `Unknown project: ${body.project}`);
        body.projectId = p.id;
        delete body.project;
    }
    return patchTodo(req.params.id, body);
}));

app.delete('/api/todos/:id', wrap((req) => deleteTodo(req.params.id)));
app.get('/api/todos/:id', wrap((req) => {
    const t = getTodo(req.params.id);
    if (!t) throw new HttpError(404, 'Todo not found');
    return t;
}));

app.post('/api/todos/reorder', wrap((req) => reorderTodos(req.body)));
app.post('/api/todos/cleanup', wrap(() => cleanupOldDone()));

// Admin: re-rank all open todos to 1..N. Idempotent. Normally not needed
// (every mutation calls it internally), but exposed for one-off recovery
// after legacy data imports.
app.post('/api/normalize', wrap(() => normalizePriorities()));

// Friendly single-todo priority setter (chat tool uses this)
app.post('/api/todos/:id/priority', wrap((req) => {
    const p = req.body?.priority;
    if (p === undefined) throw new HttpError(400, 'priority is required');
    return setTodoPriority(req.params.id, p);
}));

// Project resolver (chat tool sugar)
app.get('/api/projects/resolve', wrap((req) => {
    const p = resolveProject(req.query.q);
    if (!p) throw new HttpError(404, 'No matching project');
    return p;
}));

// Import / export
app.get('/api/export', (_req, res) => {
    res.json(getState());
});

app.post('/api/import', wrap((req) => replaceState(req.body)));

app.post('/api/meta/last-backup', wrap((req) => {
    const iso = req.body?.iso || new Date().toISOString();
    setLastBackup(iso);
    return { lastBackup: iso };
}));

// --- Error handler ---------------------------------------------

app.use((err, _req, res, _next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message || 'Internal error' });
});

// --- Static frontend -------------------------------------------
//
// Explicit allowlist of frontend files. We intentionally do NOT
// use express.static on the repo root because the repo also
// contains backend source, SQLite data, and the .git dir — any
// of which would be a privacy / source-leak if served. Adding a
// new frontend file? Add an entry to FRONTEND_FILES below.

const FRONTEND_FILES = {
    '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
    '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
    '/app.js': { file: 'app.js', type: 'application/javascript; charset=utf-8' },
    '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' }
};

for (const [route, { file, type }] of Object.entries(FRONTEND_FILES)) {
    app.get(route, (_req, res) => {
        const full = path.join(PUBLIC_DIR, file);
        fs.readFile(full, (err, buf) => {
            if (err) return res.status(404).type('text/plain').send('Not found');
            res.type(type).send(buf);
        });
    });
}

// --- Boot -------------------------------------------------------

app.listen(PORT, () => {
    console.log(`[todo] api+frontend listening on http://0.0.0.0:${PORT}`);
    console.log(`[todo] data dir: ${DATA_DIR}`);
    console.log(`[todo] public dir: ${PUBLIC_DIR}`);
});

// --- Helper ----------------------------------------------------

function wrap(handler) {
    return async (req, res, next) => {
        try {
            const result = await handler(req);
            res.json(result);
        } catch (e) {
            next(e);
        }
    };
}
