import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockEmitBrowserAnnotationInject = vi.fn()
const mockFallbackToDraft = vi.fn()
const mockToast = vi.fn()
const mockExecuteScript = vi.fn()
const mockCancelAnnotation = vi.fn()
const mockScreenshot = vi.fn()

vi.mock('@components/chat/context/browserAnnotationInjection', () => ({
  emitBrowserAnnotationInject: (...args: unknown[]) => mockEmitBrowserAnnotationInject(...args),
}))

vi.mock('@/services/browserAnnotationDraftFallback', () => ({
  fallbackBrowserAnnotationToDraft: (...args: unknown[]) => mockFallbackToDraft(...args),
}))

vi.mock('@/crawlspace/electron/crawl-view-client', () => ({
  crawlViewClient: {
    executeScript: (...args: unknown[]) => mockExecuteScript(...args),
    cancelAnnotation: (...args: unknown[]) => mockCancelAnnotation(...args),
    screenshot: (...args: unknown[]) => mockScreenshot(...args),
  },
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: (...args: unknown[]) => mockToast(...args),
}))

vi.mock('@/i18n', () => ({
  default: {
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  },
}))

import { CONTENT_SNAPSHOT_SNIPPET, cancelBrowserAnnotationToChat, captureBrowserViewportToChat, quoteBrowserSelectionToChat, startBrowserAnnotationToChat } from '../quoteBrowserSelectionToChat'

describe('quoteBrowserSelectionToChat', () => {
  beforeEach(() => {
    mockEmitBrowserAnnotationInject.mockClear()
    // 默认模拟「有对话 composer 接住」——注入被消费，走原有成功 toast 路径
    mockEmitBrowserAnnotationInject.mockReturnValue(true)
    mockFallbackToDraft.mockClear()
    mockFallbackToDraft.mockReturnValue(true)
    mockToast.mockClear()
    mockExecuteScript.mockClear()
    mockCancelAnnotation.mockClear()
    mockScreenshot.mockClear()
    document.documentElement.style.removeProperty('--primary')
    document.documentElement.style.removeProperty('--primary-foreground')
    mockExecuteScript.mockResolvedValue({
      success: true,
      result: {
        selection: { kind: 'text', text: 'Selected text' },
        rect: { x: 10, y: 20, width: 100, height: 30 },
        captureRect: { x: 2, y: 12, width: 116, height: 46 },
        dom: { tag: 'p', selector: 'p:nth-of-type(1)' },
      },
    })
    mockScreenshot.mockResolvedValue({ success: true, data: Buffer.from('png').toString('base64') })
  })

  it('默认注入 DOM-only web_annotation，不携带截图附件', async () => {
    const ok = await quoteBrowserSelectionToChat({
      text: '  Selected text  ',
      url: 'https://example.com/',
      viewId: 'view-1',
      title: 'Example',
      favicon: 'https://example.com/favicon.ico',
      crawlspaceId: 'cs-1',
      t: (_key, defaultValue) => defaultValue,
    })

    expect(ok).toBe(true)
    expect(mockScreenshot).not.toHaveBeenCalled()
    expect(mockEmitBrowserAnnotationInject).toHaveBeenCalledTimes(1)
    const payload = mockEmitBrowserAnnotationInject.mock.calls[0]?.[0]
    expect(payload.attachment).toBeUndefined()
    expect(payload.contextRef).toMatchObject({
      type: 'web_annotation',
      resourceId: 'https://example.com/',
      label: 'Example',
      tabType: 'tabweb',
      meta: expect.objectContaining({
        preview: 'Selected text',
        url: 'https://example.com/',
        pageTitle: 'Example',
        favicon: 'https://example.com/favicon.ico',
        crawlspaceId: 'cs-1',
        selection: { kind: 'text', text: 'Selected text' },
        rect: { x: 10, y: 20, width: 100, height: 30 },
        dom: { tag: 'p', selector: 'p:nth-of-type(1)' },
      }),
    })
    expect(payload.contextRef.meta.screenshotFilename).toBeUndefined()
    expect(mockToast).toHaveBeenCalledWith({ title: '已引用网页注释到对话' })
  })

  it('空选区不注入，并提示先选中文本', async () => {
    const ok = await quoteBrowserSelectionToChat({
      text: '   ',
      url: 'https://example.com/',
      t: (_key, defaultValue) => defaultValue,
    })

    expect(ok).toBe(false)
    expect(mockEmitBrowserAnnotationInject).not.toHaveBeenCalled()
    expect(mockToast).toHaveBeenCalledWith({
      title: '请先在网页中选中文本',
      variant: 'destructive',
    })
  })

  it('preview 最多保留 2000 个字符', async () => {
    mockExecuteScript.mockResolvedValueOnce({
      success: true,
      result: {
        selection: { kind: 'text', text: 'x'.repeat(2001) },
        rect: { x: 10, y: 20, width: 100, height: 30 },
        captureRect: { x: 2, y: 12, width: 116, height: 46 },
        dom: { tag: 'p', selector: 'p:nth-of-type(1)' },
      },
    })

    await quoteBrowserSelectionToChat({
      text: 'x'.repeat(2001),
      url: 'https://example.com/',
      viewId: 'view-1',
      t: (_key, defaultValue) => defaultValue,
    })

    const payload = mockEmitBrowserAnnotationInject.mock.calls[0]?.[0]
    expect(payload.contextRef.meta.preview).toHaveLength(2000)
  })

  it('inspect 模式点击元素后注入 element web_annotation', async () => {
    mockExecuteScript.mockResolvedValueOnce({
      success: true,
      result: {
        selection: { kind: 'element', text: 'Element text' },
        rect: { x: 10, y: 20, width: 120, height: 40 },
        captureRect: { x: 2, y: 12, width: 136, height: 56 },
        dom: { tag: 'button', role: 'button', selector: 'button:nth-of-type(1)' },
      },
    })

    const ok = await startBrowserAnnotationToChat({
      url: 'https://example.com/',
      viewId: 'view-1',
      title: 'Example',
      t: (_key, defaultValue) => defaultValue,
    })

    expect(ok).toBe(true)
    const payload = mockEmitBrowserAnnotationInject.mock.calls[0]?.[0]
    expect(payload.contextRef).toMatchObject({
      type: 'web_annotation',
      meta: expect.objectContaining({
        preview: 'Element text',
        selection: { kind: 'element', text: 'Element text' },
        dom: { tag: 'button', role: 'button', selector: 'button:nth-of-type(1)' },
      }),
    })
    expect(payload.attachment).toBeUndefined()
    expect(mockScreenshot).not.toHaveBeenCalled()
  })

  it('inspect overlay 使用当前项目主题色，而不是固定蓝色', async () => {
    document.documentElement.style.setProperty('--primary', '178 55% 42%')
    document.documentElement.style.setProperty('--primary-foreground', '0 0% 99%')
    mockExecuteScript.mockResolvedValueOnce({
      success: true,
      result: {
        selection: { kind: 'element', text: 'Element text' },
        rect: { x: 10, y: 20, width: 120, height: 40 },
        captureRect: { x: 2, y: 12, width: 136, height: 56 },
        dom: { tag: 'button', role: 'button', selector: 'button:nth-of-type(1)' },
      },
    })

    await startBrowserAnnotationToChat({
      url: 'https://example.com/',
      viewId: 'view-1',
      t: (_key, defaultValue) => defaultValue,
    })

    const [script] = mockExecuteScript.mock.calls[0] ?? []
    expect(script).toContain('"primary":"178 55% 42%"')
    expect(script).not.toContain('#0ea5ff')
  })

  it('截图模式点击元素后截取当前可视区域', async () => {
    mockExecuteScript.mockResolvedValueOnce({
      success: true,
      result: {
        selection: { kind: 'element', text: 'Element text' },
        rect: { x: 10, y: 20, width: 120, height: 40 },
        captureRect: { x: 2, y: 12, width: 136, height: 56 },
        dom: { tag: 'button', role: 'button', selector: 'button:nth-of-type(1)' },
      },
    })

    const ok = await startBrowserAnnotationToChat({
      url: 'https://example.com/',
      viewId: 'view-1',
      title: 'Example',
      includeScreenshot: true,
      t: (_key, defaultValue) => defaultValue,
    })

    expect(ok).toBe(true)
    expect(mockScreenshot).toHaveBeenCalledWith({
      format: 'png',
    }, 'view-1')
    const payload = mockEmitBrowserAnnotationInject.mock.calls[0]?.[0]
    expect(payload.attachment).toMatchObject({
      filename: expect.stringMatching(/^browser-annotation-.*\.png$/),
      mimeType: 'image/png',
      type: 'image',
      status: 'pending',
    })
    expect(payload.contextRef.meta.screenshotFilename).toMatch(/^browser-annotation-.*\.png$/)
  })

  it('可直接截取当前可视区域，不进入 DOM 选择模式', async () => {
    const ok = await captureBrowserViewportToChat({
      url: 'https://example.com/',
      viewId: 'view-1',
      title: 'Example',
      t: (_key, defaultValue) => defaultValue,
    })

    expect(ok).toBe(true)
    expect(mockExecuteScript).not.toHaveBeenCalled()
    expect(mockScreenshot).toHaveBeenCalledWith({ format: 'png' }, 'view-1')
    const payload = mockEmitBrowserAnnotationInject.mock.calls[0]?.[0]
    expect(payload.attachment).toMatchObject({
      type: 'image',
      filename: expect.stringMatching(/^browser-annotation-.*\.png$/),
    })
    expect(payload.contextRef).toMatchObject({
      type: 'web_annotation',
      meta: expect.objectContaining({
        preview: 'Example',
        screenshotFilename: expect.stringMatching(/^browser-annotation-.*\.png$/),
      }),
    })
  })

  it('连续两次 viewport 截图产生不同的 attachment.id（ 回归）', async () => {
    // 同 url / 同 title / 同 viewId，模拟用户滑动后再次点截图按钮。
    // 修复前：annotationId 仅由 annotationKey 决定，两次完全相同 → ChatInput
    // 按 att.id 去重时第二次截图被丢弃。修复后：含截图路径拼唯一后缀，两次必不同。
    await captureBrowserViewportToChat({
      url: 'https://example.com/',
      viewId: 'view-1',
      title: 'Example',
      t: (_key, defaultValue) => defaultValue,
    })
    await captureBrowserViewportToChat({
      url: 'https://example.com/',
      viewId: 'view-1',
      title: 'Example',
      t: (_key, defaultValue) => defaultValue,
    })

    expect(mockEmitBrowserAnnotationInject).toHaveBeenCalledTimes(2)
    const firstPayload = mockEmitBrowserAnnotationInject.mock.calls[0]?.[0]
    const secondPayload = mockEmitBrowserAnnotationInject.mock.calls[1]?.[0]
    expect(firstPayload.attachment?.id).toBeTruthy()
    expect(secondPayload.attachment?.id).toBeTruthy()
    expect(firstPayload.attachment?.id).not.toBe(secondPayload.attachment?.id)
    expect(firstPayload.attachment?.filename).not.toBe(secondPayload.attachment?.filename)
    // annotationKey 保持稳定（同 url 同 viewport 的语义身份不变）
    expect(firstPayload.contextRef.meta.annotationKey).toBe(secondPayload.contextRef.meta.annotationKey)
  })

  it('含截图的元素注释连续两次点同一元素产生不同 attachment.id（ 同类）', async () => {
    mockExecuteScript.mockResolvedValue({
      success: true,
      result: {
        selection: { kind: 'element', text: 'Element text' },
        rect: { x: 10, y: 20, width: 120, height: 40 },
        captureRect: { x: 2, y: 12, width: 136, height: 56 },
        dom: { tag: 'button', role: 'button', selector: 'button:nth-of-type(1)' },
      },
    })

    await startBrowserAnnotationToChat({
      url: 'https://example.com/',
      viewId: 'view-1',
      title: 'Example',
      includeScreenshot: true,
      t: (_key, defaultValue) => defaultValue,
    })
    await startBrowserAnnotationToChat({
      url: 'https://example.com/',
      viewId: 'view-1',
      title: 'Example',
      includeScreenshot: true,
      t: (_key, defaultValue) => defaultValue,
    })

    expect(mockEmitBrowserAnnotationInject).toHaveBeenCalledTimes(2)
    const firstPayload = mockEmitBrowserAnnotationInject.mock.calls[0]?.[0]
    const secondPayload = mockEmitBrowserAnnotationInject.mock.calls[1]?.[0]
    expect(firstPayload.attachment?.id).not.toBe(secondPayload.attachment?.id)
  })

  it('无对话 composer 消费时走新任务草稿兜底并提示已创建', async () => {
    mockEmitBrowserAnnotationInject.mockReturnValue(false)

    const ok = await quoteBrowserSelectionToChat({
      text: 'Selected text',
      url: 'https://example.com/',
      viewId: 'view-1',
      title: 'Example',
      t: (_key, defaultValue) => defaultValue,
    })

    expect(ok).toBe(true)
    expect(mockFallbackToDraft).toHaveBeenCalledTimes(1)
    const input = mockFallbackToDraft.mock.calls[0]?.[0]
    expect(input).toMatchObject({
      sourceUrl: 'https://example.com/',
      sourceTitle: 'Example',
      contextRef: expect.objectContaining({ type: 'web_annotation' }),
    })
    expect(mockToast).toHaveBeenCalledWith({ title: '已创建新任务并引用网页注释' })
    // 谎报回归：不得再弹「已引用网页注释到对话」
    expect(mockToast).not.toHaveBeenCalledWith({ title: '已引用网页注释到对话' })
  })

  it('无对话消费且截图模式时，附件透传给兜底', async () => {
    mockEmitBrowserAnnotationInject.mockReturnValue(false)

    const ok = await captureBrowserViewportToChat({
      url: 'https://example.com/',
      viewId: 'view-1',
      title: 'Example',
      t: (_key, defaultValue) => defaultValue,
    })

    expect(ok).toBe(true)
    const input = mockFallbackToDraft.mock.calls[0]?.[0]
    expect(input.attachment).toMatchObject({ type: 'image' })
  })

  it('兜底失败（无可用工作空间）时报错误 toast 并返回 false', async () => {
    mockEmitBrowserAnnotationInject.mockReturnValue(false)
    mockFallbackToDraft.mockReturnValue(false)

    const ok = await quoteBrowserSelectionToChat({
      text: 'Selected text',
      url: 'https://example.com/',
      viewId: 'view-1',
      t: (_key, defaultValue) => defaultValue,
    })

    expect(ok).toBe(false)
    expect(mockToast).toHaveBeenCalledWith({
      title: '无法引用网页注释：没有可用的对话',
      variant: 'destructive',
    })
  })

  it('元素注释携带内容快照时写入 meta.contentSnapshot', async () => {
    mockExecuteScript.mockResolvedValueOnce({
      success: true,
      result: {
        selection: { kind: 'element', text: '评论 1 评论 2' },
        rect: { x: 10, y: 20, width: 120, height: 40 },
        captureRect: { x: 2, y: 12, width: 136, height: 56 },
        dom: { tag: 'bili-comments', selector: 'bili-comments:nth-of-type(1)' },
        content: { text: '评论 1 评论 2 评论 3', truncated: false },
      },
    })

    const ok = await startBrowserAnnotationToChat({
      url: 'https://example.com/',
      viewId: 'view-1',
      title: 'Example',
      t: (_key, defaultValue) => defaultValue,
    })

    expect(ok).toBe(true)
    const payload = mockEmitBrowserAnnotationInject.mock.calls[0]?.[0]
    expect(payload.contextRef.meta.contentSnapshot).toEqual({ text: '评论 1 评论 2 评论 3', truncated: false })
  })

  it('无内容快照时 meta 不出现 contentSnapshot 键', async () => {
    mockExecuteScript.mockResolvedValueOnce({
      success: true,
      result: {
        selection: { kind: 'element', text: 'Element text' },
        rect: { x: 10, y: 20, width: 120, height: 40 },
        captureRect: { x: 2, y: 12, width: 136, height: 56 },
        dom: { tag: 'button', selector: 'button:nth-of-type(1)' },
      },
    })

    await startBrowserAnnotationToChat({
      url: 'https://example.com/',
      viewId: 'view-1',
      t: (_key, defaultValue) => defaultValue,
    })

    const payload = mockEmitBrowserAnnotationInject.mock.calls[0]?.[0]
    expect('contentSnapshot' in payload.contextRef.meta).toBe(false)
  })

  it('可通过 cancel 脚本取消 inspect 模式', async () => {
    mockCancelAnnotation.mockResolvedValueOnce({ success: true, result: true })

    await expect(cancelBrowserAnnotationToChat('view-1')).resolves.toBe(true)
    const [viewId] = mockCancelAnnotation.mock.calls[0] ?? []
    expect(viewId).toBe('view-1')
    expect(mockExecuteScript).not.toHaveBeenCalled()
  })

  it('inspect 模式取消时不注入', async () => {
    mockExecuteScript.mockResolvedValueOnce({ success: true, result: null })

    const ok = await startBrowserAnnotationToChat({
      url: 'https://example.com/',
      viewId: 'view-1',
      t: (_key, defaultValue) => defaultValue,
    })

    expect(ok).toBe(false)
    expect(mockEmitBrowserAnnotationInject).not.toHaveBeenCalled()
    expect(mockToast).toHaveBeenCalledWith({ title: '已取消网页注释' })
  })
})

describe('collectContentSnapshot（：注释落点内容快照，穿透 shadow DOM）', () => {
  type Snapshot = { text: string; truncated: boolean }
  // 页面注入片段在 jsdom 里直接求值，验证的就是线上跑的同一段代码
  const collect = new Function(
    `${CONTENT_SNAPSHOT_SNIPPET}; return collectContentSnapshot;`,
  )() as (root: Node, maxChars: number) => Snapshot

  it('穿透多层 open shadow DOM 取文本（innerText 为空的 Web Components 宿主）', () => {
    const host = document.createElement('bili-comments')
    const shadow = host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = ':host { display: block; }'
    shadow.appendChild(style)

    const thread = document.createElement('bili-comment-thread')
    const threadShadow = thread.attachShadow({ mode: 'open' })
    const p = document.createElement('p')
    p.textContent = '第一条评论'
    threadShadow.appendChild(p)
    shadow.appendChild(thread)

    const div = document.createElement('div')
    div.textContent = '共 41 条回复'
    shadow.appendChild(div)

    // 对照组：textContent 只看 light DOM，取不到任何内容
    expect((host.textContent || '').trim()).toBe('')

    const snapshot = collect(host, 8000)
    expect(snapshot.text).toContain('第一条评论')
    expect(snapshot.text).toContain('共 41 条回复')
    // style 标签内容不得混入（B 站案例中曾把 :host {...} CSS 当文本抓出来）
    expect(snapshot.text).not.toContain(':host')
    expect(snapshot.truncated).toBe(false)
  })

  it('slot 投影内容按扁平树回接 assignedNodes，不重复计入', () => {
    const host = document.createElement('x-card')
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.appendChild(document.createElement('slot'))
    const span = document.createElement('span')
    span.textContent = '投影文本'
    host.appendChild(span)
    document.body.appendChild(host)

    try {
      const snapshot = collect(host, 8000)
      expect(snapshot.text).toBe('投影文本')
    } finally {
      host.remove()
    }
  })

  it('超出 maxChars 截断并置 truncated', () => {
    const root = document.createElement('div')
    root.textContent = '很长的评论内容'.repeat(100)
    const snapshot = collect(root, 50)
    expect(snapshot.text.length).toBeLessThanOrEqual(50)
    expect(snapshot.truncated).toBe(true)
  })

  it('跳过 script/style/noscript/template 与 aria-hidden 子树', () => {
    const root = document.createElement('div')
    root.innerHTML = [
      '<p>可见文本</p>',
      '<script>var x = 1;</scr' + 'ipt>',
      '<style>.a { color: red; }</style>',
      '<div aria-hidden="true">装饰性内容</div>',
    ].join('')
    const snapshot = collect(root, 8000)
    expect(snapshot.text).toBe('可见文本')
  })

  it('普通 light DOM 元素正常取文本并折叠空白', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p>  第一段\n\n  </p><p>第二段</p>'
    const snapshot = collect(root, 8000)
    expect(snapshot.text).toBe('第一段 第二段')
  })
})
