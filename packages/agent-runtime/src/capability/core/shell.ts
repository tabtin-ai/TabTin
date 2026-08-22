/**
 * ShellCap —— 本地 LLM 唯一的 shell 工具贡献者。
 *
 * **业务定位**（北极星）：本地 LLM 调 shell 时，命令用一次性子进程跑，
 * 输出同步写进用户的 Terminal Tab transcript 里，用户能实时看。这是 TabTin「Agent 贯穿所有
 * 工作面、每一步都看得见」的工程基本盘，让 Agent 命令输出进入用户可见的 Terminal Tab。
 *
 * ---
 *
 * ## 暴露的 LLM 工具（2026-05-23 push 通知重构 commit B：单工具）
 *
 * `tools()` 返回**唯一一个** `run_terminal_command` 工具：
 *
 *   - `wait_ms > 0` → bridge.spawnAgentSessionDetached + poll；wait_ms 内退出
 *     返 `completed`，到期仍在跑返 `running` + session_id（进程不杀）
 *   - `wait_ms: 0` → 立即返 `running` + session_id + output_file，命令在后台
 *     跑；任务完成时通过 push notification 激活下一轮 turn
 *   - LLM 要停后台任务：自己跑 `run_terminal_command("kill <pid>")`（pid 在
 *     running envelope 里返回）
 *   - 等场景全部用 `run_terminal_command` 自身覆盖（见工具描述等待场景矩阵）
 *
 * **历史**：5-14 D11 引入了专门的 kill 工具、5-18 引入了专门的 await 工具
 * 形成"三件套"——后来一次性删掉两个伴生工具，push 通知激活替代 polling
 * 等终态、`run_terminal_command kill <pid>` 替代专门 kill 工具，断开三件套
 * 工具描述闭环引用环。
 *
 * ## Shell 执行路径（D1，子进程执行 + transcript 展示）
 *
 * ```
 * LLM → run_terminal_command → ShellCap.execute
 *                                ├─ hardline 拦截 / Skill 凭据脱敏
 *                                └─ PtyManagerBridge.executeAgentCommand
 *                                    ├─ Electron 端：主进程创建独立 transcript session
 *                                    ├─ Daemon 端：DaemonPtyManager 创建 transcript session + log
 *                                    ├─ emit 'agent-session-created' → Terminal Tab（D3 每次新 tab）
 *                                    └─ child process exit/timeout/abort 判定完成
 *                                  → ShellCap envelope（脱敏 / 截断 / persisted_output_path）
 *                                    → LLM tool result
 * ```
 *
 * 接口契约：本地 `shell-bridge-contract.ts`（结构类型 / 常量；与 terminal-core
 * agent-bridge 行为对齐，生产不再 import `@tabtin/terminal-core`）。
 * ShellCap 构造时**必须**注入 `PtyManagerBridge`，未注入则同步 throw（D6
 * 不留 `child_process.spawn` 兼容性兜底）。
 *
 * ## 决策摘要（D1-D11，详见总控文档）
 *
 *   - **D1（2026-05-17 修订）**：本地 LLM 调 shell **必走一次性子进程**；
 *     PtyManager/DaemonPtyManager 只负责 transcript，不参与完成判定
 *   - **D2**：（被 D11 修订）LLM 工具面原本设计为单工具 `run_terminal_command`
 *   - **D3**：每次 Agent 调 shell → **每次新 Terminal Tab**，不复用、不分屏
 *   - **D4（2026-05-17 修订）**：Agent tab 是输出 transcript，不承接 stdin；
 *     需要交互时未来走独立 interactive terminal 工具
 *   - **D5**：**不加 Agent 视觉标识**——`source: 'agent'` 仅作数据层标识
 *   - **D6**：未上线，**不做兼容性**。shell bridge 未注入 → ShellCap 装配失败
 *   - **D7**：**不留 MVP / 中间态**——`classifyShellStderr` / `persisted_stderr_path` /
 *     `pid` 等旧执行路径字段全部退役
 *   - **D8**：TabTin 不做 MCP 输出——4 件套 MCP 暴露已在 WP5 删除
 *   - **D9**：暂不做跨设备执行（bridge 只服务本机 Electron / Daemon 两端）
 *   - **D10**：`DEFAULT_AGENT_COMMAND_TIMEOUT_MS = 120_000` 单源（2 分钟默认超时）
 *   - **D11**：~~5-14 加专门 kill 工具~~（2026-05-23 push 通知重构废止，
 *     LLM kill 改用 `run_terminal_command kill <pid>` 单一路径）
 *
 * ## envelope 字段映射现状（WP1 / WP4 落地）
 *
 *   - `bridge AgentCommandResult.sessionId` → envelope `agent_session_id`
 *   - `bridge AgentSpawnDetachedResult.sessionId` → envelope `session_id`
 *     （LLM 用此 id 通过 `run_terminal_command kill <pid>` 停掉任务；pid 在
 *     running envelope 同时返回）
 *   - `bridge AgentSpawnDetachedResult.outputFilePath` → envelope `output_file`
 *     （bridge 层持续 tail 到 `{tmpdir}/tabtin-agent-tasks/{sessionId}.log`，
 *     不与 `persisted_output_path` 重复——后者是 foreground 64KB 阈值同步落盘
 *     的独立机制）
 *   - `bridge AgentCommandResult.stderr` 永远空 → envelope **不再带**
 *     `persisted_stderr_path` / `persisted_stderr_size` / `pid`（D6 / D7 退役）
 *   - `abort_reason: 'user_interrupt' | 'timeout' | 'tool_call_cancelled'`
 *     （WP4 新增）→ 让 LLM 区分"为什么命令没正常完成"做正确下一步决策；
 *     派生逻辑见 `deriveAbortReason()` 注释
 *   - `degraded` / `degradedReason` → bridge 降级（如 sandbox 路径替代 agent
 *     shell process）时透传，让 LLM 知道"我刚才不是标准 shell process 跑的"
 *
 * ## 跟 4 件套（人控适配层）的关系
 *
 * `packages/action-tools/src/tools/terminal.ts` 内的 4 个 terminal action
 * 已在 manifest 标 `llm_facing: false`、MCP 不暴露（WP5）：它们是
 * `FrontendActionBridge` 处理 renderer IPC `agent:execute-action` / Daemon
 * 远端 WS frontend_action 等**程序化人控路径**的桥接层，**LLM 看不到也
 * 调不到**。`PtyManagerBridge`（AI 控）与 `PtyManagerAPI`（人控）独立 set /
 * 独立 resolve，互不污染——详见 `shell-bridge-contract.ts`。
 *
 * ## 职责边界
 *
 *   - **做**：定义 run_terminal_command 单工具、hardline 拦截 / Skill 凭据脱敏 /
 *     abort_reason 推导 / envelope 字段组装
 *   - **不做**：审批弹窗 / 沙箱选择 / 日志埋点（外层 v3 judge +
 *     bridge 实现 + Harness Detector 链路负责）
 *
 * ## 配置来源（v2 capabilities.overrides.shell）
 *
 *   - `terminal_mode` / `command_execution`：四值枚举（sandboxed / regular /
 *     blocked / tabtin_only）—— 持久化在 _config，供 W3 HITL Pipeline 读取
 *   - `operation_switches`：13 项 allow / confirm / block —— 同上
 *   - `high_risk_requires_approval`：boolean hint
 *
 * **历史**：曾在 `instructions()` 方法里把上述配置浓缩成 LLM 软提示，
 * 阶段 2.3（2026-05-20）随 `Capability.instructions?()` 接口一并下线。
 * 未来若需 LLM 看到这些配置，走 agent-prompt + prompt-contract 注册表，
 * 而非恢复本类的 `instructions()` 方法。
 */

import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import {
  mkdir as fsMkdir,
  writeFile as fsWriteFile,
  realpath as fsRealpath,
} from 'node:fs/promises';

import type {
  StreamEvent,
} from '../../engine/contracts/wire-protocol.js';
import type {
  Tool,
  ToolContext,
  ToolPresentation,
  ToolResult,
} from '../../engine/contracts/tools.js';
import { buildShellLlmContextContent } from '../../engine/context/llm-context-projection.js';
import { resolveToolNotificationThreadId } from '../../engine/tooling/notification-thread.js';
import type { CapabilityCategory } from '../capability.js';
import { CapabilityBase } from '../base.js';
import { describeError, jsonError } from './_utils.js';
import { performance } from 'node:perf_hooks';
import { redactSecretsInOutput } from './_redact.js';
import { buildTabtinRuntimeEnv } from './runtime-env.js';
import { RuntimeSystemNoticeEvent } from '../../event/events/observability-events.js';
import type {
  RestrictedShellAllowlistChecker,
  ShellAllowlistDecision,
} from './restricted-shell-allowlist.js';
import {
  COMMAND_BLOCKED_BY_POLICY,
  CWD_NOT_FOUND,
  INTERNAL_ERROR,
  INVALID_PARAM_FORMAT,
  MISSING_REQUIRED_PARAM,
  MODE_RESTRICTED,
  REQUEST_TIMEOUT,
  SPAWN_FAILURE,
} from '../../engine/errors/error-kinds.js';
import {
  attachShellFileHistoryToEnvelope,
  buildShellFileHistoryEnvelope,
  prepareShellFileHistoryTracking,
  type ShellFileHistoryEnvelope,
  type ShellFileHistoryPrepareResult,
} from './shell-file-history.js';
import {
  detectUnquotedWorkspacePath,
  type UnquotedWorkspacePathHit,
  DEFAULT_AGENT_COMMAND_TIMEOUT_MS,
  DEDUP_WINDOW_MS,
  resolveAgentShellInfo,
  type PtyManagerBridge,
  type AgentCommandRequest,
  type AgentCommandProgressSnapshot,
  type AgentReadResult,
  type AgentSpawnDetachedResult,
  type ShellManagedTaskStorePort,
  SKILL_CREDENTIAL_PRESERVE_ENV_KEYS_MARKER,
} from './shell-bridge-contract.js';
import { isShellCommandWriteOp } from './shell-command-side-effect.js';

/**
 * v2 `capabilities.overrides.shell` 形状（与 Django
 * `agent_config_v2.build_default_agent_config_v2()` 对齐）。
 *
 * - `terminal_mode`: 'sandboxed' | 'regular' | 'blocked' | 'tabtin_only'
 *   产品语义：Agent 终端的整体模式。`blocked` 完全禁用 shell；`tabtin_only`
 *   仅允许 tabtin CLI 内置命令；`sandboxed` 走 sandbox-exec / bwrap；
 *   `regular` 直接 spawn 子进程。
 *
 * - `command_execution`: 同 terminal_mode 的子集（更细粒度）—— 现有
 *   `sandbox_policy.py` 的实装中两者会一起被推导成 ExecutionDecision。
 *   W2.2.1 把两者都暴露给 LLM 让其能感知。
 *
 * - `operation_switches`: { [op]: 'allow'|'confirm'|'block' } 13 项。
 *   现有 W0-A 调研列出的 13 个 op：
 *     git_read / git_push / git_destructive / rm / mv / db_write /
 *     db_schema / package_install / curl_read / curl_mutate /
 *     docker / kubectl / ssh
 *
 * - `high_risk_requires_approval`: 在 regular 模式下，是否对高危命令
 *   触发审批。W2.2.1 仅作 hint。
 */
export interface ShellCapConfig {
  terminal_mode?:
    | 'sandboxed'
    | 'regular'
    | 'blocked'
    | 'tabtin_only'
    | string;
  command_execution?: 'sandboxed' | 'regular' | 'blocked' | 'tabtin_only' | string;
  operation_switches?: Record<string, 'allow' | 'confirm' | 'block' | string>;
  high_risk_requires_approval?: boolean;
}

/**
 * Skill 凭据上下文 —— 由 W2.3 宿主装配时注入的解析回调，对齐原
 * `tools/core-tools.ts::SkillCredentialResolver` 协议。
 *
 * **设计要点**（与 dispatcher 模式对齐 - W2.2.2 takeaway）：
 *
 *   - 依赖反转：ShellCap 作为 pure agent-runtime 的一部分不直接依赖
 *     Electron / Daemon 凭据存取栈；宿主在 createSession 时把
 *     `createSkillCredentialResolver()` 包装成本接口实例注入。
 *   - 采用宿主层注入回调的模式，避免 agent-runtime 反向耦合宿主桥接
 *     实现（已退役的 TabDocCap dispatcher 也走过同一模式）。
 *
 * **provider 实现约束**（同原 SkillCredentialResolver 契约）：
 *
 *   - 实现自带缓存（5min TTL LRU），用户改密钥时主动失效；
 *   - 返回的 env value 绝不能进任何宿主日志（明文）；
 *   - **不抛异常**——网络错误 / 凭据失效 / 未绑定一律返回 null，让
 *     ShellCap 降级为"不注入凭据继续执行"，不阻塞 Agent 主流程。
 */
export interface SkillCredentialInjection {
  /** 注入到子进程环境的 env 变量字典，所有 value 按密钥处理。 */
  env: Record<string, string>;
  /** 凭据 service_name（如 `openai`）；可安全记录到 telemetry。 */
  serviceName?: string;
  /** UserCredential.id（UUID）；可安全记录，用户能据此定位是哪条凭据。 */
  credentialId?: string;
  /**
   * 后端 skill_reveal 派生时附带的非致命警告码（如
   * `primary_env_ignored_for_mapped_service`）。不含密钥，可进 telemetry / SYSTEM_NOTICE。
   */
  warnings?: string[];
}

export interface SkillContextProvider {
  /**
   * 解析 skill credential env。
   *
   * @param params  当前活动 Skill 的 key + space + primary_env（来自
   *                ToolContext.skillContext，由 `skill_invoke` tool 写入
   *                state 的 contextModifier 段）
   * @param signal  取消信号；HTTP / IPC 长 RPC 应监听
   * @returns       env 字典 + 元数据；null 表示"本次不注入"（凭据未绑定 /
   *                网络故障 / 已过期），ShellCap 会原样执行命令并发
   *                SYSTEM_NOTICE 提示
   */
  resolveCredentials(
    params: { skillKey: string; spaceId: string; agentId: string; primaryEnv?: string },
    signal: AbortSignal,
  ): Promise<SkillCredentialInjection | null>;
}

/**
 * ShellCap 构造参数（W2.3 引入）。
 *
 * **向后兼容**：构造函数仍接受旧 `ShellCapConfig` 直接传（无 init 嵌套）
 * 形态，duck-typing 区分。W2.2.1 测试 / 早期装配代码无须改动。
 */
/**
 * Shell 硬红线检查结果（中立契约；产品规则表由宿主注入实现）。
 * 字段与 security-policy HardlineHit 对齐，类型不绑产品包。
 */
export interface HardlineCommandHit {
  hit: boolean;
  pattern?: string;
  description?: string;
}

/** 宿主注入：判断命令是否命中不可绕过硬红线。 */
export type HardlineCommandChecker = (command: string) => HardlineCommandHit;
export type ShellPresentationResolver = (input: unknown) => ToolPresentation | undefined;

export interface ShellCapInit {
  config?: ShellCapConfig;
  /**
   *  Stage 3c：硬红线检查器（必填）。
   * 生产路径由宿主注入 `@tabtin/security-policy` 的 `checkHardlineCommand`；
   * 内核不再直接依赖产品安全包。
   */
  checkHardlineCommand: HardlineCommandChecker;
  /**
   * **WP1（2026-05-13）/ 2026-05-17 修订**：本机 agent shell bridge，**必填**。
   *
   * **业务定位**：本地 LLM 调 `run_terminal_command` 时，命令由一次性子进程
   * 执行，输出写进 Terminal Tab transcript，让 Agent 的每一步真正可视化。
   * 这是 TabTin 北极星「Agent 贯穿所有工作面、每一步都看得见」的工程拐点。
   *
   * **接口契约**：见本地 `shell-bridge-contract.ts`（`PtyManagerBridge`）：
   *   - `executeAgentCommand` —— foreground 路径（默认）
   *   - `spawnAgentSessionDetached` —— `run_in_background: true` 路径
   *   - `readAgentSessionOutput` / `killAgentSession` —— 后续 WP4 工具用
   *   - `subscribe` —— Daemon logger / contract test 用
   *
   * **注入路径**：
   *   - 宿主（ElectronAgentHost / DaemonAgentHost）装配 ShellCap 前调
   *     `resolvePtyManagerBridge()`（`@tabtin/action-tools/runtime`）拿到
   *     WP2 真实实现注入的 bridge 实例，作为 `ptyManagerBridge` 字段传入。
   *   - bridge 缺失（`resolvePtyManagerBridge()` 返回 `null`）→ 装配点
   *     **不要 fallback 到桩**，直接跳过 ShellCap 装配（用户看到的现象是
   *     "本地 LLM 无 shell 工具可用"，这是 D6 决策的可接受代价）。
   *   - 单测可注入 mock bridge 或 `unimplementedPtyManagerBridge` 桩
   *     （后者会让首次 `execute` throw `not implemented`）。
   *
   * **缺失时的行为**：构造函数直接 `throw new Error('ShellCap: ptyManagerBridge
   * is required')`——D6 不留兼容性兜底，D7 不留中间态。
   */
  ptyManagerBridge: PtyManagerBridge;
  /**
   *  RB2：host 装配期烘焙的业务身份（per-runtime 常量，切 Space
   * 重建 runtime 保证一致）。凭据派生、`TABTIN_SPACE_ID` / `TABTIN_AGENT_ID` /
   * `TABTIN_ORGANIZATION_ID` env 注入、`agentMeta.spaceId` / `agentId` 全部读
   * 这些值，不再从运行时
   * `ToolContext` 取业务 id。缺失时 `run_terminal_command` 走原「缺 spaceId 即
   * throw」硬契约（见 `requireShellContext`）。
   * `#6198`：skill-reveal 须真实 `agentId`（缺则不注入凭据并发 notice）；
   * 普通 shell 不因缺 `agentId` 而失败，也不再把 `spaceId` 填进 `agentMeta.agentId`。
   */
  spaceId?: string;
  agentId?: string;
  organizationId?: string;
  /**
   * Skill 运行时密钥注入回调（W2.3 P0-1 修复，对齐退役命令工具实现）。
   *
   * 缺省时（provider === undefined）ShellCap 完全保持"无 Skill 注入"
   * 行为：env = process.env，忽略 ToolContext.skillContext。
   */
  skillContextProvider?: SkillContextProvider;
  /**
   * SYSTEM_NOTICE emit hook —— 用于在凭据未注入 / warning 时通知 UI 与
   * LLM（与退役命令工具实现的系统提示行为对齐）。
   *
   * 缺省时（emitStreamEvent === undefined）SYSTEM_NOTICE 静默不发；
   * 命令仍正常执行（不阻塞 Agent）。
   */
  emitStreamEvent?: (event: StreamEvent) => void;
  /**
   * run_terminal_command 默认超时（ms）。
   *
   * **L17 W1（2026-05-12）D10**：缺省 `120_000`（2 分钟）。
   *
   * **决策依据**：
   *   - 业界常见 bash 工具缺省约 2min
   *   - 过短（如 10s）只适合带 stream delta 的场景；TabTin 没 stream，不适用
   *   - TabTin 之前 30s 是中间值——`pnpm test` / `pnpm build` 几乎必超时撞
   *     timeout hint 路径（`Strongly prefer run_in_background ...`）反而强迫
   *     LLM 多走一轮决策。改 2min 让中等长度命令一次跑完
   *
   * **W2.3 P1-2 历史**：之前 schema 注释写"typically 120s"是抄错的
   * `ASK_USER_TIMEOUT_MS`（ask 用户工具的超时）。本次 D10 让 120s 真的
   * 成为默认（不是文案误抄）。
   *
   * LLM 在 input 显式传 `timeout` 时覆盖此值。
   */
  defaultTimeoutMs?: number;
  /**
   * **L16 W5.5**：受限模式（plan/ask/study）的 input 级 shell 白名单 checker。
   *
   * 缺省 `undefined` → ShellCap 不做 input 级过滤（agent / group 模式装配时不传）。
   * 设置为 checker 实例 → 每次 `run_terminal_command.execute` 入口先调
   *   `checker.isAllowed(command)`，拒绝时直接返回结构化错误，不走 session.exec。
   *
   * 由宿主（ElectronAgentHost / DaemonAgentHost）按当前 `agentMode` 决定是否注入；
   * checker 内部负责 tabtin Risk 查询（详见 `restricted-shell-allowlist.ts`）。
   */
  restrictedShellChecker?: RestrictedShellAllowlistChecker;
  /**
   * 宿主注入的 CLI 展示语义 resolver。core shell 不认识 TabTin 业务命令；
   * 宿主解析 argv 后返回稳定 kind，由 lifecycle 协议透传给 Renderer。
   */
  resolvePresentation?: ShellPresentationResolver;
}

/**
 * run_terminal_command 默认输出截断字节数 —— 走 ExecOptions.maxOutputBytes 透传链路
 * （W2.2.1 P1 (b) 让 ExecuteParams 公开字段后真生效）。
 *
 * 选 256KB（终端典型场景：`pnpm test` / `pytest` 输出几十 KB ~ 几百 KB；
 * `find /` 等灾难性输出会超过此限）。Capability 层的 cap 比 CommandExecutor
 * 全局 100KB 更宽（让默认场景更友好），但不至于把 LLM context 撑爆。
 *
 * Tool.maxResultSizeChars（150_000 字符 ≈ 600KB UTF-8）作为二级闸门走
 * ToolResultStorage 持久化路径。
 */
const EXEC_RESULT_MAX_CHARS = 150_000;
const EXECUTION_TIMEOUT_GRACE_MS = 5_000;

// wait_ms 默认 60s，上限 300s（5 分钟 - 避免撞 LLM provider tool_call 超时）。
// 不设硬默认 / 强制 required —— 让 LLM 显式表达"我愿意等多久"。
const DEFAULT_WAIT_MS = 60_000;
const MAX_WAIT_MS = 300_000;
// run_terminal_command 路径的 stdout inline 上限：30KB。
// 256KB 顶满单条 tool_result tokens 上限，30KB 留 buffer 给后续推理 + 多 tool_use。
const STDOUT_INLINE_MAX_BYTES = 30 * 1024;
// 2026-05-18 review P1-5：100ms 平衡及时性与 IPC 开销（原 500ms 让小 wait_ms 严重超调）。
const POLL_INTERVAL_MS = 100;
// RT-4 R1：pattern 跨增量边界滑窗大小——cursor 增量读后单轮只拿新 chunk，
// 用滑窗（上次尾部 + 本次增量）保证跨边界 pattern 不漏匹配。
const PATTERN_MATCH_WINDOW_BYTES = 64 * 1024;
// running 分支 stdout_tail 返回字节数。
const STDOUT_TAIL_BYTES = 8 * 1024;

/**
 * 大输出落盘阈值（字节）。
 *
 * 单次命令 stdout/stderr 体量超过阈值时，把完整输出写到独立 tool-results 目录，
 * **同时**给 LLM 返回 `persisted_output_path` + 头/尾 preview，让它用
 * `read_file` 接续看完整内容（而不是用 `cat | head` 违背 description 引导）。
 *
 * 选 64KB 而非更大：
 *   - LLM context 单条 tool_result 应控制在 ~16K tokens 以内，64KB UTF-8
 *     大致对应 16K-32K tokens（中文/英文混合），是上限附近。
 *   - 选 64KB 以适应日志类命令，但仍比 EXEC_DEFAULT_MAX_OUTPUT_BYTES（256KB）
 *     小一个量级——这意味着"截断后的截断"也能尽量保住完整可读副本。
 */
/**
 * `run_terminal_command` 的基础描述（shell 无关的纯功能文案）。
 *
 *  方案 2：shell 专属语法（POSIX / PowerShell / cmd）收敛到系统提示
 * `<shell_runtime>`。：本描述不得再内嵌 bash 等待示例（`until` /
 * `[[ ]]`）或伪通用的 `cd &&` / `$TABTIN_*`——那些会在 Windows 上盖过
 * `<shell_runtime>` 的 PowerShell 纪律。切目录 / env / 等待循环一律指向
 * `<shell_runtime>`。
 */
const EXEC_COMMAND_BASE_DESCRIPTION =
  '在工作目录根执行 shell；切目录、路径环境变量语法见 `<shell_runtime>`。\n' +
  '`completed` 返回 preview/full_output_path；`running` 返回 pid/output_file；`failed` 看 error_kind/hint。\n' +
  '等待退出用默认 wait_ms=60000；等特定输出用 pattern；长任务传 wait_ms:0 后台化。' +
  '批量取证可在一条命令里串联/管道完成；交互进程需用非交互参数。';

/**
 * `run_terminal_command` 的工具描述——**shell 无关的纯功能描述**。
 *
 *  方案 2：shell 专属语法提示统一归口系统提示 `<shell_runtime>`
 * （`@tabtin/agent-prompt::buildShellRuntimeSection`）。：本函数
 * 只保留功能说明与等待场景矩阵骨架，**不**内嵌任何具体 shell 的命令示例，
 * 避免工具描述与 `<shell_runtime>` 各说一套语法造成漂移 / Windows 误用 bash。
 *
 * 保留为函数（而非直接导出常量）以维持既有调用点与 tool-description-audit fixture 的
 * 接口稳定。
 */
export function buildExecCommandDescription(): string {
  return EXEC_COMMAND_BASE_DESCRIPTION;
}

/**
 * Persisted preview 头/尾各保留的字节数。
 *
 * 「head + tail preview」模式：先呈现命令头部进度信息，
 * 再呈现命令尾部错误信号 / 退出标识，让 LLM 不读完整文件也能做基础判断。
 * 头/尾各 8KB 总共 16KB，留给 envelope 其它字段足够预算。
 */
const PERSIST_PREVIEW_HEAD_BYTES = 8 * 1024;
const PERSIST_PREVIEW_TAIL_BYTES = 8 * 1024;


/**
 * 计算"头 + 尾"preview 字符串。
 *
 * 把 stdout 取头 PERSIST_PREVIEW_HEAD_BYTES 字节 + 尾 PERSIST_PREVIEW_TAIL_BYTES
 * 字节，中间加 `... [N bytes elided — full output at full_output_path; use
 * jq/grep/read_file ranges ...] ...` 提示（ 下线 digest 后只引导仍可用
 * 的收窄路径；字段名对齐 completed envelope 的 `full_output_path`）。
 *
 * **WP1（2026-05-13）/ 2026-05-17 修订**：Agent shell bridge 把 stdout /
 * stderr 合流进 stdout，ShellCap 只处理一条 stdout 路径——函数签名不再带
 * channel 参数，引导文案统一指单一落盘路径字段。不删 LLM 会
 * 幻觉一个永远 undefined 的"另一路径"。
 *
 * **为什么不只取头部**：命令日志的关键诊断信息（错误堆栈、exit code、最终
 * 状态）通常在尾部；只看头部会让 LLM 误判命令"卡住"。头 + 尾保住两端最有
 * 信息量的部分。
 */
/**
 * 归一 Agent shell stdout 供 LLM 消费（ A1 + A2）。
 *
 * **一致性不变量**：本函数产出即 tool_result content，也就是 LLM 入参检视快照
 * （query.ts `buildLLMCallSnapshot` 记录的 `llmRequest.messages`）看到的确切内容。
 * 归一只在此处（tool_result 生成点）发生 —— 终端 Tab transcript（人看，仍含
 * `$ command` 回显与原始 CRLF）不受影响，故「debug 视图」与「LLM 消费」不分叉：
 * 入参检视面板始终等于 LLM 真实所见；终端 transcript 作为人类执行记录允许更全。
 *
 * A2：CRLF / 孤立 CR → LF。PTY transcript 用 `\r\n`，LLM 不需要 `\r`，进 JSON
 *     envelope 还会把 `\r` 转义成两字符白白翻倍。
 * A1：剥掉 bridge 写入的命令回显前缀 `$ <command>\n`（Electron / Daemon 两端
 *     `PtyManagerBridge` 统一以 `$ ${req.command}\r\n` 写入）。命令原文对 LLM 是纯
 *     冗余（tool_use 里已含完整 command），长命令 / heredoc 会让每条结果重复计费。
 */
export function normalizeAgentStdout(rawOutput: string, command: string): string {
  const lf = rawOutput.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const normCommand = command.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const echoPrefix = `$ ${normCommand}`;
  if (lf.startsWith(echoPrefix)) {
    const rest = lf.slice(echoPrefix.length);
    return rest.startsWith('\n') ? rest.slice(1) : rest;
  }
  return lf;
}

// LLM-facing 裁剪规则单源在 engine/llm-context-projection.ts——
// live 路径（此处 llmContextContent）与 query.ts 发送前边界投影共用同一实现，
// 保证历史恢复（transcript / renderer / crash resume）与同轮 live 字节一致。

function buildShellToolResult(
  envelope: Record<string, unknown>,
  options?: { llmContextContent?: string },
): ToolResult {
  return {
    content: JSON.stringify(envelope, null, 0),
    llmContextContent: options?.llmContextContent ?? buildShellLlmContextContent(envelope),
  };
}

interface LoginRequiredControlSignal {
  domain: string;
  reason: string;
  tab_id?: string;
}

function asJsonRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function extractLoginRequiredControlSignal(parsed: unknown): LoginRequiredControlSignal | null {
  const root = asJsonRecord(parsed);
  if (!root) return null;
  const payload = asJsonRecord(root.data) ?? root;
  const loginRequired = asJsonRecord(payload.login_required);
  if (!loginRequired) return null;

  const pageUrl = [payload.finalUrl, payload.page_url, payload.url]
    .find((value): value is string => typeof value === 'string');
  if (!pageUrl) return null;

  let domain: string;
  try {
    const url = new URL(pageUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    domain = url.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
  if (!domain) return null;

  const reason = typeof loginRequired.reason === 'string' && loginRequired.reason
    ? loginRequired.reason.slice(0, 500)
    : '页面需要登录';
  const tabId = typeof loginRequired.tab_id === 'string'
    && /^[A-Za-z0-9_-]{1,128}$/.test(loginRequired.tab_id)
    ? loginRequired.tab_id
    : undefined;
  return { domain, reason, ...(tabId ? { tab_id: tabId } : {}) };
}

function extractJsonControlSignals(output: string): { login_required?: LoginRequiredControlSignal } | undefined {
  const trimmed = output.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  try {
    const loginRequired = extractLoginRequiredControlSignal(parsed);
    return loginRequired ? { login_required: loginRequired } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 取 stdout 末尾 N 字节作为 running 分支的 stdout_tail（utf-8 字节级切，避免多字节字符截半）。
 *
 * running 分支只给末尾，避免大输出占满 LLM context（30KB 的 head preview
 * 已经是另一回事）。
 */
function takeTail(output: string, maxBytes: number): string {
  const buf = Buffer.from(output, 'utf-8');
  if (buf.length <= maxBytes) return output;
  return buf.subarray(buf.length - maxBytes).toString('utf-8');
}

type ForegroundDetachTrigger =
  | { kind: 'wait_ms_exhausted'; effectiveWaitMs: number }
  | { kind: 'user_detached' };

type ForegroundDetachOutcome =
  | { action: 'continue' }
  | { action: 'return'; envelope: Record<string, unknown> };

/**
 * 前台 sync poll 转后台 running envelope——wait_ms 超时与 UI 人工 detach 共用。
 */
async function finishForegroundWaitAsBackgroundRunning(params: {
  sessionId: string;
  store: ShellManagedTaskStorePort | undefined;
  lastRead: AgentReadResult;
  readFullOutput: () => Promise<AgentReadResult>;
  command: string;
  secretEnv: Record<string, string> | undefined;
  startedAt: number;
  outputFilePath: string;
  hardTimeoutMs: number | undefined;
  stdoutRedirectWarning: string | undefined;
  waitMsClamped: string | undefined;
  pathQuotingWarnings: Array<{ path: string; hint: string }> | undefined;
  trigger: ForegroundDetachTrigger;
}): Promise<ForegroundDetachOutcome> {
  const {
    sessionId,
    store,
    lastRead,
    readFullOutput,
    command,
    secretEnv,
    startedAt,
    outputFilePath,
    hardTimeoutMs,
    stdoutRedirectWarning,
    waitMsClamped,
    pathQuotingWarnings,
    trigger,
  } = params;

  const releasedClaim = store?.releaseSyncNotificationClaim(sessionId);
  if (releasedClaim && releasedClaim.status !== 'running') {
    return { action: 'continue' };
  }

  const elapsedMs = Date.now() - startedAt;
  const fullExpire = await readFullOutput();
  const normalizedExpire = normalizeAgentStdout(fullExpire.output, command);
  const redactedOutputExpire = secretEnv
    ? redactSecretsInOutput(normalizedExpire, secretEnv)
    : normalizedExpire;
  const tail = takeTail(redactedOutputExpire, STDOUT_TAIL_BYTES);
  store?.markBackgroundExposed(sessionId);

  const pidHint = lastRead.pid ?? 'unknown';
  const killPipelineHint =
    `(3) To stop it, kill the whole pipeline (a plain \`kill ${pidHint}\` only kills the wrapper shell and leaves piped children like du/sort still scanning): ` +
    `run \`pkill -P ${pidHint} 2>/dev/null; kill ${pidHint} 2>/dev/null\` via run_terminal_command.`;
  const baseContinueHint =
    `You can: (1) Continue with other work — you will be notified when it completes; ` +
    `(2) Use \`read_file(${outputFilePath})\` to view current output; ` +
    killPipelineHint;
  const hintReason =
    trigger.kind === 'user_detached'
      ? `User detached command to background (pid=${pidHint}). ${baseContinueHint}`
      : `Command still running in background (pid=${pidHint}) after ${elapsedMs}ms (wait_ms=${trigger.effectiveWaitMs} exhausted). ${baseContinueHint}`;

  return {
    action: 'return',
    envelope: {
      status: 'running',
      session_id: sessionId,
      pid: lastRead.pid,
      stdout_tail: tail,
      stdout_byte_count: lastRead.outputBytes,
      elapsed_ms: elapsedMs,
      output_file: outputFilePath,
      hard_timeout_ms: hardTimeoutMs,
      hint: {
        next_action: 'continue',
        reason: hintReason,
      },
      stdout_redirect_warning: stdoutRedirectWarning,
      input_clamped: waitMsClamped,
      path_quoting_warnings: pathQuotingWarnings,
    },
  };
}

/**
 * pattern 匹配 helper。
 *
 * **不变量**：
 *   1. ANSI strip：output 是 bridge readAgentSessionOutput 返回，已 cleanOutput，
 *      但再做一次 cleanOutput 保险（cleanOutput 幂等）
 *   2. ReDoS 100ms 兜底：用 performance.now() 测 regex exec 时长，超过视为 ReDoS。
 *      注意：JS regex 是同步的；如果真的灾难性回溯卡死 event loop 这里测不到，
 *      但**第二次循环**就能识别并停 polling（best-effort，已显著好过没保护）
 *   3. 返回 { matched: true, text, byte_offset } 或 { matched: false } 或 { redos: true }
 */
function tryMatchPattern(
  pattern: RegExp,
  output: string,
): { matched: true; text: string; byte_offset: number } | { matched: false } | { redos: true } {
  // ANSI 再 strip 一次（cleanOutput 来自 @tabtin/pty-core，幂等）
  const clean = output; // bridge readAgentSessionOutput 已 cleanOutput；这里直接用
  const t0 = performance.now();
  const m = pattern.exec(clean);
  const elapsedMs = performance.now() - t0;
  if (elapsedMs > 100) {
    return { redos: true };
  }
  if (!m) return { matched: false };
  return {
    matched: true,
    text: m[0],
    byte_offset: Buffer.byteLength(clean.slice(0, m.index), 'utf-8'),
  };
}

function buildHeadTailPreview(output: string): string {
  const totalBytes = Buffer.byteLength(output, 'utf8');
  if (totalBytes <= PERSIST_PREVIEW_HEAD_BYTES + PERSIST_PREVIEW_TAIL_BYTES) {
    return output;
  }
  // 用 Buffer 做字节级切，避免在 multibyte 字符中间切（slice 末尾可能产生
  // invalid UTF-8 序列，但写入 string 时 Node 会用 replacement char 兜底，
  // 不会崩。LLM 看到 replacement char 不影响诊断）。
  const buf = Buffer.from(output, 'utf8');
  const head = buf.subarray(0, PERSIST_PREVIEW_HEAD_BYTES).toString('utf8');
  const tail = buf
    .subarray(buf.length - PERSIST_PREVIEW_TAIL_BYTES)
    .toString('utf8');
  const elided = totalBytes - PERSIST_PREVIEW_HEAD_BYTES - PERSIST_PREVIEW_TAIL_BYTES;
  // 字段名与 envelope 对齐（full_output_path）；只引导仍可用的收窄路径。
  return `${head}\n\n... [${elided} bytes elided — full output at full_output_path; use jq for machine-readable JSON, grep_search for specific text, or read_file with line ranges] ...\n\n${tail}`;
}

/**
 * 把大 stdout/stderr 落盘到 tool-results 目录（os.tmpdir 下）。
 *
 * 落盘到 tool-results dir + 返回 `persistedOutputPath`。走自己的
 * 临时目录（不能跟 ToolResultStorage 共用——后者是 host-injected，本 Lane
 * 限制不动跨包接口）。
 *
 * 文件命名包含 sessionId + toolUseId 让多 session / 并发 tool_use 互不覆
 * 盖。失败时（磁盘满 / 权限拒）不抛错——返回 undefined 让上游 fallback 到
 * "用 truncated stdout 直接发给 LLM"。
 *
 * 路径返回给 LLM 后，它用 `read_file` 工具去读完整内容；read_file 已支持
 * `/tmp` 路径读取（safe-fs 默认放行系统目录读）。
 */
async function persistLargeOutput(params: {
  sessionId: string;
  toolUseId: string | undefined;
  content: string;
}): Promise<string | undefined> {
  try {
    // L17 W1（2026-05-12）D9：落盘 dir 走 realpath 兜底 macOS symlink。
    //
    // 修法对齐 W4 read-file-state.ts:312-338 `canonicalizePath` 同款思路：
    //   - macOS：os.tmpdir() 返回 `/var/folders/.../T/`，但 fs.realpath 解出
    //     `/private/var/folders/.../T/`（/var → /private/var symlink）
    //   - read 端 (read-file-state.ts) 已 realpath；如果 shell 落盘端不 realpath，
    //     当前表面工作（OS 层 symlink 透明可达），但**未来 read 端 realpath
    //     行为变更或换实现会立刻断**——属于 W4 同款"两端 key 一致"的脆弱不变量
    //
    // 兜底策略：dir 不存在时（首次创建）→ 先 mkdir，再对 dir 取 realpath。
    // realpath 失败（极少见，只有权限问题）→ fallback 用未 realpath 的 dir，
    // 让落盘仍然成功（不阻塞 LLM 主流程）。
    const rawDir = joinPath(tmpdir(), 'tabtin-tool-results', params.sessionId);
    await fsMkdir(rawDir, { recursive: true });
    let dir: string;
    try {
      dir = await fsRealpath(rawDir);
    } catch {
      dir = rawDir; // realpath 失败兜底，落盘继续
    }
    const id = params.toolUseId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const file = joinPath(dir, `shell-${id}-stdout.log`);
    await fsWriteFile(file, params.content, 'utf8');
    return file;
  } catch {
    // 落盘失败不阻塞主流程；调用方走 truncated preview 兜底
    return undefined;
  }
}

const executeCommandInputSchema = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description: '要执行的命令',
    },
    description: {
      type: 'string',
      description: '这条命令在做什么。5-10 个字，给用户看的摘要。',
    },
    wait_ms: {
      type: 'integer',
      description:
        // 取值表 / running 完整契约在工具 description；越界 clamp 见 envelope。
        '最长阻塞毫秒数。默认 60000，范围 [0,300000]，越界 clamp。' +
        '到期不杀进程：返 `status:"running"` + session_id；完成后 push 唤醒。`0`=立即背景化。',
    },
    hard_timeout_ms: {
      type: 'integer',
      description:
        // 推荐取值表 / GC 兜底在工具 description 末段。
        '真死线毫秒。到点 SIGTERM，返 `killed_reason:"hard_timeout"`。' +
        '不传=无硬死线（系统默认提醒与兜底）。',
    },
    pattern: {
      type: 'string',
      description:
        // ANSI strip / ReDoS 细节见 envelope `pattern_failed` hint。
        '可选 regex（≤200 字符）。命中即提前返 `running`+`pattern_matched`，不必等 `wait_ms`。' +
        'ReDoS（单次 >100ms）拒绝。',
    },
    env: {
      type: 'object',
      description:
        '可选额外环境变量（清洗后注入；key/value 须为字符串）。勿塞密钥——改用 Skill 凭证。',
      additionalProperties: { type: 'string' },
    },
  },
  required: ['command'],
  additionalProperties: false,
} as unknown as Tool['inputSchema'];

// ─── Helpers ─────────────────────────────────────────────────────────
// jsonError / describeError 抽到 `core/_utils.ts` 共享。

/**
 * 校验调用方传入的 env 字典——必须是 Record<string, string>，
 * 任一非字符串值会被拒绝（避免 LLM 失误传 number / null 进 spawn）。
 *
 * **TABTIN_\* / _TABTIN_\* 前缀保留给平台契约**（TABTIN_WORKSPACE /
 * TABTIN_THREAD_ID / _TABTIN_TRANSPORT_TOKEN 等），由
 * `buildTabtinRuntimeEnv` 从 `ToolContext` 派生注入。LLM 不得通过 env 参数设置或覆盖这些变量——
 * 若传了一律静默过滤（不报错，避免 LLM 因防御性拒绝而反复重试）。
 *
 * 平台 env（`TABTIN_*` / `_TABTIN_*`）由 spawn 逻辑直接写入，
 * LLM 无渠道覆盖。
 *
 * 仅 ShellCap 内部使用（其他 Cap 不接 env 入参），所以不抽到 _utils.ts。
 */
function normalizeExecEnv(value: unknown): Record<string, string> | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== 'string') continue; // 静默丢弃非法项；命令通常仍可跑
    if (k.startsWith('TABTIN_') || k.startsWith('_TABTIN_')) continue; // 平台契约，LLM 不能设置
    // bugbot 评审  high：内部 marker __TABTIN_SKILL_CREDENTIAL_PRESERVE_KEYS__
    // 以双下划线开头，不被上面的 TABTIN_ 前缀过滤。若不拦，LLM 可自行在 env 里塞
    // 这个 marker + 任意 preserveKeys，经 buildEnv → sanitizeEnv(preserveKeys) 绕过
    // 敏感 env 黑名单注入 OPENAI_API_KEY 等。marker 只能由 ShellCap 内部写入，
    // 故这里连同任何 __TABTIN_ 前缀的内部契约键一并从 LLM/用户 env 剔除。
    if (k.startsWith('__TABTIN_')) continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 检测命令里**明确的 stdout 重定向目标**。
 *
 * dogfood 现场：Agent 把 stdout 重定向到
 * `~/disk_usage_summary.txt` 然后 read_file(output_file) 看到空文件以为
 * 后台任务失败——实际任务跑成功，结果在 redirect target 里。
 *
 * **只识别**：`>` / `1>` / `>>`（精确 stdout 重定向到文件路径）。
 * **不识别**：变量（`$VAR`）、子 shell（`$(...)`）、复杂引号嵌套
 * （`> "$file"`）、`2>` (stderr only)、`| tee file`（tee 本身向 stdout 输出，
 * output_file 不会空）。
 *
 * 命中时返回 redirect 目标字符串；不命中或不确定时返回 null。
 * 文案在 background spawn banner 与 envelope `stdout_redirect_warning`
 * 字段中提示 LLM 去读 redirect target 而不是 output_file。
 */
const STDOUT_REDIRECT_RE = /(?:^|[\s;&|])(?:1?>>?)\s+([^\s;&|<>$()"'`]+)/;

export function detectStdoutRedirect(command: string): string | null {
  const m = STDOUT_REDIRECT_RE.exec(command);
  if (!m) return null;
  const target = m[1]!;
  // 排除明显非文件形态
  if (target.startsWith('$') || target.startsWith('(') || target.startsWith('&')) return null;
  // 排除 `>&N` 文件描述符复制（如 2>&1）
  if (/^&?\d+$/.test(target)) return null;
  return target;
}

/**
 * 把 cwd 路径未引号检测命中数组序列化为返回 envelope 字段。
 *
 * 单一函数 + 清晰契约（path / hint 两字段）：LLM 只需读两字段就能
 * 复现整个语义。**不在此处去重 hint**——detector 已确保同一 path 只
 * 出现一次，更复杂的去重反而让契约不可预测。
 */
function serializeQuotingHits(
  hits: readonly UnquotedWorkspacePathHit[],
): Array<{ path: string; hint: string }> {
  return hits.map((h) => ({ path: h.path, hint: h.hint }));
}

type ShellCommandInput =
  | {
      ok: true;
      command: string;
      description: string | undefined;
      effectiveWaitMs: number;
      waitMsClamped: string | undefined;
      hardTimeoutMs: number | undefined;
      patternRegex: RegExp | undefined;
      env: unknown;
    }
  | { ok: false; result: ToolResult };

function parseShellCommandInput(input: unknown): ShellCommandInput {
  const { command, description, wait_ms, hard_timeout_ms, pattern, env } = (input ?? {}) as {
    command?: unknown;
    description?: unknown;
    wait_ms?: unknown;
    hard_timeout_ms?: unknown;
    pattern?: unknown;
    env?: unknown;
  };
  if (typeof command !== 'string' || command.trim().length === 0) {
    return {
      ok: false,
      result: jsonError("Missing required 'command': provide a non-empty string.", {
        error_kind: MISSING_REQUIRED_PARAM,
        hint: 'Provide a non-empty command string. The command field is required.',
      }),
    };
  }

  const requestedWaitMs =
    typeof wait_ms === 'number' && Number.isFinite(wait_ms) && wait_ms >= 0
      ? Math.floor(wait_ms)
      : DEFAULT_WAIT_MS;
  const effectiveWaitMs = Math.min(Math.max(requestedWaitMs, 0), MAX_WAIT_MS);
  const hardTimeoutMs =
    typeof hard_timeout_ms === 'number' && Number.isFinite(hard_timeout_ms) && hard_timeout_ms > 0
      ? Math.floor(hard_timeout_ms)
      : undefined;
  const patternResult = compileShellPattern(pattern);
  if (!patternResult.ok) return patternResult;
  const trimmedDescription =
    typeof description === 'string' && description.trim().length > 0
      ? description.trim()
      : undefined;
  return {
    ok: true,
    command,
    description: trimmedDescription,
    effectiveWaitMs,
    waitMsClamped: requestedWaitMs !== effectiveWaitMs
      ? `wait_ms ${requestedWaitMs} clamped to ${effectiveWaitMs}`
      : undefined,
    hardTimeoutMs,
    patternRegex: patternResult.patternRegex,
    env,
  };
}

function compileShellPattern(
  pattern: unknown,
): { ok: true; patternRegex: RegExp | undefined } | { ok: false; result: ToolResult } {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return { ok: true, patternRegex: undefined };
  }
  if (pattern.length > 200) {
    return {
      ok: false,
      result: jsonError(`Invalid 'pattern': regex string too long (${pattern.length} > 200 chars)`, {
        error_kind: INVALID_PARAM_FORMAT,
        hint: 'Pattern must be ≤ 200 chars to prevent ReDoS. Use a more specific anchor like a unique substring instead of broad alternations.',
      }),
    };
  }
  try {
    return { ok: true, patternRegex: new RegExp(pattern) };
  } catch (err) {
    return {
      ok: false,
      result: jsonError(`Invalid 'pattern' regex: ${describeError(err)}`, {
        error_kind: INVALID_PARAM_FORMAT,
        hint: 'Provide a valid JavaScript regex. Test it with `new RegExp(pattern)` locally first.',
      }),
    };
  }
}

function buildHardlineRejection(
  checkHardlineCommand: HardlineCommandChecker,
  command: string,
  pathQuotingWarnings: Array<{ path: string; hint: string }> | undefined,
): ToolResult | null {
  const hardline = checkHardlineCommand(command);
  if (!hardline.hit) return null;
  return jsonError(
    `Command blocked by security policy: ${hardline.description ?? 'forbidden'}`,
    {
      error_kind: COMMAND_BLOCKED_BY_POLICY,
      blocked_by: 'security_policy_hardline',
      pattern: hardline.pattern,
      description: hardline.description ?? 'forbidden command',
      hint:
        'This command matches a non-bypassable hardline rule (e.g. ' +
        'unrecoverable destruction, fork bomb, system takeover). It cannot ' +
        'be relaxed or retried with different flags. Re-evaluate the goal ' +
        '— if the destructive operation is truly intended, ask the user ' +
        'directly (via `ask_user`) so they can perform it manually.',
      path_quoting_warnings: pathQuotingWarnings,
    },
  );
}

function restrictedShellHint(code: ShellAllowlistDecision['code']): string {
  if (code === 'system_command_rejected') {
    return 'Readonly system commands (git, tree, find, sed, xargs, ps) are ' +
      'allowed in restricted mode (plan / ask / study), but only with ' +
      'flags listed in their safeFlags. Your command was rejected because ' +
      'one or more flags fall outside the safeFlags allowlist (e.g. ' +
      '`--output=PATH` writes a file, `-c core.fsmonitor=...` injects ' +
      'config). Try removing or adjusting the offending flag and retry. ' +
      'If you genuinely need write operations, use `switch_mode` (or ask ' +
      'the user to switch via the mode selector at the bottom-left of the ' +
      'chat input) to enter Agent mode.';
  }
  return 'The current mode (plan / ask / study) only allows registered ' +
    'read-only platform CLI sub-commands (as reported by the command ' +
    'allowlist) and a small set of readonly system commands (git, tree, ' +
    'find, sed, xargs, ps) with restricted flags. For write operations ' +
    '(create / update / delete, etc.), use `switch_mode` (or ask the user ' +
    'to switch via the mode selector at the bottom-left of the chat input) ' +
    'to enter Agent mode before retrying.';
}

async function buildRestrictedShellRejection(params: {
  checker: RestrictedShellAllowlistChecker | undefined;
  command: string;
  pathQuotingWarnings: Array<{ path: string; hint: string }> | undefined;
}): Promise<ToolResult | null> {
  if (!params.checker) return null;
  const decision = await params.checker.isAllowed(params.command);
  if (decision.allowed) return null;
  const reasonSuffix = decision.reason ? ` (${decision.reason})` : '';
  return jsonError(`Restricted mode rejected the command${reasonSuffix}.`, {
    error_kind: MODE_RESTRICTED,
    blocked_by: 'restricted_shell_allowlist',
    validator_code: decision.code ?? 'denied',
    hint: restrictedShellHint(decision.code),
    path_quoting_warnings: params.pathQuotingWarnings,
  });
}

interface SkillCredentialState {
  secretEnv?: Record<string, string>;
  unavailable: boolean;
  warnings?: string[];
}

async function resolveSkillCredentialState(
  provider: SkillContextProvider | undefined,
  context: ToolContext,
  spaceId: string | undefined,
  agentId: string | undefined,
): Promise<SkillCredentialState> {
  // ：仅 Skill 凭据路径需要真实 agentId；缺则不注入并走 unavailable 提示，
  // 与 skill-credential-resolver 拒 reveal（return null）语义一致。不阻塞无 Skill 的 shell。
  if (provider && context.skillContext && spaceId) {
    if (!agentId?.trim()) {
      return { unavailable: true };
    }
    try {
      const injection = await provider.resolveCredentials(
        {
          skillKey: context.skillContext.skillKey,
          spaceId,
          agentId,
          primaryEnv: context.skillContext.primaryEnv,
        },
        context.abortSignal,
      );
      if (injection && injection.env && Object.keys(injection.env).length > 0) {
        return {
          secretEnv: injection.env,
          warnings: Array.isArray(injection.warnings) && injection.warnings.length > 0
            ? injection.warnings
            : undefined,
          unavailable: false,
        };
      }
      return { unavailable: true };
    } catch {
      return { unavailable: true };
    }
  }
  return { unavailable: !provider && Boolean(context.skillContext) };
}

function emitSkillCredentialNotices(
  state: SkillCredentialState,
  context: ToolContext,
  fallbackEmitter: ((event: StreamEvent) => void) | undefined,
): void {
  if (!context.skillContext) return;
  const emitter = context.emitStreamEvent ?? fallbackEmitter;
  if (state.unavailable) {
    emitter?.(new RuntimeSystemNoticeEvent({
        notice_type: 'skill_credential_unavailable',
        severity: 'silent',
        content:
          `Skill 「${context.skillContext.skillKey}」绑定的 API Key 未能获取，` +
          '命令会继续执行但不注入密钥。可能原因（请按顺序自查）：' +
          '(1) 该 Skill 在当前 Agent 没有绑定凭据；' +
          '(2) 绑定的凭据已过期 / 被停用；' +
          '(3) 若 Agent 运行在远程 Daemon，设备访问令牌可能临时失效，' +
          '通常几分钟内自动恢复；如长期不恢复，请让管理员重新执行 ' +
          '`tabtin-daemon init --token <新 token>`。',
        skill_key: context.skillContext.skillKey,
    }).toStreamEvent());
    return;
  }
  if (state.warnings) emitSkillCredentialWarning(state.warnings, context, emitter);
}

function emitSkillCredentialWarning(
  warnings: string[],
  context: ToolContext,
  emitter: ((event: StreamEvent) => void) | undefined,
): void {
  emitter?.(new RuntimeSystemNoticeEvent({
      notice_type: 'skill_credential_warning',
      severity: 'silent',
      content:
        `Skill 「${context.skillContext!.skillKey}」的 API Key 已成功注入。` +
        '提示：Skill 声明的环境变量名与凭据所属服务的默认派生名不一致，' +
        '已按凭据映射注入（例如 openai 凭据总是派生成 OPENAI_API_KEY）。' +
        '通常不影响命令执行；若命令报 "XXX_API_KEY not set" 类错误：' +
        '• 若该 Skill 是他人分享 → 请联系 Skill 作者更新 SKILL.md 的 primary_env 字段；' +
        '• 若是你自己写的 Skill → 把 primary_env 改成凭据实际派生的变量名后重试。',
      skill_key: context.skillContext!.skillKey,
      warnings,
  }).toStreamEvent());
}

function buildMergedShellEnv(
  context: ToolContext,
  inputEnv: unknown,
  secretEnv: Record<string, string> | undefined,
  spaceId: string | undefined,
  organizationId: string | undefined,
  agentId: string | undefined,
): Record<string, string> | undefined {
  const tabtinEnv = buildTabtinRuntimeEnv(context, spaceId, organizationId, agentId);
  const userEnv = normalizeExecEnv(inputEnv);
  const secretEnvKeys = secretEnv && Object.keys(secretEnv).length > 0
    ? Object.keys(secretEnv).sort()
    : undefined;
  const hasAnyEnv = Object.keys(tabtinEnv).length > 0 || userEnv || secretEnv;
  return hasAnyEnv
    ? {
        ...(userEnv ?? {}),
        ...tabtinEnv,
        ...(secretEnv ?? {}),
        ...(secretEnvKeys ? { [SKILL_CREDENTIAL_PRESERVE_ENV_KEYS_MARKER]: secretEnvKeys.join(',') } : {}),
      }
    : undefined;
}

function requireShellContext(
  context: ToolContext,
  spaceId: string | undefined,
  agentId: string | undefined,
): {
  toolUseId: string;
  effectiveSpaceId: string;
  /** 真实 Agent id；未烘焙时为空串（不回落 spaceId）。Skill 凭据路径另有校验。 */
  effectiveAgentId: string;
  threadId: string;
} {
  const toolUseId = context.toolUseId;
  if (!toolUseId) {
    throw new Error(
      'ShellCap.run_terminal_command: context.toolUseId is missing — ' +
        'orchestration must transit block.id to ToolContext.toolUseId. ' +
        'See `packages/agent-runtime/src/engine/tool-orchestration.ts` ' +
        "perBlockContext path and `shell-bridge-contract.ts` hard contract. " +
        "Legacy single-tool tests must explicitly set `toolUseId: 'mock-tool-use'` " +
        'on the ToolContext mock.',
    );
  }
  if (!spaceId) throwMissingSpaceId();
  if (!context.threadId) throwMissingThreadId();
  return {
    toolUseId,
    effectiveSpaceId: spaceId,
    effectiveAgentId: agentId?.trim() ?? '',
    threadId: context.threadId,
  };
}

function throwMissingSpaceId(): never {
  throw new Error(
    'ShellCap.run_terminal_command: baked spaceId is missing — ' +
      'host must bake spaceId into ShellCapInit at assembly time ( RB2). ' +
      'agentMeta.spaceId / agentId are hard contract fields (see ' +
      '`shell-bridge-contract.ts` / host PtyManagerBridge contract). ' +
      'Production path: query.ts main loop transits effectiveSpaceId; ' +
      'test mocks must explicitly set `spaceId: "mock-space"` on ToolContext. ' +
      '\nMost common production cause: the host (ElectronAgentHost / ' +
      'DaemonAgentHost) did not propagate the active Space id into ' +
      '`runtime.query({ spaceId })`. For Electron, verify the renderer ' +
      'passes `spaceId` in the `agent-engine:query` IPC payload (see ' +
      '`LocalAgentStreamOptions.spaceId` / `QueryRequest.spaceId` JSDoc) — ' +
      'historically the host fell back to `getCLISpaceId()` global ' +
      'singleton, which races with the async `space:set-active` IPC and ' +
      'silently routes sessions to `spaces/_unscoped/` when that race ' +
      'loses.',
  );
}

function throwMissingThreadId(): never {
  throw new Error(
    'ShellCap.run_terminal_command: context.threadId is missing — ' +
      'threadId is a hard contract field (the routing key for background ' +
      'task terminal-state delivery; see F7 in the 终端假运行根治 PRD and ' +
      '`shell-bridge-contract.ts`). Production path: host query entry rejects ' +
      'empty sessionId and transits sessionConfig.threadId; subagents get ' +
      'a synthetic `agent-${childId}`. Test mocks must explicitly set ' +
      '`threadId: "test-thread"` on the ToolContext.',
  );
}

function managedTaskStore(bridge: PtyManagerBridge): ShellManagedTaskStorePort | undefined {
  return typeof bridge.getManagedTaskStore === 'function'
    ? bridge.getManagedTaskStore()
    : undefined;
}

function makeProgressEmitter(params: {
  context: ToolContext;
  fallbackEmitter?: (event: StreamEvent) => void;
  toolUseId: string;
  command: string;
}): (snapshot: AgentCommandProgressSnapshot & {
  sessionId: string;
  pid?: number | null;
  outputFile?: string;
}) => void {
  return (snapshot) => {
    const emitter = params.context.emitStreamEvent ?? params.fallbackEmitter;
    try {
      emitter?.(new RuntimeSystemNoticeEvent({
          content: 'Tool progress: run_terminal_command',
          notice_type: 'tool_progress',
          severity: 'silent',
          tool_name: 'run_terminal_command',
          tool_call_id: params.toolUseId,
          phase: 'progress',
          stdout: snapshot.stdout,
          output_bytes: snapshot.outputBytes,
          truncated: snapshot.truncated,
          captured_at: snapshot.capturedAt,
          session_id: snapshot.sessionId,
          pid: snapshot.pid ?? undefined,
          output_file: snapshot.outputFile,
          command: params.command,
      }).toStreamEvent());
    } catch {
      // Progress notices are best-effort; tool execution result remains authoritative.
    }
  };
}

type SpawnOutcome =
  | { type: 'dedup'; record: NonNullable<ReturnType<ShellManagedTaskStorePort['get']>> }
  | { type: 'spawned'; det: AgentSpawnDetachedResult }
  | { type: 'spawnError'; err: unknown };

async function spawnAgentCommand(params: {
  bridge: PtyManagerBridge;
  store: ShellManagedTaskStorePort | undefined;
  request: AgentCommandRequest;
  context: ToolContext;
  command: string;
  mergedEnv: Record<string, string> | undefined;
  threadId: string;
  onPrepared: (prepared: ShellFileHistoryPrepareResult | undefined) => void;
}): Promise<SpawnOutcome> {
  const doSpawn = async (): Promise<SpawnOutcome> => {
    try {
      return { type: 'spawned', det: await params.bridge.spawnAgentSessionDetached(params.request) };
    } catch (err) {
      return { type: 'spawnError', err };
    }
  };
  const cwdForDedup = params.context.workspaceRoot;
  if (!params.store || !cwdForDedup) {
    params.onPrepared(await prepareShellFileHistoryTracking(params.context));
    return doSpawn();
  }
  return params.store.runSpawnSerialized(
    { command: params.command, cwd: cwdForDedup, env: params.mergedEnv, threadId: params.threadId },
    async (): Promise<SpawnOutcome> => {
      const dedupHit = params.store!.findDedupCandidate({
        command: params.command,
        cwd: cwdForDedup,
        env: params.mergedEnv,
        threadId: params.threadId,
      });
      if (dedupHit) return { type: 'dedup', record: dedupHit };
      params.onPrepared(await prepareShellFileHistoryTracking(params.context));
      return doSpawn();
    },
  );
}

function buildDedupResult(params: {
  store: ShellManagedTaskStorePort | undefined;
  record: ReturnType<ShellManagedTaskStorePort['get']> & {};
  attachHistory: (envelope: Record<string, unknown>) => void;
  pathQuotingWarnings: Array<{ path: string; hint: string }> | undefined;
}): ToolResult {
  const dedup = params.record;
  params.store?.markBackgroundExposed(dedup.session_id);
  const envelope: Record<string, unknown> = {
    status: 'running',
    session_id: dedup.session_id,
    pid: dedup.pid,
    stdout_tail: '',
    stdout_byte_count: dedup.stdout_byte_count,
    elapsed_ms: Date.now() - dedup.started_at,
    output_file: dedup.output_file_path,
    hard_timeout_ms: dedup.hard_timeout_ms,
    hint: {
      next_action: 'continue',
      reason:
        `Deduplicated to an existing identical command started within ${DEDUP_WINDOW_MS}ms in this thread. ` +
        `It is still running in background (pid=${dedup.pid ?? 'unknown'}); ` +
        `you will be notified when it completes. ` +
        `(If you really wanted to re-run, wait > 1s or change cwd/env.)`,
    },
    dedup_hit: true,
    path_quoting_warnings: params.pathQuotingWarnings,
  };
  params.attachHistory(envelope);
  return { content: JSON.stringify(envelope, null, 0) };
}

function buildSpawnErrorResult(params: {
  err: unknown;
  workspaceRoot: string | undefined;
  pathQuotingWarnings: Array<{ path: string; hint: string }> | undefined;
}): ToolResult {
  const message = describeError(params.err);
  const spawnErrCode = (params.err as { code?: unknown } | null)?.code;
  if (spawnErrCode === 'EXECUTION_ROOT_UNREACHABLE') {
    const badCwd = (params.err as { cwd?: unknown } | null)?.cwd ?? params.workspaceRoot ?? '(unknown)';
    return jsonError(`Working directory is unreachable: ${String(badCwd)}`, {
      status: 'failed',
      error_kind: CWD_NOT_FOUND,
      hint: {
        next_action: 'ask_user',
        reason:
          `The Space's working directory "${String(badCwd)}" no longer exists or is ` +
          `unreachable (deleted, moved/renamed, or its external/network volume is not ` +
          `mounted). This is NOT a shell problem — do NOT retry with a different shell ` +
          `path (e.g. /bin/bash) and do NOT silently cd into another directory. Tell ` +
          `the user their working directory is gone and ask them (via ask_user) to ` +
          `re-select a working directory for this Space (or remount the volume), then retry.`,
      },
      path_quoting_warnings: params.pathQuotingWarnings,
    });
  }
  const limitReached = /agent session limit reached/i.test(message);
  return jsonError(`Failed to spawn shell process: ${message}`, {
    status: 'failed',
    error_kind: SPAWN_FAILURE,
    error: message,
    hint: {
      next_action: limitReached ? 'ask_user' : 'fix_command',
      reason: limitReached
        ? 'Per-Space agent session limit reached. Wait for an existing background task to finish before retrying.'
        : 'Shell bridge could not start the process (typical causes: transcript manager not initialized, process spawn failure). Inspect the error message and retry once if it looks transient.',
    },
    path_quoting_warnings: params.pathQuotingWarnings,
  });
}

function stdoutRedirectWarning(command: string, outputFilePath: string): string | undefined {
  const redirectTarget = detectStdoutRedirect(command);
  return redirectTarget
    ? `⚠ Detected stdout redirect to "${redirectTarget}". The bridge's output_file ` +
      `(${outputFilePath}) will likely be EMPTY because stdout is captured by your ` +
      `redirect. To check progress: \`read_file("${redirectTarget}")\` (NOT output_file). ` +
      `Note: this detector ignores $var paths, command substitution, and complex quoting.`
    : undefined;
}

async function buildImmediateBackgroundResult(params: {
  store: ShellManagedTaskStorePort | undefined;
  sessionId: string;
  outputFilePath: string;
  hardTimeoutMs: number | undefined;
  stdoutRedirectWarning: string | undefined;
  waitMsClamped: string | undefined;
  pathQuotingWarnings: Array<{ path: string; hint: string }> | undefined;
  mergeHistory: (envelope: Record<string, unknown>, opts?: { deferred?: boolean }) => Promise<void>;
}): Promise<ToolResult> {
  params.store?.markBackgroundExposed(params.sessionId);
  const envelope: Record<string, unknown> = {
    status: 'running',
    session_id: params.sessionId,
    pid: params.store?.get(params.sessionId)?.pid,
    stdout_tail: '',
    stdout_byte_count: 0,
    elapsed_ms: 0,
    output_file: params.outputFilePath,
    hard_timeout_ms: params.hardTimeoutMs,
    hint: {
      next_action: 'continue',
      reason:
        'Task started in background (wait_ms=0). ' +
        'You will be notified when it completes (push notification). ' +
        'Use `read_file(output_file)` to view progress; pass `pattern` next time to detect readiness early.',
    },
    stdout_redirect_warning: params.stdoutRedirectWarning,
    input_clamped: params.waitMsClamped,
    path_quoting_warnings: params.pathQuotingWarnings,
  };
  await params.mergeHistory(envelope, { deferred: true });
  return { content: JSON.stringify(envelope, null, 0) };
}

function readFullSessionOutput(params: {
  bridge: PtyManagerBridge;
  sessionId: string;
  getLastRead: () => AgentReadResult | null;
}): () => Promise<AgentReadResult> {
  return async () => {
    try {
      return await params.bridge.readAgentSessionOutput(params.sessionId, { sinceByteOffset: 0 });
    } catch {
      return params.getLastRead()!;
    }
  };
}

/**
 * 前台 poll 命中 abort：seal-then-kill，再返回 failed。
 *
 * ：旧路径只 markNotified，ManagedTaskStore 仍 running → 对话步骤已「失败」
 * 但 PendingTasksNotice 仍挂「运行中」。须先同步 seal，再 best-effort kill。
 */
async function buildAbortResult(params: {
  bridge: PtyManagerBridge;
  store: ShellManagedTaskStorePort | undefined;
  sessionId: string;
  pathQuotingWarnings: Array<{ path: string; hint: string }> | undefined;
}): Promise<ToolResult> {
  // seal-then-kill：seal 必须在 await kill 之前，listRunning 立刻为空。
  params.store?.updateOnExit(params.sessionId, {
    status: 'killed',
    exit_code: -1,
    exited_by: 'signal',
    killed_reason: 'user_interrupt',
  });
  params.store?.markNotified(params.sessionId);
  try {
    await params.bridge.killAgentSession?.(params.sessionId, 'SIGTERM');
  } catch {
    // session 已没 / bridge 不支持 → 忽略；store 已 seal，底条不再展示。
  }
  return jsonError('Tool call aborted before completion.', {
    status: 'failed',
    error_kind: REQUEST_TIMEOUT,
    error: 'abort_signal',
    hint: {
      next_action: 'ask_user',
      reason:
        'The tool call was interrupted (user cancel or orchestration abort). ' +
        'The process has been terminated.',
    },
    session_id: params.sessionId,
    path_quoting_warnings: params.pathQuotingWarnings,
  });
}

async function readNextSessionOutput(params: {
  bridge: PtyManagerBridge;
  store: ShellManagedTaskStorePort | undefined;
  sessionId: string;
  pollCursor: number;
  pathQuotingWarnings: Array<{ path: string; hint: string }> | undefined;
}): Promise<{ ok: true; lastRead: AgentReadResult } | { ok: false; result: ToolResult }> {
  try {
    return {
      ok: true,
      lastRead: await params.bridge.readAgentSessionOutput(params.sessionId, {
        sinceCursor: params.pollCursor,
      }),
    };
  } catch {
    params.store?.markNotified(params.sessionId);
    return {
      ok: false,
      result: jsonError(`Lost track of spawned session ${params.sessionId}.`, {
        status: 'failed',
        error_kind: INTERNAL_ERROR,
        error: 'session_lost_after_spawn',
        hint: {
          next_action: 'ask_user',
          reason: 'The bridge reported the session disappeared right after spawn. This is unusual; try again or ask the user to relaunch the app.',
        },
        path_quoting_warnings: params.pathQuotingWarnings,
      }),
    };
  }
}

async function maybeHandleKillRequest(params: {
  bridge: PtyManagerBridge;
  store: ShellManagedTaskStorePort | undefined;
  sessionId: string;
  lastRead: AgentReadResult;
  readFullOutput: () => Promise<AgentReadResult>;
  command: string;
  secretEnv: Record<string, string> | undefined;
  startedAt: number;
  outputFilePath: string;
  hardTimeoutMs: number | undefined;
  stdoutRedirectWarning: string | undefined;
  waitMsClamped: string | undefined;
  pathQuotingWarnings: Array<{ path: string; hint: string }> | undefined;
  mergeHistory: (envelope: Record<string, unknown>, opts?: { deferred?: boolean }) => Promise<void>;
}): Promise<ToolResult | null> {
  if (!params.store?.consumeKillRequest(params.sessionId)) return null;
  try {
    await params.bridge.killAgentSession?.(params.sessionId, 'SIGTERM');
  } catch {
    // session 已没了 / bridge 不支持 → 忽略，下面照常返回终止 envelope。
  }
  const fullKill = await params.readFullOutput();
  const normalizedKill = normalizeAgentStdout(fullKill.output, params.command);
  const redactedKill = params.secretEnv
    ? redactSecretsInOutput(normalizedKill, params.secretEnv)
    : normalizedKill;
  params.store?.markNotified(params.sessionId);
  const envelope: Record<string, unknown> = {
    status: 'completed',
    session_id: params.sessionId,
    exit_code: -1,
    exited_by: 'signal',
    killed_reason: 'user_interrupt',
    duration_ms: Date.now() - params.startedAt,
    stdout: takeTail(redactedKill, STDOUT_TAIL_BYTES),
    output_file: params.outputFilePath,
    hard_timeout_ms: params.hardTimeoutMs,
    hint: {
      next_action: 'continue',
      reason:
        'User manually stopped this command from the terminal card. ' +
        'The process has been terminated. Continue based on the partial ' +
        'output above, or ask the user how they want to proceed.',
    },
    stdout_redirect_warning: params.stdoutRedirectWarning,
    input_clamped: params.waitMsClamped,
    path_quoting_warnings: params.pathQuotingWarnings,
  };
  await params.mergeHistory(envelope);
  return { content: JSON.stringify(envelope, null, 0) };
}

async function maybeHandlePatternMatch(params: {
  patternRegex: RegExp | undefined;
  patternHit: { text: string; byte_offset: number } | undefined;
  patternWindow: string;
  lastRead: AgentReadResult;
  store: ShellManagedTaskStorePort | undefined;
  sessionId: string;
  readFullOutput: () => Promise<AgentReadResult>;
  command: string;
  secretEnv: Record<string, string> | undefined;
  startedAt: number;
  outputFilePath: string;
  hardTimeoutMs: number | undefined;
  stdoutRedirectWarning: string | undefined;
  waitMsClamped: string | undefined;
  pathQuotingWarnings: Array<{ path: string; hint: string }> | undefined;
  mergeHistory: (envelope: Record<string, unknown>, opts?: { deferred?: boolean }) => Promise<void>;
}): Promise<{
  patternWindow: string;
  patternHit: { text: string; byte_offset: number } | undefined;
  result?: ToolResult;
  continueLoop?: boolean;
}> {
  if (!params.patternRegex || params.patternHit) {
    return { patternWindow: params.patternWindow, patternHit: params.patternHit };
  }
  const patternWindow = (params.patternWindow + params.lastRead.output).slice(-PATTERN_MATCH_WINDOW_BYTES);
  const matchResult = tryMatchPattern(params.patternRegex, patternWindow);
  if ('redos' in matchResult) {
    params.store?.markNotified(params.sessionId);
    return {
      patternWindow,
      patternHit: undefined,
      result: jsonError('Pattern regex took too long (>100ms), suspected ReDoS — aborting.', {
        status: 'failed',
        error_kind: INVALID_PARAM_FORMAT,
        hint: {
          next_action: 'fix_command',
          reason: 'Use a more specific pattern with anchors. Avoid catastrophic backtracking like `(a+)+b`.',
        },
        session_id: params.sessionId,
        path_quoting_warnings: params.pathQuotingWarnings,
      }),
    };
  }
  if (!matchResult.matched) return { patternWindow, patternHit: params.patternHit };
  const patternHit = { text: matchResult.text, byte_offset: matchResult.byte_offset };
  if (!params.lastRead.isRunning) return { patternWindow, patternHit };
  const releasedClaim = params.store?.releaseSyncNotificationClaim(params.sessionId);
  if (releasedClaim && releasedClaim.status !== 'running') return { patternWindow, patternHit, continueLoop: true };
  return buildPatternRunningResult({ ...params, patternHit, patternWindow });
}

async function buildPatternRunningResult(params: {
  patternWindow: string;
  patternHit: { text: string; byte_offset: number };
  lastRead: AgentReadResult;
  store: ShellManagedTaskStorePort | undefined;
  sessionId: string;
  readFullOutput: () => Promise<AgentReadResult>;
  command: string;
  secretEnv: Record<string, string> | undefined;
  startedAt: number;
  outputFilePath: string;
  hardTimeoutMs: number | undefined;
  stdoutRedirectWarning: string | undefined;
  waitMsClamped: string | undefined;
  pathQuotingWarnings: Array<{ path: string; hint: string }> | undefined;
  mergeHistory: (envelope: Record<string, unknown>, opts?: { deferred?: boolean }) => Promise<void>;
}): Promise<{
  patternWindow: string;
  patternHit: { text: string; byte_offset: number };
  result: ToolResult;
}> {
  const fullForPattern = await params.readFullOutput();
  const normalizedForPattern = normalizeAgentStdout(fullForPattern.output, params.command);
  const redactedOutput = params.secretEnv
    ? redactSecretsInOutput(normalizedForPattern, params.secretEnv)
    : normalizedForPattern;
  params.store?.markBackgroundExposed(params.sessionId);
  const envelope: Record<string, unknown> = {
    status: 'running',
    session_id: params.sessionId,
    pid: params.lastRead.pid,
    stdout_tail: takeTail(redactedOutput, STDOUT_TAIL_BYTES),
    stdout_byte_count: params.lastRead.outputBytes,
    elapsed_ms: Date.now() - params.startedAt,
    output_file: params.outputFilePath,
    hard_timeout_ms: params.hardTimeoutMs,
    pattern_matched: params.patternHit,
    hint: {
      next_action: 'continue',
      reason:
        `Pattern matched at byte_offset ${params.patternHit.byte_offset}. ` +
        `Command is still running in background (pid=${params.lastRead.pid ?? 'unknown'}). ` +
        `You can continue with other work (you will be notified on completion), ` +
        `or run \`kill ${params.lastRead.pid ?? '<pid>'}\` via run_terminal_command to stop it.`,
    },
    stdout_redirect_warning: params.stdoutRedirectWarning,
    input_clamped: params.waitMsClamped,
    path_quoting_warnings: params.pathQuotingWarnings,
  };
  await params.mergeHistory(envelope, { deferred: true });
  return { patternWindow: params.patternWindow, patternHit: params.patternHit, result: { content: JSON.stringify(envelope, null, 0) } };
}

function inferExitedBy(exitCode: number): 'normal_exit' | 'exec_failure' | 'signal' {
  if (exitCode === 126 || exitCode === 127) return 'exec_failure';
  return exitCode < 0 ? 'signal' : 'normal_exit';
}

async function maybeHandleCompleted(params: {
  lastRead: AgentReadResult;
  readFullOutput: () => Promise<AgentReadResult>;
  command: string;
  secretEnv: Record<string, string> | undefined;
  startedAt: number;
  outputFilePath: string;
  context: ToolContext;
  toolUseId: string;
  sessionId: string;
  store: ShellManagedTaskStorePort | undefined;
  patternHit: { text: string; byte_offset: number } | undefined;
  stdoutRedirectWarning: string | undefined;
  waitMsClamped: string | undefined;
  pathQuotingWarnings: Array<{ path: string; hint: string }> | undefined;
  mergeHistory: (envelope: Record<string, unknown>, opts?: { deferred?: boolean }) => Promise<void>;
}): Promise<ToolResult | null> {
  if (params.lastRead.isRunning) return null;
  const fullRead = await params.readFullOutput();
  const normalizedOutput = normalizeAgentStdout(fullRead.output, params.command);
  const fullOutput = params.secretEnv
    ? redactSecretsInOutput(normalizedOutput, params.secretEnv)
    : normalizedOutput;
  const fullBytes = Buffer.byteLength(fullOutput, 'utf-8');
  const truncated = fullBytes > STDOUT_INLINE_MAX_BYTES || fullRead.truncated;
  const inlineStdout = truncated
    ? buildHeadTailPreview(fullOutput)
    : fullOutput;
  const persistedFullPath = truncated
    ? await persistLargeOutput({
        sessionId: params.context.threadId ?? params.sessionId,
        toolUseId: params.toolUseId,
        content: fullOutput,
      })
    : undefined;
  params.store?.markNotified(params.sessionId);
  const exitCode = params.lastRead.exitCode ?? -1;
  const envelope: Record<string, unknown> = {
    status: 'completed',
    session_id: params.sessionId,
    exit_code: exitCode,
    exited_by: inferExitedBy(exitCode),
    duration_ms: Math.max(0, (params.lastRead.lastOutputAt || Date.now()) - params.startedAt),
    stdout: inlineStdout,
    stdout_truncated: truncated || undefined,
    full_output_path: persistedFullPath,
    control_signals: truncated ? extractJsonControlSignals(fullOutput) : undefined,
    output_file: params.outputFilePath,
    pattern_matched: params.patternHit,
    stdout_redirect_warning: params.stdoutRedirectWarning,
    input_clamped: params.waitMsClamped,
    path_quoting_warnings: params.pathQuotingWarnings,
  };
  await params.mergeHistory(envelope);
  // ：core shell 不建业务卡、不产业务 llmSummary——只把执行事实
  // （命令 / 已脱敏的完整 stdout / exitCode / bridge tail 路径）附在瞬态
  // `hostMetadata` 上，交给 host afterToolResult hook 识别 browser/table/oss 并建卡。
  // 关键：`fullOutput` 已在 shell 侧完成 normalize + redact（host 无 secretEnv），
  // 保证脱敏在正典处发生。无 host hook 消费时，content 仍是原始命令结果，
  // hostMetadata 只是附带、不进 LLM / 不落库（消费方 hook 用完清空）。
  return {
    content: JSON.stringify(envelope, null, 0),
    hostMetadata: {
      command: params.command,
      fullOutput,
      exitCode,
      outputFilePath: params.outputFilePath,
    },
  };
}

async function waitForNextPoll(context: ToolContext, remaining: number): Promise<void> {
  const sleepMs = Math.min(POLL_INTERVAL_MS, remaining);
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, sleepMs);
    context.abortSignal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

async function pollForegroundSession(params: {
  bridge: PtyManagerBridge;
  context: ToolContext;
  store: ShellManagedTaskStorePort | undefined;
  sessionId: string;
  outputFilePath: string;
  command: string;
  secretEnv: Record<string, string> | undefined;
  startedAt: number;
  effectiveWaitMs: number;
  hardTimeoutMs: number | undefined;
  patternRegex: RegExp | undefined;
  stdoutRedirectWarning: string | undefined;
  waitMsClamped: string | undefined;
  pathQuotingWarnings: Array<{ path: string; hint: string }> | undefined;
  toolUseId: string;
  mergeHistory: (envelope: Record<string, unknown>, opts?: { deferred?: boolean }) => Promise<void>;
}): Promise<ToolResult> {
  const deadline = params.startedAt + params.effectiveWaitMs;
  let lastRead: AgentReadResult | null = null;
  let patternHit: { text: string; byte_offset: number } | undefined;
  let pollCursor = 0;
  let patternWindow = '';
  const readFullOutput = readFullSessionOutput({
    bridge: params.bridge,
    sessionId: params.sessionId,
    getLastRead: () => lastRead,
  });

  while (true) {
    if (params.context.abortSignal?.aborted) return await buildAbortResult(params);
    const read = await readNextSessionOutput({ ...params, pollCursor });
    if (!read.ok) return read.result;
    lastRead = read.lastRead;
    if (typeof lastRead.nextCursor === 'number') pollCursor = lastRead.nextCursor;

    const killed = await maybeHandleKillRequest({ ...params, lastRead, readFullOutput });
    if (killed) return killed;

    const pattern = await maybeHandlePatternMatch({
      ...params,
      patternHit,
      patternWindow,
      lastRead,
      readFullOutput,
    });
    patternHit = pattern.patternHit;
    patternWindow = pattern.patternWindow;
    if (pattern.result) return pattern.result;
    if (pattern.continueLoop) continue;

    const completed = await maybeHandleCompleted({ ...params, lastRead, readFullOutput, patternHit });
    if (completed) return completed;

    const detachOrTimeout = await maybeHandleDetachOrTimeout({ ...params, lastRead, readFullOutput, deadline });
    if (detachOrTimeout) return detachOrTimeout;
  }
}

async function maybeHandleDetachOrTimeout(params: {
  context: ToolContext;
  store: ShellManagedTaskStorePort | undefined;
  sessionId: string;
  lastRead: AgentReadResult;
  readFullOutput: () => Promise<AgentReadResult>;
  command: string;
  secretEnv: Record<string, string> | undefined;
  startedAt: number;
  outputFilePath: string;
  hardTimeoutMs: number | undefined;
  stdoutRedirectWarning: string | undefined;
  waitMsClamped: string | undefined;
  pathQuotingWarnings: Array<{ path: string; hint: string }> | undefined;
  effectiveWaitMs: number;
  deadline: number;
  mergeHistory: (envelope: Record<string, unknown>, opts?: { deferred?: boolean }) => Promise<void>;
}): Promise<ToolResult | null> {
  const trigger = params.store?.consumeDetachRequest(params.sessionId)
    ? { kind: 'user_detached' as const }
    : null;
  if (trigger) return finishForegroundAsRunningResult({ ...params, trigger });

  const remaining = params.deadline - Date.now();
  if (remaining > 0) {
    await waitForNextPoll(params.context, remaining);
    return null;
  }
  return finishForegroundAsRunningResult({
    ...params,
    trigger: { kind: 'wait_ms_exhausted', effectiveWaitMs: params.effectiveWaitMs },
  });
}

async function finishForegroundAsRunningResult(params: {
  sessionId: string;
  store: ShellManagedTaskStorePort | undefined;
  lastRead: AgentReadResult;
  readFullOutput: () => Promise<AgentReadResult>;
  command: string;
  secretEnv: Record<string, string> | undefined;
  startedAt: number;
  outputFilePath: string;
  hardTimeoutMs: number | undefined;
  stdoutRedirectWarning: string | undefined;
  waitMsClamped: string | undefined;
  pathQuotingWarnings: Array<{ path: string; hint: string }> | undefined;
  trigger: ForegroundDetachTrigger;
  mergeHistory: (envelope: Record<string, unknown>, opts?: { deferred?: boolean }) => Promise<void>;
}): Promise<ToolResult | null> {
  const outcome = await finishForegroundWaitAsBackgroundRunning(params);
  if (outcome.action === 'continue') return null;
  await params.mergeHistory(outcome.envelope, { deferred: true });
  return { content: JSON.stringify(outcome.envelope, null, 0) };
}

async function handleSpawnedSession(params: {
  bridge: PtyManagerBridge;
  context: ToolContext;
  store: ShellManagedTaskStorePort | undefined;
  det: AgentSpawnDetachedResult;
  command: string;
  secretEnv: Record<string, string> | undefined;
  effectiveWaitMs: number;
  hardTimeoutMs: number | undefined;
  patternRegex: RegExp | undefined;
  waitMsClamped: string | undefined;
  pathQuotingWarnings: Array<{ path: string; hint: string }> | undefined;
  toolUseId: string;
  emitProgress: (snapshot: AgentCommandProgressSnapshot & {
    sessionId: string;
    pid?: number | null;
    outputFile?: string;
  }) => void;
  mergeHistory: (envelope: Record<string, unknown>, opts?: { deferred?: boolean }) => Promise<void>;
}): Promise<ToolResult> {
  const startedAt = Date.now();
  const sessionId = params.det.sessionId;
  const outputFilePath = params.det.outputFilePath;
  if (params.effectiveWaitMs > 0) {
    params.emitProgress({
      stdout: '',
      outputBytes: 0,
      truncated: false,
      capturedAt: Date.now(),
      sessionId,
      pid: params.store?.get(sessionId)?.pid,
      outputFile: outputFilePath,
    });
  }
  const redirectWarning = stdoutRedirectWarning(params.command, outputFilePath);
  if (params.effectiveWaitMs === 0) {
    return buildImmediateBackgroundResult({
      ...params,
      sessionId,
      outputFilePath,
      stdoutRedirectWarning: redirectWarning,
    });
  }
  return pollForegroundSession({
    ...params,
    sessionId,
    outputFilePath,
    stdoutRedirectWarning: redirectWarning,
    startedAt,
  });
}

interface ShellExecuteDeps {
  bridge: PtyManagerBridge;
  /**  RB2：host 装配期烘焙的业务身份（per-runtime 常量）。 */
  spaceId?: string;
  agentId?: string;
  organizationId?: string;
  skillContextProvider?: SkillContextProvider;
  emitStreamEvent?: (event: StreamEvent) => void;
  getRestrictedShellChecker: () => RestrictedShellAllowlistChecker | undefined;
  checkHardlineCommand: HardlineCommandChecker;
}

async function executeShellCommand(
  input: unknown,
  context: ToolContext,
  deps: ShellExecuteDeps,
): Promise<ToolResult> {
  const parsed = parseShellCommandInput(input);
  if (!parsed.ok) return parsed.result;

  const pathQuotingHits = detectUnquotedWorkspacePath(
    parsed.command,
    [context.workspaceRoot],
    resolveAgentShellInfo().kind,
  );
  const pathQuotingWarnings = pathQuotingHits.length > 0
    ? serializeQuotingHits(pathQuotingHits)
    : undefined;
  const hardlineRejection = buildHardlineRejection(
    deps.checkHardlineCommand,
    parsed.command,
    pathQuotingWarnings,
  );
  if (hardlineRejection) return hardlineRejection;
  const restrictedRejection = await buildRestrictedShellRejection({
    checker: deps.getRestrictedShellChecker(),
    command: parsed.command,
    pathQuotingWarnings,
  });
  if (restrictedRejection) return restrictedRejection;

  const credentials = await resolveSkillCredentialState(
    deps.skillContextProvider,
    context,
    deps.spaceId,
    deps.agentId,
  );
  emitSkillCredentialNotices(credentials, context, deps.emitStreamEvent);
  const mergedEnv = buildMergedShellEnv(
    context,
    parsed.env,
    credentials.secretEnv,
    deps.spaceId,
    deps.organizationId,
    deps.agentId,
  );
  const required = requireShellContext(context, deps.spaceId, deps.agentId);
  const store = managedTaskStore(deps.bridge);
  const emitProgress = makeProgressEmitter({
    context,
    fallbackEmitter: deps.emitStreamEvent,
    toolUseId: required.toolUseId,
    command: parsed.command,
  });

  let shellFileHistoryPrepare: ShellFileHistoryPrepareResult | undefined;
  const history = buildHistoryCallbacks(context, () => shellFileHistoryPrepare);
  const progressRouting: { sessionId?: string; outputFile?: string } = {};
  const request = buildAgentCommandRequest({
    parsed,
    context,
    required,
    mergedEnv,
    progressRouting,
    store,
    emitProgress,
  });
  const spawnOutcome = await spawnAgentCommand({
    bridge: deps.bridge,
    store,
    request,
    context,
    command: parsed.command,
    mergedEnv,
    threadId: required.threadId,
    onPrepared: (prepared) => {
      shellFileHistoryPrepare = prepared;
    },
  });
  if (spawnOutcome.type === 'dedup') {
    return buildDedupResult({ store, record: spawnOutcome.record, attachHistory: history.attachDedup, pathQuotingWarnings });
  }
  if (spawnOutcome.type === 'spawnError') {
    return buildSpawnErrorResult({ err: spawnOutcome.err, workspaceRoot: context.workspaceRoot, pathQuotingWarnings });
  }
  progressRouting.sessionId = spawnOutcome.det.sessionId;
  progressRouting.outputFile = spawnOutcome.det.outputFilePath;
  return handleSpawnedSession({
    bridge: deps.bridge,
    context,
    store,
    det: spawnOutcome.det,
    command: parsed.command,
    secretEnv: credentials.secretEnv,
    effectiveWaitMs: parsed.effectiveWaitMs,
    hardTimeoutMs: parsed.hardTimeoutMs,
    patternRegex: parsed.patternRegex,
    waitMsClamped: parsed.waitMsClamped,
    pathQuotingWarnings,
    toolUseId: required.toolUseId,
    emitProgress,
    mergeHistory: history.merge,
  });
}

function buildHistoryCallbacks(
  context: ToolContext,
  getPrepared: () => ShellFileHistoryPrepareResult | undefined,
): {
  merge: (envelope: Record<string, unknown>, opts?: { deferred?: boolean }) => Promise<void>;
  attachDedup: (envelope: Record<string, unknown>) => void;
} {
  return {
    merge: async (envelope, opts): Promise<void> => {
      const pre = getPrepared();
      if (!pre) return;
      const fh = await buildShellFileHistoryEnvelope({
        workspaceRoot: context.workspaceRoot,
        preSnapshot: pre.preSnapshot,
        preTrack: pre.preTrack,
        deferred: opts?.deferred,
      });
      attachShellFileHistoryToEnvelope(envelope, fh);
    },
    attachDedup: (envelope): void => {
      attachShellFileHistoryToEnvelope(envelope, {
        status: 'deferred',
        tracked_count: 0,
        changed_count: 0,
        created_untracked_count: 0,
        deleted_count: 0,
        modified_count: 0,
        scan_truncated: false,
        scan_failed: false,
        track_failed_count: 0,
        degraded: true,
        degraded_reason: 'background_deferred',
      } satisfies ShellFileHistoryEnvelope);
    },
  };
}

function buildAgentCommandRequest(params: {
  parsed: Extract<ShellCommandInput, { ok: true }>;
  context: ToolContext;
  required: {
    toolUseId: string;
    effectiveSpaceId: string;
    effectiveAgentId: string;
    threadId: string;
  };
  mergedEnv: Record<string, string> | undefined;
  progressRouting: { sessionId?: string; outputFile?: string };
  store: ShellManagedTaskStorePort | undefined;
  emitProgress: (snapshot: AgentCommandProgressSnapshot & {
    sessionId: string;
    pid?: number | null;
    outputFile?: string;
  }) => void;
}): AgentCommandRequest {
  return {
    command: params.parsed.command,
    cwd: params.context.workspaceRoot,
    env: params.mergedEnv,
    timeoutMs: params.parsed.hardTimeoutMs,
    signal: params.context.abortSignal,
    agentMeta: {
      toolUseId: params.required.toolUseId,
      spaceId: params.required.effectiveSpaceId,
      agentId: params.required.effectiveAgentId,
      threadId: params.required.threadId,
      notificationThreadId:
        params.context.notificationThreadId?.trim()
        || resolveToolNotificationThreadId(params.context),
      description: params.parsed.description ?? params.context.toolCallMetadata?.intent,
      originatedBy: 'local-llm-shellcap',
    },
    syncNotificationClaim: params.parsed.effectiveWaitMs > 0,
    onProgress: params.parsed.effectiveWaitMs > 0
      ? (snapshot) => {
          if (!params.progressRouting.sessionId) return;
          params.emitProgress({
            ...snapshot,
            sessionId: params.progressRouting.sessionId,
            pid: params.store?.get(params.progressRouting.sessionId)?.pid,
            outputFile: params.progressRouting.outputFile,
          });
        }
      : undefined,
  };
}

/**
 * **WP4（2026-05-14）**：abort 来源三态——LLM 决策的核心信号。
 *
 * 让 LLM 拿到 envelope 时区分"为什么命令没正常完成"，从而做正确的下一步：
 *   - `user_interrupt`：用户主动 abort（UI 中断按钮 / 关闭 Agent transcript tab
 *     传导到 abortSignal）→ **不应自动 retry**，应通过 `ask_user` 确认用户意图
 *   - `timeout`：bridge 主动按 `timeoutMs` 超时后台化 → **可以**用更长 `timeout`
 *     重跑 / 改用 `run_in_background: true` 让任务 detach 不阻塞主对话
 *   - `tool_call_cancelled`：orchestration 取消（同批 tool_call 内某个失败
 *     触发 cancel 其他 pending；或 query 主循环 abort 但非用户行为）
 *     → 与 `user_interrupt` 不同语义：不一定是用户意图，可能是上游 batch
 *     失败级联，LLM 可以根据 batch 内其他工具结果决定是否重试
 *
 * **当前 codebase 现状**（2026-05-14 dogfood 视角）：
 *   - `query.ts:1611-1613` `abort()` 不带 reason，所有 abort 路径 reason 是
 *     默认 `DOMException(AbortError)` —— 落到 `user_interrupt` 分支
 *   - orchestration 暂无"取消其他 pending tool"路径，`tool_call_cancelled`
 *     当前**未触发**，是预留语义槽
 *   - 未来 orchestration 加 batch-cancel 时显式传 `signal.aborted` reason
 *     带 `{ type: 'tool_call_cancelled' }` / `code: 'TOOL_CALL_CANCELLED'`
 *     即可命中本分支；下游 LLM 引导文案不需改
 */
// ─── ShellCap ────────────────────────────────────────────────────────

/**
 * ShellCap：单工具 `run_terminal_command` 贡献者。
 *
 * **clone 行为**：用 CapabilityBase 默认（_config 是 plain object 走
 * structuredClone）。`_skillContextProvider` / `_emitStreamEvent`
 * 含函数 / class instance —— structuredClone 走 fallback 路径保留原引用。
 * 这是合理的（这些都是宿主层无状态查询入口，多 cloned 实例共用同一份正是
 * 宿主期望语义；历史上已退役的 TabDocCap dispatcher 走过同一模式）。
 *
 * **Cap 不持有 inflight Promise / watcher / lock** —— 不需要 override clone。
 */
export class ShellCap extends CapabilityBase {
  readonly type = 'shell';
  readonly category: CapabilityCategory = 'core';

  private readonly _config: Readonly<ShellCapConfig>;
  private readonly _ptyBridge: PtyManagerBridge;
  private readonly _spaceId?: string;
  private readonly _agentId?: string;
  private readonly _organizationId?: string;
  private readonly _skillContextProvider?: SkillContextProvider;
  private readonly _emitStreamEvent?: (event: StreamEvent) => void;
  private readonly _defaultTimeoutMs: number;
  private readonly _checkHardlineCommand: HardlineCommandChecker;
  private readonly _resolvePresentation?: ShellPresentationResolver;
  /**
   * 受限模式（plan/ask/study）的 shell 白名单 checker。
   *
   * ：从 `readonly` 改为**可热更**——模式切换（switch_mode HITL 批准）
   * 需要在**同一轮内**把 shell 档位从受限切到非受限（或反向），而 ShellCap 是
   * session 级长生命周期实例。之前 checker 焊死导致 host 必须走完整 runtime 重建
   * （见 ElectronAgentHost `shellRestrictionChanged` 分支 / ），无法轮内热切换。
   * 现在通过 `setRestrictedShellChecker` 就地替换，配合 toolProvider.reconfigure +
   * systemPrompt mutate 让整套模式能力轮内一致生效。
   */
  private _restrictedShellChecker?: RestrictedShellAllowlistChecker;

  /**
   * **构造契约**（WP1 2026-05-13 收紧 +  Stage 3c）：
   *   - 必须传 `ShellCapInit` 形态且 `ptyManagerBridge` / `checkHardlineCommand` 非空。
   *   - 旧 `ShellCapConfig` 直传形态（无 init 嵌套）已**不再支持**——D6
   *     不留兼容性。生产装配点 / 单测都必须显式传上述字段。
   *   - bridge 缺失 → 同步 throw，宿主应 catch 后跳过 ShellCap 装配。
   */
  constructor(init: ShellCapInit) {
    super();
    if (!init || typeof init !== 'object') {
      throw new Error(
        'ShellCap: constructor requires ShellCapInit with required ptyManagerBridge — ' +
          'host must call resolvePtyManagerBridge() before assembling ShellCap.',
      );
    }
    if (!init.ptyManagerBridge) {
      throw new Error(
        'ShellCap: ptyManagerBridge is required — ' +
          'no PtyManagerBridge implementation injected. ' +
          'Host must call setPtyManagerBridge(...) (typically wired in ' +
          'ElectronAgentHost / DaemonAgentHost bootstrap) before assembling ShellCap. ' +
          'See `shell-bridge-contract.ts` for the local bridge contract.',
      );
    }
    if (typeof init.checkHardlineCommand !== 'function') {
      throw new Error(
        'ShellCap: checkHardlineCommand is required — ' +
          'host must inject a hardline checker (production: security-policy checkHardlineCommand).',
      );
    }
    this._config = Object.freeze({ ...(init.config ?? {}) });
    this._ptyBridge = init.ptyManagerBridge;
    this._checkHardlineCommand = init.checkHardlineCommand;
    this._spaceId = init.spaceId;
    this._agentId = init.agentId;
    this._organizationId = init.organizationId;
    this._skillContextProvider = init.skillContextProvider;
    this._emitStreamEvent = init.emitStreamEvent;
    this._defaultTimeoutMs = init.defaultTimeoutMs ?? DEFAULT_AGENT_COMMAND_TIMEOUT_MS;
    this._restrictedShellChecker = init.restrictedShellChecker;
    this._resolvePresentation = init.resolvePresentation;
  }

  tools(): Tool[] {
    return [this._executeCommandTool()];
  }

  /**
   * ：模式切换热更入口。
   *
   * 传入受限模式的 checker（plan/ask/study 传 tabtin-readonly checker），或
   * `undefined` 解除限制（切到 agent/group/yolo）。ShellCap 是 session 级实例，
   * `run_terminal_command` 的 execute 闭包持有 `this`，热更后同一实例即按新档位
   * 判定，无需重建工具或 runtime。仅此一处可变，其它构造字段仍 readonly。
   */
  setRestrictedShellChecker(
    checker: RestrictedShellAllowlistChecker | undefined,
  ): void {
    this._restrictedShellChecker = checker;
  }

  required_capability_types(): ReadonlySet<string> {
    return new Set();
  }

  // ── Tool factory ────────────────────────────────────────────────────

  private _executeCommandTool(): Tool {
    const bridge = this._ptyBridge;
    const spaceId = this._spaceId;
    const agentId = this._agentId;
    const organizationId = this._organizationId;
    const skillContextProvider = this._skillContextProvider;
    const emitStreamEvent = this._emitStreamEvent;
    const getRestrictedShellChecker = () => this._restrictedShellChecker;
    const checkHardlineCommand = this._checkHardlineCommand;
    return {
      name: 'run_terminal_command',
      resolvePresentation: this._resolvePresentation,
      // L1 description 治理纪律 + 内容演进日志见 0_active_renderers.md
      // `run_terminal_command_tool` notes 字段（单一真相源）。本注释只点 audit
      // 守门：description 改动必须跑 packages/agent-runtime/src/tools/__tests__/
      // tool-description-audit.test.ts 验证 P2 字符上限 + P7 硬契约 topic 全覆盖。
      //  / ：shell 语法只在 `<shell_runtime>`；工具描述为纯功能 +
      // 等待场景骨架，不含 bash/PowerShell/cmd 命令示例。
      description: buildExecCommandDescription(),
      inputSchema: executeCommandInputSchema,
      // 静态默认非只读（并发分区 fail-closed）；真实读写看 isWriteOp / isConcurrencySafe。
      isReadOnly: false,
      policyActionKind: 'shell',
      isWriteOp: (input: unknown) => {
        const { command } = (input ?? {}) as { command?: string };
        return isShellCommandWriteOp(typeof command === 'string' ? command : '');
      },
      isConcurrencySafe: (input: unknown) => {
        const { command } = (input ?? {}) as { command?: string };
        return !isShellCommandWriteOp(typeof command === 'string' ? command : '');
      },
      extractPolicyParams: (input: unknown) => {
        const { command } = (input ?? {}) as { command?: string };
        return command ? { command } : {};
      },
      maxResultSizeChars: EXEC_RESULT_MAX_CHARS,
      executionTimeoutMs: (input: unknown) => {
        // tool 整体执行时长上限 = wait_ms + grace。wait_ms 默认 60s，上限 300s。
        const { wait_ms } = (input ?? {}) as { wait_ms?: unknown };
        const requested =
          typeof wait_ms === 'number' && Number.isFinite(wait_ms) && wait_ms >= 0
            ? Math.floor(wait_ms)
            : DEFAULT_WAIT_MS;
        const clamped = Math.min(Math.max(requested, 0), MAX_WAIT_MS);
        return clamped + EXECUTION_TIMEOUT_GRACE_MS;
      },
      async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
        return executeShellCommand(input, context, {
          bridge,
          spaceId,
          agentId,
          organizationId,
          skillContextProvider,
          emitStreamEvent,
          getRestrictedShellChecker,
          checkHardlineCommand,
        });
      },
    };
  }
}
