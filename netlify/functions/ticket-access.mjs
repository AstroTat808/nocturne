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
  <style>
    body{min-height:100svh;background:radial-gradient(circle at 50% 8%,rgba(216,154,43,.13),transparent 28rem),#020202}.ticket-pending-shell{min-height:100svh;display:grid;place-items:center;padding:2rem 1rem}.ticket-pending-card{width:min(760px,100%);padding:clamp(2rem,6vw,4.5rem);border:1px solid rgba(216,154,43,.22);background:linear-gradient(145deg,rgba(12,9,6,.92),rgba(3,3,3,.94));text-align:center;box-shadow:0 40px 120px rgba(0,0,0,.45)}.ticket-pending-logo{width:min(620px,100%);height:auto;aspect-ratio:2/1;object-fit:contain;margin:0 auto 1.5rem;mix-blend-mode:screen;filter:drop-shadow(0 0 28px rgba(216,154,43,.12))}.ticket-pending-card h1{font-family:var(--serif);font-weight:500;font-size:clamp(3rem,8vw,5.6rem);line-height:.94;margin:.35rem 0;color:#fff4df}.ticket-pending-card p{max-width:600px;margin:1rem auto;color:#aa9d89}.ticket-pending-status{margin:2rem auto;padding:1.2rem;border:1px solid rgba(255,202,97,.19);background:rgba(216,154,43,.04);color:#d7c4a3}.ticket-pending-actions{display:flex;justify-content:center;gap:.8rem;flex-wrap:wrap;margin-top:1.8rem}
  </style>
</head>
<body>
  <main class="ticket-pending-shell">
    <section class="ticket-pending-card">
      <img class="ticket-pending-logo" src="/assets/images/nocturne-logo.webp" alt="NOCTURNE Festival — presented by Wild Ones" width="1536" height="768">
      <p class="section-kicker">Invitation Verified</p>
      <h1>Your access<br>is confirmed.</h1>
      <p>Your invitation was successfully redeemed. The private ticket checkout is not live yet, so there is nothing else you need to do right now.</p>
      <div class="ticket-pending-status"><strong>Private ticket access is being prepared.</strong><br>Approved guests will receive the next instructions when checkout opens.</div>
      <p>Keep an eye on the email and mobile number used in your application. Event details and ticket instructions will be released privately.</p>
      <div class="ticket-pending-actions"><a class="btn" href="/">Return to NOCTURNE</a><a class="btn secondary" href="https://instagram.com/nocturnehawaii" target="_blank" rel="noopener noreferrer">Follow @nocturnehawaii</a></div>
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
