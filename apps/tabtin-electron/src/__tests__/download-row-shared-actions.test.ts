import { describe, it, expect, vi, beforeEach } from 'vitest'

const { toastMock, storeState } = vi.hoisted(() => ({
  toastMock: vi.fn(),
  storeState: {
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    cancelStream: vi.fn(),
    open: vi.fn(),
    showInFolder: vi.fn(),
    removeItem: vi.fn(),
    retry: vi.fn(),
    deleteFile: vi.fn(),
    removeStreamItem: vi.fn(),
    clearCompleted: vi.fn(),
  },
}))

vi.mock('@tabtin/smartsheet-ui/toast', () => ({
  toast: toastMock,
}))

vi.mock('@stores/useDownloadStore', () => ({
  useDownloadStore: {
    getState: () => storeState,
  },
}))

vi.mock('@/i18n', () => ({
  default: {
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  },
}))

import { storeActions } from '../renderer/src/components/crawl/DownloadRowShared'

function setTabtinShell(shell: Record<string, unknown>) {
  Object.defineProperty(window, 'tabtin', {
    configurable: true,
    writable: true,
    value: shell,
  })
}

describe('DownloadRowShared storeActions shell path actions', () => {
  beforeEach(() => {
    toastMock.mockReset()
    vi.clearAllMocks()
  })

  it('opens a completed file through the legacy shell IPC success path', async () => {
    const openPath = vi.fn(async () => ({ success: true }))
    setTabtinShell({ openPath })

    await storeActions.openPath('C:\\Users\\me\\Downloads\\doc.docx')

    expect(openPath).toHaveBeenCalledWith('C:\\Users\\me\\Downloads\\doc.docx')
    expect(toastMock).not.toHaveBeenCalled()
  })

  it('shows a toast when openPath returns legacy success:false', async () => {
    setTabtinShell({
      openPath: vi.fn(async () => ({ success: false, error: '文件已被移动或删除' })),
    })

    await storeActions.openPath('C:\\Users\\me\\Downloads\\missing.docx')

    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      title: '打开文件失败',
      description: '文件已被移动或删除',
      variant: 'destructive',
    }))
  })

  it('shows a toast when showItemInFolder is unavailable', async () => {
    setTabtinShell({})

    await storeActions.showPathInFolder('C:\\Users\\me\\Downloads\\doc.docx')

    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      title: '在文件夹中显示失败',
      description: '文件操作不可用',
      variant: 'destructive',
    }))
  })

  it('shows a toast when showItemInFolder returns legacy success:false', async () => {
    setTabtinShell({
      showItemInFolder: vi.fn(async () => ({ success: false, error: '路径不合法' })),
    })

    await storeActions.showPathInFolder('C:\\Users\\me\\Downloads\\blocked.docx')

    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      title: '在文件夹中显示失败',
      description: '路径不合法',
      variant: 'destructive',
    }))
  })
})
