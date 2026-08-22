/**
 * useCurrentDeviceId — 拿到「当前这台 Electron 设备」对应的后端 Device.id
 *
 * 设计动机：
 *   设置 → 设备管理域里没有「当前 Agent / Space」上下文。这里的面板
 *   （SSH 服务器、本地 MCP 等）要管理的是「**这台机器**」自身的资源，
 *   而不是某个 Agent 绑定的远端设备。所以设备身份不能像 SSHPanel 旧实现那样
 *   从 `selectedAgent.control_device_id` 推导，而应直接取「当前 Electron 设备」。
 *
 * 数据来源链路：
 *   utils/deviceId.ts 生成/持久化本机 fingerprint（electron-{uuid}，与 Main 进程对齐）
 *     → useDeviceStore.registerCurrentDevice(organizationId) 请求 AgentHost 幂等注册
 *       （后端 Device.fingerprint 唯一 → 一条 Device 记录）
 *         → 注册成功后 useDeviceStore.currentDevice 被填充
 *           → 本 hook 读 currentDevice，对外暴露 deviceId / device / 加载态 / retry。
 *
 * 前置条件（重要）：
 *   注册由 `onOrganizationSelected` 在「选中团队」时自动触发（见 useDeviceStore 末尾）。
 *   也就是说 **必须先有一个选中的 organization**，注册才会发生。正常登录流程下这一步
 *   总会发生；但若调用方在「尚无选中团队」的窗口期挂载本 hook，注册可能从未触发。
 *
 * 永久 loading 边界：
 *   「注册从未触发」的纯初始态（registered=false 且不在 loading 且无 error 且无设备）
 *   下，朴素地把它算作「加载中」会导致 isLoading 永远为 true。为避免这种永久 loading，
 *   本 hook 加了 5s 超时兜底：超时后 isLoading 转为 false，调用方可展示「无当前设备」空态
 *   并提供「重试」入口。调用方应优先用返回的 `retry()` 重新触发注册，而不是自己造轮子。
 *
 * retry()：
 *   读取当前选中的 organizationId（useOrganizationStore.selectedOrganization），重新触发
 *   useDeviceStore.registerCurrentDevice。注册会清掉上一次的 error、重置加载态。
 *   若当前没有选中团队（无法注册），retry 不做任何事、保持当前空态。
 *
 * 复用性：返回结构（deviceId / device / isLoading / retry）刻意做成与具体业务无关，
 *   设备域任何「按当前设备管理资源」的面板都可直接复用（不耦合 SSH / MCP）。
 *
 * 未来扩展「切换设备」：当前固定返回当前 Electron 设备。等多设备管理上线后，
 *   可在此读取一个「设备域选中设备」store，或给 hook 加一个可选 deviceId 入参覆盖
 *   默认值；只要保持返回结构不变，所有调用方无需改动。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useDeviceStore } from '@stores/useDeviceStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import type { Device } from '@tabtin/app-shell'

/** 「注册从未触发」纯初始态的永久 loading 兜底超时（毫秒）。 */
const REGISTER_TIMEOUT_MS = 5000

export interface CurrentDeviceResult {
  /** 当前设备的后端 Device.id；尚未解析到时为 null */
  deviceId: string | null
  /** 当前设备完整对象（用于展示名称等）；尚未解析到时为 null */
  device: Device | null
  /**
   * 设备身份仍在解析中（注册 / 拉取未完成且尚未失败）。
   * 调用方据此区分「加载中」与「确实没有当前设备」两种空态。
   * 注意：「注册从未触发」的纯初始态最多保持 loading REGISTER_TIMEOUT_MS，
   * 超时后转为 false，避免永久 loading（见文件头注释）。
   */
  isLoading: boolean
  /**
   * 重新触发当前设备注册（清 error、重置加载态）。
   * 用于「无当前设备」空态下的「重试」入口。无选中团队时为 no-op。
   */
  retry: () => void
}

export function useCurrentDeviceId(): CurrentDeviceResult {
  const device = useDeviceStore((s) => s.currentDevice)
  const registered = useDeviceStore((s) => s.registered)
  const storeLoading = useDeviceStore((s) => s.isLoading)
  const error = useDeviceStore((s) => s.error)

  // 超时兜底标记：仅在「注册从未触发」纯初始态卡满 REGISTER_TIMEOUT_MS 后置 true。
  const [timedOut, setTimedOut] = useState(false)

  const deviceId = device?.id ?? null

  // 「注册从未触发」纯初始态：没拿到设备、没出错、不在 loading、也从未注册过。
  const isUntriggeredInitial = deviceId == null && !error && !storeLoading && !registered

  const retry = useCallback(() => {
    const organizationId = useOrganizationStore.getState().selectedOrganization?.id
    // 无选中团队 → 无法注册：保持当前空态（含 timedOut），让调用方继续展示空态提示。
    if (!organizationId) return
    setTimedOut(false)
    void useDeviceStore.getState().registerCurrentDevice(organizationId).catch(() => {})
  }, [])

  // 处于纯初始态时起 5s 计时；一旦离开该态（开始 loading / 拿到设备 / 出错），
  // 清掉计时并复位 timedOut。
  useEffect(() => {
    if (!isUntriggeredInitial) {
      setTimedOut(false)
      return
    }
    const timer = setTimeout(() => setTimedOut(true), REGISTER_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [isUntriggeredInitial])

  return useMemo<CurrentDeviceResult>(() => {
    // 已拿到设备 → 不再视为加载中。
    // 没拿到设备时：注册/拉取进行中（storeLoading），或尚未注册过且无错误
    //   （!registered && !error，覆盖应用启动后到注册完成之间的窗口，避免空态闪现）
    //   → 视为加载中。
    // 注册失败（error）或注册完成却仍无设备 → 加载结束，由调用方展示「无当前设备」空态。
    // 超时兜底（timedOut）：纯初始态卡满超时后强制结束 loading，避免永久 loading。
    const baseLoading = deviceId == null && !error && (storeLoading || !registered)
    const isLoading = baseLoading && !timedOut
    return { deviceId, device: device ?? null, isLoading, retry }
  }, [device, deviceId, registered, storeLoading, error, timedOut, retry])
}
