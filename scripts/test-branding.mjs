import fs from 'node:fs';

function read(path) { return fs.readFileSync(path, 'utf8'); }
function assert(condition, message) { if (!condition) throw new Error(message); }

const wordmark = '/assets/images/nocturne-logo-wordmark.png';
const adminPages = [
  'site/admin.html',
  'site/admin-launch.html',
  'site/admin-operations.html',
  'site/admin-rehearsal.html'
];

for (const path of adminPages) {
  const html = read(path);
  assert(html.includes('class="admin-brand"'), `${path}: missing admin header brand.`);
  assert(html.includes('class="admin-brand-logo"'), `${path}: admin header must use the shared wordmark image class.`);
  assert(html.includes(wordmark), `${path}: admin header/footer must use the supplied NOCTURNE wordmark asset.`);
  assert(html.includes('class="admin-footer"'), `${path}: missing branded admin footer.`);
  assert(html.includes('class="admin-footer-brand"'), `${path}: missing admin footer wordmark lockup.`);
}

const adminCss = read('site/assets/css/admin.css');
assert(adminCss.includes('.admin-brand .admin-brand-logo'), 'Shared admin CSS must size the real wordmark on every sub-admin page.');
assert(adminCss.includes('.admin-footer-brand'), 'Shared admin CSS must define the branded footer lockup.');

const brandingCss = read('site/assets/css/branding.css');
assert(brandingCss.includes(wordmark), 'Public branding layer must use the supplied NOCTURNE wordmark asset.');
assert(brandingCss.includes('.site-header .brand'), 'Public branding layer must standardize site headers.');
assert(brandingCss.includes('.footer-brand-lockup'), 'Public branding layer must standardize rich footers.');
assert(brandingCss.includes('.footer > .footer-bottom:first-child'), 'Public branding layer must brand compact legal footers.');

const premiumCss = read('site/assets/css/premium.css');
assert(premiumCss.includes("@import url('/assets/css/branding.css?v=20260826a');"), 'Premium presentation must load the shared branding layer.');

for (const path of ['site/index.html', 'site/festival.html', 'site/conduct.html', 'site/privacy.html', 'site/terms.html']) {
  const html = read(path);
  assert(html.includes('class="site-header'), `${path}: expected standard public header.`);
  assert(html.includes('class="footer'), `${path}: expected standard public footer.`);
}

console.log('NOCTURNE branding regression checks passed.');
