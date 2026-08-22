/**
 * Agent 模拟指针编排层（主进程侧）。
 *
 * 在真实鼠标动作（CDP Input.dispatchMouseEvent / DOM 操作）执行前，把页内
 * cursor runtime 注入被浏览页面并等指针动画到位——让用户看见 Agent 在点哪里。
 *
 * 铁律：可视化任何失败（注入报错 / 页面 CSP / 动画卡死）都必须静默放行，
 * 绝不阻断真实动作。兜底超时 1.5s。
 */

import type { BrowserContext } from '../context/BrowserContext';
import { CURSOR_RUNTIME_SNIPPET } from '../page-scripts/cursor-runtime';

const ANIMATION_FALLBACK_TIMEOUT_MS = 1500;

function buildInvocation(expression: string): string {
  return `(async () => { try { ${CURSOR_RUNTIME_SNIPPET}; __tabtinAgentCursorEnsure(); ${expression} } catch (_) {} })()`;
}

/** 指针飞到 (x, y)，到位后 resolve；失败/超时静默放行。 */
export async function animateCursorTo(ctx: BrowserContext, x: number, y: number): Promise<void> {
  const rx = Math.round(x);
  const ry = Math.round(y);
  const script = buildInvocation(`await __tabtinAgentCursorMoveTo(${rx}, ${ry});`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // 先挂 .catch：timeout 胜出后 executeScript 延迟 reject（常见于导航）不得变成 unhandledRejection
    const run = ctx.executeScript(script).catch(() => {});
    await Promise.race([
      run,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ANIMATION_FALLBACK_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // 可视化失败静默：不打断真实动作
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 点击波纹 / 按下 / 松开，fire-and-forget。 */
export function pulseCursor(ctx: BrowserContext, kind: 'click' | 'down' | 'up'): void {
  const script = buildInvocation(`__tabtinAgentCursorPulse(${JSON.stringify(kind)});`);
  void Promise.resolve()
    .then(() => ctx.executeScript(script))
    .catch(() => {});
}

/** drag 跟随：匀速直线滑到 (x, y)，fire-and-forget。 */
export function glideCursorTo(ctx: BrowserContext, x: number, y: number, durationMs: number): void {
  const rx = Math.round(x);
  const ry = Math.round(y);
  const ms = Math.max(0, Math.round(durationMs));
  const script = buildInvocation(`__tabtinAgentCursorGlideTo(${rx}, ${ry}, ${ms});`);
  void Promise.resolve()
    .then(() => ctx.executeScript(script))
    .catch(() => {});
}

/** 任务结束收起指针：注入 hide，不 ensure。失败静默。 */
export function buildHideCursorScript(): string {
  return `(async () => { try { ${CURSOR_RUNTIME_SNIPPET}; __tabtinAgentCursorHide(); } catch (_) {} })()`;
}

export function hideCursor(ctx: BrowserContext): void {
  const script = buildHideCursorScript();
  void Promise.resolve()
    .then(() => ctx.executeScript(script))
    .catch(() => {});
}
