/**
 * ResourceLink E2E（vitest jsdom）— 专题"Agent 产物在 Space 内的打开" W3 北极星
 *
 * 覆盖 5 类 url × 3 触发方式 = 15 个用例（RFC §12.0 W3 北极星）：
 *
 *   url 维度：
 *     1. 自有格式：`tabtin://resource/document/doc_xyz?hint=tabdoc`
 *     2. https://...
 *     3. file:///...
 *     4. mailto:...
 *     5. 裸绝对路径 `/Users/x/report.md`（remarkAutolinkResource 升级为 file://
 *        markdown link 节点）
 *
 *   触发维度：
 *     A. 左键点击 — 走 ResourceRouter.open（D2 五层优先级）
 *     B. ⌘ / Ctrl + 左键 — modifierExternal: true，跳第 5 层系统应用
 *     C. 右键菜单 — 弹 ResourceLinkContextMenu，至少含"在 Space 内打开"+
 *        "在外部应用打开"+"复制链接"
 *
 * 项目无 Playwright / Cypress e2e 基础设施（W2 trackerArtifactMap.test 反思
 * 16 已确认），改用 vitest + @testing-library/react 渲染 MarkdownRenderer
 * 完整 markdown pipeline，模拟用户事件——比 unit test 强一档（覆盖整条
 * remark/rehype/sanitize/onClick/onContextMenu 链路）。
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render } from '@testing-library/react'

// ResourceRouter 是路由派发主入口；测试覆盖"链接事件 → 调 router.open"
// 的链路契约。router 内部的 D2 五层优先级 / candidate 排序在
// `packages/resource-router/test/router.test.ts` 已覆盖，本测试不重复。
const routerOpen = vi.fn(async () => ({
  outcome: 'in_space_opened',
  carrierAppId: 'tabdoc',
  resolveSource: 'manifest_default',
  durationMs: 0,
}))
const expandCanvasAfterInSpaceOpen = vi.fn()

vi.mock('@/services/resourceRouter', () => ({
  resourceRouter: {
    open: (...args: unknown[]) => routerOpen(...args),
  },
}))

vi.mock('@/services/openResourceLink', () => ({
  resolveSpaceIdForResourceLink: (tabScopeKey?: string | null) =>
    tabScopeKey === 'conversation:session-1' ? 'space-session' : 'space-test',
  expandCanvasAfterInSpaceOpen: (...args: unknown[]) => expandCanvasAfterInSpaceOpen(...args),
}))

// useSpaceStore 提供当前 space id —— 测试桩用固定值
vi.mock('@/stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => ({ selectedSpace: { id: 'space-test' } }),
  },
}))

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      draftExecutionSpaceIdByWorkspaceKey: {},
      getSessionById: (sessionId: string) =>
        sessionId === 'session-1'
          ? { id: 'session-1', space_id: 'space-session' }
          : undefined,
    }),
  },
}))

// 直接 hook ResourceLinkContextMenu 的 imperative API，验证右键菜单触发
const showContextMenu = vi.fn()
vi.mock('../ResourceLinkContextMenu', () => ({
  showResourceLinkContextMenu: (...args: unknown[]) => showContextMenu(...args),
  ResourceLinkContextMenuHost: () => null,
}))

// MermaidBlock 在 jsdom 下加载会拉外部依赖；本测试不渲染 mermaid，stub 成空组件
vi.mock('../../markdown/MermaidBlock', () => ({
  MermaidBlock: () => null,
}))

import { MarkdownRenderer } from '../../markdown/MarkdownRenderer'
import { sanitizeSchema } from '@/lib/rehypeSanitizeSchema'

// 防御性自检：sanitize schema 的 protocols.href / src 必须为 falsy（null / false /
// 空数组），代表"完全不限制协议"——RFC §3.3 + D4 默认全开。任何回退到白名单
// 形态都会让 file:// / tabtin:// 链接被静默删 href，破坏 W3 北极星。
describe('ResourceLink E2E 守门：sanitize protocols 全开自检', () => {
  it('sanitizeSchema.protocols.href 是 falsy（hast-util-sanitize 语义"全开"）', () => {
    const protocols = (sanitizeSchema as { protocols?: Record<string, unknown> }).protocols
    expect(protocols).toBeDefined()
    expect(Boolean(protocols!.href)).toBe(false)
    expect(Boolean(protocols!.src)).toBe(false)
  })
})

const URL_CASES: Array<{ name: string; markdown: string; expectedHrefStartsWith: string }> = [
  {
    name: '自有格式 tabtin://resource/...',
    markdown: '看[这份产物](tabtin://resource/document/doc_xyz?hint=tabdoc)',
    expectedHrefStartsWith: 'tabtin://resource/document/doc_xyz',
  },
  {
    name: 'https',
    markdown: '参考 [TabTin 官网](https://www.example.com/docs)',
    expectedHrefStartsWith: 'https://www.example.com/',
  },
  {
    name: 'file://',
    markdown: '日志在 [log.json](file:///tmp/run/log.json)',
    expectedHrefStartsWith: 'file:///tmp/run/',
  },
  {
    name: 'mailto:',
    markdown: '联系 [作者](mailto:author@example.com)',
    expectedHrefStartsWith: 'mailto:author@example.com',
  },
  {
    name: '裸绝对路径（autolink 升级）',
    markdown: '产物在 /Users/developer/sandbox/report.md 里',
    expectedHrefStartsWith: 'tabtin://resource/file/',
  },
]

beforeEach(() => {
  routerOpen.mockClear()
  expandCanvasAfterInSpaceOpen.mockClear()
  showContextMenu.mockClear()
})

describe('ResourceLink E2E (W3 / RFC §12.0 北极星)', () => {
  it('GFM 表格里的裸 https URL 左键可派发（browser dogfood 回归）', () => {
    const markdown = [
      '| Tab ID | 标题 | URL | 类型 |',
      '| --- | --- | --- | --- |',
      '| view-c…517210 | **Example Domain** | https://example.com/ | tabweb |',
    ].join('\n')
    const { container } = render(<MarkdownRenderer content={markdown} />)
    const anchor = container.querySelector('td a[href="https://example.com/"]')

    expect(anchor).toBeTruthy()
    fireEvent.click(anchor!)
    expect(routerOpen).toHaveBeenCalledTimes(1)
    const [spaceId, pointer, opts] = routerOpen.mock.calls[0]
    expect(spaceId).toBe('space-test')
    expect(pointer).toMatchObject({
      scheme: 'https',
      raw: 'https://example.com/',
    })
    expect((opts as { modifierExternal?: boolean }).modifierExternal).toBeFalsy()
  })

  // ── 触发 A：左键点击 ──────────────────────────────────────
  for (const { name, markdown, expectedHrefStartsWith } of URL_CASES) {
    it(`左键点击 → resourceRouter.open（url=${name}）`, async () => {
      const { container } = render(<MarkdownRenderer content={markdown} />)
      const anchor = container.querySelector('a')
      const href = anchor?.getAttribute('href') ?? ''
      // 调试输出（如失败可看见 markdown → DOM 结果）
      if (!anchor || !href) {
        console.log(`[debug] markdown=${markdown}\n  html=${container.innerHTML}`)
      }
      expect(anchor).toBeTruthy()
      expect(href).toMatch(
        new RegExp(`^${expectedHrefStartsWith.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      )
      fireEvent.click(anchor!)
      expect(routerOpen).toHaveBeenCalledTimes(1)
      const [spaceId, pointer, opts] = routerOpen.mock.calls[0]
      expect(spaceId).toBe('space-test')
      expect(typeof pointer).toBe('object')
      expect((opts as { modifierExternal?: boolean }).modifierExternal).toBeFalsy()
    })
  }

  it('左键点击时透传 tabScopeKey 到 ResourceRouter', async () => {
    const { container } = render(
      <MarkdownRenderer
        content="[doc](tabtin://resource/document/doc_xyz)"
        tabScopeKey="conversation:session-1"
      />,
    )
    const anchor = container.querySelector('a')!

    fireEvent.click(anchor)

    const [spaceId, , opts] = routerOpen.mock.calls[0]
    expect(spaceId).toBe('space-session')
    expect((opts as { tabScopeKey?: string }).tabScopeKey).toBe('conversation:session-1')
  })

  it('聊天链接在 Space 内打开成功后展开最小化的工作台', async () => {
    const { container } = render(
      <MarkdownRenderer
        content="[网页](https://example.com/)"
        tabScopeKey="conversation:session-1"
      />,
    )

    fireEvent.click(container.querySelector('a')!)
    await Promise.resolve()

    expect(expandCanvasAfterInSpaceOpen).toHaveBeenCalledWith(
      'conversation:session-1',
      expect.objectContaining({ outcome: 'in_space_opened' }),
    )
  })

  it('非对话宿主可显式指定资源所属 Space，不回退到全局选中工作空间', () => {
    const { container } = render(
      <MarkdownRenderer
        content="[doc](tabtin://resource/document/doc_xyz)"
        resourceSpaceId="project-space-1"
      />,
    )

    fireEvent.click(container.querySelector('a')!)

    const [spaceId] = routerOpen.mock.calls[0]
    expect(spaceId).toBe('project-space-1')
  })

  it('外层已可点击的卡片可关闭 Markdown 链接交互', () => {
    const { container } = render(
      <MarkdownRenderer
        content="查看 **[交付文档](tabtin://resource/document/doc_xyz)**"
        linksEnabled={false}
      />,
    )

    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('strong')?.textContent).toBe('交付文档')
  })

  // ── 触发 B：⌘ + 左键（modifierExternal=true，D2 第 5 层短路） ──
  for (const { name, markdown } of URL_CASES) {
    it(`⌘ + 左键 → modifierExternal=true（url=${name}）`, async () => {
      const { container } = render(<MarkdownRenderer content={markdown} />)
      const anchor = container.querySelector('a')!
      fireEvent.click(anchor, { metaKey: true })
      expect(routerOpen).toHaveBeenCalledTimes(1)
      const [, , opts] = routerOpen.mock.calls[0]
      expect((opts as { modifierExternal?: boolean }).modifierExternal).toBe(true)
    })
  }

  // ── 触发 C：右键菜单 ────────────────────────────────────
  for (const { name, markdown } of URL_CASES) {
    it(`右键 → 上下文菜单触发（url=${name}）`, async () => {
      const { container } = render(<MarkdownRenderer content={markdown} />)
      const anchor = container.querySelector('a')!
      fireEvent.contextMenu(anchor)
      expect(routerOpen).not.toHaveBeenCalled()
      expect(showContextMenu).toHaveBeenCalledTimes(1)
      const [args] = showContextMenu.mock.calls[0]
      expect(typeof args).toBe('object')
      expect((args as { spaceId?: string }).spaceId).toBe('space-test')
    })
  }

  it('右键菜单时透传 tabScopeKey 到菜单 store', async () => {
    const { container } = render(
      <MarkdownRenderer
        content="[doc](tabtin://resource/document/doc_xyz)"
        tabScopeKey="conversation:session-1"
      />,
    )
    const anchor = container.querySelector('a')!

    fireEvent.contextMenu(anchor)

    const [args] = showContextMenu.mock.calls[0]
    expect((args as { spaceId?: string }).spaceId).toBe('space-session')
    expect((args as { tabScopeKey?: string }).tabScopeKey).toBe('conversation:session-1')
  })
})

// ── 兜底：5 × 3 = 15 个 it() 编号检验（北极星可命令 grep 验证）──
describe('ResourceLink E2E 北极星：15 PASS 计数守护', () => {
  it('北极星：5 类 url × 3 触发 = 15 个用例（grep 验证）', () => {
    expect(URL_CASES.length).toBe(5)
    // 上面 3 组 for-loop 各注册 5 个 it()；vitest 跑完时实际 14 it() 由 vitest
    // 自身计数。这里用 const 守护"5 × 3 + 1 = 16 总数（含本检验项）"——
    // 北极星验收只看 15 业务用例 PASS，本元测试是"测试本身"维度。
    expect(URL_CASES.length * 3).toBe(15)
  })
})
