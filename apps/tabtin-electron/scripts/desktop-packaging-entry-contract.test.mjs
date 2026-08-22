import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const scriptDirectory = new URL('./', import.meta.url)
const fullBuild = readFileSync(new URL('build-packaged-app.sh', scriptDirectory), 'utf8')
const quickMacBuild = readFileSync(new URL('build-mac-dmg-quick.sh', scriptDirectory), 'utf8')
const frameworkLinkRepair = new URL('repair-macos-framework-links.sh', scriptDirectory)

test('packaged build runs typecheck without inheriting the repository i18n prebuild hook', () => {
  assert.match(fullBuild, /pnpm run typecheck\s+node "\$SCRIPT_DIR\/run-electron-vite\.mjs" build/)
  assert.doesNotMatch(fullBuild, /^\s*pnpm build\s*$/m)
})

test('full and quick builds invoke the pinned electron-builder installation', () => {
  for (const source of [fullBuild, quickMacBuild]) {
    assert.match(source, /EXPECTED_ELECTRON_BUILDER_VERSION="25\.1\.8"/)
    assert.match(source, /node "\$ELECTRON_BUILDER_CLI"/)
    assert.doesNotMatch(source, /\bnpx electron-builder\b/)
  }
})

test('local packaging has no private upload credential gate', () => {
  assert.doesNotMatch(fullBuild, /local profile 强制要求 sourcemap 上传/)
  assert.match(fullBuild, /Sourcemap upload failed \(non-fatal\)/)
})

test('packaging reuses the installed Electron runtime and guards optional helpers', () => {
  for (const source of [fullBuild, quickMacBuild]) {
    assert.match(source, /--config\.electronDist=\$INSTALLED_ELECTRON_DIST/)
  }
  assert.match(fullBuild, /if \[ ! -f "\$EMBEDDING_MODEL_FETCH_SCRIPT" \]/)
})

test('packaging uses moved runtime helpers and defers Office download to first preview', () => {
  assert.match(fullBuild, /scripts\/electron\/package\/prepare-python-runtime\.sh/)
  assert.match(fullBuild, /scripts\/electron\/runtime\/fetch-embedding-model\.mjs/)
  assert.doesNotMatch(fullBuild, /scripts\/prepare-python-runtime-for-electron-packaging\.sh/)
  assert.doesNotMatch(fullBuild, /\$REPO_ROOT\/scripts\/fetch-embedding-model\.mjs/)
  assert.match(fullBuild, /fetch-desktop-runtimes\.sh" --only python/)
  assert.match(fullBuild, /stage_office_preview_runtime_download_manifest/)
})

test('local macOS packages always use certificate-free ad-hoc signing', () => {
  for (const source of [fullBuild, quickMacBuild]) {
    assert.match(source, /export CSC_IDENTITY_AUTO_DISCOVERY=false/)
    assert.match(source, /unset CSC_LINK CSC_KEY_PASSWORD CSC_NAME CSC_KEYCHAIN/)
    assert.match(source, /repair-macos-framework-links\.sh" "\$app_bundle"\s+codesign/)
    assert.match(source, /codesign --force --deep --sign - "\$app_bundle"/)
  }
  assert.match(fullBuild, /if \[ "\$PROFILE" = "local" \]; then\s+NEED_ADHOC_SIGN=1/)
  assert.doesNotMatch(quickMacBuild, /find_developer_id_identity/)
})

test('macOS packaging repairs flattened framework aliases before signing', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tabtin-framework-links-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const appBundle = join(root, 'TabTin.app')
  const framework = join(appBundle, 'Contents', 'Frameworks', 'Example.framework')
  const version = join(framework, 'Versions', 'A')

  mkdirSync(join(version, 'Resources'), { recursive: true })
  writeFileSync(join(version, 'Example'), 'original binary')
  mkdirSync(join(framework, 'Versions', 'Current'), { recursive: true })
  writeFileSync(join(framework, 'Example'), 'binary with applied fuses')
  mkdirSync(join(framework, 'Resources'), { recursive: true })

  const result = spawnSync('bash', [frameworkLinkRepair.pathname, appBundle], {
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(readlinkSync(join(framework, 'Versions', 'Current')), 'A')
  assert.equal(readlinkSync(join(framework, 'Example')), 'Versions/Current/Example')
  assert.equal(readlinkSync(join(framework, 'Resources')), 'Versions/Current/Resources')
  assert.equal(readFileSync(join(framework, 'Example'), 'utf8'), 'binary with applied fuses')
  assert.equal(
    readFileSync(join(framework, 'Versions', 'Current', 'Example'), 'utf8'),
    'binary with applied fuses',
  )
})
