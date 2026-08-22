import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const toastMock = vi.fn()

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: (...args: unknown[]) => toastMock(...args),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const messages: Record<string, string> = {
        'fileOps.createSuccess': `已创建 ${options?.name ?? ''}`,
        'fileOps.createFailed': '创建失败',
        'fileOps.genericDenied': '操作被安全策略拦截。在目录中打开对应目录即可授权，或在 Settings 打开超级权限。',
        'fileOps.noWritePermission': '当前目录没有写入权限，无法完成本次文件操作。请修改目录权限，或选择可写目录。',
        'fileOps.parentMissing': '目标文件夹已不存在（可能被移动或改名），请刷新或重新选择目录后再试。',
        'fileOps.rootMissing': '目录根路径已不可访问，请重新选择目录后再试。',
      }
      return messages[key] ?? String(options?.defaultValue ?? key)
    },
  }),
}))

import { useFileTreeActions } from '../useFileTreeActions'

function installFileSystem(overrides: Partial<Record<'pathExists' | 'writeFile' | 'createDir', ReturnType<typeof vi.fn>>> = {}) {
  // 默认：父目录/根存在，待创建的叶子路径不存在（配合 ensureParentWritable + resolveUniqueEntryName）
  const pathExists = vi.fn().mockImplementation(async (targetPath: string) => {
    const base = targetPath.replace(/\\/g, '/').split('/').pop() ?? ''
    if (
      base === 'notes.md'
      || base === 'new-folder'
      || base.startsWith('notes-')
      || base.startsWith('new-folder-')
    ) {
      return { exists: false }
    }
    return { exists: true }
  })
  ;(window as unknown as Record<string, unknown>).tabtin = {
    fileSystem: {
      pathExists,
      writeFile: vi.fn().mockResolvedValue({ success: true }),
      createDir: vi.fn().mockResolvedValue({ success: true }),
      ...overrides,
    },
  }
}

describe('useFileTreeActions', () => {
  beforeEach(() => {
    toastMock.mockReset()
    installFileSystem()
  })

  it('localizes outside-workspace create-file failures and keeps the toast visible in quiet mode', async () => {
    installFileSystem({
      writeFile: vi.fn().mockResolvedValue({
        success: false,
        error: 'Path E:\\TabTin\\TabTin Preprod\\tabtin-desktop is outside your workspace. Open this folder in TabFolder/TabCode to authorize, or toggle Super Permissions in Agent Security settings.',
      }),
    })
    const onRefresh = vi.fn()
    const { result } = renderHook(() => useFileTreeActions({
      rootPath: 'E:/TabTin/TabTin Preprod',
      onRefresh,
      i18nNamespace: 'context',
      showSuccessToast: false,
    }))

    let ok = true
    await act(async () => {
      ok = await result.current.createFile('E:/TabTin/TabTin Preprod/tabtin-desktop', 'notes.md')
    })

    expect(ok).toBe(false)
    expect(onRefresh).not.toHaveBeenCalled()
    expect(toastMock).toHaveBeenCalledWith({
      title: '操作被安全策略拦截。在目录中打开对应目录即可授权，或在 Settings 打开超级权限。',
      preferNative: true,
    })
  })

  it('localizes outside-your-workspace failures without relying on other hint words', async () => {
    installFileSystem({
      writeFile: vi.fn().mockResolvedValue({
        success: false,
        error: 'Path E:\\locked\\notes.md is outside your workspace.',
      }),
    })
    const { result } = renderHook(() => useFileTreeActions({
      rootPath: 'E:/locked',
      onRefresh: vi.fn(),
      i18nNamespace: 'context',
      showSuccessToast: false,
    }))

    await act(async () => {
      await result.current.createFile('E:/locked', 'notes.md')
    })

    expect(toastMock).toHaveBeenCalledWith({
      title: '操作被安全策略拦截。在目录中打开对应目录即可授权，或在 Settings 打开超级权限。',
      preferNative: true,
    })
  })

  it('localizes OS write-permission create-directory failures', async () => {
    installFileSystem({
      createDir: vi.fn().mockResolvedValue({
        success: false,
        code: 'FS_PERMISSION_DENIED',
        error: 'EACCES: permission denied, mkdir C:\\Windows\\System32\\new-folder',
      }),
    })
    const { result } = renderHook(() => useFileTreeActions({
      rootPath: 'C:/Windows/System32',
      onRefresh: vi.fn(),
      i18nNamespace: 'context',
      showSuccessToast: false,
    }))

    let ok = true
    await act(async () => {
      ok = await result.current.createDirectory('C:/Windows/System32', 'new-folder')
    })

    expect(ok).toBe(false)
    expect(toastMock).toHaveBeenCalledWith({
      title: '当前目录没有写入权限，无法完成本次文件操作。请修改目录权限，或选择可写目录。',
      preferNative: true,
    })
  })

  it('keeps non-permission file operation failures as error toasts', async () => {
    installFileSystem({
      writeFile: vi.fn().mockResolvedValue({
        success: false,
        error: 'disk is full',
      }),
    })
    const { result } = renderHook(() => useFileTreeActions({
      rootPath: 'E:/project',
      onRefresh: vi.fn(),
      i18nNamespace: 'context',
      showSuccessToast: true,
    }))

    await act(async () => {
      await result.current.createFile('E:/project', 'notes.md')
    })

    expect(toastMock).toHaveBeenCalledWith({
      title: '创建失败',
      description: 'disk is full',
      variant: 'destructive',
      preferNative: true,
    })
  })

  it('blocks create when parent path no longer exists', async () => {
    const writeFile = vi.fn().mockResolvedValue({ success: true })
    installFileSystem({
      pathExists: vi.fn().mockResolvedValue({ exists: false }),
      writeFile,
    })
    const { result } = renderHook(() => useFileTreeActions({
      rootPath: '/Users/me/old-root',
      onRefresh: vi.fn(),
      i18nNamespace: 'context',
      showSuccessToast: false,
    }))

    let ok = true
    await act(async () => {
      ok = await result.current.createFile('/Users/me/old-root/src', 'notes.md')
    })

    expect(ok).toBe(false)
    expect(writeFile).not.toHaveBeenCalled()
    expect(toastMock).toHaveBeenCalledWith({
      title: '目标文件夹已不存在（可能被移动或改名），请刷新或重新选择目录后再试。',
      preferNative: true,
    })
  })
})
