import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';
import deleteApplication from './admin-delete-application.mjs';

const RATE_STORE = 'nocturne-application-rate-limits';

function emailRateKey(value = '') {
  const email = String(value || '').trim().toLowerCase();
  const hash = createHash('sha256').update(email).digest('hex');
  return email ? `email-${hash}` : '';
}

export default async (req) => {
  let confirmEmail = '';
  try {
    const body = await req.clone().json();
    confirmEmail = String(body?.confirmEmail || '').trim().toLowerCase();
  } catch {}

  const response = await deleteApplication(req);
  if (response.ok && confirmEmail) {
    try {
      const rateStore = getStore({ name: RATE_STORE, consistency: 'strong' });
      await rateStore.delete(emailRateKey(confirmEmail));
    } catch (error) {
      console.error('NOCTURNE deleted-applicant email throttle cleanup failed:', error);
    }
  }
  return response;
};
