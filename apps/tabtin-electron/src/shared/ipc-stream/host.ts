/**
 * IpcStreamHost —— 主进程侧的 IpcStream 入口。
 *
 * 用法：
 *   const stream = new IpcStreamHost<MyEvent>(sender, 'my:channel', sessionId)
 *   try {
 *     for await (const event of generator) {
 *       if (sender.isDestroyed()) break
 *       stream.emit(event)
 *     }
 *     stream.close('completed')
 *   } catch (err) {
 *     stream.fail(err as Error)
 *   }
 *
 * 关键约束（与 Renderer client 协议一致）：
 *   1. 业务事件按 emit 顺序通过 `webContents.send` 发出，Chromium IPC 保序
 *   2. 流结束时**必须**显式调 `close()` 或 `fail()` —— 这一帧是 Renderer 兜底
 *      退出 iterator 的传输层 sentinel
 *   3. 重复 close / fail / emit-after-close 是 no-op，不会重复发帧
 *   4. sender 销毁后所有方法都是 no-op（不抛错），调用方 `for await` 循环里
 *      的 `if (sender.isDestroyed()) break` 仍是必要的（避免无谓 emit）
 */

import type { IpcStreamEnvelope } from './types'

/** 主进程对 sender 的最小依赖（剥离 Electron WebContents 完整接口，便于测试 mock）。 */
export interface IpcStreamSender {
  send(channel: string, ...args: unknown[]): void
  isDestroyed(): boolean
}

export interface IpcStreamHostOptions {
  /**
   * 自动心跳间隔（ms）。设为 >0 后 host 会定期向 Renderer 发心跳 envelope，
   * 让 client 侧 watchdog 在 LLM TTFT 较长时不会误判为 stall。
   *
   * 推荐值：watchdog 超时的一半（默认 watchdog 30s → 心跳 15s）。
   * 设为 0 或不传则不启用。
   */
  heartbeatIntervalMs?: number
}

export class IpcStreamHost<T> {
  private _closed = false
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly sender: IpcStreamSender,
    private readonly channel: string,
    private readonly sessionId: string,
    options?: IpcStreamHostOptions,
  ) {
    const interval = options?.heartbeatIntervalMs
    if (interval && interval > 0) {
      this._heartbeatTimer = setInterval(() => {
        if (this._closed || this.sender.isDestroyed()) {
          this.stopHeartbeat()
          return
        }
        const envelope: IpcStreamEnvelope<T> = { sessionId: this.sessionId, heartbeat: true }
        this.sender.send(this.channel, envelope)
      }, interval)
    }
  }

  private stopHeartbeat(): void {
    if (this._heartbeatTimer !== null) {
      clearInterval(this._heartbeatTimer)
      this._heartbeatTimer = null
    }
  }

  /** 是否已发送 sentinel 帧（close / fail 之后为 true）。 */
  get isClosed(): boolean {
    return this._closed
  }

  /**
   * 推一个业务事件。
   *
   * - sender 已销毁：no-op
   * - 已 close / fail：no-op（保持 sentinel 是流的最后一帧不变性）
   */
  emit(event: T): void {
    if (this._closed) return
    if (this.sender.isDestroyed()) return
    const envelope: IpcStreamEnvelope<T> = { sessionId: this.sessionId, event }
    this.sender.send(this.channel, envelope)
  }

  /**
   * 显式发 sentinel 帧 —— 流的"最后一帧"，Renderer iterator 据此关闭。
   *
   * @param reason 默认 `'completed'`；用户主动取消等场景可传 `'aborted'`。
   *               `'errored'` 应通过 `fail()` 传，带错误详情。
   */
  close(reason: 'completed' | 'aborted' = 'completed'): void {
    if (this._closed) return
    this._closed = true
    this.stopHeartbeat()
    if (this.sender.isDestroyed()) return
    const envelope: IpcStreamEnvelope<T> = {
      sessionId: this.sessionId,
      terminal: { reason },
    }
    this.sender.send(this.channel, envelope)
  }

  /**
   * 异常路径 sentinel —— 流因错误终止时调用。
   *
   * Renderer iterator 收到此帧后，其 `next()` Promise 会 reject 一个
   * `IpcStreamRemoteError`，调用方在 `catch` 里能拿到 message。
   */
  fail(error: Error | string): void {
    if (this._closed) return
    this._closed = true
    this.stopHeartbeat()
    if (this.sender.isDestroyed()) return
    const message = error instanceof Error ? error.message : String(error)
    const envelope: IpcStreamEnvelope<T> = {
      sessionId: this.sessionId,
      terminal: { reason: 'errored', error: message },
    }
    this.sender.send(this.channel, envelope)
  }
}
