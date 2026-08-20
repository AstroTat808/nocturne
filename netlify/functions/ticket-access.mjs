import { createHmac, timingSafeEqual } from 'node:crypto';

const ACCESS_COOKIE = 'nocturne_ticket_access';

function accessSecret() {
  return process.env.NOCTURNE_TICKET_ACCESS_SECRET || process.env.NOCTURNE_ADMIN_SESSION_SECRET || process.env.NOCTURNE_ADMIN_KEY || '';
}

function sign(payload) {
  return createHmac('sha256', accessSecret()).update(payload).digest('base64url');
}

function constantTimeEqual(a = '', b = '') {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function parseCookies(req) {
  const header = req.headers.get('cookie') || '';
  return Object.fromEntries(
    header.split(';').map((part) => {
      const index = part.indexOf('=');
      if (index < 0) return ['', ''];
      return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
    }).filter(([key]) => key)
  );
}

function validAccess(req) {
  if (!accessSecret()) return false;
  const token = parseCookies(req)[ACCESS_COOKIE];
  if (!token || !token.includes('.')) return false;
  const [payload, signature] = token.split('.', 2);
  if (!constantTimeEqual(signature, sign(payload))) return false;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.scope === 'ticket-access' && Number(data.exp) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#030303">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <title>Private Ticket Access | NOCTURNE</title>
  <link rel="icon" href="/assets/images/favicon.png">
  <link rel="stylesheet" href="/assets/css/styles.css">
  <link rel="stylesheet" href="/assets/css/private-access.css">
</head>
<body class="private-access-page">
  <main class="private-access-shell">
    <section class="private-access-card" aria-labelledby="ticket-access-title">
      <div class="private-access-logo-wrap">
        <img class="private-access-logo" src="/assets/images/nocturne-logo.webp" alt="NOCTURNE Festival — presented by Wild Ones" width="1536" height="768">
      </div>
      <p class="section-kicker">Invitation Verified</p>
      <h1 id="ticket-access-title">Your access<br>is confirmed.</h1>
      <p>Your invitation was successfully redeemed. The private ticket checkout is not live yet, so there is nothing else you need to do right now.</p>
      <div class="private-access-status"><strong>Private ticket access is being prepared.</strong><br>Approved guests will receive the next instructions when checkout opens.</div>
      <p>Keep an eye on the email and mobile number used in your application. Event details and ticket instructions will be released privately.</p>
      <div class="private-access-actions"><a class="btn" href="/">Return to NOCTURNE</a><a class="btn secondary" href="https://instagram.com/nocturnehawaii" target="_blank" rel="noopener noreferrer">Follow @nocturnehawaii</a></div>
    </section>
  </main>
</body>
</html>`;

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method not allowed.', { status: 405 });

  if (!validAccess(req)) {
    return new Response(`<!doctype html><html><head><meta name="robots" content="noindex"><meta http-equiv="refresh" content="2;url=/invite"><title>Private Access | NOCTURNE</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#030303;color:#d6c4a7;font:16px Arial,sans-serif;text-align:center}</style></head><body><p>Private access requires a valid redeemed invitation.<br>Returning to invitation verification…</p></body></html>`, {
      status: 401,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow, noarchive'
      }
    });
  }

  return new Response(page, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow, noarchive'
    }
  });
};
