import type { BrowserContext } from '../context/BrowserContext';

// DOM 稳定判定参数：连续 QUIET_MS 无结构性 DOM 变更即视为「内容就绪」；
// MAX_MS 为观察上限，超过仍在变化则视为 unsettled（持续动画 / 长轮询 / 数据未就绪）。
// 口径必须与 Electron content-ops.ts、Daemon DaemonBrowserService.ts 的同名常量保持一致
// （三处运行时不同、无法共用一份实现；改动这里请同步另两处）。
const DOM_SETTLE_QUIET_MS = 500;
const DOM_SETTLE_MAX_MS = 10000;
// 页面导航会销毁 executeJavaScript 所在的执行上下文，极端情况下 Promise 不 reject 也不 resolve。
// 宿主侧必须有独立于页面定时器的上限，额外余量只用于 IPC 调度。
const DOM_SETTLE_HOST_GRACE_MS = 250;

/**
 * 生成在页面上下文里执行的「DOM 稳定观察」脚本：用原生 MutationObserver 观察
 * childList/subtree 变更，连续 quietMs 无变更 resolve(true)；到达 maxWaitMs 仍在变化
 * resolve(false)。以 IIFE Promise 字符串形式返回，供 BrowserContext.executeScript 执行
 * （Electron executeJavaScript / Daemon page.evaluate 均会 await 该 Promise）。
 */
function buildDomSettleScript(quietMs: number, maxWaitMs: number): string {
  return `(() => new Promise((resolve) => {
    try {
      let quietTimer = null;
      let done = false;
      const finish = (settled) => {
        if (done) return;
        done = true;
        try { observer.disconnect(); } catch (e) {}
        if (quietTimer) clearTimeout(quietTimer);
        resolve(settled);
      };
      const schedule = () => {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(() => finish(true), ${quietMs});
      };
      const observer = new MutationObserver(() => schedule());
      const root = document.documentElement || document.body;
      if (!root) { resolve(false); return; }
      observer.observe(root, { childList: true, subtree: true, attributes: false, characterData: false });
      setTimeout(() => finish(false), ${maxWaitMs});
      schedule();
    } catch (e) {
      resolve(false);
    }
  }))()`;
}

/**
 * 观察 tab 的 DOM 是否稳定，作为「内容就绪」信号（覆盖 load 后才 fetch 渲染的 SPA、
 * 交互 / 导航后异步渲染）。纯 best-effort：ctx 失效或脚本异常都返回 false，绝不抛错。
 * quiet 窗口固定为 DOM_SETTLE_QUIET_MS；maxWaitMs 允许调用方按场景收紧观察上限
 * （如交互动作后用比页面加载更短的上限，避免持续动画页每次都等满）。
 */
export async function waitForDomSettle(
  ctx: BrowserContext,
  maxWaitMs: number = DOM_SETTLE_MAX_MS,
): Promise<boolean> {
  if (!ctx.isAlive()) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const settled = await Promise.race([
      ctx.executeScript<boolean>(buildDomSettleScript(DOM_SETTLE_QUIET_MS, maxWaitMs)),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), maxWaitMs + DOM_SETTLE_HOST_GRACE_MS);
      }),
    ]);
    return Boolean(settled);
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
