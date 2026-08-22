import type { IMMessageMetadata } from '@/services/im/contracts'

export const IM_IMAGE_FRAME_MAX_WIDTH = 480
export const IM_IMAGE_FRAME_MAX_HEIGHT = 420

export interface ImImageFrame {
  width: number
  height: number
}

function positiveDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * 历史消息没有尺寸时保留最大预览框；带尺寸的新消息按原比例缩进同一边界。
 * 两种路径都在图片解码前确定高度，避免虚拟列表重测后反向补偿滚动位置。
 */
export function resolveImImageFrame(metadata: IMMessageMetadata | undefined): ImImageFrame {
  const sourceWidth = metadata?.image_width
  const sourceHeight = metadata?.image_height
  if (!positiveDimension(sourceWidth) || !positiveDimension(sourceHeight)) {
    return {
      width: IM_IMAGE_FRAME_MAX_WIDTH,
      height: IM_IMAGE_FRAME_MAX_HEIGHT,
    }
  }

  const scale = Math.min(
    1,
    IM_IMAGE_FRAME_MAX_WIDTH / sourceWidth,
    IM_IMAGE_FRAME_MAX_HEIGHT / sourceHeight,
  )
  return {
    width: sourceWidth * scale,
    height: sourceHeight * scale,
  }
}
