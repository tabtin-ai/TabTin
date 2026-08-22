/**
 * 渲染进程 feature flags 集中入口
 *
 * 设计目标：把"是否暴露调试 / 观测 / 实验入口"统一收口，避免
 * 每个组件各自写 `import.meta.env.X` 散得到处都是。
 *
 * 各 flag 的 dev / prod 语义：
 *   - dev mode：默认全开（开发者本地都能用，不需要配置 env）
 *   - packaged build：默认全关，仅当对应 profile 显式注入环境变量时才开
 *
 * Vite 会在 prod build 时把 `import.meta.env.DEV` 静态替换为 `false`，
 * 三元的第一个分支 dead-code-eliminate，prod bundle 里实际只剩
 * `import.meta.env.VITE_XXX === 'true'` 这一行。
 */

import { parseEmailLoginEnabled } from '@tabtin/shared/auth-forms'

/**
 * 调试 / 观测面板（LLMSnapshotPanel、BrowserResourceCenter 的 Developer 模式等）
 * 是否对用户可见。
 *
 * - dev mode：永远开，不读取 `VITE_ENABLE_DEBUG_PANELS`
 * - packaged build：仅当 profile env 注入 `VITE_ENABLE_DEBUG_PANELS=true` 才开
 *   （正式发版包默认关；本地测试包默认开；预发包按需可开）
 */
export const DEBUG_PANELS_ENABLED: boolean = import.meta.env.DEV
  ? true
  : import.meta.env.VITE_ENABLE_DEBUG_PANELS === 'true'

/**
 * 当前构建的发布通道标识，用于 UI 上做"预发"等显式标记。
 *
 * 通过 build 时注入的 `VITE_BUILD_PROFILE` 决定（默认 `'production'`）。
 * dev mode 下永远是 `'development'`。
 */
export const BUILD_PROFILE: 'development' | 'preprod' | 'production' | string =
  import.meta.env.DEV
    ? 'development'
    : (import.meta.env.VITE_BUILD_PROFILE as string) || 'production'

/**
 * 是否需要在 UI 上显著展示"非正式版"标记（标题栏后缀、版本水印等）。
 */
export const IS_PREPROD_BUILD: boolean = BUILD_PROFILE === 'preprod'

/**
 * 构建与服务端地址仅供开发和预发排障；正式包不向用户展示。
 */
export function isRuntimeVersionDetailsEnabled(buildProfile: string): boolean {
  return buildProfile !== 'production'
}

export const RUNTIME_VERSION_DETAILS_ENABLED = isRuntimeVersionDetailsEnabled(BUILD_PROFILE)

/**
 * Tins 入口是否对用户可见。
 *
 * 2026-06-03 决策：Tin 先收敛为「网页自动化脚本 + Agent 链接」的能力储备，
 * 暂不作为正式用户入口开放。底层 runtime / API 暂保留，等待产品口径和安全边界
 * 重新确认后再打开入口。
 */
export const TINS_UI_ENABLED: boolean = import.meta.env.VITE_ENABLE_TINS_UI === 'true'

/**
 * TabSlide App 入口是否对用户可见。
 *
 * 2026-07决策：当前版本 TabSlide App UI 暂不上线。Agent「做 PPT」的
 * 交付物改为工作目录内的本地 `.pptx` 文件（TabSlide 引擎降级为隐形渲染器，用
 * `tabtin slide export --output` 落地本地文件）。App 的 tab / Home 入口 / 快捷创建 /
 * composer preset / 更多应用总览一律隐藏；底层引擎、Django API、编辑器组件保留，
 * 上线时把本 flag 置真（或注入 `VITE_ENABLE_TABSLIDE_UI=true`）即可整体恢复。
 *
 * dev / packaged 一致默认关闭——保持与用户可见口径一致，便于验收隐藏后行为；
 * 需要临时打开编辑器验证时注入 `VITE_ENABLE_TABSLIDE_UI=true`。
 */
export const TABSLIDE_UI_ENABLED: boolean = import.meta.env.VITE_ENABLE_TABSLIDE_UI === 'true'

/**
 * Project（team_space 协作房间）入口是否对用户可见。
 *
 * 正式包默认关闭；dev / preprod（ACK test）默认打开，便于内测与 dogfood。
 * 构建期由 `VITE_ENABLE_PROJECTS_UI` 控制（见 `.env.preprod` / `.env.production`）。
 */
export const PROJECTS_UI_ENABLED: boolean = import.meta.env.DEV
  ? import.meta.env.VITE_ENABLE_PROJECTS_UI !== 'false'
  : import.meta.env.VITE_ENABLE_PROJECTS_UI === 'true'

/**
 * ChatGPT Codex 账号登录（订阅套餐入口）是否对用户可见。
 *
 * 正式包与 preprod 由构建 env 注入；`.env.production` / `.env.preprod` 现为 true。
 * 未注入时 packaged 仍默认关；dev 默认开。
 * 只挡模型配置入口；主进程 OAuth / LocalCodex 实现保留。
 */
export const OPENAI_CODEX_BYOK_UI_ENABLED: boolean = import.meta.env.DEV
  ? import.meta.env.VITE_ENABLE_OPENAI_CODEX_BYOK_UI !== 'false'
  : import.meta.env.VITE_ENABLE_OPENAI_CODEX_BYOK_UI === 'true'

/**
 * Space 生命周期「归档」入口是否对用户可见。
 *
 * Electron 客户端尚无「已归档 Space 列表 / 恢复」对等 UI，临时隐藏归档入口，
 * 避免用户归档后无法自行恢复。后端 API 与 AdminDash 能力保留。
 */
export const SPACE_ARCHIVE_UI_ENABLED = false

/**
 * Workspace 回收站入口是否对用户可见。
 *
 * 2026-07-15：暂不对客暴露「移入回收站」与「回收站 → Workspace 回收站」
 * Tab；「删除 Workspace」仍保留。后端 soft-delete / restore API 与面板实现
 * 保留；恢复时改为 `true`。跟踪：。
 */
export const SPACE_TRASH_UI_ENABLED = false

/**
 * 全局搜索（Cmd+K / 侧栏放大镜）入口是否对用户可见。
 *
 * 2026-07-14：统一搜索引擎（`SEARCH_ENGINE_ENABLED` + ES）尚未在 test/生产就绪，
 * 打开只会落到「engine_disabled」基础搜索且消息/Agent 等 Tab 恒空，体验误导。
 * 代码与 overlay 宿主保留；引擎 go-live 后再改为 `true`（或接
 * `VITE_ENABLE_GLOBAL_SEARCH_UI`）。跟踪：。
 */
export const GLOBAL_SEARCH_UI_ENABLED: boolean =
  import.meta.env.VITE_ENABLE_GLOBAL_SEARCH_UI === 'true'

/**
 * 主导航「云文档」域是否展示普通文件（tabfiles）列表/筛选/上传。
 *
 * ：云文档知识库式目录默认只收 tabdoc + tabdata；任务模式「更多」里的云盘
 * （cloud-resources / default 呈现）不受本开关约束，始终保留完整云盘能力。
 * 若要在云文档域也露出文件面：改为 `true`，或注入 `VITE_CLOUD_DOCS_SHOW_DRIVE=true`。
 */
export const CLOUD_DOCS_SHOW_DRIVE: boolean =
  import.meta.env.VITE_CLOUD_DOCS_SHOW_DRIVE === 'true'

/**
 * 登录 / 注册 / 找回密码是否允许邮箱作为标识符。
 *
 * 读 VITE_AUTH_EMAIL_LOGIN_ENABLED；未设置或去掉空白后小写不等于 'false' 则打开。
 * 打开时同一输入框收邮箱或手机号；关闭时只认大陆手机号。
 */
export const AUTH_EMAIL_LOGIN_ENABLED: boolean = parseEmailLoginEnabled(
  import.meta.env.VITE_AUTH_EMAIL_LOGIN_ENABLED,
)
