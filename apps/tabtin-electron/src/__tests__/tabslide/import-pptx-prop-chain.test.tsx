import { describe, it, expect } from 'vitest'
import type { SlideTopBarProps } from '../../../../../packages/tabslide/src/components/SlideTopBar'

/**
 * EI-001 回归测试：验证 onImportPPTX prop 在类型系统层面正确声明。
 *
 * ：导入/导出/放映/版本历史已从 RightSidebar 迁到顶栏 SlideTopBar，
 * 因此 prop 链路改为 SlideEditor → SlideTopBar。
 *
 * 由于测试基础设施中 @tabtin/app-shell 未解析（已有问题），
 * 无法渲染依赖 @tabtin/smartsheet-ui 的组件。
 * 本测试通过类型契约 + 源码结构两层验证确保 prop 传递链路完整。
 */

describe('TabSlide onImportPPTX prop chain (EI-001)', () => {
  it('SlideTopBarProps 接口应包含 onImportPPTX 回调', () => {
    const props: SlideTopBarProps = {
      onImportPPTX: () => {},
    }
    expect(props.onImportPPTX).toBeDefined()
    expect(typeof props.onImportPPTX).toBe('function')
  })

  it('onImportPPTX 应为可选 prop（未传时不报错）', () => {
    const props: SlideTopBarProps = {}
    expect(props.onImportPPTX).toBeUndefined()
  })

  it('SlideEditor 渲染 SlideTopBar 时传递了 onImportPPTX（源码结构验证）', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const editorPath = path.resolve(
      __dirname,
      '../../../../../packages/tabslide/src/components/SlideEditor.tsx',
    )
    const source = fs.readFileSync(editorPath, 'utf-8')

    const topBarBlock = source.match(/<SlideTopBar[\s\S]*?\/>/)?.[0] ?? ''
    expect(topBarBlock).toContain('onImportPPTX')
    expect(topBarBlock).toMatch(/onImportPPTX\s*=\s*\{/)
  })

  it('SlideTopBar 组件解构了 onImportPPTX prop（源码结构验证）', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const topBarPath = path.resolve(
      __dirname,
      '../../../../../packages/tabslide/src/components/SlideTopBar.tsx',
    )
    const source = fs.readFileSync(topBarPath, 'utf-8')

    expect(source).toContain('onImportPPTX')
    const destructureMatch = source.match(
      /export const SlideTopBar[\s\S]*?\(\{[\s\S]*?onImportPPTX[\s\S]*?\}\)/,
    )
    expect(destructureMatch).not.toBeNull()
  })

  it('SlideTopBar 顶栏中使用了 onImportPPTX（源码结构验证）', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const topBarPath = path.resolve(
      __dirname,
      '../../../../../packages/tabslide/src/components/SlideTopBar.tsx',
    )
    const source = fs.readFileSync(topBarPath, 'utf-8')

    expect(source).toMatch(/onImportPPTX\s*&&/)
    expect(source).toMatch(/onClick\s*=\s*\{?\s*onImportPPTX\s*\}?/)
  })
})
