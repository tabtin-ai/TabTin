/**
 * CaptchaGuard — 验证码检测与处理
 *
 * 职责：
 * - 在页面执行验证码 DOM 特征检测脚本
 * - 缓存检测结果（节流）
 * - Cloudflare Turnstile 自动等待
 * - 需要人工处理时：非阻塞通知宿主（可选）；不再 await 用户
 *   （人工路径由 wire `captcha_required` / Access Barrier HITL 接手）
 */

import { buildDetectionScript, analyzeDetectionResult, type CaptchaInfo } from '../captcha/CaptchaDetector';
import type { BrowserContext } from '../context/BrowserContext';

export type ContextFactory = (tabId: string) => BrowserContext | null;

export type CaptchaUserInterventionCallback = (
  tabId: string,
  captcha: CaptchaInfo,
) => Promise<boolean>;

/** 超时 / 早退路径专用：禁止叠 waitForTurnstile。 */
export const CAPTCHA_DETECT_FAST_TIMEOUT_MS = 2_000;

const NO_CAPTCHA: CaptchaInfo = {
  detected: false,
  confidence: 0,
  challenge_visible: false,
  suggested_action: 'auto-wait',
};

export function captchaNeedsUserIntervention(captcha: CaptchaInfo): boolean {
  return (
    captcha.detected === true &&
    (captcha.suggested_action === 'user-intervention' ||
      captcha.suggested_action === 'click-checkbox')
  );
}

export class CaptchaGuard {
  private contextFactory: ContextFactory | null = null;
  private interventionCallback: CaptchaUserInterventionCallback | null = null;
  private cache = new Map<string, { result: CaptchaInfo; ts: number }>();
  private static THROTTLE_MS = 5000;

  setContextFactory(factory: ContextFactory): void {
    this.contextFactory = factory;
  }

  setInterventionCallback(cb: CaptchaUserInterventionCallback): void {
    this.interventionCallback = cb;
  }

  clearCache(tabId: string): void {
    this.cache.delete(tabId);
  }

  async detect(tabId: string): Promise<CaptchaInfo> {
    try {
      const cached = this.cache.get(tabId);
      if (cached && Date.now() - cached.ts < CaptchaGuard.THROTTLE_MS) {
        return cached.result;
      }

      if (!this.contextFactory) return NO_CAPTCHA;
      const ctx = this.contextFactory(tabId);
      if (!ctx || !ctx.isAlive()) return NO_CAPTCHA;

      const script = buildDetectionScript();
      const raw = await ctx.executeScript<{
        matches: string[];
        title: string;
        url?: string;
        bodyText?: string;
      }>(script);
      const result = analyzeDetectionResult(raw);
      this.cache.set(tabId, { result, ts: Date.now() });
      return result;
    } catch {
      return { ...NO_CAPTCHA };
    }
  }

  /**
   * 快速探测：只跑 DOM/URL/正文脚本，**绝不** waitForTurnstile。
   * 供 act 早退、CLI CONNECTION_TIMEOUT 补投 `captcha_required` 使用；硬上限默认 2s。
   */
  async detectFast(
    tabId: string,
    timeoutMs: number = CAPTCHA_DETECT_FAST_TIMEOUT_MS,
  ): Promise<CaptchaInfo> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.detect(tabId),
        new Promise<CaptchaInfo>((resolve) => {
          timer = setTimeout(() => resolve({ ...NO_CAPTCHA }), timeoutMs);
        }),
      ]);
    } catch {
      return { ...NO_CAPTCHA };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async detectAndHandle(tabId: string): Promise<CaptchaInfo> {
    const captcha = await this.detect(tabId);
    if (!captcha.detected) return captcha;

    if (captcha.type === 'turnstile' && captcha.suggested_action === 'auto-wait') {
      const passed = await this.waitForTurnstile(tabId, 20000);
      if (passed) {
        this.clearCache(tabId);
        return { ...captcha, detected: false, confidence: 0 };
      }
    } else if (captchaNeedsUserIntervention(captcha)) {
      // 人工验证码不再阻塞 RPC 等待用户（旧路径 await 最长 120s → CLI 先超时，
      // Agent 只看到 CONNECTION_TIMEOUT 并空转 glance）。墙信号由编排层投影为
      // captcha_required / Access Barrier，能力层 HITL 弹卡挂起。
      // interventionCallback 若仍注册：仅作非阻塞通知（例如把 Tab 提到前台），
      // 不得依赖其返回值决定是否清除 detected。
      if (this.interventionCallback) {
        void Promise.resolve(this.interventionCallback(tabId, captcha)).catch(() => {});
      }
    }

    return captcha;
  }

  private async waitForTurnstile(tabId: string, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    const interval = 2000;
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, interval));
      try {
        if (!this.contextFactory) return false;
        const ctx = this.contextFactory(tabId);
        if (!ctx || !ctx.isAlive()) return false;
        const check = await ctx.executeScript<{ title: string; response: string }>(`
          (function() {
            var title = document.title || '';
            var resp = '';
            try { var el = document.querySelector('input[name="cf-turnstile-response"]'); if (el) resp = el.value || ''; } catch(e){}
            return { title: title, response: resp };
          })();
        `);
        const isChallengeGone =
          check.title !== 'Just a moment...' &&
          check.title !== 'Attention Required! | Cloudflare';
        const hasResponse = check.response && check.response.length > 0;
        if (isChallengeGone || hasResponse) return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

let shared: CaptchaGuard | null = null;

export function getSharedCaptchaGuard(): CaptchaGuard {
  if (!shared) shared = new CaptchaGuard();
  return shared;
}
