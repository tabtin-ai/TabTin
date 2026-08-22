/**
 * AutofillDetector — 在 WebContentsView 的 dom-ready 事件中检测登录表单，
 * 并通过 IPC 通知渲染进程展示密码选择器 Overlay。
 *
 * Wave 3 新增：`PASSWORD_CAPTURE_SCRIPT` 多信号捕获脚本——在用户提交登录
 * 表单时把 (url, username, password) 通过 `window.postMessage` 透出给 preload，
 * preload 转 IPC 给主进程的 `autofill-service.onPasswordSubmitted`。
 *
 * 设计取舍（PRD Story 2 + 反思 7：SPA 密码捕获覆盖率）：
 *   - 三个独立信号最大化覆盖各种登录 UI（form submit / SPA button / 动态 DOM）；
 *   - 任意信号触发都 postMessage，preload 端按 (domain, username) 去重，
 *     避免一次提交触发 2-3 次保存提示；
 *   - **不**捕获密码到主进程内存外的任何地方——postMessage 只在当前 view
 *     的 main world → isolated world，preload 直接转 IPC，不写日志、不
 *     console.log；
 *   - 已知限制：纯 fetch/XHR 登录且不触发 form submit 也不点击 submit-like
 *     button 的 SPA（极少见）会漏，作为已知限制文档化（PRD 风险 7）。
 */

import type { WebContents } from 'electron'
import { getModalWindowManager } from '../overlay/overlay-window-manager'
import { getViewFactory } from '../view-factory'
import { createLogger } from '../logger'

const log = createLogger('AutofillDetector')

const LOGIN_FORM_DETECT_SCRIPT = `
(function() {
  try {
    const pwdInputs = document.querySelectorAll('input[type="password"]');
    if (pwdInputs.length === 0) return null;

    let usernameInput = null;
    for (const pwd of pwdInputs) {
      const form = pwd.closest('form');
      const candidates = form
        ? form.querySelectorAll('input[type="text"], input[type="email"], input[name*="user"], input[name*="login"], input[name*="email"], input[autocomplete="username"]')
        : document.querySelectorAll('input[type="text"], input[type="email"], input[name*="user"], input[name*="login"], input[name*="email"], input[autocomplete="username"]');
      if (candidates.length > 0) {
        usernameInput = candidates[0];
        break;
      }
    }

    return {
      hasPassword: true,
      hasUsername: !!usernameInput,
      passwordCount: pwdInputs.length,
    };
  } catch(e) {
    return null;
  }
})()
`

const FILL_FORM_SCRIPT = `
(function(username, password) {
  function simulateInput(el, value) {
    el.focus();
    el.value = '';
    el.dispatchEvent(new Event('focus', { bubbles: true }));
    // 使用 InputEvent 模拟真实输入
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set;
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const pwdInputs = document.querySelectorAll('input[type="password"]');
  if (pwdInputs.length === 0) return { filled: false };

  const pwdInput = pwdInputs[0];
  const form = pwdInput.closest('form');
  const scope = form || document;

  if (username) {
    const userCandidates = scope.querySelectorAll(
      'input[type="text"], input[type="email"], input[name*="user"], input[name*="login"], input[name*="email"], input[autocomplete="username"]'
    );
    if (userCandidates.length > 0) {
      simulateInput(userCandidates[0], username);
    }
  }

  simulateInput(pwdInput, password);
  return { filled: true };
})
`

export interface FormDetectResult {
  hasPassword: boolean
  hasUsername: boolean
  passwordCount: number
}

export async function detectLoginForm(webContents: WebContents): Promise<FormDetectResult | null> {
  try {
    if (webContents.isDestroyed()) return null
    const result = await webContents.executeJavaScript(LOGIN_FORM_DETECT_SCRIPT, true)
    return result as FormDetectResult | null
  } catch (err: any) {
    // 检测脚本失败（页面跳转中 / context destroyed）视为"无登录表单"降级。
    // 高频路径仅记 debug；错误信息里不含任何用户输入。
    log.debug('detectLoginForm 失败', { name: err?.name })
    return null
  }
}

function extractHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

function doDomainsMatch(a: string, b: string): boolean {
  const la = a.toLowerCase()
  const lb = b.toLowerCase()
  if (la === lb) return true
  return la.endsWith('.' + lb) || lb.endsWith('.' + la)
}

export async function fillLoginForm(
  webContents: WebContents,
  username: string,
  password: string,
  credentialUrl: string
): Promise<boolean> {
  try {
    if (webContents.isDestroyed()) return false

    const currentUrl = webContents.getURL()
    const currentHost = extractHostname(currentUrl)
    const credentialHost = extractHostname(credentialUrl)
    if (!currentHost || !credentialHost || !doDomainsMatch(currentHost, credentialHost)) {
      log.warn('域名不匹配，拒绝填充', { currentHost, credentialHost })
      return false
    }

    const escapedUsername = JSON.stringify(username)
    const escapedPassword = JSON.stringify(password)
    const result = await webContents.executeJavaScript(
      `(${FILL_FORM_SCRIPT})(${escapedUsername}, ${escapedPassword})`,
      true
    )
    return result?.filled === true
  } catch (err: any) {
    // 注入脚本内嵌了明文密码字面量：这里**只记录错误类型**，绝不记录 err 对象
    // 或 err.message（避免脚本源码 / 密码经错误信息外泄）。
    log.warn('fillLoginForm 执行失败', { name: err?.name })
    return false
  }
}

// ════════════════════════════════════════════════════════════════════
// Wave 4 H2：Agent 后台 view 自动 submit 登录表单
// ════════════════════════════════════════════════════════════════════

/**
 * SUBMIT_FORM_SCRIPT — fill 完成后查找登录按钮并自动 click。
 *
 * Wave 4 三视角 Review 自修：选择器健壮性收紧。
 *
 * **三视角 视角 1 P0 发现 1 自修**：
 *   旧实现 candidates 含 ``a[href*="login" i]`` / ``a[href*="signin" i]``——但
 *   anchor 链接基本不会是 form-submit 按钮。真实 site footer/header 常见
 *   "已有账号？立即登录"、"Forgot login?"、"Try a different login method" 等
 *   链接，textContent 命中 'login'/'登入' 关键字 → click 触发 anchor 默认导航
 *   → 跳到另一个登录页 → onViewDomReady 又触发 → 又点一个链接 → ... Agent
 *   在 background tab 反复跳页直到 verifyLoginSuccess 1.5s 还在登录页才退出。
 *   **修复**：candidates 移除 ``a[href*=login|signin]``——只在明确的 button /
 *   [role=button] / input[type=submit] 三类元素中查找。
 *
 * **三视角 视角 1 P0 发现 2 + 视角 3 发现 3 自修**：
 *   旧实现 loginKeywords 把 ``'continue' / 'next' / '下一步' / '继续'`` 与
 *   ``'sign in' / 'log in'`` 同等处理，按 DOM 顺序首个命中 return。
 *   真实场景：登录页通常先展示 OAuth 按钮（"Continue with Google"），再展示
 *   自有账号 form。Agent fill 完密码 → 走第一个文本匹配 → click "Continue
 *   with Google" → 跳 IdP 同意页 → 跨 IdP 串扰（且 cookie 写到 google.com
 *   partition，与 Wave 2b CookieSync 联动可能扩散到所有共享 env 的 Space）。
 *   **修复**：
 *     1. 关键字分两层 — strongKeywords 仅含明确登录词；weakKeywords 仅在
 *        "form 内最后一个 button + form 含密码框"才采纳；
 *     2. OAuth 黑名单：text 含 "with google / with apple / with github / with
 *        microsoft / with facebook / with linkedin / with twitter" 等 OAuth
 *        识别词，**直接跳过该按钮**；
 *     3. 删除 ``'注 册'`` 死代码（带空格永远不命中，注释里说要避免点注册按钮，
 *        但 ``'注 册'`` 自己实际不起作用——意图与实现脱节）；
 *     4. 显式 signupBlacklist：text 含"注册 / 注 册 / sign up / signup /
 *        register / 注册账号"等，跳过该按钮。
 *
 * 选择器优先级（修复后）：
 *   1. **密码框最近的 form 内** ``button[type="submit"]`` → 标准 form 提交按钮
 *   2. **同 form 内** ``input[type="submit"]`` → 老派表单
 *   3. **同 form 内** ``button | [role="button"]`` 文本匹配
 *      strongKeywords 且不在 OAuth/signup 黑名单中
 *   4. **document 范围**重复 1-3
 *   5. **兜底**：weakKeywords 仅在 form 内最后一个 button 且 form 含密码框
 *   6. **最终兜底**：``form.requestSubmit()`` → ``form.submit()``
 *
 * 安全语义（与 fillLoginForm 配套）：
 *   - 不传任何用户输入或密码字符串到脚本里；
 *   - ``executeJavaScript(..., userGesture=true)`` 让 click 携带用户手势标记；
 *   - **永远不抛异常**——任何失败返回 ``{ submitted: false, reason }``；
 *   - **不 click anchor 链接** —— 防 a[href] 默认导航触发跨页跳转死循环。
 *
 * 已知边界：
 *   - 验证码 / reCAPTCHA：脚本会 click 但 captcha 弹出后由 Agent 介入；
 *   - 多步登录 step-1（只输 username）：返回 no-password-input；
 *   - **不点 OAuth 按钮**——Agent 后台 view 不应主动用第三方 IdP 登录（除非
 *     凭据明确指向该 IdP，但目前凭据是 form 表单密码，不是 OAuth token）。
 *   - **Shadow DOM 不穿透**（Wave 4 真·真 Review 视角 3 P2 发现 5 文档化）：
 *     ``document.querySelectorAll('button, [role="button"]')`` 不能进入 closed
 *     shadow root；GitHub 的 `<auto-check>` web component、Stripe Checkout 的
 *     ``<stripe-card>``、新一代 SaaS 控件库（Stencil / LitElement）越来越多用
 *     shadow DOM。这类页面下 SUBMIT_FORM_SCRIPT 会**静默失败**返回
 *     ``no-submit-target``，主进程通过 ``code='submit-failed'`` 通知用户"密码
 *     已填入登录表单但未自动提交，请手动点击登录"。
 *     ``PASSWORD_CAPTURE_SCRIPT`` 同样 ``addEventListener('submit', ...)`` 不
 *     穿越 shadow root 的事件冒泡边界——同一类盲区。
 *     V2 路径（Wave 5+）：实现 ``querySelectorDeep(root, selector)`` 递归扫所
 *     有 ``node.shadowRoot``，事件捕获改成"递归 attachShadow 绑同样监听"的
 *     polyfill 风格（参考 chromium password manager 的 OpenShadowRoot 实现）。
 */
export const SUBMIT_FORM_SCRIPT = `
(function() {
  try {
    var pwdInputs = document.querySelectorAll('input[type="password"]');
    if (pwdInputs.length === 0) {
      return { submitted: false, reason: 'no-password-input' };
    }
    var pwd = null;
    for (var i = 0; i < pwdInputs.length; i++) {
      if (pwdInputs[i].value) { pwd = pwdInputs[i]; break; }
    }
    if (!pwd) pwd = pwdInputs[0];

    var form = pwd.closest('form');

    // Wave 4 修复：分级关键字
    var strongKeywords = [
      '登录', '登入',
      'sign in', 'signin', 'log in', 'login', 'submit', '提交'
    ];
    var weakKeywords = [
      '继续', '下一步', 'continue', 'next'
    ];
    // OAuth 第三方按钮黑名单（命中后跳过）
    var oauthBlacklist = [
      'with google', 'with apple', 'with github',
      'with microsoft', 'with facebook', 'with linkedin',
      'with twitter', 'with x', 'with discord', 'with slack',
      'use google', 'use apple', 'use sso', 'use saml',
      '使用 google', '使用 apple', '使用微信', '使用钉钉',
      '使用 github', '使用 lark', '使用飞书',
      'sign in with', 'log in with', 'continue with'
    ];
    // 注册按钮黑名单
    var signupBlacklist = [
      '注册', 'sign up', 'signup', 'register', 'create account',
      '创建账号', '创建账户', '免费注册'
    ];

    function isOauthButton(text) {
      for (var i = 0; i < oauthBlacklist.length; i++) {
        if (text.indexOf(oauthBlacklist[i]) !== -1) return true;
      }
      return false;
    }
    function isSignupButton(text) {
      for (var i = 0; i < signupBlacklist.length; i++) {
        if (text.indexOf(signupBlacklist[i]) !== -1) return true;
      }
      return false;
    }
    function matchesAny(text, keywords) {
      for (var i = 0; i < keywords.length; i++) {
        if (text.indexOf(keywords[i]) !== -1) return keywords[i];
      }
      return null;
    }
    function getButtonText(b) {
      return ((b.textContent || '') + ' ' + (b.value || '') +
              ' ' + (b.getAttribute('aria-label') || '')).toLowerCase().trim();
    }
    function isVisibleEnabled(b) {
      if (b.disabled) return false;
      var rect = b.getBoundingClientRect && b.getBoundingClientRect();
      if (rect && rect.width === 0 && rect.height === 0) return false;
      return true;
    }

    function findSubmitButton(scope) {
      // 1. 标准 type=submit
      var btn = scope.querySelector('button[type="submit"]') ||
                scope.querySelector('input[type="submit"]');
      if (btn && isVisibleEnabled(btn)) return { btn: btn, via: 'type=submit' };

      // 2. strongKeywords 文本匹配（不点 anchor 链接，避免跨页死循环）
      // Wave 4 视角1#1：删除 a[href*=login|signin]
      var candidates = scope.querySelectorAll('button, [role="button"]');
      for (var i = 0; i < candidates.length; i++) {
        var b = candidates[i];
        if (!isVisibleEnabled(b)) continue;
        var text = getButtonText(b);
        // 黑名单守门：OAuth / 注册按钮跳过
        if (isOauthButton(text)) continue;
        if (isSignupButton(text)) continue;
        var hit = matchesAny(text, strongKeywords);
        if (hit) return { btn: b, via: 'text-strong:' + hit };
      }
      return null;
    }

    function findWeakSubmitButton(formScope) {
      // 仅在 form 内：找出 form 最后一个可见 button，且文本含 weakKeywords，
      // 且不是 OAuth / 注册按钮——这是多步登录"下一步"按钮的安全识别
      if (!formScope) return null;
      var allBtns = formScope.querySelectorAll('button, [role="button"]');
      var visibleBtns = [];
      for (var i = 0; i < allBtns.length; i++) {
        if (isVisibleEnabled(allBtns[i])) visibleBtns.push(allBtns[i]);
      }
      if (visibleBtns.length === 0) return null;
      var last = visibleBtns[visibleBtns.length - 1];
      var text = getButtonText(last);
      if (isOauthButton(text) || isSignupButton(text)) return null;
      var hit = matchesAny(text, weakKeywords);
      if (hit) return { btn: last, via: 'text-weak:' + hit };
      return null;
    }

    // 优先 form 内找 strongKeywords；兜底 document 找
    var found = (form && findSubmitButton(form)) || findSubmitButton(document);
    // 仍找不到 → 用 weakKeywords 仅在 form 内 last button 找一次
    if (!found && form) {
      found = findWeakSubmitButton(form);
    }
    if (found && found.btn) {
      try {
        found.btn.click();
        return { submitted: true, via: found.via };
      } catch (e) {
        // click 失败兜底走 form.submit()
      }
    }

    // 没找到按钮：直接 form.submit()
    if (form) {
      if (typeof form.requestSubmit === 'function') {
        form.requestSubmit();
        return { submitted: true, via: 'form.requestSubmit' };
      }
      try {
        form.submit();
        return { submitted: true, via: 'form.submit' };
      } catch (e) {
        return { submitted: false, reason: 'form.submit threw: ' + String(e) };
      }
    }

    return { submitted: false, reason: 'no-submit-target' };
  } catch (e) {
    return { submitted: false, reason: 'script error: ' + String(e) };
  }
})()
`

/**
 * Agent 后台 view 路径下 fill 完表单后调用，自动 click 登录按钮。
 *
 * 与 ``fillLoginForm`` 的区别：
 *   - fillLoginForm 严格做域名校验后才填值；submit 没有域名概念，调用方
 *     已经保证当前 page 是凭据合法目标域；
 *   - submit 永远不会泄漏任何用户/密码数据——脚本不接收输入。
 *
 * 返回 ``{ submitted, via?, reason? }``：
 *   - submitted=true：成功触发 click / requestSubmit / submit 之一；
 *   - submitted=false：reason 描述原因（no-password-input / no-submit-target / 异常）。
 */
export async function submitLoginForm(
  webContents: WebContents,
): Promise<{ submitted: boolean; via?: string; reason?: string }> {
  try {
    if (webContents.isDestroyed()) {
      return { submitted: false, reason: 'webcontents-destroyed' }
    }
    const result = await webContents.executeJavaScript(SUBMIT_FORM_SCRIPT, true)
    if (!result || typeof result !== 'object') {
      return { submitted: false, reason: 'invalid-script-return' }
    }
    return result as { submitted: boolean; via?: string; reason?: string }
  } catch (err: any) {
    return { submitted: false, reason: 'execute-failed: ' + (err?.message || String(err)) }
  }
}

export function notifyRendererAutofillSuggestion(
  tabId: string,
  credentials: Array<{ id: string; url: string; username: string; masked_password: string }>,
  formInfo: FormDetectResult & { domain: string }
): void {
  // 自动填充建议卡片必须盖在浏览器网页（原生 WebContentsView）之上、且要点选
  // 凭据（可交互），所以跑在 focusable 的 modal 子窗口——发到主
  // renderer 会被网页原生层盖住，用户根本看不见（ 同源问题）。modal 窗口即
  // 使当前 hidden，其 webContents 仍在运行、能收 IPC 并渲染，renderer 收到后再
  // 通过 setModalSourceOpen('autofill-suggest', true) 驱动 show，时序安全。
  const modalMgr = getModalWindowManager()
  // 把提示小窗锚到「浏览器网页视图」的右上角（而非整窗右上角——那会盖到右侧
  // 聊天面板）。取不到视图 bounds 时传 null，退化为整块父内容右上角。
  try {
    const bounds = getViewFactory().getView(tabId)?.getBounds() ?? null
    modalMgr.setCompactAnchor(bounds)
  } catch {
    modalMgr.setCompactAnchor(null)
  }
  const modalContents = modalMgr.getWebContents()
  if (!modalContents || modalContents.isDestroyed()) return
  modalContents.send('credential-vault:autofill-suggest', {
    tabId,
    credentials,
    formInfo,
  })
}

/**
 * 通知 modal 子窗口清掉该 tab 的自动填充建议卡片。
 *
 * 用于用户没在提示上操作、但页面已真实跳转（如手动登录成功导航走）时，避免
 * 卡片残留在角落。renderer 按 tabId 匹配后清空 suggestion，撤出 modal source。
 */
export function clearRendererAutofillSuggestion(tabId: string): void {
  const modalContents = getModalWindowManager().getWebContents()
  if (!modalContents || modalContents.isDestroyed()) return
  modalContents.send('credential-vault:autofill-clear', { tabId })
}

// ════════════════════════════════════════════════════════════════════
// Wave 3 G1：密码捕获脚本（page main world → preload）
// ════════════════════════════════════════════════════════════════════

/**
 * PASSWORD_CAPTURE_SCRIPT — 在 dom-ready 时注入到页面 main world。
 *
 * 三个信号（capture 阶段全局监听天然覆盖动态 DOM，无需 MutationObserver）：
 *  1. **form submit** (capture 阶段)：最高保真度，覆盖标准 form 登录
 *  2. **疑似登录提交元素 click**：覆盖 SPA / 自定义按钮登录。判据从旧版
 *     "href 含 login" 放宽为"祖先链命中登录正向关键词、或标准提交控件，且
 *     未命中注册/忘记/第三方等负向关键词"——覆盖 <a href="javascript:;">、
 *     <div class="login-btn"> 一类非标准登录按钮（京东等站点常见）。
 *  3. **文本输入框内 Enter 键**：覆盖"密码框回车直接登录"（不点任何按钮）。
 *
 * 之所以不需要 MutationObserver（视角 3#2 死代码修复）：三个信号都用
 * `document.addEventListener(..., true)` 在 capture 阶段挂在 document 上，
 * SPA 后续动态新增的密码框/按钮的事件冒泡仍然命中——MutationObserver 只
 * 是冗余开销，已删。
 *
 * 宽进严出：click 信号放宽后可能对非登录点击也上报"候选"密码，但真正入库
 * 还要过 verifyLoginSuccess（登录成功判定）+ 用户手动确认两道闸门，误报仅
 * 表现为"多一次不弹保存条的后台判定"，不会导致乱存密码。
 *
 * 注入幂等：用 `__tabtinPasswordCaptureInstalled` 标记，避免 dom-ready 多次
 * 触发（SPA 路由变化）时挂多套监听。
 *
 * 数据出口：`window.postMessage({__tabtin_password_capture, username, password}, '*')`
 *   - **不传 url 字段**（Wave 3 P0 视角 1#2 投毒修复）：恶意 page 即便伪造
 *     url 也没用——主进程从 sender.getURL() 取真实 URL，永远不信 page 自报的。
 *   - 用 `*` target origin 而非具体 origin —— page 的 origin 在 SPA 切路由
 *     后可能与挂监听时不同；preload 在 isolated world 收到 message event，
 *     `event.source === window` 校验保证不被第三方 iframe postMessage 注入；
 *   - 安全：preload 仅在 `event.source === window` 且 `event.data.__tabtin_password_capture === true`
 *     时转发；密码不进 LLM 上下文、不写主进程日志。
 *
 * 已知限制（PRD 风险 7 文档化，信号 2/3 放宽后收窄）：
 *   - **Shadow DOM 不穿透**：closed shadow root 内的 form / 按钮，submit 与
 *     click 事件不冒泡出边界，三个信号都抓不到（同 SUBMIT_FORM_SCRIPT 盲区）。
 *   - **跨 frame**：脚本只注入 main frame，iframe 内的登录表单抓不到。
 *   - **无 Enter、无点击、非标准控件的纯脚本提交**：既不触发 form submit、
 *     用户也不点任何可识别元素（如纯手势 / 定时自动提交）的极端 SPA 会漏。
 *   这些场景用户可手动在「登录信息」页新建密码，或下次走可识别信号时被覆盖。
 *
 * 安全不变量（务必维护）：
 *   - 注入脚本只运行在 main world，密码留在原页面进程；
 *   - postMessage 只跨 main↔isolated 两个 world（同一进程），不出 webContents；
 *   - preload → main IPC 走 invoke，不持久化任何缓存；
 *   - **永远不传 url 字段，URL 由主进程从 sender.getURL() 兜底**。
 */
export const PASSWORD_CAPTURE_SCRIPT = `
(function() {
  if (window.__tabtinPasswordCaptureInstalled) return;
  window.__tabtinPasswordCaptureInstalled = true;

  // 节流：300ms 内同一 (username, password) 只发一次，避免 form submit
  // 同时触发 click 和 submit 信号导致重复。
  // 注意：节流 key **不含 password**（密码不进 closure），用 username + 密
  // 码长度 + 时间戳近似，再依靠 main 进程 pendingSavePasswords 兜底去重。
  var lastSent = { key: '', at: 0 };
  function sendCapture(username, password) {
    if (!password) return;
    var key = (username || '') + '|' + password.length;
    var now = Date.now();
    if (key === lastSent.key && now - lastSent.at < 300) return;
    lastSent = { key: key, at: now };
    try {
      // **不传 url 字段**（Wave 3 P0 视角 1#2）—— 主进程从 sender.getURL() 取
      window.postMessage({
        __tabtin_password_capture: true,
        username: username || '',
        password: password
      }, '*');
    } catch (e) {
      // postMessage 极少失败；万一失败静默处理（密码留页面）
    }
  }

  // Wave 3 三视角 Review 视角 2 P1 发现 1 自修：
  //
  // **不应该 capture** 的密码框：
  //   - autocomplete="new-password" / "current-password"... 这种 web 标准
  //     语义里，"new-password" 表示用户正在**设置新密码**（注册 / 改密码
  //     / 重置密码）。直接当登录密码存进凭据库，会让"改密码场景下旧密码被
  //     update 路径误覆盖成新密码 → 下次自动填充用错误密码登录失败"——这
  //     是数据破坏级 bug。
  //   - autocomplete="cc-csc"（信用卡 CVV）即便 type=password 也不该被当
  //     登录密码——用户输 3-4 位 CVV 提交支付，会弹"保存 example.com 的
  //     密码"。误存的 CVV 替换真实密码，伤害已有凭据。
  //
  // 改密码场景的特殊性：现代规范常见 currentPassword + newPassword 双框
  // 共存。current-password autocomplete 标记的是用户已知的密码，本来可以
  // capture——但**和 new-password 共存的情景下** capture 会让用户疑惑
  // "我刚改密码为什么弹保存"，所以保守只在"无 new-password 框"的情况下
  // 才 capture current-password 框。
  //
  // 启发式优先级：
  //   1. 表单内若存在任何 type=password 且 autocomplete='new-password' 框
  //      → **整张表单视为修改密码 / 注册表单**，不 capture（用户可在
  //      Wave 5 设置页手动添加）
  //   2. 单个密码框 autocomplete='cc-csc' 或 'one-time-code'（OTP）→ 跳过
  //   3. 其余情况按原逻辑 capture
  function isSettingNewPassword(form) {
    if (!form || !form.querySelectorAll) return false;
    var pwdInputs = form.querySelectorAll('input[type="password"]');
    for (var i = 0; i < pwdInputs.length; i++) {
      var ac = (pwdInputs[i].getAttribute('autocomplete') || '').toLowerCase();
      if (ac === 'new-password') return true;
    }
    return false;
  }
  function isCvvOrOtp(input) {
    if (!input) return false;
    var ac = (input.getAttribute('autocomplete') || '').toLowerCase();
    if (ac === 'cc-csc' || ac === 'one-time-code') return true;
    // CVV 启发式：3-4 位 numeric，且 inputmode/numeric type
    var maxLen = parseInt(input.getAttribute('maxlength') || '0', 10);
    if (maxLen > 0 && maxLen <= 4) {
      var inputmode = (input.getAttribute('inputmode') || '').toLowerCase();
      if (inputmode === 'numeric') return true;
    }
    return false;
  }

  // 在指定作用域（form 或 document）找用户名输入。
  // 优先级：autocomplete=username > 显式 type/name > email/text 兜底
  function findUsernameInput(scope) {
    var sels = [
      'input[autocomplete="username"]',
      'input[autocomplete="email"]',
      'input[type="email"]',
      'input[name*="user" i]',
      'input[name*="email" i]',
      'input[name*="login" i]',
      'input[id*="user" i]',
      'input[id*="email" i]',
      'input[type="text"]'
    ];
    for (var i = 0; i < sels.length; i++) {
      var nodes = scope.querySelectorAll(sels[i]);
      for (var j = 0; j < nodes.length; j++) {
        var el = nodes[j];
        if (el && el.value) return el;
      }
      // 没值的也用第一个匹配作为兜底（场景：只有 password 的 step-2 页面）
      if (nodes.length > 0) return nodes[0];
    }
    return null;
  }

  // 在 password 框附近找 username。回溯 form → 兜底全文档。
  function findUsernameNear(pwdInput) {
    var form = pwdInput.closest && pwdInput.closest('form');
    if (form) {
      var u = findUsernameInput(form);
      if (u) return u;
    }
    return findUsernameInput(document);
  }

  // 判断页面是否存在"已填值的密码框"——click / keydown 信号的廉价前置闸门，
  // 大多数点击/按键时密码框为空，直接短路返回，避免每次都跑关键词匹配。
  function hasFilledPassword() {
    var pwds = document.querySelectorAll('input[type="password"]');
    for (var i = 0; i < pwds.length; i++) {
      if (pwds[i].value) return true;
    }
    return false;
  }

  // 从所有"已填、非注册/改密码/CVV/OTP"的密码框里抓一条上报。
  // 三个信号（submit / click / keydown）共用同一条落库逻辑。
  function captureFromFilledPasswords() {
    // 页面/表单整体是注册·改密码场景 → 不抓（避免误存新密码覆盖旧凭据）
    if (isSettingNewPassword(document)) return;
    var pwds = document.querySelectorAll('input[type="password"]');
    for (var i = 0; i < pwds.length; i++) {
      var p = pwds[i];
      if (!p.value) continue;
      if (isCvvOrOtp(p)) continue;
      var f = p.closest && p.closest('form');
      if (f && isSettingNewPassword(f)) continue;
      var u = findUsernameNear(p);
      sendCapture(u && u.value, p.value);
      // 一条足够——多密码框（注册 confirm）由 verifyLoginSuccess 后置过滤
      break;
    }
  }

  // 登录提交类关键词（正向）。
  var SUBMIT_POSITIVE_KW = [
    '登录', '登 录', '登陆', '登入', '立即登录', '马上登录',
    'sign in', 'signin', 'log in', 'login', 'submit', '提交'
  ];
  // 明确"不是登录提交"的关键词（负向，命中即否决）——避免点"忘记密码 /
  // 立即注册 / 短信登录 / 微信登录 / 切换方式"被当成登录提交而误抓。
  var SUBMIT_NEGATIVE_KW = [
    '注册', '注 册', 'sign up', 'signup', 'register', '创建账',
    '忘记', '找回', 'forgot', 'reset', '重置',
    '切换', '换一种', '换个', '其他方式', '其它方式',
    '短信', '验证码登录', '扫码', '二维码', '微信', 'qq', '支付宝'
  ];
  function hitAnyKeyword(hay, kws) {
    for (var i = 0; i < kws.length; i++) {
      if (hay.indexOf(kws[i]) !== -1) return true;
    }
    return false;
  }

  // 判断一次点击是否"疑似登录提交"。
  //
  // 从点击目标向上遍历 6 层祖先（覆盖 <a><b>登录</b></a> 一类嵌套按钮）：
  //   - 命中负向关键词（注册/忘记/第三方登录）→ 立即否决；
  //   - 命中正向关键词（登录/login/submit）→ 命中；
  //   - 标准提交控件（<button> 非 reset、input[type=submit|button]）兜底命中。
  //
  // 之所以放宽到 <a href="javascript:;"> / <div class="login-btn"> 这类非标准
  // 登录按钮（京东等站点常见，href 不含 login、也不是 button）：capture 只是
  // "候选"，真正入库还要过 verifyLoginSuccess（登录成功判定）+ 用户手动确认
  // 两道闸门——宽进严出，放宽捕获不会导致乱存密码。
  function isSubmitLikeTarget(target) {
    var node = target;
    for (var depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      var tag = node.tagName;
      if (!tag) continue;
      var aria = (node.getAttribute && node.getAttribute('aria-label')) || '';
      var hay = (
        (node.textContent || '').slice(0, 40) + ' ' +
        (node.id || '') + ' ' +
        (typeof node.className === 'string' ? node.className : '') + ' ' +
        aria + ' ' +
        (node.value || '')
      ).toLowerCase();
      if (hitAnyKeyword(hay, SUBMIT_NEGATIVE_KW)) return false;
      if (hitAnyKeyword(hay, SUBMIT_POSITIVE_KW)) return true;
      var type = ((node.getAttribute && node.getAttribute('type')) || '').toLowerCase();
      if (tag === 'BUTTON' && type !== 'reset') return true;
      if (tag === 'INPUT' && (type === 'submit' || type === 'button')) return true;
    }
    return false;
  }

  // 信号 1：form submit (capture 阶段) ——
  // 用 capture=true 抢在页面自定义 onsubmit 之前，即使页面 preventDefault
  // 也能拿到密码。
  document.addEventListener('submit', function(e) {
    var form = e.target;
    if (!form || !form.querySelectorAll) return;
    // Wave 3 三视角 Review 视角 2 P1 发现 1 自修：注册/改密码表单跳过
    if (isSettingNewPassword(form)) return;
    var pwd = form.querySelector('input[type="password"]');
    if (!pwd || !pwd.value) return;
    // CVV / OTP 跳过
    if (isCvvOrOtp(pwd)) return;
    var user = findUsernameInput(form);
    sendCapture(user && user.value, pwd.value);
  }, true);

  // 信号 2：点击"疑似登录提交"元素时密码框已填值 ——
  // 覆盖 SPA / 自定义按钮登录（<a href="javascript:;">、<div class="login-btn">
  // 等非标准登录按钮，form 也不 submit）。capture 阶段挂 document，SPA 后续
  // 动态新增的按钮事件冒泡仍然命中——无需 MutationObserver。
  document.addEventListener('click', function(e) {
    if (!hasFilledPassword()) return;
    if (!isSubmitLikeTarget(e.target)) return;
    captureFromFilledPasswords();
  }, true);

  // 信号 3：在文本类输入框内按 Enter 提交 ——
  // 很多登录页支持"密码框回车直接登录"，不点任何按钮，click 信号覆盖不到。
  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Enter' && e.keyCode !== 13) return;
    var t = e.target;
    if (!t || t.tagName !== 'INPUT') return;
    var ty = ((t.getAttribute && t.getAttribute('type')) || '').toLowerCase();
    // 只在文本类输入框回车才算提交意图（排除 checkbox / radio / button 等）
    if (ty && ty !== 'password' && ty !== 'text' && ty !== 'email' && ty !== 'tel' && ty !== 'number') return;
    if (!hasFilledPassword()) return;
    captureFromFilledPasswords();
  }, true);
})();
`

/**
 * 在 dom-ready 时注入密码捕获脚本到指定 webContents。
 *
 * 用 `executeJavaScript(..., true)` 即"用户手势"标记，确保某些受限 API
 * 可调用；脚本本身幂等（`__tabtinPasswordCaptureInstalled`），多次注入安全。
 */
export async function installPasswordCaptureScript(webContents: WebContents): Promise<void> {
  try {
    if (webContents.isDestroyed()) return
    await webContents.executeJavaScript(PASSWORD_CAPTURE_SCRIPT, true)
  } catch (err: any) {
    // Wave 3 三视角 Review 视角 3 P2 发现 5 自修：
    //   B1 修复让每次 dom-ready 都注入。OAuth 多跳 / 快速 navigate 场景下
    //   前一次 executeJavaScript 的 promise 在 navigate 时被 reject——这
    //   是**正常并发**而不是"注入失败"。旧实现把所有错误都 console.warn
    //   会刷屏，污染日志卫生。这里区分：
    //     - navigation 类异常（aborted / context destroyed / disposed
    //       / navigated / frame was）→ 静默
    //     - 真正的注入错误（chrome:// 拒绝 / 语法错误）→ 仍 warn
    const msg = String(err?.message ?? err ?? '')
    if (/aborted|destroyed|navigated|frame was|disposed/i.test(msg)) return
    log.warn('PASSWORD_CAPTURE_SCRIPT 注入失败:', err?.message)
  }
}
