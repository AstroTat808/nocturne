import createCheckout from './create-checkout.mjs';

function rewriteBody(body) {
  if (!(body instanceof URLSearchParams)) return body;
  const next = new URLSearchParams(body);
  for (const [key, value] of next.entries()) {
    if (String(value).includes('8:00 AM')) next.set(key, String(value).replaceAll('8:00 AM', '10:00 AM'));
  }
  return next;
}

export default async (req) => {
  const priorFetch = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => priorFetch(input, { ...init, body: rewriteBody(init.body) });
  try { return await createCheckout(req); }
  finally { globalThis.fetch = priorFetch; }
};
