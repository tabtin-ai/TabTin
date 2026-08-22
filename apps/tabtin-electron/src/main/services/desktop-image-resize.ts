/**
 * TabDesktop · 截图尺寸对齐云端 vision tokenizer 网格（Wave 3 · D2）。
 *
 * 规范出处：`docs/planning/tabdesktop-spec-v1.md` § 4.5.1 / § 10 Q6。
 *
 * 要解决什么：
 *   Claude / GPT-4o 等 vision 模型在接收超尺寸图像时会做服务端二次缩放，
 *   并按自己的 token 网格（28 px/tile × 1568 tokens）对齐。TabDesktop 原先
 *   用单一 `maxDim` 长边约束算出的截图尺寸，常落在"需要服务端再缩一次"的
 *   区间（例如 MBP 16" AR 1568×1014 = 56×37 = 2072 tokens > 1568 预算，
 *   会被服务端缩到 1372×887）——模型实际看到的尺寸 ≠
 *   `ScreenshotResult.width/height`，`toScreenCoords` 反算坐标就会系统性
 *   偏移 ~14%。
 *
 *   本模块的 `targetImageSize(w, h, params)` 把单参数 `maxDim` 升级为
 *   "长边 ≤ maxTargetPx 且 ⌈w/px⌉×⌈h/px⌉ ≤ maxTargetTokens"的**双约束
 *   二分搜索**，保证 TabDesktop 送出去的每一张截图都落在云端 transcoder
 *   的"早退出"路径里，尺寸与模型所见逐像素一致。
 *
 * 开关：
 *   - `tabdesktop.imageResize.enabled`（app.json 配置，默认 true）
 *   - 关闭 → `DesktopExecutorService.screenshot` 回退到 Wave 2 的
 *     `maxDim` 单参数路径（见 `screenshot` 的调用点）
 *
 * 坐标系影响：
 *   `scaleFactor = outputWidth / logicalDisplayWidth` 的定义不变——本模块
 *   只改变 `outputWidth` 的求法，下游 `toScreenCoords` 逻辑完全不变。
 */

import { DesktopError, DesktopErrorCode } from './desktop-error-codes'

/**
 * 算法参数。三个字段都参数化以便未来云端模型改变 token 预算时可以无代码
 * 改动升级（改 app.json 或调用处传参即可）。
 */
export interface ImageResizeParams {
  /** 每个 vision token 覆盖的像素数（正方形 tile 边长）。claude / GPT-4o 为 28。 */
  pxPerToken: number
  /** 长边像素上限（硬约束之一）。 */
  maxTargetPx: number
  /** token 总数上限（硬约束之二，⌈w/px⌉ × ⌈h/px⌉）。 */
  maxTargetTokens: number
}

/**
 * 默认参数：对齐云端 vision transcoder 常量。**不要**随意改这些值——改动
 * 等于把 TabDesktop 送出的截图踢出"早退出"路径，云端会再缩一次，坐标
 * 漂移 10%+。若云端真的改了 tokenizer，此处 + 规范 § 4.5.1 + app.json
 * 默认值三处必须同步。
 */
export const DEFAULT_IMAGE_RESIZE_PARAMS: ImageResizeParams = {
  pxPerToken: 28,
  maxTargetPx: 1568,
  maxTargetTokens: 1568,
}

/**
 * `⌈px / pxPerToken⌉`——算一维上需要多少个 token。
 *
 * 等价于 `Math.ceil(px / pxPerToken)`，但写成 `floor((px - 1) / n) + 1`
 * 的形式可以避免浮点 ceil 在边界上的脆性（例如 `ceil(28 / 28) === 1`
 * 而非误差导致的 2）。这个技巧来自 Rust 原版 `resize.rs:74-76` 的
 * 整数除法；JS 的 `Math.floor` 等价。
 */
export function nTokensForPx(px: number, pxPerToken: number): number {
  if (pxPerToken <= 0) {
    throw new DesktopError(
      DesktopErrorCode.VALIDATION_ERROR,
      `imageResize 参数非法：pxPerToken 必须 > 0，当前值 ${pxPerToken}。` +
      `本次截图缩放未执行，session 其他状态不受影响。` +
      `请检查 app.json 中 tabdesktop.imageResize.pxPerToken，或移除自定义值回到默认 28。`,
    )
  }
  if (px <= 0) return 0
  return Math.floor((px - 1) / pxPerToken) + 1
}

/**
 * 计算一张 w×h 图在 pxPerToken 网格下占用的 token 总数——等于
 * `⌈w/px⌉ × ⌈h/px⌉`。
 */
function nTokensForImg(width: number, height: number, pxPerToken: number): number {
  return nTokensForPx(width, pxPerToken) * nTokensForPx(height, pxPerToken)
}

/**
 * 计算满足 vision tokenizer 双约束的最大图像尺寸，保持宽高比不变。
 *
 * 约束：
 *   1. 长边 ≤ `maxTargetPx`
 *   2. `⌈w/px⌉ × ⌈h/px⌉` ≤ `maxTargetTokens`
 *
 * 策略：
 *   - 若输入本身已满足两条约束 → 原样返回（No-op，避免无意义缩放）。
 *   - 把"竖屏"先翻转成"横屏"（w ≥ h）做搜索，最后按原方向转置回去；
 *     这让搜索空间在 width 单一维度上单调，二分法可用。
 *   - 沿 width 做二分：`lower` 保证合法、`upper` 保证非法，
 *     循环约 `log2(maxW) ≈ 12` 次；每步按 `aspectRatio = w / h` 算出
 *     对应的 `middleHeight`（`Math.round` 避免 1px 截断，最小值 1 兜底
 *     极窄比例），再用双约束判断是否合法。
 *   - 终止在 `lower + 1 === upper` 时返回 `lower` ——此时 `upper` 已知
 *     非法、`lower` 已知合法，再大一个像素就越界。
 *
 * 返回：满足约束的最大 `[width, height]`（保持宽高比、逐像素整数）。
 *
 * 正确性参考：算法与既定 vision 预处理规格以及
 * Rust `resize.rs:91-155` 等价，Wave 3 单测对核心 5 组 AR 逐 bit 对齐。
 */
export function targetImageSize(
  width: number,
  height: number,
  params: ImageResizeParams = DEFAULT_IMAGE_RESIZE_PARAMS,
): [number, number] {
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new DesktopError(
      DesktopErrorCode.VALIDATION_ERROR,
      `imageResize 输入非法：宽/高必须是有限数值，当前 width=${width} height=${height}。` +
      `本次截图缩放未执行，session 其他状态不受影响。` +
      `通常是 Electron display 信息异常导致，请重新 screenshot；如反复出现请排查 display bounds。`,
    )
  }
  if (width <= 0 || height <= 0) {
    throw new DesktopError(
      DesktopErrorCode.VALIDATION_ERROR,
      `imageResize 输入非法：宽/高必须为正数，当前 width=${width} height=${height}。` +
      `本次截图缩放未执行，session 其他状态不受影响。` +
      `请重新 screenshot；若持续出现请检查 display / region 参数。`,
    )
  }

  const { pxPerToken, maxTargetPx, maxTargetTokens } = params

  if (
    width <= maxTargetPx &&
    height <= maxTargetPx &&
    nTokensForImg(width, height, pxPerToken) <= maxTargetTokens
  ) {
    return [width, height]
  }

  if (height > width) {
    const [w, h] = targetImageSize(height, width, params)
    return [h, w]
  }

  const aspectRatio = width / height

  // 循环不变量：lowerBoundWidth 始终合法、upperBoundWidth 始终非法。
  // 起点 lower=1（极端情况下 1×1 总是合法——1 token 肯定在预算内）；
  // upper=width（大于目标值的输入本身就是起点非法宽度）。
  let upperBoundWidth = width
  let lowerBoundWidth = 1

  for (;;) {
    if (lowerBoundWidth + 1 === upperBoundWidth) {
      return [
        lowerBoundWidth,
        Math.max(Math.round(lowerBoundWidth / aspectRatio), 1),
      ]
    }

    const middleWidth = Math.floor((lowerBoundWidth + upperBoundWidth) / 2)
    const middleHeight = Math.max(Math.round(middleWidth / aspectRatio), 1)

    if (
      middleWidth <= maxTargetPx &&
      nTokensForImg(middleWidth, middleHeight, pxPerToken) <= maxTargetTokens
    ) {
      lowerBoundWidth = middleWidth
    } else {
      upperBoundWidth = middleWidth
    }
  }
}
