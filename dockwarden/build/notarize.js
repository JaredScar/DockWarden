/**
 * afterSign hook for electron-builder.
 *
 * Runs Apple notarytool notarization on macOS release builds when the
 * required credentials are present in the environment.  The hook is a
 * no-op on all other platforms and on local builds where the env vars
 * are absent, so developer builds continue to work without any changes.
 *
 * Required env vars (set these in CI / your release environment):
 *   APPLE_ID                  - Apple ID used to sign in to notarytool
 *   APPLE_APP_SPECIFIC_PASSWORD - app-specific password for that Apple ID
 *   APPLE_TEAM_ID             - 10-character Apple Developer Team ID
 */

'use strict';

const { notarize } = require('@electron/notarize');

exports.default = async function notarizeApp(context) {
  if (process.platform !== 'darwin') return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;

  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log(
      '[notarize] Skipping notarization — APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set.'
    );
    return;
  }

  const { appOutDir, packager } = context;
  const appName = packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  console.log(`[notarize] Submitting ${appPath} to Apple notarytool…`);

  await notarize({
    tool: 'notarytool',
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });

  console.log(`[notarize] Notarization complete for ${appPath}`);
};
