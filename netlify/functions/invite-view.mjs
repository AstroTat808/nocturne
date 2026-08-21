function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function normalizeCode(value = '') {
  return String(value).trim().toUpperCase().replace(/\s+/g, '');
}

export default async (req) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('Method not allowed.', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }

  const url = new URL(req.url);
  const candidate = normalizeCode(url.searchParams.get('code') || '');
  const code = /^NOC-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(candidate) ? candidate : '';
  const error = String(url.searchParams.get('error') || '').slice(0, 300);
  const codeValue = code ? ` value="${escapeHtml(code)}"` : '';
  const initialMessage = error
    ? escapeHtml(error)
    : code
      ? 'Your invitation code is ready. Verify it below to continue.'
      : '';

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#030303">
  <title>Private Invitation | NOCTURNE Festival</title>
  <meta name="description" content="Redeem a private NOCTURNE Festival invitation.">
  <meta name="robots" content="noindex,nofollow">
  <link rel="icon" href="/assets/images/favicon.png">
  <link rel="stylesheet" href="/assets/css/styles.css">
  <link rel="stylesheet" href="/assets/css/private-access.css">
  <script src="/assets/js/app.js" defer></script>
  <script src="/assets/js/invite.js?v=20260821c" defer></script>
</head>
<body class="private-access-page">
  <main class="private-access-shell">
    <section class="private-access-card" aria-labelledby="invite-title">
      <div class="private-access-logo-wrap">
        <img class="private-access-logo" src="/assets/images/nocturne-logo.webp" alt="NOCTURNE Festival — presented by Wild Ones" width="1536" height="768">
      </div>

      <p class="section-kicker">Private Access</p>
      <h1 id="invite-title">Your night<br>begins here.</h1>
      <p>Enter the invitation code provided with your acceptance. Valid codes unlock the private ticket path and may only be redeemed once.</p>

      <form id="invite-form" class="private-invite-form" method="POST" action="/api/redeem-invite">
        <label class="field">
          <span style="position:absolute;left:-9999px">Invitation code</span>
          <input name="code" required autocomplete="off" inputmode="text" placeholder="NOC-XXXX-XXXX-XXXX" pattern="NOC-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}"${codeValue}>
        </label>
        <button class="btn" type="submit">Verify Invitation →</button>
      </form>

      <div id="invite-result" class="private-invite-result" role="status" aria-live="polite">${initialMessage}</div>
      <a id="ticket-link" class="btn private-ticket-link" href="#" rel="noopener noreferrer">Continue to Private Tickets →</a>

      <p class="private-access-footnote">No invitation yet? <a href="/#apply">Request consideration.</a><br>Having trouble? <a href="mailto:help@nocturnefestival.com?subject=NOCTURNE%20Invite%20Help">help@nocturnefestival.com</a></p>
      <div class="private-access-actions"><a class="btn secondary" href="/">Return to NOCTURNE</a></div>
    </section>
  </main>
</body>
</html>`;

  return new Response(req.method === 'HEAD' ? null : html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      'X-Robots-Tag': 'noindex, nofollow, noarchive'
    }
  });
};
