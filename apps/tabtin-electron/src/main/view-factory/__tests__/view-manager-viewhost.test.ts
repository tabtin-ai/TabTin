/**
 * ViewManager 的 ViewHost 接口契约测试（ Phase 1）
 *
 * 目的：ViewHost 面在 Phase 1 没有生产调用方（纯接缝），
 * 用契约单测钉住「接口方法 ≡ 既有方法别名」的等价性 + isAttached 这段唯一新逻辑，
 * 避免 Phase 2 首次真实调用时才暴露偏差。
 *
 * 断言的契约（与 WebContentsView 实现语义一一对应）：
 * - createGuest ≡ createView：同步创建、同 id 幂等复用、返回 { id, webContents } 窄句柄
 * - attach ≡ showView：addChildView + 已挂载去重
 * - detach ≡ hideView：removeChildView，不销毁 webContents
 * - destroy ≡ destroyView：销毁 webContents 并清理映射
 * - getWebContents / isAttached：查询语义
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => {
  class MockWebContentsView {
    webContents = {
      isDestroyed: vi.fn().mockReturnValue(false),
      loadURL: vi.fn().mockResolvedValue(undefined),
      once: vi.fn(),
      destroy: vi.fn(),
    }
    setBounds = vi.fn()
    setBackgroundColor = vi.fn()
  }
  return { WebContentsView: MockWebContentsView }
})

import { ViewManager } from '@tabtin/browser-capabilities'

function makeMockMainWindow() {
  const children: unknown[] = []
  return {
    isDestroyed: vi.fn().mockReturnValue(false),
    contentView: {
      children,
      addChildView: vi.fn((view: unknown) => {
        children.push(view)
      }),
      removeChildView: vi.fn((view: unknown) => {
        const idx = children.indexOf(view)
        if (idx >= 0) children.splice(idx, 1)
      }),
    },
  }
}

describe('ViewManager — ViewHost 契约', () => {
  let manager: ViewManager
  let mainWindow: ReturnType<typeof makeMockMainWindow>

  beforeEach(() => {
    manager = new ViewManager()
    mainWindow = makeMockMainWindow()
    manager.setMainWindow(mainWindow as any)
  })

  describe('createGuest', () => {
    it('返回容器无关的 { id, webContents } 句柄，webContents 与 createView 同实例', async () => {
      const handle = await manager.createGuest('g1', {})
      expect(handle.id).toBe('g1')
      expect(handle.webContents).toBe(manager.getView('g1')!.webContents)
    })

    it('同 id 重复创建幂等：返回同一 webContents（≡ createView 的重复创建语义）', async () => {
      const first = await manager.createGuest('g1', {})
      const second = await manager.createGuest('g1', {})
      expect(second.webContents).toBe(first.webContents)
      expect(manager.getViewCount()).toBe(1)
    })
  })

  describe('attach / detach / isAttached', () => {
    it('attach 挂载到 contentView，isAttached 变为 true', async () => {
      await manager.createGuest('g1', {})
      expect(manager.isAttached('g1')).toBe(false)

      manager.attach('g1')
      expect(mainWindow.contentView.addChildView).toHaveBeenCalledTimes(1)
      expect(manager.isAttached('g1')).toBe(true)
    })

    it('重复 attach 去重：不重复 addChildView（≡ showView 防闪烁语义）', async () => {
      await manager.createGuest('g1', {})
      manager.attach('g1')
      manager.attach('g1')
      expect(mainWindow.contentView.addChildView).toHaveBeenCalledTimes(1)
    })

    it('detach 移除挂载但不销毁 webContents', async () => {
      const handle = await manager.createGuest('g1', {})
      manager.attach('g1')

      manager.detach('g1')
      expect(mainWindow.contentView.removeChildView).toHaveBeenCalledTimes(1)
      expect(manager.isAttached('g1')).toBe(false)
      expect((handle.webContents as any).destroy).not.toHaveBeenCalled()
      expect(manager.getWebContents('g1')).toBe(handle.webContents)
    })

    it('未知 id：attach 抛错（≡ showView），isAttached 返回 false', () => {
      expect(() => manager.attach('nonexistent')).toThrow()
      expect(manager.isAttached('nonexistent')).toBe(false)
    })

    it('主窗口不可用时 isAttached 返回 false', async () => {
      await manager.createGuest('g1', {})
      manager.attach('g1')
      mainWindow.isDestroyed.mockReturnValue(true)
      expect(manager.isAttached('g1')).toBe(false)
    })
  })

  describe('destroy / getWebContents', () => {
    it('destroy 销毁 webContents 并清理映射（≡ destroyView）', async () => {
      const handle = await manager.createGuest('g1', {})
      manager.attach('g1')

      manager.destroy('g1')
      expect((handle.webContents as any).destroy).toHaveBeenCalledTimes(1)
      expect(manager.getWebContents('g1')).toBeNull()
      expect(manager.hasView('g1')).toBe(false)
      expect(manager.isAttached('g1')).toBe(false)
    })

    it('getWebContents 未知 id 返回 null', () => {
      expect(manager.getWebContents('nonexistent')).toBeNull()
    })
  })

  describe('setBounds', () => {
    it('透传到底层容器 setBounds', async () => {
      await manager.createGuest('g1', {})
      const bounds = { x: 1, y: 2, width: 300, height: 400 }
      manager.setBounds('g1', bounds)
      expect((manager.getView('g1') as any).setBounds).toHaveBeenCalledWith(bounds)
    })
  })
})
