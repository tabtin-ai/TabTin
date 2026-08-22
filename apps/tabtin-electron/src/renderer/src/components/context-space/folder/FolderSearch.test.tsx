/**
 * FolderSearch 单测 —  修复回归
 *
 * 覆盖点：
 * - 成功：ripgrepSearch success:true → 渲染结果列表 + 行号
 * - 失败显式反馈：ripgrepSearch success:false → 渲染「搜索失败」+ 后端 error，
 *   不再静默落进「无匹配结果」分支（ 之前的根因）
 * - 抛错显式反馈：IPC reject → 渲染「搜索失败」+ 异常 message
 * - Windows 路径兼容：ripgrep 返回 `C:\...` 而 rootPath 是 `C:/...`，
 *   相对路径要正确截掉 root 前缀，而不是把整个绝对路径铺到 UI
 * - rootPath 变化时清空：切目录后旧 query / results 不残留
 *
 * 实现注意：
 * - 不用 fake timers：doSearch 有 300ms 防抖，waitFor 默认 1000ms timeout 足够
 *   覆盖防抖 + mock resolve。fake timers 下 waitFor 的内部轮询不会自动推进，
 *   组合起来很别扭，索性走真实 timers。
 * - 不依赖 jest-dom matcher：用 toBeTruthy / toBeNull 等 vitest 原生 matcher
 *   （与 GlobalSearch.test.tsx 同款约定）。
 */
import React, { act } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── 模块顶层 mock：必须在被测组件 import 前注册 ──
const { mockRipgrepSearch } = vi.hoisted(() => ({
  mockRipgrepSearch: vi.fn(),
}))

// setup.ts 已经把 window.tabtin 初始化成 createMockTabtin()（不带 fileSystem），
// 这里在它上面补 fileSystem.ripgrepSearch。用 defineProperty 是因为 setup.ts
// 也是用 defineProperty 定义的 window.tabtin，且 configurable: true。
beforeEach(() => {
  const baseTabtin = (window as Window & { tabtin?: Record<string, unknown> }).tabtin ?? {}
  Object.defineProperty(window, 'tabtin', {
    value: {
      ...baseTabtin,
      fileSystem: {
        ripgrepSearch: mockRipgrepSearch,
      },
    },
    writable: true,
    configurable: true,
  })
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, defaultValueOrOptions?: unknown) => {
      if (typeof defaultValueOrOptions === 'string') return defaultValueOrOptions
      if (
        defaultValueOrOptions &&
        typeof defaultValueOrOptions === 'object' &&
        'defaultValue' in (defaultValueOrOptions as Record<string, unknown>)
      ) {
        return (defaultValueOrOptions as Record<string, string>).defaultValue
      }
      return _key
    },
  }),
}))

// FileIcon 走 useSyncExternalStore 订阅 manifest，测试里不挂真实 manifest，
// stub 成占位 span 即可——本测试只关心文本与 error 分支，不关心图标。
vi.mock('@components/shared/file-icon/FileIcon', () => ({
  FileIcon: ({ fileName }: { fileName: string }) => (
    <span data-testid="file-icon" data-file={fileName} />
  ),
}))

import { FolderSearch } from './FolderSearch'

beforeEach(() => {
  mockRipgrepSearch.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// helper：输入后等 300ms 防抖 + mock resolve
async function typeAndWaitDebounce(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } })
  // doSearch 在 handleInputChange 的 300ms setTimeout 后触发；
  // waitFor 默认 1000ms timeout，足够覆盖防抖 + mock microtask
  await waitFor(() => {
    expect(mockRipgrepSearch).toHaveBeenCalled()
  })
}

describe('FolderSearch —  搜索功能无效修复回归', () => {
  it('成功：ripgrepSearch success:true → 渲染结果 + 行号', async () => {
    mockRipgrepSearch.mockResolvedValue({
      success: true,
      results: [
        { file: '/agent/foo.txt', line: 12, column: 3, text: 'hello world', matchText: 'hello' },
      ],
      truncated: false,
    })

    render(
      <FolderSearch
        rootPath="/agent"
        onSelectResult={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    const input = screen.getByPlaceholderText('搜索文件或文件夹...')
    await typeAndWaitDebounce(input, 'hello')

    expect(screen.getByText('foo.txt')).toBeTruthy()
    expect(screen.getByText(':12')).toBeTruthy()
    expect(screen.queryByText('搜索失败')).toBeNull()
    expect(screen.queryByText('无匹配结果')).toBeNull()
  })

  it('失败显式反馈：success:false → 渲染「搜索失败」+ 后端 error，不再静默落进「无匹配结果」', async () => {
    // 复现  现象：之前 res.success === false 走 setResults([])，
    // hasSearched 仍为 true，UI 落进 noResults 分支显示「无匹配结果」。
    // 用户搜什么都是「无匹配结果」，看起来就是「搜索功能无效」。
    mockRipgrepSearch.mockResolvedValue({
      success: false,
      error: 'ripgrep (rg) is not installed',
      results: [],
    })

    render(
      <FolderSearch
        rootPath="/agent"
        onSelectResult={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    const input = screen.getByPlaceholderText('搜索文件或文件夹...')
    await typeAndWaitDebounce(input, 'foo')

    expect(screen.getByText('搜索失败')).toBeTruthy()
    expect(screen.getByText(/ripgrep .* is not installed/)).toBeTruthy()
    // 关键回归点：失败时绝不显示「无匹配结果」——那是另一个分支
    expect(screen.queryByText('无匹配结果')).toBeNull()
  })

  it('抛错显式反馈：IPC reject → 渲染「搜索失败」+ 异常 message', async () => {
    mockRipgrepSearch.mockRejectedValue(new Error('IPC channel not registered'))

    render(
      <FolderSearch
        rootPath="/agent"
        onSelectResult={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    const input = screen.getByPlaceholderText('搜索文件或文件夹...')
    await typeAndWaitDebounce(input, 'foo')

    expect(screen.getByText('搜索失败')).toBeTruthy()
    expect(screen.getByText('IPC channel not registered')).toBeTruthy()
  })

  it('Windows 路径兼容：ripgrep 返回 C:\\... 而 rootPath 是 C:/... → 相对路径正确截掉 root 前缀', async () => {
    // Windows 下 ripgrep 返回的 file 路径用 `\` 分隔，FileExplorerPane 把 rootPath
    // normalize 成 `/`。之前 startsWith 比较永远不成立，UI 会铺整个绝对路径。
    mockRipgrepSearch.mockResolvedValue({
      success: true,
      results: [
        { file: 'C:\\Users\\me\\TabTin\\agent\\notes.md', line: 3, column: 0, text: '# title', matchText: 'title' },
      ],
      truncated: false,
    })

    render(
      <FolderSearch
        rootPath="C:/Users/me/TabTin/agent"
        onSelectResult={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    const input = screen.getByPlaceholderText('搜索文件或文件夹...')
    await typeAndWaitDebounce(input, 'title')

    expect(screen.getByText('notes.md')).toBeTruthy()
    // 关键回归点：不能把整个 Windows 绝对路径铺到 UI
    expect(screen.queryByText('C:\\Users\\me\\TabTin\\agent\\notes.md')).toBeNull()
    expect(screen.queryByText(/C:\\Users\\/)).toBeNull()
  })

  it('目录名称命中：渲染文件夹结果，点击时传 isDirectory=true', async () => {
    const onSelectResult = vi.fn()
    mockRipgrepSearch.mockResolvedValue({
      success: true,
      results: [
        {
          file: 'C:\\Users\\me\\TabTin\\agent\\666-folder',
          line: 0,
          column: 0,
          text: '666-folder',
          matchText: '666',
          matchKind: 'path',
          isDirectory: true,
        },
      ],
      truncated: false,
    })

    render(
      <FolderSearch
        rootPath="C:/Users/me/TabTin/agent"
        onSelectResult={onSelectResult}
        onClose={vi.fn()}
      />,
    )

    const input = screen.getByPlaceholderText('搜索文件或文件夹...')
    await typeAndWaitDebounce(input, '666')

    expect(mockRipgrepSearch).toHaveBeenCalledWith(expect.objectContaining({
      includePathMatches: true,
    }))
    expect(screen.getByText('666-folder')).toBeTruthy()
    expect(screen.getByText('文件夹名称匹配')).toBeTruthy()
    expect(screen.queryByText(':0')).toBeNull()

    fireEvent.click(screen.getByText('666-folder'))
    expect(onSelectResult).toHaveBeenCalledWith(
      'C:\\Users\\me\\TabTin\\agent\\666-folder',
      0,
      true,
    )
  })

  it('rootPath 变化时清空：切目录后旧 query / results 不残留', async () => {
    mockRipgrepSearch.mockResolvedValue({
      success: true,
      results: [
        { file: '/old/foo.txt', line: 1, column: 0, text: 'foo', matchText: 'foo' },
      ],
      truncated: false,
    })

    const { rerender } = render(
      <FolderSearch
        rootPath="/old"
        onSelectResult={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    const input = screen.getByPlaceholderText('搜索文件或文件夹...')
    await typeAndWaitDebounce(input, 'foo')

    expect(screen.getByText('foo.txt')).toBeTruthy()

    // 切到新目录：rootPath 变化 → useEffect 清空 query / results
    rerender(
      <FolderSearch
        rootPath="/new"
        onSelectResult={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    // query 清空 → input value 为空
    expect((input as HTMLInputElement).value).toBe('')
    // results 清空 → 不再渲染旧目录的 foo.txt
    expect(screen.queryByText('foo.txt')).toBeNull()
  })

  it('空 query 不发起 IPC 调用，清空 results', async () => {
    mockRipgrepSearch.mockResolvedValue({ success: true, results: [], truncated: false })

    render(
      <FolderSearch
        rootPath="/agent"
        onSelectResult={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    const input = screen.getByPlaceholderText('搜索文件或文件夹...')
    // 输入空格（trim 后为空）→ doSearch 提前 return，不调 IPC
    fireEvent.change(input, { target: { value: '   ' } })

    // 给防抖 timer 一点时间确认没触发 IPC
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400))
    })
    expect(mockRipgrepSearch).not.toHaveBeenCalled()
    expect(screen.queryByText('搜索失败')).toBeNull()
    expect(screen.queryByText('无匹配结果')).toBeNull()
  })
})
