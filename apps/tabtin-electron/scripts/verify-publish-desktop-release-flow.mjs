#!/usr/bin/env node
/**
 * 验收 harness：验证 publish-desktop-release 上传草稿链路的门禁与步骤顺序。
 *
 * 覆盖：
 * 1. 缺 UPDATER_RELEASE_NOTES / --release-notes → 失败
 * 2. mac stable dry-run 缺 dmg → 失败
 * 3. mac fixture + mock fetch：upsert → package → blockmap → website_installer → readiness
 *    且默认不调用 publish/push，release 保持 draft
 * 4. 可选：对本机 dist-app 做 win dry-run（有 exe 时）
 *
 * 用法：
 *   node apps/tabtin-electron/scripts/verify-publish-desktop-release-flow.mjs
 */

import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const releaseScript = require('./publish-desktop-release.cjs')
const {
  selectReleaseAsset,
  selectWebsiteInstallerAsset,
  main,
} = releaseScript

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const ELECTRON_DIR = path.resolve(SCRIPT_DIR, '..')
const ROOT = path.resolve(ELECTRON_DIR, '../..')
const DIST_APP = path.join(ELECTRON_DIR, 'dist-app')

let passed = 0
let failed = 0
const findings = []

function ok(name, detail = '') {
  passed += 1
  findings.push({ status: 'PASS', name, detail })
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`)
}

function fail(name, detail = '') {
  failed += 1
  findings.push({ status: 'FAIL', name, detail })
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
}

function assert(condition, name, detail = '') {
  if (condition) ok(name, detail)
  else fail(name, detail)
}

function createMacFixtureDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'tabtin-release-verify-'))
  const zipName = 'TabTin-1.0.99-arm64-mac.zip'
  const dmgName = 'TabTin-1.0.99-arm64.dmg'
  writeFileSync(path.join(dir, zipName), Buffer.from('fake-zip-content-for-verify'))
  writeFileSync(path.join(dir, `${zipName}.blockmap`), Buffer.from('fake-blockmap'))
  writeFileSync(path.join(dir, dmgName), Buffer.from('fake-dmg-content-for-verify'))
  writeFileSync(
    path.join(dir, 'latest-mac.yml'),
    'version: 1.0.99\nfiles:\n  - url: TabTin-1.0.99-arm64-mac.zip\n'
  )
  return dir
}

function classifyAdminCall(method, url) {
  const u = String(url)
  if (method === 'GET' && /\/releases\?/.test(u)) return 'list_releases'
  if (method === 'POST' && /\/releases$/.test(u.replace(/\/+$/, ''))) return 'create_release'
  if (method === 'PUT' && /\/releases\/\d+$/.test(u)) return 'update_release'
  if (method === 'POST' && /asset-upload-intent/.test(u)) return 'asset_intent'
  if (method === 'POST' && /asset-upload-complete/.test(u)) return 'asset_complete'
  if (method === 'POST' && /readiness-check/.test(u)) return 'readiness_check'
  if (method === 'POST' && /\/publish$/.test(u)) return 'publish'
  if (method === 'POST' && /\/push$/.test(u)) return 'push'
  if (method === 'GET' && /\/releases\/\d+$/.test(u)) return 'get_release'
  if (method === 'PUT' && /presign\.example\.com/.test(u)) return 'oss_put'
  return `${method} ${u}`
}

async function drainBody(body) {
  if (!body) return
  if (typeof body === 'string' || Buffer.isBuffer(body)) return
  if (typeof body.getReader === 'function') {
    const reader = body.getReader()
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }
    return
  }
  if (typeof body.on === 'function') {
    await new Promise((resolve, reject) => {
      body.on('data', () => {})
      body.on('end', resolve)
      body.on('error', reject)
    })
  }
}

function buildMockFetch(calls) {
  return async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase()
    let body = null
    if (typeof init.body === 'string' && init.body) {
      body = JSON.parse(init.body)
    }
    const kind = classifyAdminCall(method, url)
    calls.push({ method, url: String(url), kind, body, assetType: body?.asset_type })

    if (kind === 'list_releases') {
      return jsonResponse({ items: [] })
    }
    if (kind === 'create_release') {
      return jsonResponse({
        release: {
          id: 42,
          status: 'draft',
          version: body.version,
          platform: body.platform,
          arch: body.arch,
          channel: body.channel,
          release_notes: body.release_notes,
          file_url: '',
          website_file_url: '',
          rollout_percentage: 0,
        },
      })
    }
    if (kind === 'asset_intent') {
      const fileName = body.file_name
      const objectKey = `desktop-updates/stable/mac/arm64/1.0.99/${fileName}`
      return jsonResponse({
        asset_type: body.asset_type,
        file_name: fileName,
        expected_file_name: fileName,
        object_key: objectKey,
        presigned_url: `https://presign.example.com/${objectKey}`,
        access_url: `https://oss.example.com/${objectKey}`,
        cdn_url: `https://cdn.example.com/${objectKey}`,
        public_url: `https://cdn.example.com/${objectKey}`,
        content_type: body.content_type || 'application/octet-stream',
        expires_in: 900,
      })
    }
    if (kind === 'oss_put') {
      await drainBody(init.body)
      return new Response(null, { status: 200 })
    }
    if (kind === 'asset_complete') {
      const isWebsite = body.asset_type === 'website_installer'
      const isPackage = body.asset_type === 'package'
      return jsonResponse({
        success: true,
        message: 'ok',
        release: {
          id: 42,
          status: 'draft',
          version: '1.0.99',
          platform: 'mac',
          arch: 'arm64',
          channel: 'stable',
          file_url: isPackage
            ? 'https://cdn.example.com/desktop-updates/stable/mac/arm64/1.0.99/TabTin-1.0.99-arm64-mac.zip'
            : 'https://cdn.example.com/desktop-updates/stable/mac/arm64/1.0.99/TabTin-1.0.99-arm64-mac.zip',
          website_file_url: isWebsite
            ? 'https://cdn.example.com/desktop-updates/stable/mac/arm64/1.0.99/TabTin-1.0.99-arm64.dmg'
            : '',
          effective_feed_url: 'https://cdn.example.com/desktop-updates/stable/mac/arm64/1.0.99/',
          manifest_url: 'https://cdn.example.com/desktop-updates/stable/mac/arm64/1.0.99/latest-mac.yml',
          download_file_url: isWebsite
            ? 'https://cdn.example.com/desktop-updates/stable/mac/arm64/1.0.99/TabTin-1.0.99-arm64.dmg'
            : 'https://cdn.example.com/desktop-updates/stable/mac/arm64/1.0.99/TabTin-1.0.99-arm64-mac.zip',
          rollout_percentage: 0,
        },
        asset: {
          asset_type: body.asset_type,
          manifest_generated: isPackage,
          public_url: `https://cdn.example.com/${body.object_key}`,
        },
      })
    }
    if (kind === 'readiness_check') {
      return jsonResponse({
        status: 'ready',
        blocking_issue_count: 0,
        warning_issue_count: 0,
      })
    }
    if (kind === 'get_release') {
      return jsonResponse({
        release: {
          id: 42,
          status: 'draft',
          version: '1.0.99',
          platform: 'mac',
          arch: 'arm64',
          channel: 'stable',
          file_url:
            'https://cdn.example.com/desktop-updates/stable/mac/arm64/1.0.99/TabTin-1.0.99-arm64-mac.zip',
          website_file_url:
            'https://cdn.example.com/desktop-updates/stable/mac/arm64/1.0.99/TabTin-1.0.99-arm64.dmg',
          download_file_url:
            'https://cdn.example.com/desktop-updates/stable/mac/arm64/1.0.99/TabTin-1.0.99-arm64.dmg',
          effective_feed_url: 'https://cdn.example.com/desktop-updates/stable/mac/arm64/1.0.99/',
          manifest_url: 'https://cdn.example.com/desktop-updates/stable/mac/arm64/1.0.99/latest-mac.yml',
          rollout_percentage: 0,
        },
      })
    }
    return jsonResponse({ detail: `unexpected mock call ${kind}` }, 500)
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function captureMainStdout(fn) {
  const chunks = []
  const originalWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk, encoding, cb) => {
    chunks.push(String(chunk))
    if (typeof cb === 'function') cb()
    return true
  }
  try {
    await fn()
  } finally {
    process.stdout.write = originalWrite
  }
  return chunks.join('')
}

async function testMissingReleaseNotes() {
  const dir = createMacFixtureDir()
  try {
    let error = null
    try {
      await main([
        '--platform',
        'mac',
        '--arch',
        'arm64',
        '--channel',
        'stable',
        '--version',
        '1.0.99',
        '--dist-dir',
        dir,
        '--dry-run',
      ])
    } catch (err) {
      error = err
    }
    assert(
      Boolean(error && /缺少更新文案/.test(String(error.message || error))),
      '门禁：缺 release notes 必须失败',
      error ? String(error.message || error) : '未抛错'
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function testMacStableDryRunRequiresDmg() {
  const dir = mkdtempSync(path.join(tmpdir(), 'tabtin-release-nodmg-'))
  try {
    writeFileSync(path.join(dir, 'TabTin-1.0.99-arm64-mac.zip'), Buffer.from('zip-only'))
    writeFileSync(path.join(dir, 'TabTin-1.0.99-arm64-mac.zip.blockmap'), Buffer.from('bm'))
    let error = null
    try {
      await main([
        '--platform',
        'mac',
        '--arch',
        'arm64',
        '--channel',
        'stable',
        '--version',
        '1.0.99',
        '--dist-dir',
        dir,
        '--release-notes',
        '验收文案',
        '--dry-run',
      ])
    } catch (err) {
      error = err
    }
    assert(
      Boolean(error && /需要同目录 \.dmg/.test(String(error.message || error))),
      '门禁：mac stable dry-run 缺 dmg 必须失败',
      error ? String(error.message || error) : '未抛错'
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function testAssetSelection() {
  const dir = createMacFixtureDir()
  try {
    const files = readdirSync(dir).map((name) => path.join(dir, name))
    const packageAsset = selectReleaseAsset(files, 'mac')
    const websiteAsset = selectWebsiteInstallerAsset(files, 'mac', 'arm64')
    assert(packageAsset.fileName.endsWith('.zip'), '选包：mac package 必须是 zip', packageAsset.fileName)
    assert(websiteAsset?.fileName.endsWith('.dmg'), '选包：mac website 必须是 dmg', websiteAsset?.fileName)
    assert(
      selectWebsiteInstallerAsset(files, 'win', 'x64') === null,
      '选包：win 不要求 website_installer'
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function testMockedUploadSequenceKeepsDraft() {
  const dir = createMacFixtureDir()
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = buildMockFetch(calls)

  try {
    const stdout = await captureMainStdout(async () => {
      await main([
        '--platform',
        'mac',
        '--arch',
        'arm64',
        '--channel',
        'stable',
        '--version',
        '1.0.99',
        '--dist-dir',
        dir,
        '--release-notes',
        '验收：mock 全链路',
        '--admin-base-url',
        'https://api.example.com',
        '--admin-token',
        'test-token',
      ])
    })

    const payload = JSON.parse(stdout)
    const kinds = calls.map((item) => item.kind)
    const completeAssetTypes = calls
      .filter((item) => item.kind === 'asset_complete')
      .map((item) => item.body.asset_type)

    assert(kinds.includes('create_release'), '步骤：创建草稿')
    assert(completeAssetTypes[0] === 'package', '步骤顺序：先 package complete', String(completeAssetTypes))
    assert(completeAssetTypes.includes('blockmap'), '步骤：上传 blockmap', String(completeAssetTypes))
    assert(
      completeAssetTypes.includes('website_installer'),
      '步骤：上传 website_installer',
      String(completeAssetTypes)
    )
    assert(
      completeAssetTypes.indexOf('blockmap') > completeAssetTypes.indexOf('package'),
      '步骤顺序：blockmap 在 package 之后'
    )
    assert(
      completeAssetTypes.indexOf('website_installer') > completeAssetTypes.indexOf('package'),
      '步骤顺序：website_installer 在 package 之后'
    )
    assert(kinds.includes('readiness_check'), '步骤：readiness-check')
    assert(!kinds.includes('publish'), '约束：默认不 publish')
    assert(!kinds.includes('push'), '约束：默认不 push')
    assert(payload.releaseStatus === 'draft', '结果：保持草稿', payload.releaseStatus)
    assert(payload.websiteInstallerUploaded === true, '结果：dmg 已上传')
    assert(payload.blockmapUploaded === true, '结果：blockmap 已上传')
    assert(Array.isArray(payload.nextManualSteps) && payload.nextManualSteps.length >= 3, '结果：输出人工后续步骤')
    assert(payload.readinessBlockingIssues === 0, '结果：readiness 无阻塞', String(payload.readinessBlockingIssues))
  } catch (err) {
    fail('mock 全链路执行', String(err?.stack || err))
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
}

function testWinDistDryRunIfPresent() {
  if (!existsSync(DIST_APP)) {
    ok('可选：win dist-app dry-run', '跳过（无 dist-app）')
    return
  }
  const files = readdirSync(DIST_APP)
  const exe = files.find((name) => name.endsWith('.exe') && !name.endsWith('.blockmap'))
  if (!exe) {
    ok('可选：win dist-app dry-run', '跳过（无 .exe）')
    return
  }

  const result = spawnSync(
    process.execPath,
    [
      path.join(ELECTRON_DIR, 'scripts/publish-desktop-release.cjs'),
      '--platform',
      'win',
      '--arch',
      'x64',
      '--channel',
      'alpha',
      '--version',
      '0.0.1-alpha.160',
      '--dist-dir',
      DIST_APP,
      '--release-notes',
      '验收 dry-run',
      '--dry-run',
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        UPDATER_RELEASE_PUBLISH: 'false',
      },
    }
  )

  if (result.status !== 0) {
    fail('可选：win dist-app dry-run', result.stderr || result.stdout)
    return
  }
  try {
    const payload = JSON.parse(result.stdout)
    assert(payload.dryRun === true, 'win dry-run 输出 dryRun=true')
    assert(payload.asset?.fileName?.endsWith('.exe'), 'win dry-run 选中 exe', payload.asset?.fileName)
    assert(payload.requireWebsiteInstaller === false, 'win alpha 不强制 website_installer')
  } catch (err) {
    fail('可选：win dist-app dry-run 解析', String(err))
  }
}

async function mainVerify() {
  console.log('=== verify publish-desktop-release upload-draft flow ===\n')
  await testMissingReleaseNotes()
  await testMacStableDryRunRequiresDmg()
  await testAssetSelection()
  await testMockedUploadSequenceKeepsDraft()
  testWinDistDryRunIfPresent()

  console.log(`\n=== summary: ${passed} passed, ${failed} failed ===`)
  if (failed > 0) {
    process.exitCode = 1
  }
}

mainVerify().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
