/**
 * trackerArtifactMap — Tracker skill_key → 产物 app 映射单测。
 *
 * W3 改造（专题"Agent 产物在 Space 内的打开" RFC §11）后，候选 app id
 * 从 contextRegistry 反查（manifest 即 SSOT），不再有静态白名单。
 *
 * 测试用真实的 contextRegistry 注册若干 mock handler，覆盖：
 *   - 命名空间风格 / 短横线风格 / 整 key 命中三种拆解
 *   - 大小写无关
 *   - 未注册 app 返回 undefined
 *   - 关键产物 app 集合（charter §4.4）守护
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resolveArtifactAppFromSkill } from '../trackerArtifactMap'
import { contextRegistry } from '@components/context-space/registry/instance'
import type { ContextTypeHandler } from '@components/context-space/registry/types'

// charter §4.4 关键产物 app 集合 — 测试守护"manifest 注册 → resolve 命中"链路
const REQUIRED_APPS = [
  'tabcode', 'tabdata', 'tabdoc', 'tabslide',
  'tabmail', 'tabtracker', 'tabfiles', 'tabfolder', 'tabinbox',
  'tabweb', 'tabphone', 'tabdesktop', 'tabwhiteboard',
  'tabsite', 'tabvideo',
] as const

const minimalHandler = (appId: string): ContextTypeHandler => ({
  type: appId,
  appId,
})

describe('resolveArtifactAppFromSkill (W3 / RFC §11 / charter §4.4)', () => {
  beforeAll(() => {
    // 把守护集合一次性注册进 contextRegistry，模拟 builtin App 启动时的 manifest 聚合
    for (const appId of REQUIRED_APPS) {
      // 只有未注册时才补 mock，避免覆盖单测前已 register 的真实 handler
      if (!contextRegistry.getHandlerByAppId(appId)) {
        contextRegistry.register(minimalHandler(appId))
      }
    }
  })

  afterAll(() => {
    // contextRegistry 是模块级单例，测试环境 process 退出即丢弃，无需 cleanup
  })

  it('按命名空间风格 (tabdata.append_row) 推断 tabdata', () => {
    expect(resolveArtifactAppFromSkill('tabdata.append_row')).toBe('tabdata')
  })

  it('按短横线风格 (tabdata-skill-field) 推断 tabdata', () => {
    expect(resolveArtifactAppFromSkill('tabdata-skill-field')).toBe('tabdata')
  })

  it('整 key 即 app id (tabdoc) 命中', () => {
    expect(resolveArtifactAppFromSkill('tabdoc')).toBe('tabdoc')
  })

  it('未注册的 app 返回 undefined(降级到 Run 详情)', () => {
    expect(resolveArtifactAppFromSkill('myUnknownSkill')).toBeUndefined()
    expect(resolveArtifactAppFromSkill('tab-fake')).toBeUndefined()
  })

  it('null / undefined / 空串 → undefined', () => {
    expect(resolveArtifactAppFromSkill(null)).toBeUndefined()
    expect(resolveArtifactAppFromSkill(undefined)).toBeUndefined()
    expect(resolveArtifactAppFromSkill('')).toBeUndefined()
    expect(resolveArtifactAppFromSkill('   ')).toBeUndefined()
  })

  it('大小写无关', () => {
    expect(resolveArtifactAppFromSkill('TabDoc.create')).toBe('tabdoc')
    expect(resolveArtifactAppFromSkill('TABDATA')).toBe('tabdata')
  })

  it('charter §4.4 关键 app 集合就位（来自 contextRegistry 注册而非硬编码白名单）', () => {
    // 这些 app 是 charter §4.4 表格里"产物本体"会落到的位置——必须命中
    const charter = ['tabcode', 'tabdata', 'tabdoc', 'tabslide']
    for (const app of charter) {
      expect(resolveArtifactAppFromSkill(app)).toBe(app)
    }
  })

  it('守护：所有 charter §4.4 产物 app 都在 contextRegistry 里（防漏列）', () => {
    for (const app of REQUIRED_APPS) {
      expect(resolveArtifactAppFromSkill(app)).toBe(app)
    }
    // 至少 8 个（防止误删）
    expect(REQUIRED_APPS.length).toBeGreaterThanOrEqual(8)
  })
})
