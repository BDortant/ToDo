# ToDo

A lightweight, single-file to-do application built with vanilla HTML, CSS, and JavaScript. All data is stored in the browser using `localStorage` — no backend required.

## Features

- Create and manage to-do items with title, status, effort, deadline, assignee, notes, and tags
- Organize items into projects
- Drag-and-drop reordering (overall and per-project priority)
- Filter by status (To Do, In Progress, Done)
- "By Project" view to see all projects at a glance
- Import/Export data as JSON
- Completed items auto-archive with completion date

## Getting Started

Serve the project directory with any static file server. For example:

```bash
npx serve -l 8083
```

Then open [http://127.0.0.1:8083](http://127.0.0.1:8083) in your browser.

## Tech Stack

- **HTML/CSS/JS** — everything lives in a single `index.html` file
- **localStorage** — data persists in the browser, no database needed
