/** @store-category ui */

/**
 * useAgentSettingsSheetStore — Agent 档案侧边设置面板状态
 *
 * 配合 `AgentProfilePane` + `AgentSettingsSheet` 使用：档案主页是一张
 * 静态名片 + 模块列表，每个模块的"添加 / 编辑"会通过本 store 唤起一个
 * 右侧 Sheet（侧边展开的详细配置面板）。
 *
 * 设计模仿 `useFieldSettingStore`：单一打开状态 + section 路由。
 */

import { create } from 'zustand'

/**
 * 档案模块对应的 section 路由 key。
 *
 * `profile-*` 来自档案"名片"区的拆分（名字+头像+描述+角色设定、自定义规则）。
 * 其余 key 与 `SpaceSettingsPane` 历史 WORKSPACE_NAV_ITEMS 对齐，方便复用现有
 * 子面板组件（AgentSecurityPanel / MemoryPanel / DevicePanel / ...）。
 *
 * ── 对象边界预留（设置 IA 重构 PRD §3.3 / §5.3 / §8.7，Phase 4）──
 * 当前 Agent 与 Space 一对一绑定，本档案页混着「Agent 对象」与「Space 对象」两类设置。
 * 下列以 [对象边界:S=Space属性] 标记的 section 属于 **Space 对象属性**（非 Agent 对象）：
 * 一对一绑定下暂留 Agent 资料页，待多 Agent 进入 Space 开放后，必须从 Agent
 * 设置迁出到 Space 设置（对应 PRD §5.3「对象」列标「S」的 6 项）。此处不拆库、不动
 * 逻辑，仅打统一标记便于未来 grep 检索迁移点。
 */
export type AgentSettingsSection =
  | 'profile-identity' // [对象边界:S=Space属性] 身份/名片，多 Agent 后归 Space
  | 'profile-rules'
  | 'working-dir'
  // 'apps'（应用管理）入口已屏蔽：应用启用属于组织层的权限分发，不再作为 Space 管理的模块
  | 'memory'
  | 'subagents'
  // 'extensions'（集成能力）入口已屏蔽：Personal Plugin + Extension 混排体验未定型，暂不在 Agent 设置暴露
  | 'extensions'
  | 'device'
  | 'security'
  | 'execution-limits'
  // 'channels'（对外渠道）入口已屏蔽：Bot 外部渠道接入尚未产品化，Space 管理不再承载
  // 'api'（开发者 API）入口已屏蔽：Space 级开发者 API 不再在 Agent 设置中暴露
  | 'archived' // [对象边界:S=Space属性] 归档对话（Space 生命周期），多 Agent 后归 Space
// 'trash' 已迁至「团队设置 → 资源回收站」（/#2253），不再是 Agent/Space 设置 section

export interface AgentSettingsSheetOpenOptions {
  /**
   * 打开后立刻引导重选工作目录（系统文件夹选择器）。
   * 用于顶部「目录不可访问」横幅 / 起始页失效卡的「重新选择…」——
   * 只打开设置面板不够，用户期望点下去就能换目录。
   */
  relocate?: boolean
  /**
   * 打开安全面板时绑定的目标会话。
   * 从 ChatInput 进入时必须显式传入，避免 Space 设置面板误写全局当前会话。
   */
  sessionId?: string | null
}

export interface AgentSettingsSheetStore {
  /** 面板是否打开 */
  isOpen: boolean
  /** 当前展开的模块 */
  section: AgentSettingsSection | null
  /** 触发面板的 Space ID（多 Agent 场景下用于作用域隔离） */
  spaceId: string | null
  /** 触发面板时绑定的会话 ID；缺省时由面板按 spaceId 回退解析。 */
  sessionId: string | null
  /**
   * 递增 nonce：working-dir 表单订阅后弹出选目录器。
   * 用 nonce 而非 boolean，保证「面板已打开时再点重新选择」仍会触发。
   */
  relocateNonce: number

  /** 打开指定模块 */
  open: (
    section: AgentSettingsSection,
    spaceId?: string | null,
    options?: AgentSettingsSheetOpenOptions,
  ) => void
  /** 关闭面板 */
  close: () => void
}

export const useAgentSettingsSheetStore = create<AgentSettingsSheetStore>()((set) => ({
  isOpen: false,
  section: null,
  spaceId: null,
  sessionId: null,
  relocateNonce: 0,

  open: (section, spaceId, options) => {
    // 入口已屏蔽的 section 不打开 Sheet，避免深链 / 通知残留落到空白面板
    if (section === 'extensions') return
    set((state) => ({
      isOpen: true,
      section,
      spaceId: spaceId ?? null,
      sessionId: options?.sessionId ?? null,
      relocateNonce:
        options?.relocate && section === 'working-dir'
          ? state.relocateNonce + 1
          : state.relocateNonce,
    }))
  },

  close: () =>
    set({
      isOpen: false,
      section: null,
      spaceId: null,
      sessionId: null,
    }),
}))
