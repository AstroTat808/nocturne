import { getStore } from '@netlify/blobs';
import { randomUUID } from 'node:crypto';

const APPLICATION_STORE = 'nocturne-applications';
const MAX = {
  full_name: 120,
  preferred_name: 120,
  email: 254,
  phone: 40,
  location: 160,
  instagram: 120,
  referral: 160,
  community: 1500,
  why_nocturne: 2000,
  group_names: 1000
};

function clean(value, max = 5000) {
  return String(value ?? '').trim().slice(0, max);
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

async function readFields(req) {
  const type = (req.headers.get('content-type') || '').toLowerCase();

  if (type.includes('application/json')) {
    const body = await req.json();
    return body && typeof body === 'object' ? body : {};
  }

  if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
    const form = await req.formData();
    return Object.fromEntries(form.entries());
  }

  throw new Error('Unsupported content type.');
}

function validate(fields) {
  const fullName = clean(fields.full_name, MAX.full_name);
  const email = clean(fields.email, MAX.email).toLowerCase();
  const phone = clean(fields.phone, MAX.phone);
  const location = clean(fields.location, MAX.location);
  const referral = clean(fields.referral, MAX.referral);
  const whyNocturne = clean(fields.why_nocturne, MAX.why_nocturne);

  if (!fullName) return 'Full name is required.';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'A valid email address is required.';
  if (!phone) return 'Mobile number is required.';
  if (!location) return 'Location is required.';
  if (!referral) return 'Referral source is required.';
  if (whyNocturne.length < 50) return 'Please tell us a little more about why you want to attend.';
  if (clean(fields.conduct_ack) !== 'yes') return 'The Code of Conduct acknowledgement is required.';
  if (clean(fields.selection_ack) !== 'yes') return 'The selection acknowledgement is required.';
  if (clean(fields.privacy_ack) !== 'yes') return 'The Privacy Notice acknowledgement is required.';

  return null;
}

export default async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed.' }, 405);
  }

  let fields;
  try {
    fields = await readFields(req);
  } catch {
    return json({ error: 'Invalid application request.' }, 400);
  }

  // Honeypot: make automated submissions look successful without storing them.
  if (clean(fields['bot-field'])) {
    return req.headers.get('x-nocturne-ajax') === '1'
      ? json({ ok: true }, 201)
      : new Response(null, { status: 303, headers: { Location: '/application-received.html' } });
  }

  const error = validate(fields);
  if (error) return json({ error }, 400);

  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const application = {
    id,
    createdAt,
    fullName: clean(fields.full_name, MAX.full_name),
    preferredName: clean(fields.preferred_name, MAX.preferred_name),
    email: clean(fields.email, MAX.email).toLowerCase(),
    phone: clean(fields.phone, MAX.phone),
    location: clean(fields.location, MAX.location),
    instagram: clean(fields.instagram, MAX.instagram),
    referral: clean(fields.referral, MAX.referral),
    community: clean(fields.community, MAX.community),
    whyNocturne: clean(fields.why_nocturne, MAX.why_nocturne),
    groupNames: clean(fields.group_names, MAX.group_names),
    conductAck: clean(fields.conduct_ack) === 'yes',
    selectionAck: clean(fields.selection_ack) === 'yes',
    privacyAck: clean(fields.privacy_ack) === 'yes',
    marketingOptIn: clean(fields.marketing_opt_in) === 'yes'
  };

  try {
    const store = getStore({ name: APPLICATION_STORE, consistency: 'strong' });
    await store.setJSON(id, application, {
      metadata: { createdAt, email: application.email }
    });
  } catch (error) {
    console.error('NOCTURNE application storage failed:', error);
    return json({ error: 'Your application could not be stored. Please try again.' }, 500);
  }

  if (req.headers.get('x-nocturne-ajax') === '1') {
    return json({ ok: true, id }, 201);
  }

  return new Response(null, {
    status: 303,
    headers: {
      Location: '/application-received.html',
      'Cache-Control': 'no-store'
    }
  });
};
