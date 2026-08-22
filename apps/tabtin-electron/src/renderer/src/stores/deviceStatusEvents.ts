/**
 * 设备状态消息事件总线
 *
 * 解决 useDeviceStore → useChatStore 的循环依赖。
 * useDeviceStore 在设备上/下线时 emit 系统消息内容，
 * useChatStore 订阅后向当前对话注入 role:system 消息。
 *
 * 零 store 依赖，任何模块可安全导入。
 */

type DeviceStatusMessageListener = (content: string) => void

const listeners = new Set<DeviceStatusMessageListener>()

export function onDeviceStatusMessage(listener: DeviceStatusMessageListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function emitDeviceStatusMessage(content: string): void {
  listeners.forEach(fn => {
    try { fn(content) } catch { /* 防止单个 listener 异常阻塞其他 */ }
  })
}
