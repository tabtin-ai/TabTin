/**
 * BlockDetector — 多维度页面封禁检测
 *
 * 检测维度：
 *   1. HTTP 状态码（Performance Navigation API）
 *   2. Cloudflare challenge 特征（DOM selector + title 关键词）
 *   3. 反爬关键词匹配（title + body 正则）
 *   4. 空白页启发式检测（极短 body + 4xx/5xx）
 *   5. 登录墙检测（登录表单 DOM + 登录路由 URL + 门槛文案）——独立于 HTTP 403，
 *      覆盖「200 页面 + 登录浮层」（如小红书未登录 explore）这类最常见的登录墙。
 *
 * 所有维度在单次 executeScript 中完成（减少 IPC 次数）。
 * 返回 EnhancedBlockSignal（extends BlockSignal，向后兼容）。
 */

import type { EnhancedBlockSignal, BlockType } from '../types/browser';
import type { BrowserContext } from '../context/BrowserContext';

export type ContextFactory = (tabId: string) => BrowserContext | null;

// ── 反爬关键词 ──────────────────────────────────────────────

const BLOCK_SIGNALS: ReadonlyArray<{
  pattern: RegExp;
  reason: string;
  code: 'blocked' | 'rate_limited';
}> = [
  // 英文
  { pattern: /access\s*denied/i, reason: 'Access Denied', code: 'blocked' },
  { pattern: /403\s*forbidden/i, reason: '403 Forbidden', code: 'blocked' },
  { pattern: /you\s*(have\s*been|are)\s*blocked/i, reason: 'IP Blocked', code: 'blocked' },
  { pattern: /too\s*many\s*requests/i, reason: 'Too Many Requests', code: 'rate_limited' },
  { pattern: /rate\s*limit\s*(exceeded|reached)/i, reason: 'Rate Limit Exceeded', code: 'rate_limited' },
  { pattern: /\bHTTP\s*(?:Status\s*)?429\b|\b429\s+Too\s+Many\b|\bError\s+429\b/i, reason: '429 Rate Limited', code: 'rate_limited' },
  { pattern: /request\s*blocked/i, reason: 'Request Blocked', code: 'blocked' },
  { pattern: /ip\s*(has\s*been\s*)?banned/i, reason: 'IP Banned', code: 'blocked' },
  // 中文
  { pattern: /访问.*(?:被拒绝|已被禁止|已拒绝)/, reason: '访问被拒绝', code: 'blocked' },
  { pattern: /IP.*(?:已被?封|被?禁止|已列入黑名单)/, reason: 'IP 封禁', code: 'blocked' },
  { pattern: /访问.*(?:过于频繁|太频繁|太快)/, reason: '访问过于频繁', code: 'rate_limited' },
  { pattern: /请求.*(?:过于频繁|太频繁|频率.*限制)/, reason: '请求频率限制', code: 'rate_limited' },
  { pattern: /(?:操作|请求).*(?:太快|过快)/, reason: '操作过快', code: 'rate_limited' },
  { pattern: /(?:系统繁忙|服务器繁忙).*(?:稍后|重试)/, reason: '服务器繁忙', code: 'rate_limited' },
];

// ── Cloudflare 特征 ─────────────────────────────────────────
// 只保留稳定特征（CF 经常更新 DOM），selector 列表可扩展

const CF_TITLE_PATTERNS: ReadonlyArray<RegExp> = [
  /Just a moment\.\.\./i,
  /Attention Required!.*Cloudflare/i,
  /Please Wait\.\.\.\s*\|\s*Cloudflare/i,
];

const CF_SELECTORS: ReadonlyArray<string> = [
  '#cf-challenge-running',
  '#cf-wrapper',
  '[data-cf-chl-managed-form-id]',
  '.cf-browser-verification',
  '#cf-challenge-hcaptcha-wrapper',
];

// ── 业务权限关键词（这些出现时 shouldUpgrade = false） ──────

const BUSINESS_AUTH_PATTERNS: ReadonlyArray<RegExp> = [
  // 英文
  /you don['']t have permission/i,
  /permission\s*denied/i,
  /sign\s*in\s*(to|required)/i,
  /log\s*in\s*(to|required)/i,
  /please\s*(sign|log)\s*in/i,
  /401\s*unauthorized/i,
  /authentication\s*required/i,
  /subscription\s*required/i,
  /premium\s*(content|access)/i,
  /members?\s*only/i,
  /create\s*(an?\s*)?account/i,
  // 中文
  /(?:请先?|需要).*登录/,
  /(?:请先?|需要).*注册/,
  /没有.*(?:权限|访问权)/,
  /(?:权限|访问权).*不足/,
  /(?:会员|VIP).*(?:专享|专属|才能)/,
  /(?:付费|订阅).*(?:内容|才能|后.*查看)/,
];

// ── 登录墙判据 ──────────────────────────────────────────────
// 登录墙 ≠ 反爬封禁：不该升级访问策略、不该重试，应停下来让用户手动登录。
// 判据分「弱信号」（有登录字样，不足以单独定性）与「强信号」（登录表单/路由/门槛文案）。

/** 弱信号：页面出现登录相关字样（仅作上下文，需强信号佐证才判定登录墙）。 */
const LOGIN_KEYWORD_PATTERN =
  /登录|登陆|\blog\s?in\b|\bsign\s?in\b|扫码登录/i;

/**
 * 否定语境：仅作废「同一语义单元」内的门槛命中（FAQ「不需要登录」等）。
 * 不得对整段 main/article 全局短路，否则会吞掉同页其它真实门槛句。
 */
const LOGIN_NEGATION_PATTERNS: ReadonlyArray<RegExp> = [
  /不需要登录/,
  /无需登录/,
  /不用登录/,
  /不必登录/,
  /no(?:\s+need\s+to)?\s*log\s?in/i,
  /login\s+not\s+required/i,
  /without\s+logging\s+in/i,
];

/**
 * 「不支持 / 无法获取」类语境：下载器列表标题常在门槛短语上一行，
 * 豁免须看命中点前一小段上下文，不能只凭「需要登录才能查看的」本身。
 */
const LOGIN_GATE_UNSUPPORTED_CONTEXT_PATTERNS: ReadonlyArray<RegExp> = [
  /不支持/,
  /无法获取/,
  /仅对好友/,
];

/** 命中点前回看长度：覆盖「暂不支持」标题与列表项之间的空行。 */
const LOGIN_GATE_UNSUPPORTED_PREFIX_CHARS = 100;

/**
 * 强信号 · 门槛文案：明确表达「必须登录才能继续/查看」的语义。
 * 覆盖小红书未登录浮层「登录探索更多内容」等真实文案。
 */
const LOGIN_GATING_PATTERNS: ReadonlyArray<RegExp> = [
  /请先?登录/,
  /需要登录(?:后|才)/,
  /登录后.{0,10}(?:查看|继续|解锁|使用|探索|参与|评论|下载)/,
  /登录.{0,6}(?:查看|解锁|继续|探索)/,
  /登录探索/,
  /扫码登录/,
  /please\s*(?:sign|log)\s*in/i,
  /(?:sign|log)\s?in\s?to\s?(?:continue|view|see|read|explore|access)/i,
  /members?\s*only/i,
];

/** 句号 / 分号 / 逗号等：否定与门槛只在同一分句内互相抵消。 */
const LOGIN_GATE_UNIT_SEPARATORS = /[。！？；，、\n.!?;,]/;

function loginGateSemanticUnit(text: string, start: number, end: number): string {
  let left = start;
  while (left > 0 && !LOGIN_GATE_UNIT_SEPARATORS.test(text.charAt(left - 1))) {
    left -= 1;
  }
  let right = end;
  while (right < text.length && !LOGIN_GATE_UNIT_SEPARATORS.test(text.charAt(right))) {
    right += 1;
  }
  return text.slice(left, right);
}

function isLoginGateMatchExempt(text: string, start: number, end: number): boolean {
  const unit = loginGateSemanticUnit(text, start, end);
  if (LOGIN_NEGATION_PATTERNS.some((neg) => neg.test(unit))) return true;
  // 前缀可跨换行，识别「暂不支持」标题下的列表项，避免误伤真门槛句。
  const prefix = text.slice(Math.max(0, start - LOGIN_GATE_UNSUPPORTED_PREFIX_CHARS), start);
  const unsupportedCtx = `${prefix}\n${unit}`;
  return LOGIN_GATE_UNSUPPORTED_CONTEXT_PATTERNS.some((p) => p.test(unsupportedCtx));
}

/**
 * 先定位肯定门槛命中，再判断同句否定或「不支持」语境豁免。
 * 同页「无需登录…」FAQ +「需要登录后才能查看」正文 → 仍为 true。
 */
export function isAffirmativeLoginGateText(text: string): boolean {
  if (!text) return false;
  for (const pattern of LOGIN_GATING_PATTERNS) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const re = new RegExp(pattern.source, flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      if (!isLoginGateMatchExempt(text, match.index, match.index + match[0].length)) {
        return true;
      }
      if (match[0].length === 0) {
        re.lastIndex += 1;
      }
    }
  }
  return false;
}

/** 强信号 · 登录路由 URL（location.pathname）。 */
const LOGIN_PATH_PATTERN =
  /(?:^|\/)(?:login|signin|sign-in|passport|sso|oauth|authorize|account\/login|user\/login|accounts\/login)(?:\/|$)/i;

const NO_BLOCK: EnhancedBlockSignal = { blocked: false, confidence: 0, shouldUpgrade: false };

// ── 页面内一次性采集脚本 ─────────────────────────────────────

/**
 * 构建注入页面的检测脚本。所有维度一次性采集，返回结构化数据。
 * 注意：不使用 console.* 调用（Patchright 环境可能禁用）。
 * 导出仅供单测做语法有效性守护（脚本是字符串，编译期查不出语法错）。
 */
export function buildDetectionScript(cfSelectors: ReadonlyArray<string>): string {
  const selectorsJson = JSON.stringify(cfSelectors);
  const loginNegationPatternsJson = JSON.stringify(
    LOGIN_NEGATION_PATTERNS.map((pattern) => ({ source: pattern.source, flags: pattern.flags })),
  );
  const loginUnsupportedContextPatternsJson = JSON.stringify(
    LOGIN_GATE_UNSUPPORTED_CONTEXT_PATTERNS.map((pattern) => ({
      source: pattern.source,
      flags: pattern.flags,
    })),
  );
  const loginUnsupportedPrefixCharsJson = JSON.stringify(LOGIN_GATE_UNSUPPORTED_PREFIX_CHARS);
  const loginGatingPatternsJson = JSON.stringify(
    LOGIN_GATING_PATTERNS.map((pattern) => ({ source: pattern.source, flags: pattern.flags })),
  );
  const loginModalMinCoverageJson = JSON.stringify(LOGIN_MODAL_MIN_COVERAGE);
  return `(function(){
  var result = {
    title: document.title || '',
    bodyText: '',
    bodyLength: 0,
    httpStatus: 0,
    url: location.href,
    pathname: (location && location.pathname) || '',
    cfSelectorHits: 0,
    hasChallengeIframe: false,
    hasPasswordInput: false,
    hasPhoneLoginInput: false,
    hasVerifyCodeInput: false,
    loginModalCandidates: []
  };

  var body = document.body;
  if (body) {
    var text = body.innerText || '';
    result.bodyLength = text.length;
    result.bodyText = text.length > 2000 ? text.substring(0, 2000) : text;
  }

  try {
    var entries = performance.getEntriesByType('navigation');
    if (entries.length > 0 && entries[0].responseStatus !== undefined) {
      result.httpStatus = entries[0].responseStatus;
    }
  } catch(e) {}

  try {
    var selectors = ${selectorsJson};
    for (var i = 0; i < selectors.length; i++) {
      if (document.querySelector(selectors[i])) {
        result.cfSelectorHits++;
      }
    }
  } catch(e) {}

  try {
    var iframes = document.querySelectorAll('iframe');
    for (var j = 0; j < iframes.length; j++) {
      var src = iframes[j].src || '';
      if (src.indexOf('challenges.cloudflare.com') !== -1) {
        result.hasChallengeIframe = true;
        break;
      }
    }
  } catch(e) {}

  // 登录表单 DOM 信号（只统计可见元素，避免隐藏的注册/找回密码表单误报）。
  function isVisible(el){
    if(!el) return false;
    return !!(el.offsetWidth || el.offsetHeight || (el.getClientRects && el.getClientRects().length));
  }
  function inputLoginSignal(el){
    var type = (el.getAttribute('type') || '').toLowerCase();
    var hint = (
      (el.getAttribute('placeholder') || '') + ' ' +
      (el.getAttribute('name') || '') + ' ' +
      (el.getAttribute('autocomplete') || '') + ' ' +
      (el.getAttribute('aria-label') || '')
    ).toLowerCase();
    return {
      password: type === 'password' || /password|passwd|\u5bc6\u7801/.test(hint),
      phone: type === 'tel' || /phone|mobile|\\btel\\b|\u624b\u673a/.test(hint),
      verify: /verif|captcha|\\botp\\b|sms|\u9a8c\u8bc1\u7801|\u77ed\u4fe1/.test(hint)
    };
  }
  function hasLoginGateText(text){
    if (!text) return false;
    var negations = ${loginNegationPatternsJson};
    var unsupported = ${loginUnsupportedContextPatternsJson};
    var prefixChars = ${loginUnsupportedPrefixCharsJson};
    var patterns = ${loginGatingPatternsJson};
    // 与 Node isAffirmativeLoginGateText 同口径。
    var seps = '\u3002\uff01\uff1f\uff1b\uff0c\u3001' + String.fromCharCode(10) + '.!?;,';
    function unitAround(start, end){
      var left = start;
      while (left > 0 && seps.indexOf(text.charAt(left - 1)) === -1) left--;
      var right = end;
      while (right < text.length && seps.indexOf(text.charAt(right)) === -1) right++;
      return text.slice(left, right);
    }
    function matchExempt(start, end){
      var unit = unitAround(start, end);
      var i;
      for (i = 0; i < negations.length; i++) {
        if (new RegExp(negations[i].source, negations[i].flags).test(unit)) return true;
      }
      var prefixStart = start - prefixChars;
      if (prefixStart < 0) prefixStart = 0;
      var ctx = text.slice(prefixStart, start) + String.fromCharCode(10) + unit;
      for (i = 0; i < unsupported.length; i++) {
        if (new RegExp(unsupported[i].source, unsupported[i].flags).test(ctx)) return true;
      }
      return false;
    }
    for (var p = 0; p < patterns.length; p++) {
      var flags = patterns[p].flags.indexOf('g') !== -1
        ? patterns[p].flags
        : patterns[p].flags + 'g';
      var re = new RegExp(patterns[p].source, flags);
      var m;
      while ((m = re.exec(text)) !== null) {
        if (!matchExempt(m.index, m.index + m[0].length)) return true;
        if (m[0].length === 0) re.lastIndex++;
      }
    }
    return false;
  }
  function shouldExcludeGateTextElement(el){
    var tag = el.tagName;
    var role = (el.getAttribute('role') || '').toLowerCase();
    var identity = (el.id || '') + ' ' + (el.className || '');
    return tag === 'ASIDE' || tag === 'NAV' || tag === 'HEADER' || tag === 'FOOTER'
      || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'DIALOG'
      || role === 'dialog' || el.getAttribute('aria-modal') === 'true'
      || el.getAttribute('aria-hidden') === 'true'
      || /comment|discussion|reply|sidebar|aside|footer|related|recommend/i.test(identity);
  }
  function collectPageGateText(node, parentVisible, parts){
    if (node.nodeType === 3) {
      if (parentVisible) parts.push(node.textContent || '');
      return;
    }
    if (node.nodeType !== 1) return;
    if (shouldExcludeGateTextElement(node)) return;
    var style = window.getComputedStyle(node);
    var visible = parentVisible && style.display !== 'none' && style.visibility !== 'hidden';
    if (!visible) return;
    for (var child = node.firstChild; child; child = child.nextSibling) {
      collectPageGateText(child, visible, parts);
    }
  }
  try {
    var inputs = document.querySelectorAll('input');
    for (var k = 0; k < inputs.length; k++) {
      var el = inputs[k];
      if (!isVisible(el)) continue;
      var sig = inputLoginSignal(el);
      if (sig.password) result.hasPasswordInput = true;
      if (sig.phone) result.hasPhoneLoginInput = true;
      if (sig.verify) result.hasVerifyCodeInput = true;
    }
  } catch(e) {}

  // 登录浮层候选采集——只采事实，是否构成登录墙由 analyzeBlockProbe 纯函数判定。
  // 页头「登录」入口按钮同样会被 [class*="login"] 选中（，36kr 案例），
  // 故对每个「可见 + 文本命中登录语义」的候选记录三类墙特征事实：
  //   dialog（显式对话框语义）/ form（内部可见登录表单要素）/ fixed+coverage（悬浮遮罩）。
  try {
    var vw = window.innerWidth || 0;
    var vh = window.innerHeight || 0;
    var viewportAvailable = vw > 0 && vh > 0;
    var layoutWidth = Math.max(
      vw,
      document.documentElement ? document.documentElement.scrollWidth : 0,
      body ? body.scrollWidth : 0
    );
    var modals = document.querySelectorAll('[role="dialog"],[aria-modal="true"],dialog[open],.modal,[class*="login"],[class*="signin"],[class*="sign-in"],[id*="login"]');
    for (var m = 0; m < modals.length; m++) {
      if (result.loginModalCandidates.length >= 8) break;
      var node = modals[m];
      if (!isVisible(node)) continue;
      var mt = (node.innerText || '').slice(0, 600);
      if (!/\u767b\u5f55|\u767b\u9646|log\\s?in|sign\\s?in|\u626b\u7801|\u8f93\u5165\u624b\u673a\u53f7|\u9a8c\u8bc1\u7801/i.test(mt)) continue;
      var role = (node.getAttribute('role') || '').toLowerCase();
      var isDialogNode = role === 'dialog'
        || node.getAttribute('aria-modal') === 'true'
        || (node.tagName === 'DIALOG' && node.hasAttribute('open'));
      var heading = node.querySelector('h1,h2,h3,h4,[role="heading"]');
      var authIdentity = (
        (node.getAttribute('aria-label') || '') + ' ' +
        (node.getAttribute('title') || '') + ' ' +
        (node.getAttribute('id') || '') + ' ' +
        (node.getAttribute('class') || '') + ' ' +
        (heading ? (heading.innerText || '') : '')
      );
      var containerIdentity = (
        (node.getAttribute('aria-label') || '') + ' ' +
        (node.getAttribute('title') || '') + ' ' +
        (node.getAttribute('id') || '') + ' ' +
        (node.getAttribute('class') || '')
      );
      var hasForm = false;
      var innerInputs = node.querySelectorAll('input');
      for (var q = 0; q < innerInputs.length; q++) {
        var f = innerInputs[q];
        if (!isVisible(f)) continue;
        var fsig = inputLoginSignal(f);
        if (fsig.password || fsig.phone || fsig.verify) { hasForm = true; break; }
      }
      var coverage = 0;
      var horizontalCoverage = 0;
      var areaCoverageAvailable = false;
      var isFixed = false;
      try {
        var rect = node.getBoundingClientRect();
        areaCoverageAvailable = viewportAvailable && rect.width > 0 && rect.height > 0;
        if (areaCoverageAvailable) coverage = (rect.width * rect.height) / (vw * vh);
        if (layoutWidth > 0) horizontalCoverage = rect.width / layoutWidth;
        isFixed = window.getComputedStyle(node).position === 'fixed';
      } catch(e) {}
      var authTitled = /\\u767b\\u5f55|\\u767b\\u9646|log\\s?in|sign\\s?in|\\bauth\\b/i.test(authIdentity);
      var publicLinkCount = 0;
      var candidateLinks = node.querySelectorAll('a[href]');
      for (var a = 0; a < candidateLinks.length; a++) {
        var link = candidateLinks[a];
        if (!isVisible(link)) continue;
        var linkHint = ((link.innerText || '') + ' ' + (link.getAttribute('href') || '')).toLowerCase();
        if (!/login|log-in|signin|sign-in|\\u767b\\u5f55|\\u767b\\u9646/.test(linkHint)) publicLinkCount++;
      }
      // 仅将“非 fixed 的大面积、公开内容丰富的 Dialog”视为行情抽屉、
      // 侧栏等局部功能。认证 Dialog 默认仍是登录墙，避免 OAuth/扫码页
      // 因为带了条款、隐私、帮助链接而被误放行。
      var hasDockSizeEvidence = areaCoverageAvailable
        ? coverage >= ${loginModalMinCoverageJson}
        : horizontalCoverage >= ${loginModalMinCoverageJson};
      var hasPublicContent = isDialogNode && !isFixed
        && hasDockSizeEvidence
        && !authTitled && !hasForm && mt.length >= 240 && publicLinkCount >= 3
        && /\\b(?:dock|drawer|sidebar|navigation)\\b/i.test(containerIdentity);
      result.loginModalCandidates.push({
        dialog: isDialogNode,
        authTitled: authTitled,
        hasPublicContent: hasPublicContent,
        utilityDock: /\\b(?:dock|drawer|sidebar|navigation)\\b/i.test(containerIdentity),
        form: hasForm,
        fixed: isFixed,
        coverage: coverage > 1 ? 1 : Math.round(coverage * 100) / 100,
        viewportAvailable: viewportAvailable,
        areaCoverageAvailable: areaCoverageAvailable,
        horizontalCoverage: horizontalCoverage > 1
          ? 1
          : Math.round(horizontalCoverage * 100) / 100
      });
    }
  } catch(e) {}

  // 页面级门槛文案只从一个优先级最高的主内容根采集。Header、侧栏、
  // Dialog 和评论区等局部模块也可能提示登录，但不能据此阻断仍然公开
  // 可读的主页面。
  try {
    var primary = null;
    var primarySelectors = ['main', 'article', '[role="main"]'];
    for (var r = 0; r < primarySelectors.length && !primary; r++) {
      var roots = document.querySelectorAll(primarySelectors[r]);
      for (var s = 0; s < roots.length; s++) {
        if (primarySelectors[r] === 'article'
          && roots[s].parentElement && roots[s].parentElement.closest('article')) continue;
        if (isVisible(roots[s])) { primary = roots[s]; break; }
      }
    }
    primary = primary || body;
    if (primary) {
      var gateTextParts = [];
      collectPageGateText(primary, true, gateTextParts);
      result.hasPageLevelLoginGate = hasLoginGateText(gateTextParts.join(' '));
    }
  } catch(e) {}

  return result;
})()`;
}

// ── 检测结果中间结构 ─────────────────────────────────────────

/** 登录浮层候选事实（页面脚本采集；是否构成登录墙见 isLoginWallModal）。 */
export interface LoginModalCandidate {
  /** 显式对话框语义（role=dialog / aria-modal="true" / <dialog open>）。 */
  dialog: boolean;
  /** 对话框自身的标题、标识或类名明确表示认证，而不是普通功能面板。 */
  authTitled?: boolean;
  /** 无认证标识/表单但承载公开内容的局部 Dialog（如行情/导航抽屉）。 */
  hasPublicContent?: boolean;
  /** 容器自身以通用 Dock/Drawer/Sidebar/Navigation 语义标识为局部面板。 */
  utilityDock?: boolean;
  /** 内部有可见登录表单要素（密码 / 手机号 / 验证码输入框）。 */
  form: boolean;
  /** fixed 定位（悬浮遮罩特征）。 */
  fixed: boolean;
  /** 占视口面积比例 [0, 1]。 */
  coverage: number;
  /** 页面当前是否有可用于面积计算的非零视口。 */
  viewportAvailable?: boolean;
  /** 候选矩形宽高和页面视口均有效，可可靠计算面积占比。 */
  areaCoverageAvailable?: boolean;
  /** 候选宽度 / 页面布局宽度；候选面积不可可靠计算时用于识别 Dock。 */
  horizontalCoverage?: number;
}

export interface PageProbe {
  title: string;
  bodyText: string;
  bodyLength: number;
  httpStatus: number;
  url: string;
  pathname?: string;
  cfSelectorHits: number;
  hasChallengeIframe: boolean;
  /** 可见的密码输入框（登录/注册表单强信号）。 */
  hasPasswordInput?: boolean;
  /** 可见的手机号登录输入框（手机号 + 验证码登录，如小红书）。 */
  hasPhoneLoginInput?: boolean;
  /** 可见的验证码输入框。 */
  hasVerifyCodeInput?: boolean;
  /** 登录浮层候选（可见 + 文本命中登录语义的对话框 / 登录容器）。 */
  loginModalCandidates?: LoginModalCandidate[];
  /** 主内容中存在“登录后才能继续/查看”的页面级门槛文案。 */
  hasPageLevelLoginGate?: boolean;
}

// ── BlockDetector ────────────────────────────────────────────

export class BlockDetector {
  private contextFactory: ContextFactory | null = null;

  setContextFactory(factory: ContextFactory): void {
    this.contextFactory = factory;
  }

  async detect(tabId: string): Promise<EnhancedBlockSignal> {
    try {
      if (!this.contextFactory) return NO_BLOCK;
      const ctx = this.contextFactory(tabId);
      if (!ctx || !ctx.isAlive()) return NO_BLOCK;

      const probe = await ctx.executeScript<PageProbe>(
        buildDetectionScript(CF_SELECTORS),
      );

      return analyzeBlockProbe(probe);
    } catch {
      return NO_BLOCK;
    }
  }
}

/**
 * 判断页面是否为业务权限页面（而非反爬封禁）。
 * 存在业务认证关键词时，不应触发策略升级。
 */
function isBusinessPermissionPage(combined: string): boolean {
  return BUSINESS_AUTH_PATTERNS.some((p) => p.test(combined));
}

/**
 * Cloudflare 特征检测。
 * 综合 title 关键词 + DOM selector 命中数 + challenge iframe。
 */
function detectCloudflare(
  probe: PageProbe,
  combined: string,
): { confidence: number; reason: string } {
  let cfConfidence = 0;
  let reason = '';

  for (const pat of CF_TITLE_PATTERNS) {
    if (pat.test(probe.title)) {
      cfConfidence += 0.5;
      reason = 'Cloudflare Challenge';
      break;
    }
  }

  if (probe.cfSelectorHits > 0) {
    cfConfidence += Math.min(probe.cfSelectorHits * 0.2, 0.4);
    reason = reason || 'Cloudflare DOM Detected';
  }

  if (probe.hasChallengeIframe) {
    cfConfidence += 0.3;
    reason = reason || 'Cloudflare Challenge Iframe';
  }

  // 通用 cloudflare 关键词作辅助信号
  if (/cloudflare/i.test(combined) && cfConfidence > 0) {
    cfConfidence += 0.1;
  }

  return { confidence: cfConfidence, reason };
}

/** 大面积遮罩判定阈值：fixed 候选至少覆盖 30% 视口才算登录墙遮罩。 */
const LOGIN_MODAL_MIN_COVERAGE = 0.3;

/**
 * 登录浮层候选是否构成登录墙。页头「登录」入口按钮也会进候选（命中
 * [class*="login"] + 文本「登录」， 的 36kr 案例），必须叠加墙特征之一
 * ——内部登录表单要素、fixed 大面积遮罩，或明确不是公开内容抽屉的对话框——
 * 才定性，守住「登录入口 ≠ 登录墙」的边界。
 */
function isLoginWallModal(c: LoginModalCandidate): boolean {
  if (c.form || (c.fixed && c.coverage >= LOGIN_MODAL_MIN_COVERAGE)) return true;
  // 保留“dialog 是强信号”的原有保守策略；只有能明确证明它是承载公开
  // 信息的局部抽屉时才例外，避免无标题的真实认证 Dialog 被放行。
  const areaCoverageAvailable = c.areaCoverageAvailable
    ?? (c.viewportAvailable !== false);
  const hasDockSizeEvidence = areaCoverageAvailable
    ? c.coverage >= LOGIN_MODAL_MIN_COVERAGE
    : (c.horizontalCoverage ?? 0) >= LOGIN_MODAL_MIN_COVERAGE;
  const isPublicDock = c.hasPublicContent === true
    && c.utilityDock === true
    && !c.fixed
    && hasDockSizeEvidence;
  return c.dialog && !isPublicDock;
}

/**
 * 登录墙检测（高精度）——独立于 HTTP 403，覆盖「200 页面 + 登录浮层」。
 *
 * 只有「登录字样（弱信号）」不足以定性（很多页面页头就有「登录」链接）；
 * 必须叠加以下任一**强信号**才判定为登录墙：
 *   - 登录路由 URL（pathname 命中 /login、/passport 等）；
 *   - 具备墙特征的可见登录浮层（对话框语义 / 含登录表单 / fixed 大面积遮罩，见 isLoginWallModal）；
 *   - 明确的门槛文案（「登录探索」「请先登录」「sign in to continue」等）；
 *   - 登录字样 + 可见的密码 / 手机号登录输入框；
 *   - 密码 + 验证码输入框并存（典型登录 / 注册表单）。
 */
function detectAuthWall(probe: PageProbe, combined: string): { detected: boolean; reason: string } {
  const pathIsLogin = !!probe.pathname && LOGIN_PATH_PATTERN.test(probe.pathname);
  if (pathIsLogin) return { detected: true, reason: '页面跳转到登录 / 授权页' };

  if ((probe.loginModalCandidates ?? []).some(isLoginWallModal)) {
    return { detected: true, reason: '页面弹出登录浮层' };
  }

  const hasPageLevelLoginGate = probe.hasPageLevelLoginGate
    ?? isAffirmativeLoginGateText(combined);
  if (hasPageLevelLoginGate) {
    return { detected: true, reason: '内容需要登录后才能查看' };
  }

  const loginText = LOGIN_KEYWORD_PATTERN.test(combined);
  if (loginText && (probe.hasPasswordInput || probe.hasPhoneLoginInput)) {
    return { detected: true, reason: '页面出现登录表单' };
  }

  if (probe.hasPasswordInput && probe.hasVerifyCodeInput) {
    return { detected: true, reason: '页面出现登录 / 注册表单' };
  }

  return { detected: false, reason: '' };
}

/**
 * 多维度分析，返回综合判定（纯函数，便于单测）。
 * 每个维度贡献独立的 confidence 增量，最终 clamp 到 [0, 1]。
 *
 * 注意：BlockDetector 只负责检测事实（被封了吗？什么类型？置信度多少？），
 * "是否应该升级访问策略"的决策权归 AccessStrategyService。
 */
export function analyzeBlockProbe(probe: PageProbe): EnhancedBlockSignal {
  const { title, bodyText, bodyLength, httpStatus } = probe;
  const combined = `${title} ${bodyText}`;

  let confidence = 0;
  let type: BlockType = 'none';
  let reason = '';
  let errorCode: 'blocked' | 'rate_limited' | undefined;

  // ── 维度 1: Cloudflare 特征 ──────────────────────────────
  const cfResult = detectCloudflare(probe, combined);
  if (cfResult.confidence > 0) {
    confidence += cfResult.confidence;
    type = 'cloudflare';
    reason = cfResult.reason;
    errorCode = 'blocked';
  }

  // ── 维度 2: 登录墙检测 ────────────────────────────────────
  // CF 挑战（人机验证）优先于登录墙——先过 CF 才谈登录。非 CF 时登录墙独立定性，
  // 且优先于下方反爬关键词 / HTTP 加权（登录墙是更具体、更可执行的结论）。
  if (type === 'none') {
    const authWall = detectAuthWall(probe, combined);
    if (authWall.detected) {
      return {
        blocked: true,
        reason: authWall.reason,
        // 登录墙不是反爬封禁，error_code 留空（复用 'blocked'/'rate_limited' 会误导上层）。
        type: 'auth_wall',
        confidence: 0.9,
        httpStatus: httpStatus > 0 ? httpStatus : undefined,
        shouldUpgrade: false,
        loginRequired: true,
      };
    }
  }

  // ── 维度 3: 反爬关键词匹配 ───────────────────────────────
  // CF 场景下仍累加 confidence（作辅助信号），但不覆盖 type
  for (const signal of BLOCK_SIGNALS) {
    if (signal.pattern.test(combined)) {
      confidence += type === 'none' ? 0.5 : 0.15;
      if (type === 'none') {
        reason = signal.reason;
        errorCode = signal.code;
        if (signal.code === 'rate_limited') {
          type = 'rate_limit';
        } else if (/ip.*(ban|block|封|禁)/i.test(combined)) {
          type = 'ip_ban';
        }
      }
      break;
    }
  }

  // ── 维度 4: HTTP 状态码加权 ──────────────────────────────
  if (httpStatus > 0) {
    if (httpStatus === 429) {
      confidence += 0.4;
      if (type === 'none') {
        type = 'rate_limit';
        reason = reason || '429 Rate Limited';
        errorCode = 'rate_limited';
      }
    } else if (httpStatus === 403) {
      confidence += 0.3;
      if (type === 'none') {
        reason = reason || '403 Forbidden';
        errorCode = 'blocked';
        if (isBusinessPermissionPage(combined)) {
          type = 'business_403';
        }
      }
    } else if (httpStatus === 503 && type === 'cloudflare') {
      confidence += 0.1;
    } else if (httpStatus === 401 || httpStatus === 404) {
      confidence = Math.max(confidence - 0.3, 0);
    }
  }

  // ── 维度 5: 空白页启发式 ─────────────────────────────────
  if (bodyLength < 50 && httpStatus >= 400 && httpStatus < 600) {
    confidence += 0.2;
    if (!reason) {
      reason = 'Empty error page';
      errorCode = 'blocked';
    }
  }

  // ── 最终 type 判定 ───────────────────────────────────────
  if (type === 'none' && errorCode === 'blocked') {
    if (httpStatus === 403 && isBusinessPermissionPage(combined)) {
      type = 'business_403';
    } else if (/ip.*(ban|block|封|禁)/i.test(combined)) {
      type = 'ip_ban';
    }
  }

  // ── 最终裁定 ─────────────────────────────────────────────
  confidence = Math.min(confidence, 1);
  const blocked = confidence >= 0.3;

  if (!blocked) {
    return NO_BLOCK;
  }

  return {
    blocked: true,
    reason: reason || 'Blocked',
    error_code: errorCode,
    type,
    confidence: Math.round(confidence * 100) / 100,
    httpStatus: httpStatus > 0 ? httpStatus : undefined,
    shouldUpgrade: false, // 由 AccessStrategyService 决定，BlockDetector 不做策略决策
  };
}

let shared: BlockDetector | null = null;

export function getSharedBlockDetector(): BlockDetector {
  if (!shared) shared = new BlockDetector();
  return shared;
}
