function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

export default async (req) => {
  if (req.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);

  const siteKey = String(process.env.NOCTURNE_TURNSTILE_SITE_KEY || '').trim();
  const secretConfigured = Boolean(String(process.env.NOCTURNE_TURNSTILE_SECRET_KEY || '').trim());
  const enabled = Boolean(siteKey && secretConfigured);

  return json({
    turnstile: {
      enabled,
      siteKey: enabled ? siteKey : null,
      action: 'invite_request'
    }
  });
};
