/**
 * renderInsideContextHome 声明契约
 *
 * 此前 apphome.tsx 用硬编码白名单 RESOURCE_TYPE_APPS = {tabdata, tabdoc, tabslide,
 * tabfolder, tabfiles, tabsite} 决定哪些 App 在独立
 * apphome 标签页里展示完整 ContextHome 容器，新增 App 极易遗漏（DM-064 / TabPhone
 * 设备列表无响应都源于此）。
 *
 * 现已迁移为由 HomeSectionHandler.renderInsideContextHome 自声明：
 * - 资源列表型 Section（createResourceListSection 系列 + tabdata/tabsite/tabfolder）
 *   声明 true，保留旧行为
 * - 工具/设备型 Section 默认 false，渲染轻量视图
 *
 * 该测试锁定预期声明，防止重构 / 复制粘贴新 Section 时再次踩坑。
 */
import { describe, it, expect } from 'vitest'

// ContextHome / SpaceApi 等会被 createResourceListSection 间接引入；
// 这里只读 handler 元数据声明，所以 stub 掉运行时依赖即可。
import { vi } from 'vitest'
vi.mock('@components/context-space/ContextHome', () => ({ ContextHome: () => null }))
vi.mock('@/services/spaceApi', () => ({ SpaceApiService: { pinContextItem: vi.fn() } }))

import { tabdataHomeSection } from '../tabdata'
import { tabsiteHomeSection } from '../tabsite'
import { tabdocHomeSection } from '../tabdoc'
import { tabslideHomeSection } from '../tabslide'

// 单根契约（docs/single-root-space-prd.md）：tabcode / tabfolder 不再有独立
// HomeSection——它们是 Agent 目录的内嵌视图（由 Orchestration HomeSection 按
// working_dir_type 自动渲染 TabCode 或 TabFolder 视图），所以从 renderInside-
// ContextHome 的契约表里移除，这两个 App 在侧边栏完全消失。
describe('HomeSectionHandler.renderInsideContextHome 声明契约', () => {
  describe('资源列表型 App 应声明为 true（独立 apphome 走完整 ContextHome）', () => {
    it.each([
      ['tabdata', tabdataHomeSection],
      ['tabsite', tabsiteHomeSection],
      ['tabdoc', tabdocHomeSection],
      ['tabslide', tabslideHomeSection],
    ])('%s', (_label, section) => {
      expect(section.renderInsideContextHome).toBe(true)
    })
  })

})
