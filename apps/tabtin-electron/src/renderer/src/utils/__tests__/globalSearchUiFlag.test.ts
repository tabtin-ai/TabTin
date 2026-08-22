import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GLOBAL_SEARCH_UI_ENABLED } from '@/utils/featureFlags'

/**
 * 统一搜索未 go-live 前，客户端入口必须默认关闭。
 * 引擎就绪后改 flag 时本测试会红，提醒同步打开顶栏 / Cmd+K / 宿主。
 */
describe('GLOBAL_SEARCH_UI_ENABLED', () => {
  it('defaults to false until search engine go-live', () => {
    expect(GLOBAL_SEARCH_UI_ENABLED).toBe(false)
  })

  it('Cmd+K shortcut respects the flag', () => {
    const src = readFileSync(
      resolve(__dirname, '../../components/app/AppGlobalEffects.tsx'),
      'utf8',
    )
    expect(src).toMatch(/GLOBAL_SEARCH_UI_ENABLED/)
    expect(src).toMatch(/if\s*\(\s*!GLOBAL_SEARCH_UI_ENABLED\s*\)\s*return/)
  })

  it('top bar search trigger is gated', () => {
    const src = readFileSync(
      resolve(__dirname, '../../components/layout/ShellTopBarGlobalSearchTrigger.tsx'),
      'utf8',
    )
    expect(src).toMatch(/GLOBAL_SEARCH_UI_ENABLED/)
    expect(src).toMatch(/if\s*\(\s*!GLOBAL_SEARCH_UI_ENABLED\s*\)\s*\{\s*return null/)
  })
})
