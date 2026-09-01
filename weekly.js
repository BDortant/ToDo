// =============================================================
// Weekly update tab — one persisted markdown draft per project,
// built up during the week and copied into Outlook on send-day.
//
// See docs/weekly-update.md for the why. The short version: the
// draft accumulates as the work happens, and the project-overview
// skill's deliverable scan runs at the end of the week as a check
// against it rather than as the thing that writes it.
//
// The markdown -> Outlook HTML conversion below is a port of the
// PocketDev `zp-md-panel` tool. Its odd choices (table-based <hr>,
// spacer <p> elements, headings rewritten as <p><span>) are all
// Outlook workarounds — see the notes on applyStyles().
// =============================================================
const Weekly = (() => {

    const ACCENT = '#F7921E';        // ZeroPlex orange, same as zp-md-panel
    const SAVE_DEBOUNCE_MS = 800;
    const DONE_LOOKBACK_DAYS = 14;   // matches the project-overview lookback

    // --- State ---

    let projectId = null;            // project currently mounted, null = unmounted
    let projectName = '';
    let markdown = '';
    let layout = 'split';            // 'editor' | 'split' | 'preview'
    let suggestionsOpen = true;
    let saveTimer = null;
    let inFlight = null;             // Promise of the PUT currently on the wire, or null
    let teardownSave = null;         // Final save of a session already torn down, or null
    let saveState = 'idle';          // 'idle' | 'dirty' | 'saving' | 'saved' | 'error'
    let savedAt = null;
    let archive = [];
    // Bumped on every mount and unmount. Async work captures it and re-checks
    // after each await, so a slow response from an abandoned session can never
    // write into the session that replaced it. Comparing projectId is not
    // enough: leaving a project and returning to the SAME one makes a stale
    // response look current again.
    let mountToken = 0;
    let meta = { recipientsTo: '', recipientsCc: '', greeting: '', clientName: '' };
    let metaOpen = false;
    let loadError = null;

    // --- Section model -------------------------------------------
    //
    // Mirrors WEEKLY_SECTIONS in server/db.js. Both exist because the
    // editor inserts into unsaved text (client-side) while the CLI
    // appends to the stored document (server-side).

    const SECTIONS = [
        { key: 'notable', label: 'Noemenswaardige ontwikkelingen', test: /^##\s+Noemenswaardige/i, heading: '## Noemenswaardige (recente) ontwikkelingen' },
        { key: 'client', label: 'Benodigde acties vanuit jullie', test: /^##\s+Benodigde acties/i, heading: '## Benodigde acties vanuit jullie (klant)' },
        { key: 'us', label: 'Geplande acties vanuit ons', test: /^##\s+Geplande acties/i, heading: '## Geplande acties vanuit ons (ZeroPlex)' }
    ];

    // Status -> section. 'On Hold' deliberately lands in "notable" and not
    // in "planned actions": the layout rules say an item with no date, owner
    // or concrete next step must not read as a commitment we made.
    const STATUS_SECTION = {
        'Done': 'notable',
        'On Hold': 'notable',
        'Waiting on Client': 'client',
        'Waiting on Third Party': 'client',
        'To Do': 'us',
        'In Progress': 'us',
        'Waiting on Me': 'us',
        'In Review': 'us'
        // 'Cancelled' intentionally absent — never suggested.
    };

    function isoWeek(date) {
        // ISO-8601 week number. Thursday of the current week decides the year,
        // which is why the day is shifted before dividing.
        const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
        d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
        const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
        return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
    }

    // The full Dutch client-mail template from the project-overview skill
    // (phase-c-email-layout.md). Duplicated rather than imported: the app
    // cannot read ~/.claude/skills. If the skill's layout changes, change
    // this with it.
    // Pre-filled from the project's stored mail details where they exist, so
    // a new week starts with the recipients and greeting already right. Any
    // field left blank falls back to a visible placeholder.
    function buildTemplate(name) {
        const week = isoWeek(new Date());
        const to = meta.recipientsTo || '{vul de ontvanger(s) in}';
        const cc = meta.recipientsCc || '{vul in of verwijder}';
        const subjectName = meta.clientName || name;
        const greeting = meta.greeting || '{voornaam}';
        return `**To:** ${to}
**Cc:** ${cc}
**Subject:** ZeroPlex - periodieke update ${subjectName} - week ${week}

---

Hoi ${greeting},


Hierbij onze periodieke update, mochten er vragen zijn dan reageer gerust!

Als je een Teams call wilt inplannen dan kan dit uiteraard ook. Stuur ons een aantal mogelijke tijdvensters, dan proberen wij hieruit een keuze te maken.

Bij situaties die urgentie verlangen, bel ons op 077 - 206 63 04 i.p.v. een e-mail of ander bericht te versturen.


## Belangrijkste zaken

Dit segment bevat alleen de belangrijkste zaken die we extra onder aandacht willen brengen voor de komende periode.

Voor een volledig overzicht bekijk a.u.b. het 'Overzicht Actieve Deliverables' onderin deze e-mail of login op ons klantenportaal voor software (Alex).

Heeft u nog geen toegang tot ons klantenportaal maar wilt u dit wel, stuur dan een e-mail naar support@zeroplex.nl, dan zetten wij het account voor u klaar.


## Noemenswaardige (recente) ontwikkelingen


## Benodigde acties vanuit jullie (klant)


## Geplande acties vanuit ons (ZeroPlex)


## Overzicht Actieve Deliverables

In dit overzicht staan alle momenteel actieve deliverables, voor meer informatie, login op ons klantenportaal of neem contact op!

| Sequence | Project | Deliv. # | Deliverable | Deliv. status | Hours worked billable | Expected hours billable | External Remark |
|---|---|---|---|---|---|---|---|


Met vriendelijke groet,



Bram Dortant


Business Consultant
ZeroPlex B.V.

077 - 206 63 04
bram.dortant@zeroplex.nl

Huiskensstraat 72, Venlo
zeroplex.nl

Voor algemene vragen is onze servicedesk bereikbaar via support@zeroplex.nl of telefonisch via 077 - 206 63 03
`;
    }

    // --- API -----------------------------------------------------

    async function call(method, path, body) {
        const opts = { method, headers: { Accept: 'application/json' } };
        if (body !== undefined) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        const res = await fetch(path, opts);
        const text = await res.text();
        let payload = null;
        if (text) {
            try { payload = JSON.parse(text); } catch { /* non-JSON error body */ }
        }
        if (!res.ok) throw new Error((payload && payload.error) || `HTTP ${res.status}`);
        return payload;
    }

    const api = {
        get: (pid) => call('GET', `/api/projects/${encodeURIComponent(pid)}/weekly`),
        getMeta: (pid) => call('GET', `/api/projects/${encodeURIComponent(pid)}/meta`),
        putMeta: (pid, patch) => call('PUT', `/api/projects/${encodeURIComponent(pid)}/meta`, patch),
        put: (pid, md) => call('PUT', `/api/projects/${encodeURIComponent(pid)}/weekly`, { markdown: md }),
        archive: (pid, md) => call('POST', `/api/projects/${encodeURIComponent(pid)}/weekly/archive`, { markdown: md }),
        listArchive: (pid) => call('GET', `/api/projects/${encodeURIComponent(pid)}/weekly/archive`),
        getArchive: (pid, aid) => call('GET', `/api/projects/${encodeURIComponent(pid)}/weekly/archive/${encodeURIComponent(aid)}`),
        deleteArchive: (pid, aid) => call('DELETE', `/api/projects/${encodeURIComponent(pid)}/weekly/archive/${encodeURIComponent(aid)}`)
    };

    // --- Markdown -> HTML ----------------------------------------

    // The draft's `**To:** / **Cc:** / **Subject:**` block sits above the first
    // `---` and is Bram's own reference, not part of the mail. Everything the
    // preview renders and the copy buttons produce comes from below it.
    function splitDraft(md) {
        const lines = (md || '').split('\n');
        const idx = lines.findIndex(l => /^---\s*$/.test(l));
        if (idx === -1) return { header: '', body: md || '' };
        return {
            header: lines.slice(0, idx).join('\n'),
            body: lines.slice(idx + 1).join('\n')
        };
    }

    // Port of zp-md-panel's applyStyles. `outlook` selects the clipboard-HTML
    // variant, which omits the display:* and padding declarations that Outlook
    // either ignores or renders badly; the preview variant keeps them so the
    // on-screen table looks like a table.
    function applyStyles(container, outlook) {
        const hc = ACCENT;
        const baseFont = 'font-family:Calibri,Arial,sans-serif;font-size:11pt;';
        const tableFont = 'font-family:Calibri,Arial,sans-serif;font-size:10pt;';
        const fontFamily = 'font-family:Calibri,Arial,sans-serif;';

        // Outlook collapses margins on tables, so vertical space has to be a
        // real element with a line-height.
        const mkSpacer = (px) => {
            const s = document.createElement('p');
            s.setAttribute('data-spacer', '1');
            s.setAttribute('style', `margin:0;padding:0;line-height:${px}px;font-size:1px;border:0;`);
            s.innerHTML = '&nbsp;';
            return s;
        };

        container.querySelectorAll('table').forEach(el => {
            const disp = outlook ? '' : 'display:table;';
            el.setAttribute('style', disp + 'border-collapse:collapse;max-width:100%;margin:0;' + tableFont);
            el.setAttribute('cellpadding', '3');
            el.setAttribute('cellspacing', '0');
            el.parentNode.insertBefore(mkSpacer(3), el);
            if (el.nextSibling) {
                el.parentNode.insertBefore(mkSpacer(3), el.nextSibling);
            } else {
                el.parentNode.appendChild(mkSpacer(3));
            }
        });
        if (!outlook) {
            container.querySelectorAll('thead').forEach(el => el.setAttribute('style', 'display:table-header-group;'));
            container.querySelectorAll('tbody').forEach(el => el.setAttribute('style', 'display:table-row-group;'));
        }
        container.querySelectorAll('tr').forEach(el => {
            const isInTbody = el.parentNode && el.parentNode.tagName === 'TBODY';
            const isEven = isInTbody && (Array.prototype.indexOf.call(el.parentNode.children, el) % 2 === 1);
            const bg = isEven ? 'background-color:#f8f8f8;' : '';
            if (outlook) {
                if (bg) el.setAttribute('style', bg);
            } else {
                el.setAttribute('style', 'display:table-row;' + bg);
            }
        });
        container.querySelectorAll('th').forEach(el => {
            const align = el.getAttribute('align') || 'left';
            if (outlook) {
                el.setAttribute('style', `background-color:${hc};text-align:${align};border:1px solid #bbb;font-weight:bold;font-size:10pt;${fontFamily}`);
            } else {
                el.setAttribute('style', `display:table-cell;background-color:${hc};padding:4px 8px;text-align:${align};border:1px solid #bbb;font-weight:bold;font-size:10pt;${fontFamily}line-height:14px;`);
            }
        });
        container.querySelectorAll('td').forEach(el => {
            const align = el.getAttribute('align') || 'left';
            if (outlook) {
                el.setAttribute('style', `text-align:${align};border:1px solid #ddd;font-size:10pt;${fontFamily}`);
            } else {
                el.setAttribute('style', `display:table-cell;padding:3px 6px;text-align:${align};border:1px solid #ddd;word-break:break-word;overflow:hidden;font-size:10pt;${fontFamily}line-height:14px;`);
            }
        });
        // A row carrying <strong> is treated as a subtotal/emphasis row.
        container.querySelectorAll('tbody tr').forEach(el => {
            if (!el.querySelector('strong')) return;
            const existing = el.getAttribute('style') || '';
            el.setAttribute('style', existing.replace(/background-color:[^;]*;?/g, '') + 'background-color:#f0f0f0;');
            el.querySelectorAll('td').forEach(td => {
                td.setAttribute('style', (td.getAttribute('style') || '') + 'border-top:1px solid #bbb;');
            });
        });
        // Outlook ignores `border` on non-table elements, so an <hr> has to
        // become a one-cell table with a bottom border.
        container.querySelectorAll('hr').forEach(el => {
            const tbl = document.createElement('table');
            tbl.setAttribute('width', '100%');
            tbl.setAttribute('cellpadding', '0');
            tbl.setAttribute('cellspacing', '0');
            tbl.setAttribute('border', '0');
            tbl.setAttribute('style', 'border-collapse:collapse;border:0;margin:0;');
            const tr = document.createElement('tr');
            tr.setAttribute('style', 'border:0;');
            const td = document.createElement('td');
            td.setAttribute('style', 'border:0;border-bottom:1px solid #cccccc;font-size:1px;line-height:1px;height:1px;padding:0;');
            td.innerHTML = '&nbsp;';
            tr.appendChild(td);
            tbl.appendChild(tr);
            el.parentNode.insertBefore(mkSpacer(4), el);
            el.parentNode.insertBefore(tbl, el);
            el.parentNode.insertBefore(mkSpacer(4), el);
            el.parentNode.removeChild(el);
        });
        // Same reason as <hr>: the quote bar is a table cell, not a border.
        container.querySelectorAll('blockquote').forEach(el => {
            const tbl = document.createElement('table');
            tbl.setAttribute('cellpadding', '0');
            tbl.setAttribute('cellspacing', '0');
            tbl.setAttribute('border', '0');
            tbl.setAttribute('style', 'border-collapse:collapse;border:0;margin:0;');
            const tr = document.createElement('tr');
            tr.setAttribute('style', 'border:0;');
            const barTd = document.createElement('td');
            barTd.setAttribute('style', 'width:3px;background-color:#ccc;border:0;font-size:1px;');
            barTd.innerHTML = '&nbsp;';
            const contentTd = document.createElement('td');
            contentTd.setAttribute('style', 'padding:4px 12px;color:#555;font-style:italic;border:0;' + baseFont);
            contentTd.innerHTML = el.innerHTML;
            contentTd.querySelectorAll('p').forEach(p => {
                p.setAttribute('style', baseFont + 'margin:2px 0;line-height:1.4;color:#555;font-style:italic;border:0;');
            });
            tr.appendChild(barTd);
            tr.appendChild(contentTd);
            tbl.appendChild(tr);
            el.parentNode.insertBefore(mkSpacer(3), el);
            el.parentNode.insertBefore(tbl, el);
            el.parentNode.insertBefore(mkSpacer(3), el);
            el.parentNode.removeChild(el);
        });
        container.querySelectorAll('pre').forEach(el => {
            const codeFont = 'font-family:Consolas,Monaco,Courier New,monospace;font-size:9pt;';
            const tbl = document.createElement('table');
            tbl.setAttribute('width', '100%');
            tbl.setAttribute('cellpadding', '0');
            tbl.setAttribute('cellspacing', '0');
            tbl.setAttribute('border', '0');
            tbl.setAttribute('style', 'border-collapse:collapse;border:0;margin:0;');
            const tr = document.createElement('tr');
            tr.setAttribute('style', 'border:0;');
            const td = document.createElement('td');
            td.setAttribute('style', 'background-color:#f5f5f5;border:1px solid #e0e0e0;padding:8px 12px;border-radius:3px;' + codeFont + 'line-height:1.45;color:#333;white-space:pre;overflow-x:auto;');
            const codeEl = el.querySelector('code');
            td.textContent = codeEl ? codeEl.textContent : el.textContent;
            tr.appendChild(td);
            tbl.appendChild(tr);
            el.parentNode.insertBefore(mkSpacer(3), el);
            el.parentNode.insertBefore(tbl, el);
            el.parentNode.insertBefore(mkSpacer(3), el);
            el.parentNode.removeChild(el);
        });
        container.querySelectorAll('code').forEach(el => {
            if (el.parentNode && el.parentNode.tagName === 'PRE') return;
            el.setAttribute('style', 'font-family:Consolas,Monaco,Courier New,monospace;font-size:9pt;background-color:#f0f0f0;padding:1px 4px;border:0;border-radius:2px;color:#c7254e;');
        });
        // Outlook collapses the margin between adjacent blocks, so a blank
        // spacer paragraph is inserted between them to keep the gaps visible.
        const blockTags = { P: 1, H1: 1, H2: 1, H3: 1, H4: 1, UL: 1, OL: 1 };
        const topChildren = Array.from(container.children);
        for (let i = topChildren.length - 1; i > 0; i--) {
            const curr = topChildren[i];
            const prev = topChildren[i - 1];
            if ((curr.getAttribute && curr.getAttribute('data-spacer')) ||
                (prev.getAttribute && prev.getAttribute('data-spacer'))) continue;
            if (blockTags[curr.tagName] && blockTags[prev.tagName]) {
                const gap = document.createElement('p');
                gap.setAttribute('data-spacer', '1');
                gap.setAttribute('style', 'margin:0;padding:0;line-height:10pt;font-size:1pt;border:0;');
                gap.innerHTML = '&nbsp;';
                container.insertBefore(gap, curr);
            }
        }
        container.querySelectorAll('p').forEach(el => {
            if (el.getAttribute('data-spacer')) return;
            if (el.closest && el.closest('blockquote')) return;
            el.setAttribute('style', baseFont + 'margin:6px 0;line-height:16px;border:0;');
        });
        container.querySelectorAll('ul').forEach(el => el.setAttribute('style', baseFont + 'margin:6px 0;padding-left:24px;border:0;'));
        container.querySelectorAll('ol').forEach(el => el.setAttribute('style', baseFont + 'margin:6px 0;padding-left:24px;border:0;'));
        container.querySelectorAll('li').forEach(el => el.setAttribute('style', baseFont + 'margin:2px 0;line-height:16px;border:0;'));
        container.querySelectorAll('strong').forEach(el => el.setAttribute('style', 'font-weight:bold;border:0;'));
        container.querySelectorAll('em').forEach(el => el.setAttribute('style', 'font-style:italic;border:0;'));
        container.querySelectorAll('a').forEach(el => el.setAttribute('style', 'color:#0563C1;text-decoration:underline;border:0;'));

        // Outlook overrides its own h2/h3/h4 styling, so headings are rebuilt
        // as a styled <span> inside a plain <p>.
        const replaceHeading = (el, size, lineH, mTop, mBot) => {
            const p = document.createElement('p');
            p.setAttribute('style', `margin:${mTop} 0 ${mBot};line-height:${lineH};border:0;`);
            const span = document.createElement('span');
            span.setAttribute('style', `${fontFamily}font-size:${size};color:#1a1a1a;font-weight:bold;border:0;`);
            span.innerHTML = el.innerHTML;
            p.appendChild(span);
            el.parentNode.replaceChild(p, el);
        };
        container.querySelectorAll('h1').forEach(el => replaceHeading(el, '16pt', '22pt', '20px', '6px'));
        container.querySelectorAll('h2').forEach(el => replaceHeading(el, '13pt', '18pt', '16px', '4px'));
        container.querySelectorAll('h3').forEach(el => replaceHeading(el, '11pt', '15pt', '14px', '4px'));
        container.querySelectorAll('h4').forEach(el => replaceHeading(el, '10pt', '14pt', '12px', '4px'));
    }

    // Markdown setup lives here rather than in index.html so the tests
    // exercise the same configuration the page runs with.
    //
    // Raw HTML is escaped rather than rendered. A draft is never meant to
    // contain HTML: the body is markdown and the Outlook converter builds its
    // own markup. Since the local API is unauthenticated, anything that can
    // write a draft could otherwise get script into the preview, which is
    // rendered with innerHTML. Escaping is enough here and avoids pulling in a
    // sanitiser library for a case we don't want to support anyway.
    function configureMarked() {
        if (!window.marked) return;
        marked.setOptions({ breaks: true });
        marked.use({
            renderer: {
                html: (token) => {
                    const raw = typeof token === 'string' ? token : (token && token.raw) || '';
                    return String(raw).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                }
            }
        });
    }

    function toHtml(bodyMarkdown, outlook) {
        if (!window.marked || !bodyMarkdown.trim()) return '';
        const div = document.createElement('div');
        div.innerHTML = marked.parse(bodyMarkdown);
        applyStyles(div, outlook);
        return div.innerHTML;
    }

    // --- Suggestions ---------------------------------------------

    // Which section a todo belongs in, or null when it isn't a candidate.
    // An explicit wu:* override implies inclusion, so it is checked before
    // the `weekly` tag requirement.
    function sectionFor(todo) {
        const tags = (todo.tags || []).map(t => String(t).toLowerCase());
        if (tags.includes('wu:skip')) return null;
        if (tags.includes('wu:notable')) return 'notable';
        if (tags.includes('wu:client')) return 'client';
        if (tags.includes('wu:us')) return 'us';
        if (!tags.includes('weekly')) return null;

        if (todo.status === 'Done') {
            // Only recent completions are news. An item done a month ago was
            // already reported in an earlier week's mail.
            if (!todo.completedDate) return null;
            const age = (Date.now() - new Date(todo.completedDate).getTime()) / 86400000;
            if (age > DONE_LOOKBACK_DAYS) return null;
        }
        return STATUS_SECTION[todo.status] || null;
    }

    // Is this item already written down somewhere in the draft? Deliverable
    // ids are the reliable signal: you will rewrite a bullet's wording, but
    // you will not rewrite the D-number. Titles without one fall back to a
    // normalised substring match.
    function isMentioned(draft, todo) {
        const idMatch = String(todo.title).match(/\bD\d{3,6}\b/i);
        if (idMatch) return new RegExp(`\\b${idMatch[0]}\\b`, 'i').test(draft);
        const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const needle = norm(todo.title);
        return needle.length > 0 && norm(draft).includes(needle);
    }

    function suggestions() {
        const todos = App.getTodos().filter(t => t.projectId === projectId);
        return SECTIONS.map(sec => ({
            ...sec,
            items: todos
                .filter(t => sectionFor(t) === sec.key)
                .map(t => ({ id: t.id, title: t.title, status: t.status, mentioned: isMentioned(markdown, t) }))
        }));
    }

    // Client-side twin of appendWeeklyBullet() in server/db.js.
    function insertBullet(sectionKey, text) {
        const spec = SECTIONS.find(s => s.key === sectionKey);
        if (!spec) return;
        const bullet = `- ${text}`;
        const lines = markdown.split('\n');
        const headingIdx = lines.findIndex(l => spec.test.test(l));

        if (headingIdx === -1) {
            const sigIdx = lines.findIndex(l => /^Met vriendelijke groet,/i.test(l));
            const block = ['', spec.heading, '', bullet, ''];
            if (sigIdx === -1) lines.push(...block);
            else lines.splice(sigIdx, 0, ...block);
        } else {
            let end = headingIdx + 1;
            while (end < lines.length && !/^##\s/.test(lines[end])) end++;
            let insertAt = end;
            while (insertAt > headingIdx + 1 && lines[insertAt - 1].trim() === '') insertAt--;
            // First bullet in an empty section keeps the blank line under the heading.
            if (insertAt === headingIdx + 1) lines.splice(insertAt, 0, '', bullet);
            else lines.splice(insertAt, 0, bullet);
        }

        markdown = lines.join('\n');
        const ta = document.getElementById('weekly-editor');
        if (ta) ta.value = markdown;
        scheduleSave();
        renderPreview();
        renderSuggestions();
    }

    // Take a todo's bullet back out of the draft. Matches the same way
    // isMentioned() decides a todo is in there, so what the ✓ claims and what
    // this removes can never drift apart.
    function removeBullet(todo) {
        const idMatch = String(todo.title).match(/\bD\d{3,6}\b/i);
        const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const needle = norm(todo.title);

        const matches = (line) => {
            if (!/^\s*[-*]\s+/.test(line)) return false;          // bullets only
            if (idMatch) return new RegExp(`\\b${idMatch[0]}\\b`, 'i').test(line);
            return needle.length > 0 && norm(line).includes(needle);
        };

        const kept = markdown.split('\n').filter(l => !matches(l));
        const removed = markdown.split('\n').length - kept.length;
        if (removed === 0) {
            // Mentioned, but not as a bullet — it was written into prose, so
            // there is no safe automatic edit. Say so instead of guessing.
            flashToolbar('Mentioned in prose, not as a bullet — remove it by hand');
            return;
        }
        markdown = kept.join('\n');
        const ta = document.getElementById('weekly-editor');
        if (ta) ta.value = markdown;
        scheduleSave();
        renderPreview();
        renderSuggestions();
        flashToolbar(removed === 1 ? 'Bullet removed' : `${removed} bullets removed`);
    }

    // --- Saving ---------------------------------------------------

    function scheduleSave() {
        saveState = 'dirty';
        renderStatus();
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(flush, SAVE_DEBOUNCE_MS);
    }

    // Save for the CURRENTLY MOUNTED session. Resolves only once the server
    // holds the text as of the call, and reports whether that succeeded, so
    // `archiveAndReset` can refuse to archive over edits that never landed.
    //
    // Teardown saves do NOT come through here — see saveOnTeardown(). Mixing
    // the two would let a save for the project you just left write into the
    // shared editor state of the project you just opened.
    async function flush() {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }

        // A previous session's final save, or a PUT already on the wire, has
        // to land first: otherwise two PUTs race and the slower one wins.
        if (teardownSave) await teardownSave;
        if (inFlight) await inFlight;
        if (!projectId || saveState !== 'dirty') return saveState !== 'error';

        const pid = projectId;
        const body = markdown;
        saveState = 'saving';
        renderStatus();

        const request = (async () => {
            try {
                await api.put(pid, body);
                // Any keystroke since would have set 'dirty' again, so a
                // still-'saving' state means this text is what's stored.
                if (saveState === 'saving') {
                    saveState = 'saved';
                    savedAt = new Date();
                }
            } catch (e) {
                saveState = 'error';
                console.error('Weekly draft save failed:', e);
            } finally {
                inFlight = null;
            }
        })();

        inFlight = request;
        await request;
        renderStatus();
        return saveState !== 'error';
    }

    // Final save for a session being torn down. Deliberately self-contained:
    // it takes everything it needs as arguments and never touches saveState,
    // savedAt or the DOM, because by the time it settles all of those belong
    // to whichever project was opened next. A failure is reported with the
    // name of the project it actually belonged to.
    function saveOnTeardown(pid, name, body, pending) {
        const done = (async () => {
            try {
                if (pending) await pending;
                await api.put(pid, body);
            } catch (e) {
                console.error('Weekly draft teardown save failed:', e);
                alert(
                    `The weekly update draft for ${name} could not be saved.\n\n` +
                    `Your last edits were not stored. Check that the backend is running, ` +
                    `then reopen that project's Weekly update tab and retype them.`
                );
            } finally {
                if (teardownSave === done) teardownSave = null;
            }
        })();
        teardownSave = done;
        return done;
    }

    // --- Rendering -------------------------------------------------

    function statusText() {
        switch (saveState) {
            case 'dirty': return 'Unsaved…';
            case 'saving': return 'Saving…';
            case 'error': return 'Save failed — check the backend';
            case 'saved': return savedAt ? `Saved ${savedAt.toTimeString().slice(0, 5)}` : 'Saved';
            default: return '';
        }
    }

    function renderStatus() {
        const el = document.getElementById('weekly-save-state');
        if (!el) return;
        el.textContent = statusText();
        el.className = `weekly-save-state ${saveState}`;
    }

    function renderPreview() {
        const el = document.getElementById('weekly-preview');
        if (!el) return;
        const { body } = splitDraft(markdown);
        const html = toHtml(body, false);
        el.innerHTML = html || '<p class="weekly-preview-empty">Nothing to preview yet.</p>';
    }

    function renderSuggestions() {
        const el = document.getElementById('weekly-suggestions');
        if (!el) return;
        const groups = suggestions();
        const total = groups.reduce((n, g) => n + g.items.length, 0);
        const missing = groups.reduce((n, g) => n + g.items.filter(i => !i.mentioned).length, 0);

        const head = `
            <button type="button" class="weekly-suggest-toggle" onclick="Weekly.toggleSuggestions()">
                <span class="caret">${suggestionsOpen ? '▾' : '▸'}</span>
                From your todos
                <span class="weekly-suggest-count ${missing ? 'warn' : 'ok'}">
                    ${total === 0 ? 'none tagged' : `${missing} of ${total} not in draft`}
                </span>
            </button>`;

        if (!suggestionsOpen) { el.innerHTML = head; return; }

        if (total === 0) {
            el.innerHTML = head + `
                <div class="weekly-suggest-body">
                    <p class="weekly-suggest-empty">
                        No todos in this project are tagged <code>weekly</code>.
                        Tag an item <code>weekly</code> and it shows up here, filed by its status.
                    </p>
                </div>`;
            return;
        }

        const body = groups.map(g => {
            if (!g.items.length) return '';
            const rows = g.items.map(i => `
                <li class="${i.mentioned ? 'mentioned' : ''}">
                    ${i.mentioned
                        ? `<button type="button" class="weekly-suggest-add remove" data-id="${App.escapeAttr(i.id)}"
                                   title="In the draft. Click to take the bullet back out."
                                   onclick="Weekly.removeSuggestion(this.dataset.id)">✓</button>`
                        : `<button type="button" class="weekly-suggest-add" title="Insert as a bullet under this section"
                                   data-section="${g.key}" data-id="${App.escapeAttr(i.id)}"
                                   onclick="Weekly.insertSuggestion(this.dataset.section, this.dataset.id)">＋</button>`}
                    <span class="weekly-suggest-title">${App.escapeHTML(i.title)}</span>
                    <span class="weekly-suggest-status">${App.escapeHTML(i.status)}</span>
                    <button type="button" class="weekly-suggest-untag" data-id="${App.escapeAttr(i.id)}"
                            title="Not for the weekly update: removes the weekly / wu:* tags from this todo"
                            onclick="Weekly.untagSuggestion(this.dataset.id)">✕</button>
                </li>`).join('');
            return `<div class="weekly-suggest-group">
                <h4>${App.escapeHTML(g.label)}</h4>
                <ul>${rows}</ul>
            </div>`;
        }).join('');

        el.innerHTML = head + `<div class="weekly-suggest-body">${body}</div>`;
    }

    // Mail details live outside the markdown so they survive an archive and
    // can pre-fill next week's template. Editing them does not rewrite the
    // current draft on its own — "Apply to draft" does that explicitly,
    // because silently rewriting text you typed would be worse.
    function renderMeta() {
        const el = document.getElementById('weekly-meta');
        if (!el) return;
        const filled = [meta.recipientsTo, meta.greeting].filter(Boolean).length;
        const head = `
            <button type="button" class="weekly-suggest-toggle" onclick="Weekly.toggleMeta()">
                <span class="caret">${metaOpen ? '▾' : '▸'}</span>
                Mail details
                <span class="weekly-suggest-count ${filled === 2 ? 'ok' : 'warn'}">
                    ${meta.recipientsTo ? App.escapeHTML(meta.recipientsTo.split(',')[0].trim()) + (meta.recipientsTo.includes(',') ? ' +' : '') : 'no recipients set'}
                </span>
            </button>`;
        if (!metaOpen) { el.innerHTML = head; return; }
        const field = (key, label, placeholder) => `
            <label class="weekly-meta-field">
                <span>${label}</span>
                <input type="text" data-meta="${key}" value="${App.escapeAttr(meta[key] || '')}"
                       placeholder="${App.escapeAttr(placeholder)}"
                       onchange="Weekly.onMetaChange(this.dataset.meta, this.value)">
            </label>`;
        el.innerHTML = head + `
            <div class="weekly-meta-body">
                ${field('recipientsTo', 'To', 'Jules Seelen <jules@seelen.nl>')}
                ${field('recipientsCc', 'Cc', 'Jasper Bauer <jasper@zeroplex.nl>')}
                ${field('greeting', 'Greeting', 'Jules')}
                ${field('clientName', 'Name in subject', 'leave empty to use the project name')}
                <div class="weekly-meta-actions">
                    <button type="button" class="btn btn-outline btn-small" onclick="Weekly.applyMeta()">
                        Apply to draft
                    </button>
                    <span class="weekly-meta-hint">Rewrites the To / Cc / Subject lines and the greeting in the draft above.</span>
                </div>
            </div>`;
    }

    // Mail-detail writes are chained rather than fired in parallel. Two
    // overlapping PUTs for the same field can otherwise be processed in the
    // wrong order, leaving the older value stored — a silently wrong recipient
    // on a client mail. A queue makes the last edit the last write, always.
    let metaQueue = Promise.resolve();

    async function onMetaChange(key, value) {
        const token = mountToken;
        const pid = projectId;
        meta = { ...meta, [key]: value };

        metaQueue = metaQueue.then(async () => {
            try {
                const saved = await api.putMeta(pid, { [key]: value });
                // Applying this to a project the user has since switched to
                // would show one client's recipients under another's draft.
                if (token !== mountToken) return;
                meta = saved;
            } catch (e) {
                if (token !== mountToken) return;
                flashToolbar('Could not save mail details: ' + (e.message || e));
            }
        });

        await metaQueue;
        if (token === mountToken) renderMeta();
    }

    function toggleMeta() {
        metaOpen = !metaOpen;
        renderMeta();
    }

    // Fill only the literal placeholder tokens from the stored mail details.
    // Safe to run unprompted on every open: a placeholder is by definition
    // text nobody has written yet, so nothing you typed can be lost. Covers
    // drafts that were started before their mail details existed.
    function fillPlaceholders() {
        let out = markdown;
        // Function replacements, so a `$&` or `$1` inside a stored value is
        // inserted literally instead of being read as a replacement pattern.
        if (meta.recipientsTo) out = out.replace('**To:** {vul de ontvanger(s) in}', () => `**To:** ${meta.recipientsTo}`);
        if (meta.recipientsCc) out = out.replace('**Cc:** {vul in of verwijder}', () => `**Cc:** ${meta.recipientsCc}`);
        if (meta.greeting) out = out.replace('Hoi {voornaam},', () => `Hoi ${meta.greeting},`);
        if (out === markdown) return false;
        markdown = out;
        return true;
    }

    // Rewrite the header lines and the greeting of the CURRENT draft from the
    // stored mail details. Only those four lines are touched.
    function applyMeta() {
        const lines = markdown.split('\n');
        const dividerIdx = lines.findIndex(l => /^---\s*$/.test(l));
        const limit = dividerIdx === -1 ? lines.length : dividerIdx;

        const setHeader = (label, value) => {
            const re = new RegExp(`^\\*\\*${label}:\\*\\*`);
            const idx = lines.findIndex((l, i) => i < limit && re.test(l));
            if (idx !== -1) lines[idx] = `**${label}:** ${value}`;
        };
        if (meta.recipientsTo) setHeader('To', meta.recipientsTo);
        if (meta.recipientsCc) setHeader('Cc', meta.recipientsCc);

        const subjIdx = lines.findIndex((l, i) => i < limit && /^\*\*Subject:\*\*/.test(l));
        if (subjIdx !== -1) {
            const name = meta.clientName || projectName;
            // Function replacement: a `$` in the client name would otherwise be
            // read as a replacement pattern and mangle the subject line.
            lines[subjIdx] = lines[subjIdx].replace(
                /^(\*\*Subject:\*\* ZeroPlex - periodieke update ).*( - week \d+)$/,
                (_match, prefix, suffix) => `${prefix}${name}${suffix}`
            );
        }
        if (meta.greeting) {
            const greetIdx = lines.findIndex(l => /^Hoi\s+.*,\s*$/.test(l));
            if (greetIdx !== -1) lines[greetIdx] = `Hoi ${meta.greeting},`;
        }

        markdown = lines.join('\n');
        const ta = document.getElementById('weekly-editor');
        if (ta) ta.value = markdown;
        scheduleSave();
        renderPreview();
        flashToolbar('Mail details applied');
    }

    function renderArchiveSelect() {
        const el = document.getElementById('weekly-archive-select');
        if (!el) return;
        if (!archive.length) {
            el.innerHTML = '<option value="">History (empty)</option>';
            el.disabled = true;
            return;
        }
        el.disabled = false;
        el.innerHTML = '<option value="">History…</option>' + archive.map(a => {
            const d = new Date(a.archivedDate);
            const label = `${d.toISOString().slice(0, 10)} (week ${isoWeek(d)})`;
            return `<option value="${App.escapeAttr(a.id)}">${App.escapeHTML(label)}</option>`;
        }).join('');
    }

    function shell() {
        return `
            <div class="weekly-pane" data-layout="${layout}">
                <div class="weekly-toolbar">
                    <div class="weekly-layout-toggle" role="group" aria-label="Editor layout">
                        ${['editor', 'split', 'preview'].map(l => `
                            <button type="button" class="${layout === l ? 'active' : ''}"
                                    onclick="Weekly.setLayout('${l}')">${l[0].toUpperCase() + l.slice(1)}</button>`).join('')}
                    </div>
                    <span class="weekly-save-state ${saveState}" id="weekly-save-state">${statusText()}</span>
                    <span class="weekly-toolbar-spacer"></span>
                    <button class="btn btn-primary btn-small" onclick="Weekly.copyForOutlook()"
                            title="Copies the mail body as rich text. Paste into Outlook with Keep Source Formatting.">📋 Copy for Outlook</button>
                    <button class="btn btn-outline btn-small" onclick="Weekly.copyHtml()"
                            title="Copies the inline-styled HTML source">&lt;/&gt; Copy HTML</button>
                    <select class="weekly-archive-select" id="weekly-archive-select"
                            onchange="Weekly.openArchive(this.value); this.value=''"
                            title="Read a previous week's update"></select>
                    <button class="btn btn-outline btn-small" onclick="Weekly.archiveAndReset()"
                            title="Store this draft in the history and start the next week from the empty template">🗄️ Archive &amp; start new week</button>
                </div>

                <div class="weekly-suggestions" id="weekly-meta"></div>

                <div class="weekly-suggestions" id="weekly-suggestions"></div>

                <div class="weekly-split">
                    <div class="weekly-editor-wrap">
                        <textarea id="weekly-editor" class="weekly-editor" spellcheck="false"
                                  oninput="Weekly.onInput(this.value)"
                                  onblur="Weekly.flush()"></textarea>
                    </div>
                    <div class="weekly-preview-wrap">
                        <div class="weekly-preview-note">Preview of the mail body (everything below the <code>---</code> divider)</div>
                        <div id="weekly-preview" class="weekly-preview"></div>
                    </div>
                </div>

                <p class="weekly-hint">
                    Paste into Outlook with <strong>Keep Source Formatting</strong>.
                    The <code>To / Cc / Subject</code> block above the divider is your own reference and is not copied.
                </p>
            </div>`;
    }

    function renderAll() {
        const ta = document.getElementById('weekly-editor');
        if (ta && ta.value !== markdown) ta.value = markdown;
        renderPreview();
        renderSuggestions();
        renderArchiveSelect();
        renderMeta();
        renderStatus();
    }

    // --- Public API ------------------------------------------------

    // Rendered by App into #main-content. Mount is a two-step: paint the
    // shell synchronously so the tab feels instant, then fill it once the
    // draft arrives.
    async function mount(pid, name, container) {
        // Switching away from a project with pending edits must not lose them.
        if (projectId && projectId !== pid) await flush();

        const token = ++mountToken;
        projectId = pid;
        projectName = name;
        loadError = null;
        container.innerHTML = shell();

        try {
            const [draft, list, m] = await Promise.all([api.get(pid), api.listArchive(pid), api.getMeta(pid)]);
            if (token !== mountToken) return;   // this session was replaced mid-load
            meta = m || { recipientsTo: '', recipientsCc: '', greeting: '', clientName: '' };
            // First open of a project seeds the template and saves it, so the
            // CLI's weekly-append has real sections to append into from day one.
            const isFirstOpen = !draft.markdown;
            markdown = isFirstOpen ? buildTemplate(name) : draft.markdown;
            archive = list || [];
            saveState = 'idle';
            savedAt = draft.updatedDate ? new Date(draft.updatedDate) : null;
            // An existing draft may predate its mail details, or have been
            // seeded before they were filled in. Placeholders still standing
            // get resolved now rather than waiting for a manual Apply.
            const filled = !isFirstOpen && fillPlaceholders();
            renderAll();
            if (isFirstOpen || filled) scheduleSave();
            if (filled) flashToolbar('Mail details filled in');
        } catch (e) {
            if (token !== mountToken) return;
            loadError = e;
            container.innerHTML = `<div class="load-error">
                <h2>Could not load the weekly update draft</h2>
                <p>${App.escapeHTML(String(e.message || e))}</p>
            </div>`;
        }
    }

    function unmount() {
        // Everything the final save needs is captured here, while it is still
        // this project's. The editor is then released straight away — app.js
        // calls unmount() synchronously from render(), so it cannot wait.
        const pid = projectId;
        const name = projectName;
        const body = markdown;
        const unsaved = saveState === 'dirty' || saveState === 'saving';
        const pending = inFlight;

        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        mountToken++;          // invalidate any load still in flight
        projectId = null;
        inFlight = null;

        if (pid && unsaved) saveOnTeardown(pid, name, body, pending);
    }

    function isMounted(pid) {
        return projectId !== null && projectId === pid && !loadError;
    }

    function onInput(value) {
        markdown = value;
        scheduleSave();
        renderPreview();
        renderSuggestions();
    }

    function setLayout(l) {
        layout = l;
        const pane = document.querySelector('.weekly-pane');
        if (pane) pane.dataset.layout = l;
        document.querySelectorAll('.weekly-layout-toggle button').forEach(b => {
            b.classList.toggle('active', b.textContent.trim().toLowerCase() === l);
        });
    }

    function toggleSuggestions() {
        suggestionsOpen = !suggestionsOpen;
        renderSuggestions();
    }

    function insertSuggestion(section, todoId) {
        const todo = App.getTodos().find(t => t.id === todoId);
        if (!todo) return;
        insertBullet(section, todo.title);
    }

    function removeSuggestion(todoId) {
        const todo = App.getTodos().find(t => t.id === todoId);
        if (!todo) return;
        removeBullet(todo);
    }

    // Drop the weekly / wu:* tags so the todo stops being a candidate at all.
    // The bullet, if one was already inserted, is left alone — dropping it
    // from the list is not the same decision as pulling it out of the mail.
    async function untagSuggestion(todoId) {
        const todo = App.getTodos().find(t => t.id === todoId);
        if (!todo) return;
        const kept = (todo.tags || []).filter(t => {
            const lower = String(t).toLowerCase();
            return lower !== 'weekly' && !lower.startsWith('wu:');
        });
        try {
            await App.setTodoTags(todoId, kept);
            renderSuggestions();
            flashToolbar('Removed from the weekly list');
        } catch (e) {
            flashToolbar('Could not update tags: ' + (e.message || e));
        }
    }

    // Copies the rendered preview by selecting it — same approach as
    // zp-md-panel's default button, which keeps the most formatting fidelity
    // because the browser serialises what is actually on screen.
    function copyForOutlook() {
        const el = document.getElementById('weekly-preview');
        if (!el || !el.textContent.trim()) return;
        const wasPreviewHidden = layout === 'editor';
        if (wasPreviewHidden) setLayout('split');   // execCommand needs it visible

        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        const ok = document.execCommand('copy');
        sel.removeAllRanges();

        if (wasPreviewHidden) setLayout('editor');
        flashToolbar(ok ? 'Copied for Outlook' : 'Copy failed');
    }

    async function copyHtml() {
        const { body } = splitDraft(markdown);
        const html = toHtml(body, true);
        if (!html) return;
        try {
            await navigator.clipboard.writeText(html);
            flashToolbar('HTML source copied');
        } catch (e) {
            flashToolbar('Copy failed: ' + (e.message || e));
        }
    }

    function flashToolbar(msg) {
        const el = document.getElementById('weekly-save-state');
        if (!el) return;
        el.textContent = msg;
        el.className = 'weekly-save-state saved';
        setTimeout(renderStatus, 2500);
    }

    async function archiveAndReset() {
        if (!projectId) return;
        const ok = confirm(
            `Archive the current ${projectName} update and start the next week from the empty template?\n\n` +
            `The current draft stays readable under History.`
        );
        if (!ok) return;

        // The archive endpoint stores whatever the SERVER currently holds. If
        // the pending save never landed, archiving would file the older text
        // and then wipe the editor to a fresh template, losing the edits for
        // good. Stop instead.
        const saved = await flush();
        if (!saved) {
            alert(
                `Your latest edits to the ${projectName} draft have not been saved yet, ` +
                `so archiving now would file the previous version and lose them.\n\n` +
                `Check that the backend is running, wait for "Saved", then archive again.`
            );
            return;
        }

        try {
            const fresh = buildTemplate(projectName);
            const res = await api.archive(projectId, fresh);
            markdown = res.draft.markdown;
            archive = await api.listArchive(projectId);
            saveState = 'saved';
            savedAt = new Date();
            renderAll();
        } catch (e) {
            alert(`Could not archive the draft: ${e.message || e}`);
        }
    }

    async function openArchive(archiveId) {
        if (!archiveId || !projectId) return;
        try {
            const entry = await api.getArchive(projectId, archiveId);
            const modal = document.getElementById('weekly-archive-modal');
            const d = new Date(entry.archivedDate);
            document.getElementById('weekly-archive-title').textContent =
                `${projectName} — archived ${d.toISOString().slice(0, 10)} (week ${isoWeek(d)})`;
            const preview = document.getElementById('weekly-archive-preview');
            preview.innerHTML = toHtml(splitDraft(entry.markdown).body, false);
            document.getElementById('weekly-archive-source').value = entry.markdown;
            document.getElementById('weekly-archive-delete').dataset.id = entry.id;
            modal.classList.add('open');
        } catch (e) {
            alert(`Could not open the archived draft: ${e.message || e}`);
        }
    }

    function closeArchive() {
        document.getElementById('weekly-archive-modal').classList.remove('open');
    }

    // The way back out of an archive-by-accident.
    async function deleteArchive(el) {
        const aid = el.dataset.id;
        if (!aid || !projectId) return;
        if (!confirm('Permanently delete this archived update? The live draft is not affected.')) return;
        try {
            await api.deleteArchive(projectId, aid);
            archive = await api.listArchive(projectId);
            renderArchiveSelect();
            closeArchive();
        } catch (e) {
            alert(`Could not delete the archived draft: ${e.message || e}`);
        }
    }

    // True while the user is mid-edit, so App's 10s poll knows not to
    // re-render #main-content out from under the textarea.
    function isBusy() {
        if (teardownSave) return true;
        if (!projectId) return false;
        if (saveState === 'dirty' || saveState === 'saving') return true;
        const ae = document.activeElement;
        return !!(ae && ae.id === 'weekly-editor');
    }

    configureMarked();

    return {
        mount, unmount, isMounted, isBusy, flush,
        onInput, setLayout, toggleSuggestions,
        insertSuggestion, removeSuggestion, untagSuggestion,
        toggleMeta, onMetaChange, applyMeta,
        copyForOutlook, copyHtml, archiveAndReset, openArchive, closeArchive, deleteArchive,
        refresh: renderSuggestions
    };
})();
