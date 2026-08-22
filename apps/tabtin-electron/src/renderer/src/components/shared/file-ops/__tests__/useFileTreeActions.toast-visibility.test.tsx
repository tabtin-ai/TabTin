import React from 'react'
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Toaster } from '@tabtin/smartsheet-ui/toast'
import { useFileTreeActions } from '../useFileTreeActions'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const messages: Record<string, string> = {
        'fileOps.createFailed': '创建失败',
        'fileOps.genericDenied': '操作被安全策略拦截。在目录中打开对应目录即可授权，或在 Settings 打开超级权限。',
        'fileOps.noWritePermission': '当前目录没有写入权限，无法完成本次文件操作。请修改目录权限，或选择可写目录。',
      }
      return messages[key] ?? String(options?.defaultValue ?? key)
    },
  }),
}))

function pathExistsMock(targetPath: string) {
  const base = targetPath.replace(/\\/g, '/').split('/').pop() ?? ''
  // 父目录存在；待创建叶子不存在，好让 create 走到 writeFile
  if (base === 'notes.md' || base.startsWith('notes-')) return { exists: false }
  return { exists: true }
}

function installFileSystem() {
  ;(window as unknown as Record<string, unknown>).tabtin = {
    fileSystem: {
      pathExists: vi.fn().mockImplementation(async (p: string) => pathExistsMock(p)),
      writeFile: vi.fn().mockResolvedValue({
        success: false,
        error: 'Path E:\\locked\\notes.md is outside your workspace.',
      }),
    },
  }
}

function installFileSystemWithOverlay() {
  ;(window as unknown as Record<string, unknown>).tabtin = {
    fileSystem: {
      pathExists: vi.fn().mockImplementation(async (p: string) => pathExistsMock(p)),
      writeFile: vi.fn().mockResolvedValue({
        success: false,
        error: 'Path E:\\locked\\notes.md is outside your workspace.',
      }),
    },
    overlay: {
      push: vi.fn().mockResolvedValue({ success: true }),
    },
  }
}

describe('useFileTreeActions toast visibility', () => {
  beforeEach(() => {
    installFileSystem()
  })

  afterEach(() => {
    cleanup()
    delete (window as unknown as { tabtin?: unknown }).tabtin
  })

  it('renders a visible toast through the app Toaster when create-file fails in quiet mode', async () => {
    render(<Toaster />)
    const { result } = renderHook(() => useFileTreeActions({
      rootPath: 'E:/locked',
      onRefresh: vi.fn(),
      i18nNamespace: 'context',
      showSuccessToast: false,
    }))

    await act(async () => {
      await result.current.createFile('E:/locked', 'notes.md')
    })

    await waitFor(() => {
      expect(screen.getAllByText('操作被安全策略拦截。在目录中打开对应目录即可授权，或在 Settings 打开超级权限。').length).toBeGreaterThan(0)
    })
  })

  it('keeps file-operation failures visible when the overlay bridge is present but not rendering', async () => {
    installFileSystemWithOverlay()
    render(<Toaster />)
    const { result } = renderHook(() => useFileTreeActions({
      rootPath: 'E:/locked',
      onRefresh: vi.fn(),
      i18nNamespace: 'context',
      showSuccessToast: false,
    }))

    await act(async () => {
      await result.current.createFile('E:/locked', 'notes.md')
    })

    await waitFor(() => {
      expect(screen.getAllByText('操作被安全策略拦截。在目录中打开对应目录即可授权，或在 Settings 打开超级权限。').length).toBeGreaterThan(0)
    })
  })
})
