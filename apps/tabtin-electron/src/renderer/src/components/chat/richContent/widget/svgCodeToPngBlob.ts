/**
 * 重构来源：apps/tabtin-electron/src/renderer/src/components/chat/RichContentRenderer.tsx（行 479-559）
 * 拆分时间：2026-04-30
 * 重构原因：RichContentRenderer.tsx 1352 行单文件过大，按职责拆分
 * 职责：renderer 端 SVG → PNG 转换（Wave 4.10 右键菜单本地 fallback）
 *       —— 纯工具函数，无 React 依赖。
 * 业务逻辑版本：与拆分前完全相同，只是 module 边界调整
 */

/**
 * Widget Wave 4.10（widget RFC §五 4.10）：renderer 端 SVG → PNG 转换。
 *
 * **业务路径**：用户右键 → "保存图片"，但 image_url 还未就位（Wave 4 烤图链路
 * 失败 / 流式中 finalCode 已就位但还没 OSS 上传完成）→ renderer 端把 SVG 临时
 * 转 PNG 让用户立刻拿到图。
 *
 * **限制**（写到 toast 提示）：renderer 转 PNG 仅用 raw SVG drawImage 到 canvas，
 * 不走完整 wrapper（CSP / design tokens 不会注入）→ 字体颜色可能与桌面 chat
 * 内 widget 视觉略有差异。**强烈建议**用户等 image_url 就位后再保存（Wave 4
 * 主路径——服务端 wrapper 烤的图保真度 100%）。
 *
 * **为什么不直接用 image_url**：image_url 路径优先（见 RichWidget handleSavePng），
 * 仅在 image_url 缺失时退到本函数。
 *
 * **失败模式**：
 *   - SVG 内引用外部资源（外链 image / 外部 font）：CSP-no 状态下浏览器仍尝试
 *     加载，跨域时 canvas 会 tainted，toBlob 抛 SecurityError——本函数捕获返
 *     null 让上层 toast 错误提示
 *   - SVG 没有显式 width/height + viewBox 异常：canvas naturalWidth/Height 是
 *     0 → 用 wrapper 默认 680×400 兜底
 */
export async function svgCodeToPngBlob(
  svgCode: string,
  theme: 'light' | 'dark',
): Promise<Blob | null> {
  if (!svgCode) return null
  return new Promise<Blob | null>((resolve) => {
    let url: string | null = null
    try {
      // 用 SVG MIME blob URL —— `<img src=blob:...>` 触发浏览器解析 SVG
      const blob = new Blob([svgCode], { type: 'image/svg+xml;charset=utf-8' })
      url = URL.createObjectURL(blob)
      const img = new Image()
      const cleanup = () => {
        if (url) URL.revokeObjectURL(url)
      }
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas')
          // SVG 没显式 width/height 时 naturalWidth=0 → 用 widget 默认 680×400
          const w = img.naturalWidth > 0 ? img.naturalWidth : 680
          const h = img.naturalHeight > 0 ? img.naturalHeight : 400
          // DPR 2 让导出 retina-quality（与 OffscreenWindowPool deviceScaleFactor 一致）
          canvas.width = w * 2
          canvas.height = h * 2
          const ctx = canvas.getContext('2d')
          if (!ctx) {
            cleanup()
            resolve(null)
            return
          }
          // dark 主题底色——避免暗色模式下导出图字白色看不见
          if (theme === 'dark') {
            ctx.fillStyle = '#1a1a1a'
          } else {
            ctx.fillStyle = '#ffffff'
          }
          ctx.fillRect(0, 0, canvas.width, canvas.height)
          ctx.scale(2, 2)
          ctx.drawImage(img, 0, 0, w, h)
          canvas.toBlob((b) => {
            cleanup()
            resolve(b)
          }, 'image/png')
        } catch {
          cleanup()
          resolve(null)
        }
      }
      img.onerror = () => {
        cleanup()
        resolve(null)
      }
      img.src = url
    } catch {
      if (url) URL.revokeObjectURL(url)
      resolve(null)
    }
  })
}
