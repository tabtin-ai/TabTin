const PREVIEW_WIDTH_PX = 232
const PREVIEW_OFFSET_X_PX = 20
const PREVIEW_OFFSET_Y_PX = 18

export interface ResourceDragPreviewOptions {
  label: string
  icon?: string | null
}

/**
 * 用独立紧凑卡片替换 Chromium 根据 draggable 容器生成的整行拖拽影像。
 *
 * 只影响鼠标旁的 drag image：源列表布局、占位、MIME payload 和 drop 行为均不变。
 * 节点需短暂挂到 document.body，Chromium 才会接受为 drag image。
 */
export function setResourceDragPreview(
  dataTransfer: Pick<DataTransfer, 'setDragImage'>,
  { label, icon }: ResourceDragPreviewOptions,
): void {
  if (typeof dataTransfer.setDragImage !== 'function' || typeof document === 'undefined') return

  const preview = document.createElement('div')
  preview.dataset.resourceDragPreview = 'true'
  preview.setAttribute('aria-hidden', 'true')
  preview.className = [
    'flex min-h-10 items-center gap-2 overflow-hidden',
    'rounded-interactive border border-border bg-background px-2.5 py-2',
    'text-body text-foreground shadow-xl',
  ].join(' ')
  Object.assign(preview.style, {
    position: 'fixed',
    left: '-10000px',
    top: '-10000px',
    width: `${PREVIEW_WIDTH_PX}px`,
    opacity: '0.96',
    pointerEvents: 'none',
  })

  const iconNode = document.createElement('span')
  iconNode.dataset.resourceDragPreviewIcon = 'true'
  iconNode.className = 'w-5 shrink-0 overflow-hidden text-center leading-5'
  iconNode.textContent = icon || '📄'

  const labelNode = document.createElement('span')
  labelNode.dataset.resourceDragPreviewLabel = 'true'
  labelNode.className = 'min-w-0 truncate'
  labelNode.textContent = label

  preview.append(iconNode, labelNode)
  document.body.appendChild(preview)
  dataTransfer.setDragImage(preview, PREVIEW_OFFSET_X_PX, PREVIEW_OFFSET_Y_PX)

  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => preview.remove())
  } else {
    preview.remove()
  }
}
