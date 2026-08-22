const { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')

function resolveAppPath(context) {
  const appOutDir = context?.appOutDir
  if (!appOutDir) {
    throw new Error('[notarize] 缺少 appOutDir，无法定位 .app')
  }

  const productFilename =
    context?.packager?.appInfo?.productFilename || context?.packager?.appInfo?.productName || 'Electron'
  const directPath = path.join(appOutDir, `${productFilename}.app`)
  if (existsSync(directPath)) {
    return directPath
  }

  const appEntry = readdirSync(appOutDir).find((entry) => entry.endsWith('.app'))
  if (appEntry) {
    return path.join(appOutDir, appEntry)
  }

  throw new Error(`[notarize] 无法在 ${appOutDir} 下定位 .app`)
}

function buildAppleApiKeyOptions(env) {
  if (!env.APPLE_API_KEY_ID || !env.APPLE_API_ISSUER) {
    return null
  }

  const inlineKey = env.APPLE_API_KEY
  const keyPath = env.APPLE_API_KEY_PATH
  if (!inlineKey && !keyPath) {
    return null
  }

  let tempDir = null
  let resolvedKeyPath = keyPath
  if (!resolvedKeyPath) {
    tempDir = mkdtempSync(path.join(tmpdir(), 'tabtin-notary-'))
    resolvedKeyPath = path.join(tempDir, 'AuthKey.p8')
    writeFileSync(resolvedKeyPath, inlineKey, 'utf8')
  }

  return {
    tempDir,
    options: {
      appleApiKey: resolvedKeyPath,
      appleApiKeyId: env.APPLE_API_KEY_ID,
      appleApiIssuer: env.APPLE_API_ISSUER,
    },
  }
}

function buildAppleIdOptions(env) {
  if (!env.APPLE_ID || !env.APPLE_APP_SPECIFIC_PASSWORD || !env.APPLE_TEAM_ID) {
    return null
  }

  return {
    tempDir: null,
    options: {
      appleId: env.APPLE_ID,
      appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: env.APPLE_TEAM_ID,
    },
  }
}

async function afterSign(context, notarizeModule) {
  if (context.electronPlatformName !== 'darwin') {
    return
  }

  const appPath = resolveAppPath(context)
  const appBundleId = context?.packager?.appInfo?.id
  const credentialSet = buildAppleApiKeyOptions(process.env) || buildAppleIdOptions(process.env)

  if (!credentialSet) {
    console.log('[notarize] 未检测到 Apple 公证凭据，跳过 notarization')
    return
  }

  try {
    const resolvedModule = notarizeModule ?? (await import('@electron/notarize'))
    if (typeof resolvedModule.notarize !== 'function') {
      throw new Error('[notarize] @electron/notarize 未暴露 notarize，无法继续')
    }

    await resolvedModule.notarize({
      appBundleId,
      appPath,
      tool: 'notarytool',
      ...credentialSet.options,
    })
    console.log(`[notarize] 已完成公证: ${appPath}`)
  } finally {
    if (credentialSet.tempDir) {
      rmSync(credentialSet.tempDir, { recursive: true, force: true })
    }
  }
}

module.exports = afterSign
module.exports.default = afterSign
module.exports.resolveAppPath = resolveAppPath
module.exports.buildAppleApiKeyOptions = buildAppleApiKeyOptions
module.exports.buildAppleIdOptions = buildAppleIdOptions
