/**
 * 导入身份解析（Layer D）——run 的 options 需要 targetOrganizationId / agentId /
 * deviceId 三元组（impl-spec §2.1）。本 hook 集中回答「导到哪个组织、谁来当执行
 * Agent、哪台设备」，并提供「外部 cwd 是否命中已有 Workspace」的比对（PRD §4.2
 * 每行标『→ 导入到已有 Workspace「X」/ 将新建』）。
 *
 * 取值口径：
 *   - **targetOrganizationId**：当前选中组织，回退个人组织 / 列表首个。
 *   - **agentId**：组织默认 Agent（小Tin）。沿用会话/现场既有口径
 *     `space.execution_agent_id ?? space.agent_id`（services/localArtifactActions.ts
 *     同款），从目标组织下任一工作空间取；再回退当前选中身份 selectedAgent。
 *   - **deviceId**：当前 Electron 设备 `currentDevice.id`（与 CreateSpace 创建
 *     Workspace 同源，NewSpaceButton.tsx）。
 */

import { useCallback, useMemo } from 'react'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useDeviceStore } from '@stores/useDeviceStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import {
  getCachedOrganizationAgents,
  listOrganizationAgents,
} from '@/services/organizationAgentsApi'

/** 词法归一：去尾部分隔符、折叠重复斜杠。renderer 侧做不到 realpath，仅用于
 *  UI 提示「会合流到已有工作空间」；服务端仍以 canonical + 最长前缀为准。 */
function lexicalNormalize(p: string): string {
  if (!p) return ''
  return p.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
}

export interface ExistingWorkspaceMatch {
  /** 命中的已有工作空间名字；null = 将新建。 */
  name: string | null
  /** exact = 精确同目录；prefix = 外部 cwd 是已有工作空间的子目录（归并）。 */
  kind: 'exact' | 'prefix' | 'new'
}

export interface ImportIdentity {
  deviceId: string | null
  /** 组织下拉选项（历史兼容，导入默认用当前选中组织）。 */
  organizations: Array<{ id: string; name: string; type: 'personal' | 'team' }>
  /** 无当前选中组织时的回退目标（个人组织优先）。 */
  defaultOrganizationId: string | null
  organizationName: (orgId: string | null) => string
  isTeamOrganization: (orgId: string | null) => boolean
  /** 解析某组织的默认执行 Agent（小Tin）。 */
  resolveAgentId: (orgId: string | null) => string | null
  /** 确保目标组织的工作空间列表已加载（供 Agent 解析 + 已有工作空间比对）。 */
  ensureSpacesLoaded: (orgId: string | null) => Promise<void>
  /** 外部 cwd 命中哪个已有工作空间（限定在目标组织内比对）。 */
  matchExistingWorkspace: (cwd: string, orgId: string | null) => ExistingWorkspaceMatch
}

export function useImportIdentity(): ImportIdentity {
  const organizationsRaw = useOrganizationStore((s) => s.organizations)
  const selectedOrganization = useOrganizationStore((s) => s.selectedOrganization)
  const currentDevice = useDeviceStore((s) => s.currentDevice)
  // spaces 订阅进 hook：加载完成后自动触发比对刷新。
  const spaces = useSpaceStore((s) => s.spaces)

  const organizations = useMemo(
    () =>
      (organizationsRaw ?? []).map((o) => ({
        id: o.id,
        name: o.name,
        type: (o.type === 'team' ? 'team' : 'personal') as 'personal' | 'team',
      })),
    [organizationsRaw],
  )

  const defaultOrganizationId = useMemo(() => {
    const personal = organizations.find((o) => o.type === 'personal')
    return personal?.id ?? selectedOrganization?.id ?? organizations[0]?.id ?? null
  }, [organizations, selectedOrganization])

  const organizationName = useCallback(
    (orgId: string | null) => organizations.find((o) => o.id === orgId)?.name ?? '',
    [organizations],
  )

  const isTeamOrganization = useCallback(
    (orgId: string | null) => organizations.find((o) => o.id === orgId)?.type === 'team',
    [organizations],
  )

  const resolveAgentId = useCallback(
    (orgId: string | null) => {
      // 组织默认 Agent（小Tin）优先——不依赖工作空间，兜住「刚注册、零工作空间」
      // 的 onboarding 目标用户（此前从工作空间反推 agent 会把入口交给 onboarding
      // 尚未产生的产物）。缓存由 ensureSpacesLoaded 预热。
      if (orgId) {
        const orgAgents = getCachedOrganizationAgents(orgId)
        if (orgAgents && orgAgents.length > 0) {
          const preferred = orgAgents.find((a) => a.is_default) ?? orgAgents[0]
          if (preferred?.id) return preferred.id
        }
      }
      // 回退：工作空间承载的执行 Agent（缓存未就绪时的快路径）。
      const all = useSpaceStore.getState().spaces
      const inOrg = orgId ? all.filter((s) => s.organization_id === orgId) : all
      for (const s of inOrg) {
        const agentId = s.execution_agent_id ?? s.agent_id
        if (agentId) return agentId
      }
      return useSpaceStore.getState().selectedAgent?.id ?? null
    },
    [],
  )

  const ensureSpacesLoaded = useCallback(async (orgId: string | null) => {
    if (!orgId) return
    // 并行预热：工作空间列表（比对用）+ 组织 Agent 列表（resolveAgentId 用）。
    await Promise.allSettled([
      useSpaceStore.getState().loadSpaces(orgId),
      listOrganizationAgents(orgId),
    ])
  }, [])

  // 预归一：spaces 变化时才重算一次 {orgId, name, normWd}，避免比对时对每个 cwd
  // 逐条重跑正则（性能项：内容树 67 个 workspace × 每渲染各调一次 matchWorkspace）。
  const normalizedSpaces = useMemo(
    () =>
      spaces
        .map((s) => ({
          orgId: s.organization_id,
          name: s.name,
          normWd: lexicalNormalize(s.normalized_working_dir ?? s.working_dir ?? ''),
        }))
        .filter((s) => s.normWd),
    [spaces],
  )

  const matchExistingWorkspace = useCallback(
    (cwd: string, orgId: string | null): ExistingWorkspaceMatch => {
      const target = lexicalNormalize(cwd)
      if (!target) return { name: null, kind: 'new' }
      const inOrg = orgId ? normalizedSpaces.filter((s) => s.orgId === orgId) : normalizedSpaces
      // 精确优先。
      for (const s of inOrg) {
        if (s.normWd === target) return { name: s.name, kind: 'exact' }
      }
      // 最长前缀归并：外部 cwd 是某已有工作空间的子目录。
      let best: { name: string; len: number } | null = null
      for (const s of inOrg) {
        if (target.startsWith(s.normWd + '/') && (!best || s.normWd.length > best.len)) {
          best = { name: s.name, len: s.normWd.length }
        }
      }
      if (best) return { name: best.name, kind: 'prefix' }
      return { name: null, kind: 'new' }
    },
    [normalizedSpaces],
  )

  // 稳定引用：否则调用方（向导）里依赖 identity 的 useCallback/useMemo 每渲染失效。
  return useMemo(
    () => ({
      deviceId: currentDevice?.id ?? null,
      organizations,
      defaultOrganizationId,
      organizationName,
      isTeamOrganization,
      resolveAgentId,
      ensureSpacesLoaded,
      matchExistingWorkspace,
    }),
    [
      currentDevice?.id,
      organizations,
      defaultOrganizationId,
      organizationName,
      isTeamOrganization,
      resolveAgentId,
      ensureSpacesLoaded,
      matchExistingWorkspace,
    ],
  )
}
