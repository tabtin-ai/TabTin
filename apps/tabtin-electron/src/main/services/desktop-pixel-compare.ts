/**
 * TabDesktop · pixelCompare 点击前 9×9 像素陈旧度校验（Wave 3 · 规范 § 4.5.3）。
 *
 * 要解决什么：
 *   Agent 的工作流是 "screenshot → 分析 → 点击"。分析期间 UI 可能被弹窗 /
 *   动画 / 异步加载 / 别的 Agent 改动——Agent 的坐标落在一个"已经不是它
 *   以为的东西"上（Figma / IDE 场景频发）。
 *
 *   pixelCompare 的思路是：点击前**立即再截屏一次**，取目标坐标周围 9×9
 *   像素块 raw bytes，与 session 上次截图对应位置的 9×9 对比。
 *   - 相等 → UI 没变，点击安全，执行
 *   - 不等 → UI 已变，抛中文三段式错误，引导 Agent 重新 screenshot
 *
 * **红线（规范 § 4.5.3 第 2 点 + Wave 3 监督计划 § 3.3）**：
 *   任何异常（decode 失败 / 新截屏失败 / 冷启动 last 缺失 / 其他）都**必须
 *   跳过校验 + 继续点击**。校验失败绝不能阻塞操作。本模块的所有外部接口
 *   对"异常"统一返回 `{ valid: true, skipped: true }`，调用方按等同
 *   `valid: true` 处置。违反这条红线 → Agent 冷启动第一次点击永远挂。
 *
 * 与 imageResize 的耦合（规范 § 10 Q6）：
 *   last 与 fresh 两次截图必须经过相同的 imageResize 参数，像素尺寸一致。
 *   session 内 imageResize 参数冻结（默认 DEFAULT_IMAGE_RESIZE_PARAMS）就
 *   满足这条约束；pixelCompare 自身用**百分比坐标**裁 9×9，进一步 defense
 *   in depth。
 */

/** 9×9 是调优过的尺寸——大到能抓 tooltip 出现，小到不被周围
 * 动画误伤。规范 § 4.5.3 引用之。 */
export const DEFAULT_GRID_SIZE = 9

/**
 * 9×9 裁剪矩形（在某张截图的像素坐标空间里）。
 */
export interface CropRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 计算以 (xPercent, yPercent) 为中心的 gridSize×gridSize 裁剪矩形。
 *
 * 百分比坐标：以 `imgW × imgH` 为 100%×100% 的相对定位，`(0, 0)` = 左上
 * 角、`(100, 100)` = 右下角。为什么用百分比而不是直接像素坐标？
 *
 *   - imageResize 可能让 last 与 fresh 的像素尺寸差异（极端情况下，比如
 *     session 中途换了 tokenizer 参数——v1 不会发生但 defense in depth）。
 *     百分比让两张图的"同一相对位置"可比较。
 *   - 与主流程 `toScreenCoords` 正交，不影响 Retina scaleFactor 计算。
 *
 * 边界处理：
 *   - `imgW / imgH` 为 0 或负 → 返回 null（调用方作 skip）
 *   - 百分比超 [0, 100] → clamp 到区间
 *   - rect 超出图边界 → 收紧到合法 9×9 或更小；若完全收紧到 ≤ 0 → null
 *
 * 公式来源：中心裁剪 + 平均色差。
 */
export function computeCropRect(
  imgW: number,
  imgH: number,
  xPercent: number,
  yPercent: number,
  gridSize: number = DEFAULT_GRID_SIZE,
): CropRect | null {
  if (!Number.isFinite(imgW) || !Number.isFinite(imgH) || imgW <= 0 || imgH <= 0) {
    return null
  }
  if (!Number.isFinite(xPercent) || !Number.isFinite(yPercent)) return null
  if (gridSize <= 0) return null

  const clampedX = Math.max(0, Math.min(100, xPercent))
  const clampedY = Math.max(0, Math.min(100, yPercent))

  const centerX = Math.round((clampedX / 100.0) * imgW)
  const centerY = Math.round((clampedY / 100.0) * imgH)

  const halfGrid = Math.floor(gridSize / 2)
  const cropX = Math.max(0, centerX - halfGrid)
  const cropY = Math.max(0, centerY - halfGrid)
  const cropW = Math.min(gridSize, imgW - cropX)
  const cropH = Math.min(gridSize, imgH - cropY)
  if (cropW <= 0 || cropH <= 0) return null

  return { x: cropX, y: cropY, width: cropW, height: cropH }
}

/**
 * 比较两个已经被裁剪到同尺寸的 raw bytes buffer 是否**完全相等**。
 *
 * 9×9 exact byte equality——没有 fuzzing / 容差：一个像素变了就视为变了。
 * 这是规范 § 4.5.3 的语义承诺，也是"点击前屏幕没变"最严格的判定。
 *
 * 格式无关性：两边 buffer 的像素格式只要相同就行——Electron `nativeImage
 * .toBitmap()` 给 BGRA，sharp `.raw()` 给 RGB，对比时都是字节对字节相等。
 */
export function buffersEqual(a: Buffer | null, b: Buffer | null): boolean {
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.equals(b)
}

/**
 * 以"百分比坐标"为入口的 pixelCompare 判定接口。
 *
 * @param cropFn 由调用方注入的"从某张图裁指定 rect 的 raw bytes" 函数。
 *   失败时必须返回 null（不要抛错，让本函数在 null 分支安全跳过）。
 * @returns
 *   - `{ equal: true }` —— 两张图该位置完全一致，可以放心点击
 *   - `{ equal: false }` —— 不等，**调用方应中止点击**并抛中文三段式
 *   - `null` —— 无法判定（rect 算不出 / cropFn 返回 null 等），
 *     **调用方必须按"继续点击"处置**（规范 § 4.5.3 红线）
 */
export function comparePixelAtLocation(
  imgW: number,
  imgH: number,
  xPercent: number,
  yPercent: number,
  cropFn: (rect: CropRect) => Buffer | null,
  source: 'last' | 'fresh',
): { patch: Buffer | null; rect: CropRect | null } {
  const rect = computeCropRect(imgW, imgH, xPercent, yPercent)
  if (!rect) {
    return { patch: null, rect: null }
  }
  try {
    const patch = cropFn(rect)
    return { patch: patch ?? null, rect }
  } catch {
    // 规范 § 4.5.3 红线：crop 异常视作 skip（调用方会继续点击）。
    // 这里不 log.warn 是刻意的——内部诊断由 comparePixels 调用方记一次即可，
    // 本函数保持纯逻辑。
    void source
    return { patch: null, rect }
  }
}

/**
 * 高层便捷接口：给定两张图的 cropFn + 百分比坐标，比对同一 9×9 位置的
 * raw bytes 是否相等。
 *
 * 返回：
 *   - `true`  → 相等，可继续点击
 *   - `false` → 不等，调用方应中止点击
 *   - `null`  → 判定失败（红线：调用方必须按"继续点击"处置）
 */
export function comparePixels(
  imgW: number,
  imgH: number,
  xPercent: number,
  yPercent: number,
  lastCropFn: (rect: CropRect) => Buffer | null,
  freshCropFn: (rect: CropRect) => Buffer | null,
): boolean | null {
  const { patch: lastPatch, rect } = comparePixelAtLocation(
    imgW,
    imgH,
    xPercent,
    yPercent,
    lastCropFn,
    'last',
  )
  if (!rect || !lastPatch) return null
  let freshPatch: Buffer | null
  try {
    freshPatch = freshCropFn(rect)
  } catch {
    return null
  }
  if (!freshPatch) return null
  return buffersEqual(lastPatch, freshPatch)
}
