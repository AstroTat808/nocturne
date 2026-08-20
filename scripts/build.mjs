import { access } from 'node:fs/promises';

const required = [
  'site/index.html',
  'site/invite.html',
  'site/admin.html',
  'site/privacy.html',
  'site/terms.html',
  'site/conduct.html',
  'site/application-received.html',
  'site/404.html',
  'site/robots.txt',
  'site/sitemap.xml',
  'site/assets/css/styles.css',
  'site/assets/css/premium.css',
  'site/assets/css/polish.css',
  'site/assets/css/hero-logo.css',
  'site/assets/css/icons.css',
  'site/assets/css/admin.css',
  'site/assets/js/app.js',
  'site/assets/js/invite.js',
  'site/assets/js/admin.js',
  'site/assets/images/favicon.png',
  'site/assets/images/nocturne-logo.webp',
  'site/assets/images/hero-woman.webp',
  'netlify/functions/redeem-invite.mjs',
  'netlify/functions/create-invites.mjs',
  'netlify/functions/admin-dashboard.mjs'
];

for (const file of required) await access(file);
console.log(`NOCTURNE build validation passed (${required.length} required files).`);
