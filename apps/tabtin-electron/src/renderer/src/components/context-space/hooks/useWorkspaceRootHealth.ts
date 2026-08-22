/**
 * useWorkspaceRootHealth — Space 级「执行根（Agent working_dir）可达性」探针（RT-3）
 *
 * RT-2 在底层把「工作目录消失」从误导性的 `spawn /bin/zsh ENOENT` 收敛成结构化的
 * `cwd_not_found`（见 `docs/overview/ai-issues-overview.md`）——但那是**跑命令时**才
 * 被动触发。RT-3 让用户**一进 Space 就主动**知道执行根没了：本 hook 复用
 * `OrchestrationSection` 同款的 `fs.pathExists` 探测 + `useIsAgentControlDevice` 门控，
 * 把结果抽成可在 Space 顶部横幅（`WorkspaceRootBanner`）消费的状态。
 *
 * **护栏（单根契约 + 透明）**：本 hook 只读探测，绝不替用户换根；恢复（换目录）只能
 * 由用户在 UI 显式 reselect（横幅按钮 → `working-dir` 设置面板）。
 *
 * 状态语义：
 *   - `idle`        非 control_device / 未设 working_dir / fs 探针不可用 → 不该报警
 *   - `checking`    正在探测（横幅在此态保持静默，避免闪现）
 *   - `ok`          working_dir 存在且是目录
 *   - `unreachable` working_dir 找不到或不是目录（被删/移走/改名，或外置盘未挂载）
 */
import { useCallback, useEffect, useState } from 'react'
import { useDeviceStore } from '@stores/useDeviceStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { isCurrentDeviceControl } from '@/services/deviceControlMatch'

export type WorkspaceRootHealthStatus = 'idle' | 'checking' | 'ok' | 'unreachable'

export interface WorkspaceRootHealth {
  status: WorkspaceRootHealthStatus
  /** 当前 Space 绑定 Agent 的 working_dir（可能为空）。 */
  workingDir: string
  /** 手动重探（覆盖 OS 缓存 / 外置盘短暂掉线场景）。 */
  retry: () => void
}

export function useWorkspaceRootHealth(spaceId: string | null): WorkspaceRootHealth {
  const space = useSpaceStore((state) =>
    spaceId ? state.spaces.find((p) => p.id === spaceId) ?? null : null,
  )
  const isWorkspace = space?.type === 'workspace'
  // Space 是执行根 SSOT；Agent 只是兼容/惰性执行身份。
  const agent = useSpaceStore((state) => {
    if (!isWorkspace) return null
    const agentId = space?.execution_agent_id ?? space?.agent_id ?? null
    if (!agentId) return null
    return state.agentCache[agentId] ?? (state.selectedAgent?.id === agentId ? state.selectedAgent : null)
  })
  const currentDevice = useDeviceStore((state) => state.currentDevice ?? null)
  const devices = useDeviceStore((state) => state.devices ?? [])
  const controlDeviceId =
    space?.control_device_id
    ?? space?.bound_device_id
    ?? agent?.control_device_id
    ?? agent?.bound_device_id
    ?? null
  const isControl = isCurrentDeviceControl(controlDeviceId, currentDevice, devices)
  const workingDir = space?.working_dir || agent?.working_dir || ''

  const [status, setStatus] = useState<WorkspaceRootHealthStatus>('idle')
  // 强制重探的 nonce（retry 时 ++）——不直接依赖 workingDir，是为了能在同一路径上
  // 手动重试（外置盘挂回 / OS 缓存刷新）。
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    // 只有「当前就是 control_device」+「设了 working_dir」时才做本地 fs 探测；
    // 遥控器模式 / 未设目录都不该报警（路径在远端或本就没设）。
    if (!isControl || !workingDir) {
      setStatus('idle')
      return
    }
    setStatus('checking')
    let cancelled = false
    const fs = window.tabtin?.fileSystem
    if (!fs?.pathExists) {
      setStatus('idle')
      return
    }
    void fs
      .pathExists(workingDir)
      .then((result) => {
        if (cancelled) return
        setStatus(result?.exists && result?.isDirectory ? 'ok' : 'unreachable')
      })
      .catch(() => {
        if (cancelled) return
        setStatus('unreachable')
      })
    return () => {
      cancelled = true
    }
  }, [isControl, workingDir, nonce])

  const retry = useCallback(() => setNonce((n) => n + 1), [])

  return { status, workingDir, retry }
}
