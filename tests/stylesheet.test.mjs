// Guard for a bug jsdom cannot catch.
//
// `el.hidden = true` is a NO-OP in a real browser when an author rule sets
// `display` on that element via a class: the class selector outranks the UA
// stylesheet's `[hidden] { display: none }`. That is exactly what happened to
// .project-tabs and .filters-bar, both `display: flex` — the tab bar stayed on
// screen while the JS "hid" it, and the jsdom tests passed throughout because
// they asserted the PROPERTY.
//
// jsdom cannot verify the fix either: it applies its own [hidden] rule ABOVE
// author class rules, so a computed-style assertion passes whether or not the
// guard exists (verified by deleting it). So this is a static check on the
// stylesheet, which is honest about what it proves.
import fs from 'node:fs';
import path from 'node:path';
import { REPO, section, check, report } from './helpers.mjs';

const css = fs.readFileSync(path.join(REPO, 'style.css'), 'utf8');
const appJs = fs.readFileSync(path.join(REPO, 'app.js'), 'utf8');

section('the [hidden] guard is present');
check('style.css forces [hidden] to display:none !important',
    /\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/.test(css));

section('and it is load-bearing');
const toggled = [...appJs.matchAll(/([\w.'()\[\]-]+)\.hidden\s*=/g)].map(m => m[1]);
check('app.js hides the project tabs via `hidden`', toggled.some(t => /tabs/i.test(t)), toggled.join(' | '));
check('app.js hides the filter bar via `hidden`', toggled.some(t => /filters-bar/.test(t)), toggled.join(' | '));

const displayRules = [...css.matchAll(/^\.([\w-]+)\s*\{[^}]*display:\s*(flex|grid|block|inline-flex)/gm)].map(m => m[1]);
check('.project-tabs sets a display that would defeat [hidden]', displayRules.includes('project-tabs'));
check('.filters-bar sets a display that would defeat [hidden]', displayRules.includes('filters-bar'));

report();
