/**
 * Tool Error Kind Catalog —— PRD 08 W13（L-35 / L-24 收口）
 *
 * **背景**：W12 把 capability 错误统一为 `jsonError(message, metadata)`；W13 把
 * `src/tools/` 下散落的 `{ content: JSON.stringify(...), isError: true }` 也收口
 * 到同一形态。但单纯统一形态还不够——前端 / observability / dogfood 都希望
 * 看到**语义化、稳定**的错误标识，而不是裸 message + 看着像随机的 HTTP code。
 *
 * **本表的角色**：所有 jsonError 调用的 `metadata.error_kind` 字段必须落到
 * 这张枚举表里。`tool-orchestration.ts::extractToolErrorCode` 读 metadata 把
 * 它升格成 `agent.stream.tool` payload 的顶层 `error_code`，前端
 * `TOOL_ERROR_CATALOG` 据此走"软/硬异常分流 + i18n 翻译 + 折叠统计"。
 *
 * **命名规则**（D13）：
 *   - **扁平** 不嵌套——避免 `tool.fileSys.read` 这种点号分段（前端 i18n key /
 *     LLM context 都希望 string 直接 = 标识）
 *   - **snake_case** 与 `tool-orchestration` / `TOOL_ERROR_CATALOG` 现有
 *     `permission_denied` / `tool_stale_read` 等风格对齐
 *   - **业务语义优先** 命名上让 LLM / 用户能从字面读出"出了什么事 / 下一步该
 *     做什么"——例如 `cwd_not_found` 比 `fs_enoent_workdir` 直观得多
 *   - **跨工具复用** 优先，同一种业务错（"网络失败"/"参数缺失"）多个工具复用同
 *     一 kind；只有真正工具特有的（widget_render_failed）才单独占一格
 *
 * **如何新增**：
 *   1. 在本文件加 const 字段 + JSDoc 说明触发场景
 *   2. 同步前端 `apps/tabtin-electron/src/renderer/src/components/chat/toolErrorClassification.ts`
 *      的 `TOOL_ERROR_CATALOG` 加同名 entry（4 个布尔字段：soft / translatable /
 *      countsAsAnomaly / userInitiated）
 *   3. 同步 i18n 文案：`apps/.../i18n/locales/zh-CN/chat.json` + `en-US/chat.json`
 *      的 `chat.toolError.{key}` 段，写"动作化、给下一步建议"的简洁文案
 *
 * **不在本表的（已在 catalog 里的）**：`budget_skipped` / `aborted` /
 * `aborted_by_user` / `tool_timeout` / `execute_error` / `unknown_tool` /
 * `schema_invalid` / `validate_input` / `plan_guard_deny` —— 这些是 W2h
 * （runtime 顶层管控）已有的。本表包含工具层会主动写入 jsonError metadata
 * 的语义 kind，包括少数历史上先由顶层 catalog 承载、现在被工具层复用的 kind。
 */

// ─── 输入参数类 ───────────────────────────────────────────────────────

/**
 * 必填参数缺失（最常见的"工具调用就报错"场景）。
 * 触发：`if (!params.x) jsonError('Missing x', { error_kind: 'missing_required_param' })`
 * 文案给用户："缺少必填参数 · 请补全后重试"
 */
export const MISSING_REQUIRED_PARAM = 'missing_required_param' as const;

/**
 * 参数格式不合法（typing 对，但内容不符合约束）。
 * 触发：slug 不是 kebab-case / canonical_key 不符合正则 / format 不在 enum 内 /
 * url 不是 https 等。
 * 文案给用户："参数格式不正确 · 检查输入后重试"
 */
export const INVALID_PARAM_FORMAT = 'invalid_param_format' as const;

/**
 * 参数超过工具上限（widget code > 8KB / slug > 64 chars / context too short / etc.）。
 * 文案给用户："输入超出限制 · 拆分或精简后重试"
 */
export const PARAM_TOO_LARGE = 'param_too_large' as const;

/**
 * 互斥参数同传（如字段表单与选择题参数混传）。
 * 文案给用户："参数互斥 · 请只保留其中一个"
 */
export const MUTUALLY_EXCLUSIVE_PARAMS = 'mutually_exclusive_params' as const;

// ─── 会话/上下文/装配类 ───────────────────────────────────────────────

/**
 * 工具需要前端 UI 连接（emitStreamEvent / waitForUserInput）才能完成，但当前
 * 宿主不支持（典型：Daemon headless 模式调 show_widget / present_to_user）。
 * 文案给用户："此功能需在 TabTin 桌面端使用"
 */
export const NO_UI_SESSION = 'no_ui_session' as const;

/**
 * Runtime 装配缺失上下文：organization_id / space_id / API base url 等运行时必需
 * 字段未注入。这通常是宿主层 bug，不是 LLM 能修的——给用户的文案要明确"找
 * 开发者"。
 * 文案给用户："运行时配置不完整 · 请联系开发者"
 */
export const RUNTIME_MISCONFIG = 'runtime_misconfig' as const;

/**
 * 当前宿主部署模式不支持本工具（如 relaunch_app 在 Daemon 模式下没有
 * `app.relaunch()`；`clear_os_error_blacklist` 在测试宿主下没注入
 * blacklist 实例；ask 用户工具在无 HITL hook 的宿主等）。
 * 文案给用户："当前模式不支持此操作"
 */
export const HOST_UNSUPPORTED = 'host_unsupported' as const;

// ─── 网络 / 外部服务类 ─────────────────────────────────────────────────

/**
 * 网络 / IPC 请求失败（fetch reject / response.status 5xx 但非 timeout 类）。
 * 文案给用户："网络请求失败 · 检查网络或重试"
 */
export const NETWORK_FAILED = 'network_failed' as const;

/**
 * 请求超时（AbortSignal.timeout 触发 / err.message 命中 /timeout|aborted/i）。
 * 与 `network_failed` 区分是因为 LLM / 用户的下一步动作不同：
 * timeout 通常意味着工具本身 OK 但需要更耐心，而 network_failed 通常需要
 * 检查连接 / 切换网络。
 * 文案给用户："请求超时 · 简化输入或稍后重试"
 */
export const REQUEST_TIMEOUT = 'request_timeout' as const;

/**
 * 鉴权失败（HTTP 401，少数情况下也含 403——但本枚举主指"票据失效 /
 * 未登录"）。区别 `permission_denied`：后者是"已认证但无权限"。
 * 文案给用户："登录失效 · 请重新登录"
 */
export const AUTH_FAILED = 'auth_failed' as const;

/**
 * 已认证但无权访问目标资源（HTTP 403 / policy says no）。
 * 区别 `auth_failed`：用户身份有效，但当前 Space / Organization / 资源授权不足。
 * 文案给用户："权限不足 · 请检查 Space 或资源访问权限"
 */
export const PERMISSION_DENIED = 'permission_denied' as const;

/**
 * 目标业务资源不存在或不可再访问（HTTP 404 / 410）。
 * 典型：parse_document 收到不存在的 file_id、credential id 已失效。
 * 文案给用户："资源不存在 · 确认 ID 或重新选择资源"
 */
export const RESOURCE_NOT_FOUND = 'resource_not_found' as const;

/**
 * 已上传文档尚在解析 / 排队（Celery docparse 未完成）。
 * 触发：`parse_document` 收到 `status: 'parsing' | 'pending'`。
 * 与 `resource_not_found` 区分：file_id 有效但内容尚未就绪，LLM 应稍后重试。
 * 文案给用户："文档尚在解析 — 稍等几秒后重试"
 */
export const DOCUMENT_NOT_READY = 'document_not_ready' as const;

/**
 * 上游明确限流（HTTP 429）。
 * 与 `upstream_error` 区分：限流通常只需要等待或降低频率，不是服务整体故障。
 * 文案给用户："请求过于频繁 · 稍后重试"
 */
export const RATE_LIMITED = 'rate_limited' as const;

/**
 * 上游服务返回业务错（HTTP 5xx 系统错 / 业务码非成功 / 响应缺关键字段如
 * plan API 没返 document_id / non-JSON response 等）。
 * 文案给用户："服务暂时不可用 · 稍后重试或联系支持"
 */
export const UPSTREAM_ERROR = 'upstream_error' as const;

// ─── 业务约束类 ───────────────────────────────────────────────────────

/**
 * Skill canonical key 用了 `ext:` / `tin:` 前缀——这两类只在云端 Agent 模式
 * 下可用，本地 / Daemon 模式不支持。
 * 文案给用户："此技能仅在线模式可用 · 切换 Agent 后重试"
 */
export const SKILL_UNSUPPORTED_PREFIX = 'skill_unsupported_prefix' as const;

/**
 * Skill key 不存在（已被删 / 未安装 / 拼错）。LLM 应该 fallback 到 skills_search。
 * 文案给用户："找不到该技能 · 试试搜索其他技能"
 */
export const SKILL_NOT_FOUND = 'skill_not_found' as const;

/** Skill 存在，但当前 Agent 未启用。 */
export const SKILL_DISABLED = 'skill_disabled' as const;

/** 本 Run 尚未拿到权威 enablement 快照，调用方可重试。 */
export const SKILL_NOT_READY = 'skill_not_ready' as const;

/** Skill 已登记，但本机尚未安装或物化 SKILL.md。 */
export const SKILL_NOT_INSTALLED = 'skill_not_installed' as const;

/**
 * W3 (2026-05-10): `TOOL_RESULT_NOT_FOUND` removed alongside the
 * `retrieve_tool_result` tool — large outputs now point the LLM at the
 * persisted file path via `<persisted-output>` and the LLM re-reads via
 * `read_file`; there is no longer an "ID lookup miss" failure mode.
 */

/**
 * TabDoc 版本冲突（用户 / 其他 Agent 已修改文档，本次修改基于过期版本）。
 * 来自 W12 capability 层 `tab-doc.ts` dispatcher 的同名 errorCode。
 * 文案给用户："文档已被修改 · 重新读取后再试"
 */
export const VERSION_CONFLICT = 'version_conflict' as const;

/**
 * 文件在上次读取后被外部修改，当前快照已过期。
 * 来自 tabcode read-before-write 协议的数字 error_code=7，同步提供 string
 * error_kind，LLM 应重新读取目标文件后再试。
 * 文案给用户："文件已变化 · 重新读取后再修改"
 *
 * **W2 同步删除 TOOL_READ_REQUIRED（'tool_read_required' / errorCode=6）**：
 * FileEditTool 对齐后该 errorCode 整套下线——LLM "没读过"
 * 不再阻断 edit，errorCode=8/9 兜底"瞎 edit"场景。
 */
export const TOOL_STALE_READ = 'tool_stale_read' as const;

/**
 * `edit_file` 给的 `old_string` 在文件里完全找不到（含全部 fuzzy fallback 都
 * miss 之后）。来自 tabcode 的 `error_code=8`，同步提供 string error_kind 让
 * LLM 走"重读 + 重新构造 old_string"的精确自纠错路径。
 *
 * **W5 (2026-05-12) 修复**：之前 `mapTabcodeErrorKind` 没显式列 case → 走
 * `default` 返 `'invalid_param_format'`。Agent 看见这个名字会以为参数格式错
 * （类型 / 字段名错），完全不会想到去重新定位真实字符串——事故 c39cd8b2
 * 12 次 edit 中 3 次失败的根因之一。本 errorKind 是跟 contracts /
 * browser-core 已有 string enum 字面量对齐（详见 `packages/contracts/src/
 * tool/index.ts`、`packages/browser-core/src/types/errors.ts`）。
 *
 * 文案给用户："找不到匹配文本 · 重新读取后核对"
 */
export const OLD_STRING_NOT_FOUND = 'old_string_not_found' as const;

/**
 * `edit_file` 给的 `old_string` 在文件里命中**多处**，且 `replace_all=false`
 * —— 上层须提供更多上下文让 old_string 唯一，或显式 set `replace_all=true`。
 * 来自 tabcode 的 `error_code=9`，同步提供 string error_kind。
 *
 * **W5 修复**：跟 `OLD_STRING_NOT_FOUND` 同款问题——之前 fallback 成
 * `'invalid_param_format'`。
 *
 * 文案给用户："匹配多处 · 提供更多上下文或允许全部替换"
 */
export const OLD_STRING_NOT_UNIQUE = 'old_string_not_unique' as const;

// ─── File pipeline 类 ─────────────────────────────────────────────────
//
// 字面量须与 `@tabtin/file-pipeline-errors` codegen 输出对齐（
// Stage 7a：runtime 不再生产依赖该包；新增码时两边同步改）。

/** 文件 / URL 不存在。文案："文件不存在 · 请检查路径" */
export const FILE_NOT_FOUND = 'file_not_found' as const;

/** 文件超出读取上限。文案："文件过大 · 请拖入聊天走深度解析" */
export const FILE_TOO_LARGE = 'file_too_large' as const;

/** PDF 密码保护。文案："文件已加密 · 请提供无密码版本" */
export const ENCRYPTED = 'encrypted' as const;

/** 文件损坏。文案："文件已损坏 · 请重新导出" */
export const CORRUPTED = 'corrupted' as const;

/** PDF 扫描件。文案："扫描件 PDF · 请拖入聊天走深度解析" */
export const SCANNED_PDF = 'scanned_pdf' as const;

/** 文本层乱码。文案："文本层质量过低 · 请拖入聊天走深度解析" */
export const GARBLED_TEXT_LAYER = 'garbled_text_layer' as const;

/** 本地不支持的格式。文案："格式不支持 · 请拖入聊天或使用其他格式" */
export const UNSUPPORTED_FORMAT = 'unsupported_format' as const;

/** 本地解析超时。文案："本地解析超时 · 请拖入聊天走异步解析" */
export const PARSE_TIMEOUT = 'parse_timeout' as const;

/** sharp 缩放失败。文案："本地图像处理失败 · 请拖入聊天走云端解析" */
export const IMAGE_RESIZE_FAILED = 'image_resize_failed' as const;

/**
 * 命令 / 工具被**当前 Agent 模式**拒绝 —— 命令本身合规（不会触发 hardline 或
 * denylist），但当前会话处于受限模式（plan / ask / study 等只读模式）而被
 * input 级白名单拦截。典型：用户在 plan 模式下让 Agent 执行 `tabtin doc
 * create`——命令在 agent 模式下完全合规，但 plan 模式只放行只读命令。
 *
 * **与 `command_blocked_by_policy` / `command_denied_by_validator` 的区别**：
 *   - `command_blocked_by_policy` = hardline 红线，命令本身高危
 *   - `command_denied_by_validator` = denylist 软边界，命令含被禁姿势但目标可换
 *   - `mode_restricted` = 命令完全合规、目标也合规，仅当前会话模式限制
 *
 * 三者对 LLM 的下一步引导完全不同：hardline 应放弃任务；denylist 应换姿势；
 * mode_restricted 应通过 `switch_mode` 请求切换到 agent 模式（命令本身没
 * 任何问题，只是当前模式不许执行）。
 *
 * **metadata 字段**：
 *   - `code: string` — checker 给出的细粒度原因码（如 `'write_risk'` /
 *                      `'not_tabtin'`），便于前端按子类型分类展示
 *   - `hint: string`  — 英文可操作指引，引导 ask_user 让用户切换模式
 *
 * 文案给用户："当前模式拒绝执行 · 切换到 Agent 模式后可继续"
 */
export const MODE_RESTRICTED = 'mode_restricted' as const;

// ─── 系统 / 操作类（W12 capability 层已用，W13 提升为前端可见） ────────

/**
 * 命令被 **W12 hardline** 安全策略阻止 —— 来自 `@tabtin/security-policy::
 * checkHardlineCommand` 命中（典型：`rm -rf /`、`curl ... | sh`、`mkfs.*`、
 * `:(){ :|:&};:` fork bomb）。Hardline 是不可绕过的红线，**不受 relaxedRules
 * 影响**——这是和 `command_denied_by_validator` 的核心区别。
 *
 * **metadata 字段**（与 `error_kind` 同层级传入 jsonError 第二参数）：
 *   - `pattern: string`      — 命中的 hardline 规则模式标识
 *   - `description: string`  — hardline 规则对该模式的人类描述
 *   - `hint: string`         — 英文可操作指引（"任务级重新规划"，与 denylist
 *                              的"换姿势"语义不同：hardline 没法"换姿势"
 *                              做同一件事，只能放弃这个目标）
 *
 * 文案给用户："已阻止 · 该命令含高危操作"
 */
export const COMMAND_BLOCKED_BY_POLICY = 'command_blocked_by_policy' as const;

/**
 * 命令被 **CommandValidator denylist** 拒绝 —— 来自 `@tabtin/terminal-core::
 * CommandValidator.validate()` 命中（典型：`>` 重定向、`$VAR` env-var-expansion、
 * `python -c`、`rm`、`sudo`、`chmod` 等）。
 *
 * **与 `command_blocked_by_policy` 的区别**：
 *   - `command_blocked_by_policy` = hardline 红线（不可绕过；典型场景"高危
 *     操作"如清盘、提权 fork bomb 等，触发后只能任务级 replan）
 *   - `command_denied_by_validator` = denylist 软边界（可被 server-side
 *     `relaxedRules` 放宽；触发后通常 LLM **能换姿势**完成同一目标，例如
 *     `>` 改用 `write_file` 工具、`python -c` 改用 `write_file` + `python
 *     script.py` 两步）
 *
 * 区分两者让 LLM（以及 W3 stall detector）能做更精准决策——同一命令撞
 * hardline 5 次和撞 denylist 5 次的"下一步建议"不同：前者建议 ask_user
 * 求助，后者建议先看 hint 换姿势再试。
 *
 * **metadata 字段**（与 `error_kind` 同层级传入 jsonError 第二参数）：
 *   - `rule_name: string` — 触发拒绝的 denylist 规则名（e.g. `'redirect-write'`
 *                          / `'env-var-expansion'` / `'sensitive-path'` /
 *                          `'python-inline'` / `'command-substitution'` ...）
 *   - `hint: string`      — 英文可操作指引（按 ruleName 在 `DENY_RULE_HINTS`
 *                          表中查找；告诉 LLM 应换用何种合规姿势完成同一目标）
 *
 * 读取示例（downstream tool-orchestration 和前端 TOOL_ERROR_CATALOG 透传）：
 * ```typescript
 * jsonError(`Command denied by validator rule '${ruleName}'.`, {
 *   error_kind: COMMAND_DENIED_BY_VALIDATOR,
 *   rule_name: ruleName,
 *   hint: DENY_RULE_HINTS[ruleName],
 * });
 * ```
 *
 * 文案给用户："命令被规则拦截 · 请按 hint 切换调用姿势"
 */
export const COMMAND_DENIED_BY_VALIDATOR = 'command_denied_by_validator' as const;

/**
 * `run_terminal_command` 的 cwd 路径不存在（Node spawn 抛 ENOENT / "uv_cwd"）。
 * 来自 W12 `shell.ts` ENOENT 友好分支。
 * 文案给用户："工作目录不存在 · 检查路径或重新配置 workspace"
 */
export const CWD_NOT_FOUND = 'cwd_not_found' as const;

/**
 * `run_terminal_command` spawn 失败 —— bridge `spawnAgentSessionDetached` 抛错。
 * 典型场景：transcript manager 未初始化 / per-Space session limit reached /
 * Node child_process spawn 失败 / signal pre-aborted。
 *
 * **与 CWD_NOT_FOUND / COMMAND_BLOCKED_BY_POLICY 区分**：
 *   - `cwd_not_found` = 工作目录不存在（路径配错）
 *   - `command_blocked_by_policy` = hardline 拦截（命令违规）
 *   - `spawn_failure` = bridge 本身问题（命令本身合法 / 路径有效，
 *     但 transcript / OS process 创建失败）
 *
 * **2026-05-18 review P0-3 / 上线对齐 PRD §0.5 表 B**：
 * `failed` 分支 error_kind 现在按 PRD 枚举：`spawn_failure | mode_restricted |
 * policy_block | invalid_input`——其中 spawn_failure 是本 kind，其他三个映射到
 * `MODE_RESTRICTED` / `COMMAND_BLOCKED_BY_POLICY` / `INVALID_PARAM_FORMAT`（语义等价，命名更精确）。
 *
 * 文案给用户："启动 shell 失败 · 重试或联系支持"
 */
export const SPAWN_FAILURE = 'spawn_failure' as const;

/**
 * OS 访问错误（safe-fs 抛 OSAccessError，典型场景：macOS TCC 拒绝 /
 * Linux EPERM / Windows ACL 拦截）。orchestration 层 `maybeBlockToolOnOSError`
 * 会写黑名单短路后续重试；用户授权后调 `clear_os_error_blacklist` 解封。
 * 文案给用户："系统拒绝访问 · 请授权或换路径"
 */
export const OS_ACCESS_ERROR = 'os_access_error' as const;

// ─── 渲染 / 烤图特定类 ────────────────────────────────────────────────

/**
 * `show_widget` 的 SVG/HTML/Mermaid 编译或 prepareWidgetSource 抛错（语法错 /
 * mermaid render fail 等）。注意：`bake-upload` 烤图失败**不**走此 kind——
 * 烤图失败是非致命基建问题，桌面端仍可看 widget；本 kind 是"代码本身渲染失败"。
 * 文案给用户："Widget 渲染失败 · 检查代码后重试"
 */
export const WIDGET_RENDER_FAILED = 'widget_render_failed' as const;

// ─── 内部异常类 ───────────────────────────────────────────────────────

/**
 * 工具内部 catch 块兜底（非网络 / 非参数 / 非业务约束）。比如 `skills_read`
 * 调 `deps.getSkill` 抛 unhandled error / `skill_create` 调 `deps.writeSkill`
 * 抛 unhandled error。这种是宿主层 bug 范畴，文案要让用户知道"非他能修"。
 * 文案给用户："内部错误 · 重试或联系支持"
 */
export const INTERNAL_ERROR = 'internal_error' as const;

// ─── Todo 生命周期──────────────────────────────────────────

/** 已有未关闭列表时再次 open。文案：先 close 再开新列表 */
export const TODO_LIST_ALREADY_OPEN = 'todo_list_already_open' as const;

/** 无 open 列表时 add/update/remove/close。文案：请先 open */
export const TODO_LIST_NOT_OPEN = 'todo_list_not_open' as const;

/** 修改/删除已 completed 的项。文案：完成后不可改 */
export const TODO_ITEM_FROZEN = 'todo_item_frozen' as const;

/** open/add 的 items/item 非法（空、重复 id、非法 status 等）。 */
export const TODO_INVALID_ITEMS = 'todo_invalid_items' as const;

// ─── 联合类型导出 ─────────────────────────────────────────────────────

/**
 * 全部 W13 新增 error_kind 字面量类型。便于工具实现时 IDE 自动补全 + 编译期
 * 拼写校验（注意：这个表跟 `TOOL_ERROR_CATALOG` 的"全集"不同——catalog 还
 * 含 W2h 的 budget_skipped / aborted 等顶层枚举，不属于工具层 `error_kind`
 * 的常见取值集，故不写入本类型）。
 */
export type ToolErrorKind =
  | typeof MISSING_REQUIRED_PARAM
  | typeof INVALID_PARAM_FORMAT
  | typeof PARAM_TOO_LARGE
  | typeof MUTUALLY_EXCLUSIVE_PARAMS
  | typeof NO_UI_SESSION
  | typeof RUNTIME_MISCONFIG
  | typeof HOST_UNSUPPORTED
  | typeof NETWORK_FAILED
  | typeof REQUEST_TIMEOUT
  | typeof AUTH_FAILED
  | typeof PERMISSION_DENIED
  | typeof RESOURCE_NOT_FOUND
  | typeof DOCUMENT_NOT_READY
  | typeof RATE_LIMITED
  | typeof UPSTREAM_ERROR
  | typeof SKILL_UNSUPPORTED_PREFIX
  | typeof SKILL_NOT_FOUND
  | typeof SKILL_DISABLED
  | typeof SKILL_NOT_READY
  | typeof SKILL_NOT_INSTALLED
  // W3: TOOL_RESULT_NOT_FOUND removed (see above).
  | typeof VERSION_CONFLICT
  | typeof TOOL_STALE_READ
  | typeof OLD_STRING_NOT_FOUND
  | typeof OLD_STRING_NOT_UNIQUE
  | typeof COMMAND_BLOCKED_BY_POLICY
  | typeof COMMAND_DENIED_BY_VALIDATOR
  | typeof MODE_RESTRICTED
  | typeof CWD_NOT_FOUND
  | typeof SPAWN_FAILURE
  | typeof OS_ACCESS_ERROR
  | typeof WIDGET_RENDER_FAILED
  | typeof INTERNAL_ERROR
  | typeof TODO_LIST_ALREADY_OPEN
  | typeof TODO_LIST_NOT_OPEN
  | typeof TODO_ITEM_FROZEN
  | typeof TODO_INVALID_ITEMS
  // W1 file pipeline 类（字面量对齐 file-pipeline-errors codegen）
  | typeof FILE_NOT_FOUND
  | typeof FILE_TOO_LARGE
  | typeof ENCRYPTED
  | typeof CORRUPTED
  | typeof SCANNED_PDF
  | typeof GARBLED_TEXT_LAYER
  | typeof UNSUPPORTED_FORMAT
  | typeof PARSE_TIMEOUT
  | typeof IMAGE_RESIZE_FAILED; // W5 L38
