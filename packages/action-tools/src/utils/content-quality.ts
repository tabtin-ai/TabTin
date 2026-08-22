/**
 * 内容质量校验 — 检测采集结果是否为真正内容
 *
 * 检测项：空内容、SPA 骨架页、验证码/挑战页、封禁/限流、服务器错误。
 * 每个 reason 附带 suggestion 字段指导 Agent 下一步行动。
 */

export type ContentQualityReason =
  | 'empty'
  | 'insufficient_content'
  | 'spa_skeleton'
  | 'captcha'
  | 'blocked'
  | 'rate_limited'
  | 'server_error';

export interface ContentQuality {
  ok: boolean;
  reason?: ContentQualityReason;
  message?: string;
  suggestion?: string;
}

// 精确的验证码/挑战信号（避免 /cloudflare/i 误伤普通 Cloudflare 托管页面）
const CAPTCHA_SIGNALS = [
  'cf-challenge-running',
  'cf-turnstile',
  'hcaptcha-box',
  'h-captcha',
  'g-recaptcha',
  'recaptcha-anchor',
];

const SPA_ROOT_MARKERS = [
  'id="root"', 'id="app"', 'id="__next"',
  "id='root'", "id='app'", "id='__next'",
];

export function validateContentQuality(
  content: string,
  rawHtml: string,
  statusCode?: number,
): ContentQuality {
  // 1. 服务器错误（5xx）
  if (statusCode && statusCode >= 500) {
    return {
      ok: false,
      reason: 'server_error',
      message: `Server returned HTTP ${statusCode}`,
      suggestion: 'The server may be temporarily down. Retry after a brief wait.',
    };
  }

  // 2. 限流（429）
  if (statusCode === 429) {
    return {
      ok: false,
      reason: 'rate_limited',
      message: 'Rate limited (HTTP 429)',
      suggestion: 'Wait a moment before retrying. Reduce request frequency if making multiple calls.',
    };
  }

  // 3. 封禁（403 + access denied 指标）
  if (statusCode === 403) {
    const lower = rawHtml.toLowerCase();
    if (lower.includes('access denied') || lower.includes('forbidden')) {
      return {
        ok: false,
        reason: 'blocked',
        message: 'Access denied (HTTP 403)',
        suggestion: 'The site blocks automated access. Use `tabtin browser open <url>` to load in a real browser.',
      };
    }
  }

  // 4. 验证码/挑战页精确检测
  const lower = rawHtml.toLowerCase();
  const hasCaptcha = CAPTCHA_SIGNALS.some(s => lower.includes(s));
  const hasJustAMoment = /<title[^>]*>[^<]*just a moment[^<]*<\/title>/i.test(rawHtml);
  if (hasCaptcha || hasJustAMoment) {
    return {
      ok: false,
      reason: 'captcha',
      message: 'Page is behind a CAPTCHA or bot-challenge screen',
      suggestion: 'Use `tabtin browser open <url>` to load in a real browser that can handle challenges.',
    };
  }

  // 5. 空内容
  if (!content || content.trim().length === 0) {
    return {
      ok: false,
      reason: 'empty',
      message: 'No readable content could be extracted',
      suggestion: 'The page may be empty or require JavaScript rendering. Try `tabtin browser open <url>` then `extract`.',
    };
  }

  // 6. 内容量极低（< 50 字）— 覆盖所有反爬空壳页，无需逐站加规则
  if (content.trim().length < 50) {
    return {
      ok: false,
      reason: 'insufficient_content',
      message: `Very little readable content (${content.trim().length} chars)`,
      suggestion: 'The page may block automated access or require JavaScript rendering. Try `tabtin browser open <url>` then `extract`.',
    };
  }

  // 7. SPA 骨架页（内容 <200 字 + 含 SPA 根标记）
  const hasSpaRoot = SPA_ROOT_MARKERS.some(s => lower.includes(s));
  if (content.trim().length < 200 && hasSpaRoot) {
    return {
      ok: false,
      reason: 'spa_skeleton',
      message: 'Page appears to be a client-side rendered SPA with minimal server HTML',
      suggestion: 'Use `tabtin browser open <url>` to render JavaScript, then use `extract` to get the content.',
    };
  }

  return { ok: true };
}
