/**
 * 视频管线路由 — 委托给 @tabtin/media-capabilities 共享实现。
 *
 * 保持原有导出签名不变，daemon.ts 无需任何改动。
 */

import {
  createVideoHandler,
  type EventPublisher,
} from '@tabtin/media-capabilities/routes';
import { djangoRequest } from '../shared/error-handler.js';

const instance = createVideoHandler({ djangoRequest });

export const handleVideoRoute = instance.handler;

export function getActiveVideoTaskCount(): number {
  return instance.getActiveTaskCount();
}

/**
 * 注入 WS 事件发布器，由 daemon.ts 在 CLI Server 启动后调用。
 */
export function initVideoRouteWs(publish: EventPublisher): void {
  instance.setPublishEvent(publish);
}

/**
 * 优雅关闭：标记所有进行中任务为失败 + 发送 WS 通知。
 * 由 daemon 的 SIGTERM/SIGINT handler 调用。
 */
export function shutdownVideoTasks(): void {
  instance.shutdown();
}
