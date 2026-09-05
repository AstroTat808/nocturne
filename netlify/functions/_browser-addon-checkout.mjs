function redirect(location) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: location,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer'
    }
  });
}

function accepted(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function publicSiteOrigin(req) {
  const configured = String(process.env.NOCTURNE_SITE_URL || '').trim();
  if (configured) {
    try { return new URL(configured).origin; } catch {}
  }
  return new URL(req.url).origin;
}

export function browserAddonFormPost(req) {
  const type = (req.headers.get('content-type') || '').toLowerCase();
  return type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data');
}

export function trustedBrowserSubmission(req) {
  const fetchSite = String(req.headers.get('sec-fetch-site') || '').trim().toLowerCase();
  if (fetchSite) return fetchSite === 'same-origin';

  const origin = String(req.headers.get('origin') || '').trim();
  if (!origin) return true;
  return origin === publicSiteOrigin(req);
}

async function formValues(req) {
  const type = (req.headers.get('content-type') || '').toLowerCase();
  if (type.includes('application/x-www-form-urlencoded')) {
    return new URLSearchParams(await req.text());
  }
  if (type.includes('multipart/form-data')) {
    return req.formData();
  }
  return null;
}

export async function browserAddonCheckout(req, legacyHandler, { formPolicyField, jsonPolicyField, errorPath }) {
  if (!browserAddonFormPost(req)) return legacyHandler(req);

  if (!trustedBrowserSubmission(req)) {
    return redirect(`${errorPath}?error=${encodeURIComponent('Origin not allowed.')}`);
  }

  let values;
  try {
    values = await formValues(req);
  } catch (error) {
    console.error('NOCTURNE add-on browser form parsing failed:', error);
    return redirect(`${errorPath}?error=${encodeURIComponent('Checkout request could not be read. Reload your digital ticket and try again.')}`);
  }

  const token = String(values?.get('token') || '').trim();
  const policyAccepted = accepted(values?.get(formPolicyField));
  const headers = new Headers(req.headers);
  headers.set('content-type', 'application/json');
  headers.set('accept', 'application/json');
  headers.delete('content-length');
  headers.delete('origin');
  headers.delete('sec-fetch-site');
  headers.delete('sec-fetch-mode');
  headers.delete('sec-fetch-dest');
  headers.delete('sec-fetch-user');

  const normalized = new Request(req.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ token, [jsonPolicyField]: policyAccepted })
  });

  const response = await legacyHandler(normalized);
  if (response.status >= 300 && response.status < 400) return response;

  const data = await response.clone().json().catch(() => null);
  if (response.ok && data?.checkoutUrl) return redirect(data.checkoutUrl);
  if (data?.error) return redirect(`${errorPath}?error=${encodeURIComponent(data.error)}`);
  return response;
}
