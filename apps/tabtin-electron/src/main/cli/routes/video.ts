/**
 * 视频管线路由 — Electron 端。
 *
 * 委托给 @tabtin/media-capabilities 共享实现，
 * 使 Electron 也能响应云端 `tabtin media` 视频生成管线。
 */

import {
  createVideoHandler,
  type EventPublisher,
  type VideoHandlerDeps,
} from '@tabtin/media-capabilities/routes'
import { djangoRequest } from './shared/error-handler.js'

const videoDeps: VideoHandlerDeps = { djangoRequest }
const instance = createVideoHandler(videoDeps)

export const handleVideoRoute = instance.handler

/**
 * 注入 WS 事件发布器。
 *
 * TODO: Electron 端 WS 推送机制与 Daemon 不同（Daemon 通过 DaemonGatewayClient，
 * Electron 通过 renderer IPC），需要在 Electron 主进程中实现事件桥接后再接入。
 * 当前仅暴露接口，由 cli-server.ts 在合适时机调用。
 */
export function initVideoRouteWs(publish: EventPublisher): void {
  instance.setPublishEvent(publish)
}

/**
 * 优雅关闭：标记所有进行中任务为失败。
 * 由 stopCLIServer() 在关闭时调用。
 */
export function shutdownVideoTasks(): void {
  instance.shutdown()
}
