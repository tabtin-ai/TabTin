import type { AgentTool } from '../types';
import type { ToolError } from '../types/errors';
import { ToolErrorCode } from '../types/errors';
import { standardizeLegacyResult } from '../utils/tool-output';
import { resolveTerminalRuntimeBridge } from '../utils/runtime-bridge';
import {
  normalizeTerminalExecutionPolicy,
  CommandValidator,
  CRITICAL_DENYLIST,
  isAutoApprovedTerminalWrite,
  type TerminalExecutionPolicyPayload,
  type TerminalRuntimeBridge,
  type TerminalExecuteRequest,
} from '@tabtin/terminal-core';

// ========== Terminal 错误分类 ==========
//
// BT-2 修复：将 catch 块中的 UNKNOWN_ERROR 替换为精确的错误分类。
// 通过解析错误消息模式来推断错误类型，至少区分以下 5 类：
//   - SESSION_NOT_FOUND: 会话不存在
//   - SESSION_BUSY: 会话中已有命令在运行
//   - POLICY_BLOCKED: 安全策略拒绝
//   - TIMEOUT: 执行超时
//   - SESSION_LIMIT_REACHED: 会话数量达上限
//   - UNKNOWN_ERROR: 其他未分类错误

/**
 * 从错误消息推断 Terminal 专用 ToolErrorCode。
 *
 * Electron 和 Daemon 的 PtyManager 抛出的错误消息格式不完全一致，
 * 但核心关键词是稳定的（如 "not found"、"already"、"blocked"、"policy"、
 * "max sessions"、"timeout" 等）。此函数通过关键词匹配进行分类。
 */
function classifyTerminalError(message: string): ToolErrorCode {
  const lower = message.toLowerCase();

  // 会话不存在
  if (lower.includes('session') && lower.includes('not found')) {
    return ToolErrorCode.SESSION_NOT_FOUND;
  }

  // 会话正忙（已有命令在执行）
  if (
    (lower.includes('already') && (lower.includes('running') || lower.includes('executing'))) ||
    (lower.includes('command') && lower.includes('pending'))
  ) {
    return ToolErrorCode.SESSION_BUSY;
  }

  // 安全策略阻止
  if (
    lower.includes('blocked by') ||
    lower.includes('policy') ||
    lower.includes('not allowed') ||
    lower.includes('permission denied') ||
    lower.includes('sandbox')
  ) {
    return ToolErrorCode.POLICY_BLOCKED;
  }

  // 会话数量达上限
  if (lower.includes('max session') || lower.includes('session limit') || lower.includes('max sessions reached')) {
    return ToolErrorCode.SESSION_LIMIT_REACHED;
  }

  // 超时
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return ToolErrorCode.TIMEOUT;
  }

  // 会话/Shell 已退出
  if (
    lower.includes('exited') ||
    lower.includes('shell has exited') ||
    lower.includes('process exited') ||
    lower.includes('process terminated') ||
    lower.includes('session closed') ||
    lower.includes('pty exited')
  ) {
    return ToolErrorCode.SESSION_EXITED;
  }

  return ToolErrorCode.UNKNOWN_ERROR;
}

/**
 * BT-3 修复：检测 Daemon policy 拒绝的伪成功响应。
 *
 * 背景差异（BT-1）：
 * - Electron PtyManager 使用 getInteractiveTerminalPolicySupportError()，
 *   对 sandbox/blocked/network-restricted 策略直接 throw Error。
 * - Daemon DaemonPtyManager 使用 evaluateLocalTerminalPolicy()，
 *   对 blocked 命令返回 { output: denyReason, exitCode: 126, ... }（不 throw）。
 *
 * 这导致同一命令在两端返回格式完全不同。此函数在 action-tools 层面
 * 统一处理：将 Daemon 的 exitCode=126 + policy 特征响应转为 success=false。
 *
 * 检测逻辑：exitCode === 126 且 output 包含 policy/blocked 关键词。
 * exitCode 126 在 Unix 中表示"命令无法执行"（permission issue），
 * 与 Daemon 的语义一致。
 *
 * 注意（BT-1 后续统一方案）：
 * 理想状态是 Daemon 端也 throw 而非返回伪成功。但修改 DaemonPtyManager
 * 超出 action-tools 的修改范围，因此在此做兼容层。后续应在 Daemon 端
 * 统一为 throw，届时此检测逻辑自然不再命中（无害保留即可）。
 */
function isDaemonPolicyBlockedResponse(result: {
  output?: string;
  exitCode?: number | null;
  durationMs?: number;
}): boolean {
  if (result.exitCode !== 126) return false;
  if (result.durationMs !== undefined && result.durationMs > 100) return false; // 真实命令不会 0ms 返回
  const output = (result.output || '').toLowerCase();
  return (
    output.includes('blocked') ||
    output.includes('policy') ||
    output.includes('not allowed') ||
    output.includes('security')
  );
}

function resolveTerminalRuntime(): TerminalRuntimeBridge | null {
  return resolveTerminalRuntimeBridge();
}

function resolveSessionIdFromThread(
  runtime: TerminalRuntimeBridge,
  sessionId: string | undefined,
  threadId: string | undefined,
): string | undefined {
  if (sessionId) return sessionId;
  if (!threadId || !runtime.resolveThreadSession) return undefined;
  return runtime.resolveThreadSession(threadId) ?? undefined;
}

export interface ReadTerminalOutputInput {
  session_id?: string;
  tail?: number;
  _thread_id?: string;
}

export interface ReadTerminalOutputOutput {
  success: boolean;
  data?: Record<string, any>;
  error?: ToolError;
}

export const readTerminalOutputTool: AgentTool<ReadTerminalOutputInput, ReadTerminalOutputOutput> = {
  name: 'read_terminal_output',
  description: 'Read recent output from a PTY terminal session. Returns output text plus metadata: cwd, is_running, last_exit_code (of last completed command), has_pending_command (whether a command is still in progress). Use to poll background commands.',
  parameters: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'PTY session ID to read output from. Falls back to thread context when omitted.' },
      tail: { type: 'number', description: 'Number of recent output chunks to retrieve (optional)' },
    },
    required: [],
  },
  async execute(input: ReadTerminalOutputInput): Promise<ReadTerminalOutputOutput> {
    const runtime = resolveTerminalRuntime();
    if (!runtime?.readOutput) {
      return standardizeLegacyResult({
        success: false,
        error: runtime ? 'Current terminal runtime does not support reading session output' : 'PTY manager API not available',
        error_code: ToolErrorCode.UNKNOWN_ERROR,
      }, { defaultErrorCode: ToolErrorCode.UNKNOWN_ERROR });
    }

    const sessionId = resolveSessionIdFromThread(runtime, input.session_id, input._thread_id);
    if (!sessionId) {
      return standardizeLegacyResult({
        success: false,
        error: 'session_id is required',
        error_code: ToolErrorCode.INVALID_PARAMETER,
      }, { defaultErrorCode: ToolErrorCode.INVALID_PARAMETER });
    }

    const effectiveTail = input.tail ?? 200;
    const result = runtime.readOutput(sessionId, { tail: effectiveTail });
    if (!result) {
      return standardizeLegacyResult({
        success: false,
        error: `Session ${sessionId} not found`,
        error_code: ToolErrorCode.SESSION_NOT_FOUND,
      }, { defaultErrorCode: ToolErrorCode.SESSION_NOT_FOUND });
    }
    return standardizeLegacyResult({
      success: true,
      data: {
        output: result.output,
        pid: result.metadata.pid,
        cwd: result.metadata.cwd,
        is_running: result.metadata.isRunning,
        last_output_at: result.metadata.lastOutputAt,
        last_exit_code: result.metadata.lastExitCode,
        last_command_completed_at: result.metadata.lastCommandCompletedAt,
        has_pending_command: result.metadata.hasPendingCommand,
      },
    });
  },
};

export interface ListTerminalSessionsOutput {
  success: boolean;
  data?: Record<string, any>;
  error?: ToolError;
}

export interface ListTerminalSessionsInput {
  _space_id?: string;
}

export const listTerminalSessionsTool: AgentTool<ListTerminalSessionsInput, ListTerminalSessionsOutput> = {
  name: 'list_terminal_sessions',
  description: 'List all active PTY terminal sessions with their IDs, PIDs, current working directories, and running status.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  async execute(input?: ListTerminalSessionsInput): Promise<ListTerminalSessionsOutput> {
    const runtime = resolveTerminalRuntime();
    if (!runtime?.listSessions) {
      return standardizeLegacyResult({
        success: false,
        error: runtime ? 'Current terminal runtime does not support listing terminal sessions' : 'PTY manager API not available',
        error_code: ToolErrorCode.UNKNOWN_ERROR,
      }, { defaultErrorCode: ToolErrorCode.UNKNOWN_ERROR });
    }
    const spaceId = input?._space_id;
    const sessions = runtime.listSessions({ spaceId });
    return standardizeLegacyResult({
      success: true,
      data: {
        sessions: sessions.map((s) => ({
          id: s.id,
          pid: s.pid,
          cwd: s.cwd,
          is_running: s.isRunning,
          last_output_at: s.lastOutputAt,
          created_at: s.createdAt,
          last_exit_code: s.lastExitCode,
          last_command_completed_at: s.lastCommandCompletedAt,
          has_pending_command: s.hasPendingCommand,
        })),
      },
    });
  },
};

// ========== Agent 输出截断 ==========
//
// Agent context window 有限，对于 `find /` 或 `cat huge_file` 这类命令，
// 巨量输出会挤占 context。此处实现保留首尾、截断中间的策略，
// 保留首尾、截断中间的策略。

const AGENT_TRUNCATION_MAX_CHARS = 51_200; // 50 KB
const AGENT_TRUNCATION_TAIL_CHARS = 10_240; // 10 KB
const AGENT_TRUNCATION_MARKER =
  '\n\n... [truncated: {removed} chars removed, showing first {head} + last {tail} chars] ...\n\n';

export interface AgentTruncationResult {
  output: string;
  truncated: boolean;
  originalLength: number;
}

export function truncateOutputForAgent(
  raw: string,
  maxChars: number = AGENT_TRUNCATION_MAX_CHARS,
  tailChars: number = AGENT_TRUNCATION_TAIL_CHARS,
): AgentTruncationResult {
  if (raw.length <= maxChars) {
    return { output: raw, truncated: false, originalLength: raw.length };
  }

  const markerOverhead = AGENT_TRUNCATION_MARKER.length + 60;
  const headChars = maxChars - tailChars - markerOverhead;

  if (headChars <= 0) {
    const tail = raw.slice(-tailChars);
    const marker = AGENT_TRUNCATION_MARKER
      .replace('{removed}', String(raw.length - tailChars))
      .replace('{head}', '0')
      .replace('{tail}', String(tailChars));
    return { output: marker + tail, truncated: true, originalLength: raw.length };
  }

  const head = raw.slice(0, headChars);
  const tail = raw.slice(-tailChars);
  const removed = raw.length - headChars - tailChars;
  const marker = AGENT_TRUNCATION_MARKER
    .replace('{removed}', String(removed))
    .replace('{head}', String(headChars))
    .replace('{tail}', String(tailChars));

  return { output: head + marker + tail, truncated: true, originalLength: raw.length };
}

// ========== execute_in_terminal ==========

export interface AutoRespondRule {
  pattern: string;
  response: string;
}

export interface ExecuteInTerminalInput {
  command: string;
  session_id?: string;
  block_until_ms?: number;
  working_directory?: string;
  auto_respond?: AutoRespondRule[];
  kill_on_timeout?: boolean;
  _space_id?: string;
  _workspace_root?: string;
  _thread_id?: string;
  _sandbox_policy?: TerminalExecutionPolicyPayload;
  _skip_policy_degradation?: boolean;
  _degradation_decision?: TerminalExecuteRequest['_degradationDecision'];
}

export interface ExecuteInTerminalOutput {
  success: boolean;
  data?: Record<string, any>;
  error?: ToolError;
}

export const executeInTerminalTool: AgentTool<ExecuteInTerminalInput, ExecuteInTerminalOutput> = {
  name: 'execute_in_terminal',
  description:
    'Execute a command in a persistent PTY shell session. State (cwd, env) persists across calls. ' +
    'Supports background mode via block_until_ms and auto_respond for interactive prompts. ' +
    'When block_until_ms=0, the command runs in background: returns immediately with backgrounded=true, ' +
    'output="" and exitCode=null. Use read_terminal_output to poll for actual output and completion status. ' +
    'IMPORTANT: "success" means the command was submitted to the terminal, NOT that it exited with code 0. ' +
    'Check "command_succeeded" (true/false/null) to know if the command itself succeeded (exit_code==0). ' +
    'command_succeeded is null when the command is still running in background. ' +
    'Result includes timed_out: true if the command exceeded block_until_ms. ' +
    'When timed_out + backgrounded=true, the command continues in background (use read_terminal_output to poll). ' +
    'When timed_out + backgrounded=false, the command was killed (kill_on_timeout was true).',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      session_id: {
        type: 'string',
        description: 'Reuse an existing session. Omit to auto-create a new agent session.',
      },
      block_until_ms: {
        type: 'number',
        description:
          'Max wait time in ms before moving to background (default 30000). Set to 0 for immediate background.',
        default: 30000,
      },
      working_directory: {
        type: 'string',
        description: 'Override working directory for this command',
      },
      auto_respond: {
        type: 'array',
        description:
          'Auto-respond rules for interactive prompts. Each rule matches output (case-insensitive substring) and sends a response. Rules are consumed in order, each matching once.',
        items: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Substring to match in terminal output (case-insensitive)' },
            response: { type: 'string', description: 'Data to send when pattern matches. Use \\n for Enter.' },
          },
          required: ['pattern', 'response'],
        },
      },
      kill_on_timeout: {
        type: 'boolean',
        description:
          'Whether to send Ctrl+C to kill the command when it exceeds block_until_ms. ' +
          'Defaults to true. Set to false to let long-running commands continue in background without interruption.',
        default: true,
      },
    },
    required: ['command'],
  },
  async execute(input: ExecuteInTerminalInput): Promise<ExecuteInTerminalOutput> {
    const command = input.command?.trim();
    if (!command) {
      return standardizeLegacyResult({
        success: false,
        error: 'command is required',
        error_code: ToolErrorCode.INVALID_PARAMETER,
      }, { defaultErrorCode: ToolErrorCode.INVALID_PARAMETER });
    }

    const runtime = resolveTerminalRuntime();
    if (!runtime?.execute) {
      return standardizeLegacyResult({
        success: false,
        error: 'PTY executeCommand API not available',
        error_code: ToolErrorCode.UNKNOWN_ERROR,
      }, { defaultErrorCode: ToolErrorCode.UNKNOWN_ERROR });
    }

    try {
      // killOnTimeout 经 TerminalExecuteRequest 传递，adaptPtyManagerAPI 转发到 PtyManagerAPI.executeCommand（HF2 修复）
      const killOnTimeout = input.kill_on_timeout !== false;
      const executeRequest = {
        command,
        sessionId: input.session_id,
        blockUntilMs: Math.min(input.block_until_ms ?? 30_000, 270_000),
        killOnTimeout,
        context: {
          workingDirectory: input.working_directory,
          workspaceRoot: input._workspace_root,
          threadId: input._thread_id,
          spaceId: input._space_id,
        },
        policy: input._skip_policy_degradation
          ? undefined
          : normalizeTerminalExecutionPolicy(input._sandbox_policy),
        autoRespond: input.auto_respond,
        _degradationDecision: input._skip_policy_degradation
          ? undefined
          : input._degradation_decision,
      };
      const result = await runtime.execute(executeRequest);

      // 交互式命令阻断：降级路径检测到命令需要交互式输入，返回特殊结果让上层发起 HITL
      if (result.interactiveBlocked) {
        return standardizeLegacyResult({
          success: false,
          error: `Interactive command blocked: ${result.interactiveReason || 'command requires interactive input'}`,
          error_code: 'INTERACTIVE_BLOCKED' as ToolErrorCode,
          data: {
            interactive_blocked: true,
            interactive_reason: result.interactiveReason,
            matched_command: result.matchedCommand,
            session_id: result.sessionId,
          },
        }, { defaultErrorCode: ToolErrorCode.UNKNOWN_ERROR });
      }

      // BT-3: 检测 Daemon policy 拒绝的伪成功响应，统一为 success=false
      if (isDaemonPolicyBlockedResponse(result)) {
        return standardizeLegacyResult({
          success: false,
          error: result.output || 'Command blocked by security policy.',
          error_code: ToolErrorCode.POLICY_BLOCKED,
          ...(result.ruleName ? { blocked_by_rule: result.ruleName } : {}),
        }, { defaultErrorCode: ToolErrorCode.POLICY_BLOCKED });
      }

      // P0-F3: 对返回 Agent 的输出做截断，防止巨量输出占满 context window
      const rawOutput = result.output ?? '';
      const truncation = truncateOutputForAgent(rawOutput);

      // EF6: command_succeeded — 明确表达"命令本身是否成功"的语义。
      // success 仅表示"命令是否被成功提交到 PTY 执行"，不代表命令返回码。
      // backgrounded 模式下命令尚未完成，exitCode 为 null，command_succeeded 也为 null。
      const commandSucceeded = result.backgrounded
        ? null
        : (result.exitCode === 0);

      return standardizeLegacyResult({
        success: true,
        data: {
          output: truncation.output,
          exit_code: result.exitCode,
          command_succeeded: commandSucceeded,
          cwd: result.cwd,
          backgrounded: result.backgrounded,
          timed_out: result.timedOut ?? false,
          duration_ms: result.durationMs,
          session_id: result.sessionId,
          space_id: input._space_id || undefined,
          ...((truncation.truncated || result.outputTruncated) ? {
            output_truncated: true,
            ...(truncation.truncated ? { output_original_length: truncation.originalLength } : {}),
            ...(result.outputTruncated ? { buffer_overflow: true } : {}),
          } : {}),
        },
      });
    } catch (error) {
      // BT-2: 区分不同错误类型，保留原始错误信息
      const message = error instanceof Error ? error.message : String(error);
      const errorCode = classifyTerminalError(message);
      // EF6: 从错误对象中提取 ruleName（commandExecutor / DaemonPtyManager 附加）
      const ruleName = (error as any)?.ruleName as string | undefined;
      return standardizeLegacyResult({
        success: false,
        error: message,
        error_code: errorCode,
        ...(ruleName && errorCode === ToolErrorCode.POLICY_BLOCKED
          ? { blocked_by_rule: ruleName }
          : {}),
      }, { defaultErrorCode: errorCode });
    }
  },
};

// ========== write_to_terminal 安全验证 ==========
//
// HF1 修复：write_to_terminal 此前完全绕过 CommandValidator / denylist / allowlist。
// 分层验证策略：
//   L0. 纯控制字符（Ctrl+C / Ctrl+D / Ctrl+Z）→ 放行
//   L1. isAutoApprovedTerminalWrite（y/n/yes/no/Enter/数字）→ 放行
//   L2. 长度限制（1024 字节）→ 超长拒绝
//   L3. CRITICAL_DENYLIST 模式检测（pipe-to-shell 等）→ 命中拒绝
//   L4. 换行结尾的完整命令 → CommandValidator 全量校验
//   L5. 其余数据（不以换行结尾的部分输入）→ 放行

const WRITE_MAX_BYTES = 1024;

const writeValidator = new CommandValidator();

const SAFE_CONTROL_CHARS = new Set([
  '\x03', // Ctrl+C
  '\x04', // Ctrl+D (EOF)
  '\x1a', // Ctrl+Z (suspend)
]);

export interface WriteValidationResult {
  allowed: boolean;
  reason?: string;
  ruleName?: string;
}

/**
 * Validates data being written to a PTY session.
 *
 * @param rawData  - The unescaped data that will be written to PTY stdin.
 * @param originalInput - The original input string (with escape sequences like \\x03).
 *                        Passed to isAutoApprovedTerminalWrite which does its own unescaping.
 */
export function validateWriteData(rawData: string, originalInput: string): WriteValidationResult {
  // L0: Pure control character — always safe
  if (rawData.length === 1 && SAFE_CONTROL_CHARS.has(rawData)) {
    return { allowed: true };
  }

  // L1: Auto-approved interactive response (y/n, yes/no, Enter, single digit)
  if (isAutoApprovedTerminalWrite(originalInput)) {
    return { allowed: true };
  }

  // L2: Length limit — defense in depth against payload smuggling
  if (rawData.length > WRITE_MAX_BYTES) {
    return {
      allowed: false,
      reason: `Input exceeds maximum allowed length (${WRITE_MAX_BYTES} bytes)`,
      ruleName: 'write-length-limit',
    };
  }

  // L3: Critical denylist patterns (pipe-to-shell, curl|sh, redirect-write, etc.)
  // Checked on all data regardless of trailing newline.
  const stripped = rawData.replace(/[\r\n]+$/g, '');
  if (stripped.length > 0) {
    for (const rule of CRITICAL_DENYLIST) {
      if (rule.pattern.test(stripped)) {
        return {
          allowed: false,
          reason: `Dangerous pattern detected: ${rule.name}`,
          ruleName: rule.name,
        };
      }
    }
  }

  // L4: Newline-terminated data looks like a command submission → full validation
  if (rawData.endsWith('\n') || rawData.endsWith('\r')) {
    const commandLike = stripped.trim();
    if (commandLike.length > 0) {
      const result = writeValidator.validate(commandLike);
      if (!result.allowed) {
        return {
          allowed: false,
          reason: result.reason || 'Command not allowed',
          ruleName: result.ruleName,
        };
      }
    }
  }

  // L5: Non-newline-terminated partial input — allow (interactive typing, partial responses)
  return { allowed: true };
}

// ========== write_to_terminal ==========

export interface WriteToTerminalInput {
  session_id?: string;
  data: string;
  _thread_id?: string;
}

export interface WriteToTerminalOutput {
  success: boolean;
  data?: Record<string, any>;
  error?: ToolError;
}

export const writeToTerminalTool: AgentTool<WriteToTerminalInput, WriteToTerminalOutput> = {
  name: 'write_to_terminal',
  description:
    'Write raw data to a PTY session. Use for responding to interactive prompts (y/n), ' +
    'sending Ctrl+C (\\x03), or providing stdin input.',
  parameters: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'PTY session ID to write to. Falls back to thread context when omitted.' },
      data: {
        type: 'string',
        description: 'Data to write. Use \\x03 for Ctrl+C, \\n for Enter.',
      },
    },
    required: ['data'],
  },
  async execute(input: WriteToTerminalInput): Promise<WriteToTerminalOutput> {
    if (input.data === undefined || input.data === null) {
      return standardizeLegacyResult({
        success: false,
        error: 'data is required',
        error_code: ToolErrorCode.INVALID_PARAMETER,
      }, { defaultErrorCode: ToolErrorCode.INVALID_PARAMETER });
    }

    const runtime = resolveTerminalRuntime();
    if (!runtime?.write) {
      return standardizeLegacyResult({
        success: false,
        error: runtime ? 'Current terminal runtime does not support writing to sessions' : 'PTY write API not available',
        error_code: ToolErrorCode.UNKNOWN_ERROR,
      }, { defaultErrorCode: ToolErrorCode.UNKNOWN_ERROR });
    }

    const sessionId = resolveSessionIdFromThread(runtime, input.session_id, input._thread_id);
    if (!sessionId) {
      return standardizeLegacyResult({
        success: false,
        error: 'session_id is required',
        error_code: ToolErrorCode.INVALID_PARAMETER,
      }, { defaultErrorCode: ToolErrorCode.INVALID_PARAMETER });
    }

    const rawData = input.data
      .replace(/\\x03/g, '\x03')
      .replace(/\\x04/g, '\x04')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t');

    // HF1: Security validation — prevent command injection via write_to_terminal
    const validation = validateWriteData(rawData, input.data);
    if (!validation.allowed) {
      return standardizeLegacyResult({
        success: false,
        error: `write_to_terminal blocked: ${validation.reason}`,
        error_code: ToolErrorCode.POLICY_BLOCKED,
        ...(validation.ruleName ? { blocked_by_rule: validation.ruleName } : {}),
      }, { defaultErrorCode: ToolErrorCode.POLICY_BLOCKED });
    }

    const ok = runtime.write(sessionId, rawData);
    if (!ok) {
      return standardizeLegacyResult({
        success: false,
        error: `Failed to write to session ${sessionId} (not found or exited)`,
        error_code: ToolErrorCode.SESSION_NOT_FOUND,
      }, { defaultErrorCode: ToolErrorCode.SESSION_NOT_FOUND });
    }

    return standardizeLegacyResult({
      success: true,
      data: { session_id: sessionId, bytes_written: rawData.length },
    });
  },
};

// **WP5（2026-05-14）**：原 `terminalExecuteTools` / `terminalReadTools` /
// `terminalWriteTools` / `terminalPtyTools` 4 个子组 alias 已退役 —— 唯一消费者
// 是 `tools/terminal/_meta.ts`（一个从未被 `allDomains` 收集的死代码 domain），
// 与 D7「不留中间态」冲突。4 件套现在统一通过 `core-headless/_meta.ts` 的
// `terminalTools` group 暴露（按 manifest `llm_facing: false` 字段标记），
// 不再有"按 read / write / execute 三分"的 capability 切片需求 —— 那是
// L-4 遗留项语义（thread→session 复用），跟工具分组无关。
export const terminalTools = [
  executeInTerminalTool,
  readTerminalOutputTool,
  listTerminalSessionsTool,
  writeToTerminalTool,
];
