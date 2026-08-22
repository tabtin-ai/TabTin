/**
 * useIsRemoteViewer —— 按 spaceId 判断「当前客户端是不是这个 Agent 的遥控器」
 *
 * 这是各执行设备型 App（终端/浏览器/手机/Agent 目录…）遥控器占位 gate 的**唯一判定源**。
 * 在 useIsAgentControlDevice 之上做两件事：① 按 spaceId 解析出对应 Agent；② 把「是否该拦截」
 * 收敛成一个严格三态,避免各 gate 各写一套、在自愈窗口误伤本机。
 *
 * ⚠️ `isRemoteViewer` 不等于 `!isControl`。必须严格三态（与 orchestration 的判定对齐）：
 *   ① `isResolving`（device store 还在加载 currentDevice）→ 既非 control 也非 remote,
 *      调用方应短暂显示骨架/加载,**不要闪 banner**。
 *   ② `controlDeviceId` 为 null（刚建 Agent、 自愈正在把本机绑成 control 的窗口,或从未
 *      绑过设备）→ `isRemoteViewer=false`,**绝不拦**,把决定权交回 orchestration 的自愈逻辑,
 *      否则本该正常使用的本机会被占位墙误伤。
 *   ③ `controlDeviceId` 存在且 ≠ 当前设备 → 真·遥控器,`isRemoteViewer=true`,gate 出 banner。
 *
 * 非 workspace（普通协作 Space）没有「遥控器」概念,一律返回 `isRemoteViewer=false`。
 */
import { useMemo } from 'react'
import { useDeviceStore } from '@stores/useDeviceStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { isCurrentDeviceControl } from '@/services/deviceControlMatch'

export interface RemoteViewerResult {
  /** 真·遥控器：当前设备 ≠ Agent.control_device 且 control_device 已绑定。仅此态拦截执行设备型 App。 */
  isRemoteViewer: boolean
  /** device store / agent 仍在解析,调用方应短暂显示骨架而非 banner,避免闪现。 */
  isResolving: boolean
  /** Agent 绑定的 control_device 名称,用于 banner 文案「Agent 在「xxx」上工作」。 */
  controlDeviceName: string | null
  controlDeviceId: string | null
  /** Agent 目录路径（仅展示用,遥控器本机不一定存在此路径,别当真实路径消费）。 */
  workingDir: string | null
}

const NOT_REMOTE: RemoteViewerResult = {
  isRemoteViewer: false,
  isResolving: false,
  controlDeviceName: null,
  controlDeviceId: null,
  workingDir: null,
}

export function useIsRemoteViewer(spaceId: string | null | undefined): RemoteViewerResult {
  const space = useSpaceStore((s) => {
    if (!spaceId) return null
    return s.spaces.find((p) => p.id === spaceId)
      ?? (s.selectedSpace?.id === spaceId ? s.selectedSpace : null)
  })
  const selectedAgent = useSpaceStore((s) => s.selectedAgent)
  const agentCache = useSpaceStore((s) => s.agentCache)
  const devices = useDeviceStore((s) => s.devices)
  const currentDevice = useDeviceStore((s) => s.currentDevice)
  const currentDeviceId = currentDevice?.id ?? null

  const isWorkspace = space?.type === 'workspace'
  const agent = useMemo(() => {
    if (!isWorkspace) return null
    const agentId = space?.execution_agent_id ?? space?.agent_id ?? null
    if (!agentId) return null
    return agentCache[agentId] ?? (selectedAgent?.id === agentId ? selectedAgent : null)
  }, [isWorkspace, space?.execution_agent_id, space?.agent_id, agentCache, selectedAgent])

  return useMemo<RemoteViewerResult>(() => {
    // 非 workspace：没有遥控器概念,从不拦截。
    if (!isWorkspace) return NOT_REMOTE

    const controlDeviceId =
      space?.control_device_id
      ?? space?.bound_device_id
      ?? agent?.control_device_id
      ?? agent?.bound_device_id
      ?? null
    const controlDevice = controlDeviceId
      ? (devices ?? []).find((device) => device.id === controlDeviceId)
      : null
    const isResolving = !currentDeviceId
    const isControl =
      !isResolving &&
      isCurrentDeviceControl(controlDeviceId, currentDevice, devices ?? [])

    // 三态收敛：isResolving / 无 control_device 自愈窗口 / 本机 control → 一律不拦（isRemoteViewer=false）；
    // 仅「control_device 已绑定且 ≠ 当前设备」才是真·遥控器。
    const isRemoteViewer =
      !isResolving && !isControl && !!controlDeviceId && controlDeviceId !== currentDeviceId

    return {
      isRemoteViewer,
      isResolving,
      controlDeviceName: controlDevice?.name ?? null,
      controlDeviceId,
      workingDir: space?.working_dir || agent?.working_dir || null,
    }
  }, [
    isWorkspace,
    space?.control_device_id,
    space?.bound_device_id,
    space?.working_dir,
    agent?.control_device_id,
    agent?.bound_device_id,
    agent?.working_dir,
    currentDevice,
    currentDeviceId,
    devices,
  ])
}
