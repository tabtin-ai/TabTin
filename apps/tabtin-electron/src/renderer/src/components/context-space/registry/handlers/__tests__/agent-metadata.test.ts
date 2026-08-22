/**
 * Handler agent metadata 守门测试。
 *
 * 这些断言锁定的契约：
 *
 *   1. 凡是声明了 `quickAction`（"+ 新建" 入口的 App）的 handler，**必须**也声明
 *      `agent` 元信息——否则用户能创建该 App 资源，但 Agent 跟用户对话时不知
 *      道有这个 App，导致"我能创建多维表，但你问我能做什么我答不出多维表"的
 *      用户视角 bug。
 *
 *   2. `agent.displayName` 跟同一 handler 的 i18n `labelKey` 派生的中文显示名
 *      （zh-CN locale）一致。两路硬编码各自维护时容易漂移——产品改了 i18n
 *      label 忘了同步 agent.displayName 就会让 Agent 跟用户口语的产品名不一致。
 *
 *   3. capability 长度合理（≥10 字 + ≤120 字），避免文案极端：太短没信息量，
 *      太长占 prompt token。这是 P1 软约束（不致命，但能压制无脑长文案）。
 *
 *   4. apphome handler **不应**声明 agent 字段——它是抽象 tab type，不该出现
 *      在 `<apps>` 段（首页本身不是一个 App，它是某个 App 的首页）。
 *
 * 加这套测试是 review #4（agent.displayName ↔ i18n 漂移风险）的兑现方式：
 * 用户选 "保持硬编码 + 加 lint/单测约束"。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { contextRegistry } from '../../index'
import i18n from '@/i18n'

describe('Handler agent metadata 守门契约', () => {
  it('凡是声明 quickAction 的 App handler 都必须声明 agent 元信息', () => {
    const handlers = contextRegistry.getAllHandlers()
    const violators = handlers
      .filter(h => h.quickAction && !h.agent)
      .map(h => h.type)
    expect(violators).toEqual([])
  })

  it('agent.displayName 跟 i18n labelKey 的 zh-CN 派生名字一致（或者 handler 没声明 labelKey）', () => {
    const handlers = contextRegistry.getAgentExposedHandlers()
    // searchLabelKey 是产品对外的"中文显示名"权威源。如果 labelKey 在 zh-CN
    // 有翻译，agent.displayName 必须跟它一致；如果没翻译就跳过（极少数情况）。
    const drifts: Array<{ type: string; i18n: string; agent: string }> = []
    for (const handler of handlers) {
      if (!handler.searchLabelKey) continue
      const i18nName = i18n.t(handler.searchLabelKey, { lng: 'zh-CN' })
      // i18n 返回 key 本身说明没翻译——跳过
      if (i18nName === handler.searchLabelKey) continue
      if (typeof i18nName !== 'string' || !i18nName.trim()) continue
      if (i18nName !== handler.agent.displayName) {
        drifts.push({ type: handler.type as string, i18n: i18nName, agent: handler.agent.displayName })
      }
    }
    // 失败时打印漂移清单方便修复。如果有 drift 就 fail——CI 不放行。
    expect(drifts).toEqual([])
  })

  it('agent.capability 长度 ≥10 且 ≤120 字（软约束，挡极端文案）', () => {
    const handlers = contextRegistry.getAgentExposedHandlers()
    const issues: Array<{ type: string; len: number; capability: string }> = []
    for (const handler of handlers) {
      const len = handler.agent.capability.length
      if (len < 10 || len > 120) {
        issues.push({ type: handler.type as string, len, capability: handler.agent.capability })
      }
    }
    expect(issues).toEqual([])
  })

  it('agent.capability 不写 tabtin 子命令', () => {
    const handlers = contextRegistry.getAgentExposedHandlers()
    const issues: Array<{ type: string; capability: string }> = []
    for (const handler of handlers) {
      if (/tabtin/i.test(handler.agent.capability)) {
        issues.push({ type: handler.type as string, capability: handler.agent.capability })
      }
    }
    expect(issues).toEqual([])
  })

  it('agent.capability 只写正向能力，不承担跨 App 排除清单', () => {
    const handlers = contextRegistry.getAgentExposedHandlers()
    const issues: Array<{ type: string; capability: string }> = []
    for (const handler of handlers) {
      if (/不适用于|不用于|改用|用「/.test(handler.agent.capability)) {
        issues.push({ type: handler.type as string, capability: handler.agent.capability })
      }
    }
    expect(issues).toEqual([])
  })

  it('apphome handler 不声明 agent 字段（它是抽象 tab type，不是 App 本身）', () => {
    const apphome = contextRegistry.getHandler('apphome')
    expect(apphome).toBeDefined()
    expect(apphome?.agent).toBeUndefined()
  })

  it('getAgentExposedHandlers 不返回 apphome / tabsettings / 浏览器子页面这类系统 tab', () => {
    const exposed = contextRegistry.getAgentExposedHandlers().map(h => h.type as string)
    expect(exposed).not.toContain('apphome')
    expect(exposed).not.toContain('tabsettings')
    expect(exposed).not.toContain('tinbookmarks')
    expect(exposed).not.toContain('tindownloads')
    expect(exposed).not.toContain('tinhistory')
  })

  it.each([
    'tabsite',
  ])(
    '#5353 临时屏蔽的 %s 不进入 Agent App 清单',
    (appId) => {
      const exposed = contextRegistry.getAgentExposedHandler(appId)
      const exposedAppIds = contextRegistry.getAgentExposedHandlers()
        .map(handler => handler.appId ?? (handler.type as string))

      expect(exposed).toBeUndefined()
      expect(exposedAppIds).not.toContain(appId)
    },
  )

  it('#8695 TabSlide 恢复 Agent `<apps>` 元数据；默认 UI 入口仍关闭', () => {
    const exposed = contextRegistry.getAgentExposedHandler('tabslide')
    expect(exposed).toBeDefined()
    expect(exposed?.agent?.cliKey).toBe('slide')
    expect(exposed?.agent?.displayName).toBe('演示')
    // UI 关闭（默认 TABSLIDE_UI_ENABLED=false）：无 quickAction / 搜索元数据
    expect(exposed?.quickAction).toBeUndefined()
    expect(exposed?.searchable).toBe(false)
    expect(exposed?.searchLabelKey).toBeUndefined()
    // Home section stem 仍在 HIDDEN_APPS，不影响 handler 注册
    expect(contextRegistry.getHandler('tabslide')).toBeDefined()
    expect(contextRegistry.getHandlerByAppId('tabslide')).toBeDefined()
  })

  it.each(['tabfiles', 'tabcode', 'tabslide'])(
    '#5353 /  保留的 %s 继续进入本地 Agent App 清单',
    (appId) => {
      expect(contextRegistry.getAgentExposedHandler(appId)).toBeDefined()
    },
  )

  it('Remote manifest 闸门：未交付项仍关闭；tabslide 已恢复 hasPromptSection', () => {
    const hasPromptSection = (appId: string): boolean => {
      const manifestPath = resolve(process.cwd(), `../../packages/apps/${appId}/app.json`)
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        agentIntegration: { hasPromptSection: boolean }
      }
      return manifest.agentIntegration.hasPromptSection
    }

    for (const appId of [
      'tabsite',
      // hotfix 不夹带扩面：tabfiles Remote 段保持关闭
      'tabfiles',
      // marketplace 演示样板：不进生产 Agent 上下文
      'tabtin-demo-app',
    ]) {
      expect(hasPromptSection(appId), appId).toBe(false)
    }
    expect(hasPromptSection('tabslide')).toBe(true)
  })

  //  / ：内置浏览器 handler 的 appMeta.resolve 靠 getState()
  // 读 crawl view 快照，必须声明 URL + title 依赖，才能让 useChatPanelContext
  // 在同标签页导航和标题稍晚到达时重算 activeAppMeta。
  it('浏览器 handler 声明 crawl view URL/title 依赖，保证当前页上下文刷新', () => {
    const browser = contextRegistry.getHandler('tabweb')
    expect(browser?.appMeta?.resolve).toBeTypeOf('function')
    expect(browser?.appMeta?.metaDeps?.useCrawlViewUrl).toBe(true)
    expect(browser?.appMeta?.metaDeps?.useCrawlViewTitle).toBe(true)
  })
})
