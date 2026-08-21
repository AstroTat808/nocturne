import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';

await mkdir('site/assets/vendor', { recursive: true });
await copyFile(
  'node_modules/html5-qrcode/html5-qrcode.min.js',
  'site/assets/vendor/html5-qrcode.min.js'
);

// The GitHub connector used to maintain this site writes text files, so the
// approved homepage hero image is stored as small base64 source chunks. Rebuild
// the WebP at deploy time before Netlify publishes the site.
const heroParts = [
  'site/assets/data/hero-woman-teal-01.b64',
  'site/assets/data/hero-woman-teal-02.b64',
  'site/assets/data/hero-woman-teal-03.b64',
  'site/assets/data/hero-woman-teal-04.b64',
  'site/assets/data/hero-woman-teal-05.b64',
  'site/assets/data/hero-woman-teal-06.b64'
];
const heroBase64 = (await Promise.all(heroParts.map((file) => readFile(file, 'utf8'))))
  .map((part) => part.trim())
  .join('');
const heroImage = Buffer.from(heroBase64, 'base64');
if (heroImage.length < 50000) throw new Error('NOCTURNE hero image reconstruction failed.');
await writeFile('site/assets/images/hero-woman-teal.webp', heroImage);

const required = [
  'site/index.html',
  'site/invite.html',
  'site/admin.html',
  'site/admin-launch.html',
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
  'site/assets/css/event-details.css',
  'site/assets/css/admin.css',
  'site/assets/css/admin-invites.css',
  'site/assets/css/admin-tickets.css',
  'site/assets/css/success.css',
  'site/assets/css/private-access.css',
  'site/assets/css/check-in.css',
  'site/assets/js/app.js',
  'site/assets/js/invite.js',
  'site/assets/js/admin-auth-router.js',
  'site/assets/js/admin.js',
  'site/assets/js/admin-comp.js',
  'site/assets/js/admin-email.js',
  'site/assets/js/admin-refund.js',
  'site/assets/js/admin-launch.js',
  'site/assets/js/check-in.js',
  'site/assets/js/ticket-view.js',
  'site/assets/vendor/html5-qrcode.min.js',
  'site/assets/images/favicon.png',
  'site/assets/images/nocturne-logo.webp',
  'site/assets/images/hero-woman.webp',
  'site/assets/images/hero-woman-teal.webp',
  'netlify/functions/apply.mjs',
  'netlify/functions/redeem-invite.mjs',
  'netlify/functions/invite-view.mjs',
  'netlify/functions/_ticket-auth.mjs',
  'netlify/functions/_ticket-token.mjs',
  'netlify/functions/ticket-access.mjs',
  'netlify/functions/ticket-reentry.mjs',
  'netlify/functions/create-checkout.mjs',
  'netlify/functions/stripe-webhook.mjs',
  'netlify/functions/ticket-confirmed.mjs',
  'netlify/functions/ticket-view.mjs',
  'netlify/functions/ticket-qr.mjs',
  'netlify/functions/check-in.mjs',
  'netlify/functions/create-invites.mjs',
  'netlify/functions/admin-auth.mjs',
  'netlify/functions/admin-applications.mjs',
  'netlify/functions/admin-launch.mjs',
  'netlify/functions/admin-dashboard.mjs',
  'netlify/functions/admin-comp-ticket.mjs',
  'netlify/functions/admin-approval-email.mjs'
];

for (const file of required) await access(file);
console.log(`NOCTURNE build validation passed (${required.length} required files).`);
