import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [api, ui, css, config] = await Promise.all([
  readFile(new URL('../netlify/functions/admin-rehearsal.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../site/assets/js/admin-rehearsal.js', import.meta.url), 'utf8'),
  readFile(new URL('../site/assets/css/admin-rehearsal.css', import.meta.url), 'utf8'),
  readFile(new URL('../netlify.toml', import.meta.url), 'utf8')
]);

assert.match(api, /RESET REHEARSAL/);
assert.match(api, /Digital ticket opens correctly on a real iPhone/);
assert.match(api, /Two bartenders attempting the same last credit cannot double-redeem/);
assert.match(api, /NOCTURNE_BAR_KEY/);
assert.match(ui, /Rehearsal checklist/);
assert.match(ui, /data-rehearsal-state/);
assert.match(css, /admin-rehearsal-progress/);
assert.match(config, /\/api\/admin\/rehearsal/);

console.log('NOCTURNE rehearsal checklist regression tests passed.');
