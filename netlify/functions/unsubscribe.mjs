import { suppressMarketingToken } from './_marketing-preferences.mjs';

function htmlPage(message, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>Email Preferences | NOCTURNE</title></head><body style="margin:0;background:#030303;color:#f7efe3;font-family:Arial,sans-serif"><main style="max-width:620px;margin:0 auto;padding:64px 24px"><section style="border:1px solid rgba(216,154,43,.35);background:#080604;padding:38px 30px"><div style="color:#d89a2b;font-size:11px;letter-spacing:3px;text-transform:uppercase">NOCTURNE · Email Preferences</div><h1 style="font-family:Georgia,serif;font-weight:400;font-size:38px;color:#fff3df">${message}</h1><p style="color:#a99d8b;line-height:1.7">You may still receive essential invitation, ticket, payment, refund, event-access, and support messages connected to your NOCTURNE application or ticket.</p><p><a href="/" style="color:#ffca61">Return to NOCTURNE</a></p></section></main></body></html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive' } });
}

export default async (req) => {
  const url = new URL(req.url);
  const token = String(url.searchParams.get('token') || '').trim();
  if (!token) return htmlPage('That unsubscribe link is invalid.', 400);

  if (req.method === 'GET') {
    const result = await suppressMarketingToken(token, 'visible_link');
    return result
      ? htmlPage('You are unsubscribed from NOCTURNE promotional updates.')
      : htmlPage('That unsubscribe link is invalid or expired.', 400);
  }

  if (req.method === 'POST') {
    const contentType = String(req.headers.get('content-type') || '').toLowerCase();
    let oneClick = false;
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const body = await req.text();
      const params = new URLSearchParams(body);
      oneClick = params.get('List-Unsubscribe') === 'One-Click';
    }
    if (!oneClick) return new Response('Invalid one-click unsubscribe request.', { status: 400 });
    const result = await suppressMarketingToken(token, 'one_click');
    return new Response(result ? 'Unsubscribed.' : 'Invalid unsubscribe token.', { status: result ? 200 : 400, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  }

  return new Response('Method not allowed.', { status: 405, headers: { Allow: 'GET, POST' } });
};
