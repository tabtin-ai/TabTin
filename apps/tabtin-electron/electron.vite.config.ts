import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import checker from 'vite-plugin-checker'
import { resolve, dirname } from 'path'
import { copyFileSync, mkdirSync, readFileSync, existsSync, appendFileSync, cpSync } from 'fs'
import { createRequire } from 'module'
import { defaultClientConditions, defaultServerConditions, type Plugin } from 'vite'
import { buildProductionCsp } from './scripts/production-csp'

/**
 * 把 pdfjs-dist 的 cmaps + standard_fonts 拷进 renderer publicDir(static/)，
 * 让 PdfViewer 能本地加载 CMap——渲染非嵌入 CID 字体(如 reportlab 的中文
 * STSong-Light)时必需；缺它则中文映射不出来、页面空白。资源随 publicDir 进
 * dev server 与打包产物,字形仍由用户系统字体绘制(useSystemFonts)。
 * 产物经 gitignore,不入库;buildStart 在 serve/build 前同步拷贝。
 */
function copyPdfjsAssetsPlugin(): Plugin {
  return {
    name: 'tabtin-copy-pdfjs-assets',
    buildStart() {
      // 用 __dirname（本配置已在用，CJS 形态可靠）派生 require，避免 import.meta.url 在
      // 编译为 CJS 时为 undefined。
      const requireFromHere = createRequire(resolve(__dirname, 'electron.vite.config.ts'))
      const distDir = dirname(requireFromHere.resolve('pdfjs-dist/package.json'))
      const staticDir = resolve(__dirname, 'static')
      for (const sub of ['cmaps', 'standard_fonts']) {
        const from = resolve(distDir, sub)
        if (existsSync(from)) {
          cpSync(from, resolve(staticDir, sub), { recursive: true })
        }
      }
    },
  }
}

/** Django 侧 provider-icons 为 SSoT；构建/开发启动时镜像到 renderer assets 以便打进安装包。 */
function copyProviderIconAssetsPlugin(): Plugin {
  const fromDir = resolve(__dirname, '../tabtin_django/apps/services/llm/static/llm/provider-icons')
  const toDir = resolve(__dirname, 'src/renderer/src/assets/provider-icons')
  return {
    name: 'tabtin-copy-provider-icon-assets',
    buildStart() {
      if (!existsSync(fromDir)) {
        console.warn('[Config] ⚠️  provider-icons 源目录不存在，跳过同步:', fromDir)
        return
      }
      mkdirSync(toDir, { recursive: true })
      cpSync(fromDir, toDir, {
        recursive: true,
        filter: (src) => src.endsWith('.svg') || src === fromDir,
      })
    },
  }
}

// 🔧 加载环境变量
//
// 加载顺序（后加载覆盖前加载，本段读到的值会 force 覆盖 process.env）：
//   • 日常 pnpm dev：仓库根 .env → 仓库根 .env.local（个人覆盖，gitignore）
//   • 显式 dev env file：仓库根 .env → 指定 env 文件（跳过 .env.local）
//   • 打安装包：仓库根 .env → apps/tabtin-electron/.env.<profile>
//
// 关键：本段必须 **force overwrite** process.env，原因——
//   vite build 默认 mode='production' 会自动加载 apps/tabtin-electron/.env.production，
//   且 vite loadEnv 内部 process.env 优先级最高（覆盖 .env.* 文件读到的值）。
//   只有把我们想要的 profile 配置先压进 process.env，vite 最终的 import.meta.env
//   才会用我们的值——否则 local profile build 会偷偷指向生产服务器（重大故障）。
const buildProfile = process.env.TABTIN_BUILD_PROFILE?.trim() || ''
const explicitDevEnvFile = process.env.TABTIN_ELECTRON_DEV_ENV_FILE?.trim() || ''
// vite mode 名（由 run-electron-vite.mjs 写入），可能与 buildProfile 不同
// （例：profile='local' → viteMode='localdev'，因 vite 拒绝 'local' 这个保留字）。
// envFileLoaded 段优先读 .env.<viteMode> 与 vite 自身 loadEnv 对齐。
const viteMode = process.env.TABTIN_VITE_MODE?.trim() || ''
const initialProcessEnv: Record<string, string | undefined> = { ...process.env }
const ENV_REFERENCE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
const expandEnvReferences = (value: string, scope: Record<string, string | undefined>): string =>
  value.replace(ENV_REFERENCE_PATTERN, (match, key: string) => scope[key] ?? match)
const isDevOnly = process.env.NODE_ENV !== 'production'
  && !buildProfile
  && (!viteMode || viteMode === 'development')
const skipPackagedBuildTypecheck = process.env.TABTIN_PACKAGED_BUILD_SKIP_TYPECHECK === '1'
const skipPackagedBuildSourcemaps = process.env.TABTIN_PACKAGED_BUILD_SKIP_SOURCEMAPS === '1'
const devProcessEnvWinsKeys = new Set([
  'TABTIN_API_BASE_URL',
  'TABTIN_DAEMON_CONTROL_API_BASE_URL',
  'VITE_API_BASE_URL',
  'VITE_COLLAB_WS_BASE',
  'VITE_CENTRIFUGO_WS_URL',
  'TABTIN_PUBLIC_WEB_BASE_URL',
  'VITE_PUBLIC_WEB_BASE_URL',
  'VITE_WEBSITE_BASE_URL',
])
const explicitBuildProcessEnvWinsKeys = new Set([
  // Community build 脚本已完成 endpoint 安全校验；其显式输入必须压过
  // .env.community 的本地默认值。其他 profile 仍以各自文件为 SSoT。
  'TABTIN_API_BASE_URL',
  'VITE_API_BASE_URL',
  'TABTIN_WS_BASE_URL',
  'VITE_WS_BASE_URL',
  'VITE_IM_API_BASE_URL',
  'VITE_COLLAB_WS_BASE',
  'VITE_CENTRIFUGO_WS_URL',
  'VITE_PUBLIC_WEB_BASE_URL',
  'VITE_WEBSITE_BASE_URL',
  'VITE_DISTRIBUTION_KIND',
  // 打包时可被 shell 注入的功能开关（不是环境地址类 SSoT）。
  // 语义：process.env 只压过「根 .env」默认值；一旦 profile 文件
  // （.env.production / .env.preprod / .env.<mode>）显式写出该键，以 profile 为准。
  // 否则开发机/打包机若继承了根 .env 的 false，会把渠道配置锁死（IM 打包再现）。
  'VITE_ENABLE_DEBUG_PANELS',
  // release/0.1.0：Project 先不对客；preprod / 内部包显式注入才展示入口。
  'VITE_ENABLE_PROJECTS_UI',
  // ChatGPT Codex 订阅套餐入口：preprod / 本地开，正式包关。
  'VITE_ENABLE_OPENAI_CODEX_BYOK_UI',
  // Daemon Control 的底层链路总闸；产品入口由组织 + 服务端版本灰度决定。
  'DAEMON_CONTROL_ENABLED',
])
const envCandidates: string[] = []
const rootEnvPath = resolve(__dirname, '../../.env')
const readInitialDevProcessOverride = (key: string): string | undefined => {
  if (!isDevOnly || !devProcessEnvWinsKeys.has(key)) return undefined
  return initialProcessEnv[key]
}
const readInitialBuildProcessOverride = (
  key: string,
  candidatePath: string,
): string | undefined => {
  if (isDevOnly || !explicitBuildProcessEnvWinsKeys.has(key)) return undefined
  if (buildProfile === 'community') return initialProcessEnv[key]
  // profile 文件显式键是渠道 SSoT；ambient shell 不得盖掉。
  if (candidatePath !== rootEnvPath) return undefined
  return initialProcessEnv[key]
}
envCandidates.push(rootEnvPath)
if (explicitDevEnvFile) {
  envCandidates.push(resolve(explicitDevEnvFile))
} else if (!isDevOnly) {
  if (viteMode) {
    envCandidates.push(resolve(__dirname, `.env.${viteMode}`))
  }
  if (buildProfile && buildProfile !== viteMode) {
    envCandidates.push(resolve(__dirname, `.env.${buildProfile}`))
  }
  if (process.env.NODE_ENV === 'production' && !buildProfile) {
    envCandidates.push(resolve(__dirname, '.env.production'))
  }
} else {
  envCandidates.push(resolve(__dirname, '../../.env.local'))
}

const envVars: Record<string, string> = {}
const envVarSources: Record<string, string> = {}
let envFileLoaded: string | null = null
const setRuntimeEnv = (key: string, value: string, source: string): void => {
  envVars[key] = value
  envVarSources[key] = source
  process.env[key] = value
}
for (const candidate of envCandidates) {
  if (!existsSync(candidate)) continue
  const envContent = readFileSync(candidate, 'utf-8')
  const candidateVars: Record<string, string> = {}
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim()
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=')
      if (key && valueParts.length > 0) {
        const normalizedKey = key.trim()
        // 只尊重启动 electron-vite 前真实存在的 shell override。
        // 不能读 process.env 当前值：根 .env 会先写入 process.env，否则会误挡 .env.local 覆盖。
        const processOverrideValue =
          readInitialDevProcessOverride(normalizedKey) ??
          readInitialBuildProcessOverride(normalizedKey, candidate)
        if (processOverrideValue) {
          setRuntimeEnv(normalizedKey, processOverrideValue, 'process')
          candidateVars[normalizedKey] = processOverrideValue
          return
        }

        const value = expandEnvReferences(valueParts.join('=').trim(), {
          ...process.env,
          ...envVars,
          ...candidateVars,
        })
        envVarSources[normalizedKey] = candidate
        envVars[normalizedKey] = value
        candidateVars[normalizedKey] = value
        // 故意 force overwrite——见上面 block 注释
        process.env[normalizedKey] = value
      }
    }
  })
  envFileLoaded = candidate
}
if (envFileLoaded) {
  console.log(`[Config] ✅ 已加载环境变量，最后覆盖文件: ${envFileLoaded}:`, Object.keys(envVars).join(', '))
  if (buildProfile) {
    console.log(`[Config] 🏷  build profile = ${buildProfile}`)
  }
} else {
  console.warn('[Config] ⚠️  未找到任何 .env 文件，候选路径:', envCandidates.join(', '))
}

/** 开发态：按 .env.local 的 TABTIN_LOCAL_DEV_MODE 套用模式一/模式二预设 URL */
function applyDevModePresets(scope: Record<string, string>) {
  if (!isDevOnly) return
  const mode = scope.TABTIN_LOCAL_DEV_MODE?.trim()
  if (!mode || mode === 'native') return

  const prefix = mode === 'lite' ? 'TABTIN_LITE_' : mode === 'docker' ? 'TABTIN_DOCKER_' : null
  if (!prefix) {
    console.warn(`[Config] ⚠️  未知 TABTIN_LOCAL_DEV_MODE=${mode}（允许 lite / docker / native）`)
    return
  }

  const mappings: Array<[string, string]> = [
    ['API_BASE_URL', 'TABTIN_API_BASE_URL'],
    ['API_BASE_URL', 'VITE_API_BASE_URL'],
    ['COLLAB_WS_BASE', 'VITE_COLLAB_WS_BASE'],
    ['CENTRIFUGO_WS_URL', 'VITE_CENTRIFUGO_WS_URL'],
    ['PUBLIC_WEB_BASE_URL', 'VITE_PUBLIC_WEB_BASE_URL'],
    ['PUBLIC_WEB_BASE_URL', 'TABTIN_PUBLIC_WEB_BASE_URL'],
    ['WEBSITE_BASE_URL', 'VITE_WEBSITE_BASE_URL'],
  ]

  for (const [suffix, targetKey] of mappings) {
    const processOverrideValue = readInitialDevProcessOverride(targetKey)
    if (processOverrideValue) {
      setRuntimeEnv(targetKey, processOverrideValue, 'process')
      continue
    }

    const value = scope[`${prefix}${suffix}`]
    if (value) {
      setRuntimeEnv(targetKey, value, `dev-mode:${mode}`)
    }
  }
  console.log(`[Config] 🔀 dev mode = ${mode}（已套用 ${prefix}* 预设）`)
}
applyDevModePresets(envVars)

const normalizeEnvUrl = (value: string | undefined): string | undefined =>
  value?.trim().replace(/\/+$/, '') || undefined

const isRootDefaultEnv = (key: string): boolean =>
  !envVarSources[key] || envVarSources[key] === rootEnvPath

const isLoopbackHost = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase()
  return normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]'
}

const classifyEndpointFamily = (value: string | undefined): 'local' | 'test' | 'unknown' => {
  const normalized = normalizeEnvUrl(value)
  if (!normalized) return 'unknown'
  try {
    const hostname = new URL(normalized).hostname.toLowerCase()
    if (isLoopbackHost(hostname)) return 'local'
    if (
      hostname === 'api-test.example.com' ||
      hostname === 'collab-test.example.com' ||
      hostname === 'centrifugo-test.example.com'
    ) {
      return 'test'
    }
  } catch {
    return 'unknown'
  }
  return 'unknown'
}

type DevEndpointPreset = {
  mode: 'lite' | 'docker'
  apiBaseUrl?: string
  collabWsBase?: string
  centrifugoWsUrl?: string
  publicWebBaseUrl?: string
}

function resolveDevEndpointPreset(scope: Record<string, string>, apiBaseUrl: string | undefined): DevEndpointPreset | null {
  const normalizedApiBaseUrl = normalizeEnvUrl(apiBaseUrl)
  if (!normalizedApiBaseUrl) return null

  const presets: DevEndpointPreset[] = [
    {
      mode: 'lite',
      apiBaseUrl: scope.TABTIN_LITE_API_BASE_URL,
      collabWsBase: scope.TABTIN_LITE_COLLAB_WS_BASE,
      centrifugoWsUrl: scope.TABTIN_LITE_CENTRIFUGO_WS_URL,
      publicWebBaseUrl: scope.TABTIN_LITE_PUBLIC_WEB_BASE_URL,
    },
    {
      mode: 'docker',
      apiBaseUrl: scope.TABTIN_DOCKER_API_BASE_URL,
      collabWsBase: scope.TABTIN_DOCKER_COLLAB_WS_BASE,
      centrifugoWsUrl: scope.TABTIN_DOCKER_CENTRIFUGO_WS_URL,
      publicWebBaseUrl: scope.TABTIN_DOCKER_PUBLIC_WEB_BASE_URL,
    },
  ]

  return presets.find(preset => normalizeEnvUrl(preset.apiBaseUrl) === normalizedApiBaseUrl) ?? null
}

function normalizeDevApiBaseAliases(scope: Record<string, string>): void {
  if (!isDevOnly) return

  const tabtinApiBaseUrl = normalizeEnvUrl(scope.TABTIN_API_BASE_URL)
  const viteApiBaseUrl = normalizeEnvUrl(scope.VITE_API_BASE_URL)
  if (!tabtinApiBaseUrl || !viteApiBaseUrl || tabtinApiBaseUrl === viteApiBaseUrl) return

  const tabtinIsDefault = isRootDefaultEnv('TABTIN_API_BASE_URL')
  const viteIsDefault = isRootDefaultEnv('VITE_API_BASE_URL')
  if (!tabtinIsDefault && viteIsDefault) {
    setRuntimeEnv('VITE_API_BASE_URL', tabtinApiBaseUrl, 'auto:api-alias')
    console.log(`[Config] 🔁 VITE_API_BASE_URL 自动跟随 TABTIN_API_BASE_URL: ${tabtinApiBaseUrl}`)
    return
  }
  if (tabtinIsDefault && !viteIsDefault) {
    setRuntimeEnv('TABTIN_API_BASE_URL', viteApiBaseUrl, 'auto:api-alias')
    console.log(`[Config] 🔁 TABTIN_API_BASE_URL 自动跟随 VITE_API_BASE_URL: ${viteApiBaseUrl}`)
    return
  }

  console.warn(
    `[Config] ⚠️  TABTIN_API_BASE_URL(${tabtinApiBaseUrl}) 与 ` +
    `VITE_API_BASE_URL(${viteApiBaseUrl}) 不一致；请只覆盖其中一个或保持相同。`,
  )
}

function normalizeDevPublicWebAliases(scope: Record<string, string>): void {
  if (!isDevOnly) return

  const tabtinPublicWebBaseUrl = normalizeEnvUrl(scope.TABTIN_PUBLIC_WEB_BASE_URL)
  const vitePublicWebBaseUrl = normalizeEnvUrl(scope.VITE_PUBLIC_WEB_BASE_URL)
  if (!tabtinPublicWebBaseUrl || !vitePublicWebBaseUrl || tabtinPublicWebBaseUrl === vitePublicWebBaseUrl) return

  const tabtinIsDefault = isRootDefaultEnv('TABTIN_PUBLIC_WEB_BASE_URL')
  const viteIsDefault = isRootDefaultEnv('VITE_PUBLIC_WEB_BASE_URL')
  if (!tabtinIsDefault && viteIsDefault) {
    setRuntimeEnv('VITE_PUBLIC_WEB_BASE_URL', tabtinPublicWebBaseUrl, 'auto:public-web-alias')
    console.log(`[Config] 🔁 VITE_PUBLIC_WEB_BASE_URL 自动跟随 TABTIN_PUBLIC_WEB_BASE_URL: ${tabtinPublicWebBaseUrl}`)
    return
  }
  if (tabtinIsDefault && !viteIsDefault) {
    setRuntimeEnv('TABTIN_PUBLIC_WEB_BASE_URL', vitePublicWebBaseUrl, 'auto:public-web-alias')
    console.log(`[Config] 🔁 TABTIN_PUBLIC_WEB_BASE_URL 自动跟随 VITE_PUBLIC_WEB_BASE_URL: ${vitePublicWebBaseUrl}`)
    return
  }

  console.warn(
    `[Config] ⚠️  TABTIN_PUBLIC_WEB_BASE_URL(${tabtinPublicWebBaseUrl}) 与 ` +
    `VITE_PUBLIC_WEB_BASE_URL(${vitePublicWebBaseUrl}) 不一致；请只覆盖其中一个或保持相同。`,
  )
}

function normalizeDevRealtimeEndpoints(scope: Record<string, string>): void {
  if (!isDevOnly) return

  const apiBaseUrl = normalizeEnvUrl(scope.VITE_API_BASE_URL || scope.TABTIN_API_BASE_URL)
  const preset = resolveDevEndpointPreset(scope, apiBaseUrl)
  const currentCollabWsBase = normalizeEnvUrl(scope.VITE_COLLAB_WS_BASE)
  const currentCentrifugoWsUrl = normalizeEnvUrl(scope.VITE_CENTRIFUGO_WS_URL)
  const apiFamily = classifyEndpointFamily(apiBaseUrl)
  const collabFamily = classifyEndpointFamily(currentCollabWsBase)
  const shouldReplaceDefaultCollab =
    Boolean(preset?.collabWsBase) &&
    (
      !currentCollabWsBase ||
      isRootDefaultEnv('VITE_COLLAB_WS_BASE')
    )

  if (shouldReplaceDefaultCollab && preset?.collabWsBase) {
    setRuntimeEnv('VITE_COLLAB_WS_BASE', preset.collabWsBase, `auto:${preset.mode}`)
    console.log(`[Config] 🔁 VITE_COLLAB_WS_BASE 自动跟随 ${preset.mode} API: ${preset.collabWsBase}`)
  } else if (apiFamily !== 'unknown' && collabFamily !== 'unknown' && apiFamily !== collabFamily) {
    console.warn(
      `[Config] ⚠️  API 与协作 WS 环境不一致：API=${apiBaseUrl}, ` +
      `VITE_COLLAB_WS_BASE=${currentCollabWsBase}。这会导致 TabDoc/TabData 协作鉴权失败。`,
    )
  }

  if (preset?.centrifugoWsUrl && (!currentCentrifugoWsUrl || isRootDefaultEnv('VITE_CENTRIFUGO_WS_URL'))) {
    setRuntimeEnv('VITE_CENTRIFUGO_WS_URL', preset.centrifugoWsUrl, `auto:${preset.mode}`)
    console.log(`[Config] 🔁 VITE_CENTRIFUGO_WS_URL 自动跟随 ${preset.mode} API: ${preset.centrifugoWsUrl}`)
  }

  if (preset?.publicWebBaseUrl) {
    if (!scope.VITE_PUBLIC_WEB_BASE_URL || isRootDefaultEnv('VITE_PUBLIC_WEB_BASE_URL')) {
      setRuntimeEnv('VITE_PUBLIC_WEB_BASE_URL', preset.publicWebBaseUrl, `auto:${preset.mode}`)
    }
    if (!scope.TABTIN_PUBLIC_WEB_BASE_URL || isRootDefaultEnv('TABTIN_PUBLIC_WEB_BASE_URL')) {
      setRuntimeEnv('TABTIN_PUBLIC_WEB_BASE_URL', preset.publicWebBaseUrl, `auto:${preset.mode}`)
    }
  }
}

/**
 * Daemon Control 只维护 TABTIN_* 单一配置键；Renderer 通过 Vite 映射读取。
 * 打包 profile 未显式覆盖该键时，不能把根 .env 的本机 6080 烘进安装包，
 * 应与该 profile 的 API Gateway 同源。
 */
function normalizeDaemonControlEndpoint(scope: Record<string, string>): void {
  setRuntimeEnv(
    'VITE_DAEMON_CONTROL_ENABLED',
    scope.DAEMON_CONTROL_ENABLED?.trim() === 'true' ? 'true' : 'false',
    'auto:daemon-control',
  )
  const apiBaseUrl = normalizeEnvUrl(scope.VITE_API_BASE_URL || scope.TABTIN_API_BASE_URL)
  const configuredBaseUrl = normalizeEnvUrl(scope.TABTIN_DAEMON_CONTROL_API_BASE_URL)
  const shouldUseApiGateway = !isDevOnly && isRootDefaultEnv('TABTIN_DAEMON_CONTROL_API_BASE_URL')
  const resolvedBaseUrl = shouldUseApiGateway
    ? apiBaseUrl
    : configuredBaseUrl ?? apiBaseUrl
  if (!resolvedBaseUrl) return

  setRuntimeEnv(
    'TABTIN_DAEMON_CONTROL_API_BASE_URL',
    resolvedBaseUrl,
    shouldUseApiGateway ? 'auto:api-gateway' : 'auto:daemon-control',
  )
  setRuntimeEnv(
    'VITE_DAEMON_CONTROL_API_BASE_URL',
    resolvedBaseUrl,
    shouldUseApiGateway ? 'auto:api-gateway' : 'auto:daemon-control',
  )
}

normalizeDevApiBaseAliases(envVars)
normalizeDevPublicWebAliases(envVars)
normalizeDevRealtimeEndpoints(envVars)
normalizeDaemonControlEndpoint(envVars)

/** 设为 `1` 时关闭渲染进程 Vite HMR，改代码后需手动刷新窗口（如 ⌘⇧R），避免 Agent 改文件时打断调试 */
const rendererHmrDisabled = process.env.TABTIN_DISABLE_RENDERER_HMR === '1'
if (rendererHmrDisabled) {
  console.log('[Config] TABTIN_DISABLE_RENDERER_HMR=1 → 渲染进程 HMR 已关闭（手动刷新生效）')
}

// Vite 通用解法应走 package.json `exports` conditions：
// workspace 包声明 source/development 条件，dev 在 `resolve.conditions` 里选择源码；
// 没声明条件的包继续走 package 自身默认 import/dist。
const sourceResolveConditions = (conditions: readonly string[]): string[] | undefined => isDevOnly
  ? ['source', ...conditions]
  : undefined
const sourceSsrResolve = (conditions: string[] | undefined) => conditions
  ? {
      resolve: {
        conditions,
        externalConditions: conditions,
      },
    }
  : undefined
const mainResolveConditions = sourceResolveConditions(defaultServerConditions)
const preloadResolveConditions = sourceResolveConditions(defaultServerConditions)
const rendererResolveConditions = sourceResolveConditions(defaultClientConditions)
const mainSsrResolve = sourceSsrResolve(mainResolveConditions)
const preloadSsrResolve = sourceSsrResolve(preloadResolveConditions)
const electronPackageManifest = JSON.parse(
  readFileSync(resolve(__dirname, 'package.json'), 'utf8'),
) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}
const workspaceDependencyExternalExcludes = Object.entries({
  ...electronPackageManifest.dependencies,
  ...electronPackageManifest.devDependencies,
})
  .filter(([name, version]) => name.startsWith('@tabtin/') && version.startsWith('workspace:'))
  .map(([name]) => name)
const mainDependencyExternalExcludes = [
  ...workspaceDependencyExternalExcludes,
  // mcp-remote 由 utility process 在安装包内运行。必须连同依赖闭包打进专用
  // out/main chunk，不能让终端用户额外安装 Node/npm/npx 或外部 npm 包。
  'mcp-remote',
]

// ✅ 自定义插件：复制 main 进程运行时需要按相对路径读取的资产到输出目录
function copyMainRuntimeAssetsPlugin() {
  return {
    name: 'copy-main-runtime-assets',
    writeBundle() {
      try {
        const srcPath = resolve(__dirname, 'src/main/anti-detect/fingerprint-preload.js');
        const destDir = resolve(__dirname, 'out/main/anti-detect');
        const destPath = resolve(destDir, 'fingerprint-preload.js');

        // 确保目录存在
        mkdirSync(destDir, { recursive: true });

        // 复制文件
        copyFileSync(srcPath, destPath);

        console.log('[Build] ✅ 已复制 fingerprint-preload.js 到输出目录');
      } catch (error) {
        console.error('[Build] ⚠️  复制 fingerprint-preload.js 失败:', error);
      }
      try {
        const srcPath = resolve(__dirname, '../../packages/security-policy/src/hardline-v3-rules.json');
        const destDir = resolve(__dirname, 'out/main');
        const destPath = resolve(destDir, 'hardline-v3-rules.json');

        mkdirSync(destDir, { recursive: true });
        copyFileSync(srcPath, destPath);

        console.log('[Build] ✅ 已复制 hardline-v3-rules.json 到输出目录');
      } catch (error) {
        console.error('[Build] ⚠️  复制 hardline-v3-rules.json 失败:', error);
      }
    }
  };
}

// S3-04: 生产构建时将开发 CSP 替换为严格版本
// - 移除所有 localhost/内网地址引用
// - 保留 unsafe-eval（Monaco Editor 依赖 new Function）
// - 保留 style-src unsafe-inline（CSS-in-JS 运行时注入）
// - 保留 script-src unsafe-inline（：htmlBlock/widget 的 blob/srcdoc iframe
//   继承壳 CSP；用户 HTML 的 onclick / 内联 script 需要它。Vite 壳本身不产出内联脚本）
// - object-src/base-uri/form-action 收紧，防止插件注入和 base tag 劫持
// - connect-src 白名单化：从构建环境变量推导 API/WS origin，加 OSS 通配
// - frame-src 白名单化：仅允许 self + OSS 域（TabSite iframe）
//
// 环境变量扩展点：
//   CSP_EXTRA_CONNECT_SRC — 空格分隔的额外 connect-src 域（用于自建部署）
//   CSP_EXTRA_FRAME_SRC  — 空格分隔的额外 frame-src 域
function hardenCspPlugin() {
  // 白名单推导已抽到 scripts/production-csp.ts（纯函数，可单测）——
  //  踩过的坑是 frame-src 少了公共资产域，只有真机打包才暴露。
  const PRODUCTION_CSP = buildProductionCsp(process.env, (msg) => console.warn(msg))

  return {
    name: 'harden-csp',
    transformIndexHtml: {
      order: 'post' as const,
      handler(html: string) {
        if (process.env.NODE_ENV !== 'production') return html
        const hardened = html.replace(
          /<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*"\s*\/?>/i,
          `<meta http-equiv="Content-Security-Policy" content="${PRODUCTION_CSP}" />`,
        )
        if (hardened === html) {
          throw new Error(
            '[harden-csp] CSP meta tag not found in index.html — ' +
            'the production build will ship without hardened CSP. ' +
            'Ensure index.html contains <meta http-equiv="Content-Security-Policy" ...>.',
          )
        }
        return hardened
      },
    },
  }
}

// ✅ Phase 4-B: electron-vite 只为入口 chunk（如 index.mjs）注入 CommonJS Shims；
// 拆到 main-app-*.mjs 等子 chunk 的代码仍含 `join(__dirname, ...)` / `require()`，运行时会 ReferenceError。
// 对「尚未含 import.meta.dirname」且确实用到 __dirname/require 的 chunk 补同一套 shim。
/**
 * dogfood 4d2108a2 第 7 轮 工程改进 — main 进程 typecheck gate：
 *
 * 历史背景：electron-vite 走 esbuild 编译 main，esbuild **完全不做 TS 类型
 * 检查**只做语法转换。一晚撞出 4 个同源 ReferenceError（normalizedCostLimits
 * TDZ / workspaceSnapshotV3 漏传 / yoloMode 漏解构 / agentConfigV3 缺字段），
 * 全部是 tsc 编译期能秒抓但 esbuild 一路放行进 dist 的运行时炸弹。
 *
 * 接入 vite-plugin-checker 让 tsc 在 dev 启动时跑 watch 模式校验 main 范围
 * （tsconfig.main.json 仅 include `src/main/` + `src/preload/` + `src/shared/`
 * + 必要 d.ts），任何 TS2304 / TS2339 / TS2352 类型错误立刻在 dev 终端出红
 * + Renderer 端 overlay 提示。常规 build 可以失败；Windows 打包机默认
 * 不挂 checker，避免类型债阻塞预发包产出。
 *
 * **renderer / preload 暂未启用**：当前根 tsconfig 下 renderer 还有 10+ 个
 * 历史债（bf454d821 / 7bef7e135 / 09ec99c40 / ddc002064 累积），需要专题
 * 清扫后再同模式接入（分阶段路线见 docs/agent-runtime/dogfood-debugging-handbook.md
 * §5 排障套路）。
 */
const mainTypecheckPlugin = checker({
  typescript: {
    tsconfigPath: 'tsconfig.main.json',
    buildMode: false, // dev: watch 模式增量校验；build 时由 electron-vite 自己跑 tsc
  },
  // 只在 dev / build 时启用 overlay；test 时不挂 overlay 避免干扰 vitest。
  // checker 默认在 renderer 才挂 overlay，main 是 Node 进程没 overlay 容器。
  overlay: false,
  // 不让 typecheck 失败阻塞 dev 启动 —— 错误打印到终端就行，确保用户能继续
  // 看到"启动了但 main 有 X 个类型错"，而不是被卡在启动失败让 dogfood 中断。
  // Windows packaged build 默认不因类型检查阻塞；显式 PACK_RUN_TYPECHECK=1
  // 时打包脚本会改走 pnpm build，并保留 checker。
  enableBuild: !skipPackagedBuildTypecheck,
})

/**
 * Dev-only：接收 renderer 端 TabDoc 数据流探针事件，追加写共享日志文件（JSONL）。
 * 与 tabtin-web 的 createTabDocProbeLogPlugin 完全对称 —— renderer 也是 Vite dev server，
 * 同源 POST /__tabdoc_probe 即可，无需 IPC / main / preload 改动。
 * apply:'serve' 保证只在 dev 挂载；生产构建零影响。
 */
function createTabDocProbeLogPlugin(): Plugin {
  const logPath = resolve(__dirname, '../../apps/tabtin_django/logs/tabdoc-dataflow.log')
  return {
    name: 'tabtin-electron-tabdoc-probe-log',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__tabdoc_probe', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end()
          return
        }
        const chunks: Buffer[] = []
        req.on('data', (c) => chunks.push(c as Buffer))
        req.on('end', () => {
          try {
            const events = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown[]
            const receivedAt = Date.now()
            const lines = (Array.isArray(events) ? events : [events])
              .map((e) => JSON.stringify({ receivedAt, ...(e as object) }))
              .join('\n') + '\n'
            mkdirSync(resolve(logPath, '..'), { recursive: true })
            appendFileSync(logPath, lines)
            res.statusCode = 204
            res.end()
          } catch (err) {
            res.statusCode = 400
            res.end(String(err))
          }
        })
      })
    },
  }
}

/**
 * Dev-only：接收 renderer 端 TabData 交互数据流探针事件，追加写共享日志文件（JSONL）。
 * 与 createTabDocProbeLogPlugin 完全同构 —— renderer 是 Vite dev server，
 * 同源 POST /__tabdata_probe 即可，无需 IPC / main / preload 改动。
 * apply:'serve' 保证只在 dev 挂载；生产构建零影响。
 */
function createTabDataProbeLogPlugin(): Plugin {
  const logPath = resolve(__dirname, '../../apps/tabtin_django/logs/tabdata-dataflow.log')
  return {
    name: 'tabtin-electron-tabdata-probe-log',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__tabdata_probe', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end()
          return
        }
        const chunks: Buffer[] = []
        req.on('data', (c) => chunks.push(c as Buffer))
        req.on('end', () => {
          try {
            const events = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown[]
            const receivedAt = Date.now()
            const lines = (Array.isArray(events) ? events : [events])
              .map((e) => JSON.stringify({ receivedAt, ...(e as object) }))
              .join('\n') + '\n'
            mkdirSync(resolve(logPath, '..'), { recursive: true })
            appendFileSync(logPath, lines)
            res.statusCode = 204
            res.end()
          } catch (err) {
            res.statusCode = 400
            res.end(String(err))
          }
        })
      })
    },
  }
}

const RENDERER_SRC_DIR = resolve(__dirname, 'src/renderer/src')

const PROSEMIRROR_SINGLETON_DEPS = [
  'prosemirror-model',
  'prosemirror-state',
  'prosemirror-transform',
  'prosemirror-view',
]
const requireFromElectronConfig = createRequire(resolve(__dirname, 'package.json'))
const tiptapPmNodeModules = resolve(
  dirname(requireFromElectronConfig.resolve('@tiptap/pm/view')),
  '../../../..',
)
const PROSEMIRROR_SINGLETON_ALIASES = PROSEMIRROR_SINGLETON_DEPS.map((dep) => ({
  find: dep,
  replacement: resolve(tiptapPmNodeModules, dep),
}))

// ProseMirror uses instanceof checks for DecorationSet/DecorationGroup. Keep
// the collaboration stack and @tiptap/pm on the same module instances.
const EDITOR_SINGLETON_DEPS = [
  ...PROSEMIRROR_SINGLETON_DEPS,
  'yjs',
]

export default defineConfig({
  main: {
    // Packaged main code should not ship in source-like formatting. Keep function/class
    // names in the first rollout because runtime registration and diagnostics may depend on them.
    esbuild: {
      keepNames: true,
      legalComments: 'eof',
    },
    plugins: [
      externalizeDepsPlugin({
        exclude: mainDependencyExternalExcludes,
      }),
      copyMainRuntimeAssetsPlugin(),
      ...(!skipPackagedBuildTypecheck ? [mainTypecheckPlugin] : []),
    ],
    resolve: {
      ...(mainResolveConditions ? { conditions: mainResolveConditions } : {}),
      alias: [
        { find: '@shared', replacement: resolve(__dirname, 'src/shared') },
      ]
    },
    ...(mainSsrResolve ? { ssr: mainSsrResolve } : {}),
    build: {
      minify: 'esbuild',
      // hidden sourcemap：不在 JS 中引用，仅供 Sentry 主进程堆栈符号化
      // （upload-sentry-sourcemaps.sh 上传后由打包脚本删除，不进安装包）
      sourcemap: skipPackagedBuildSourcemaps ? false : 'hidden',
      rollupOptions: {
        external: [
          '@TabTabwebbase/core',
          '@TabTabwebbase/shared',
          '@TabTabwebbase/web',
          '@tabtin/data-extraction',
          // WebSocket 相关
          'ws',
          'bufferutil',
          'utf-8-validate',
          // 其他原生模块
          'sqlite3',
          'canvas',
          // jsdom 依赖 css-tree，css-tree 会运行时读取 ../data/patch.json。
          // 打进 main bundle 后相对数据文件会失散，需保留原 node_modules 目录结构。
          'jsdom',
          // @tabtin/local-embedding（workspace 包，被打进 main bundle）懒加载
          // onnxruntime-node + @anush008/tokenizers（/#3306 语义双路召回）。
          // 两者都是 .node 原生二进制 + 运行时动态 require，打进 bundle 会在运行时报
          // "Could not dynamically require .../onnxruntime_binding.node"。
          // 保持 external + 声明为 tabtin-electron 直接依赖，运行时从 node_modules 解析。
          'onnxruntime-node',
          '@anush008/tokenizers',
        ],
        input: {
          index: 'src/main/index.ts',
          'doc-parser-worker': 'src/main/workers/doc-parser-worker.ts',
          'pty-host-process': 'src/main/terminal/pty-host-process.ts',
          'mcp-remote-host-process': 'src/main/services/mcp-remote-host-process.ts',
          // 方案 B：onnxruntime 推理子进程 entry（进程隔离，崩溃只死子进程）。
          'onnx-embed-child': 'src/main/workers/onnx-embed-child.ts',
        },
        output: {
          format: 'es',
          entryFileNames: '[name].mjs',
          chunkFileNames: '[name]-[hash].mjs',
          // ✅ 保留 .js 文件（如 fingerprint-preload.js）
          assetFileNames: (assetInfo) => {
            if (assetInfo.name?.endsWith('.js')) {
              return '[name][extname]';
            }
            return 'assets/[name]-[hash][extname]';
          }
        }
      },
      // ✅ 复制 anti-detect 目录下的所有文件
      copyPublicDir: false,
      assetsInlineLimit: 0
    }
  },
  preload: {
    // Preload is an IPC contract boundary. Minify its implementation while retaining
    // function/class names; property and channel names remain untouched by esbuild.
    esbuild: {
      keepNames: true,
      legalComments: 'eof',
    },
    // preload 编译为 CJS bundle（output.format = 'cjs'）。externalizeDepsPlugin
    // 默认把所有 dependencies externalize 走运行时 `require()`，但 `@tabtin/agent-
    // runtime` 是 ESM-only 包（"type": "module"，exports 子路径只有 "import" 条件，
    // 没有 "require"），sandbox preloadRequire 解析子路径 `agent-runtime/agent-modes`
    // 时会直接报 `module not found`。
    //
    // preload 仅有一处值导入 `AGENT_MODE_NAMES`（见 preload/index.ts，
    // 从 `@tabtin/agent-modes/types` 导入）。不能走 index barrel：会解析到
    // permission-path.ts（node:fs），sandbox preload 加载即崩。
    plugins: [
      externalizeDepsPlugin({
        exclude: ['@electron-toolkit/preload', ...workspaceDependencyExternalExcludes],
      }),
    ],
    resolve: {
      ...(preloadResolveConditions ? { conditions: preloadResolveConditions } : {}),
      alias: [
        { find: '@shared', replacement: resolve(__dirname, 'src/shared') },
        {
          find: '@tabtin/agent-modes/types',
          replacement: resolve(__dirname, '../../packages/agent-modes/dist/types.js'),
        },
      ]
    },
    ...(preloadSsrResolve ? { ssr: preloadSsrResolve } : {}),
    build: {
      minify: 'esbuild',
      // hidden sourcemap：仅供 Sentry 堆栈符号化，上传后即删（同 main 段说明）
      sourcemap: skipPackagedBuildSourcemaps ? false : 'hidden',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        }
      }
    }
  },
  renderer: {
    // Renderer has no Node-side reflection contract, so use full identifier minification.
    // Preserve legal notices at EOF; private hidden sourcemaps keep production errors diagnosable.
    esbuild: {
      legalComments: 'eof',
    },
    worker: {
      format: 'es',
    },
    // 构建时生成 hidden sourcemap（不在产物中引用，仅供错误还原上传）
    css: { devSourcemap: false },
    server: {
      port: parseInt(process.env.VITE_DEV_SERVER_PORT || '5173'),
      strictPort: true,
      // Windows 上仅 [::1] 监听时，部分工具连 127.0.0.1 会失败；显式绑定 loopback IPv4。
      host: '127.0.0.1',
      // dev server 就绪后预编译 renderer 入口，避免 Electron 窗口打开后才开始按需 transform 数千模块。
      warmup: {
        clientFiles: [
          resolve(__dirname, 'src/renderer/index.html'),
          resolve(__dirname, 'src/renderer/overlay.html'),
          resolve(__dirname, 'src/renderer/src/main.tsx'),
          resolve(__dirname, 'src/renderer/overlay/main.tsx'),
          resolve(__dirname, 'src/renderer/src/App.tsx'),
        ],
      },
      // App 平台 H1 / Wave B-B2：允许 renderer 直接 glob 扫描 packages/apps/*/tool-cards/* 等
      // marketplace App 物料；workspace root 之外路径不放行。
      fs: {
        allow: [resolve(__dirname, '../..')],
      },
      ...(rendererHmrDisabled ? { hmr: false } : {}),
    },
    resolve: {
      ...(rendererResolveConditions ? { conditions: rendererResolveConditions } : {}),
      dedupe: EDITOR_SINGLETON_DEPS,
      alias: [
        ...PROSEMIRROR_SINGLETON_ALIASES,
        { find: '@shared', replacement: resolve(__dirname, 'src/shared') },
        { find: '@', replacement: RENDERER_SRC_DIR },
        { find: '@components', replacement: resolve(__dirname, 'src/renderer/src/components') },
        // `@/stores/*` 与 `@stores/*` 必须解析到同一绝对路径，避免 Vite 拆成两套 zustand 单例
        // （登录写进一套、侧栏读另一套 → 点登录「没反应」）。
        {
          find: /^@\/stores\/(.*)/,
          replacement: `${resolve(__dirname, 'src/renderer/src/stores')}/$1`,
        },
        { find: '@stores', replacement: resolve(__dirname, 'src/renderer/src/stores') },
        { find: '@services', replacement: resolve(__dirname, 'src/renderer/src/services') },
        { find: '@hooks', replacement: resolve(__dirname, 'src/renderer/src/hooks') },
        { find: '@utils', replacement: resolve(__dirname, 'src/renderer/src/utils') },
        { find: '@types', replacement: resolve(__dirname, 'src/renderer/src/types') },
        { find: '@styles', replacement: resolve(__dirname, 'src/renderer/src/styles') },
        {
          find: '@tabtin/smartsheet-ui/toast',
          replacement: resolve(__dirname, 'src/renderer/src/shims/smartsheet-ui-toast.ts'),
        },
        {
          find: '@tabtin/smartsheet-ui/message',
          replacement: resolve(__dirname, 'src/renderer/src/shims/smartsheet-ui-toast.ts'),
        },
        {
          find: '@tabtin/smartsheet-ui/toast-native',
          replacement: resolve(__dirname, '../../packages/smartsheet-ui/src/toast.ts'),
        },
        {
          find: '@tabtin/smartsheet-ui/message-native',
          replacement: resolve(__dirname, '../../packages/smartsheet-ui/src/message.ts'),
        },
        // ：包根与 /toast|/message shim 必须同实例。
        // 先匹配 /toast|/message|/toast-native|/styles，再把包根钉到 entry。
        {
          find: '@tabtin/smartsheet-ui-core',
          replacement: resolve(__dirname, '../../packages/smartsheet-ui/src/index.ts'),
        },
        {
          find: /^@tabtin\/smartsheet-ui$/,
          replacement: resolve(__dirname, 'src/renderer/src/shims/smartsheet-ui-entry.ts'),
        },
        // App 平台 H1 / Wave B-B2：marketplace App 物料根目录别名，给 import.meta.glob 跨包扫描提供入口
        { find: '@apps-marketplace', replacement: resolve(__dirname, '../../packages/apps') },
        // App 平台 H1 / Wave B-B2：marketplace App 物料 (packages/apps/<id>/) 不是独立 npm 包，
        // pnpm 下其内部 import '@tabtin/chat-client' 无法通过 node_modules 解析；显式 alias 兜底。
        { find: /^@tabtin\/chat-client$/, replacement: resolve(__dirname, '../../packages/tabtin-chat-client/src/index.ts') },
        { find: /^@tabtin\/app-shell$/, replacement: resolve(__dirname, '../../packages/app-shell/src/index.ts') },
        { find: /^@tabtin\/smartsheet-ui\/styles$/, replacement: resolve(__dirname, '../../packages/smartsheet-ui/dist/smartsheet-ui.css') },
        { find: '@tabtin/tabdoc-ui/editor/prosemirror.css', replacement: resolve(__dirname, '../../packages/tabdoc-ui/src/editor/prosemirror.css') },
        { find: 'util', replacement: resolve(__dirname, 'src/renderer/src/shims/util-browser.js') },
      ]
    },
    // 🔧 Force Vite to pre-bundle CJS deps upfront.
    // Lazy-loaded modules (tabslide, tabdoc, etc.) import CJS packages that Vite's
    // startup scanner can't discover. Without explicit inclusion, Vite discovers
    // them at runtime and forces a full page reload.
    optimizeDeps: {
      entries: [
        resolve(__dirname, 'src/renderer/index.html'),
        resolve(__dirname, 'src/renderer/overlay.html'),
        resolve(__dirname, 'src/renderer/src/main.tsx'),
        resolve(__dirname, 'src/renderer/overlay/main.tsx'),
      ],
      exclude: [
        '@tiptap/pm',
        ...PROSEMIRROR_SINGLETON_DEPS,
        'yoga-layout',
      ],
      include: [
        // Only packages resolvable from tabtin-electron's node_modules.
        // Transitive deps from workspace packages need explicit devDependencies.
        'dompurify',
        'react-markdown',
        'rehype-sanitize',
        'remark-gfm',
        '@tiptap/extension-text-style',
        '@tiptap/extension-color',
        '@tiptap/extension-highlight',
        '@tiptap/extension-link',
        '@tiptap/extension-table',
        '@tiptap/extension-table-cell',
        '@tiptap/extension-table-header',
        '@tiptap/extension-table-row',
        '@tiptap/extension-task-item',
        '@tiptap/extension-task-list',
        '@tiptap/extension-collaboration',
        '@tiptap/extension-collaboration-cursor',
        'tiptap-markdown',
        '@radix-ui/react-separator',
        'class-variance-authority',
        // tabslide
        'echarts',
        'echarts-for-react',
        'html2canvas-pro',
        'jspdf',
        'jszip',
        'pptxgenjs',
        'react-moveable',
        'react-virtuoso',
        '@tiptap/extension-font-family',
        '@tiptap/extension-subscript',
        '@tiptap/extension-superscript',
        '@tiptap/extension-text-align',
        '@tiptap/extension-underline',
        '@tiptap/extension-bold',
        '@tiptap/extension-bullet-list',
        '@tiptap/extension-code',
        '@tiptap/extension-italic',
        '@tiptap/extension-ordered-list',
        '@tiptap/extension-strike',
        // @tiptap/pm 无根路径 "." export，仅子路径（./model、./state 等），预构建会报错，由其他 tiptap 包按需解析子路径即可
        '@radix-ui/react-scroll-area',
        '@radix-ui/react-hover-card',
      ],
      esbuildOptions: {
        // Ensure esbuild also resolves `util` to our shim during pre-bundling
        alias: {
          'util': resolve(__dirname, 'src/renderer/src/shims/util-browser.js'),
        },
      },
    },
    publicDir: resolve(__dirname, 'static'),
    plugins: [hardenCspPlugin(), react(), copyPdfjsAssetsPlugin(), copyProviderIconAssetsPlugin(), createTabDocProbeLogPlugin(), createTabDataProbeLogPlugin()],
    build: {
      minify: 'esbuild',
      // 生成 hidden sourcemap（.map 文件存在但 JS 中不含 //# sourceMappingURL）
      sourcemap: skipPackagedBuildSourcemaps ? false : 'hidden',
      // Electron renderer 会内置 Monaco 等重资源，
      // 默认 500kB 阈值会持续告警，这里提升为 25MB 以减少噪声。
      chunkSizeWarningLimit: 25000,
      // macOS 26 + Spotlight 索引 publicDir 里上千个 file-icons 时，vite 自己的
      // emptyDir 会偶发 ENOTEMPTY。改由 build-packaged-app.sh 在 step 1 之前
      // 手动 rm -rf out（更可控、加 sync + sleep），vite 不再尝试清空。
      emptyOutDir: false,
      rollupOptions: {
        onwarn(warning, warn) {
          const message = warning.message || ''
          const isBrowserExternalizedNoise = message.includes('has been externalized for browser compatibility')
          const isInvalidPureAnnotationNoise = message.includes('contains an annotation that Rollup cannot interpret')
          if (isBrowserExternalizedNoise || isInvalidPureAnnotationNoise) {
            return
          }
          warn(warning)
        },
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          overlay: resolve(__dirname, 'src/renderer/overlay.html'),
        },
        external: [
          '@TabTabwebbase/core',
          '@TabTabwebbase/shared',
          '@TabTabwebbase/web',
          '@tabtin/data-extraction',
          '@tabtin/security-policy',
        ],
        output: {
          manualChunks(id) {
            // 避免 Vite 的 preload helper 被落进 vendor-monaco，
            // 否则大量无关 chunk 会因为 __vitePreload 反向依赖 monaco。
            if (id.includes('vite/preload-helper')) return 'vendor-runtime'
            if (id.includes('monaco-editor')) return 'vendor-monaco'
            if (id.includes('@xterm')) return 'vendor-xterm'
            if (
              id.includes('highlight.js') ||
              id.includes('rehype-highlight') ||
              id.includes('node_modules/lowlight')
            )
              return 'vendor-highlight'
            if (id.includes('node_modules/lodash/'))
              return 'vendor-lodash'
            if (id.includes('@glideapps/glide-data-grid'))
              return 'vendor-glide-grid'
            if (
              id.includes('react-markdown') ||
              id.includes('remark-gfm') ||
              id.includes('remark-parse') ||
              id.includes('node_modules/unified') ||
              id.includes('node_modules/mdast') ||
              id.includes('node_modules/micromark') ||
              id.includes('node_modules/hast')
            )
              return 'vendor-markdown'
            if (/node_modules\/d3-[^/]+/.test(id))
              return 'vendor-d3'
            if (
              id.includes('node_modules/react/') ||
              id.includes('node_modules/react-dom/') ||
              id.includes('node_modules/scheduler/')
            )
              return 'vendor-react'
            if (id.includes('framer-motion') || id.includes('node_modules/motion'))
              return 'vendor-motion'
            if (id.includes('lucide-react')) return 'vendor-icons'
            if (id.includes('@teable/ui-lib')) return 'vendor-teable-ui'
            if (id.includes('@teable/core') || id.includes('@teable/icons'))
              return 'vendor-teable-core'
            if (id.includes('@teable/')) return 'vendor-teable-misc'
            if (id.includes('@dnd-kit')) return 'vendor-dnd'
            if (
              id.includes('node_modules/clsx') ||
              id.includes('class-variance-authority') ||
              id.includes('tailwind-merge') ||
              id.includes('node_modules/prop-types/')
            )
              return 'vendor-utils'
            if (
              id.includes('@radix-ui') ||
              id.includes('node_modules/cmdk') ||
              id.includes('node_modules/novel') ||
              id.includes('@tiptap/') ||
              id.includes('tiptap-markdown') ||
              id.includes('prosemirror')
            )
              return 'vendor-editor'
            if (
              id.includes('node_modules/yjs') ||
              id.includes('@hocuspocus/')
            )
              return 'vendor-collab'
            if (id.includes('react-pdf') || id.includes('pdfjs-dist'))
              return 'vendor-pdf'
            if (id.includes('node_modules/i18next') || id.includes('react-i18next'))
              return 'vendor-i18n'
          }
        }
      }
    }
  }
})
