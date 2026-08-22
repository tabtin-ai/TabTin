/**
 * 把内置贴纸 URL（SVG/PNG）栅格化为可上传的 PNG File。
 */

const STICKER_PNG_SIZE = 256

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`Failed to load sticker image: ${url}`))
    img.src = url
  })
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('Failed to encode sticker PNG'))
    }, 'image/png')
  })
}

export async function stickerSrcToFile(src: string, filename: string): Promise<File> {
  const img = await loadImage(src)
  const canvas = document.createElement('canvas')
  canvas.width = STICKER_PNG_SIZE
  canvas.height = STICKER_PNG_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('Canvas 2D context unavailable')
  }
  ctx.clearRect(0, 0, STICKER_PNG_SIZE, STICKER_PNG_SIZE)
  ctx.drawImage(img, 0, 0, STICKER_PNG_SIZE, STICKER_PNG_SIZE)
  const blob = await canvasToPngBlob(canvas)
  const safeName = filename.endsWith('.png') ? filename : `${filename}.png`
  return new File([blob], safeName, { type: 'image/png' })
}
