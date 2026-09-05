import { createHash } from 'node:crypto';

export const WAIVER_VERSION = '2026-09-05.1';
export const WAIVER_TITLE = 'NOCTURNE Festival Participant Waiver, Release, Assumption of Risk & Emergency Authorization';
export const WAIVER_TEXT = `In consideration for being permitted to attend and remain at NOCTURNE Festival at Koa's Events, I acknowledge and agree as follows:

1. VOLUNTARY PARTICIPATION AND RISKS. I understand that attendance may involve risks including crowds, loud amplified sound and possible hearing injury, dancing and physical activity, darkness and reduced visibility, uneven or slippery ground, weather, insects, vehicles and parking areas, camping or sleeping in vehicles, alcohol consumption by adults, dehydration, falls, collisions, acts of other guests, artists or contractors, and other known and unknown risks that may cause property damage, bodily injury, illness, permanent disability, or death.

2. ASSUMPTION OF RISK. I knowingly and voluntarily assume the inherent and reasonably foreseeable risks of attending, participating in, parking at, and remaining on the event property, including any Late Checkout / Car Camping period.

3. RELEASE TO THE FULLEST EXTENT PERMITTED BY LAW. To the fullest extent permitted by applicable Hawaii law, I release and discharge Wild Ones LLC, Koa's Events, the property owner or lessor, event producers, affiliates, contractors, artists, vendors, volunteers, employees, agents, and representatives from claims arising from the risks I have assumed, including claims based on ordinary negligence only to the extent such claims may lawfully be released. This agreement does not waive liability that cannot lawfully be waived, including liability for gross negligence, reckless or willful and wanton misconduct, or intentional acts.

4. PERSONAL RESPONSIBILITY. I am responsible for my own conduct, hydration, hearing protection, footwear, transportation, alcohol decisions, medications, medical conditions, valuables, and compliance with event rules and staff directions. I will not drive while impaired.

5. MEDICAL CARE. If I am unable to consent during an emergency, I authorize event personnel to contact emergency services and permit reasonable emergency assistance. I understand that I am responsible for my own medical expenses unless otherwise required by law.

6. PROPERTY AND VEHICLES. I accept the risks associated with parking, entering, exiting, or remaining in or around vehicles and with any optional overnight or late-stay activity. I agree to follow staff instructions regarding parking, camping, restricted areas, fire safety, and departure deadlines.

7. ELECTRONIC SIGNATURE. I agree to conduct this waiver transaction electronically. I understand that typing my full legal name and selecting the acceptance boxes constitutes my electronic signature. I have had the opportunity to read, save, print, and review this agreement before signing.

8. SEVERABILITY AND HAWAII LAW. This agreement is intended to be enforced to the maximum extent permitted by Hawaii law. If any provision is held unenforceable, the remaining provisions will continue to the extent permitted by law.`;

export const WAIVER_TEXT_HASH = createHash('sha256').update(WAIVER_TEXT).digest('hex');

export function waiverSigned(summary = {}, review = {}) {
  return Boolean(summary.waiverSignedAt && summary.waiverVersion === WAIVER_VERSION && summary.waiverTextHash === WAIVER_TEXT_HASH)
    || Boolean(review.waiverSignedAt && review.waiverVersion === WAIVER_VERSION && review.waiverTextHash === WAIVER_TEXT_HASH);
}

export function waiverFields({ signerName, participantName, signerRole, guardianRelationship = '', signedAt, userAgent = '', clientIpHash = '' }) {
  return {
    waiverSignedAt: signedAt,
    waiverVersion: WAIVER_VERSION,
    waiverTitle: WAIVER_TITLE,
    waiverTextHash: WAIVER_TEXT_HASH,
    waiverSignerName: signerName,
    waiverParticipantName: participantName,
    waiverSignerRole: signerRole,
    waiverGuardianRelationship: guardianRelationship || null,
    waiverElectronicConsent: true,
    waiverUserAgent: String(userAgent || '').slice(0, 500),
    waiverClientIpHash: clientIpHash || null,
    updatedAt: signedAt
  };
}
