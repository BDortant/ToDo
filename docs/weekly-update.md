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

Edits autosave 800 ms after you stop typing. Three guarantees hold around that,
because this draft is written across a whole week and losing part of it costs
real work:

- **Saves are serialised.** `flush()` waits for any PUT already on the wire
  before starting another, and only resolves once the server holds the text as
  it was when it was called. Without that, clicking *Archive & start new week*
  during a save let the older PUT land last and resurrect the pre-archive draft.
- **A failed final save is reported.** Leaving the tab tears the pane down, so a
  failure can no longer be shown in it. `unmount()` waits for the save and
  raises an alert naming the project if it failed. Otherwise the last edit
  disappears with no warning at all.
- **A teardown save is self-contained.** Leaving a project hands its final save
  to `saveOnTeardown()`, which takes everything it needs as arguments and never
  touches `saveState` or the DOM. Routing it through the normal `flush()` let a
  save for the project you just left consume the shared dirty flag, so the
  project you just opened silently ended up with no save request of its own.
- **Archiving refuses to run over an unsaved draft.** The archive endpoint files
  whatever the server holds, so archiving after a failed save would store the
  older text and then wipe the editor to a fresh template. `archiveAndReset()`
  now stops and says why.
- **Mail-detail writes are queued.** Two overlapping PUTs for the same field
  could be processed out of order, leaving the older recipient stored.
- **Stale sessions cannot write.** Every mount and unmount bumps a generation
  token; async work captures it and re-checks after each await. Comparing the
  project id alone was not enough, because leaving a project and returning to
  the *same* one made an abandoned response look current again — which could
  put one client's recipients into another client's draft. The save state is shown next to the
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

### Mail details (per-project prefill)

Above the suggestions sits a **Mail details** panel holding four long-lived
fields per project, so a new week does not start by retyping the same
recipients:

| Field | Used for |
|---|---|
| `To` | the `**To:**` reference line |
| `Cc` | the `**Cc:**` reference line |
| `Greeting` | the `Hoi <name>,` line |
| `Name in subject` | the subject, when the client's mail name differs from the project name |

The subject is built as `{client} - Wekelijkse update {d-m-yyyy}`, for example
`NHA - Wekelijkse update 6-10-2025`. Day and month carry no leading zeros.

The template stamps the date when the week is *started*, which is usually a few
days before you send. **Apply to draft** rebuilds the subject line outright, so
it also refreshes that date to today and upgrades a draft still carrying the
older subject wording. Press it before sending.

These live outside the markdown, so they survive an archive and pre-fill the
next template. Opening a draft that still carries the raw placeholders
(`{vul de ontvanger(s) in}`, `Hoi {voornaam},`) resolves them from the mail
details on the spot, which covers drafts started before their details existed.
That is safe to do unprompted because a placeholder is by definition text
nobody has written yet. Editing them does **not** rewrite the draft you already have,
because silently rewriting text you typed is worse than an extra click:
**Apply to draft** does that explicitly, touching only the To / Cc / Subject
lines and the greeting.

They mirror the `recurring_recipients_to`, `recurring_recipients_cc` and
`email_subject_name` keys the `project-overview` skill keeps in
`project-facts/<slug>.md`. The app cannot read `~/.claude/skills`, so the `todo`
CLI is what copies them across:

```bash
todo --action=project-meta --project=Hendrix
todo --action=project-meta-set --project=Hendrix \
     --to="Jules Seelen <jules@seelen.nl>" --greeting="Jules" --facts-slug=hendrix-fruit
```

`project-meta-set` is a partial update: only the flags you pass are written, so
pushing recipients from the facts file never clobbers a greeting typed in the
UI. Pass an empty value (`--cc=`) to clear a field.

### The suggestions strip

Above the editor sits a collapsible **From your todos** strip listing every
candidate for this project, grouped by target section. Each row shows:

- **＋ insert** — append it as a bullet under the right `##` heading
- **✓ in draft** — already mentioned; clicking takes the bullet back out again
- **✕** — not for the weekly update: strips the `weekly` / `wu:*` tags from the
  todo so it stops being a candidate at all

"Already mentioned" is decided by looking for the item's deliverable id
(`D####`) in the draft when the title has one, and by a normalised title
substring match when it does not. Deliverable-id matching is what makes this
reliable: you will rewrite the wording of a bullet, but you will not rewrite the
id.

Removing a bullet uses the same matching that decided the item was in the draft,
so the ✓ and the removal can never disagree. When an item is mentioned only in
prose rather than as a bullet, removal refuses and says so instead of guessing
at an edit.

The ✕ deliberately leaves any already-inserted bullet alone: dropping an item
off the candidate list is not the same decision as pulling it out of the mail.

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
| `GET` | `/api/projects/:id/meta` | Per-project mail details |
| `PUT` | `/api/projects/:id/meta` | Partial update of the mail details |
| `POST` | `/api/projects/:id/weekly/append` | Append a bullet under a section (`{ section, text }`) |
| `POST` | `/api/projects/:id/weekly/archive` | Archive the current draft, optionally reseed (`{ markdown }`) |
| `GET` | `/api/projects/:id/weekly/archive` | List archived drafts (newest first, no bodies) |
| `GET` | `/api/projects/:id/weekly/archive/:archiveId` | One archived draft, body included |
| `DELETE` | `/api/projects/:id/weekly/archive/:archiveId` | Delete one archived draft |

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
todo --action=project-meta --project=Hendrix           # show the mail details
todo --action=weekly-append --project=Hendrix \
     --section=us --text="D5456 gaat deze week naar staging"
todo --action=weekly-set --project=Hendrix --file=draft.md   # replace wholesale
todo --action=weekly-archive --project=Hendrix         # archive + reseed template
```

`weekly-append` is the one that matters for day-to-day use: it is a single
low-token call that adds one bullet to the right section without reading or
rewriting the whole document.

## A note on hiding elements

The tab bar and the filter bar are shown and hidden with the `hidden`
attribute. Any author rule that sets `display` on those elements via a class
outranks the browser's built-in `[hidden] { display: none }`, which silently
turns `el.hidden = true` into a no-op. That is exactly what happened when both
were given `display: flex`. `style.css` therefore carries a
`[hidden] { display: none !important; }` guard. Do not remove it.

jsdom cannot catch this class of bug: it applies its own `[hidden]` rule above
author class rules, so a computed-style assertion passes whether or not the
guard exists. The guard is covered by a static stylesheet check instead.

## Raw HTML in a draft

`weekly.js` configures `marked` to **escape** HTML tokens rather than render
them, via `configureMarked()`. The preview is written with `innerHTML`, and the
local API has no authentication, so anything able to write a draft could
otherwise get script running in the app's origin.

Escaping is enough here and avoids vendoring a sanitiser: a draft is markdown,
and the Outlook converter builds its own markup, so raw HTML is not a feature
worth supporting. The configuration lives in `weekly.js` rather than
`index.html` so the tests run against the same setup as the page.

## Client-portal access (why the template says what it says)

The template's line about portal access points at **<support@zeroplex.nl>**, not
at a personal address. That follows the actual flow in the Alex codebase:

- Portal accounts (`FrontendUser`) are created either by the **M365 contact
  sync** (for any active contact with an `m365_user_id` in a tenant-linked org,
  the only creation path under Design E) or by hand from the back-office under
  **Organization → Contacts → portal action**.
- The manual route needs the **`manage_portal_access`** permission, which ships
  to the **Admin** role. Bram's Alex role is *SW Developer*, so this has to be
  delegated regardless.
- **No invite or welcome mail is sent** by any of it. Accounts get a random
  32-char password; the client gets in via M365 SSO, or through a password
  reset.
- Auto-provisioned accounts only get the `zp_transfer` module. Access to the
  software projects area (`software_projects`) has to be granted explicitly,
  unless the contact is an ICT Coordinator, who gets every module.

So a client who "wants access" needs someone with the permission to grant it and
to tick the software module. The servicedesk address routes that correctly the
first time.

## Storage

Three tables, all keyed on the project:

```sql
CREATE TABLE project_meta (
    project_id     TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    recipients_to  TEXT NOT NULL DEFAULT '',
    recipients_cc  TEXT NOT NULL DEFAULT '',
    greeting       TEXT NOT NULL DEFAULT '',
    client_name    TEXT NOT NULL DEFAULT '',
    facts_slug     TEXT NOT NULL DEFAULT '',
    updated_date   TEXT NOT NULL
);

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
