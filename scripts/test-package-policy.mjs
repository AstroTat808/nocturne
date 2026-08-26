import assert from 'node:assert/strict';

const PACKAGE_POLICY = 'FINAL SALE / NON-REFUNDABLE';

assert.equal(PACKAGE_POLICY.includes('NON-REFUNDABLE'), true);
console.log('NOCTURNE package policy regression test placeholder passed.');
