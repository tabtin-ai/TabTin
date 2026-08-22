const {
  existsSync,
  readdirSync,
  statSync,
} = require('node:fs')
const { createRequire } = require('node:module')
const path = require('node:path')

function loadElectronFusesModule() {
  const appPackageJson = path.resolve(__dirname, '../../../apps/tabtin-electron/package.json')
  if (existsSync(appPackageJson)) {
    return createRequire(appPackageJson)('@electron/fuses')
  }
  const localPackageJson = path.resolve(__dirname, '../package.json')
  if (existsSync(localPackageJson)) {
    try {
      return createRequire(localPackageJson)('@electron/fuses')
    } catch {
      // deploy 目录在仓库根时，devDependency 不在本次 node_modules 里
    }
  }
  throw new Error(
    '[electron-fuses] 无法解析 @electron/fuses。请确认 apps/tabtin-electron/node_modules/@electron/fuses 存在。',
  )
}

function parseBoolean(value, defaultValue = false) {
  if (value == null || value === '') {
    return defaultValue
  }

  const normalized = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false
  }

  return defaultValue
}

function normalizeProfile(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!normalized) {
    return undefined
  }
  if (normalized === 'dev' || normalized === 'development') {
    return 'development'
  }
  if (normalized === 'local' || normalized === 'localdev') {
    return 'local'
  }
  if (normalized === 'preprod' || normalized === 'preproduction') {
    return 'preprod'
  }
  if (normalized === 'prod' || normalized === 'production') {
    return 'production'
  }
  return undefined
}

function resolveFuseProfile(env = process.env) {
  return (
    normalizeProfile(env.TABTIN_ELECTRON_FUSE_PROFILE) ||
    normalizeProfile(env.TABTIN_RUNTIME_PROFILE) ||
    normalizeProfile(env.TABTIN_BUILD_PROFILE) ||
    normalizeProfile(env.VITE_BUILD_PROFILE) ||
    (env.NODE_ENV === 'development' ? 'development' : 'production')
  )
}

function createFusePolicy(env = process.env) {
  const profile = resolveFuseProfile(env)
  const isProtectedProfile = profile === 'preprod' || profile === 'production'
  const runAsNode = isProtectedProfile
    ? false
    : parseBoolean(env.TABTIN_ENABLE_RUN_AS_NODE_FUSE, profile === 'development' || profile === 'local')
  const enableNodeOptionsEnvironmentVariable = isProtectedProfile
    ? false
    : parseBoolean(env.TABTIN_ENABLE_NODE_OPTIONS_FUSE, profile === 'development' || profile === 'local')
  const enableNodeCliInspectArguments = isProtectedProfile
    ? false
    : parseBoolean(env.TABTIN_ENABLE_NODE_INSPECT_FUSE, profile === 'development' || profile === 'local')

  return {
    profile,
    runAsNode,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable,
    enableNodeCliInspectArguments,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: !parseBoolean(env.TABTIN_DISABLE_ONLY_LOAD_APP_FROM_ASAR, false),
    // Enabling this requires shipping browser_v8_context_snapshot.bin. Without it,
    // packaged macOS builds abort inside ElectronMain before app code runs.
    loadBrowserProcessSpecificV8Snapshot: parseBoolean(env.TABTIN_ENABLE_BROWSER_V8_SNAPSHOT, false),
    grantFileProtocolExtraPrivileges: true,
  }
}

function getProductFilename(context) {
  return context?.packager?.appInfo?.productFilename || context?.packager?.appInfo?.productName || 'Electron'
}

function getExecutableCandidateNames(context) {
  const candidates = new Set()
  const appInfo = context?.packager?.appInfo
  const addCandidate = (value) => {
    if (typeof value !== 'string') {
      return
    }

    const normalized = value.trim()
    if (!normalized) {
      return
    }

    candidates.add(normalized)
  }

  addCandidate(context?.packager?.executableName)
  addCandidate(context?.packager?.platformSpecificBuildOptions?.executableName)
  addCandidate(appInfo?.productFilename)
  addCandidate(appInfo?.productName)
  addCandidate(appInfo?.sanitizedProductName)
  addCandidate(appInfo?.sanitizedName)
  addCandidate(appInfo?.name)

  if (typeof appInfo?.name === 'string') {
    addCandidate(appInfo.name.toLowerCase())
  }
  if (typeof appInfo?.sanitizedName === 'string') {
    addCandidate(appInfo.sanitizedName.toLowerCase())
  }

  if (candidates.size === 0) {
    addCandidate(getProductFilename(context))
  }

  return [...candidates]
}

function resolvePackagedAppPath(context) {
  const appOutDir = context && typeof context.appOutDir === 'string' ? context.appOutDir : ''
  if (!appOutDir) {
    throw new Error('[electron-fuses] 缺少 appOutDir，无法翻转 Electron fuses')
  }
  if (!existsSync(appOutDir)) {
    throw new Error(`[electron-fuses] appOutDir 不存在: ${appOutDir}`)
  }

  const electronPlatformName = context?.electronPlatformName || process.platform
  const candidateNames = getExecutableCandidateNames(context)

  const directCandidates = candidateNames.map((candidateName) => {
    switch (electronPlatformName) {
      case 'darwin':
      case 'mas':
        return path.join(appOutDir, `${candidateName}.app`)
      case 'win32':
        return path.join(appOutDir, candidateName.endsWith('.exe') ? candidateName : `${candidateName}.exe`)
      default:
        return path.join(appOutDir, candidateName)
    }
  })

  const directMatch = directCandidates.find((candidate) => existsSync(candidate))
  if (directMatch) {
    return directMatch
  }

  const entries = readdirSync(appOutDir)
  if (electronPlatformName === 'darwin' || electronPlatformName === 'mas') {
    const appEntry = entries.find((entry) => entry.endsWith('.app'))
    if (appEntry) {
      return path.join(appOutDir, appEntry)
    }
  }

  if (electronPlatformName === 'win32') {
    const exeEntry = entries.find((entry) => entry.toLowerCase().endsWith('.exe'))
    if (exeEntry) {
      return path.join(appOutDir, exeEntry)
    }
  }

  const lowerCaseNames = candidateNames.map((candidateName) => candidateName.toLowerCase())
  const caseInsensitiveMatch = entries.find((entry) => lowerCaseNames.includes(entry.toLowerCase()))
  if (caseInsensitiveMatch) {
    return path.join(appOutDir, caseInsensitiveMatch)
  }

  throw new Error(
    `[electron-fuses] 无法在 ${appOutDir} 下定位 ${electronPlatformName} 的 Electron 可执行目标`
  )
}

function createWireConfig(fusesModule, env = process.env) {
  const { FuseVersion, FuseV1Options } = fusesModule
  const policy = createFusePolicy(env)

  return {
    policy,
    config: {
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: policy.runAsNode,
      [FuseV1Options.EnableCookieEncryption]: policy.enableCookieEncryption,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: policy.enableNodeOptionsEnvironmentVariable,
      [FuseV1Options.EnableNodeCliInspectArguments]: policy.enableNodeCliInspectArguments,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: policy.enableEmbeddedAsarIntegrityValidation,
      [FuseV1Options.OnlyLoadAppFromAsar]: policy.onlyLoadAppFromAsar,
      [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: policy.loadBrowserProcessSpecificV8Snapshot,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: policy.grantFileProtocolExtraPrivileges,
    },
  }
}

function getBrowserV8SnapshotCandidates(appPath, electronPlatformName = process.platform) {
  if (electronPlatformName === 'darwin' || electronPlatformName === 'mas') {
    return [
      path.join(
        appPath,
        'Contents',
        'Frameworks',
        'Electron Framework.framework',
        'Resources',
        'browser_v8_context_snapshot.bin'
      ),
      path.join(
        appPath,
        'Contents',
        'Frameworks',
        'Electron Framework.framework',
        'Versions',
        'A',
        'Resources',
        'browser_v8_context_snapshot.bin'
      ),
      path.join(appPath, 'Contents', 'Resources', 'browser_v8_context_snapshot.bin'),
    ]
  }

  return [
    path.join(appPath, 'browser_v8_context_snapshot.bin'),
    path.join(appPath, 'resources', 'browser_v8_context_snapshot.bin'),
  ]
}

function assertBrowserV8SnapshotPresent(appPath, electronPlatformName) {
  const candidates = getBrowserV8SnapshotCandidates(appPath, electronPlatformName)
  if (candidates.some((candidate) => existsSync(candidate))) {
    return
  }

  throw new Error(
    [
      '[electron-fuses] TABTIN_ENABLE_BROWSER_V8_SNAPSHOT=1 requires browser_v8_context_snapshot.bin,',
      'but no snapshot file was found in the packaged app.',
      'Checked:',
      ...candidates.map((candidate) => `  - ${candidate}`),
    ].join('\n')
  )
}

function resolveResourcesPath(appPath, electronPlatformName = process.platform) {
  if (electronPlatformName === 'darwin' || electronPlatformName === 'mas') {
    return path.join(appPath, 'Contents', 'Resources')
  }
  return path.join(appPath, 'resources')
}

async function applyElectronFuses(context, fusesModule) {
  const resolvedModule = fusesModule ?? loadElectronFusesModule()
  if (typeof resolvedModule.flipFuses !== 'function') {
    throw new Error('[electron-fuses] @electron/fuses 未暴露 flipFuses，无法继续')
  }

  const appPath = resolvePackagedAppPath(context)
  const { policy, config } = createWireConfig(resolvedModule, process.env)
  if (policy.loadBrowserProcessSpecificV8Snapshot) {
    assertBrowserV8SnapshotPresent(appPath, context?.electronPlatformName)
  }

  await resolvedModule.flipFuses(appPath, config)

  return { appPath, policy, config }
}

async function flipElectronFusesHook(context) {
  if (parseBoolean(process.env.TABTIN_DISABLE_ELECTRON_FUSES, false)) {
    console.warn('[electron-fuses] 已通过 TABTIN_DISABLE_ELECTRON_FUSES 跳过 fuse 翻转')
    return
  }

  const result = await applyElectronFuses(context)
  console.log(
    '[electron-fuses] 已应用 Electron fuses:',
    JSON.stringify(
      {
        platform: context.electronPlatformName,
        appPath: result.appPath,
        policy: result.policy,
      },
      null,
      2
    )
  )
}

async function protectedAfterPackHook(context) {
  await flipElectronFusesHook(context)
}

module.exports = protectedAfterPackHook
module.exports.default = protectedAfterPackHook
module.exports.parseBoolean = parseBoolean
module.exports.normalizeProfile = normalizeProfile
module.exports.resolveFuseProfile = resolveFuseProfile
module.exports.createFusePolicy = createFusePolicy
module.exports.resolvePackagedAppPath = resolvePackagedAppPath
module.exports.createWireConfig = createWireConfig
module.exports.getBrowserV8SnapshotCandidates = getBrowserV8SnapshotCandidates
module.exports.assertBrowserV8SnapshotPresent = assertBrowserV8SnapshotPresent
module.exports.resolveResourcesPath = resolveResourcesPath
module.exports.applyElectronFuses = applyElectronFuses
module.exports.flipElectronFusesHook = flipElectronFusesHook
