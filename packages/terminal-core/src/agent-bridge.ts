/**
 * Agent Shell Bridge —— 本地 LLM shell 执行公共契约。
 *
 * **业务目标**（北极星）：本地 LLM 调 shell 工具时，命令用确定性的
 * 一次性子进程执行；Terminal Tab 只承载 transcript，让用户实时看输出。
 * 工具完成以进程 exit/timeout/abort 为准，不再依赖交互式 shell marker。
 *
 * **本文件的角色**：把 ShellCap（`packages/agent-runtime/src/capability/core/shell.ts`）
 * 跟两端 Terminal transcript 管理器（Electron `PtyManager` / Daemon
 * `DaemonPtyManager`）解耦的公共契约。Wave 内三个并行 Agent 共用同一份接口：
 *
 *   - **WP1（ShellCap 接入）**：ShellCap 调
 *     `PtyManagerBridge.executeAgentCommand` / `spawnAgentSessionDetached`，
 *     bridge 内部用一次性子进程执行命令
 *   - **WP2（Daemon PtyManager 对齐）**：在两端各实现 `PtyManagerBridge`
 *     接口，行为通过 contract test 强制一致（含事件 emit）
 *   - **WP3（UI 同步）**：通过 `bridge.subscribe('agent-session-created', ...)`
 *     消费事件，每次新开一个 Terminal Tab（D3：不复用、不分屏）
 *
 *   - D1（2026-05-17 修订）：本地 LLM 调 shell **必走一次性子进程**；
 *     PtyManager 只创建 transcript session，不参与命令完成判定
 *   - D2：（被 D11 修订）LLM 工具面原本设计为单工具 `run_terminal_command`；
 *     WP4 dogfood 反馈"LLM 没法主动停 background 任务"后修订为双工具
 *   - D3：每次 Agent 调 shell → 每次新 Terminal Tab，不复用
 *   - D4（2026-05-17 修订）：Agent tab 是输出 transcript，不接管 stdin；
 *     交互命令未来走单独 interactive 工具，不塞回普通 shell tool
 *   - D5：不加 Agent 视觉标识（`source: 'agent'` 仅作数据层标识）
 *   - D6：未上线，不做兼容性。shell bridge 未注入 → 启动失败
 *   - D7：不留 MVP / 中间态。本契约自身就是上线即成熟版
 *   - D8：TabTin 不做 MCP 输出——4 件套 MCP 暴露已在 WP5 删除
 *   - D9：暂不做跨设备执行。`PtyManagerBridge` 仅作本机两端（Electron /
 *     Daemon）的协议对齐，**不**为未来"远端执行环境"做超前抽象
 *   - D10：`DEFAULT_AGENT_COMMAND_TIMEOUT_MS = 120_000` 单源（常见 agent shell 超时共识），两端实现 + ShellCap 默认值
 *     统一从此常量取，避免漂移
 *   - D11：~~5-14 加专门 kill 工具~~（2026-05-23 push 通知重构废止；LLM
 *     kill 改用 `run_terminal_command kill <pid>` 单一路径，pid 在 running
 *     envelope 返回）。`killAgentSession` 作为**内部** API 保留——给
 *     `run_terminal_command("kill <pid>")` 物理 kill PID 路径 + ManagedTaskStore
 *     hard_timeout GC kill 用。
 *
 * **跟现有 4 件套（`PtyManagerAPI` / `TerminalRuntimeBridge`）的关系**：
 *   - 4 件套（`packages/action-tools/src/tools/terminal.ts`）面向**人控**
 *     场景：列 session / 读输出 / 写输入 / 执行命令——下游消费者是
 *     action-bridge / runtimes / future MCP。
 *   - `PtyManagerBridge` 面向 **AI 控**场景：LLM 跑命令 → 起独立
 *     transcript session + 自带 `agentMeta` 标识 + 由 child process exit
 *     拿结果 + 带订阅 / 事件机制。
 *   - 两套接口**独立 set / 独立 resolve**（见 `runtime-bridge.ts`），互不
 *     污染；Electron / Daemon 在 bootstrap 时都注入。
 *
 * **桩实现**：本文件 `unimplementedPtyManagerBridge` 提供所有方法都
 * `throw new Error('not implemented')` 的占位，供 WP1 在 WP2 真实实现落地
 * 前 import 来开发 / 跑单测——这是接口固化阶段的正确产物，不是 MVP。
 */

import type { TerminalAutoRespondRule } from './types';
import type { KilledReason } from './managed-task-store';

// ==================== Constants ====================

/**
 * Agent 命令默认超时（毫秒）。两端实现 + ShellCap 默认值统一从此常量取，
 * 避免 Electron / Daemon 漂出不同默认。
 *
 * 数值来源：常见 agent shell 超时共识（120s）
 */
export const DEFAULT_AGENT_COMMAND_TIMEOUT_MS = 120_000;

// ==================== Request ====================

/**
 * Agent 起 shell 命令的统一请求 schema。
 *
 * **设计原则**：
 *   - **agentMeta 必填**：每条 Agent 起的命令都必须带溯源信息（toolUseId /
 *     spaceId / agentId），这是"Agent 每步可追溯"产品价值的数据底座，也是
 *     后续 UI 标识 / 审计 / 跨 Wave 关联的唯一锚点。
 *   - **autoRespond / timeoutMs 走 LLM 视角语义**：LLM 心智里是"超时秒数"
 *     而非"阻塞毫秒数"，下层适配到子进程 timeout。
 *   - **不带 policy / route / sandboxLevel**：本地 LLM 安全策略（hardline /
 *     skill 脱敏）由 ShellCap 上层处理，bridge 只关心"怎么起进程 + transcript"，
 *     不重复决策。
 *   - **signal 透传**：用户中断 / orchestration 取消都通过 AbortSignal 走
 *     一条统一通道，bridge 实现层 abort → SIGTERM → 返回 `status: 'error'`。
 */
export interface AgentCommandRequest {
  /** 要执行的命令字符串。原样交给一次性 shell 子进程，不预先 shell escape。 */
  command: string;

  /** 工作目录。缺省时 bridge 使用 transcript session 的 cwd（首次 spawn 时为系统默认）。 */
  cwd?: string;

  /**
   * 追加进子进程的环境变量。会与 `sanitizeEnv(process.env)` 合并；
   * 同名键以本字段为准，但仍受 `DANGEROUS_INJECTION_VARS`（@tabtin/env-sanitize
   * 单源，被 `@tabtin/terminal-core` re-export）+ `SENSITIVE_ENV_VARS` 等执行层
   * 安全过滤约束（见 `packages/terminal-core/src/sanitizeEnv.ts` re-export 链）。
   * **agent-runtime 永不直接 import env-sanitize**：sanitize 在 bridge 实现层
   * 单点完成，避免 inline 副本漂移。
   */
  env?: Record<string, string>;

  /**
   * LLM 视角的超时（毫秒）。foreground 命令未在该时长内结束 → bridge
   * 终止子进程树并返回 `status: 'timeout'`。background 命令显式由
   * `spawnAgentSessionDetached` 接管，不用 foreground timeout 杀掉进度。
   *
   * 缺省值 = `DEFAULT_AGENT_COMMAND_TIMEOUT_MS`（120_000）。两端实现 +
   * ShellCap 必须从同一常量取，禁止各自硬编码。
   */
  timeoutMs?: number;

  /**
   * 自动应答规则。一次性子进程不支持交互式自动应答；字段保留给未来
   * 显式 interactive session 使用。
   * 与 `TerminalExecuteRequest.autoRespond` 同构（共用 `TerminalAutoRespondRule`）。
   *
   * **匹配语义**：实现层应在 `cleanOutput()` 后的字符串上做匹配（去 ANSI
   * 后）。一次性子进程当前不支持自动应答；交互式自动应答未来应放到独立
   * interactive terminal 工具里。
   */
  autoRespond?: TerminalAutoRespondRule[];

  /**
   * 取消信号。来源：
   *   - ShellCap 端：`ToolContext.abortSignal`（用户取消 / orchestration cancel）
   *
   * **行为约定**：
   *   - signal 已 aborted → bridge 同步 throw（不启动进程），与 timeout 路径
   *     语义对齐
   *   - 命令进行中 abort → bridge 给子进程树发 SIGTERM（3s 后 SIGKILL），
   *     返回 `status: 'error'` + `exitCode: null`
   *   - `spawnAgentSessionDetached` 路径下 signal abort → 等价
   *     `killAgentSession(SIGTERM)`
   */
  signal?: AbortSignal;

  /**
   * Agent 调用方溯源信息。**全部必填**——bridge 实现层会用这些字段：
   *   - 在 `agent-session-created` 事件 payload 里携带，让 UI（WP3）/
   *     审计日志关联到具体 Agent / Tool / Space
   *   - 拼 `sessionId`（约定为 `agent-{spaceId}-{Date.now()}-{rand4}`）
   *   - 拼 Terminal tab 标题（description 优先，缺失时用 command 截断兜底，
   *     最末用 sessionId 兜底）
   */
  agentMeta: {
    /**
     * ToolUse 唯一 ID（一次 LLM tool_call 对应一个）。
     *
     * **WP1 取值路径（已落地）**：直接从 `context.toolUseId` 取——WP0 收尾
     * 子 Agent 已经在 `packages/agent-runtime/src/engine/types.ts` 给
     * `ToolContext` 加了 `toolUseId?: string` 字段，并在 orchestration 三处
     * 调点透传（`tool-orchestration.ts` 内 `executeBatchParallel` /
     * `executeSingleTool` 调 `executeTool` 时按 block.id 浅拷贝覆盖；
     * `query.ts` pre-start 路径同款覆盖）。WP1 接入 ShellCap 时直接：
     *
     * ```ts
     * const toolUseId = context.toolUseId;
     * if (!toolUseId) throw new Error('ShellCap: ToolContext.toolUseId missing — orchestration must transit it');
     * req.agentMeta = { toolUseId, ... };
     * ```
     *
     * **必填语义**（hard dependency，不是 optional）：本字段是 `required string`
     * 不是 `?:`——bridge 实现层 / 事件 payload / Terminal tab 标题 / 审计落库
     * 都依赖它做唯一锚点。生产链路 ShellCap 见到 `context.toolUseId === undefined`
     * 视为契约违反 → 同步 throw 拒绝执行（不要降级为 sessionId / 空字符串
     * / 自生 UUID——背离"每步可追溯"产品价值）。仅 legacy 单测 mock context
     * 可能见 undefined，单测自己显式构造 `toolUseId: 'mock-tool-use'` 即可。
     */
    toolUseId: string;
    /** 该 Agent 所属 Space。 */
    spaceId: string;
    /** Agent 标识。 */
    agentId: string;
    /**
     * 同 Space 内的对话 thread ID（业务对话身份）。可缺省（Agent 直接由系统
     * 触发、没有用户 chat 上下文时）。
     *
     * 业务对话 thread（UI / CLI / 终端卡片 / relay）。子 Agent 上仍是父对话
     * id。**不再**兼 push 通知路由，见 `notificationThreadId`。
     *
     * **取值路径**：ShellCap 从 `ToolContext.threadId` 透传。
     *
     * §6.1 / §6.2 / §17.6；拆分见 。
     */
    threadId?: string;
    /**
     * 后台完成通知的 drain 路由键。
     * 主 Agent 与 `threadId` 相同；子 Agent 为 childId，对齐
     * `drainSubagentNotifications`。缺省时 producer 回落 `threadId`。
     */
    notificationThreadId?: string;
    /**
     * UI 用的人类可读描述（建议 ≤80 chars），用于 Terminal tab 标题 / 日志。
     *
     * **Tab title fallback 链**（`useAgentTerminalSync` L96-98 落地）：
     *   `description` ∶∶ `command.split('\n')[0].trim().slice(0, 60)` ∶∶
     *   `\`Agent Terminal · ${sessionId.slice(-6)}\``
     *
     * 中间级 `command` 数据源是 `AgentSessionCreated.command` 字段（必填，
     * 由 bridge 实现层透传 `AgentCommandRequest.command`）—— 用 hook 端按
     * UI 上下文截断而非在 bridge 截断，让审计 / 日志订阅者拿到完整命令体。
     *
     * **D3 后退役 `agent-session-title` 事件**：原 PtyManager 在命令执行时
     * 通过 marker boundary 解析命令字符串再 emit `agent-session-title` 实现
     * "同 session 多命令换标题"。D3 决策每次命令独立 session 后，标题在
     * `agent-session-created` 时一次定死，**WP2 应一并删除
     * `emitTitleIfNeeded` + `agent-session-title` IPC 通道**，**WP3 应一并
     * 删除 `onAgentSessionTitle` 订阅**——D7 不留中间态。
     */
    description?: string;
    /**
     * 触发本次执行的"上游"标识。当前 Wave 仅 `local-llm-shellcap`，
     * 4 件套 / MCP / CLI 走另一套（不会经过本 bridge）。
     *
     * **长期为单值**：当前所有本地 LLM shell 调用——包括 Skill 内的
     * `run_terminal_command`（Skill body 命令也是经过 ShellCap，**不是**
     * 另起一个 capability）——都走同一条 ShellCap 路径，因此 `originatedBy`
     * 字段长期保持单值字面量 `'local-llm-shellcap'`。
     *
     * **WP1 / 下游消费者注意**：bridge 实现层 / 事件订阅者 / UI 层**不需要
     * 写 switch 分支或兜底 fallback** —— 直接当字面量用。任何"未来可能改"
     * 的过渡期分支代码都是违反 D7（不留中间态）的过度设计。
     *
     * **解锁时机（仅供未来参考）**：仅在 D9 解锁后（跨设备 / 远程 Agent
     * 落地）才扩展为 union，新增可能值如 `'remote-agent'` /
     * `'cross-device-bridge'`。届时本字段才有分支语义；当前 Wave 不准备。
     */
    originatedBy: 'local-llm-shellcap';
  };

  /**
   * 进度回调（2026-05-17 加，配合 streaming tool_progress 协议）。
   *
   * **业务定位**：foreground 长跑命令（npm install / pytest / build）跑 30s
   * 期间，用户看到的 TerminalCard 不能是 spinner 黑屏——必须能看到 stdout
   * 逐行往下走。LLM 仍然等 atomic tool_result，但**前端 UI 实时刷新**。
   *
   * **行为约定**：
   *   - bridge 实现层在 `onOutput` 内部按"5 秒**或** stdout 累积 1KB 增量"
   *     先到为准触发回调（见 `createAgentProgressDispatcher` 共用 helper）
   *   - snapshot 是**自命令开始到现在的完整累积 stdout**（**不是增量 chunk**），
   *     已按 8KB 上限截断（头 4KB + 尾 4KB + truncated 标记，详见 dispatcher）
   *   - 命令完成 / timeout / abort 时**自动 flush 一次 + 停 timer**（避免泄漏）
   *   - 回调内部不抛错（dispatcher 用 try/catch 兜底）；回调实现者不允许在
   *     回调里做长 IO，以免阻塞主流
   *
   * **跟 `AgentCommandResult.stdout` 的关系**：result.stdout 是命令完全完成后
   * cleanOutput + 脱敏后的最终态；progress.stdout 是中途快照，可能含未清洗的
   * 终端控制字符（虽然 dispatcher 已做基础 cleanOutput）。下游 LLM 始终用
   * result.stdout，progress.stdout 只给 UI。
   *
   * **缺省语义**：`onProgress` 缺省 / undefined → bridge 不做任何节流计算，
   * 零开销。仅 ShellCap foreground 路径主动注入。
   */
  onProgress?: (snapshot: AgentCommandProgressSnapshot) => void;

  /**
   * ShellCap 同步等待路径的完成通知认领。
   *
   * `wait_ms > 0` 时 ShellCap 会尝试在当前 tool_result 同步交付 completed 终态。
   * bridge 必须在创建 ManagedTask record 时就写入该 claim，覆盖快命令在
   * ShellCap 首轮 poll 前退出的竞态；如果 ShellCap 等到 `wait_ms` 用尽返回
   * running，它会释放 claim，让后续后台完成 push 继续工作。
   */
  syncNotificationClaim?: boolean;
}

/**
 * 进度快照——`AgentCommandRequest.onProgress` 回调入参（2026-05-17）。
 *
 * **字段都是 snapshot 时刻的累积态**——bridge 已经做完截断，回调消费者
 * 直接拿来 emit SYSTEM_NOTICE 即可，不需要再做处理。
 */
export interface AgentCommandProgressSnapshot {
  /**
   * 当前累积 stdout 的截断后快照（≤ 8KB）。
   * 超 8KB 时按 head 4KB + `\n...[truncated]...\n` + tail 4KB 形态返回。
   */
  stdout: string;
  /** 命令开始到 snapshot 时刻的累积输出字节数（**未截断的真实值**），给 LLM/UI 显示规模。 */
  outputBytes: number;
  /** snapshot.stdout 是否经过截断（outputBytes > 8KB）。 */
  truncated: boolean;
  /** snapshot 抓取时刻（`Date.now()`）。给 UI 显示"上次更新于 Xs 前"。 */
  capturedAt: number;
}

// ==================== Result ====================

export type AgentCommandStatus = 'ok' | 'timeout' | 'error';

/**
 * Legacy timeout reason kept for older envelope readers.
 *
 * 2026-05-17 起 foreground timeout 会终止子进程树，不再把命令自动后台化。
 * 新 bridge 实现不应再填本字段；ShellCap 仍容忍旧 mock / 旧实现返回它。
 */
export type AgentBackgroundedReason = 'timeout-watcher';

/**
 * Foreground `executeAgentCommand` 的返回。
 *
 * **设计要点**：
 *   - `stdout` 是命令输出正文；bridge 实现应在返回前做必要的终端控制字符
 *     清理。一次性子进程路径没有 marker，也不需要 marker 切分。
 *   - `stderr` 单独字段是为了与 ShellCap 现有 tool result 形态对齐（LLM
 *     视角始终见到 stdout / stderr 二元）；**Agent shell bridge 把两路合进
 *     stdout，stderr 字段填空字符串**——WP1 应同步把 ShellCap 中 `classifyShellStderr`
 *     等依赖 stderr 的诊断短路链路改成"在 stdout + exitCode 上判别"，并
 *     重写 `_redact` 测试快照基线（D6：不留兼容）。
 *   - `outputBytes` 是**累计 emit 字节数**（含已被 ring buffer 驱逐的部分），
 *     给 LLM 决策"要不要看完整版"。
 *   - `outputFilePath` 是 foreground 原始合流输出的内部临时文件路径，仅供
 *     ShellCap 复制/脱敏成 `persisted_output_path`；bridge 不应把它直接
 *     暴露给 LLM。
 *   - `cwd` 反映命令执行完后的 shell 当前目录，与 `AgentReadResult.cwd` 字段
 *     对齐。D3 每次新 session 下大多等于请求的 `cwd`，但命令内 `cd /foo`
 *     会改变它，bridge 实现用 `pwd` 探针拿真实值；遇到 `exit` / `exec`
 *     等提前结束 shell 的命令时可回落到初始 cwd。
 *   - `degraded` / `degradedReason` 透传执行层降级路径的产品语义：当 bridge
 *     拒绝某些 policy（如 sandbox / network=blocked 时）→ 走 CommandExecutor
 *     sandbox 跑 → 返回 `degraded: true`；ShellCap 应原样透传给 LLM，让
 *     LLM 知道"我刚才不是标准 shell process 跑的"。
 */
export interface AgentCommandResult {
  /** 结果分类。background 路径不走本 result（走 `spawnAgentSessionDetached`）。 */
  status: AgentCommandStatus;

  /** 进程退出码。`null` 表示未正常 exit（被 kill / timeout / signal abort）。 */
  exitCode: number | null;

  /** stdout 正文（bridge 已做终端清理；ShellCap 返回前再做密钥脱敏）。 */
  stdout: string;

  /**
   * stderr 干净正文。
   *
   * **永远填空字符串**：Agent shell bridge 把 stdout/stderr 合流进 stdout，
   * 实现层不再尝试分离两路。字段保留只是为了与 ShellCap 现有 tool result 形态对齐
   * （LLM 视角始终见到 stdout / stderr 二元），避免上层重构。
   *
   * **ShellCap envelope 字段同步退役**：因 stderr 永远空，**WP1 必须
   * 同步删除**：
   *   1. ShellCap envelope 中的 `persisted_stderr_path` / `persisted_stderr_size`
   *      两个字段（见 `shell.ts:1623-1624` 当前生产位置）——合流后无意义；
   *   2. 依赖 stderr 的诊断短路链路 `classifyShellStderr`——改成在
   *      `stdout + exitCode` 上判别（exitCode!==0 时 stdout 末尾通常带
   *      err 信息，已足够 LLM 决策）；
   *   3. `_redact` 等针对 stderr 落盘文件的脱敏单测快照基线，重写为 stdout
   *      合流后的形态（D6：不留兼容）；
   *   4. `run_terminal_command` 工具 description 字符串中所有 LLM-visible
   *      `persisted_stderr_path` 引导文案（见 `shell.ts:1092-1097` 段：
   *      "单次 stderr 超 64KB 时落盘到 `persisted_stderr_path`" / "失败命令
   *      关键信息常在 stderr，记得也读 `persisted_stderr_path`" 等）。**改
   *      为只引导 `persisted_output_path` 单源**——合流后 stdout/stderr
   *      混在一起，LLM 看 `persisted_output_path` 即可。不删这段 LLM 会幻觉
   *      一个永远 undefined 的字段；
   *   5. `persistLargePreview` 内的 stderr 分叉（`shell.ts:367` 处的
   *      `fieldName = channel === 'stderr' ? 'persisted_stderr_path' :
   *      'persisted_output_path'`）：agent shell 路径下 channel 永远是 stdout，
   *      简化为单分支；
   *   6. ShellCap envelope `pid` 字段（`shell.ts:553` / `:789` background
   *      路径返回的 pid）：LLM 不应依赖系统 pid；改用 `sessionId`
   *      （→ envelope `background_task_id`）作为
   *      诊断 / 终止参考的单源 ID（与 D6 不留兼容对齐）。
   *
   * 详见总控文档「ShellCap envelope 字段映射」段。
   */
  stderr: string;

  /** 命令实际执行耗时（毫秒）。 */
  durationMs: number;

  /** 输出是否因 ring buffer 溢出被截断。`true` 时 LLM 应优先看落盘文件。 */
  truncated: boolean;

  /** 累计 emit 字节数（含已驱逐部分）。LLM 用 `outputBytes - stdout.length` 判断丢了多少。 */
  outputBytes: number;

  /**
   * foreground 原始合流输出临时文件。可能包含未脱敏内容，只能由 ShellCap
   * 内部读取后复制/脱敏，不能直接出现在 tool result envelope。
   */
  outputFilePath?: string;

  /** `outputFilePath` 对应文件大小（字节），缺失时用 `outputBytes` 兜底。 */
  outputFileSize?: number;

  /** 命令结束时 shell 的 cwd。 */
  cwd: string;

  /** 本次执行对应的 transcript session ID。供后续 `readAgentSessionOutput` / `killAgentSession`。 */
  sessionId: string;

  /**
   * 命令"背景化"的原因（legacy，仅旧实现可能返回）：
   *   - `timeout-watcher`：旧 PTY marker 路径超出 `timeoutMs` 后由 watcher 接管
   *
   * `status === 'ok'` / `status === 'error'` 时该字段不应出现。
   */
  backgroundedReason?: AgentBackgroundedReason;

  /**
   * `true` 表示本次执行被 bridge 层降级到 CommandExecutor sandbox 跑（policy
   * 驱动），不是真实 agent shell process 路径。ShellCap 应原样透传给 LLM。
   */
  degraded?: boolean;

  /** 降级原因（如 `'sandbox-not-supported-by-pty'` / 具体 policy 名）。 */
  degradedReason?: string;
}

/**
 * `spawnAgentSessionDetached` 的返回。
 *
 * **设计要点**：
 *   - `outputFilePath` **必填**：bridge 实现层在 detached 模式下持续 tail 一份
   *     磁盘副本（transcript 内部已有 outputBuffer，dump 到 tmpdir 即可）。LLM 拿到
 *     `sessionId + outputFilePath` 后可直接走现有 `read_file` 工具看进度，
 *     无需等 WP4 引入 `read_terminal_output` 工具，也无需引入新工具。
 *   - 不返回 stdout / cwd / exitCode 等——detached 模式下命令仍在跑，这些
 *     值无法即时确定；想看进度 → `readAgentSessionOutput` 或 `read_file`。
 */
export interface AgentSpawnDetachedResult {
  /**
   * 新建的 transcript session ID。
   *
   * **ShellCap 上层映射**：值应填进 envelope 的 `session_id` 字段
   * （2026-05-18 后台执行重构后字段名统一）。LLM 想停掉任务时跑
   * `run_terminal_command("kill <pid>")`（pid 在 status="running" envelope
   * 同时返回），最终走 `bridge.killAgentSession` 物理 kill PID 路径。
   */
  sessionId: string;

  /**
   * 持续 tail 的磁盘副本绝对路径。bridge 实现层负责创建 + 持续追加，
   * 在 session 退出 / cleanup 时**保留文件**（让 LLM 后续仍可读）。
   * 路径建议：`{tmpdir}/tabtin-agent-tasks/{sessionId}.log`。
   *
   * **ShellCap 上层映射**：本字段值应填进 envelope 的 `output_file` 字段
   * （沿用现有 `runInBackground` 路径的 TabTin Shell 契约 + macOS realpath
   * 兜底语义，与 `read-file-state.ts:327-348` 的 `canonicalizePath` 配对，
   * 保证 LLM 后续 `read_file` 调用时 dedup key 命中同一条目）。
   * **不要塞 `persisted_output_path`**——后者是 foreground 大输出 64KB
   * 阈值同步 truncate 落盘的独立机制（见 ShellCap `persistLargeOutput`
   * 路径），与 bridge 持续 tail 不同源、不双写。
   *
   * **bridge 实现层职责**（WP2 落地）：
   *   - 文件 fd 管理（open / close / 错误恢复）
   *   - 输出 burst 应对（write backpressure / 高频小块合并）
   *   - 磁盘满 graceful 降级（写失败 → log warn + 继续跑命令，不崩 session）
   *   - session cleanup 时**保留文件**（让 LLM 后续仍可读）
   *   - 单文件上限 100MB（超出 truncate 头部、保留尾部，对齐 LLM "看
   *     最近输出"的实际需要）
   *   - 老文件 7 天自动过期
   *   - PtyManager 启动时扫一次 GC（清理上次进程退出残留）
   *   - **返回路径前自己做 `fs.realpathSync`**（兜底 macOS `/var → /private/var`
   *     symlink 路径形态）。**ShellCap 拿到本字段后不再二次 realpath**——
   *     与现有 `runInBackground` 路径父目录 realpath 兜底（`shell.ts:624-628`）
   *     等价，但责任前移到 bridge 单点，避免 ShellCap 上层心智负担。
   *
   * 详见总控文档遗留项 L-7。
   */
  outputFilePath: string;
}

// ==================== Read ====================

/**
 * `readAgentSessionOutput` 入参。
 *
 * `sinceByteOffset` 让上层做"流式增量读"——传上次返回的 `outputBytes` 即可
 * 拿到自此之后的新输出，避免重读历史。
 */
export interface AgentReadOptions {
  sinceByteOffset?: number;

  /**
   * RT-4 R1：cursor 增量读。传上次返回的 `nextCursor`，bridge 用
   * `PtyOutputBuffer.readFromCursor` 只读新增 chunk，避免每轮 `readAll()`
   * 全量 join + cleanOutput（前台 poll 累积 O(n²) 的根因）。
   * 优先级高于 `sinceByteOffset`；二者都不传则读全量（首轮 / 终态）。
   */
  sinceCursor?: number;
}

/**
 * `readAgentSessionOutput` 返回。
 *
 * **设计要点**：
 *   - `output` 是从 `sinceByteOffset`（缺省 0）开始的增量字符串
 *   - `outputBytes` 是 session 累计输出字节数，下次调用直接用作 `sinceByteOffset`
 *   - `isRunning` / `exitCode` 让上层判断是否还要继续 poll
 *   - 与 `TerminalReadOutput` 不同形态是因为本接口面向**Agent 轮询**场景，
 *     字段更扁平、字段含义更直接（不嵌套 metadata）
 */
export interface AgentReadResult {
  /** 自 `sinceByteOffset` 起的增量输出（去 ANSI / 已 cleanOutput）。 */
  output: string;

  /** 自此之后下一次 read 应传入的 `sinceByteOffset`。 */
  outputBytes: number;

  /** session 是否仍在跑。`false` 时通常应该停止 poll。 */
  isRunning: boolean;

  /** 已结束的退出码；仍在跑时为 `null`。 */
  exitCode: number | null;

  /** 当前 session cwd。 */
  cwd: string;

  /** 上次输出的时间戳（ms epoch）。可用于 idle 判断。 */
  lastOutputAt: number;

  /** 输出缓冲区是否曾经发生过溢出截断。 */
  truncated: boolean;

  /**
   * RT-4 R1：下次增量读应传入的 cursor（= buffer 末尾 chunk cursor + 1）。
   * 上层 poll 维护它做 cursor 增量，避免每轮全量重读（O(n²)→O(n)）。
   * bridge 不支持 cursor 时为 undefined，上层回退到全量/byteOffset 路径。
   */
  nextCursor?: number;

  /**
   * 2026-05-18 review P0-1：terminal state 时透出 ManagedTask record 的退出分类。
   *
   * - `normal_exit`：子进程正常 exit syscall（含 exit_code != 0 的业务失败）
   * - `exec_failure`：exit_code ∈ {126, 127} 或 spawn 失败
   * - `signal`：被信号终止（SIGTERM / SIGKILL / SIGINT 等）
   *
   * 仅在 `isRunning === false` 时有意义；运行中始终 undefined。
   * 让 ShellCap completed envelope 能按 PRD §0.5 表 B 必填字段 `exited_by` 透传。
   */
  exitedBy?: 'normal_exit' | 'exec_failure' | 'signal';

  /**
   * 2026-05-18 review P0-1：被信号 / 工具 / 超时 kill 时的具体来源。
   *
   * - `hard_timeout`：ManagedTask GC 因超 `hard_timeout_ms` 自动 SIGTERM
   * - `kill_tool`：LLM 跑 `run_terminal_command("kill <pid>")` 主动停（pid 物理 kill）
   * - `user_interrupt`：用户在 UI 关 tab 触发 abort
   * - `app_exit`：客户端整体退出，退出守卫杀整组（终端假运行根治 v3 路线 A）
   *
   * 仅在 `isRunning === false` 且任务被 kill 时有意义；正常 exit 时 undefined。
   * 类型引用单源 `KilledReason`（managed-task-store），避免多处字面 union 漂移。
   */
  killedReason?: KilledReason;

  /**
   * 2026-05-18 review P0-1：ManagedTask record 的 output_file_path（bridge tail 镜像）。
   *
   * 让 ShellCap running envelope 能按 PRD §0.5 表 B running 必填字段 `output_file` 透传。
   * 5 秒窗口外 fallback 到 record-only 路径时仍有此字段；LLM 想看完整 stdout
   * 用 `read_file(output_file)`。
   */
  outputFilePath?: string;

  /**
   * 2026-05-18 review P2-3：OS 进程 pid（bridge 在 spawn 后回填到 record）。
   *
   * 让 unknown 分支 hint `ps -p <pid>` 真有值可用。
   */
  pid?: number;
}

// ==================== Events ====================

/**
 * Bridge 在新建 Agent transcript session 时 emit 的事件 schema。
 *
 * **谁消费**：
 *   - Electron 端：`useAgentTerminalSync`（WP3 改造为"每次新 tab"）通过
 *     `bridge.subscribe('agent-session-created', handler)` 订阅
 *   - Daemon 端：通过 `bridge.subscribe(...)` 订阅写结构化日志
 *     （`logger.info({ event: 'agent_session_created', ...payload })`），
 *     便于运维 grep + contract test 用 mock subscriber 验证
 *
 * **不变量**：
 *   - 每条 Agent 命令对应**恰好一次** `AgentSessionCreated`（D3）
 *   - emit 时序：bridge 必须**先 emit 再开始执行命令**（含 `executeAgentCommand`
 *     和 `spawnAgentSessionDetached`），保证订阅者第一时间能渲染 tab；
 *     `spawnAgentSessionDetached` 内部 emit 时序与 return sessionId 不强制顺序，
 *     但订阅者必须在 return 之前能收到事件
 *   - **renderer 经 IPC 收到事件的时序受 IPC 延迟影响**——bridge 仅保证
 *     **main 侧 emit** 先于命令执行；renderer 侧 `useAgentTerminalSync`
 *     经 `window.tabtin?.pty.onAgentSessionCreated` IPC 通道收到事件，
 *     **可能晚于 ShellCap 命令本身 return**（IPC 跳转有几 ms 到几十 ms 抖动，
 *     特别是命令瞬时完成的情形下，executeAgentCommand 的 Promise 可能比
 *     renderer 的事件先到）。这是 Electron IPC 物理边界，不是 bug。
 *   - **WP3 不需要也不应该改 IPC 链路尝试同步**——renderer 拿到事件后
 *     新建 tab 即可，命令的 stdout 已经通过 ShellCap tool result 落到
 *     LLM 上下文，tab 显示稍微晚一点对用户体验无影响（用户看 LLM 回应
 *     与看 Terminal Tab 是两件事）。
 */
export interface AgentSessionCreated {
  /** 新建的 transcript session ID。 */
  sessionId: string;

  /** Space ID（来自 `AgentCommandRequest.agentMeta.spaceId`）。 */
  spaceId: string;

  /**
   * 对话 thread ID；缺失时为 `null`（不要 undefined，事件 schema 要求字段存在）。
   *
   * **bridge 实现层映射责任**：request 中 `agentMeta.threadId === undefined`
   * 必须显式映射为本字段的 `null`——不允许 emit 一个 `threadId: undefined`
   * 的事件 payload（JSON 序列化会丢字段，订阅者拿不到 own property）。
   * WP2 contract test 应包含此映射断言。
   */
  threadId: string | null;

  /** Agent ID（来自 `agentMeta.agentId`）。 */
  agentId: string;

  /** ToolUse ID（来自 `agentMeta.toolUseId`），用于跨 Wave 关联。 */
  toolUseId: string;

  /** session 启动时的 cwd。 */
  cwd: string;

  /** 人类可读描述（来自 `agentMeta.description`）。 */
  description?: string;

  /**
   * 触发本次 session 创建的 shell 命令字符串（来自 `AgentCommandRequest.command`）。
   *
   * **必填语义**：bridge 实现层在 `executeAgentCommand` / `spawnAgentSessionDetached`
   * 入口已经拿到 `req.command`，emit `AgentSessionCreated` 时**必须**透传。生产
   * 路径下不允许缺失——契约违反（自生 mock 事件除外，contract test 自己构造时
   * 填字面占位即可）。
   *
   * **WP3 Tab title 中间级 fallback 的数据源**（L165-167 / `useAgentTerminalSync`
   * L96-98 落地）：renderer hook 拿到事件后按 `description ∶∶
   * command.split('\n')[0].trim().slice(0, 60) ∶∶ \`Agent Terminal · ${sessionId.slice(-6)}\``
   * 三级 fallback 决定 tab title——`description` 缺失时本字段托底（典型场景：
   * LLM 调 `run_terminal_command` 没显式传 description，但 command 一定有，
   * 用 "命令首行截断" 作 title 让 dogfood「连跑 3 条命令」用户能从 tab 标题
   * 分辨「ls /home」「pnpm test」「sleep 30」三个 tab 在跑啥，而不是看到
   * 三个一模一样的 `Agent Terminal · xxxxxx`）。
   *
   * **截断不在本字段做**：bridge emit 原样字符串（含换行 / 长命令完整体），
   * 截断由 hook 端按 UI 上下文决定（60 chars + 取第一行）。其他订阅者（审计
   * 日志 / 未来 CLI 监控）拿到的是完整字符串，便于运维 grep。
   */
  command: string;

  /**
   * session 来源固定为 `'agent'`。该字段保留在数据层用于审计 / 过滤，
   * 但根据 D5 决策**不驱动任何 UI 视觉差异**（Agent tab 与用户 tab 视觉一致）。
   */
  source: 'agent';
}

/**
 * Agent session 关闭原因。
 *   - `exit`：进程自然退出（含 exit code 0 / 非 0）
 *   - `kill`：被 `killAgentSession` / signal abort 主动 kill
 *   - `cleanup`：PtyManager 整体 dispose（进程关闭 / hot reload）
 *   - `idle_timeout`：单 session 触发 idle timeout（默认 60min 无活动）
 *
 * **Source of truth**：`packages/pty-core/src/PtySessionStore.ts` 中的
 * `PtySessionCloseReason` 是源头，本类型是跨进程 / 跨包传递时的契约副本
 * （pty-core 内部消费仍可用 `PtySessionStore` 自己的类型）。WP2 contract test
 * 字面对齐断言失败时，**优先改本类型对齐 PtySessionStore**，反向同步只在
 * 确认 pty-core 那边遗漏新值时才做。加新值必须双侧同步。
 */
export type AgentSessionCloseReason = 'exit' | 'kill' | 'cleanup' | 'idle_timeout';

/**
 * Agent session 关闭事件 schema。
 *
 * **不变量**：`sessionId` / `spaceId` 必须与对应 `AgentSessionCreated` 事件
 * 字段一致——WP3 hook 用 `(sessionId, spaceId)` 做路由 key，不一致会丢消息。
 *
 * 跟 `packages/pty-core/src/PtySessionStore.ts` 中的
 * `AgentSessionClosedInfo` / `PtySessionCloseReason` 字面对齐——本类型是
 * 跨进程 / 跨包传递时的契约副本，pty-core 内部消费仍可用 `PtySessionStore` 自己
 * 的类型。WP2 contract test 应加自动对齐断言防漂移。
 */
export interface AgentSessionClosed {
  sessionId: string;
  spaceId: string;
  reason: AgentSessionCloseReason;
}

/**
 * `bridge.subscribe` 支持的事件类型集合。
 *
 * 当前 Wave 仅 2 种事件（created / closed）。未来若加 'output-chunk' 等
 * 流式事件需要扩展本类型 + bridge 实现层。
 */
export type AgentSessionEventMap = {
  'agent-session-created': AgentSessionCreated;
  'agent-session-closed': AgentSessionClosed;
};

export type AgentSessionEventName = keyof AgentSessionEventMap;

export type AgentSessionEventHandler<E extends AgentSessionEventName> = (
  payload: AgentSessionEventMap[E],
) => void;

/** 取消订阅的句柄（调用即解除）。 */
export type AgentSessionUnsubscribe = () => void;

// ==================== Bridge Interface ====================

export type AgentKillSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL';

/**
 * 本机 agent shell 执行实现暴露给 Agent 侧（ShellCap）的统一适配面。
 *
 * **实现侧**：Electron 端 `PtyManager` / Daemon 端 `DaemonPtyManager` 各自
 * 包一个 implements 类。它们只负责创建 transcript session；命令完成由
 * 一次性 child process 的 exit/timeout/abort 判定。契约一致由 contract test 强制。
 *
 * **消费侧**：
 *   - ShellCap.execute → 统一走 `spawnAgentSessionDetached`（2026-05-18 后台执行
 *     重构后 `executeAgentCommand` 已退役；wait_ms > 0 时 ShellCap 内部 poll
 *     `readAgentSessionOutput` 直至 completed 或 wait_ms 到期）
 *   - LLM 跑 `run_terminal_command("kill <pid>")` 物理 kill PID → 经 OS 信号
 *     最终 bridge `agent-session-closed` 事件；ManagedTaskStore `hard_timeout`
 *     GC 也调 `killAgentSession`（**内部**，非 LLM-facing）
 *   - WP3 useAgentTerminalSync → `subscribe('agent-session-created', ...)` 订阅
 *
 * **注入**：通过 `setPtyManagerBridge` / `resolvePtyManagerBridge`
 * （`packages/action-tools/src/utils/runtime-bridge.ts`），与现有 4 件套
 * `setPtyManagerAPI` / `resolvePtyManagerAPI` **独立**，互不影响。
 *
 * **bootstrap 顺序约束**（WP1 / WP2 接入时必须遵守）：
 *   `PtyManager.ready()` → `setPtyManagerBridge()` → assemble ShellCap
 *
 * 注入失败 / PtyManager 未就绪 → ShellCap 装配失败 → 本地 LLM 无 shell 工具
 * 可用（D6 决策的代价）。
 *
 * **不抽象远端 / 跨设备**（D9）：本接口只服务"本机 Electron / Daemon 两
 * 端等价"目标，不为 future "在 device A 上让 device B 跑命令"做
 * 超前抽象——那是另一个 Wave 的事，到时该重新设计该重新设计。
 */
export interface PtyManagerBridge {
  /**
   * Foreground 路径：起 transcript session + 一次性 shell 子进程，
   * 等命令结束 / timeout / abort 后返回。
   *
   * **行为约定**：
   *   - 每次调用都新建一个独立 transcript session（D3）。`agentMeta.threadId`
   *     **不再用作"复用 key"**——这是与原 `getOrSpawnAgentSession` 的关键差异
   *     （`threadId` 退化为审计字段，bridge 实现不得用它做 dedup 或调
   *     `setThreadSession`）。
   *   - 在 bridge 层**先 emit `agent-session-created` 事件再开始执行命令**，
   *     保证 UI（WP3）能在第一时间渲染 tab。
   *   - 命令结束 / timeout 后**不**主动关闭 transcript session（用户可能想
   *     查看历史输出）；由 idle timeout / 用户主动关 tab 触发清理。
   *
   * **错误路径**：
   *   - transcript session 创建失败 / process spawn 失败 → throw（D6 决策：不静默降级）
   *   - 命令被执行层防御策略拒绝 → throw
   *   - **per-Space session 数撞 limit**（Electron `MAX_AGENT_SESSIONS_PER_SPACE = 6`
   *     / Daemon `MAX_SESSIONS_PER_SPACE = 3`）→ throw `Error('agent session
   *     limit reached for space {spaceId}: {n}/{max}')`，message 中含
   *     `agent session limit reached` 关键词便于 ShellCap 上层结构化识别
   *   - 命令本身 exit code 非 0 → 不 throw，正常返回 `status: 'ok'`
   *     （shell 命令"失败"是业务结果，不是接口异常）
   *   - `req.signal` 已 aborted → 同步 throw `AbortError`（语义同 timeout）
   *
   * @returns `AgentCommandResult` - 必带 `sessionId`，便于 ShellCap 在
   * tool result 里附 sessionId 给 LLM。
   */
  executeAgentCommand(req: AgentCommandRequest): Promise<AgentCommandResult>;

  /**
   * Background 路径：起 transcript session + 一次性 shell 子进程，**立即**返回
   * `{ sessionId, outputFilePath }`，不等命令完成。
   *
   * **行为约定**：
   *   - 同样**先 emit `agent-session-created` 事件**，UI 同步逻辑等价
   *   - 命令仍在子进程内跑，可通过 `readAgentSessionOutput` 增量读、
   *     `killAgentSession` 终止
   *   - bridge 实现层负责持续 tail 一份磁盘副本到 `outputFilePath`
   *     （路径建议 `{tmpdir}/tabtin-agent-tasks/{sessionId}.log`），
   *     在 session 关闭时保留文件
   *   - `req.signal` abort → 等价 `killAgentSession(sessionId, 'SIGTERM')`
   *
   * **典型用法**：ShellCap 收到 `run_in_background: true` → 直接调本方法 →
   * tool result 给 LLM 返回 `{ session_id, output_file_path, message }`，
   * LLM 用现有 `read_file` 工具查 outputFilePath 看进度。
   */
  spawnAgentSessionDetached(req: AgentCommandRequest): Promise<AgentSpawnDetachedResult>;

  /**
   * 增量读取一个 background session 的当前输出 + 状态。
   *
   * **典型用法**：LLM 启动 background 任务后想检查进度 → 调本方法。
   * 传上次返回的 `outputBytes` 作为 `sinceByteOffset` 即可拿增量。
   *
   * **错误路径**：
   *   - sessionId 不存在 → throw `Error('agent session not found: {sessionId}')`
   *   - sessionId 存在但已 idle 清理 → throw 同样错误（信息一致即可）
   */
  readAgentSessionOutput(
    sessionId: string,
    opts?: AgentReadOptions,
  ): Promise<AgentReadResult>;

  /**
   * 终止一个 background session。
   *
   * **行为约定**：
   *   - 默认信号 `SIGTERM`，调用方可指定 `SIGINT` 做温和中断、`SIGKILL` 强杀
   *   - kill 后 bridge / session manager emit `agent-session-closed`（reason: 'kill'）
   *   - sessionId 不存在 → throw `Error('agent session not found: {sessionId}')`
   *   - 已经 exited 的 session → no-op resolve（不算错误，幂等）
   */
  killAgentSession(sessionId: string, signal?: AgentKillSignal): Promise<void>;

  /**
   * 订阅 agent transcript 相关事件。
   *
   * **为什么放在 bridge 接口里**：让两端事件订阅走同一抽象——
   *   - Electron 端：实现层内部接 `EventEmitter`，订阅 → 转 IPC（preload 层
   *     已有 `window.tabtin.pty.onAgentSessionCreated` 通道，bridge 实现可
   *     直接复用）
   *   - Daemon 端：实现层内部把 emit 转成 `logger.info({ event, ...payload })`，
   *     订阅 → 在内存里挂回调（contract test 用 mock subscriber 即可验证）
   *   - 测试 / contract：mock bridge 直接维护回调列表
   *
   * **谁直接调 subscribe**（WP3 注意）：subscribe 是给 main 侧 contract test
   * + Daemon logger 用的——**renderer 不直接调 bridge.subscribe**，继续走
   * 现有 IPC 通道 `window.tabtin?.pty.onAgentSessionCreated`。WP3 只改
   * `useAgentTerminalSync` 的 IPC handler 行为（每次新 tab），不要把 bridge
   * 接口拉到 renderer 进程。
   *
   * **不变量**：
   *   - 同一事件可被多个不同 handler 订阅
   *   - 调用返回的 `unsubscribe()` 立即解除该 handler 的订阅，再 emit 不再触发
   *   - 实现层不得 throw（handler 抛错应被 catch + log，不影响其他订阅者
   *     和后续 emit）
   *
   * **边界行为契约**（WP2 实现 + contract test 必须覆盖；详见 L-8）：
   *   - **重复 `subscribe` 同一 handler 同一 event**：bridge 实现应去重——
   *     第二次 subscribe 是 no-op，返回的 `unsubscribe` 与第一次返回的等价
   *     （任一调用都解除该 handler 的唯一订阅）。**单 handler 单例订阅
   *     语义**，避免 hook re-render 频繁挂载导致回调被多次触发。
   *   - **emit 期间 `unsubscribe`**：handler 列表迭代过程中调任一 handler
   *     的 unsubscribe，**本次 emit 仍调本 handler**（不影响进行中的迭代），
   *     **下次 emit 起不再调**（snapshot 语义）。实现典型做法：emit 入口
   *     先 `Array.from(handlers)` 拍快照，迭代快照而非原数组。
   *   - **async handler reject**：handler 返回 Promise 时若 reject，bridge
   *     实现必须 catch 并 log（如 `console.error` 或 logger.warn），**不
   *     影响其他订阅者**也**不冒泡到 emit 调用方**——emit 永远 sync 完成、
   *     调用方不需要 await。这与"实现层不得 throw"对齐：handler reject
   *     语义同 throw，吞错落 log。
   *   - **`unsubscribe` 幂等**：返回的 `unsubscribe()` 函数重复调用安全，
   *     第二次起 no-op（不抛错、不 log warn）。便于 React useEffect cleanup
   *     在 strict mode 双调时不出 warning。
   *
   * @example
   * ```ts
   * const off = bridge.subscribe('agent-session-created', (e) => {
   *   addSpaceSession(e.spaceId, e.sessionId, e.description ?? e.sessionId);
   * });
   * // 不再需要时
   * off();
   * off(); // 幂等，no-op
   * ```
   */
  subscribe<E extends AgentSessionEventName>(
    event: E,
    handler: AgentSessionEventHandler<E>,
  ): AgentSessionUnsubscribe;
}

// ==================== Stub ====================

const NOT_IMPLEMENTED_HINT =
  'PtyManagerBridge stub: no real implementation wired. ' +
  'Wire a real PtyManagerBridge implementation for WP1 / WP2.';

/**
 * 所有方法都 throw `not implemented` 的桩 bridge。
 *
 * **存在意义**（WP0 接口固化阶段的正确产物，不是 MVP）：
 *   1. WP1（ShellCap 接入）开发期，没真实 bridge 也能 import 类型 + 桩跑
 *      单测，覆盖 "bridge 缺失" 防御路径
 *   2. 让 `resolvePtyManagerBridge()` 调用方有一个明确的"未注入"信号——
 *      与 "返回 null" 的语义不同：前者表达"接口存在但执行会失败"，
 *      后者表达"宿主未 wire bridge，应当 fail-fast 拒绝构造 ShellCap"
 *   3. 给 contract test 一个起点（WP2 写真实实现时，先 import 桩验证签名一致）
 *
 * **不要**在生产路径用这个桩。生产路径见 `setPtyManagerBridge` 的 JSDoc。
 *
 * `subscribe` 桩返回一个 no-op unsubscribe（不 throw），因为订阅本身不应
 * 失败——失败的是后续的 emit / 命令执行。这样测试代码可以先 subscribe
 * 验证签名通过，再断言命令调用 throw。
 */
/**
 * 进度节流 dispatcher（2026-05-17，配合 `AgentCommandRequest.onProgress`）。
 *
 * **业务问题**：foreground 长跑命令期间，前端 TerminalCard 黑屏体感极差。需要
 * bridge 实现层把 stdout 累积按"5 秒 OR 1KB"先到为准触发一次回调，让 ShellCap
 * emit `SYSTEM_NOTICE` notice_type='tool_progress' 给 UI 实时刷新。
 *
 * **职责切分**：
 *   - bridge 实现（Electron / Daemon）：在 `onOutput` 内累积 + 节流 + 截断 + 调
 *     onProgress 回调。**bridge 不知道 SYSTEM_NOTICE / tool_call_id / emitter**，
 *     职责单一
 *   - ShellCap 端：onProgress 回调里构造 SYSTEM_NOTICE 写 `tool_call_id` /
 *     emit。**ShellCap 不知道 5s / 1KB 这种执行细节**
 *
 * 两端 bridge 复用同一份 dispatcher 避免参数漂移（一端 5s 另一端 3s）。
 *
 * **使用方式**：
 * ```ts
 * const dispatcher = createAgentProgressDispatcher({ onProgress: req.onProgress });
 * handle = spawnAgentShellProcess({
 *   onOutput: (data) => {
 *     ...existing transcript/tail/watchdog logic...
 *     dispatcher.onChunk(data);
 *   },
 * });
 * void handle.result.finally(() => dispatcher.dispose());
 * ```
 *
 * `onProgress` 缺省 → dispatcher 返回 no-op，零开销路径（生产仅 ShellCap
 * foreground 注入，detached 路径自己有 transcript tail 通道不需要）。
 */
export interface AgentProgressDispatcher {
  /** 每次 runner onOutput chunk 时调一次 —— 内部累积 + 触发节流。 */
  onChunk(data: string): void;
  /** 命令完成 / timeout / abort 时调一次 —— flush 最后一次 + 停 timer（防泄漏）。 */
  dispose(): void;
}

export interface CreateAgentProgressDispatcherOptions {
  /**
   * `AgentCommandRequest.onProgress` 字面透传——缺省 / undefined 时本 helper
   * 返回 no-op 实现（不开 timer、不累积、零开销）。
   */
  onProgress?: (snapshot: AgentCommandProgressSnapshot) => void;
  /**
   * 节流时间窗（毫秒）。缺省 5000ms。**仅用于测试时压缩**，生产请用默认值。
   */
  intervalMs?: number;
  /**
   * 累积输出字节阈值（自上次 emit 起）。缺省 1024。**仅用于测试时压缩**。
   */
  byteThreshold?: number;
  /**
   * snapshot.stdout 截断上限。缺省 8192（8KB）。超过按 head/tail 各半截。
   * **仅用于测试时压缩**。
   */
  snapshotMaxBytes?: number;
}

export function createAgentProgressDispatcher(
  options: CreateAgentProgressDispatcherOptions = {},
): AgentProgressDispatcher {
  const onProgress = options.onProgress;
  if (typeof onProgress !== 'function') {
    return { onChunk() {}, dispose() {} };
  }
  const intervalMs = options.intervalMs ?? 5_000;
  const byteThreshold = options.byteThreshold ?? 1024;
  const snapshotMaxBytes = options.snapshotMaxBytes ?? 8 * 1024;
  const halfWindow = Math.max(1, Math.floor(snapshotMaxBytes / 2));

  let cumulative = '';
  let bytesSinceLastEmit = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const truncate = (s: string): { stdout: string; truncated: boolean } => {
    const bytes = Buffer.byteLength(s, 'utf8');
    if (bytes <= snapshotMaxBytes) return { stdout: s, truncated: false };
    // 按字符截（不按字节）—— 简化处理，approximate 头/尾。生产 stdout 大头是 ASCII，
    // approximate 等价；偶发多字节字符截断处可能出现 replacement char，可接受。
    const halfChars = Math.max(1, Math.floor(s.length * (halfWindow / bytes)));
    const head = s.slice(0, halfChars);
    const tail = s.slice(-halfChars);
    return {
      stdout: `${head}\n\n[... ${bytes - Buffer.byteLength(head + tail, 'utf8')} bytes truncated ...]\n\n${tail}`,
      truncated: true,
    };
  };

  const emit = (): void => {
    if (disposed) return;
    if (cumulative.length === 0) return;
    bytesSinceLastEmit = 0;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const { stdout, truncated } = truncate(cumulative);
    try {
      onProgress({
        stdout,
        outputBytes: Buffer.byteLength(cumulative, 'utf8'),
        truncated,
        capturedAt: Date.now(),
      });
    } catch {
      // 回调消费者抛错不能弄死 bridge 主流——按 onProgress JSDoc 约定吞错
    }
  };

  const scheduleTimer = (): void => {
    if (disposed || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      emit();
    }, intervalMs);
    // Node setTimeout 默认 ref 进程；progress timer 不应阻止 process exit
    timer?.unref?.();
  };

  return {
    onChunk(data: string): void {
      if (disposed || !data) return;
      cumulative += data;
      bytesSinceLastEmit += Buffer.byteLength(data, 'utf8');
      // 1KB 阈值优先 —— 大输出命令（npm install 一秒几十 KB）让用户看到滚动
      if (bytesSinceLastEmit >= byteThreshold) {
        emit();
        return;
      }
      // 否则起 5s 定时（节流） —— 慢命令（pytest 慢用例）让用户至少 5s 看到一帧
      scheduleTimer();
    },
    dispose(): void {
      if (disposed) return;
      // 最后一次 flush（除非完全没数据）——让 UI 看到命令尾部内容
      if (cumulative.length > 0 && bytesSinceLastEmit > 0) {
        emit();
      }
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

export const unimplementedPtyManagerBridge: PtyManagerBridge = {
  async executeAgentCommand(_req: AgentCommandRequest): Promise<AgentCommandResult> {
    throw new Error(`executeAgentCommand: not implemented. ${NOT_IMPLEMENTED_HINT}`);
  },
  async spawnAgentSessionDetached(
    _req: AgentCommandRequest,
  ): Promise<AgentSpawnDetachedResult> {
    throw new Error(`spawnAgentSessionDetached: not implemented. ${NOT_IMPLEMENTED_HINT}`);
  },
  async readAgentSessionOutput(
    _sessionId: string,
    _opts?: AgentReadOptions,
  ): Promise<AgentReadResult> {
    throw new Error(`readAgentSessionOutput: not implemented. ${NOT_IMPLEMENTED_HINT}`);
  },
  async killAgentSession(
    _sessionId: string,
    _signal?: AgentKillSignal,
  ): Promise<void> {
    throw new Error(`killAgentSession: not implemented. ${NOT_IMPLEMENTED_HINT}`);
  },
  subscribe<E extends AgentSessionEventName>(
    _event: E,
    _handler: AgentSessionEventHandler<E>,
  ): AgentSessionUnsubscribe {
    return () => {};
  },
};
