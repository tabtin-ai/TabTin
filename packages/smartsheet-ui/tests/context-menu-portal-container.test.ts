import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveContextMenuPortalContainer } from '../src/components/context-menu/portal-container'

function makeElement(options: {
  rect?: Partial<DOMRect>
  contains?: (node: Node | null) => boolean
  isConnected?: boolean
} = {}): HTMLElement {
  const rect = {
    x: options.rect?.x ?? options.rect?.left ?? 100,
    y: options.rect?.y ?? options.rect?.top ?? 50,
    left: options.rect?.left ?? options.rect?.x ?? 100,
    top: options.rect?.top ?? options.rect?.y ?? 50,
    right: options.rect?.right ?? 500,
    bottom: options.rect?.bottom ?? 450,
    width: options.rect?.width ?? 400,
    height: options.rect?.height ?? 400,
    toJSON: () => ({}),
  } as DOMRect

  return {
    isConnected: options.isConnected ?? true,
    contains: options.contains ?? (() => false),
    getBoundingClientRect: () => rect,
  } as unknown as HTMLElement
}

test('ContextMenu keeps coordinate anchors inside overlay container', () => {
  const overlay = makeElement()

  assert.equal(
    resolveContextMenuPortalContainer({
      overlayContainer: overlay,
      anchorPosition: { x: 120, y: 60 },
    }),
    overlay,
  )
})

test('ContextMenu falls back to body for coordinate anchors outside overlay container', () => {
  const overlay = makeElement()

  assert.equal(
    resolveContextMenuPortalContainer({
      overlayContainer: overlay,
      anchorPosition: { x: 20, y: 60 },
    }),
    null,
  )
})

test('ContextMenu uses anchor element containment before coordinate checks', () => {
  const anchorInside = makeElement()
  const anchorOutside = makeElement()
  const overlay = makeElement({
    contains: node => node === anchorInside,
  })

  assert.equal(
    resolveContextMenuPortalContainer({
      overlayContainer: overlay,
      anchorEl: anchorInside,
      anchorPosition: { x: 20, y: 60 },
    }),
    overlay,
  )
  assert.equal(
    resolveContextMenuPortalContainer({
      overlayContainer: overlay,
      anchorEl: anchorOutside,
      anchorPosition: { x: 120, y: 60 },
    }),
    null,
  )
})

test('ContextMenu keeps zero-sized overlay containers scoped to their space', () => {
  const overlay = makeElement({
    rect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
  })

  assert.equal(
    resolveContextMenuPortalContainer({
      overlayContainer: overlay,
      anchorPosition: { x: 120, y: 60 },
    }),
    overlay,
  )
})

test('ContextMenu falls back to body when overlay container is detached from document', () => {
  // 画布折叠 / 切走 Space 时，工作台 portal 宿主可能没有挂载点，整棵子树 detached。
  // 此时 overlay 容器 isConnected=false，菜单必须回退到 body，否则 portal 进游离节点不可见。
  const overlay = makeElement({ isConnected: false })

  assert.equal(
    resolveContextMenuPortalContainer({
      overlayContainer: overlay,
      anchorPosition: { x: 120, y: 60 },
    }),
    null,
  )
  // anchorEl 路径同样要兜底
  assert.equal(
    resolveContextMenuPortalContainer({
      overlayContainer: overlay,
      anchorEl: makeElement(),
    }),
    null,
  )
})
