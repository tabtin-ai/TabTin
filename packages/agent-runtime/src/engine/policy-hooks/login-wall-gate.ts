/**
 * Login Wall Gate —— 登录墙运行时硬门禁。
 *
 * **为什么需要硬门禁**：BlockDetector 已能确定性探测登录墙（`auth_wall`），
 * 浏览器工具结果里也投影了 `login_required` 字段 + 拦截 hint，但两轮真实
 * dogfood（xiaohongshu 场景）证明纯提示词约束压不住模型——模型在 thinking
 * 里承认「弹出了登录框」，仍静默绕道搜索引擎，拿别处内容冒充本站结果交付。
 * 本 hook 把「停下来问用户」从软约束升级为系统强制。
 *
 * **状态机**（工厂闭包持有，随 run 生命周期；forkQuery 子 runtime 自建新栈）：
 *   1. **侦测**（afterToolResult）：扫描工具结果文本里的确定性
 *      `login_required` 标记（来自 BrowserOrchestrator.projectObservePayload
 *      的投影，经 run_terminal_command stdout 或 FC 浏览器工具透传，键名以
 *      转义/非转义形式出现均可命中），提取域名 + reason 记为 pending；
 *   2. **门禁**（beforeModel）：pending 存在时注入 <login_wall_gate> 指引，
 *      并把本轮工具面收窄到只剩 `ask_user`——模型物理上无法静默绕道；
 *   3. **解除**：ask_user 出结果（用户答复 / 跳过 / 超时，成功失败都算）即
 *      清 pending 并把该域记入 cleared——同域 run 内不再强拦（误报或用户
 *      已表态时，代价被钉在「多问一次」，不会把任务卡死在门禁循环里）；
 *   4. **降级**：scheduled 无人值守档没人回答卡片，硬收窄会让自动化永远
 *      挂住——只注入提醒（要求诚实标注来源），不收窄工具面。
 *
 * 已知限制：状态随 run 生命周期——run 结束后用户新消息开新 run，同域再撞
 * 墙会再问一次（用户答复已在对话上下文里，模型通常能直接遵循；跨 run 持久
 * 化免拦名单需要宿主侧存储，v1 不做）。
 */

import { TelemetryEvents } from '../../telemetry/events.js';
import type {
  BeforeModelContext,
  EngineHooks,
  ObserveFn,
  ToolResultsHookContext,
} from '../contracts/kernel.js';
import type { RuntimeMode } from '../contracts/tools.js';

export interface LoginWallGateOptions {
  /** telemetry session 标识（= `sessionConfig.threadId`，装配层解析）。 */
  sessionId: string;
  /** 观测出口（`QueryDeps.observe`）。 */
  observe: ObserveFn;
  /** 当前 runtime 交互档（装配层从 EngineConfig.runtimeMode 归一为 getter）。 */
  getRuntimeMode: () => RuntimeMode;
}

/** 门禁强制时唯一保留的工具。 */
const GATE_ALLOWED_TOOLS = ['ask_user'] as const;

interface PendingLoginWall {
  domain: string;
  tabId?: string;
  reason: string;
  sourceToolName: string;
  /** 指引是否已注入过（pending 跨多轮时不重复注入）。 */
  injected: boolean;
}

interface LoginWallGateState {
  pending: PendingLoginWall | null;
  /** 本 run 内已问过用户的域名——同域不再强拦。 */
  clearedDomains: Set<string>;
}

// ─── 侦测：工具结果文本里的确定性 login_required 标记 ─────────────────

/**
 * `login_required` 键的出现形态：FC 工具结果里是裸 JSON（`"login_required"`），
 * run_terminal_command 的 stdout 是内嵌 JSON 字符串（`\"login_required\"`）。
 * 统一按「可选反斜杠 + 引号」匹配。
 */
const LOGIN_REQUIRED_KEY_PATTERN = /\\*"login_required\\*"\s*:/;
const STRUCTURE_ONLY_PATTERN = /\\*"__tabtin_output_summary\\*"\s*:\s*\\*"structure_only\\*"/;
const CONTROL_SIGNALS_PATTERN = /\\*"control_signals\\*"\s*:/;
const LOGIN_DOMAIN_PATTERN = /\\*"domain\\*"\s*:\s*\\*"([A-Za-z0-9.-]+)\\*"/;

/** reason 提取（同样兼容转义形态；取 login_required 块内的 reason）。 */
const LOGIN_REASON_PATTERN = /\\*"reason\\*"\s*:\s*\\*"((?:[^"\\]|\\.)*?)\\*"/;

/** 页面 URL 提取（finalUrl / page_url / url 任一，取首个 http(s) 值）。 */
const PAGE_URL_PATTERN = /\\*"(?:finalUrl|page_url|url)\\*"\s*:\s*\\*"(https?:\/\/[^"\\]+)/;
const TAB_ID_PATTERN = /\\*"tab_id\\*"\s*:\s*\\*"([A-Za-z0-9_-]{1,128})\\*"/;

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

function extractControlSignalDomain(text: string): string | null {
  if (!CONTROL_SIGNALS_PATTERN.test(text)) return null;
  const domain = LOGIN_DOMAIN_PATTERN.exec(text)?.[1];
  if (!domain) return null;
  try {
    return new URL(`https://${domain}`).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function extractReason(text: string): string {
  const keyIndex = text.search(LOGIN_REQUIRED_KEY_PATTERN);
  if (keyIndex < 0) return '页面需要登录';
  // reason 就近取 login_required 键之后的第一个（避免误配到别的结构）。
  const match = LOGIN_REASON_PATTERN.exec(text.slice(keyIndex));
  return match?.[1]?.replace(/\\"/g, '"') ?? '页面需要登录';
}

/** 从单个工具结果里提取登录墙信号；未命中返回 null。 */
export function detectLoginWallSignal(
  content: unknown,
): { domain: string; reason: string; tabId?: string } | null {
  const text = toolResultToText(content);
  if (!LOGIN_REQUIRED_KEY_PATTERN.test(text)) return null;
  const controlSignalDomain = extractControlSignalDomain(text);
  if (STRUCTURE_ONLY_PATTERN.test(text) && !controlSignalDomain) return null;
  const tabId = TAB_ID_PATTERN.exec(text)?.[1];
  return {
    domain: controlSignalDomain ?? extractDomain(text),
    reason: extractReason(text),
    ...(tabId ? { tabId } : {}),
  };
}

// ─── 门禁指引文案 ──────────────────────────────────────────────────────

function buildGateInjection(pending: PendingLoginWall): string {
  const safeDomain = pending.domain.replace(/"/g, '');
  const safeTabId = pending.tabId?.replace(/[^A-Za-z0-9_-]/g, '');
  return [
    `<login_wall_gate domain="${safeDomain}"${safeTabId ? ` tab_id="${safeTabId}"` : ''}>`,
    `系统确定性检测到登录墙（${pending.domain}：${pending.reason}）。`,
    '本轮工具面已被系统收窄：只允许调用 ask_user。立即用 ask_user 向用户说明此页需要登录，并让其二选一：',
    '① 手动完成登录：本机使用 TabTin 浏览器当前标签页；若你正在其他设备遥控，用登录卡片上的「在本机登录并接力」完成，之后你复用同一 --tab-id 继续在本站获取；',
    '② 明确同意后改从其他公开来源获取（须诚实标注真实来源、不得标为本站结果）。',
    '不要代填账号 / 密码 / 验证码；不要在未询问的情况下擅自换源。',
    '</login_wall_gate>',
  ].join('\n');
}

function buildScheduledReminderInjection(pending: PendingLoginWall): string {
  return [
    '<login_wall_gate>',
    `系统确定性检测到登录墙（${pending.domain}：${pending.reason}），当前为无人值守运行，无法请用户登录。`,
    '该站内容本次不可得：如改用其他公开来源，必须诚实标注真实来源、不得标为本站结果；无法替代时如实说明该站因需登录而未覆盖。',
    '不要尝试代填账号 / 密码 / 验证码。',
    '</login_wall_gate>',
  ].join('\n');
}

// ─── Hook 实现 ────────────────────────────────────────────────────────

function scanToolResults(
  ctx: ToolResultsHookContext,
  state: LoginWallGateState,
  options: LoginWallGateOptions,
): void {
  for (const er of ctx.results) {
    // 解除：ask_user 出结果（成功失败都算——超时/跳过也视为已把选择权交还
    // 用户），清 pending 并将该域记入免拦名单。
    // 仅认「门禁已生效（injected）之后」的 ask_user：撞墙当轮并行跑的无关
    // ask_user 不算，否则门禁会在生效前被误解除。
    if (er.toolName === 'ask_user' && state.pending?.injected) {
      state.clearedDomains.add(state.pending.domain);
      options.observe(
        TelemetryEvents.LOGIN_WALL_GATE_RELEASED,
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
    const signal = detectLoginWallSignal(er.result.content);
    if (!signal) continue;
    if (state.clearedDomains.has(signal.domain)) continue;
    if (state.pending?.domain === signal.domain) continue;
    state.pending = {
      domain: signal.domain,
      tabId: signal.tabId,
      reason: signal.reason,
      sourceToolName: er.toolName,
      injected: false,
    };
    // 刻意不 emitNotice：登录门禁是用户不感知的内部机制，用户只需看到
    // ask_user 登录卡片；排障走 telemetry（login_wall_gate.engaged）。
    options.observe(
      TelemetryEvents.LOGIN_WALL_GATE_ENGAGED,
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
  state: LoginWallGateState,
  options: LoginWallGateOptions,
): void {
  const pending = state.pending;
  if (!pending) return;
  // grace turn（budget 收尾）本轮无工具，收窄无意义；指引也不注入，
  // 让模型纯文字收尾时如实说明即可。
  if (ctx.isGraceTurn()) return;
  const mode = options.getRuntimeMode();
  // 无人值守档（scheduled / batch）没人回答卡片：只注入提醒，不收窄。
  // 提醒注入一次后即解除（后续按已表态处理，避免每轮重复注入）。
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
  // forceCall：收窄之外协议层再强制（tool_choice: 'required'）——tbao-1
  // dogfood 中模型把 ask_user 调用写成正文伪 XML 后 end_turn，纯收窄挡不住。
  ctx.restrictToolsForTurn(GATE_ALLOWED_TOOLS, { forceCall: true });
}

export function buildLoginWallGateHook(options: LoginWallGateOptions): EngineHooks {
  const state: LoginWallGateState = { pending: null, clearedDomains: new Set() };
  return {
    async beforeModel(ctx): Promise<void> {
      enforceGate(ctx, state, options);
    },
    async afterToolResult(ctx): Promise<void> {
      scanToolResults(ctx, state, options);
    },
  };
}
