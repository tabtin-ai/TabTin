/**
 * Captcha Wall Gate —— 人机验证码运行时硬门禁（对齐 login-wall-gate）。
 *
 * **为什么需要**：CaptchaGuard 能探测 reCAPTCHA 等，旧路径用全局 toast + 主进程
 * await 用户最长 120s；CLI 先超时，Agent 看不到结构化信号，只反复 glance。
 * 现改为 wire 投影 `captcha_required` + 本门禁强制 ask_user 卡片。
 *
 * **状态机**（与 login-wall-gate 同构）：
 *   1. afterToolResult：侦测 `captcha_required` → pending
 *   2. beforeModel：注入指引 + 工具面只留 ask_user（forceCall）
 *   3. ask_user 出结果 → 解除，同域 run 内免再拦
 *   4. scheduled/batch：只提醒不收窄
 */

import { TelemetryEvents } from '../../telemetry/events.js';
import type {
  BeforeModelContext,
  EngineHooks,
  ObserveFn,
  ToolResultsHookContext,
} from '../contracts/kernel.js';
import type { RuntimeMode } from '../contracts/tools.js';

export interface CaptchaWallGateOptions {
  sessionId: string;
  observe: ObserveFn;
  getRuntimeMode: () => RuntimeMode;
}

const GATE_ALLOWED_TOOLS = ['ask_user'] as const;

interface PendingCaptchaWall {
  domain: string;
  reason: string;
  sourceToolName: string;
  injected: boolean;
}

interface CaptchaWallGateState {
  pending: PendingCaptchaWall | null;
  clearedDomains: Set<string>;
}

const CAPTCHA_REQUIRED_KEY_PATTERN = /\\*"captcha_required\\*"\s*:/;
const CAPTCHA_REASON_PATTERN = /\\*"reason\\*"\s*:\s*\\*"((?:[^"\\]|\\.)*?)\\*"/;
const PAGE_URL_PATTERN = /\\*"(?:finalUrl|page_url|url)\\*"\s*:\s*\\*"(https?:\/\/[^"\\]+)/;

function toolResultToText(content: unknown): string {
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function extractDomain(text: string): string {
  const match = PAGE_URL_PATTERN.exec(text);
  if (!match) return 'unknown';
  try {
    return new URL(match[1]!).hostname.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}

function extractReason(text: string): string {
  const keyIndex = text.search(CAPTCHA_REQUIRED_KEY_PATTERN);
  if (keyIndex < 0) return '页面需要完成验证码';
  const match = CAPTCHA_REASON_PATTERN.exec(text.slice(keyIndex));
  return match?.[1]?.replace(/\\"/g, '"') ?? '页面需要完成验证码';
}

/** 从单个工具结果里提取验证码墙信号；未命中返回 null。 */
export function detectCaptchaWallSignal(
  content: unknown,
): { domain: string; reason: string } | null {
  const text = toolResultToText(content);
  if (!CAPTCHA_REQUIRED_KEY_PATTERN.test(text)) return null;
  return { domain: extractDomain(text), reason: extractReason(text) };
}

function buildGateInjection(pending: PendingCaptchaWall): string {
  return [
    '<captcha_wall_gate>',
    `系统确定性检测到人机验证码（${pending.domain}：${pending.reason}）。`,
    '本轮工具面已被系统收窄：只允许调用 ask_user。立即用 ask_user 向用户说明此页需要完成验证，并让其二选一：',
    '① 在 TabTin 浏览器当前标签页完成验证码后选择「已完成验证」，你复用同一 --tab-id 继续；',
    '② 明确同意后改从其他公开来源获取（须诚实标注真实来源、不得标为本站结果）。',
    '不要尝试自动点击或绕过验证码；不要反复 glance/act 空转。',
    '</captcha_wall_gate>',
  ].join('\n');
}

function buildScheduledReminderInjection(pending: PendingCaptchaWall): string {
  return [
    '<captcha_wall_gate>',
    `系统确定性检测到人机验证码（${pending.domain}：${pending.reason}），当前为无人值守运行，无法请用户完成验证。`,
    '该站内容本次不可得：如改用其他公开来源，必须诚实标注真实来源、不得标为本站结果；无法替代时如实说明该站因需验证码而未覆盖。',
    '不要尝试自动点击或绕过验证码。',
    '</captcha_wall_gate>',
  ].join('\n');
}

function scanToolResults(
  ctx: ToolResultsHookContext,
  state: CaptchaWallGateState,
  options: CaptchaWallGateOptions,
): void {
  for (const er of ctx.results) {
    if (er.toolName === 'ask_user' && state.pending?.injected) {
      state.clearedDomains.add(state.pending.domain);
      options.observe(
        TelemetryEvents.CAPTCHA_WALL_GATE_RELEASED,
        {
          domain: state.pending.domain,
          ask_errored: !!er.result.isError,
          iteration_index: ctx.iteration,
        },
        { session_id: options.sessionId },
      );
      state.pending = null;
      continue;
    }
    if (er.result.isError) continue;
    const signal = detectCaptchaWallSignal(er.result.content);
    if (!signal) continue;
    if (state.clearedDomains.has(signal.domain)) continue;
    if (state.pending?.domain === signal.domain) continue;
    state.pending = {
      domain: signal.domain,
      reason: signal.reason,
      sourceToolName: er.toolName,
      injected: false,
    };
    options.observe(
      TelemetryEvents.CAPTCHA_WALL_GATE_ENGAGED,
      {
        domain: signal.domain,
        source_tool: er.toolName,
        iteration_index: ctx.iteration,
      },
      { session_id: options.sessionId },
    );
  }
}

function enforceGate(
  ctx: BeforeModelContext,
  state: CaptchaWallGateState,
  options: CaptchaWallGateOptions,
): void {
  const pending = state.pending;
  if (!pending) return;
  if (ctx.isGraceTurn()) return;
  const mode = options.getRuntimeMode();
  if (mode === 'scheduled' || mode === 'batch') {
    if (!pending.injected) {
      pending.injected = true;
      ctx.state.messages.push({
        role: 'user',
        content: buildScheduledReminderInjection(pending),
      });
    }
    state.clearedDomains.add(pending.domain);
    state.pending = null;
    return;
  }
  if (!pending.injected) {
    pending.injected = true;
    ctx.state.messages.push({
      role: 'user',
      content: buildGateInjection(pending),
    });
  }
  ctx.restrictToolsForTurn(GATE_ALLOWED_TOOLS, { forceCall: true });
}

export function buildCaptchaWallGateHook(options: CaptchaWallGateOptions): EngineHooks {
  const state: CaptchaWallGateState = { pending: null, clearedDomains: new Set() };
  return {
    async beforeModel(ctx): Promise<void> {
      enforceGate(ctx, state, options);
    },
    async afterToolResult(ctx): Promise<void> {
      scanToolResults(ctx, state, options);
    },
  };
}
