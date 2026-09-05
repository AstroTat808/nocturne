import legacyHandler from './_legacy-create-late-stay-checkout.mjs';
import { browserAddonCheckout } from './_browser-addon-checkout.mjs';

export default function createLateStayCheckout(req) {
  return browserAddonCheckout(req, legacyHandler, {
    formPolicyField: 'late_stay_policy',
    jsonPolicyField: 'lateStayPolicy',
    errorPath: '/ticket/late-stay/confirmed'
  });
}
