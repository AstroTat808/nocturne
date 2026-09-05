import legacyHandler from './_legacy-create-drink-package-checkout.mjs';
import { browserAddonCheckout } from './_browser-addon-checkout.mjs';

export default function createDrinkPackageCheckout(req) {
  return browserAddonCheckout(req, legacyHandler, {
    formPolicyField: 'package_policy',
    jsonPolicyField: 'packagePolicy',
    errorPath: '/ticket/drinks/confirmed'
  });
}
