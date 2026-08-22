/**
 * IpcStream 协议 — 主进程↔Renderer 流式 IPC 的唯一正确写法。
 *
 * 解决 Electron 双 channel race：`ipcMain.handle` 的 RPC reply 和 `webContents.send`
 * 的事件流走两条独立 channel，没有顺序保证。Renderer 用 invoke return 当流终态信号
 * 会漏收"最后一帧之后的事件"——dogfood session 81f13c08 lifecycle.end / done 事件
 * 主进程已发，Renderer 漏收，导致 streamingBySessionId 永不清。
 *
 * **invariant**：流的终止信号必须在流自己的"最后一帧"里。不能用 RPC reply / 传输层
 * close / 外部 channel 当作流终态信号。
 *
 * 设计要点：把完成哨兵放在与业务帧同一条保序队列/流的末尾（而不是靠另一条
 * RPC reply 或传输层 close），避免双通道乱序漏收终态。
 *
 * TabTin 实现：业务事件 + sentinel 帧走同一 channel，envelope 保序，Renderer 用
 * AsyncIterator 消费——业务终态、sentinel、心跳 watchdog 三层退出条件，杜绝任何
 * "流式完成"歧义。
 */

/**
 * Sentinel 帧的关闭原因。
 *
 * - `completed`：主进程业务正常结束（`for await` 的 generator 跑完）
 * - `errored`：主进程业务抛异常（catch 路径 emit）
 * - `aborted`：主进程主动中止（譬如用户取消 / sender 销毁前 best-effort 发出）
 */
export type IpcStreamTerminalReason = 'completed' | 'errored' | 'aborted'

export interface IpcStreamTerminal {
  reason: IpcStreamTerminalReason
  /** error 详情；reason='errored' 通常存在；其他 reason 不带。 */
  error?: string
}

/**
 * 带内控制帧类型（主进程 → Renderer，）。
 *
 * - `seq-gap`：主进程 `ConversationStreamRouter` 在纯 WS 观察流上检测到 per-thread
 *   `_seq` 缺口（跳号 / 中途接入），通知 Renderer 安排一次「从服务端补拉」。
 *   检测收口主进程（IPC 与 WS 两路 `_seq` 序列不可比，只有主进程持有的纯 WS 路径
 *   可判）；Renderer 只保留补拉执行侧（`scheduleSeqGapSync` + busy defer）。
 */
export type IpcStreamControl = 'seq-gap'

/**
 * 数据平面 envelope —— 主进程通过 `webContents.send(channel, env)` 推到 Renderer。
 * 业务事件 + sentinel + 控制帧走同一 channel，由 Chromium IPC 保序。
 *
 * 对外消费形态：Renderer `for await (event of stream)` 只看业务 `T`，看不到
 * envelope 包装；sentinel / 控制帧由消费方内部消化（驱动 iterator 退出 / 触发补拉）。
 */
export type IpcStreamEnvelope<T> =
  | { sessionId: string; event: T; terminal?: undefined; heartbeat?: undefined; control?: undefined }
  | { sessionId: string; terminal: IpcStreamTerminal; event?: undefined; heartbeat?: undefined; control?: undefined }
  | { sessionId: string; heartbeat: true; event?: undefined; terminal?: undefined; control?: undefined }
  | { sessionId: string; control: IpcStreamControl; event?: undefined; terminal?: undefined; heartbeat?: undefined }

export function isTerminalEnvelope<T>(
  env: IpcStreamEnvelope<T>,
): env is { sessionId: string; terminal: IpcStreamTerminal; event?: undefined; heartbeat?: undefined; control?: undefined } {
  return env.terminal !== undefined
}

export function isHeartbeatEnvelope<T>(env: IpcStreamEnvelope<T>): boolean {
  return env.heartbeat === true
}

export function isControlEnvelope<T>(
  env: IpcStreamEnvelope<T>,
): env is { sessionId: string; control: IpcStreamControl; event?: undefined; terminal?: undefined; heartbeat?: undefined } {
  return env.control !== undefined
}
