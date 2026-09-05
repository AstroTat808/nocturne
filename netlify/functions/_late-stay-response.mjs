import { LATE_STAY_DEPARTURE } from './_late-stay.mjs';

const OLD_DEPARTURE = '8:00 AM';

export function currentLateStayCopy(value = '') {
  return String(value).replaceAll(OLD_DEPARTURE, LATE_STAY_DEPARTURE).replaceAll('8AM', '10AM');
}

export async function rewriteLateStayResponse(response) {
  const type = String(response.headers.get('content-type') || '').toLowerCase();
  if (!type.includes('text/html') && !type.includes('application/json') && !type.includes('text/plain')) return response;
  const body = await response.text();
  const rewritten = currentLateStayCopy(body);
  if (rewritten === body) return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(rewritten, { status: response.status, statusText: response.statusText, headers });
}
