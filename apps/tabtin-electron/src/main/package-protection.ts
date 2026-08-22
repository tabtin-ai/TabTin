export type ProtectedRuntimeProfile = 'development' | 'local' | 'preprod' | 'production'

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null || value === '') return defaultValue
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return defaultValue
}

export function normalizeProtectedRuntimeProfile(value: string | undefined): ProtectedRuntimeProfile | undefined {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return undefined
  if (normalized === 'dev' || normalized === 'development') return 'development'
  if (normalized === 'local' || normalized === 'localdev') return 'local'
  if (normalized === 'preprod' || normalized === 'preproduction') return 'preprod'
  if (normalized === 'prod' || normalized === 'production') return 'production'
  return undefined
}

export function resolveProtectedRuntimeProfile(
  env: NodeJS.ProcessEnv = process.env,
): ProtectedRuntimeProfile {
  return (
    normalizeProtectedRuntimeProfile(env.TABTIN_RUNTIME_PROFILE) ??
    normalizeProtectedRuntimeProfile(env.TABTIN_BUILD_PROFILE) ??
    normalizeProtectedRuntimeProfile(env.VITE_BUILD_PROFILE) ??
    (env.NODE_ENV === 'development' ? 'development' : 'production')
  )
}

export function shouldAllowMainDevTools(options: {
  isDev: boolean
  env?: NodeJS.ProcessEnv
}): boolean {
  const env = options.env ?? process.env
  if (env.TABTIN_ALLOW_MAIN_DEVTOOLS != null) {
    return parseBoolean(env.TABTIN_ALLOW_MAIN_DEVTOOLS, false)
  }

  const profile = resolveProtectedRuntimeProfile(env)
  // 预发包是面向测试的受控分发渠道，允许通过 View → Toggle Developer Tools
  // 直接取证；production 仍默认关闭，只有显式环境变量才能开启。
  return options.isDev || profile === 'development' || profile === 'local' || profile === 'preprod'
}

export function shouldAllowBrowserDevTools(options: {
  isDev?: boolean
  env?: NodeJS.ProcessEnv
} = {}): boolean {
  const env = options.env ?? process.env
  if (env.TABTIN_ALLOW_BROWSER_DEVTOOLS != null) {
    return parseBoolean(env.TABTIN_ALLOW_BROWSER_DEVTOOLS, false)
  }

  const profile = resolveProtectedRuntimeProfile(env)
  return options.isDev === true || profile === 'development' || profile === 'local'
}
