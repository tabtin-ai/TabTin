#!/usr/bin/env node

/**
 * 人工确认后的桌面更新上线：
 * CDN 刷新/预热 → 发布草稿 → 同步官网短链 → 探测 /dl/<slug>
 *
 * 用法：
 *   # 按 release-id（会带上该版本的 platform/channel）
 *   node scripts/confirm-desktop-go-live.cjs --release-id 123
 *   node scripts/confirm-desktop-go-live.cjs --release-id 123 --confirm
 *
 *   # 按平台（取该渠道最新有包草稿）
 *   node scripts/confirm-desktop-go-live.cjs --platform win --channel beta
 *   node scripts/confirm-desktop-go-live.cjs --platform win --channel beta --confirm
 */

const { normalizeBoolean, parseArgs, resolveUpdaterAdminBaseUrl } = require('./publish-desktop-release.cjs')

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
    throw new Error(`[go-live] ${method} ${url} 失败 (${response.status}): ${detail}`)
  }
  return payload || {}
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const releaseId = String(args['release-id'] || process.env.UPDATER_RELEASE_ID || '').trim()
  const platform = String(args.platform || process.env.UPDATER_GO_LIVE_PLATFORM || '').trim().toLowerCase()
  const channel = String(args.channel || process.env.UPDATER_GO_LIVE_CHANNEL || 'stable').trim().toLowerCase()
  const confirm = normalizeBoolean(args.confirm || process.env.UPDATER_GO_LIVE_CONFIRM, false)
  const adminBaseUrl = resolveUpdaterAdminBaseUrl(
    args['admin-base-url'] ||
      process.env.UPDATER_ADMIN_API_BASE_URL ||
      process.env.TABTIN_API_BASE_URL ||
      process.env.API_BASE_URL
  )
  const adminToken = String(args['admin-token'] || process.env.UPDATER_ADMIN_TOKEN || '').trim()
  const publicApiBase = String(
    args['public-api-base'] || process.env.PUBLIC_API_BASE_URL || process.env.TABTIN_API_BASE_URL || ''
  ).trim()

  if (!adminBaseUrl) {
    throw new Error('[go-live] 缺少 UPDATER_ADMIN_API_BASE_URL')
  }
  if (!adminToken) {
    throw new Error('[go-live] 缺少 UPDATER_ADMIN_TOKEN')
  }

  let resolvedPlatform = platform
  let resolvedChannel = channel
  const releaseIds = []

  if (releaseId) {
    const detail = await requestJson({
      method: 'GET',
      url: `${adminBaseUrl}/releases/${releaseId}`,
      token: adminToken,
    })
    const release = detail.release
    if (!release) {
      throw new Error(`[go-live] 未找到 release ${releaseId}`)
    }
    resolvedPlatform = release.platform
    resolvedChannel = release.channel
    releaseIds.push(release.id)
  } else if (!resolvedPlatform) {
    throw new Error('[go-live] 请提供 --release-id 或 --platform')
  }

  const payload = {
    platform: resolvedPlatform,
    channel: resolvedChannel,
    release_ids: releaseIds,
    dry_run: !confirm,
    cdn_refresh: true,
    cdn_warmup: true,
    publish: true,
    short_link: true,
    probe_short_links: true,
    public_api_base: publicApiBase,
  }

  const result = await requestJson({
    method: 'POST',
    url: `${adminBaseUrl}/go-live`,
    token: adminToken,
    body: payload,
  })

  console.log(JSON.stringify(result, null, 2))
  if (!result.success && !result.ok) {
    process.exitCode = 1
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
