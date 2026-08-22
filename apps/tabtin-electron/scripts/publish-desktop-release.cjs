#!/usr/bin/env node

const { createHash } = require('node:crypto')
const { createReadStream, statSync } = require('node:fs')
const fs = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const DEFAULT_ADMIN_API_PATH = '/api/auth/admin/desktop-updates'
const RELEASE_NOTE_FALLBACK_PREFIX = 'TabTin Desktop release'

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      continue
    }

    const key = token.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      args[key] = true
      continue
    }

    args[key] = next
    index += 1
  }
  return args
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback
  }
  if (typeof value === 'boolean') {
    return value
  }
  const normalized = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false
  }
  return fallback
}

function resolveUpdaterAdminBaseUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim()
  if (!trimmed) {
    return ''
  }

  const normalized = trimmed.replace(/\/+$/, '')
  if (normalized.endsWith(DEFAULT_ADMIN_API_PATH)) {
    return normalized
  }
  return `${normalized}${DEFAULT_ADMIN_API_PATH}`
}

function resolveReleaseNotes(version, rawNotes) {
  const trimmed = String(rawNotes || '').trim()
  if (trimmed) {
    return trimmed
  }
  return `${RELEASE_NOTE_FALLBACK_PREFIX} ${version}`
}

function resolveContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase()
  if (extension === '.zip') {
    return 'application/zip'
  }
  if (extension === '.yml' || extension === '.yaml') {
    return 'text/yaml'
  }
  if (extension === '.exe') {
    return 'application/vnd.microsoft.portable-executable'
  }
  return 'application/octet-stream'
}

/** 上传意图使用短文件名；旧后端也会按该名字落 OSS object key。 */
function buildCanonicalUploadFileName({ platform, arch, version, assetType = 'package', sourceFileName }) {
  const ext = path.extname(String(sourceFileName || '')).toLowerCase()
  const ver = String(version || '').trim()
  const normalizedArch = String(arch || '').trim()
  if (!ver || !ext) return path.basename(String(sourceFileName || ''))
  if (platform === 'win') {
    return `TabTin-${ver}-windows${ext}`
  }
  if (platform === 'mac') {
    if (assetType === 'website_installer') {
      return `TabTin-${ver}-${normalizedArch}${ext}`
    }
    if (ext === '.zip') {
      return `TabTin-${ver}-${normalizedArch}-mac.zip`
    }
    return `TabTin-${ver}-${normalizedArch}${ext}`
  }
  if (platform === 'linux' && normalizedArch) {
    return `TabTin-${ver}-${normalizedArch}${ext}`
  }
  return path.basename(String(sourceFileName || ''))
}

function isRegularFile(filePath) {
  try {
    return statSync(filePath).isFile()
  } catch {
    return false
  }
}

function selectReleaseAsset(filePaths, platform) {
  const normalizedPlatform = String(platform || '').trim()
  const candidates = filePaths.filter((filePath) => {
    if (!isRegularFile(filePath)) {
      return false
    }

    const fileName = path.basename(filePath)
    if (fileName.endsWith('.blockmap') || fileName.endsWith('.yml') || fileName.endsWith('.yaml')) {
      return false
    }

    if (normalizedPlatform === 'mac') {
      return fileName.endsWith('.zip')
    }
    if (normalizedPlatform === 'win') {
      return fileName.endsWith('.exe')
    }
    if (normalizedPlatform === 'linux') {
      return fileName.endsWith('.AppImage')
    }
    return false
  })

  if (candidates.length === 0) {
    const available = filePaths.map((filePath) => path.basename(filePath)).sort().join(', ')
    throw new Error(
      `[release] 未在产物目录中找到 ${normalizedPlatform} 对应的安装包。当前文件: ${available || '(空目录)'}`
    )
  }

  const preferred = [...candidates].sort((left, right) => left.length - right.length || left.localeCompare(right))
  const filePath = preferred[0]
  return {
    filePath,
    fileName: path.basename(filePath),
    contentType: resolveContentType(filePath),
  }
}

function selectWebsiteInstallerAsset(filePaths, platform, arch) {
  const normalizedPlatform = String(platform || '').trim()
  if (normalizedPlatform !== 'mac') {
    return null
  }

  const archToken = String(arch || '').trim()
  const candidates = filePaths.filter((filePath) => {
    if (!isRegularFile(filePath)) {
      return false
    }
    const fileName = path.basename(filePath)
    return fileName.endsWith('.dmg') && !fileName.endsWith('.blockmap')
  })

  if (candidates.length === 0) {
    return null
  }

  const archMatched = archToken
    ? candidates.filter((filePath) => path.basename(filePath).includes(`-${archToken}`))
    : []
  const preferred = (archMatched.length > 0 ? archMatched : candidates).sort(
    (left, right) => left.length - right.length || left.localeCompare(right)
  )
  const filePath = preferred[0]
  return {
    filePath,
    fileName: path.basename(filePath),
    contentType: 'application/x-apple-diskimage',
  }
}

async function uploadWebsiteInstallerIfPresent({
  adminBaseUrl,
  token,
  releaseId,
  websiteAsset,
  required,
}) {
  if (!websiteAsset) {
    if (required) {
      throw new Error(
        '[release] macOS 正式发版必须提供官网 .dmg（与自动更新 .zip 同目录），当前产物目录未找到。'
      )
    }
    return { uploaded: false, publicUrl: '' }
  }

  const checksums = await computeChecksums(websiteAsset.filePath)
  // website 上传需要 version/arch；由调用方塞进 websiteAsset 可选字段，缺省则用原名
  const uploadFileName =
    websiteAsset.canonicalFileName ||
    buildCanonicalUploadFileName({
      platform: websiteAsset.platform || 'mac',
      arch: websiteAsset.arch,
      version: websiteAsset.version,
      assetType: 'website_installer',
      sourceFileName: websiteAsset.fileName,
    })
  const intent = await requestJson({
    method: 'POST',
    url: `${adminBaseUrl}/releases/${releaseId}/asset-upload-intent`,
    token,
    body: {
      asset_type: 'website_installer',
      file_name: uploadFileName,
      file_size: checksums.fileSize,
      content_type: websiteAsset.contentType,
    },
  })

  await uploadAsset({
    presignedUrl: intent.presigned_url,
    filePath: websiteAsset.filePath,
    contentType: intent.content_type || websiteAsset.contentType,
  })

  const finalName = intent.expected_file_name || intent.file_name || uploadFileName
  const completeResult = await requestJson({
    method: 'POST',
    url: `${adminBaseUrl}/releases/${releaseId}/asset-upload-complete`,
    token,
    body: {
      asset_type: 'website_installer',
      object_key: intent.object_key,
      file_name: finalName,
      file_size: checksums.fileSize,
      content_type: intent.content_type || websiteAsset.contentType,
      checksum_sha256: checksums.checksumSha256,
      auto_generate_manifest: false,
    },
  })

  return {
    uploaded: true,
    publicUrl: completeResult.release?.website_file_url || intent.public_url || '',
    fileName: finalName,
    fileSize: checksums.fileSize,
    checksumSha256: checksums.checksumSha256,
  }
}

async function collectDistFiles(distDir) {
  const entries = await fs.readdir(distDir)
  return entries.map((entry) => path.join(distDir, entry))
}

async function computeChecksums(filePath) {
  const sha256 = createHash('sha256')
  const sha512 = createHash('sha512')

  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => {
      sha256.update(chunk)
      sha512.update(chunk)
    })
    stream.on('error', reject)
    stream.on('end', resolve)
  })

  return {
    fileSize: statSync(filePath).size,
    checksumSha256: sha256.digest('hex'),
    checksumSha512: sha512.digest('base64'),
  }
}

async function requestJson({ method, url, token, body }) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  const text = await response.text()
  let payload = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = text
    }
  }

  if (!response.ok) {
    const detail =
      typeof payload === 'string'
        ? payload
        : payload?.detail || payload?.message || JSON.stringify(payload || {})
    throw new Error(`[release] ${method} ${url} 失败 (${response.status}): ${detail}`)
  }

  if (payload === null) {
    return {}
  }
  if (typeof payload === 'string') {
    throw new Error(`[release] ${method} ${url} 返回了非 JSON 响应: ${payload}`)
  }
  return payload
}

/**
 * 上传安装包旁边的 .blockmap（electron-updater 差分下载依赖）。
 *
 * electron-updater 按「安装包 URL + .blockmap」请求差分清单，文件不在
 * OSS 上时差分静默回落全量下载——不致命但差分白做。blockmap 必须在
 * 安装包 asset-upload-complete 之后上传：后端按已登记的安装包文件名
 * 推导 blockmap 的目标对象键。
 *
 * 返回 true 表示已上传；本地没有 blockmap（如 ad-hoc 重签链路会重建
 * zip 并删除失效 blockmap）时返回 false 并告警。
 */
async function uploadBlockmapIfPresent({ adminBaseUrl, token, releaseId, packageFilePath }) {
  const blockmapPath = `${packageFilePath}.blockmap`
  if (!isRegularFile(blockmapPath)) {
    console.warn(
      `[release] 未找到 ${path.basename(blockmapPath)}，跳过 blockmap 上传——该版本差分更新不可用，将全量下载。`
    )
    return false
  }

  const blockmapSize = statSync(blockmapPath).size
  const intent = await requestJson({
    method: 'POST',
    url: `${adminBaseUrl}/releases/${releaseId}/asset-upload-intent`,
    token,
    body: {
      asset_type: 'blockmap',
      file_name: path.basename(blockmapPath),
      file_size: blockmapSize,
      content_type: 'application/octet-stream',
    },
  })

  await uploadAsset({
    presignedUrl: intent.presigned_url,
    filePath: blockmapPath,
    contentType: intent.content_type || 'application/octet-stream',
  })

  await requestJson({
    method: 'POST',
    url: `${adminBaseUrl}/releases/${releaseId}/asset-upload-complete`,
    token,
    body: {
      asset_type: 'blockmap',
      object_key: intent.object_key,
      file_name: intent.expected_file_name || path.basename(blockmapPath),
      file_size: blockmapSize,
      content_type: intent.content_type || 'application/octet-stream',
      auto_generate_manifest: false,
    },
  })

  return true
}

async function uploadAsset({ presignedUrl, filePath, contentType }) {
  const response = await fetch(presignedUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
    },
    body: createReadStream(filePath),
    duplex: 'half',
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`[release] 直传安装包失败 (${response.status}): ${body}`)
  }
}

function buildReleasePayload({
  version,
  platform,
  arch,
  channel,
  releaseNotes,
  releaseNotesEn,
  priority,
  mandatory,
  minCompatibleVersion,
}) {
  return {
    version,
    platform,
    arch,
    channel,
    file_url: '',
    feed_url: '',
    file_size: 0,
    checksum_sha256: '',
    checksum_sha512: '',
    is_mandatory: Boolean(mandatory),
    min_compatible_version: String(minCompatibleVersion || '').trim(),
    priority: String(priority || 'normal').trim() || 'normal',
    rollout_percentage: 0,
    rollout_target_users: [],
    release_notes: resolveReleaseNotes(version, releaseNotes),
    release_notes_en: String(releaseNotesEn || '').trim(),
  }
}

async function findExistingRelease({ adminBaseUrl, token, version, platform, arch, channel }) {
  const params = new URLSearchParams({
    keyword: version,
    platform,
    arch,
    channel,
    page_size: '100',
  })
  const payload = await requestJson({
    method: 'GET',
    url: `${adminBaseUrl}/releases?${params.toString()}`,
    token,
  })

  const releases = Array.isArray(payload.items) ? payload.items : []
  return (
    releases.find(
      (item) =>
        item.version === version &&
        item.platform === platform &&
        item.arch === arch &&
        item.channel === channel
    ) || null
  )
}

async function upsertRelease({
  adminBaseUrl,
  token,
  version,
  platform,
  arch,
  channel,
  releaseNotes,
  releaseNotesEn,
  priority,
  mandatory,
  minCompatibleVersion,
}) {
  const payload = buildReleasePayload({
    version,
    platform,
    arch,
    channel,
    releaseNotes,
    releaseNotesEn,
    priority,
    mandatory,
    minCompatibleVersion,
  })

  const existing = await findExistingRelease({ adminBaseUrl, token, version, platform, arch, channel })
  if (existing) {
    const updated = await requestJson({
      method: 'PUT',
      url: `${adminBaseUrl}/releases/${existing.id}`,
      token,
      body: {
        is_mandatory: payload.is_mandatory,
        min_compatible_version: payload.min_compatible_version,
        priority: payload.priority,
        rollout_percentage: 0,
        rollout_target_users: [],
        release_notes: payload.release_notes,
        release_notes_en: payload.release_notes_en,
      },
    })
    return updated.release
  }

  const created = await requestJson({
    method: 'POST',
    url: `${adminBaseUrl}/releases`,
    token,
    body: payload,
  })
  return created.release
}

/**
 * 从 dist 目录里某个 packaged 安装包的文件名反向推算实际版本号。
 *
 * electron-builder 默认 fileName 模板：`${productName}-${version}-${arch}.${ext}`
 *   例：`TabTin-1.0.0-arm64.dmg`
 *       `TabTin Preprod-1.0.0-preprod.1-arm64.dmg`
 *       `TabTin Preprod-1.0.0-preprod.1-arm64-mac.zip`
 *
 * 这是**真实产物的权威版本号**——build script 顶部 RESOLVED_APP_VERSION
 * 一路 patch 进 deploy/package.json + electron-builder extraMetadata，
 * 最终落到 dmg/zip/exe 文件名里。比环境变量 / helper 派生更可信，因为它已经
 * 被 build 持久化下来了。
 *
 * 返回 null 表示找不到匹配的安装包（比如还没 build / dryRun 前置阶段调用）。
 */
async function readVersionFromDist(distDir, platform) {
  let entries
  try {
    entries = await fs.readdir(distDir)
  } catch {
    return null
  }
  // 一个 platform 可能有多种 ext（mac 同时产 .dmg + .zip；linux 也可能 .AppImage / .deb），
  // 任一命中都行——文件名格式相同，parse 出来版本号必然一致。
  const targetExts =
    platform === 'mac' ? ['.dmg', '.zip'] :
    platform === 'win' ? ['.exe'] :
    platform === 'linux' ? ['.AppImage', '.deb', '.rpm'] :
    []
  if (targetExts.length === 0) return null
  const candidate = entries.find((name) => targetExts.some((ext) => name.endsWith(ext)))
  if (!candidate) return null
  // 版本号格式：x.y.z 或 x.y.z-suffix.N（如 1.0.0-preprod.1 / 1.0.1-rc.2）。
  // 紧跟 `-arm64`/`-x64`/`-x86_64`/`-amd64` 等 arch token，避免误匹配 productName 里的数字。
  const match = candidate.match(/-(\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)-(?:arm64|x64|x86_64|amd64)/)
  return match ? match[1] : null
}

/**
 * 推断本次 release 要登记的 packaged app 版本号。
 *
 * 走的是与 build-packaged-app.sh / electron.vite.config.ts / upload-sourcemaps.sh
 * 同一份 SSOT helper（apps/tabtin-electron/scripts/resolve-app-version.mjs），
 * 同时把 dist 文件名作为**主权来源**做对账——
 * 这是为了挡住"开发者新开终端跑 release，TABTIN_BUILD_PROFILE 已丢失" 这种隐式约定漂移：
 *   1. 上一 shell：`pnpm build:mac:preprod` → 产出 `1.0.0-preprod.1` dmg
 *   2. 新 shell：`pnpm release:publish`（profile 丢失）→ helper 派生 source `1.0.0`
 *   3. release record 写 1.0.0、dmg 实际是 1.0.0-preprod.1 → electron-updater
 *      走 version compare 会判"已是最新"或拒下载 → auto-update silent failure
 *
 * 修法：dist 文件名解出真实版本 + helper 派生对账，不一致直接 throw。
 *
 * 优先级：
 *   1. CLI --version / UPDATER_RELEASE_VERSION 显式 override（main 里早一步消费）
 *   2. 本函数：dist 文件名 parse 出权威版本 → 与 helper 派生比对一致 → 返回
 *   3. dist 不可解析时（首次跑 / 未 build / 异常调用）：fallback 到 helper 派生
 */
async function loadAppVersion(distDir, platform) {
  const helperPath = path.resolve(__dirname, 'resolve-app-version.mjs')
  const { resolveAppVersion } = await import(pathToFileURL(helperPath).href)
  const profile = process.env.TABTIN_BUILD_PROFILE
    ? String(process.env.TABTIN_BUILD_PROFILE).trim()
    : null
  const helperVersion = resolveAppVersion(profile)

  const dmgVersion = await readVersionFromDist(distDir, platform)
  if (!dmgVersion) {
    // dist 不可解析（dry-run 早期 / 首次空 dist），退回 helper 派生。
    // main 后续 collectDistFiles → selectReleaseAsset 仍会兜住 dist 缺失的硬错误。
    return helperVersion
  }

  if (dmgVersion !== helperVersion) {
    throw new Error(
      `[release] dist-app 实际版本号 "${dmgVersion}" 与 helper 派生值 "${helperVersion}" ` +
      `(profile="${profile || '(none)'}") 不一致。\n` +
      `常见根因：开发者在新 shell 里跑 release，TABTIN_BUILD_PROFILE 已丢失，helper 退到源 package.json#version。\n` +
      `修法（任选其一）：\n` +
      `  1) export TABTIN_BUILD_PROFILE=<profile> 后再跑 release（推荐——与 build 同 shell）\n` +
      `  2) --version=${dmgVersion}                 （显式 override，跳过 helper 派生）\n` +
      `  3) UPDATER_RELEASE_VERSION=${dmgVersion}    （环境变量 override，CI 友好）`
    )
  }
  return dmgVersion
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const appDir = path.resolve(__dirname, '..')
  const distDir = path.resolve(process.cwd(), args['dist-dir'] || path.join(appDir, 'dist-app'))
  const platform = String(args.platform || process.env.UPDATER_RELEASE_PLATFORM || '').trim()
  // platform 是 loadAppVersion 做 dist 对账必需的输入，校验前置（原本在 line ~378 这一段，
  // 不影响功能——下面 dryRun 阶段 / dist 推断都需要 platform 先就位）。
  if (!platform) {
    throw new Error('[release] 缺少 --platform，支持 mac / win / linux')
  }
  const arch =
    String(args.arch || process.env.UPDATER_RELEASE_ARCH || (platform === 'mac' ? 'arm64' : 'x64')).trim()
  const channel = String(args.channel || process.env.UPDATER_RELEASE_CHANNEL || 'stable').trim()
  const version = String(
    args.version || process.env.UPDATER_RELEASE_VERSION || (await loadAppVersion(distDir, platform)),
  ).trim()
  const dryRun = normalizeBoolean(args['dry-run'] || process.env.UPDATER_RELEASE_DRY_RUN, false)
  const shouldPublish = normalizeBoolean(
    args.publish || args['publish-release'] || process.env.UPDATER_RELEASE_PUBLISH,
    false
  )
  const shouldPush = normalizeBoolean(args.push || process.env.UPDATER_RELEASE_PUSH, false)
  const silentPush = normalizeBoolean(args['silent-push'] || process.env.UPDATER_RELEASE_SILENT_PUSH, false)
  const rolloutPercentageRaw =
    args['rollout-percentage'] || process.env.UPDATER_RELEASE_ROLLOUT_PERCENTAGE || '0'
  const rolloutPercentage = Number.parseInt(String(rolloutPercentageRaw), 10) || 0
  const releaseNotes = String(args['release-notes'] || process.env.UPDATER_RELEASE_NOTES || '').trim()
  const releaseNotesEn = args['release-notes-en'] || process.env.UPDATER_RELEASE_NOTES_EN || ''
  const priority = args.priority || process.env.UPDATER_RELEASE_PRIORITY || 'normal'
  const mandatory = normalizeBoolean(args.mandatory || process.env.UPDATER_RELEASE_MANDATORY, false)
  const minCompatibleVersion =
    args['min-compatible-version'] || process.env.UPDATER_RELEASE_MIN_COMPATIBLE_VERSION || ''
  const requireWebsiteInstaller = normalizeBoolean(
    args['require-website-installer'] || process.env.UPDATER_REQUIRE_WEBSITE_INSTALLER,
    platform === 'mac' && channel === 'stable'
  )
  const adminBaseUrl = resolveUpdaterAdminBaseUrl(
    args['admin-base-url'] ||
      process.env.UPDATER_ADMIN_API_BASE_URL ||
      process.env.TABTIN_API_BASE_URL ||
      process.env.API_BASE_URL
  )
  const adminToken = String(args['admin-token'] || process.env.UPDATER_ADMIN_TOKEN || '').trim()

  // platform 校验已前置到 loadAppVersion 之前，此处不再重复。

  if (!releaseNotes) {
    throw new Error(
      '[release] 缺少更新文案。请提前配置 --release-notes 或 UPDATER_RELEASE_NOTES（中文必填）。'
    )
  }

  const distFiles = await collectDistFiles(distDir)
  const asset = selectReleaseAsset(distFiles, platform)
  const websiteAsset = selectWebsiteInstallerAsset(distFiles, platform, arch)
  const checksums = await computeChecksums(asset.filePath)
  const summary = {
    version,
    platform,
    arch,
    channel,
    distDir,
    releaseNotes,
    asset: {
      fileName: asset.fileName,
      filePath: asset.filePath,
      contentType: asset.contentType,
      fileSize: checksums.fileSize,
      checksumSha256: checksums.checksumSha256,
      checksumSha512: checksums.checksumSha512,
      blockmapPresent: isRegularFile(`${asset.filePath}.blockmap`),
    },
    websiteInstaller: websiteAsset
      ? {
          fileName: websiteAsset.fileName,
          filePath: websiteAsset.filePath,
          contentType: websiteAsset.contentType,
        }
      : null,
    requireWebsiteInstaller,
    publish: shouldPublish,
    push: shouldPush,
    silentPush,
    rolloutPercentage,
  }

  if (dryRun) {
    if (requireWebsiteInstaller && !websiteAsset) {
      throw new Error(
        '[release] dry-run 失败：macOS stable 需要同目录 .dmg 作为官网安装包，当前未找到。'
      )
    }
    console.log(JSON.stringify({ dryRun: true, ...summary }, null, 2))
    return
  }

  if (!adminBaseUrl) {
    throw new Error('[release] 缺少 UPDATER_ADMIN_API_BASE_URL 或 --admin-base-url')
  }
  if (!adminToken) {
    throw new Error('[release] 缺少 UPDATER_ADMIN_TOKEN 或 --admin-token')
  }
  if (shouldPublish || shouldPush) {
    console.warn(
      '[release] 警告：本次启用了 publish/push。按正式发版口径，打包机自动上传应保持草稿；CDN/短链/发布需人工确认后再执行。'
    )
  }

  const release = await upsertRelease({
    adminBaseUrl,
    token: adminToken,
    version,
    platform,
    arch,
    channel,
    releaseNotes,
    releaseNotesEn,
    priority,
    mandatory,
    minCompatibleVersion,
  })

  const packageUploadFileName = buildCanonicalUploadFileName({
    platform,
    arch,
    version,
    assetType: 'package',
    sourceFileName: asset.fileName,
  })
  const uploadIntent = await requestJson({
    method: 'POST',
    url: `${adminBaseUrl}/releases/${release.id}/asset-upload-intent`,
    token: adminToken,
    body: {
      asset_type: 'package',
      file_name: packageUploadFileName,
      file_size: checksums.fileSize,
      content_type: asset.contentType,
    },
  })
  const packageFinalName =
    uploadIntent.expected_file_name || uploadIntent.file_name || packageUploadFileName

  await uploadAsset({
    presignedUrl: uploadIntent.presigned_url,
    filePath: asset.filePath,
    contentType: uploadIntent.content_type || asset.contentType,
  })

  const completeResult = await requestJson({
    method: 'POST',
    url: `${adminBaseUrl}/releases/${release.id}/asset-upload-complete`,
    token: adminToken,
    body: {
      asset_type: 'package',
      object_key: uploadIntent.object_key,
      file_name: packageFinalName,
      file_size: checksums.fileSize,
      content_type: uploadIntent.content_type || asset.contentType,
      checksum_sha256: checksums.checksumSha256,
      checksum_sha512: checksums.checksumSha512,
      auto_generate_manifest: true,
    },
  })

  // blockmap 依赖已登记的安装包文件名，必须在 package complete 之后上传
  const blockmapUploaded = await uploadBlockmapIfPresent({
    adminBaseUrl,
    token: adminToken,
    releaseId: release.id,
    packageFilePath: asset.filePath,
  })

  const websiteUpload = await uploadWebsiteInstallerIfPresent({
    adminBaseUrl,
    token: adminToken,
    releaseId: release.id,
    websiteAsset: websiteAsset
      ? {
          ...websiteAsset,
          platform,
          arch,
          version,
        }
      : null,
    required: requireWebsiteInstaller,
  })

  const readiness = await requestJson({
    method: 'POST',
    url: `${adminBaseUrl}/releases/${release.id}/readiness-check`,
    token: adminToken,
  })

  let publishedRelease = completeResult.release
  if (shouldPublish || shouldPush) {
    if (publishedRelease.status === 'draft') {
      const publishResult = await requestJson({
        method: 'POST',
        url: `${adminBaseUrl}/releases/${release.id}/publish`,
        token: adminToken,
      })
      publishedRelease = publishResult.release
    }
  }

  let pushedRelease = publishedRelease
  if (shouldPush) {
    const pushResult = await requestJson({
      method: 'POST',
      url: `${adminBaseUrl}/releases/${release.id}/push`,
      token: adminToken,
      body: {
        rollout_percentage: rolloutPercentage > 0 ? rolloutPercentage : undefined,
        silent: silentPush,
      },
    })
    pushedRelease = pushResult.release
  }

  const detail = await requestJson({
    method: 'GET',
    url: `${adminBaseUrl}/releases/${release.id}`,
    token: adminToken,
  })
  const finalRelease = detail.release || pushedRelease

  console.log(
    JSON.stringify(
      {
        dryRun: false,
        ...summary,
        releaseId: release.id,
        blockmapUploaded,
        websiteInstallerUploaded: websiteUpload.uploaded,
        websiteFileUrl: finalRelease.website_file_url || websiteUpload.publicUrl || '',
        fileUrl: finalRelease.file_url || '',
        downloadFileUrl: finalRelease.download_file_url || '',
        releaseStatus: finalRelease.status || pushedRelease.status,
        effectiveFeedUrl: finalRelease.effective_feed_url || pushedRelease.effective_feed_url,
        manifestUrl: finalRelease.manifest_url || pushedRelease.manifest_url,
        readinessStatus: readiness.status,
        readinessBlockingIssues: readiness.blocking_issue_count,
        readinessWarningIssues: readiness.warning_issue_count,
        nextManualSteps: [
          'CDN 刷新/预热（人工确认后）',
          '发布版本（人工确认后）',
          '官网短链更换（人工确认后）',
        ],
      },
      null,
      2
    )
  )
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}

module.exports = {
  parseArgs,
  normalizeBoolean,
  resolveUpdaterAdminBaseUrl,
  resolveReleaseNotes,
  resolveContentType,
  selectReleaseAsset,
  selectWebsiteInstallerAsset,
  computeChecksums,
  buildReleasePayload,
  uploadBlockmapIfPresent,
  uploadWebsiteInstallerIfPresent,
  main,
}
