# NOCTURNE Festival Website

A production-ready static NOCTURNE Festival website designed for GitHub + Netlify. It includes:

- Cinematic responsive homepage using the supplied NOCTURNE artwork
- Invitation-only application flow using Netlify Forms
- Honeypot spam protection
- Privacy notice, terms, code of conduct, success page, and 404
- Private invite redemption page
- Netlify Function-backed invitation code validation
- Netlify Blobs-backed invite records with expiration and single-use redemption
- Protected admin function for generating invite codes
- Security headers and SEO/Open Graph basics

## 1. Deploy from GitHub to Netlify

1. Create a new GitHub repository and push this folder to it.
2. In Netlify, choose **Add new project / Import an existing project** and select the GitHub repository.
3. Netlify reads `netlify.toml` automatically. The configured publish directory is `site` and the build command is `npm run build`.
4. Enable **Forms → Form detection** in the Netlify project if it is not already enabled.
5. Deploy.

## 2. Required Netlify environment variables

Create these in the Netlify project UI under environment variables. Do not commit them to GitHub.

- `NOCTURNE_ADMIN_KEY` — a long random secret used only by the private invite-generation endpoint.
- `NOCTURNE_TICKET_URL` — the HTTPS private ticket purchase URL returned after a valid invite is redeemed.

For stronger control, the admin endpoint also supports attaching a specific `purchaseUrl` to an invite batch, so individual ticketing links can be mapped to invitation codes instead of using the global URL.

## 3. Application review workflow

The application form is named `nocturne-application`. Netlify captures submissions under **Forms**.

Recommended review process:

1. Review identity/contact details, referral source, application answers, and any supplied public profile.
2. Apply written, lawful criteria consistently: community fit, safety, verification, capacity, prior event conduct, and completeness/authenticity of the application.
3. Do not select or reject applicants based on protected characteristics.
4. Mark each decision in your internal review tracker.
5. Generate an invitation code only after approval.
6. Send the accepted applicant the code plus `/invite` on your site.

Netlify can also send form submission notifications/webhooks from the Forms settings if you want the team notified when new applications arrive.

## 4. Generate invitation codes

After the site is deployed, set these locally in your terminal:

```bash
export NOCTURNE_SITE_URL="https://YOUR-DOMAIN.com"
export NOCTURNE_ADMIN_KEY="the-same-secret-you-set-in-netlify"
```

Then generate codes:

```bash
npm run invite:create -- 10 "August approval batch"
```

The command calls the protected Netlify admin function and creates a local CSV containing the raw codes. Only SHA-256 hashes of the codes are stored in Netlify Blobs.

Codes expire after 30 days by default and are single-use when redeemed.

### Direct admin API example

```bash
curl -X POST "https://YOUR-DOMAIN.com/api/admin/create-invites" \
  -H "Authorization: Bearer YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"count":5,"label":"Approved guest batch"}'
```

Optional fields: `expiresAt` (ISO date) and `purchaseUrl` (HTTPS URL).

## 5. Ticketing security model

The private ticket URL is never placed in the public HTML or GitHub repository. It is returned server-side only after a valid invitation code is redeemed.

For the strongest enforcement, use a ticketing platform that can also issue unique purchase links, unique access codes, per-customer limits, or named tickets. A hidden static URL alone is not sufficient protection because a recipient can share any URL after they receive it.

## 6. Netlify Forms

The form uses static HTML with `data-netlify="true"`, a hidden `form-name`, and a honeypot field so Netlify can detect and process it at deploy time.

The current form collects only information relevant to vetting and event administration. Avoid adding unnecessary sensitive personal data to the application.

## 7. Customize before launch

Search the codebase for these items and replace/update as needed:

- `2026` if the event year changes
- Hawai‘i references if venue geography changes
- FAQ reveal language
- privacy/contact wording once you choose an official support email
- ticket terms once the ticketing provider is selected
- any announced date, venue, age restriction, lineup, sponsors, or partner policies

The Instagram link is already set to `@nocturnehawaii`.
