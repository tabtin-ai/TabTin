/**
 * CaptchaDetector — 页面验证码检测
 *
 * 通过 DOM 特征、URL、页面标题/正文判断当前页面是否被验证码拦截，
 * 并返回类型和建议的处理策略。
 */

export type CaptchaType =
  | 'turnstile'
  | 'recaptcha-v2'
  | 'recaptcha-v3'
  | 'hcaptcha'
  | 'funcaptcha'
  | 'geetest'
  | 'bytedance'
  | 'custom';

export type CaptchaSuggestedAction =
  | 'auto-wait'
  | 'click-checkbox'
  | 'user-intervention'
  | 'solver-service';

export interface CaptchaInfo {
  detected: boolean;
  type?: CaptchaType;
  confidence: number;
  challenge_visible: boolean;
  suggested_action: CaptchaSuggestedAction;
  /** 探测时页面 URL（超时 detail / gate 抽 domain） */
  page_url?: string;
}

export type CaptchaRequiredWire = {
  reason: string;
  hint: string;
  type?: string;
};

/** 与编排层 / print 共用的墙提示文案（确定性 `captcha_required.hint`）。 */
export const CAPTCHA_REQUIRED_HINT =
  '检测到人机验证（CAPTCHA）：立即停下并把选择权交给用户，不要反复 glance/act 空转。'
  + '用 ask_user 卡片向用户说明此页需要完成验证，并让其二选一：'
  + '① 在 TabTin 浏览器当前标签页完成验证码后选择「已完成验证」，你复用同一 --tab-id 继续；'
  + '② 明确同意后改从其他公开来源获取（须诚实标注真实来源、不得标为本站结果）。'
  + '不要尝试自动点击或绕过验证码。';

const NO_CAPTCHA: CaptchaInfo = {
  detected: false,
  confidence: 0,
  challenge_visible: false,
  suggested_action: 'auto-wait',
};

interface DomSignal {
  selector: string;
  type: CaptchaType;
  weight: number;
  challengeVisible: boolean;
  suggestedAction: CaptchaSuggestedAction;
}

const DOM_SIGNALS: DomSignal[] = [
  // Cloudflare Turnstile
  { selector: 'div.cf-turnstile', type: 'turnstile', weight: 0.9, challengeVisible: true, suggestedAction: 'auto-wait' },
  { selector: 'input[name="cf-turnstile-response"]', type: 'turnstile', weight: 0.8, challengeVisible: false, suggestedAction: 'auto-wait' },
  { selector: '#challenge-running', type: 'turnstile', weight: 0.95, challengeVisible: true, suggestedAction: 'auto-wait' },
  { selector: '#challenge-stage', type: 'turnstile', weight: 0.85, challengeVisible: true, suggestedAction: 'auto-wait' },

  // reCAPTCHA v2
  { selector: 'div.g-recaptcha', type: 'recaptcha-v2', weight: 0.9, challengeVisible: true, suggestedAction: 'click-checkbox' },
  { selector: 'iframe[src*="recaptcha/api2"]', type: 'recaptcha-v2', weight: 0.85, challengeVisible: true, suggestedAction: 'click-checkbox' },
  { selector: 'iframe[src*="recaptcha/enterprise"]', type: 'recaptcha-v2', weight: 0.85, challengeVisible: true, suggestedAction: 'click-checkbox' },
  { selector: 'textarea#g-recaptcha-response', type: 'recaptcha-v2', weight: 0.7, challengeVisible: false, suggestedAction: 'click-checkbox' },

  // reCAPTCHA v3 (invisible)
  { selector: 'script[src*="recaptcha/api.js?render="]', type: 'recaptcha-v3', weight: 0.6, challengeVisible: false, suggestedAction: 'auto-wait' },
  { selector: '.grecaptcha-badge', type: 'recaptcha-v3', weight: 0.5, challengeVisible: false, suggestedAction: 'auto-wait' },

  // hCaptcha
  { selector: 'div.h-captcha', type: 'hcaptcha', weight: 0.9, challengeVisible: true, suggestedAction: 'user-intervention' },
  { selector: 'iframe[src*="hcaptcha.com"]', type: 'hcaptcha', weight: 0.85, challengeVisible: true, suggestedAction: 'user-intervention' },

  // FunCaptcha / Arkose Labs
  { selector: 'iframe[src*="arkoselabs"]', type: 'funcaptcha', weight: 0.85, challengeVisible: true, suggestedAction: 'user-intervention' },
  { selector: '#enforcement-frame', type: 'funcaptcha', weight: 0.80, challengeVisible: true, suggestedAction: 'user-intervention' },
  { selector: 'iframe[data-e2e="enforcement-frame"]', type: 'funcaptcha', weight: 0.80, challengeVisible: true, suggestedAction: 'user-intervention' },

  // GeeTest
  { selector: 'div.geetest_panel', type: 'geetest', weight: 0.85, challengeVisible: true, suggestedAction: 'user-intervention' },
  { selector: 'div.geetest_radar_tip', type: 'geetest', weight: 0.80, challengeVisible: true, suggestedAction: 'click-checkbox' },
  { selector: 'div.geetest_holder', type: 'geetest', weight: 0.75, challengeVisible: true, suggestedAction: 'user-intervention' },

  // ByteDance / 火山验证（36kr 等：宿主 #captcha_container + rmc.bytedance.com iframe）
  {
    selector: 'iframe[src*="rmc.bytedance.com/verifycenter"]',
    type: 'bytedance',
    weight: 0.9,
    challengeVisible: true,
    suggestedAction: 'user-intervention',
  },
  {
    selector: 'iframe[src*="verifycenter/captcha"]',
    type: 'bytedance',
    weight: 0.85,
    challengeVisible: true,
    suggestedAction: 'user-intervention',
  },
  {
    selector: '#captcha_container',
    type: 'bytedance',
    weight: 0.85,
    challengeVisible: true,
    suggestedAction: 'user-intervention',
  },

  // Generic captcha (low-confidence fallback)
  { selector: 'div.captcha-container', type: 'custom', weight: 0.45, challengeVisible: true, suggestedAction: 'user-intervention' },
  { selector: '[id*="captcha"][class*="challenge"]', type: 'custom', weight: 0.40, challengeVisible: true, suggestedAction: 'user-intervention' },
];

/** Google sorry / 异常流量墙：URL 或正文命中即视为需人工验证（不依赖 iframe 已挂载）。 */
const GOOGLE_SORRY_URL_RE = /(?:^|\.)google\.[^/]+\/sorry(?:\/|\?|$)/i;
const TRAFFIC_WALL_TEXT_RE =
  /异常流量|unusual\s+traffic|not\s+a\s+robot|不是自动程序|进行人机身份验证|our\s+systems\s+have\s+detected\s+unusual\s+traffic/i;

export interface CaptchaDetectionRaw {
  matches: string[];
  title: string;
  url?: string;
  bodyText?: string;
}

/**
 * JS 代码段：在页面中执行以检测验证码 DOM 特征。
 * 返回 { matches, title, url, bodyText }。
 */
export function buildDetectionScript(): string {
  const selectors = DOM_SIGNALS.map((s) => s.selector);
  return `
(function() {
  var selectors = ${JSON.stringify(selectors)};
  var matches = [];
  for (var i = 0; i < selectors.length; i++) {
    try { if (document.querySelector(selectors[i])) matches.push(selectors[i]); } catch(e) {}
  }
  var bodyText = '';
  try {
    bodyText = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 2500) : '';
  } catch (e) {}
  return {
    matches: matches,
    title: document.title || '',
    url: (location && location.href) ? location.href : '',
    bodyText: bodyText
  };
})();
`;
}

function attachPageUrl(info: CaptchaInfo, result: CaptchaDetectionRaw): CaptchaInfo {
  const url = typeof result.url === 'string' && result.url.length > 0 ? result.url : undefined;
  return url ? { ...info, page_url: url } : info;
}

/**
 * 从页面 DOM / URL / 标题正文解析验证码信息。
 */
export function analyzeDetectionResult(result: CaptchaDetectionRaw | null | undefined): CaptchaInfo {
  if (!result || !Array.isArray(result.matches)) return NO_CAPTCHA;

  const matchedSignals = DOM_SIGNALS.filter((s) =>
    result.matches.includes(s.selector),
  );

  const isCfChallengePage =
    (result.title === 'Just a moment...' ||
      result.title === 'Attention Required! | Cloudflare') &&
    matchedSignals.length === 0;

  if (isCfChallengePage) {
    return attachPageUrl({
      detected: true,
      type: 'turnstile',
      confidence: 0.85,
      challenge_visible: true,
      suggested_action: 'auto-wait',
    }, result);
  }

  const trafficWall = detectTrafficCaptchaWall(result);
  if (trafficWall) return trafficWall;

  if (matchedSignals.length === 0) return attachPageUrl({ ...NO_CAPTCHA }, result);

  matchedSignals.sort((a, b) => b.weight - a.weight);
  const best = matchedSignals[0];

  const confidence = Math.min(
    1,
    best.weight + (matchedSignals.length - 1) * 0.05,
  );

  return attachPageUrl({
    detected: true,
    type: best.type,
    confidence,
    challenge_visible: best.challengeVisible,
    suggested_action: best.suggestedAction,
  }, result);
}

function detectTrafficCaptchaWall(result: CaptchaDetectionRaw): CaptchaInfo | null {
  const url = typeof result.url === 'string' ? result.url : '';
  const title = typeof result.title === 'string' ? result.title : '';
  const bodyText = typeof result.bodyText === 'string' ? result.bodyText : '';
  const haystack = `${title}\n${bodyText}`;

  const urlHit = Boolean(url && GOOGLE_SORRY_URL_RE.test(url));
  const textHit = TRAFFIC_WALL_TEXT_RE.test(haystack);
  if (!urlHit && !textHit) return null;

  // sorry URL 或明确「异常流量」文案：需用户完成验证，不要当 v3 徽章误报。
  return attachPageUrl({
    detected: true,
    type: 'recaptcha-v2',
    confidence: urlHit && textHit ? 0.95 : 0.88,
    challenge_visible: true,
    suggested_action: 'user-intervention',
  }, result);
}

/** 从 CaptchaInfo 投影确定性 wire 字段（observe / snapshot / print / act 共用）。 */
export function projectCaptchaRequired(
  captcha: CaptchaInfo | null | undefined,
): CaptchaRequiredWire | undefined {
  if (!captcha || captcha.detected !== true) return undefined;
  const type = typeof captcha.type === 'string' && captcha.type ? captcha.type : undefined;
  const reason = type ? `页面需要完成验证码（${type}）` : '页面需要完成验证码';
  return { reason, hint: CAPTCHA_REQUIRED_HINT, ...(type ? { type } : {}) };
}

/** 无 DOM 时用 url/title/html 文本做同源探测（print 落盘响应等）。 */
export function analyzeCaptchaFromPageMeta(input: {
  url?: string;
  title?: string;
  htmlOrText?: string;
}): CaptchaInfo {
  const rawText = typeof input.htmlOrText === 'string' ? input.htmlOrText : '';
  const bodyText = rawText
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2500);
  return analyzeDetectionResult({
    matches: [],
    title: input.title || '',
    url: input.url || '',
    bodyText,
  });
}
