import type { ViewMeta, ViewStore } from '@tabtin/table-core'

type ViewCreatePayload = Parameters<ViewStore['createView']>[0]
type ViewCreator = (payload: ViewCreatePayload) => Promise<ViewMeta | null>

/**
 * 协作运行时已经负责 REST 创建，失败时必须把失败直接交给 UI。
 * 自动再走一次 REST 会把“响应丢失”放大成两个服务端视图。
 */
export function selectViewCreator(
  runtimeCreator: ViewCreator | null,
  restCreator: ViewCreator,
): ViewCreator {
  return runtimeCreator ?? restCreator
}
