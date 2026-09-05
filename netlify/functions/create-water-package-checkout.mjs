import legacyHandler from './_legacy-create-water-package-checkout.mjs';
import { browserAddonCheckout } from './_browser-addon-checkout.mjs';

export default function createWaterPackageCheckout(req) {
  return browserAddonCheckout(req, legacyHandler, {
    formPolicyField: 'water_policy',
    jsonPolicyField: 'waterPolicy',
    errorPath: '/ticket/water/confirmed'
  });
}
