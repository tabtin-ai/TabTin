/**
 * Wave 6 ContextMenu P1 回归测试
 *
 * CM-01: 复制对锁定元素误禁用 — copy() 不再过滤 locked 元素，ContextMenu 用 hasSelection 控制
 * CM-02: 对齐子菜单接入 — ContextMenu 引入 align.ts 并渲染 Align 子菜单
 * CM-03: 子菜单悬停间隙抖动 — SubMenuRow 使用 setTimeout 延迟关闭
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const contextMenuSrc = fs.readFileSync(
  path.resolve(__dirname, '../components/ContextMenu.tsx'),
  'utf-8',
)
// 右键菜单的动作派生与菜单模型已抽到独立模块
const ctxActionsSrc = fs.readFileSync(
  path.resolve(__dirname, '../hooks/useContextMenuActions.ts'),
  'utf-8',
)
const ctxItemsSrc = fs.readFileSync(
  path.resolve(__dirname, '../components/buildContextMenuItems.ts'),
  'utf-8',
)
const useClipboardSrc = fs.readFileSync(
  path.resolve(__dirname, '../hooks/useClipboard.ts'),
  'utf-8',
)

/* ══════════════════════════════════════════════════════
 * CM-01: 复制不再对锁定元素禁用
 * ══════════════════════════════════════════════════════ */

describe('CM-01: copy allows locked elements', () => {
  it('ContextMenu copy disabled 条件使用 hasSelection 而非 hasDeletableSelection', () => {
    const copyLine = ctxItemsSrc.match(
      /label:\s*translate\('contextMenu\.copy'\).*?disabled:\s*([^,}]+)/,
    )
    expect(copyLine).toBeTruthy()
    expect(copyLine![1].trim()).toBe('!hasSelection')
  })

  it('useClipboard.copy() 不再过滤 locked 元素', () => {
    const copyFn = useClipboardSrc.match(
      /const copy = useCallback\(\(\) => \{([\s\S]*?)\}, \[\]\)/,
    )
    expect(copyFn).toBeTruthy()
    const copyBody = copyFn![1]
    expect(copyBody).not.toContain('!el.locked')
    expect(copyBody).not.toContain('el.locked')
  })

  it('cut 仍然排除锁定元素（只有 copy 放开）', () => {
    expect(useClipboardSrc).toContain('getMovableSelectedIds')
    const getMovable = useClipboardSrc.match(
      /getMovableSelectedIds[\s\S]*?\.filter\(\(el\)\s*=>[\s\S]*?!el\.locked/,
    )
    expect(getMovable).toBeTruthy()
  })
})

describe('CM-01 source: copy() filter logic', () => {
  it('copy 的 filter 条件只检查 ids.has(el.id)，不检查 locked', () => {
    const copyFilterMatch = useClipboardSrc.match(
      /const copy = useCallback\(\(\) => \{[\s\S]*?\.filter\(\(el\)\s*=>\s*(.*)\)/,
    )
    expect(copyFilterMatch).toBeTruthy()
    const filterExpr = copyFilterMatch![1]
    expect(filterExpr).toContain('ids.has(el.id)')
    expect(filterExpr).not.toContain('locked')
  })
})

/* ══════════════════════════════════════════════════════
 * CM-02: 对齐子菜单已接入 ContextMenu
 * ══════════════════════════════════════════════════════ */

describe('CM-02: align submenu wired in ContextMenu', () => {
  it('导入 executeAlign 和 getMovableAlignUnitCount', () => {
    expect(ctxActionsSrc).toContain("import { executeAlign, getMovableAlignUnitCount } from '../utils/align'")
  })

  it('导入 AlignCommand 类型', () => {
    expect(ctxActionsSrc).toContain("import type { AlignCommand } from '../utils/align'")
  })

  it('渲染对齐子菜单（contextMenu.align label）', () => {
    expect(ctxItemsSrc).toContain("translate('contextMenu.align')")
  })

  it('包含全部 6 种基础对齐命令', () => {
    const alignCommands = ['align.left', 'align.horizontalCenter', 'align.right', 'align.top', 'align.verticalCenter', 'align.bottom']
    for (const cmd of alignCommands) {
      expect(ctxItemsSrc).toContain(`translate('${cmd}')`)
    }
  })

  it('包含水平和垂直分布命令', () => {
    expect(ctxItemsSrc).toContain("translate('align.distributeH')")
    expect(ctxItemsSrc).toContain("translate('align.distributeV')")
  })

  it('canAlign 基于 movableAlignUnitCount >= 2', () => {
    expect(ctxActionsSrc).toContain('const canAlign = movableAlignUnitCount >= 2')
  })

  it('canDistribute 基于 movableAlignUnitCount >= 3', () => {
    expect(ctxActionsSrc).toContain('const canDistribute = movableAlignUnitCount >= 3')
  })

  it('使用 updateElements 批量更新（而非逐个 updateElement）', () => {
    expect(ctxActionsSrc).toContain('updateElements(updates.map')
  })
})

/* ══════════════════════════════════════════════════════
 * CM-03: 子菜单悬停间隙抖动修复
 * ══════════════════════════════════════════════════════ */

describe('CM-03: submenu hover gap jitter fix', () => {
  it('SubMenuRow 使用 closeTimer ref', () => {
    expect(contextMenuSrc).toContain('closeTimer')
  })

  it('scheduleClose 使用 setTimeout 延迟（100ms）', () => {
    const match = contextMenuSrc.match(/setTimeout\(\(\)\s*=>\s*setOpen\(false\),\s*(\d+)\)/)
    expect(match).toBeTruthy()
    expect(Number(match![1])).toBe(100)
  })

  it('cancelClose 清除 timer', () => {
    expect(contextMenuSrc).toContain('clearTimeout(closeTimer.current)')
  })

  it('父容器 onMouseEnter 取消关闭并打开', () => {
    expect(contextMenuSrc).toContain('onMouseEnter={() => {')
    expect(contextMenuSrc).toContain('cancelClose()')
    expect(contextMenuSrc).toContain('setOpen(true)')
  })

  it('父容器 onMouseLeave 调度延迟关闭', () => {
    expect(contextMenuSrc).toContain('onMouseLeave={scheduleClose}')
  })

  it('子面板 onMouseEnter 取消关闭', () => {
    expect(contextMenuSrc).toContain('onMouseEnter={cancelClose}')
  })

  it('子面板 onMouseLeave 调度延迟关闭', () => {
    const subMenuPanelRegex = /onMouseLeave={scheduleClose}[\s\S]*?position:\s*'absolute'/
    expect(contextMenuSrc).toMatch(subMenuPanelRegex)
  })

  it('onMouseLeave 不再直接调用 setOpen(false)', () => {
    expect(contextMenuSrc).not.toContain('onMouseLeave={() => setOpen(false)}')
  })
})
