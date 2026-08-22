/**
 * 媒体生成路由 — 委托给 @tabtin/media-capabilities 共享实现。
 *
 * 认证通过 daemon 的 djangoRequest（设备凭证模式）注入。
 */

import { createMediaHandler } from '@tabtin/media-capabilities/routes';
import { djangoRequest } from '../shared/error-handler.js';

export const handleMediaRoute = createMediaHandler({ djangoRequest });
