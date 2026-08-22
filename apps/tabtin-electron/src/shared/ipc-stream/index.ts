/**
 * IpcStream 抽象层 barrel —— 主进程↔Renderer 流式 IPC 的唯一正确写法。
 *
 * **invariant**：流的终止信号必须在流自己的"最后一帧"里。不能用 RPC reply
 * （`ipcMain.handle` return）/ 传输层 close / 外部 channel 当作流终态信号。
 *
 * 详见 `support/electron/ipc-stream-invariant.md` 架构准则文档。
 */

export type {
  IpcStreamEnvelope,
  IpcStreamTerminal,
  IpcStreamTerminalReason,
  IpcStreamControl,
} from './types'
export { isTerminalEnvelope, isHeartbeatEnvelope, isControlEnvelope } from './types'

export { IpcStreamHost, type IpcStreamSender, type IpcStreamHostOptions } from './host'

export {
  openIpcStream,
  IpcStreamStallError,
  IpcStreamRemoteError,
  IpcStreamAbortedError,
  type IpcStream,
  type OpenIpcStreamOptions,
} from './client'
