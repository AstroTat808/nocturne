import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';
import deleteApplication from './admin-delete-application.mjs';

const APPLICATION_STORE = 'nocturne-applications';
const RATE_STORE = 'nocturne-application-rate-limits';

function emailRateKey(value = '') {
  const email = String(value || '').trim().toLowerCase();
  const hash = createHash('sha256').update(email).digest('hex');
  return email ? `email-${hash}` : '';
}

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
  let confirmEmail = '';
  let submissionId = '';
  try {
    const body = await req.clone().json();
    confirmEmail = String(body?.confirmEmail || '').trim().toLowerCase();
    submissionId = String(body?.submissionId || '').trim();
  } catch {}

  const response = await deleteApplication(req);
  if (!response.ok) return response;

  if (confirmEmail) {
    try {
      const rateStore = getStore({ name: RATE_STORE, consistency: 'strong' });
      const key = emailRateKey(confirmEmail);
      if (key) await rateStore.delete(key);
    } catch (error) {
      console.error('NOCTURNE deleted-applicant email throttle cleanup failed:', error);
      return json({ error: 'Applicant was deleted, but the email submission lock could not be cleared. Refresh Admin and try again.' }, 500);
    }
  }

  if (submissionId) {
    try {
      const applicationStore = getStore({ name: APPLICATION_STORE, consistency: 'strong' });
      const remaining = await applicationStore.get(submissionId, { type: 'json', consistency: 'strong' }).catch(() => null);
      if (remaining) {
        console.error('NOCTURNE applicant deletion verification failed:', submissionId);
        return json({ error: 'Deletion verification failed: the applicant record still exists. Admin will not report this record as deleted.' }, 500);
      }
    } catch (error) {
      console.error('NOCTURNE applicant deletion verification could not complete:', error);
      return json({ error: 'Deletion could not be verified. Refresh Admin before attempting to reapply with this contact information.' }, 500);
    }
  }

  return response;
};
