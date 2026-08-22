import { describe, expect, it } from 'vitest'
import { formatDirReadErrorForUser } from '../ipc-error'

function t(key: string, options?: { defaultValue?: string }): string {
  const messages: Record<string, string> = {
    'errorToast.dirReadOutsideWorkspace': '该目录尚未授权访问。请先在 TabFolder/TabCode 中打开此目录授权，或在 Agent Security 设置中开启超级权限。',
    'errorToast.dirReadPermissionDenied': '无法读取该目录，可能没有访问权限。',
    'errorToast.dirReadFailed': '目录读取失败',
  }
  return messages[key] ?? options?.defaultValue ?? key
}

describe('formatDirReadErrorForUser', () => {
  it('localizes outside-workspace directory read errors', () => {
    const message = formatDirReadErrorForUser(
      new Error("Path 'C:\\Program Files\\TabTin Preprod\\tabtin-desktop' is outside your workspace. Open this folder in TabFolder/TabCode to authorize, or toggle Super Permissions in Agent Security settings."),
      t,
    )

    expect(message).toBe('该目录尚未授权访问。请先在 TabFolder/TabCode 中打开此目录授权，或在 Agent Security 设置中开启超级权限。')
    expect(message).not.toContain('outside your workspace')
    expect(message).not.toContain('Super Permissions')
  })

  it('localizes OS permission directory read errors', () => {
    expect(formatDirReadErrorForUser('EACCES: permission denied, scandir C:\\Windows', t))
      .toBe('无法读取该目录，可能没有访问权限。')
  })
})
