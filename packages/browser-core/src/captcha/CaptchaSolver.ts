/**
 * CaptchaSolver — 验证码求解接口
 *
 * 为后续对接第三方验证码服务（2Captcha / CapSolver 等）预留扩展点。
 * 当前仅定义接口，不提供实现。
 */

import type { CaptchaType } from './CaptchaDetector';

export interface CaptchaSolveParams {
  type: CaptchaType;
  siteKey?: string;
  pageUrl: string;
  screenshot?: string;
}

export interface CaptchaSolveResult {
  success: boolean;
  token?: string;
  error?: string;
  elapsed_ms?: number;
}

export interface CaptchaSolver {
  canSolve(type: CaptchaType): boolean;
  solve(params: CaptchaSolveParams): Promise<CaptchaSolveResult>;
}

/**
 * 空实现 — 始终返回不支持，用于接口占位。
 */
export class NoOpCaptchaSolver implements CaptchaSolver {
  canSolve(_type: CaptchaType): boolean {
    return false;
  }

  async solve(_params: CaptchaSolveParams): Promise<CaptchaSolveResult> {
    return { success: false, error: 'No solver configured' };
  }
}
