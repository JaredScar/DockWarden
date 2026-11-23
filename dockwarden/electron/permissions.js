const CLIPBOARD_PERMISSIONS = new Set(['clipboard-sanitized-write', 'clipboard-read']);

function rendererPermissionAllowed(permission) {
  return CLIPBOARD_PERMISSIONS.has(permission);
}

module.exports = { rendererPermissionAllowed };
