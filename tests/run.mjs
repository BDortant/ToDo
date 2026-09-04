// Runs each suite in its own process. They mutate globals heavily (window,
// document, fetch), so sharing a process would let one suite's teardown leak
// into the next.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const suites = fs.readdirSync(here).filter(f => f.endsWith('.test.mjs')).sort();

let failed = 0;
for (const suite of suites) {
    console.log(`\n${'='.repeat(70)}\n${suite}\n${'='.repeat(70)}`);
    const r = spawnSync(process.execPath, [path.join(here, suite)], { stdio: 'inherit' });
    if (r.status !== 0) failed++;
}

console.log(`\n${'='.repeat(70)}`);
console.log(failed === 0 ? `All ${suites.length} suites passed.` : `${failed} of ${suites.length} suites FAILED.`);
process.exit(failed ? 1 : 0);
