/**
 * 后台命令终态 tool_result 构造器（t1：终端卡片"假运行"根治）。
 *
 * **背景**：`run_terminal_command` 前台等待超时（wait_ms 用尽）时返回一份
 * `status: "running"` 的快照作为 tool_result（经 reassembler 合并进对应 assistant
 * ChatMessage.content_blocks_json）。命令在后台继续，最终终结（完成 / 被 kill /
 * hard_timeout）时——旧实现只 push 一条"任务完成"通知激活新 turn，**不更新**那条
 * running 快照。结果：用户重载对话时，终端卡片永远显示"运行中"转圈（"UI 假运行"，
 * 见 push 通知重构 PRD §1.3 验收标准 7）。
 *
 * **本模块**：把后台完成通知（`BackgroundTaskCompletedPayload`）翻译成一条**终态**
 * tool_result 的 wire mini-message（role='user' + message_kind='llm' + 单个
 * tool_result block），由两端 host 经 out-of-query relay 发往 Django。Django
 * reassembler 识别 `_terminal_update` 标记，用终态**替换**已合并的 running 快照
 * （而非幂等跳过）——重载时终端卡片自然显示真实终态（完成 退出码 / 已终止）。
 * **前端零改**：拿到的就是 status='completed' 的 content，TerminalCard 照常渲染。
 *
 * 用 `EnvelopeEmitter` 构造保证 wire 字段（protocol_version / _seq / event_type /
 * message_kind 等）与主路径完全一致，避免 host 手搓 envelope 漏字段被 Django
 * schema 校验 silent drop。
 *
 * **可靠性现状（终端假运行根治 Layer 1 已落地，2026-05-31）**：
 *   1. **relay 失败可恢复**——两端 host 的 `relayBackgroundTaskTerminalResult` 已从
 *      fire-and-forget 升级为 `relayEventsWithRetry`：消费 Django ok/nak，失败
 *      （离线 / token 失效 / WS 断开 / NAK）→ 落盘到 owner 桶的 `RelayRetryQueue`
 *      （独立 `relay-pending.jsonl`），host 启动 / WS 重连时 recover 重投（治
 *      F1/F2/F3/F16）。query 内 relay 内存重试耗尽也走同一落盘路径（onExhausted，
 *      治 F5/F20）。owner 在 spawn 时焊进 `ManagedTaskRecord.owner`（治 F1）。
 *   2. **优雅退出已覆盖**——客户端退出守卫枚举 running record 杀整组 + 同步 flush
 *      `killed_reason:'app_exit'` 终态（路线 A / F-EXIT），退出后重载不再假运行。
 *   3. **仍待 Layer 2（崩溃 / kill -9 兜底）**——`ManagedTaskStore` 仍是内存态；
 *      host 崩溃（清理链路没机会跑）时在跑的后台命令终态会丢，需 sidecar 退出码
 *      落盘 + 落盘 store + 启动对账（PRD v3 Layer 2 / 执行 C，尚未做）。
 */

import * as fs from 'node:fs';
import { randomUUID as nodeRandomUUID } from 'node:crypto';

import { EnvelopeEmitter } from '../engine/wire/envelope-emitter.js';
import type {
  StreamEvent,
} from '../engine/contracts/wire-protocol.js';

/** 终态 tool_result 的 model_id / model_name 占位（与 emitDetachedMiniMessage 同款语义，业务不依赖）。 */
const BG_TERMINAL_MODEL_ID = 'tabtin-tool-runtime';

/** 终态 content 里 stdout 的截断上限（与 run_terminal_command inline 上限同量级）。 */
export const BG_TERMINAL_STDOUT_TAIL_BYTES = 30 * 1024;

/**
 * 后台完成通知里 host 构造终态 content 所需的字段子集
 * （= `@tabtin/terminal-core` 的 `BackgroundTaskCompletedPayload`，此处只声明用到的
 * 字段，避免 agent-runtime 反向耦合 terminal-core 类型）。
 */
export interface BackgroundTaskTerminalInput {
  agent_session_id: string;
  tool_use_id: string;
  command: string;
  exit_code: number | null;
  exited_by: 'normal_exit' | 'exec_failure' | 'signal';
  killed_reason?: 'hard_timeout' | 'kill_tool' | 'user_interrupt' | 'app_exit';
  duration_ms: number;
  output_file_path: string;
  cwd: string;
  /**
   * C1 结构化终态（终端假运行根治 v3 §1.3 老硬伤根治）：进程生命周期终态。
   *
   * 可选——调用方持有 `ManagedTaskRecord.status` 权威值时传入；不传则由
   * `deriveBackgroundTaskStatus` 从 `killed_reason` / `exited_by` 推导（与 bridge
   * exit handler 的 status 计算同源）。前端 TerminalCard 优先读本字段（+ `killed_reason`
   * + `exit_code`）判定"已终止/已超时/已结束/失败"，不再 string-match stderr 英文
   * 关键字（一本地化就回归）。取值枚举见 `BackgroundTaskTerminalStatus`。
   */
  status?: BackgroundTaskTerminalStatus;
}

/**
 * C1 终态结构化 `status` 取值枚举（前端判定真相源）：
 *   - `completed`：进程自然退出（exit_code 决定成功 0 / 失败 ≠0）；
 *   - `killed`：被信号 / kill 终止（`killed_reason` 决定 已超时 hard_timeout /
 *     已终止 kill_tool|user_interrupt|app_exit）；
 *   - `failed`：命令无法执行（exec_failure：command not found / 不可执行）；
 *   - `unknown`：**Layer 2 崩溃兜底（治 F9）专用**——host 崩溃 / kill -9 后启动对账，
 *     sidecar 退出码缺失 / 损坏，真实终态不可知。前端 `TerminalCard` 已有中性灰
 *     「运行状态未知」渲染（与 Layer 3 celery 标的 `unknown` 同款），不假装成功 / 失败 /
 *     被杀（footer 显示 "exited (unknown)"）。仅对账路径产生，正常 exit 不会出现。
 */
export type BackgroundTaskTerminalStatus = 'completed' | 'killed' | 'failed' | 'unknown';

/**
 * 从终态字段推导结构化 `status`（C1 真相源；与 `DaemonPtyManagerBridge` /
 * `ElectronPtyManagerBridge` exit handler 的 status 计算同源）。
 *
 *   - 显式传入 `status` → 直接采用（调用方持有 record 权威值）；
 *   - 否则：`killed_reason != null` 或信号杀 → `killed`；exec_failure → `failed`；
 *     其余（正常退出）→ `completed`（成功/失败由 `exit_code` 区分）。
 */
export function deriveBackgroundTaskStatus(
  input: Pick<BackgroundTaskTerminalInput, 'exited_by' | 'killed_reason' | 'status'>,
): BackgroundTaskTerminalStatus {
  if (input.status) return input.status;
  if (input.killed_reason != null || input.exited_by === 'signal') return 'killed';
  if (input.exited_by === 'exec_failure') return 'failed';
  return 'completed';
}

/**
 * 安全读取文件末尾 maxBytes 字节（UTF-8）。文件不存在 / 读失败 → 返回 ''。
 * 后台命令 stdout 落在 output_file，可能很大——只取尾部给终端卡片显示。
 */
export function readFileTailSafe(filePath: string, maxBytes: number): string {
  if (!filePath) return '';
  let fd: number | null = null;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return '';
    const readSize = Math.min(maxBytes, stat.size);
    const offset = stat.size - readSize;
    const buf = Buffer.allocUnsafe(readSize);
    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, readSize, offset);
    return buf.toString('utf-8');
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * 构造终态 tool_result 的 content JSON 字符串。
 *
 * 字段对齐 `run_terminal_command` 形态（前端 TerminalCard 解析 status / exit_code /
 * stdout），额外加：
 *   - `status`（C1）—— `completed | killed | failed`（`deriveBackgroundTaskStatus`
 *     从终态推导）。**这是前端判定真相源**：旧实现恒写 `'completed'`（仅表"非
 *     running"），现写真实生命周期终态，前端据此 + `killed_reason` + `exit_code`
 *     精确判定 已终止/已超时/已结束/失败，治 §1.3 老硬伤（string-match stderr 英文
 *     关键字，一本地化就回归）；
 *   - `_terminal_update: true` —— Django reassembler 据此**替换** running 快照；
 *   - `killed_reason` —— 被 kill / hard_timeout 时标识（status='killed' 时细分
 *     已超时 vs 已终止）；
 *   - `success: false` + `stderr` —— **过渡期保留**给尚未切到结构化字段的前端
 *     （新前端读 status，旧前端读 success/stderr，互不冲突）。
 */
export function buildBackgroundTaskTerminalContent(
  input: BackgroundTaskTerminalInput,
  stdoutTail: string,
): string {
  // **被 kill / hard_timeout / 信号杀 / spawn 失败**的命令：exit_code 不可靠
  // （信号杀常为 null）。C1 前**旧**前端 TerminalCard 不读 status / killed_reason，
  // 只按 `success` / `exit_code` / `stderr` 推导（deriveDisplayStatusFromPayload +
  // inferTerminatedStatusFromText）；C1 后新前端改读结构化 `status` + `killed_reason`。
  //
  // 过渡期**同时**写 `success:false` + 含 terminated/timed out 的 stderr（兼容旧前端）：
  //   - success:false 走前端"失败分支"，优先级高于 exit_code===0 判断——既让前端
  //     inferTerminatedStatusFromText 命中显示"已终止/已超时"（而非回落"运行中"，
  //     根治 bug #2 的 kill/timeout 子场景），又解决"被 kill 但优雅 exit 0 误显示
  //     完成"的诚实性问题（M2）。
  //   - 正常退出（normal_exit + 数字 exit_code）**不**写 success——保持 exit_code
  //     驱动 success/failed，行为不变。
  const isAbnormalExit =
    input.killed_reason != null
    || input.exited_by === 'signal'
    || input.exited_by === 'exec_failure';
  let stderr = '';
  if (input.killed_reason === 'hard_timeout') {
    stderr = `Command timed out (hard_timeout) after ${input.duration_ms}ms`;
  } else if (input.killed_reason === 'app_exit') {
    // 终端假运行根治 v3 路线 A / F-EXIT：退出客户端 = 取消所有本地后台命令。
    // **必须含 "terminated" 关键字**——前端 TerminalCard.inferTerminatedStatusFromText
    // 靠 terminated/killed/aborted 判定显示"已终止"；否则 success:false 会落到
    // "失败"（destructive 色）误导用户以为命令本身出错（三视角 review P1 修复）。
    stderr = 'Process terminated because the app was quitting (app_exit)';
  } else if (input.killed_reason != null) {
    stderr = `Process terminated (${input.killed_reason})`;
  } else if (input.exited_by === 'signal') {
    stderr = 'Process terminated by signal';
  } else if (input.exited_by === 'exec_failure') {
    stderr = 'Command failed to execute';
  }
  return JSON.stringify({
    // C1：结构化生命周期终态（completed/killed/failed）——前端判定真相源。
    // 旧实现恒写 'completed'（仅表"非 running"）；现写真实终态，前端可据此 + killed_reason
    // + exit_code 精确判定 已终止/已超时/已结束/失败，不再 string-match stderr 英文关键字。
    // 兼容性：旧前端不读本字段（PRD §1.3），改值零回归；新前端按枚举读。
    status: deriveBackgroundTaskStatus(input),
    session_id: input.agent_session_id,
    exit_code: input.exit_code,
    exited_by: input.exited_by,
    ...(input.killed_reason ? { killed_reason: input.killed_reason } : {}),
    ...(isAbnormalExit ? { success: false } : {}),
    duration_ms: input.duration_ms,
    stdout: stdoutTail,
    ...(stderr ? { stderr } : {}),
    output_file: input.output_file_path,
    command: input.command,
    cwd: input.cwd,
    // Django merge supersede 标记：带此字段的 tool_result 替换已有同 tool_use_id
    // 的 running 快照（见 relay_message_writer._merge_tool_result_block_into_message）。
    _terminal_update: true,
  });
}

/**
 * 把终态 tool_result 包装成 wire 4 件套 mini-message（无 delta——tool_result block
 * 内容一次性完整）：message_start(role=user, kind=llm) → content_block_start
 * (tool_result) → content_block_stop → message_stop。
 *
 * `runId` 是合成占位（非空——wire `MessageStartSchema.run_id` 要求 `.min(1)`）：
 * host 后台完成路径拿不到原 query run_id（ManagedTaskRecord 不持有）。Django merge
 * 识别 `_terminal_update` 标记后**忽略 run_id**，走"按 session 扫 assistant +
 * tool_use_id 定位 + supersede"路径（后台命令 tool_use_id 在 session 内单调唯一，
 * 无需 run_id 消歧）。占位值仅为通过 schema 校验，不参与任何匹配。
 */
export function buildBackgroundTaskTerminalResultEvents(args: {
  threadId: string;
  toolUseId: string;
  contentJson: string;
  /**
   * ：终态失败语义时传 true，tool_result block 附 `is_error: true`——
   * 移动端按 `is_error` 定工具卡成败，缺失会让失败的背景命令误显成功。
   * 正常 exit 0 不传（不加字段，保持现状兼容）。
   */
  isError?: boolean;
}): StreamEvent[] {
  const emitter = new EnvelopeEmitter({
    traceId: nodeRandomUUID(),
    threadId: args.threadId,
    // 占位 run_id（非空满足 wire schema .min(1)）；Django merge 对 _terminal_update
    // 忽略 run_id 走 tool_use_id 定位，故此值不参与匹配。
    runId: `bg-terminal-${nodeRandomUUID()}`,
  });
  const messageId = nodeRandomUUID();
  const events: StreamEvent[] = [];
  for (const ev of emitter.beginMessage({
    messageId,
    modelId: BG_TERMINAL_MODEL_ID,
    modelName: BG_TERMINAL_MODEL_ID,
    role: 'user',
    messageKind: 'llm',
  })) {
    events.push(ev);
  }
  for (const ev of emitter.emitInlineBlock({
    blockId: `blk_${nodeRandomUUID()}`,
    block: {
      type: 'tool_result',
      tool_use_id: args.toolUseId,
      content: args.contentJson,
      ...(args.isError === true ? { is_error: true } : {}),
    },
    index: 0,
  })) {
    events.push(ev);
  }
  events.push(emitter.endMessage());
  return events;
}

/**
 * 一站式：从后台完成通知构造终态 tool_result wire events（读 stdout tail +
 * 构造 content + 包 envelope）。两端 host 拿到 events 后各自走 relay 通道发出。
 *
 * 返回 `null` 表示无需 emit（缺 tool_use_id —— 老 daemon / 异常路径防御）。
 */
export function buildBackgroundTaskTerminalResult(args: {
  threadId: string;
  input: BackgroundTaskTerminalInput;
}): StreamEvent[] | null {
  if (!args.input.tool_use_id) return null;
  const stdoutTail = readFileTailSafe(args.input.output_file_path, BG_TERMINAL_STDOUT_TAIL_BYTES);
  const contentJson = buildBackgroundTaskTerminalContent(args.input, stdoutTail);
  // ：失败语义 → block 附 `is_error: true`，移动端据以把工具卡标失败。
  // **显式三态推导**（不写 `status !== 'completed'` 的反向判断）：`status:'unknown'`
  // 是 Layer 2 崩溃对账专用中性态（真实终态不可知），**不算失败**——否则移动端会把
  // 「运行状态未知」误显示成「失败」（桌面 TerminalCard 对 unknown 已有中性灰渲染；
  // 移动端中性渲染在  跟踪，届时读 content.status）。正常 exit 0 不加该字段
  // （保持现状兼容）。
  const status = deriveBackgroundTaskStatus(args.input);
  const isError =
    status === 'killed'
    || status === 'failed'
    || (status === 'completed' && args.input.exit_code != null && args.input.exit_code !== 0);
  return buildBackgroundTaskTerminalResultEvents({
    threadId: args.threadId,
    toolUseId: args.input.tool_use_id,
    contentJson,
    isError,
  });
}
