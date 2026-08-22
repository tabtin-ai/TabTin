/**
 * tabtin/prefer-scoped-activity-effects
 *
 * 引导开发者把 React effect 内的"持续型副作用"换成 `useScoped*` 包装 hook，
 * 避免在 hot-Space 子树里写出 zombie effect（Space 隐藏后副作用仍在跑）。
 *
 * ## 背景
 *
 * TabTin 的多 Space 协作模型要求 hot Space "切走但仍挂载"——切回零延迟、零闪烁。
 * 但「挂载着」不等于「应该跑所有 effect」：
 *
 *   - 后台 Space 的 UI 渲染相关 effect（ResizeObserver 测量、scroll 跟随、
 *     window/document 全局事件）应该自动暂停，节省 CPU 同时避免幽灵副作用面
 *   - 业务订阅（IPC 推送、Run 心跳）应该按需保活
 *
 * React 19.2 的 `<Activity>` 兜住了"hidden 时整个子树 cleanup"的默认安全；
 * `apps/tabtin-electron/src/renderer/src/hooks/spaceActivity/` 提供 6 个
 * `useScoped*` 包装 hook，让你按 `scope: 'foreground' | 'hot'` 显式表达
 * "前台才跑 / hot 也跑"的业务意图。
 *
 * 详见 `apps/tabtin-electron/src/renderer/src/hooks/spaceActivity/README.md`。
 *
 * ## 这条规则做什么
 *
 * 在 `useEffect` / `useLayoutEffect` / `useInsertionEffect` 回调内，识别下列
 * **"持续型 + 容易遗漏 cleanup / 无 Activity 感知"** 的裸用 API，给出 `warn`
 * 级提示，引导走 `useScoped*` 替代。
 *
 *   1) `window.addEventListener(...)` / `document.addEventListener(...)` /
 *      `globalThis.addEventListener(...)` / `self.addEventListener(...)`
 *      → `useScopedEventListener(window/document, ...)`
 *   2) `setInterval(...)`
 *      → `useScopedInterval(...)`
 *   3) `new ResizeObserver(...)` → `useScopedResizeObserver(target, ...)`
 *   4) `new MutationObserver(...)` / `new IntersectionObserver(...)`
 *      → 当前没有专属包装 hook（产品决策：业务调用方少 < 3 处），用
 *      `useScopedEffect(() => { const o = new ...; ...; return () => o.disconnect() }, deps)`
 *
 * 此外本规则还二阶校验下列**注释级反模式**：
 *
 *   5) `// eslint-disable-next-line tabtin/prefer-scoped-activity-effects` 出口
 *      没带 `-- 非空理由` —— 报 `disableMissingReason`。强制每次 disable
 *      都留下"为什么这里不走 useScoped\*"的人话给后续 reviewer。
 *
 * ## 这条规则**不**做什么（设计上的让步）
 *
 * - `target.addEventListener(...)` 中 `target` 不是 window/document/globalThis/self
 *   （譬如 ref 拿到的 DOM element）→ **不报告**。这种用法在 element 离开
 *   DOM 时自然回收，不会形成全局泄漏；强制走包装会引入大量误报。
 * - 模块级（不在 useEffect 回调内）→ **不报告**。模块单例的 IPC 注册、
 *   chokidar watcher 等不属本规则范围。
 * - `setTimeout(...)` 一次性短延时 → **不报告**。`useScopedTimeout` 主要
 *   解决 65s 兜底之类的"持续型"超时；瞬时 setTimeout 用原生即可。
 *   （想强制可用 `useScopedTimeout`，但本规则不强求——避免过度噪声。）
 * - `requestAnimationFrame(...)` 自递归循环 → **不报告**（已知漏点，登记
 *   遗留 Wave 6 同款 API 扩展）。仓库内有真实样本：
 *   `apps/tabtin-electron/src/renderer/src/hooks/useFrameTimeTracker.ts`。
 * - cleanup return 内的 `removeEventListener` / `clearInterval` →
 *   不属本规则关心的"创建副作用"模式。
 * - 测试文件（`*.test.ts(x)` / `__tests__/`）→ **不报告**。测试常需在
 *   setup/teardown 内显式 mock window 行为。
 * - `apps/tabtin-electron/src/renderer/src/hooks/spaceActivity/` 自身
 *   （`useScoped*` 实现本身就是裸包装 setInterval / addEventListener 的地方）→
 *   **不报告**。
 * - **Custom hook 包装 useEffect 的调用方**：`function useFoo(fn) { useEffect(fn, []) }`
 *   的调用方 `useFoo(() => { window.addEventListener(...) })` —— 规则不跨
 *   custom hook 边界追踪，调用方**不报告**。Hook 实现内部仍照常报告。
 *   靠 PR review 兜底。
 *
 * ## 严格度
 *
 * 当前为 `warn`（不阻塞 build）。理由：
 *   - 全仓裸用密度高（hot-Space 子树外尤甚），一上来 `error` 会让千行
 *     新增 warning 同时变 error，直接 break baseline。
 *   - 治理是分级的——本 Wave 只引入信号，迁移由后续 Wave 配合 codemod 推进。
 *   - 合理例外（譬如组件本身就是"全局 hotkey 注册器"）走
 *     `// eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- 理由`
 *     标注，比 error 更尊重作者判断（且 disableMissingReason 二阶校验
 *     强制理由非空，避免裸 disable）。
 *
 * 未来收紧路径（依赖未来 Wave 6+ 完成 hot-Space 子树清零迁移）：
 *   `components/{chat, context-space, crawl, crawlspace-workspace}` +
 *   `layout/SpaceWorkbenchHost*` / `SpaceChatRailHost*` 升 `error`，
 *   其他范围保持 `warn`。
 *
 * ## 局限（已知漏点，登记 Wave 6+ 治理）
 *
 * - **跨函数边界不追踪**：开发者把 addEventListener 提取到组件外的 helper
 *   函数，再在 useEffect 里调用——本规则看不到。属 lint 工具的固有局限。
 * - **不追踪赋值别名**：`const addL = window.addEventListener; addL(...)` 不报。
 *   罕见反模式。
 * - **rAF 自递归循环**：`useFrameTimeTracker.ts` 是真实样本，规则当前不报告。
 *   未来扩展时识别 `requestAnimationFrame(<sameNamedFn>)` 自递归模式。
 * - **长连接 API**（BroadcastChannel / WebSocket / EventSource）：仓库内
 *   当前 0 处使用，未来出现时同步扩规则。
 * - **块级 disable**（整文件 `eslint-disable` 块级注释形式）：ESLint 把
 *   整个文件的本规则全部静默（包括 Program:exit 上的 disableMissingReason
 *   上报）——所以"整文件 disable + 不写理由"的反模式**规则自身无法捕获**，
 *   靠 PR review 兜底。罕见，仓库内当前 0 处。
 */

const EFFECT_HOOK_NAMES = new Set([
  'useEffect',
  'useLayoutEffect',
  'useInsertionEffect',
])

const GLOBAL_EVENT_TARGETS = new Set(['window', 'document', 'globalThis', 'self'])

const OBSERVER_CTOR_NAMES = new Set([
  'ResizeObserver',
  'MutationObserver',
  'IntersectionObserver',
])

/** 本规则的"短名"——用于在 disable 注释里识别本规则，对前缀不敏感。
 *  生产配置为 `tabtin/prefer-scoped-activity-effects`，但 RuleTester 会
 *  改成 `rule-to-test/prefer-scoped-activity-effects` 等其他前缀。 */
const RULE_SHORT_NAME = 'prefer-scoped-activity-effects'

/** 测试文件 / wrapper 自身豁免 */
function isExemptFile(filename) {
  if (!filename) return false
  if (/\.test\.[jt]sx?$/.test(filename)) return true
  if (/[/\\]__tests__[/\\]/.test(filename)) return true
  // useScoped* 实现本身在 hooks/spaceActivity/ —— 它就是包装裸 API 的地方
  if (/[/\\]hooks[/\\]spaceActivity[/\\]/.test(filename)) return true
  return false
}

/** 判断 CallExpression 是否为 React effect hook 调用 */
function isEffectHookCall(node) {
  if (!node || node.type !== 'CallExpression') return false
  const callee = node.callee
  if (callee.type === 'Identifier' && EFFECT_HOOK_NAMES.has(callee.name)) {
    return true
  }
  // import * as React from 'react'; React.useEffect(...)
  if (
    callee.type === 'MemberExpression' &&
    callee.property.type === 'Identifier' &&
    EFFECT_HOOK_NAMES.has(callee.property.name)
  ) {
    return true
  }
  return false
}

/**
 * 沿 AST parent 链向上找：当前节点是否处于 useEffect/useLayoutEffect/
 * useInsertionEffect 的第一个参数（callback）函数体内。
 *
 * 算法：从 node 向上走，每碰到一个 function（Arrow/Function/FunctionDecl）
 * 就检查它是否为 effect-hook 的第一参——是则命中。**继续向上一直走到顶层**，
 * 这样可以正确处理 effect callback 内的嵌套 inner function（譬如
 * `useEffect(() => { setTimeout(() => { window.addEventListener(...) }, 100) })`
 * 中 inner setTimeout 的 callback 内部也算"在 effect 链路上"——这种异步嵌套
 * 反而更危险，命中是好事）。
 *
 * 漏报：如果 node 在一个被 export 出去的 helper 函数内，规则看不到调用方
 * 是否在 useEffect 内——这是跨函数边界 lint 的固有局限。
 */
function isInsideEffectCallback(node) {
  let cur = node.parent
  while (cur) {
    if (
      cur.type === 'ArrowFunctionExpression' ||
      cur.type === 'FunctionExpression' ||
      cur.type === 'FunctionDeclaration'
    ) {
      const parent = cur.parent
      if (
        parent &&
        parent.type === 'CallExpression' &&
        parent.arguments[0] === cur &&
        isEffectHookCall(parent)
      ) {
        return true
      }
    }
    cur = cur.parent
  }
  return false
}

/**
 * 解析单条 ESLint disable 注释里的规则名集合 + reason 段。
 *
 * 形态：
 *   - `// eslint-disable-next-line tabtin/foo`
 *   - `// eslint-disable-next-line tabtin/foo, react/bar -- 理由`
 *   - `/* eslint-disable-next-line tabtin/foo -- 理由 *\/`
 *   - `// eslint-disable-line tabtin/foo`
 *   - `/* eslint-disable tabtin/foo *\/`（块级 disable）
 *
 * 返回：`{ rules: Set<string>, reason: string | null }`，或 `null`（不是
 * disable 注释）。
 */
function parseDisableComment(commentValue) {
  const trimmed = commentValue.trim()
  const m = /^eslint-disable(?:-next-line|-line)?\s*(.*)$/.exec(trimmed)
  if (!m) return null
  const rest = m[1] // "tabtin/foo, react/bar -- 理由"
  // 切分 rules 和 reason：约定 ESLint 用 `--` 作为 reason 分隔符
  const dashIdx = rest.indexOf('--')
  let rulesPart, reasonPart
  if (dashIdx >= 0) {
    rulesPart = rest.slice(0, dashIdx)
    reasonPart = rest.slice(dashIdx + 2).trim()
  } else {
    rulesPart = rest
    reasonPart = null
  }
  const rules = new Set(
    rulesPart
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  return { rules, reason: reasonPart && reasonPart.length > 0 ? reasonPart : null }
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        '在 React effect 内引导走 useScoped* 包装 hook（避免 hot-Space 子树的 zombie effect）',
      url: 'https://github.com/TabTin/TabTinAgent/blob/main/eslint-rules/README.md#tabtinprefer-scoped-activity-effects',
    },
    schema: [],
    messages: {
      // ─── 主报告：在 useEffect 内裸用 ─────────────────────────────────────
      windowEventListener:
        '`{{global}}.addEventListener` 在 useEffect 内裸用 → hot-Space 切走时不会按业务语义启停。改用 `useScopedEventListener({{global}}, type, listener, { scope: \'foreground\' | \'hot\' })`（`hooks/spaceActivity/`）。App 级全局监听器加 `// eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- 理由`。详见 `apps/tabtin-electron/src/renderer/src/hooks/spaceActivity/README.md`。',
      setInterval:
        '`setInterval` 在 useEffect 内裸用 → hot-Space 切走时仍滴答。改用 `useScopedInterval(callback, delayMs, { scope: \'foreground\' | \'hot\' })`（`hooks/spaceActivity/`）：UI 刷新型选 `foreground`、Run 心跳/IPC 重试选 `hot`。App 级单例改 module-level、或加 `// eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- 理由`。详见 `apps/tabtin-electron/src/renderer/src/hooks/spaceActivity/README.md`。',
      observerCtor:
        '`new {{ctor}}` 在 useEffect 内裸用 → hot-Space 切走时仍观察。{{ctor}} 多用于 layout 测量 / 可见性追踪，后台 Space 一般不必跑——改用 `useScopedResizeObserver(target, callback)` 或裹一层 `useScopedEffect(() => { const o = new {{ctor}}(...); o.observe(target); return () => o.disconnect() }, deps)`（默认 `scope: \'foreground\'`）。详见 `apps/tabtin-electron/src/renderer/src/hooks/spaceActivity/README.md`。',

      // ─── 二阶报告：disable 注释缺理由 ───────────────────────────────────
      disableMissingReason:
        '`// eslint-disable-next-line tabtin/prefer-scoped-activity-effects` 缺 `-- <理由>`。每次 disable 必须留下"为什么这里不走 useScoped*"的人话（譬如 `-- App 级 hotkey 注册器`）——给 PR reviewer 和未来维护者。改写：`// eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- 理由`。详见 `eslint-rules/README.md#tabtinprefer-scoped-activity-effects` 出口章节。',
    },
  },

  create(context) {
    const filename = context.filename || context.getFilename()
    if (isExemptFile(filename)) return {}

    const sourceCode = context.sourceCode || context.getSourceCode()

    return {
      CallExpression(node) {
        const callee = node.callee

        // window.addEventListener / document.addEventListener / globalThis.* / self.*
        if (
          callee.type === 'MemberExpression' &&
          callee.property.type === 'Identifier' &&
          callee.property.name === 'addEventListener' &&
          callee.object.type === 'Identifier' &&
          GLOBAL_EVENT_TARGETS.has(callee.object.name)
        ) {
          if (isInsideEffectCallback(node)) {
            context.report({
              node,
              messageId: 'windowEventListener',
              data: { global: callee.object.name },
            })
          }
          return
        }

        // setInterval(...)
        if (
          callee.type === 'Identifier' &&
          callee.name === 'setInterval'
        ) {
          if (isInsideEffectCallback(node)) {
            context.report({ node, messageId: 'setInterval' })
          }
          return
        }
      },

      NewExpression(node) {
        const callee = node.callee
        if (callee.type !== 'Identifier') return
        if (!OBSERVER_CTOR_NAMES.has(callee.name)) return
        if (!isInsideEffectCallback(node)) return

        context.report({
          node,
          messageId: 'observerCtor',
          data: { ctor: callee.name },
        })
      },

      // 二阶校验：扫描所有 disable 注释里 prefer-scoped-activity-effects 出口
      // 必须带 `-- 非空理由`。比对时按"短名"识别（不要求带 plugin 前缀）——
      // 这样 `tabtin/prefer-...`、`rule-to-test/prefer-...`（RuleTester）
      // 和裸 `prefer-...` 都能命中。
      'Program:exit'() {
        const comments = sourceCode.getAllComments()
        for (const c of comments) {
          const parsed = parseDisableComment(c.value)
          if (!parsed) continue
          const matchesThisRule = [...parsed.rules].some((name) => {
            const shortName = name.includes('/') ? name.split('/').pop() : name
            return shortName === RULE_SHORT_NAME
          })
          if (!matchesThisRule) continue
          if (parsed.reason !== null) continue
          context.report({
            node: c,
            loc: c.loc,
            messageId: 'disableMissingReason',
          })
        }
      },
    }
  },
}

export default rule
