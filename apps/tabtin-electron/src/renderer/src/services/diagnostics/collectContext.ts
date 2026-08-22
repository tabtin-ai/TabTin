/**
 * 诊断包运行上下文（meta.json）收集
 *
 * 汇集研发定位问题最需要的环境信息：版本 / 发布通道 / 系统 / 设备 /
 * 当前 organization·space·agent / 登录用户（脱敏）。
 *
 * 全程防御式读取——任一 store / API 不可用（典型如崩溃兜底页里 store 已损坏）
 * 都不能让导出失败。store 结果按 any 读取，避免 store 类型演进时诊断收集编译失败。
 */

import { BUILD_PROFILE } from '@/utils/featureFlags'
import { getClientContextSnapshot } from '@/services/errorReporter'
// 静态 import 安全：sentry.ts 顶层不加载 SDK chunk（SDK 是动态 import）
import { getRecentSentryEventIds, isSentryEnabled } from '@/services/sentry'
import {
  useOrganizationStore,
  useSpaceStore,
  useSpaceListStore,
  parseSpaceSelectionId,
} from '@tabtin/app-shell'
import { useAuthStore } from '@/stores/useAuthStore'
import type { Space } from '@tabtin/app-shell'

import type { DiagnosticsHostEnv } from '../../../../shared/diagnostics-types'

export interface DiagnosticsMeta {
  generatedAt: string
  reason: string
  profile: string
  appVersion: string
  electronVersion: string
  /**
   * 构建期注入的 git 短 SHA。空字符串 = 未注入（极少非 git 目录构建）。
   * 用于判断安装包是否含某次修复：`git merge-base --is-ancestor <fix> <gitCommit>`。
   */
  gitCommit: string
  /** 构建期分支名；detached HEAD 时为空字符串。 */
  gitBranch: string
  os: { name: string; version: string; arch: string; locale: string }
  /**
   * 主进程采集的主机硬件 / 运行时架构（Intel vs ARM / Rosetta 等）。
   * 导出诊断包时经 IPC 填充；不可用则为 null。
   */
  host: DiagnosticsHostEnv | null
  session: { sessionId: string; deviceId: string }
  context: {
    organizationId: string | null
    organizationName: string | null
    spaceId: string | null
    spaceName: string | null
    agentId: string | null
    agentName: string | null
  }
  user: {
    id: string | null
    nickname: string | null
    username: string | null
    /** 手机号中间四位打码，不落明文 PII */
    phoneMasked: string | null
  }
  sentry: {
    /** 渲染进程 Sentry 是否启用 */
    enabled: boolean
    /** 最近上报的 event_id（新在前）——与 Sentry 事件互认的 join 线索 */
    recentEventIds: string[]
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

function maskPhone(phone: unknown): string | null {
  if (typeof phone !== 'string' || phone.length < 7) return null
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`
}

/** 从任意对象安全读一个字符串字段，拿不到返回 null（防御 store 结构变化）。 */
function readStr(obj: unknown, key: string): string | null {
  if (obj && typeof obj === 'object') {
    const v = (obj as Record<string, unknown>)[key]
    if (typeof v === 'string' && v) return v
  }
  return null
}

/**
 * 设置页 / IM 等导航会清空 useSpaceStore.selectedSpace，但 Space 列表选择仍保留。
 * 导出 meta 时优先 live 选中，再回退到列表选择与 spaces 缓存。
 * （export 供 services/sentry.ts 的 context provider 复用同一回退逻辑）
 */
export function resolveDiagnosticsSpace(): Space | null {
  const spaceState = useSpaceStore.getState()
  if (spaceState.selectedSpace) return spaceState.selectedSpace

  const listState = useSpaceListStore.getState()
  const organizationId = useOrganizationStore.getState().selectedOrganization?.id ?? null
  const remembered = organizationId ? listState.selectionByOrganization[organizationId] : null
  const selectionId = listState.selectedSpaceId ?? remembered?.selectedSpaceId ?? null
  const selectionKind = listState.selectedSpaceKind ?? remembered?.selectedSpaceKind ?? null

  if (!selectionId || selectionKind !== 'workspace') return null
  try {
    const { rawId } = parseSpaceSelectionId(selectionId)
    return spaceState.spaces.find((space) => space.id === rawId) ?? null
  } catch {
    return null
  }
}

export function resolveDiagnosticsAgent(_space: Space | null): unknown {
  //  / ：身份在 selectedAgent，现场不再投影 agent_id
  return useSpaceStore.getState().selectedAgent
}

export function collectDiagnosticsMeta(
  reason: string,
  host: DiagnosticsHostEnv | null = null,
): DiagnosticsMeta {
  const client = safe(() => getClientContextSnapshot(), null as ReturnType<typeof getClientContextSnapshot> | null)
  const platform = safe(() => window.tabtin?.getPlatform?.() ?? '', '')
  const arch = safe(() => window.tabtin?.getArch?.() ?? '', '')

  // store 结果按 unknown 读取 + readStr 守卫（防御：字段缺失只拿到 null，
  // 不因 store 类型演进而让诊断收集编译失败）
  const wt = safe<unknown>(() => useOrganizationStore.getState().selectedOrganization, null)
  const sp = safe<unknown>(() => resolveDiagnosticsSpace(), null)
  const ag = safe<unknown>(() => resolveDiagnosticsAgent(sp as Space | null), null)
  const user = safe<unknown>(() => useAuthStore.getState().user, null)

  // 必须精确写 import.meta.env.VITE_GIT_*（与 VITE_APP_VERSION 同理），否则 esbuild 不替换。
  const gitCommit = import.meta.env.VITE_GIT_COMMIT || ''
  const gitBranch = import.meta.env.VITE_GIT_BRANCH || ''

  return {
    generatedAt: new Date().toISOString(),
    reason,
    profile: BUILD_PROFILE,
    appVersion: client?.app_version || safe(() => (import.meta.env.VITE_APP_VERSION as string) || '', ''),
    electronVersion: client?.electron_version || '',
    gitCommit,
    gitBranch,
    os: {
      name: client?.os_name || platform,
      version: client?.os_version || '',
      arch: client?.arch || arch,
      locale: client?.locale || safe(() => navigator.language, '') || '',
    },
    host,
    session: {
      sessionId: client?.session_id || '',
      deviceId: client?.device_id || '',
    },
    context: {
      organizationId: readStr(wt, 'id'),
      organizationName: readStr(wt, 'name'),
      spaceId: readStr(sp, 'id'),
      spaceName: readStr(sp, 'name'),
      // ：只认 selectedAgent，不回落工作空间.agent_id（恒 null）
      agentId: readStr(ag, 'id'),
      agentName: readStr(ag, 'name'),
    },
    user: {
      id: readStr(user, 'id'),
      nickname: readStr(user, 'nickname'),
      username: readStr(user, 'username'),
      phoneMasked: maskPhone(readStr(user, 'phone')),
    },
    sentry: {
      enabled: safe(() => isSentryEnabled(), false),
      recentEventIds: safe(() => getRecentSentryEventIds(), []),
    },
  }
}
