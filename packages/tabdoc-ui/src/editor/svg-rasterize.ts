/**
 * 将 SVG data URI 栅格化为 PNG data URI（浏览器 / Electron canvas）。
 * 用于对话拖入文档：编辑器可显示 SVG，但 Word 导出不支持 SVG，
 * 拖入时转 PNG 可保证导出侧不依赖服务端 cairosvg/Playwright。
 */

function parseSvgDataUrl(src: string): string | null {
  const match = /^data:image\/svg\+xml([^,]*),(.*)$/i.exec(src.trim())
  if (!match) return null
  const header = match[1].toLowerCase()
  const payload = match[2]
  try {
    if (header.includes(';base64')) {
      // atob 得到二进制字符串；SVG 为 UTF-8 文本
      const binary = atob(payload)
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
      return new TextDecoder('utf-8').decode(bytes)
    }
    return decodeURIComponent(payload)
  } catch {
    return null
  }
}

/**
 * @returns PNG data URI；无法转换时返回 null（调用方应回退原 src）
 */
export function rasterizeSvgDataUrlToPngDataUrl(src: string): Promise<string | null> {
  const svgCode = parseSvgDataUrl(src)
  if (!svgCode) return Promise.resolve(null)

  return new Promise((resolve) => {
    let objectUrl: string | null = null
    try {
      const blob = new Blob([svgCode], { type: 'image/svg+xml;charset=utf-8' })
      objectUrl = URL.createObjectURL(blob)
      const img = new Image()
      const cleanup = () => {
        if (objectUrl) URL.revokeObjectURL(objectUrl)
      }
      img.onload = () => {
        try {
          const w = img.naturalWidth > 0 ? img.naturalWidth : 680
          const h = img.naturalHeight > 0 ? img.naturalHeight : 400
          const canvas = document.createElement('canvas')
          const scale = 2
          canvas.width = w * scale
          canvas.height = h * scale
          const ctx = canvas.getContext('2d')
          if (!ctx) {
            cleanup()
            resolve(null)
            return
          }
          ctx.fillStyle = '#ffffff'
          ctx.fillRect(0, 0, canvas.width, canvas.height)
          ctx.scale(scale, scale)
          ctx.drawImage(img, 0, 0, w, h)
          const png = canvas.toDataURL('image/png')
          cleanup()
          resolve(png.startsWith('data:image/png') ? png : null)
        } catch {
          cleanup()
          resolve(null)
        }
      }
      img.onerror = () => {
        cleanup()
        resolve(null)
      }
      img.src = objectUrl
    } catch {
      if (objectUrl) URL.revokeObjectURL(objectUrl)
      resolve(null)
    }
  })
}

export function isSvgDataUrl(src: string): boolean {
  return /^data:image\/svg\+xml/i.test(src.trim())
}
