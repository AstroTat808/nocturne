import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [api, ui, css, page, adminDrinks, config] = await Promise.all([
  readFile(new URL('../netlify/functions/admin-rehearsal.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../site/assets/js/admin-rehearsal.js', import.meta.url), 'utf8'),
  readFile(new URL('../site/assets/css/admin-rehearsal.css', import.meta.url), 'utf8'),
  readFile(new URL('../site/admin-rehearsal.html', import.meta.url), 'utf8'),
  readFile(new URL('../site/assets/js/admin-drinks.js', import.meta.url), 'utf8'),
  readFile(new URL('../netlify.toml', import.meta.url), 'utf8')
]);

assert.match(api, /RESET REHEARSAL/);
assert.match(api, /Digital ticket opens correctly on a real iPhone/);
assert.match(api, /Two bartenders attempting the same last credit cannot double-redeem/);
assert.match(api, /NOCTURNE_BAR_KEY/);
assert.match(ui, /Rehearsal checklist/);
assert.match(ui, /data-rehearsal-state/);
assert.doesNotMatch(ui, /nav\.after\(section\)/);
assert.match(css, /admin-rehearsal-progress/);
assert.match(css, /rehearsal-shell/);
assert.match(page, /id="admin-rehearsal"/);
assert.match(page, /Production rehearsal/);
assert.match(page, /admin-rehearsal\.js/);
assert.match(adminDrinks, /\/admin-rehearsal\.html/);
assert.doesNotMatch(adminDrinks, /loadRehearsalChecklist/);
assert.match(config, /\/api\/admin\/rehearsal/);

console.log('NOCTURNE standalone rehearsal checklist regression tests passed.');
