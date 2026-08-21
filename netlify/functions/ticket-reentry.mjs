import { getStore } from '@netlify/blobs';
import { accessTtlSeconds, makeAccessCookie, makeAccessToken, verifyReentryToken } from './_ticket-auth.mjs';

const REVIEW_STORE = 'nocturne-application-reviews';

function redirect(location, headers = {}) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: location,
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      ...headers
    }
  });
}

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method not allowed.', { status: 405, headers: { Allow: 'GET' } });

  const url = new URL(req.url);
  const token = url.searchParams.get('token') || '';
  const reentry = verifyReentryToken(token);
  if (!reentry) return redirect('/invite?error=That private access link is invalid or has expired.');

  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const review = await reviewStore.get(reentry.submissionId, { type: 'json', consistency: 'strong' });
  if (!review || review.status !== 'approved' || !['redeemed', 'active'].includes(review.inviteState || '')) {
    return redirect('/invite?error=Private ticket access is no longer available for this invitation.');
  }

  const ttlSeconds = accessTtlSeconds();
  const accessToken = makeAccessToken(reentry.submissionId, ttlSeconds);
  if (!accessToken) return redirect('/invite?error=Private ticket access is not configured.');

  return redirect('/ticket-access', {
    'Set-Cookie': makeAccessCookie(accessToken, ttlSeconds),
    'Referrer-Policy': 'no-referrer'
  });
};
