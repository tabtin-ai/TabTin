/**
 * browser-container-mode flag 判定测试
 *
 * flag 关闭 = 现状零变化的第一道保险：任何未知/缺省输入都必须回落 'wcv'。
 */

import { describe, it, expect } from 'vitest'
import {
  parseBrowserContainerMode,
  resolveBrowserContainerMode,
  buildBrowserContainerArgv,
  parseBrowserContainerModeFromArgv,
  BROWSER_CONTAINER_ARGV_PREFIX,
} from '../browser-container-mode'

describe('browser-container-mode', () => {
  it('缺省 / 未知 / 空值一律回落 wcv', () => {
    expect(parseBrowserContainerMode(undefined)).toBe('wcv')
    expect(parseBrowserContainerMode(null)).toBe('wcv')
    expect(parseBrowserContainerMode('')).toBe('wcv')
    expect(parseBrowserContainerMode('wcv')).toBe('wcv')
    expect(parseBrowserContainerMode('WEBVIEW')).toBe('wcv') // 大小写敏感，防误开
    expect(parseBrowserContainerMode('webview ')).toBe('wcv')
  })

  it('只有精确的 webview 字面量开启新容器', () => {
    expect(parseBrowserContainerMode('webview')).toBe('webview')
  })

  it('resolveBrowserContainerMode 读 TABTIN_BROWSER_CONTAINER', () => {
    expect(resolveBrowserContainerMode({}, undefined)).toBe('wcv')
    expect(resolveBrowserContainerMode({ TABTIN_BROWSER_CONTAINER: 'webview' }, undefined)).toBe('webview')
    expect(resolveBrowserContainerMode({ TABTIN_BROWSER_CONTAINER: 'bogus' }, undefined)).toBe('wcv')
  })

  it('判定顺序：运行时 env > 构建期烘焙 > 默认 wcv', () => {
    // 无运行时 env → 用烘焙值（打包形态的唯一开启通道）
    expect(resolveBrowserContainerMode({}, 'webview')).toBe('webview')
    // 运行时 env 覆盖烘焙值（排障：终端启动 packaged app 强制回 wcv）
    expect(resolveBrowserContainerMode({ TABTIN_BROWSER_CONTAINER: 'wcv' }, 'webview')).toBe('wcv')
    expect(resolveBrowserContainerMode({ TABTIN_BROWSER_CONTAINER: 'webview' }, 'wcv')).toBe('webview')
    // 烘焙值同样只认精确 webview 字面量，防 profile 配错误开
    expect(resolveBrowserContainerMode({}, 'bogus')).toBe('wcv')
    expect(resolveBrowserContainerMode({}, 'WEBVIEW')).toBe('wcv')
    // 都缺省 → wcv
    expect(resolveBrowserContainerMode({}, undefined)).toBe('wcv')
  })

  it('argv 往返：build → parse 一致', () => {
    expect(parseBrowserContainerModeFromArgv([buildBrowserContainerArgv('webview')])).toBe('webview')
    expect(parseBrowserContainerModeFromArgv([buildBrowserContainerArgv('wcv')])).toBe('wcv')
    expect(parseBrowserContainerModeFromArgv(['--other', '--flags'])).toBe('wcv')
    expect(parseBrowserContainerModeFromArgv([`${BROWSER_CONTAINER_ARGV_PREFIX}junk`])).toBe('wcv')
  })
})
