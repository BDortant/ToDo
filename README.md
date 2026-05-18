# ToDo

A small personal to-do app with a vanilla HTML/CSS/JS frontend and a tiny Node + SQLite backend. Designed to run locally in Docker on port `8084` and be usable from both the browser and an external client (e.g. a PocketDev chat tool).

## Features

- Projects, todos with status / effort / deadline / assignee / notes / tags
- Drag-to-reorder priority (overall and per-project)
- Recurring tasks that auto-spawn the next occurrence on completion
- "Daily" view (open items + Done since last working day)
- Hide-done filter, status/effort/search filters
- JSON import / export with a 24-hour backup-nag banner
- REST API so external tools can read and mutate state

## Getting Started

```bash
docker compose up -d
```

Then open <http://localhost:8084>.

State lives in a Docker named volume (`todo_data`) — survives container restarts/rebuilds. Wipe with `docker compose down -v` if you want to reset.

### Updating after a code change

| What changed | What to run |
|---|---|
| Backend (`server/*`) | `docker compose up -d --build` |
| Frontend (`index.html`, `app.js`, `style.css`) | `docker compose up -d --build` (frontend is baked into the image) |
| Nothing, just restart | `docker compose restart` |

### Backups

- **In-app**: click **📥 Export** to download a JSON file. Click **📤 Import** to restore (replaces all current data).
- **Programmatic**: `curl http://localhost:8084/api/export > backup-$(date +%F).json`
- The SQLite file is not directly accessible from the host — it lives inside the named volume.

### Migrating from the old localStorage version

1. In the old version, click **📥 Export** to download a backup JSON.
2. In the new version, click **📤 Import** and upload that file.

## Tech Stack

- **Frontend** — vanilla HTML/CSS/JS, no build step, single `index.html`/`app.js`/`style.css`
- **Backend** — Node 20 + Express + better-sqlite3, single `server.js`
- **Storage** — SQLite inside the `todo_data` named Docker volume
- **Transport** — same-origin REST under `/api/*`, served by the same Node process as the static frontend
- **Hardening** — container runs as non-root `node` user; only the 3 frontend files (`index.html`, `app.js`, `style.css`) are served — backend source, DB, and `.git` are not exposed

## API

Bound to `127.0.0.1:8084` only — no auth, not exposed beyond localhost.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/state` | Full snapshot (projects, todos, lastBackup) |
| `GET` | `/api/health` | Liveness check |
| `POST` | `/api/projects` | Create project |
| `PATCH` | `/api/projects/:id` | Update project |
| `DELETE` | `/api/projects/:id` | Delete project (todos become unassigned) |
| `POST` | `/api/todos` | Create todo (accepts `project` name as well as `projectId`) |
| `GET` | `/api/todos/:id` | Get single todo |
| `PATCH` | `/api/todos/:id` | Partial update (status flip handles `completedDate`, recurring spawn, priority shift) |
| `DELETE` | `/api/todos/:id` | Delete todo |
| `POST` | `/api/todos/:id/priority` | Set integer priority N, shift others |
| `POST` | `/api/todos/reorder` | Bulk priority assignment (drag-to-reorder) |
| `POST` | `/api/todos/cleanup` | Remove Done items older than last working day |
| `GET` | `/api/projects/resolve?q=...` | Resolve project by id or fuzzy name |
| `GET` | `/api/export` | Same payload as `/api/state` (for download) |
| `POST` | `/api/import` | Replace state with uploaded JSON |
| `POST` | `/api/meta/last-backup` | Update `lastBackup` timestamp |

## Always-on-top

The frontend is a normal web page, so you can use any OS tool to pin it on top of other windows:

- **Windows**: install [PowerToys](https://learn.microsoft.com/en-us/windows/powertoys/) → "Always On Top" → focus the browser window → `Win+Ctrl+T`.
- **PWA install**: Chrome/Edge offer "Install app" for `http://localhost:8084` — gives you a chromeless standalone window with its own taskbar icon. Combine with the PowerToys trick above for a Timekeeper-style overlay.

## Architecture

```text
ToDo/
├── index.html          # baked into the Docker image at build time
├── app.js              # vanilla JS UI; StorageService talks to /api
├── style.css
├── server/
│   ├── server.js       # Express app — /api routes + 3 explicit frontend routes
│   ├── db.js           # SQLite schema + all write logic (recurring, priority shift, cleanup)
│   ├── package.json
│   └── Dockerfile      # build context = repo root, runs as non-root `node` user
└── compose.yml         # binds 127.0.0.1:8084, named volume `todo_data` for SQLite
```

## Project Structure Notes

- All write logic that has to stay consistent across clients (recurring spawn, priority shift on Done, cleanup cutoff) lives in `server/db.js`. The browser no longer recomputes any of it.
- The browser polls `GET /api/state` every 10 seconds (paused when the tab is hidden) so changes made via the API show up automatically.
