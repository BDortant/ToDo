# ToDo

A personal to-do app with a vanilla HTML/CSS/JS frontend and a small Node + SQLite backend. It runs locally in Docker on port `8084` and is driven from two places: the browser, and the `todo` CLI (which is how Claude Code reads and writes the list).

It started as a plain task list. It now also drafts the weekly client update per project, which is why parts of it are stricter than a personal tool would normally be: the database holds client contact details and drafted client mail.

## Features

### Task list

- Projects, and todos with status / effort / deadline / assignee / notes / tags
- Drag-to-reorder priority, both overall and per project
- Recurring tasks that spawn their next occurrence on completion
- Snooze until a date, keeping the item's priority slot
- **Daily** view: open items plus everything finished since the last working day
- Per-column sort and filters, a cross-field search, and a hide-done toggle
- JSON import / export, with a 24-hour backup-nag banner

Finished work (`Done`, `Cancelled`) is treated as *off-queue*: priority drops to 0, the row renders `—` instead of a number, it sorts to the bottom, and it stops counting in the sidebar.

### Sidebar counts

Each project shows how much **open** work it holds. When some of that work is parked on someone else, a second outlined badge shows how many:

```text
Alex        5
NHA         5 ⑵     ← 5 open, 2 waiting on the client or a third party
Vitalvé     0
```

"Waiting" means `Waiting on Client` or `Waiting on Third Party` only — `Waiting on Me` and `In Review` are still your move, and `On Hold` is paused rather than waiting on a person. A project where *every* open item is waiting is dimmed, so "nothing here needs me today" is visible without opening it.

### Weekly update

Selecting a project reveals two tabs: **List** and **Weekly update**. The second is a persisted markdown draft of that client's periodic mail, with a split editor, a live Outlook-styled preview, **Copy for Outlook**, per-project mail details, and a week archive.

The draft is built up *during* the week rather than written on send-day. Full detail in **[docs/weekly-update.md](docs/weekly-update.md)**.

## Getting started

```bash
docker compose up -d
```

Then open <http://localhost:8084>.

State lives in the `todo_data` named Docker volume, so it survives restarts and rebuilds. `docker compose down -v` wipes it.

### After a code change

Both the backend and the frontend are baked into the image, so any source change needs a rebuild:

| What changed | What to run |
|---|---|
| Anything under `server/`, or `index.html` / `app.js` / `weekly.js` / `style.css` / `vendor/` | `docker compose up -d --build` |
| Nothing, just restart the container | `docker compose restart` |

### Backups

- **In-app** — **📥 Export** downloads a JSON file; **📤 Import** restores it (replacing everything).
- **Programmatic** — `curl http://localhost:8084/api/export > backup-$(date +%F).json`
- The SQLite file is not reachable from the host; it lives inside the named volume.

The export covers todos, projects, per-project mail details, weekly drafts and the draft archive. `GET /api/state` deliberately covers less (see below).

## CLI

The `todo` CLI is the low-token interface, and the one Claude Code uses. It lives at `~/projects/personal/claude-skills/bin/todo`, symlinked onto `PATH`.

```bash
todo --action=today
todo --action=list --project=Hendrix --hide-done
todo --action=create --title="Bel de leverancier" --project=Hendrix
todo --action=weekly --project=Hendrix
todo --action=weekly-append --project=Hendrix --section=us --text="D5456 gaat deze week naar staging"
```

`todo --action=help` prints every action. The `todo` skill documents the tag conventions.

## API

Bound to `127.0.0.1:8084`. **No authentication** — see [Security posture](#security-posture).

### Todos and projects

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/state` | Snapshot: projects, todos, `lastBackup` |
| `GET` | `/api/health` | Liveness check |
| `POST` | `/api/projects` | Create project |
| `PATCH` | `/api/projects/:id` | Rename project |
| `DELETE` | `/api/projects/:id` | Delete project (its todos become unassigned) |
| `GET` | `/api/projects/resolve?q=...` | Resolve a project by id or fuzzy name |
| `POST` | `/api/todos` | Create todo (accepts a `project` name as well as `projectId`) |
| `GET` | `/api/todos/:id` | Read one todo |
| `PATCH` | `/api/todos/:id` | Partial update (handles `completedDate`, recurring spawn, priority shift) |
| `DELETE` | `/api/todos/:id` | Delete todo |
| `POST` | `/api/todos/:id/priority` | Set integer priority, shifting the others |
| `POST` | `/api/todos/:id/snooze` · `/unsnooze` | Hide until a date, or wake now |
| `POST` | `/api/todos/reorder` | Bulk priority assignment (drag-to-reorder) |
| `POST` | `/api/todos/cleanup` | Remove Done items older than the last working day |
| `POST` | `/api/normalize` | Re-rank open todos to 1..N (recovery only) |

### Weekly update

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/projects/:id/meta` | Mail details: `recipientsTo`, `recipientsCc`, `greeting`, `clientName`, `factsSlug` |
| `PUT` | `/api/projects/:id/meta` | Partial update — only the keys sent are written |
| `GET` | `/api/projects/:id/weekly` | Current draft |
| `PUT` | `/api/projects/:id/weekly` | Replace the draft |
| `POST` | `/api/projects/:id/weekly/append` | Append a bullet under a section (`notable` / `client` / `us`) |
| `POST` | `/api/projects/:id/weekly/archive` | Archive the draft and reseed it |
| `GET` | `/api/projects/:id/weekly/archive` | List archived drafts (no bodies) |
| `GET` | `/api/projects/:id/weekly/archive/:archiveId` | Read one archived draft |
| `DELETE` | `/api/projects/:id/weekly/archive/:archiveId` | Delete one archived draft |

### Backup

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/export` | `/api/state` plus mail details, weekly drafts and the archive |
| `POST` | `/api/import` | Replace **all** state with the uploaded JSON |
| `POST` | `/api/meta/last-backup` | Update the `lastBackup` timestamp |

`clientName` is the name used in the mail subject when it differs from the project name in the app — for instance a project called `GMS` whose client reads as "Customs Support Safety".

## Security posture

Single-user, localhost-only, no login. That is deliberate, but two things follow from it and should not be undone casually:

- **No CORS headers.** The server previously ran `cors()`, which answered every origin with `Access-Control-Allow-Origin: *`. On an unauthenticated API holding client contact details and drafted client mail, that let any page open in the browser read and write the whole list. The frontend is same-origin and the CLI uses curl, so nothing legitimate needed it. If the frontend is ever split onto another origin (the `TODO_API_BASE` override in `app.js`), reintroduce CORS with an explicit allowlist rather than the wildcard.
- **Raw HTML in a draft is escaped, not rendered.** The weekly preview goes through `innerHTML`, so `weekly.js` configures `marked` to escape HTML tokens. Drafts are markdown; the Outlook converter builds its own markup.

Also worth keeping: the container runs as the non-root `node` user, and only the explicitly allowlisted frontend files are served — backend source, the database and `.git` are not reachable over HTTP.

## Tech stack

- **Frontend** — vanilla HTML/CSS/JS, no build step: `index.html`, `app.js` (task list), `weekly.js` (weekly update tab), `style.css`
- **Vendored** — `vendor/marked.min.js`, deliberately not CDN-loaded so the app keeps working offline
- **Backend** — Node 20 + Express + better-sqlite3, in `server/`
- **Storage** — SQLite inside the `todo_data` named volume
- **Transport** — same-origin REST under `/api/*`, served by the same Node process as the frontend

## Architecture

```text
ToDo/
├── index.html          # baked into the Docker image at build time
├── app.js              # task list UI; StorageService talks to /api
├── weekly.js           # weekly update tab: editor, preview, Outlook copy
├── style.css
├── vendor/
│   └── marked.min.js   # vendored so markdown renders offline
├── docs/
│   └── weekly-update.md
├── server/
│   ├── server.js       # Express app — /api routes + an allowlist of frontend files
│   ├── db.js           # SQLite schema and all write logic
│   ├── package.json
│   └── Dockerfile      # build context = repo root; runs as non-root `node`
└── compose.yml         # binds 127.0.0.1:8084, named volume `todo_data`
```

`FRONTEND_FILES` in `server/server.js` is an explicit allowlist rather than `express.static`, because the repo root also holds backend source, the database and `.git`. **Adding a frontend file means adding an entry there**, or it will 404.

## Notes for future changes

- Write logic that must stay consistent across clients (recurring spawn, priority shifting, cleanup cutoff) lives in `server/db.js`. The browser does not recompute any of it.
- The browser polls `GET /api/state` every 10 seconds, paused when the tab is hidden, so changes made through the CLI appear on their own.
- Weekly drafts are **not** in `/api/state`. They have their own endpoints and load only when the tab is opened, which keeps the poll cheap and stops a background refresh from overwriting an open editor.
- `style.css` carries a `[hidden] { display: none !important; }` guard. Several layout rules set `display: flex` on a class, which outranks the browser's own `[hidden]` rule and would otherwise turn `el.hidden = true` into a silent no-op. Do not remove it.

## Always-on-top

The frontend is an ordinary web page, so use an OS tool to pin it:

- **Windows** — [PowerToys](https://learn.microsoft.com/en-us/windows/powertoys/) → "Always On Top" → focus the window → `Win+Ctrl+T`.
- **PWA install** — Chrome/Edge offer "Install app" for <http://localhost:8084>, giving a chromeless window with its own taskbar icon. Combine with the PowerToys trick above.
