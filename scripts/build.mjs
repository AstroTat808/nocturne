import { access } from 'node:fs/promises';

const required = [
  'site/index.html',
  'site/invite.html',
  'site/privacy.html',
  'site/terms.html',
  'site/conduct.html',
  'site/assets/css/styles.css',
  'site/assets/js/app.js',
  'netlify/functions/redeem-invite.mjs',
  'netlify/functions/create-invites.mjs'
];

for (const file of required) await access(file);
console.log(`NOCTURNE build validation passed (${required.length} required files).`);
