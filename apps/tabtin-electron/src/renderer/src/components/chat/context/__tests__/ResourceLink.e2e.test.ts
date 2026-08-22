/**
 * ResourceLink.e2e — chat 链接派发端到端契约测试（5 类 url × 3 触发 = 15）
 *
 * **W3 北极星**（专题"Agent 产物在 Space 内的打开" RFC §3.7 / §12.0）：
 *   `pnpm --filter tabtin-electron test:e2e ResourceLink.e2e` 含 5 类 url × 3 触发 = 15 PASS
 *
 * 项目无 e2e 基础设施（参照 Wave 5 反思 16 fallback 模式 + trackerArtifactMap.test.ts
 * 注释惯例），改用 vitest 单元测试形态：mock ResourceRouter 依赖（contextRegistry /
 * shellOpenExternal / openResourceTab），用 ResourceRouter.open 真实派发逻辑覆盖
 * 5 类 url × 3 触发场景。
 *
 * 5 类 url：
 *   1. 自有格式 `tabtin://resource/<type>/<id>?hint=<app>`
 *   2. https://...
 *   3. file:///...
 *   4. mailto:...
 *   5. 裸路径 `/Users/.../x.md`（经 markdown-resource-autolink 升级为 file://）
 *
 * 3 触发：
 *   A. 左键 onClick → ResourceRouter.open（D2 五层优先级）
 *   B. ⌘ / Ctrl + 左键 → ResourceRouter.open(modifierExternal=true)（直接 system）
 *   C. 右键菜单"在外部应用打开" → ResourceRouter.open(modifierExternal=true)
 *      （右键菜单"在 Space 内打开" 与 A 等效，仅作冗余覆盖）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  parseResourcePointer,
  ResourceRouter,
  ResourceRouterRegistry,
} from '@tabtin/resource-router'

// ─── 测试 fixtures ─────────────────────────────────────────────────

const URLS = {
  selfFormat: 'tabtin://resource/document/doc_xyz?hint=tabdoc&title=项目方案',
  https: 'https://example.com/x',
  file: 'file:///tmp/log.json',
  mailto: 'mailto:foo@bar.com?subject=hi',
  // 裸路径在 markdown-resource-autolink 阶段升级为 tabtin://resource/file/<encoded>
  // 这里直接给升级后的形态，模拟 chat MarkdownRenderer 拿到 href 时的形态
  bareFile: 'tabtin://resource/file/' + encodeURIComponent('/Users/developer/report.md'),
}

const TRIGGERS = {
  leftClick: { modifierExternal: false } as const,
  modifierClick: { modifierExternal: true } as const,
  contextMenuOpenExternal: { modifierExternal: true } as const,
}

// ─── ResourceRouter mock 装配 ──────────────────────────────────────

function makeRouter() {
  const registry = new ResourceRouterRegistry()
  // 注册 manifest opens：与 packages/apps/<id>/app.json 实际声明对齐
  registry.register('tabdoc', { types: [{ type: 'document', priority: 100 }] })
  registry.register('tabweb', { schemes: [{ scheme: 'https:', priority: 50 }] })
  registry.register('tabfolder', {
    schemes: [{ scheme: 'file:', priority: 100 }],
    types: [{ type: 'file', priority: 80 }],
  })
  registry.register('tabmail', { schemes: [{ scheme: 'mailto:', priority: 100 }] })

  const KNOWN = new Set(['tabdoc', 'tabweb', 'tabfolder', 'tabmail'])
  const openResourceTab = vi.fn()
  const shellOpenExternal = vi.fn().mockResolvedValue(undefined)
  const emitEvent = vi.fn()

  const router = new ResourceRouter(
    {
      contextRegistry: {
        hasHandlerByAppId: (appId) => KNOWN.has(appId),
        getAppIdsForType: () => [],
      },
      preferenceStore: {
        get: () => undefined,
        set: () => {},
        unset: () => {},
      },
      openResourceTab,
      shellOpenExternal,
      emitEvent,
      client: 'electron',
    },
    registry,
  )

  return { router, openResourceTab, shellOpenExternal, emitEvent }
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ─── 5 × 3 = 15 测试 ────────────────────────────────────────────────

describe('ResourceLink.e2e — chat 链接派发 (5 类 url × 3 触发 = 15 PASS)', () => {
  describe('左键 onClick — D2 五层优先级正常派发', () => {
    it('A.1 自有格式 → in_space_opened（hint=tabdoc 命中 manifest opens）', async () => {
      const { router, openResourceTab, shellOpenExternal } = makeRouter()
      const pointer = parseResourcePointer(URLS.selfFormat)
      const out = await router.open('space-1', pointer, {
        ...TRIGGERS.leftClick,
        triggerSource: 'chat_markdown',
      })
      expect(out.outcome).toBe('in_space_opened')
      expect(out.carrierAppId).toBe('tabdoc')
      expect(openResourceTab).toHaveBeenCalledWith('space-1', expect.objectContaining({
        type: 'document',
        id: 'doc_xyz',
      }))
      expect(shellOpenExternal).not.toHaveBeenCalled()
    })

    it('A.2 https:// → in_space_opened (carrier=tabweb)', async () => {
      const { router, openResourceTab, shellOpenExternal } = makeRouter()
      const pointer = parseResourcePointer(URLS.https)
      const out = await router.open('space-1', pointer, {
        ...TRIGGERS.leftClick,
        triggerSource: 'chat_markdown',
      })
      expect(out.outcome).toBe('in_space_opened')
      expect(out.carrierAppId).toBe('tabweb')
      expect(openResourceTab).toHaveBeenCalledTimes(1)
      expect(shellOpenExternal).not.toHaveBeenCalled()
    })

    it('A.3 file:// → in_space_opened (carrier=tabfolder)', async () => {
      const { router, openResourceTab } = makeRouter()
      const pointer = parseResourcePointer(URLS.file)
      const out = await router.open('space-1', pointer, {
        ...TRIGGERS.leftClick,
        triggerSource: 'chat_markdown',
      })
      expect(out.outcome).toBe('in_space_opened')
      expect(out.carrierAppId).toBe('tabfolder')
      expect(openResourceTab).toHaveBeenCalled()
    })

    it('A.4 mailto: → in_space_opened (carrier=tabmail)', async () => {
      const { router, openResourceTab } = makeRouter()
      const pointer = parseResourcePointer(URLS.mailto)
      const out = await router.open('space-1', pointer, {
        ...TRIGGERS.leftClick,
        triggerSource: 'chat_markdown',
      })
      expect(out.outcome).toBe('in_space_opened')
      expect(out.carrierAppId).toBe('tabmail')
      expect(openResourceTab).toHaveBeenCalled()
    })

    it('A.5 裸路径升级 → in_space_opened (file 走 tabfolder type 优先)', async () => {
      const { router, openResourceTab } = makeRouter()
      const pointer = parseResourcePointer(URLS.bareFile)
      const out = await router.open('space-1', pointer, {
        ...TRIGGERS.leftClick,
        triggerSource: 'chat_markdown',
      })
      expect(out.outcome).toBe('in_space_opened')
      expect(out.carrierAppId).toBe('tabfolder')
      expect(openResourceTab).toHaveBeenCalledWith('space-1', expect.objectContaining({
        type: 'file',
        id: '/Users/developer/report.md',
      }))
    })
  })

  describe('⌘ / Ctrl + 左键 — D2 第 5 层短路到 system_app_opened', () => {
    it('B.1 自有格式 + 修饰键 → system_app_opened', async () => {
      const { router, openResourceTab, shellOpenExternal } = makeRouter()
      const pointer = parseResourcePointer(URLS.selfFormat)
      const out = await router.open('space-1', pointer, {
        ...TRIGGERS.modifierClick,
        triggerSource: 'chat_markdown',
      })
      expect(out.outcome).toBe('system_app_opened')
      expect(out.resolveSource).toBe('modifier_key')
      expect(openResourceTab).not.toHaveBeenCalled()
      expect(shellOpenExternal).toHaveBeenCalledWith(URLS.selfFormat)
    })

    it('B.2 https + 修饰键 → system_app_opened', async () => {
      const { router, openResourceTab, shellOpenExternal } = makeRouter()
      const pointer = parseResourcePointer(URLS.https)
      const out = await router.open('space-1', pointer, {
        ...TRIGGERS.modifierClick,
        triggerSource: 'chat_markdown',
      })
      expect(out.outcome).toBe('system_app_opened')
      expect(openResourceTab).not.toHaveBeenCalled()
      expect(shellOpenExternal).toHaveBeenCalledWith(URLS.https)
    })

    it('B.3 file + 修饰键 → system_app_opened', async () => {
      const { router, shellOpenExternal } = makeRouter()
      const pointer = parseResourcePointer(URLS.file)
      const out = await router.open('space-1', pointer, {
        ...TRIGGERS.modifierClick,
        triggerSource: 'chat_markdown',
      })
      expect(out.outcome).toBe('system_app_opened')
      expect(shellOpenExternal).toHaveBeenCalledWith(URLS.file)
    })

    it('B.4 mailto + 修饰键 → system_app_opened', async () => {
      const { router, shellOpenExternal } = makeRouter()
      const pointer = parseResourcePointer(URLS.mailto)
      const out = await router.open('space-1', pointer, {
        ...TRIGGERS.modifierClick,
        triggerSource: 'chat_markdown',
      })
      expect(out.outcome).toBe('system_app_opened')
      expect(shellOpenExternal).toHaveBeenCalledWith(URLS.mailto)
    })

    it('B.5 裸路径 + 修饰键 → system_app_opened（path 升级后的 raw 由 shell 解析）', async () => {
      const { router, shellOpenExternal } = makeRouter()
      const pointer = parseResourcePointer(URLS.bareFile)
      const out = await router.open('space-1', pointer, {
        ...TRIGGERS.modifierClick,
        triggerSource: 'chat_markdown',
      })
      expect(out.outcome).toBe('system_app_opened')
      expect(shellOpenExternal).toHaveBeenCalledWith(URLS.bareFile)
    })
  })

  describe('右键菜单"在外部应用打开" — 与修饰键同款短路', () => {
    it('C.1 自有格式 → system_app_opened', async () => {
      const { router, shellOpenExternal } = makeRouter()
      const pointer = parseResourcePointer(URLS.selfFormat)
      const out = await router.open('space-1', pointer, {
        ...TRIGGERS.contextMenuOpenExternal,
        triggerSource: 'chat_markdown',
      })
      expect(out.outcome).toBe('system_app_opened')
      expect(shellOpenExternal).toHaveBeenCalledWith(URLS.selfFormat)
    })

    it('C.2 https → system_app_opened', async () => {
      const { router, shellOpenExternal } = makeRouter()
      const pointer = parseResourcePointer(URLS.https)
      const out = await router.open('space-1', pointer, {
        ...TRIGGERS.contextMenuOpenExternal,
        triggerSource: 'chat_markdown',
      })
      expect(out.outcome).toBe('system_app_opened')
      expect(shellOpenExternal).toHaveBeenCalledWith(URLS.https)
    })

    it('C.3 file → system_app_opened', async () => {
      const { router, shellOpenExternal } = makeRouter()
      const pointer = parseResourcePointer(URLS.file)
      const out = await router.open('space-1', pointer, {
        ...TRIGGERS.contextMenuOpenExternal,
        triggerSource: 'chat_markdown',
      })
      expect(out.outcome).toBe('system_app_opened')
      expect(shellOpenExternal).toHaveBeenCalledWith(URLS.file)
    })

    it('C.4 mailto → system_app_opened', async () => {
      const { router, shellOpenExternal } = makeRouter()
      const pointer = parseResourcePointer(URLS.mailto)
      const out = await router.open('space-1', pointer, {
        ...TRIGGERS.contextMenuOpenExternal,
        triggerSource: 'chat_markdown',
      })
      expect(out.outcome).toBe('system_app_opened')
      expect(shellOpenExternal).toHaveBeenCalledWith(URLS.mailto)
    })

    it('C.5 裸路径 → system_app_opened', async () => {
      const { router, shellOpenExternal } = makeRouter()
      const pointer = parseResourcePointer(URLS.bareFile)
      const out = await router.open('space-1', pointer, {
        ...TRIGGERS.contextMenuOpenExternal,
        triggerSource: 'chat_markdown',
      })
      expect(out.outcome).toBe('system_app_opened')
      expect(shellOpenExternal).toHaveBeenCalledWith(URLS.bareFile)
    })
  })
})

// ─── 跨 turn / 多次点击不残留污染（Widget 反思 10 教训） ──────────────────

describe('ResourceLink.e2e — 跨 turn 多次点击不残留污染', () => {
  it('同一 router 实例多次 open 不互相影响', async () => {
    const { router, openResourceTab, shellOpenExternal } = makeRouter()

    // 第 1 次：自有格式左键
    const r1 = await router.open(
      'space-1',
      parseResourcePointer(URLS.selfFormat),
      { triggerSource: 'chat_markdown' },
    )
    expect(r1.outcome).toBe('in_space_opened')

    // 第 2 次：同 url 修饰键 — 不应被 user_pref / session override 污染
    const r2 = await router.open(
      'space-1',
      parseResourcePointer(URLS.selfFormat),
      { modifierExternal: true, triggerSource: 'chat_markdown' },
    )
    expect(r2.outcome).toBe('system_app_opened')

    // 第 3 次：mailto 左键 — 应正常派发到 tabmail
    const r3 = await router.open(
      'space-1',
      parseResourcePointer(URLS.mailto),
      { triggerSource: 'chat_markdown' },
    )
    expect(r3.outcome).toBe('in_space_opened')
    expect(r3.carrierAppId).toBe('tabmail')

    // 总计调用次数：openResourceTab 2 次（in_space），shellOpenExternal 1 次（modifier）
    expect(openResourceTab).toHaveBeenCalledTimes(2)
    expect(shellOpenExternal).toHaveBeenCalledTimes(1)
  })
})
