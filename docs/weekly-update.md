# Weekly update drafts

Each project has a **weekly update draft**: a persisted markdown document that is
built up during the week and ends as the body of the Dutch client mail that goes
out via Outlook.

The point is that the draft is *not* written in one sitting on send-day. Work
that happens on a Tuesday gets written down on that Tuesday, while the detail is
still fresh. The `project-overview` skill's Phase B deliverable scan then runs at
the end of the week as a **double check** against an already-populated draft,
rather than as the thing that produces it from nothing.

## Where it lives in the UI

Selecting a project in the sidebar shows two tabs:

| Tab | Content |
|---|---|
| **List** | The todo table, exactly as before |
| **Weekly update** | Split markdown editor + live preview for that project's draft |

The tabs only appear for a real project. "All items", "By project" and the
pinned "No Project" entry have no weekly update, because the mail is always
per client.

## The editor

Three layouts, toggled in the tab toolbar:

- **Editor** — markdown only, full width
- **Split** — markdown left, live preview right (default)
- **Preview** — rendered output only

The preview is styled to approximate what Outlook will show: Calibri 11pt body,
bordered tables with the ZeroPlex orange header row, and table-based horizontal
rules. It is rendered from the same DOM that the copy buttons read, so what you
see is what gets pasted.

Edits autosave 800 ms after you stop typing. The save state is shown next to the
tabs (`Saving…` / `Saved HH:MM`). Because the draft is a document rather than a
row in the table, it is deliberately **not** part of the 10-second `/api/state`
poll: an open editor is never overwritten by a background refresh.

## Copy buttons

| Button | What lands on the clipboard |
|---|---|
| **Copy for Outlook** | Rich text, produced by selecting the rendered preview and copying it |
| **Copy HTML** | The inline-styled HTML source, for pasting into a tool that wants raw HTML |

Both buttons copy **only the mail body**: everything below the first `---` in the
draft. The `**To:** / **Cc:** / **Subject:**` block above that divider is for your
own reference and is intentionally excluded, matching the layout rule in the
`project-overview` skill.

In Outlook, paste with **Keep Source Formatting**.

The Outlook HTML conversion is a port of the PocketDev `zp-md-panel` tool
(`IaC/pocket-dev/tools/zp-md-panel.json`): table-based `<hr>` and blockquotes,
spacer paragraphs for vertical gaps, headings rewritten as `<p><span>`, and
`border:0` everywhere. Outlook ignores margins on tables and overrides `h2`/`h3`
styling, so those workarounds are load-bearing, not cosmetic.

## How todos feed the draft

A todo is a candidate for the weekly update when it carries the reserved tag
**`weekly`**. Which section it lands in is derived from the status you already
maintain, so tagging is a single decision ("does the client need to hear about
this?") rather than a filing decision.

| Status | Section |
|---|---|
| `Done` (completed within the lookback window) | Noemenswaardige (recente) ontwikkelingen |
| `On Hold` | Noemenswaardige (recente) ontwikkelingen |
| `Waiting on Client`, `Waiting on Third Party` | Benodigde acties vanuit jullie (klant) |
| `To Do`, `In Progress`, `Waiting on Me`, `In Review` | Geplande acties vanuit ons (ZeroPlex) |
| `Cancelled` | not suggested |

`On Hold` maps to "notable developments" rather than "planned actions" on
purpose: the skill's layout rules say an item with no date, owner or concrete
next step must not be presented as a commitment.

### Overriding the section

When the status mapping is wrong for one item, add one of these tags alongside
`weekly`:

| Tag | Effect |
|---|---|
| `wu:notable` | Force into Noemenswaardige ontwikkelingen |
| `wu:client` | Force into Benodigde acties vanuit jullie |
| `wu:us` | Force into Geplande acties vanuit ons |
| `wu:skip` | Never suggest, even though the item is tagged `weekly` |

An override tag implies inclusion, so `wu:client` on its own works without also
adding `weekly`.

### The suggestions strip

Above the editor sits a collapsible **From your todos** strip listing every
candidate for this project, grouped by target section. Each row shows:

- **✓ in draft** — the draft already mentions this item
- **＋ insert** — click to append it as a bullet under the right `##` heading

"Already mentioned" is decided by looking for the item's deliverable id
(`D####`) in the draft when the title has one, and by a normalised title
substring match when it does not. Deliverable-id matching is what makes this
reliable: you will rewrite the wording of a bullet, but you will not rewrite the
id.

This strip is the "am I missing something?" check during the week. It never
changes the draft on its own.

## Week rollover

**Archive & start new week** stores the current draft in the archive and reseeds
the editor with the empty template. The archive is what makes the layout rule
*"cross-reference last week's update"* mechanical instead of a memory exercise:
past drafts stay readable from the **History** dropdown.

Archived drafts are read-only. Reseeding is the only destructive action in the
tab, so it asks for confirmation first.

## Template

New and reseeded drafts start from the full Dutch client-mail template in
`project-overview/phase-c-email-layout.md`: reference header, greeting, the
standard intro paragraphs, the five `##` sections, and Bram's fixed signature.
Only the bullets are left to fill in.

The template is stored in `weekly.js` as `TEMPLATE`. It is duplicated from the
skill rather than imported, because the app has no access to `~/.claude/skills`.
If the skill's layout changes, this constant has to change with it.

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/projects/:id/weekly` | Current draft `{ projectId, markdown, updatedDate }` |
| `PUT` | `/api/projects/:id/weekly` | Replace the draft (`{ markdown }`) |
| `POST` | `/api/projects/:id/weekly/append` | Append a bullet under a section (`{ section, text }`) |
| `POST` | `/api/projects/:id/weekly/archive` | Archive the current draft, optionally reseed (`{ markdown }`) |
| `GET` | `/api/projects/:id/weekly/archive` | List archived drafts (newest first, no bodies) |
| `GET` | `/api/projects/:id/weekly/archive/:archiveId` | One archived draft, body included |

`section` on the append endpoint is one of `notable`, `client`, `us`. The server
inserts the bullet at the end of the matching `##` block, creating the heading if
the draft does not have it.

Drafts are deliberately **not** included in `GET /api/state`. That payload is
already the expensive one, and a 60-item list plus nine mail bodies would make
every 10-second poll significantly heavier for data the table view never reads.

## CLI

The `todo` CLI is how Claude writes to the draft during the week.

```bash
todo --action=weekly --project=Hendrix                 # print the current draft
todo --action=weekly-append --project=Hendrix \
     --section=us --text="D5456 gaat deze week naar staging"
todo --action=weekly-set --project=Hendrix --file=draft.md   # replace wholesale
todo --action=weekly-archive --project=Hendrix         # archive + reseed template
```

`weekly-append` is the one that matters for day-to-day use: it is a single
low-token call that adds one bullet to the right section without reading or
rewriting the whole document.

## Storage

Two tables, both keyed on the project:

```sql
CREATE TABLE project_weekly (
    project_id   TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    markdown     TEXT NOT NULL DEFAULT '',
    updated_date TEXT NOT NULL
);

CREATE TABLE project_weekly_archive (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    markdown      TEXT NOT NULL,
    archived_date TEXT NOT NULL
);
```

Both cascade on project delete, so removing a project removes its drafts and its
history with it. Drafts are included in `GET /api/export` and restored by
`POST /api/import`, so the existing backup flow covers them.
