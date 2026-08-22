/**
 * useIsAgentControlDevice — 判断当前 Electron 客户端是不是 Agent 的 control_device
 *
 * PRD §11（遥控器模式）：Agent 绑定到一台 control_device 上跑，working_dir 是该 device
 * 上的路径。当前客户端 device 跟 Agent.control_device 不一致时，当前客户端是"遥控器"：
 *   - 不能本地 fs 操作 working_dir（路径在远端，本机不一定存在 / 路径形态不同）
 *   - 不能本地起终端（终端应该起在 control_device 上，待后续 wave 加远程 PTY）
 *   - 不能改 Agent 的 working_dir / type（避免覆盖远端真实路径）
 *
 * 本 hook 返回：
 *   - `isControl`: true 表示当前 device 就是 Agent 的 control_device，本地直接操作即可
 *   - `controlDeviceId`: Agent 绑定的 control_device id（即使当前客户端不是 control 也能拿到）
 *   - `controlDeviceName`: 用于展示"Agent 在 [家里 Mac] 上工作"
 *   - `currentDeviceId`: 当前 Electron 客户端的 device id
 *   - `isResolving`: device store 还没拿到 currentDevice 时为 true，UI 应短暂等待避免闪现
 *
 * 当 Agent 没设 control_device（rare：刚创建 + 设备绑定失败）时也按"非 control"处理 —
 * 此时一切操作都该走遥控器路径，等用户绑设备后才解锁本地操作。
 */
import { useMemo } from 'react'
import { useDeviceStore } from '@stores/useDeviceStore'
import type { Agent } from '@tabtin/app-shell'
import { isCurrentDeviceControl } from '@/services/deviceControlMatch'

export interface AgentControlDeviceResult {
  isControl: boolean
  controlDeviceId: string | null
  controlDeviceName: string | null
  currentDeviceId: string | null
  isResolving: boolean
}

export function useIsAgentControlDevice(agent: Agent | null): AgentControlDeviceResult {
  const devices = useDeviceStore((s) => s.devices)
  const currentDevice = useDeviceStore((s) => s.currentDevice)
  const currentDeviceId = currentDevice?.id ?? null

  return useMemo<AgentControlDeviceResult>(() => {
    const controlDeviceId = agent?.control_device_id ?? null
    const currentDevice = currentDeviceId
      ? (devices ?? []).find((d) => d.id === currentDeviceId)
      : null
    const controlDevice = controlDeviceId
      ? (devices ?? []).find((d) => d.id === controlDeviceId)
      : null

    // device store 还在加载：currentDevice 是 null 但用户已登录且应该有 device
    const isResolving = currentDevice == null

    const isControl =
      !isResolving &&
      isCurrentDeviceControl(controlDeviceId, currentDevice, devices ?? [])

    return {
      isControl,
      controlDeviceId,
      controlDeviceName: controlDevice?.name ?? null,
      currentDeviceId,
      isResolving,
    }
  }, [agent?.control_device_id, currentDeviceId, devices])
}
