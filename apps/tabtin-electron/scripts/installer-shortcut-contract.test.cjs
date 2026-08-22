const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const installerPath = path.join(__dirname, '..', 'build', 'installer.nsh')
const source = fs.readFileSync(installerPath, 'utf8')

assert.match(
  source,
  /!macro customInstall\s+!insertmacro removeDuplicateTabTinDesktopShortcut\s+!insertmacro removeStaleTabTinStartMenuShortcut\s+!macroend/,
  'customInstall must run both legacy shortcut cleanups',
)
assert.match(
  source,
  /\$\{If\} \$installMode == "all"[\s\S]*StrCpy \$0 "\$newDesktopLink"/,
  "cleanup must preserve electron-builder's all-users shortcut",
)
assert.match(
  source,
  /SetShellVarContext current[\s\S]*Delete "\$DESKTOP\\\$\{SHORTCUT_NAME\}\.lnk"/,
  'cleanup must inspect the current-user desktop',
)
assert.doesNotMatch(
  source,
  /SetShellVarContext all[\s\S]*Delete "\$DESKTOP\\\$\{SHORTCUT_NAME\}\.lnk"/,
  'a per-user install must never delete the public desktop shortcut',
)
assert.match(
  source,
  /Delete "\$DESKTOP\\\$\{SHORTCUT_NAME\}\.lnk"[\s\S]*SetShellVarContext all/,
  'all-users cleanup must restore the public shell context',
)
assert.doesNotMatch(
  source,
  /Delete "\$DESKTOP\\TabTin(?: Preprod| Local)?\.lnk"/,
  'cleanup must use the profile-specific shortcut name instead of deleting another brand',
)
assert.match(
  source,
  /!macro removeStaleTabTinStartMenuShortcut[\s\S]*\$\{If\} \$installMode == "all"[\s\S]*SetShellVarContext current[\s\S]*Delete "\$SMPROGRAMS\\\$\{SHORTCUT_NAME\}\.lnk"[\s\S]*SetShellVarContext all[\s\S]*!macroend/,
  'all-users install must remove the stale current-user Start Menu shortcut and restore shell context',
)

console.log('installer shortcut contract: ok')
