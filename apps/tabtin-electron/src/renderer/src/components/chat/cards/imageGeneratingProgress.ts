/**
 * 对话生图假进度：ease-out 指数逼近，封顶 92%；工具终态再冲到 100%。
 * 不接 Seedream stream——前端体感进度，非真实推理百分比。
 *
 * 返回连续浮点（不 round），供 rAF / scaleX 每帧平滑推进。
 */

export const DEFAULT_IMAGE_GENERATING_TAU_MS = 18_000

export function computeImageGeneratingProgress(params: {
  elapsedMs: number
  tauMs?: number
  done: boolean
}): number {
  if (params.done) return 100
  const tauMs = params.tauMs ?? DEFAULT_IMAGE_GENERATING_TAU_MS
  if (!(tauMs > 0) || !(params.elapsedMs >= 0)) {
    return 0
  }
  const raw = 100 * (1 - Math.exp(-params.elapsedMs / tauMs))
  return Math.min(92, raw)
}
