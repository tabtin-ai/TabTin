const {
  existsSync,
  readdirSync,
  statSync,
} = require('node:fs')
const { readFile, writeFile } = require('node:fs/promises')
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

function loadElectronBuilderAsarIntegrityTools() {
  const requireCandidates = []
  if (require.main?.filename) {
    requireCandidates.push(createRequire(require.main.filename))
  }
  if (process.argv[1]) {
    requireCandidates.push(createRequire(path.resolve(process.argv[1])))
  }

  const appPackageJson = path.resolve(__dirname, '../../../apps/tabtin-electron/package.json')
  if (existsSync(appPackageJson)) {
    const appRequire = createRequire(appPackageJson)
    try {
      const electronBuilderPackageJson = appRequire.resolve('electron-builder/package.json')
      requireCandidates.push(createRequire(electronBuilderPackageJson))
    } catch {
      // Isolated deploy trees load this hook from the electron-builder process.
    }
  }

  for (const candidateRequire of requireCandidates) {
    try {
      const { computeData } = candidateRequire('app-builder-lib/out/asar/integrity')
      const resedit = candidateRequire('resedit')
      if (typeof computeData === 'function' && resedit?.NtExecutable) {
        return { computeData, resedit }
      }
    } catch {
      // Try the next resolver. pnpm keeps app-builder-lib beside electron-builder.
    }
  }

  throw new Error(
    '[electron-fuses] 无法解析 electron-builder 的 Windows ASAR 完整性工具，不能生成可启动的 Windows 包。',
  )
}

function createWindowsAsarIntegrityList(asarIntegrity) {
  return Object.entries(asarIntegrity).map(([file, { algorithm: alg, hash: value }]) => ({
    // A Windows Electron process looks up resources\\app.asar. When Windows is
    // cross-packaged on macOS, path.join in electron-builder emits '/', which
    // makes the embedded record invisible to Electron at startup.
    file: file.replaceAll('/', '\\'),
    alg,
    value,
  }))
}

async function writeWindowsAsarIntegrityResource(exePath, asarIntegrity, resedit) {
  const buffer = await readFile(exePath)
  const executable = resedit.NtExecutable.from(buffer)
  const resource = resedit.NtExecutableResource.from(executable)
  const versionInfo = resedit.Resource.VersionInfo.fromEntries(resource.entries)
  if (versionInfo.length !== 1) {
    throw new Error(`[electron-fuses] 无法解析 Windows 版本资源: ${exePath}`)
  }
  const languages = versionInfo[0].getAllLanguagesForStringValues()
  if (languages.length !== 1) {
    throw new Error(`[electron-fuses] 无法定位 Windows 资源语言: ${exePath}`)
  }

  const integrityList = createWindowsAsarIntegrityList(asarIntegrity)
  resource.entries = resource.entries.filter(
    (entry) => !(entry.type === 'INTEGRITY' && entry.id === 'ELECTRONASAR'),
  )
  resource.entries.push({
    type: 'INTEGRITY',
    id: 'ELECTRONASAR',
    bin: Buffer.from(JSON.stringify(integrityList)),
    lang: languages[0].lang,
    codepage: languages[0].codepage,
  })
  resource.outputResource(executable)
  await writeFile(exePath, Buffer.from(executable.generate()))
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
  if (electronPlatformName === 'win32' && appPath.toLowerCase().endsWith('.exe')) {
    return path.join(path.dirname(appPath), 'resources')
  }
  return path.join(appPath, 'resources')
}

async function restoreWindowsAsarIntegrity(appPath, tools = loadElectronBuilderAsarIntegrityTools()) {
  const resourcesPath = resolveResourcesPath(appPath, 'win32')
  const asarIntegrity = await tools.computeData({
    resourcesPath,
    resourcesRelativePath: 'resources',
  })
  if (Object.keys(asarIntegrity).length === 0) {
    throw new Error(`[electron-fuses] 未在 ${resourcesPath} 找到 ASAR，无法恢复 Windows 完整性资源`)
  }
  const writer = tools.writeWindowsAsarIntegrityResource ?? writeWindowsAsarIntegrityResource
  await writer(appPath, asarIntegrity, tools.resedit)
  return asarIntegrity
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

  // Re-embed INTEGRITY/ELECTRONASAR after the fuse rewrite. This also normalizes
  // its file path to Windows separators: macOS cross-builds otherwise record
  // resources/app.asar, while Electron asks for resources\\app.asar and aborts
  // before main JS with archive_win.cc:142.
  if (
    context?.electronPlatformName === 'win32'
    && policy.enableEmbeddedAsarIntegrityValidation
  ) {
    await restoreWindowsAsarIntegrity(appPath)
  }

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
module.exports.loadElectronBuilderAsarIntegrityTools = loadElectronBuilderAsarIntegrityTools
module.exports.createWindowsAsarIntegrityList = createWindowsAsarIntegrityList
module.exports.writeWindowsAsarIntegrityResource = writeWindowsAsarIntegrityResource
module.exports.restoreWindowsAsarIntegrity = restoreWindowsAsarIntegrity
module.exports.applyElectronFuses = applyElectronFuses
module.exports.flipElectronFusesHook = flipElectronFusesHook
