import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';

await mkdir('site/assets/vendor', { recursive: true });
await copyFile(
  'node_modules/html5-qrcode/html5-qrcode.min.js',
  'site/assets/vendor/html5-qrcode.min.js'
);

// The approved homepage hero portrait is stored as small base64 source chunks.
// Rebuild the WebP at deploy time before Netlify publishes the site.
const heroParts = [
  'site/assets/data/hero-woman-teal-01.b64',
  'site/assets/data/hero-woman-teal-02.b64',
  'site/assets/data/hero-woman-teal-03.b64',
  'site/assets/data/hero-woman-teal-04.b64',
  'site/assets/data/hero-woman-teal-05a.b64',
  'site/assets/data/hero-woman-teal-05b.b64',
  'site/assets/data/hero-woman-teal-06.b64'
];
const heroBase64 = (await Promise.all(heroParts.map((file) => readFile(file, 'utf8'))))
  .map((part) => part.trim())
  .join('');
if (heroBase64.length !== 90368) {
  throw new Error(`NOCTURNE hero image source length was ${heroBase64.length}; expected 90368.`);
}
const heroImage = Buffer.from(heroBase64, 'base64');
if (heroImage.length !== 67774) {
  throw new Error(`NOCTURNE hero image decoded to ${heroImage.length} bytes; expected 67774.`);
}
await writeFile('site/assets/images/hero-woman-teal.webp', heroImage);

// Swap only the homepage portrait. All copy, logo artwork, layout, effects,
// festival details, and responsive positioning remain unchanged.
const heroCssPath = 'site/assets/css/styles.css';
let heroCss = await readFile(heroCssPath, 'utf8');
const originalHeroUrl = "url('../images/hero-woman.webp')";
const tealHeroUrl = "url('../images/hero-woman-teal.webp')";
if (heroCss.includes(originalHeroUrl)) {
  heroCss = heroCss.replace(originalHeroUrl, tealHeroUrl);
  await writeFile(heroCssPath, heroCss);
} else if (!heroCss.includes(tealHeroUrl)) {
  throw new Error('NOCTURNE homepage hero CSS target was not found.');
}

// Apply the supplied NOCTURNE logo artwork to public pages only. Admin,
// check-in, and private ticket screens keep their existing presentation.
const brandedPages = [
  'site/index.html',
  'site/festival.html',
  'site/privacy.html',
  'site/terms.html',
  'site/conduct.html',
  'site/application-received.html',
  'site/404.html'
];
for (const file of brandedPages) {
  let html = await readFile(file, 'utf8');
  if (!html.includes('/assets/css/brand-refresh.css')) {
    if (!html.includes('</head>')) throw new Error(`Could not add NOCTURNE branding stylesheet to ${file}.`);
    html = html.replace('</head>', '  <link rel="stylesheet" href="/assets/css/brand-refresh.css">\n</head>');
    await writeFile(file, html);
  }
}

const required = [
  'site/index.html',
  'site/festival.html',
  'site/invite.html',
  'site/admin.html',
  'site/admin-launch.html',
  'site/check-in.html',
  'site/bar.html',
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
  'site/assets/css/brand-refresh.css',
  'site/assets/css/admin.css',
  'site/assets/css/admin-invites.css',
  'site/assets/css/admin-tickets.css',
  'site/assets/css/admin-hardening.css',
  'site/assets/css/success.css',
  'site/assets/css/private-access.css',
  'site/assets/css/check-in.css',
  'site/assets/css/bar.css',
  'site/assets/css/admin-drinks.css',
  'site/assets/js/app.js',
  'site/assets/js/invite.js',
  'site/assets/js/admin-auth-router.js',
  'site/assets/js/admin.js',
  'site/assets/js/admin-comp.js',
  'site/assets/js/admin-email.js',
  'site/assets/js/admin-refund.js',
  'site/assets/js/admin-delete.js',
  'site/assets/js/admin-launch.js',
  'site/assets/js/admin-export.js',
  'site/assets/js/admin-pagination.js',
  'site/assets/js/admin-reminder-test.js',
  'site/assets/js/admin-drinks.js',
  'site/assets/js/check-in.js',
  'site/assets/js/bar.js',
  'site/assets/js/ticket-view.js',
  'site/assets/vendor/html5-qrcode.min.js',
  'site/assets/images/favicon.png',
  'site/assets/images/nocturne-logo.webp',
  'site/assets/images/nocturne-logo-hero.png',
  'site/assets/images/nocturne-logo-wordmark.png',
  'site/assets/images/hero-woman.webp',
  'site/assets/images/hero-woman-teal.webp',
  'netlify/functions/apply.mjs',
  'netlify/functions/apply-security.mjs',
  'netlify/functions/redeem-invite.mjs',
  'netlify/functions/invite-view.mjs',
  'netlify/functions/_ticket-auth.mjs',
  'netlify/functions/_ticket-token.mjs',
  'netlify/functions/_audit.mjs',
  'netlify/functions/_ops-alert.mjs',
  'netlify/functions/_reminder-policy.mjs',
  'netlify/functions/_purchase-reminder-email.mjs',
  'netlify/functions/_stripe-signature.mjs',
  'netlify/functions/_drink-package.mjs',
  'netlify/functions/_apple-wallet.mjs',
  'netlify/functions/ticket-access.mjs',
  'netlify/functions/ticket-reentry.mjs',
  'netlify/functions/create-checkout.mjs',
  'netlify/functions/create-drink-package-checkout.mjs',
  'netlify/functions/stripe-webhook.mjs',
  'netlify/functions/ticket-confirmed.mjs',
  'netlify/functions/drink-package-confirmed.mjs',
  'netlify/functions/ticket-view.mjs',
  'netlify/functions/ticket-qr.mjs',
  'netlify/functions/ticket-wallet.mjs',
  'netlify/functions/wallet-assets/icon.png',
  'netlify/functions/wallet-assets/icon@2x.png',
  'netlify/functions/wallet-assets/icon@3x.png',
  'netlify/functions/wallet-assets/logo.png',
  'netlify/functions/wallet-assets/logo@2x.png',
  'netlify/functions/wallet-assets/logo@3x.png',
  'netlify/functions/check-in.mjs',
  'netlify/functions/bar.mjs',
  'netlify/functions/create-invites.mjs',
  'netlify/functions/admin-auth.mjs',
  'netlify/functions/admin-applications.mjs',
  'netlify/functions/admin-launch.mjs',
  'netlify/functions/admin-dashboard.mjs',
  'netlify/functions/admin-comp-ticket.mjs',
  'netlify/functions/admin-approval-email.mjs',
  'netlify/functions/admin-delete-application.mjs',
  'netlify/functions/daily-purchase-reminders.mjs',
  'netlify/functions/daily-data-backup.mjs'
];

for (const file of required) await access(file);
console.log(`NOCTURNE build validation passed (${required.length} required files).`);
