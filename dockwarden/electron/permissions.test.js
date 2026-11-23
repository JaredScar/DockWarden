const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rendererPermissionAllowed } = require('./permissions');

test('clipboard writes are allowed and every other renderer permission stays denied', () => {
  assert.equal(rendererPermissionAllowed('clipboard-sanitized-write'), true);
  assert.equal(rendererPermissionAllowed('clipboard-read'), true);
  for (const permission of ['camera', 'geolocation', 'notifications', 'media', 'midi', 'clipboard-write']) {
    assert.equal(rendererPermissionAllowed(permission), false, permission);
  }
});
