import { describe, expect, it } from 'vitest'
import { resolvePageLoadErrorCopy } from './page-load-error-copy'

const t = (key: string) => {
  const map: Record<string, string> = {
    'workspace.pageLoadFailed': '页面加载失败',
    'workspace.pageLoadFailedDesc': '无法连接到该网页，请检查网络或稍后重试',
    'workspace.pageLoadErrors.dns.title': '域名无法解析',
    'workspace.pageLoadErrors.dns.hint': '请检查网址是否正确',
    'workspace.pageLoadErrors.offline.title': '网络断开',
    'workspace.pageLoadErrors.offline.hint': '请检查网络连接后重试',
    'workspace.pageLoadErrors.connection.title': '无法连接服务器',
    'workspace.pageLoadErrors.connection.hint': '请稍后重试，或检查网址是否正确',
    'workspace.pageLoadErrors.server.title': '服务器错误',
    'workspace.pageLoadErrors.server.hint': '请稍后重试',
  }
  return map[key] ?? key
}

describe('resolvePageLoadErrorCopy', () => {
  it('uses kind copy for dns/offline/connection/server', () => {
    expect(resolvePageLoadErrorCopy({
      errorDescription: 'ERR_NAME_NOT_RESOLVED',
      fallbackMessage: 'ERR_NAME_NOT_RESOLVED',
      t,
    })).toEqual({ title: '域名无法解析', message: '请检查网址是否正确' })

    expect(resolvePageLoadErrorCopy({
      errorDescription: 'HTTP 500',
      fallbackMessage: 'HTTP 500',
      t,
    })).toEqual({ title: '服务器错误', message: '请稍后重试' })
  })

  it('keeps legacy title/message for fallback', () => {
    expect(resolvePageLoadErrorCopy({
      errorDescription: 'ERR_CERT_AUTHORITY_INVALID',
      fallbackMessage: 'ERR_CERT_AUTHORITY_INVALID',
      t,
    })).toEqual({
      title: '页面加载失败',
      message: 'ERR_CERT_AUTHORITY_INVALID',
    })

    expect(resolvePageLoadErrorCopy({
      errorDescription: null,
      fallbackMessage: null,
      t,
    })).toEqual({
      title: '页面加载失败',
      message: '无法连接到该网页，请检查网络或稍后重试',
    })
  })
})
