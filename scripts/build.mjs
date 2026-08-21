import { access, copyFile, mkdir } from 'node:fs/promises';

await mkdir('site/assets/vendor', { recursive: true });
await copyFile(
  'node_modules/html5-qrcode/html5-qrcode.min.js',
  'site/assets/vendor/html5-qrcode.min.js'
);

const required = [
  'site/index.html',
  'site/invite.html',
  'site/admin.html',
  'site/check-in.html',
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
  'site/assets/css/mobile.css',
  'site/assets/css/icons.css',
  'site/assets/css/admin.css',
  'site/assets/css/admin-invites.css',
  'site/assets/css/admin-tickets.css',
  'site/assets/css/success.css',
  'site/assets/css/private-access.css',
  'site/assets/css/check-in.css',
  'site/assets/js/app.js',
  'site/assets/js/invite.js',
  'site/assets/js/admin.js',
  'site/assets/js/admin-comp.js',
  'site/assets/js/admin-email.js',
  'site/assets/js/admin-refund.js',
  'site/assets/js/check-in.js',
  'site/assets/js/ticket-view.js',
  'site/assets/vendor/html5-qrcode.min.js',
  'site/assets/images/favicon.png',
  'site/assets/images/nocturne-logo.webp',
  'site/assets/images/hero-woman.webp',
  'netlify/functions/apply.mjs',
  'netlify/functions/redeem-invite.mjs',
  'netlify/functions/_ticket-auth.mjs',
  'netlify/functions/_ticket-token.mjs',
  'netlify/functions/ticket-access.mjs',
  'netlify/functions/create-checkout.mjs',
  'netlify/functions/stripe-webhook.mjs',
  'netlify/functions/ticket-confirmed.mjs',
  'netlify/functions/ticket-view.mjs',
  'netlify/functions/ticket-qr.mjs',
  'netlify/functions/check-in.mjs',
  'netlify/functions/create-invites.mjs',
  'netlify/functions/admin-dashboard.mjs',
  'netlify/functions/admin-comp-ticket.mjs',
  'netlify/functions/admin-approval-email.mjs'
];

for (const file of required) await access(file);
console.log(`NOCTURNE build validation passed (${required.length} required files).`);
