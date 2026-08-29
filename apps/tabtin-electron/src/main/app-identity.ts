import { is } from '@electron-toolkit/utils'
import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type TabTinRuntimeProfile = 'development' | 'local' | 'community' | 'preprod' | 'production'

export interface TabTinAppIdentity {
  profile: TabTinRuntimeProfile
  appId: string
  productName: string
  userDataDirName: string
}

const PROFILE_IDENTITIES: Record<TabTinRuntimeProfile, TabTinAppIdentity> = {
  development: {
    profile: 'development',
    appId: 'com.tabtin.app.dev',
    productName: 'TabTin Dev',
    userDataDirName: 'TabTin Dev',
  },
  local: {
    profile: 'local',
    appId: 'com.tabtin.app.local',
    productName: 'TabTin Local',
    userDataDirName: 'TabTin Local',
  },
  community: {
    profile: 'community',
    appId: 'com.tabtin.community',
    productName: 'TabTin Community',
    userDataDirName: 'TabTin Community',
  },
  preprod: {
    profile: 'preprod',
    appId: 'com.tabtin.app.preprod',
    // Electron safeStorage derives its macOS Keychain service from app.getName().
    // Keep this distinct from production and aligned with the packaged app name.
    productName: 'TabTin Preprod',
    userDataDirName: 'TabTin Preprod',
  },
  production: {
    profile: 'production',
    appId: 'com.tabtin.app',
    productName: 'TabTin',
    userDataDirName: 'TabTin',
  },
}

function normalizeProfile(value: string | undefined): TabTinRuntimeProfile | undefined {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return undefined
  if (normalized === 'dev' || normalized === 'development') return 'development'
  if (normalized === 'local' || normalized === 'localdev') return 'local'
  if (normalized === 'community') return 'community'
  if (normalized === 'preprod' || normalized === 'preproduction') return 'preprod'
  if (normalized === 'prod' || normalized === 'production') return 'production'
  return undefined
}

function inferProfileFromText(value: string | undefined): TabTinRuntimeProfile | undefined {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return undefined
  if (normalized.includes('preprod')) return 'preprod'
  if (normalized.includes('community')) return 'community'
  if (normalized.includes('com.tabtin.app.local')) return 'local'
  if (/(^|[^a-z0-9])tabtin[^a-z0-9]+local([^a-z0-9]|$)/.test(normalized)) return 'local'
  return undefined
}

function getAppPathSafely(name: Parameters<typeof app.getPath>[0]): string {
  try {
    return app.getPath(name)
  } catch {
    return ''
  }
}

function resolvePackagedRuntimeProfileFromMetadata(): TabTinRuntimeProfile | undefined {
  try {
    const packageJsonPath = join(app.getAppPath(), 'package.json')
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
      tabtinDesktop?: { buildProfile?: string }
      build?: { extraMetadata?: { tabtinDesktop?: { buildProfile?: string } } }
    }
    return normalizeProfile(
      pkg.build?.extraMetadata?.tabtinDesktop?.buildProfile ??
        pkg.tabtinDesktop?.buildProfile,
    )
  } catch {
    return undefined
  }
}

export function resolvePackagedRuntimeProfileFromHost(): TabTinRuntimeProfile | undefined {
  const markers = [
    (() => {
      try {
        return app.getName()
      } catch {
        return ''
      }
    })(),
    process.resourcesPath,
    process.execPath,
    getAppPathSafely('exe'),
  ]

  for (const marker of markers) {
    const profile = inferProfileFromText(marker)
    if (profile) return profile
  }
  return undefined
}

export function resolveRuntimeProfile(): TabTinRuntimeProfile {
  const explicitProfile =
    normalizeProfile(process.env.TABTIN_RUNTIME_PROFILE) ??
    normalizeProfile(process.env.VITE_BUILD_PROFILE) ??
    normalizeProfile(process.env.TABTIN_BUILD_PROFILE)

  if (explicitProfile) {
    return explicitProfile
  }

  if (!app.isPackaged) {
    return 'development'
  }

  const packagedMetadataProfile = resolvePackagedRuntimeProfileFromMetadata()
  if (packagedMetadataProfile) {
    return packagedMetadataProfile
  }

  const packagedProfile = resolvePackagedRuntimeProfileFromHost()
  if (packagedProfile) {
    return packagedProfile
  }

  return 'production'
}

/**
 * 主进程统一的开发语义判断。
 *
 * local 安装包必须保留 Electron 的 packaged 语义，同时获得与开发启动
 * 一致的主进程能力；preprod / production 仍保持正式包语义。
 */
export function resolveIsDevRuntime(): boolean {
  return is.dev || !app.isPackaged || resolveRuntimeProfile() === 'local'
}

export function resolveRuntimeAppIdentity(): TabTinAppIdentity {
  return PROFILE_IDENTITIES[resolveRuntimeProfile()]
}

/**
 * 用户可见的默认 Workspace 顶层目录名。
 *
 * Workspace 的 working_dir 是用户本机的外部执行现场，不能跟着 userData
 * 藏进 Application Support；但不同安装档也不能再共用同一个 `~/TabTin`。
 * 正式版保持历史目录不动，其它档位按产品名分根，方便发现也避免互写。
 */
export function resolveDefaultWorkspaceDirectoryName(
  profile = resolveRuntimeProfile(),
): string {
  return PROFILE_IDENTITIES[profile].productName
}

export function resolveDevInstanceId(): string | undefined {
  if (app.isPackaged) return undefined

  const instanceId = process.env.TABTIN_DEV_INSTANCE?.trim().toLowerCase()
  if (!instanceId) return undefined
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(instanceId)) {
    throw new Error('TABTIN_DEV_INSTANCE 只能包含小写字母、数字和连字符，最长 32 位')
  }
  return instanceId
}

export function applyRuntimeAppIdentity(): TabTinAppIdentity {
  const identity = resolveRuntimeAppIdentity()
  const instanceId = resolveDevInstanceId()
  const productName = instanceId ? `${identity.productName} (${instanceId})` : identity.productName
  const userDataDirName = instanceId ? `${identity.userDataDirName}-${instanceId}` : identity.userDataDirName

  app.setName(productName)

  const appDataPath = app.getPath('appData')
  const profileRoot = join(appDataPath, userDataDirName)
  app.setPath('userData', profileRoot)

  // Keep managed/index data and execution-control state profile-scoped while
  // preserving the domain contract that Workspace.working_dir is external
  // and must never be derived from either root.
  if (app.isPackaged || !process.env.TABTIN_DATA_ROOT) {
    process.env.TABTIN_DATA_ROOT = profileRoot
  }
  if (app.isPackaged || !process.env.TABTIN_RUNTIME_ROOT) {
    process.env.TABTIN_RUNTIME_ROOT = join(profileRoot, 'runtime')
  }
  if (app.isPackaged || !process.env.TABTIN_CONFIG_DIR) {
    process.env.TABTIN_CONFIG_DIR = process.env.TABTIN_RUNTIME_ROOT
  }

  process.env.TABTIN_RUNTIME_PROFILE = identity.profile
  process.env.TABTIN_APP_ID = identity.appId
  process.env.TABTIN_APP_PRODUCT_NAME = productName

  return identity
}

/** Electron 在 app-identity 上线（6b8153cc8，2026-06-11）之前取 package.json name 作为 userData 目录名的历史形态。 */
const LEGACY_DEFAULT_USER_DATA_DIR_NAME = 'tabtin-electron'

/**
 * 所有已知的 userData 目录名：各 profile 的目录 + Electron 历史默认目录名。
 *
 * 设备身份已改为硬件锚定（`deviceFingerprint.ts`，）：有机标识时不再跨目录继承。
 * 本列表仍供清缓存探测、诊断等场景枚举同机历史目录；production 无硬件时仍可从
 * `tabtin-electron` 继承随机指纹作为回退。
 */
export function getKnownUserDataDirNames(): string[] {
  const profileDirs = Object.values(PROFILE_IDENTITIES).map((identity) => identity.userDataDirName)
  return [...profileDirs, LEGACY_DEFAULT_USER_DATA_DIR_NAME]
}
