const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const scriptPath = path.join(__dirname, 'build-packaged-app.sh')
const installerPath = path.join(__dirname, '..', 'build', 'installer.nsh')
const buildScript = fs.readFileSync(scriptPath, 'utf8')
const quickMacBuildScript = fs.readFileSync(
  path.join(__dirname, 'build-mac-dmg-quick.sh'),
  'utf8',
)
const installer = fs.readFileSync(installerPath, 'utf8')

assert.ok(buildScript.includes('PROFILE_PRODUCT_NAME="TabTin Preprod"'))
assert.ok(buildScript.includes('PROFILE_APP_ID="com.tabtin.app.preprod"'))
assert.ok(buildScript.includes('PROFILE_EXECUTABLE_NAME="tabtin-preprod"'))
assert.ok(buildScript.includes('PROFILE_SHORTCUT_NAME="TabTin Preprod"'))
assert.ok(buildScript.includes('"--config.win.executableName=$PROFILE_EXECUTABLE_NAME"'))
assert.ok(buildScript.includes('"--config.nsis.shortcutName=$PROFILE_SHORTCUT_NAME"'))
assert.ok(quickMacBuildScript.includes('PROFILE_PRODUCT_NAME="TabTin Preprod"'))
assert.ok(quickMacBuildScript.includes('PROFILE_APP_ID="com.tabtin.app.preprod"'))

const appIdentity = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'main', 'app-identity.ts'),
  'utf8',
)
assert.ok(appIdentity.includes('process.env.TABTIN_DATA_ROOT = profileRoot'))
assert.ok(appIdentity.includes("process.env.TABTIN_RUNTIME_ROOT = join(profileRoot, 'runtime')"))

const deepLink = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'deep-link.ts'), 'utf8')
assert.ok(deepLink.includes('resolveTabTinProtocolScheme'))
assert.ok(deepLink.includes('app.setAsDefaultProtocolClient(deepLinkScheme)'))

const notifyLaunch = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'main', 'services', 'notification', 'notify-launch.ts'),
  'utf8',
)
assert.ok(notifyLaunch.includes('resolveTabTinProtocolScheme'))
assert.ok(notifyLaunch.includes('${scheme}://${TOAST_NOTIFY_HOST}'))
// Keep the newer release cleanup contract: uninstall removes credentials and
// optional config/cache for every known profile, while preserving workspaces.
for (const profile of ['TabTin', 'TabTin Dev', 'TabTin Local', 'TabTin Preprod', 'tabtin-electron']) {
  assert.ok(installer.includes(`Delete "$APPDATA\\${profile}\\credentials.json"`))
  assert.ok(installer.includes(`!insertmacro wipeTabTinProfileConfig "$APPDATA\\${profile}"`))
}
assert.ok(installer.includes('$PROFILE\\.tabtin\\server.json'))
assert.ok(installer.includes('$PROFILE\\.tabtin-daemon'))
assert.ok(installer.includes('$LOCALAPPDATA\\com.tabtin.app.preprod-updater'))
assert.ok(!installer.includes('RMDir /r "$APPDATA\\TabTin"'))

console.log('install identity contract: ok')
