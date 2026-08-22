/**
 * tabtin/no-direct-fetch-in-renderer
 *
 * 禁止 renderer 端直接 `fetch(...)` 拼后端 API URL。所有 HTTP 请求必须走主进程
 * 代理（统一 token 注入 / 401 自动刷新 / 错误封装 / 未来 trace_id 透传等）。
 *
 * 触发模式（违例）：
 *   1) 直接调 helper：`fetch(joinApiPath(API_CONFIG.baseURL, '/some/path'), ...)`
 *   2) 模板字符串：`fetch(\`${API_CONFIG.baseURL}/some/path\`, ...)`
 *   3) 函数式 API base：`fetch(\`${apiBaseUrl()}/some/path\`, ...)`
 *   4) 命名空间 helper：`fetch(cfg.joinApiPath(...))`
 *   5) `globalThis.fetch` / `window.fetch` / `self.fetch` 同样命中
 *   6) 解构重命名变量绕过（一层追溯）：
 *        `const { chatApiBaseUrl: _x } = getApiRuntimeConfig()`
 *        `await fetch(\`${_x}/foo\`)`  ← 命中
 *   7) 模块级常量绕过（一层追溯）：
 *        `const BILLING_BASE = joinApiPath(API_CONFIG.baseURL, '/services/billing')`
 *        `const url = \`${BILLING_BASE}/x\`; await fetch(url)`  ← 命中
 *
 * 合法替代：
 *   - 推荐：`apiService.request<T>({ url, method, ... })` —— 全功能，含 token + 401 重试 + 错误封装
 *   - `apiRequest<T>({ url, method, ... })` —— 通过 TableApiPort 适配器
 *   - `electronFetch(url, init)` —— 透明的 fetch 桥接（支持 FormData / Blob 下载等所有 Fetch API 形态）
 *
 * 该规则在 renderer 进程（`apps/tabtin-electron/src/renderer/src/**`）以及跑在
 * renderer 环境的数据包（`packages/table-core/src/**`， 扩入）范围内生效（由
 * eslint.config.mjs 的 `files` glob 控制）。注意：跑在 Node / daemon 环境的包
 * （agent-runtime / action-tools 等）不在此范围 —— 它们的 fetch 不经 Chromium、
 * 不受 CORS 约束，强行收口反而引入无谓的 IPC 依赖。
 * services/api.ts 等"统一客户端"实现自身可以裸 fetch（其实它已经不裸 fetch 了，
 * 走 IPC），属本规则的"白名单文件"，名单见下。
 *
 * 局限：变量源追踪只走一层。如果通过两层别名绕过（譬如 const a = joinApiPath(...);
 * const b = a; await fetch(\`${b}/x\`)），现规则拦不到——但这种写法本身就违反代码评审常识，
 * 留给 PR review / type-aware lint（W4 codegen 引入）一并治理。
 */

/** 标记为"统一 HTTP 客户端实现自身"的文件，允许 import 但本身不在 renderer */
const ALLOWED_FILES = new Set([
  // 这些是 renderer 侧"被允许 fetch 的封装本身"。当前没有；如需加请显式列。
])

/**
 * API base URL 标识符——renderer 侧任何对这些标识符的引用配 fetch 都视为违例。
 *
 * 该名单需与 `packages/tabtin-config/src/index.ts` 的 `ApiRuntimeConfig` 接口字段
 * 保持同步。新增 base URL 字段时务必同步加入；漏列会导致"通过解构重命名绕过规则"。
 */
const API_BASE_TOKENS = new Set([
  'API_CONFIG',
  'API_BASE_URL',
  'apiBaseUrl', // ApiRuntimeConfig.apiBaseUrl
  'apiOrigin', // ApiRuntimeConfig.apiOrigin
  'chatApiBaseUrl', // ApiRuntimeConfig.chatApiBaseUrl
  'wsBaseUrl', // ApiRuntimeConfig.wsBaseUrl（理论上不会用 fetch 发，但保持名单对称）
  'apiBase',
  'baseURL', // 保守一点；多数情况下都是 API_CONFIG.baseURL
])

/**
 * API URL 拼接 helper —— 任何调它再喂 fetch 的都视为违例。
 *
 * - `joinApiPath`：renderer / 通用配置层的 URL 拼接（@tabtin/config）。
 * - `buildTableApiUrl`：table-core 的业务 API URL 构造入口（ 根因 2：
 *   规则原先不认它，导致 table-core / 表单组件的 `fetch(buildTableApiUrl(...))`
 *   全部逃逸主进程代理收口）。
 */
const URL_JOIN_HELPERS = new Set(['joinApiPath', 'buildTableApiUrl'])

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        '禁止 renderer 端直接 fetch(joinApiPath(...)) 或 fetch(`${API_CONFIG.baseURL}/...`)；改走 apiService.request / apiRequest / electronFetch。',
      url: 'https://github.com/TabTin/TabTinAgent/blob/main/eslint-rules/README.md#tabtinno-direct-fetch-in-renderer',
    },
    schema: [],
    messages: {
      directFetchJoin:
        'Renderer 不允许 `fetch(joinApiPath(...))` 直接拼 API URL。三选一：(1) JSON CRUD + envelope 解包用 `apiRequest({ url, method, ... })`（services/apiBase.ts，配 `unwrapData`，最常用）；(2) 复杂 token 注入 / 401 重试 / 重试策略用 `apiService.request<T>({ url, method, ... })`（services/api.ts，axios-like）；(3) blob 下载 / FormData / 透明 Response 语义用 `electronFetch(url, init)`（services/electronFetch.ts）。极少数 unload keepalive / preload bootstrap 等场景，加 `// eslint-disable-next-line tabtin/no-direct-fetch-in-renderer -- 理由` 标注例外（详见 eslint-rules/README.md#出口）。',
      directFetchApiBase:
        'Renderer 不允许 `fetch(`${API_CONFIG.baseURL}/...`)` 直接拼 API URL。三选一：(1) JSON CRUD 用 `apiRequest({ url, method, ... })`（services/apiBase.ts）；(2) axios 形态用 `apiService.request<T>({ url, method, ... })`（services/api.ts）；(3) blob / Response 语义用 `electronFetch(url, init)`（services/electronFetch.ts）。例外场景见 eslint-rules/README.md#出口。',
      directFetchVariable:
        'Renderer 不允许此处 `fetch(...)`：规则做了一层赋值溯源（"中间变量绕过"防护），发现该参数（或模板字符串内 `${x}` 占位）最终源自 API base URL 派生 —— 譬如解构 `const { chatApiBaseUrl: foo } = getApiRuntimeConfig()`、模块级 `const BILLING_BASE = joinApiPath(API_CONFIG.baseURL, ...)`、或局部 `const url = `${API_CONFIG.baseURL}/...``。换写法时三选一：(1) JSON CRUD 用 `apiRequest({ url, method, ... })`（services/apiBase.ts）；(2) axios 形态用 `apiService.request<T>({ url, method, ... })`（services/api.ts）；(3) blob / Response 语义用 `electronFetch(url, init)`（services/electronFetch.ts）。极少数 unload keepalive / preload bootstrap 等场景，加 `// eslint-disable-next-line tabtin/no-direct-fetch-in-renderer -- 理由` 标注例外（详见 eslint-rules/README.md#出口）。',
    },
  },

  create(context) {
    const filename = context.filename || context.getFilename()
    if (ALLOWED_FILES.has(filename)) return {}

    const sourceCode = context.sourceCode || context.getSourceCode()

    /** 判断 CallExpression 的 callee 是否是裸 `fetch` 或 `globalThis.fetch` */
    function isBareFetchCall(node) {
      const callee = node.callee
      if (callee.type === 'Identifier' && callee.name === 'fetch') return true
      // globalThis.fetch / window.fetch / self.fetch
      if (
        callee.type === 'MemberExpression' &&
        callee.property.type === 'Identifier' &&
        callee.property.name === 'fetch' &&
        callee.object.type === 'Identifier' &&
        ['globalThis', 'window', 'self'].includes(callee.object.name)
      ) {
        return true
      }
      return false
    }

    /** 判断 arg 是 `joinApiPath(...)` 调用 */
    function isJoinHelperCall(arg) {
      if (!arg || arg.type !== 'CallExpression') return false
      const callee = arg.callee
      if (callee.type === 'Identifier' && URL_JOIN_HELPERS.has(callee.name)) {
        return true
      }
      // helper 也可能被命名空间化（譬如 import * as cfg / cfg.joinApiPath）
      if (
        callee.type === 'MemberExpression' &&
        callee.property.type === 'Identifier' &&
        URL_JOIN_HELPERS.has(callee.property.name)
      ) {
        return true
      }
      return false
    }

    /**
     * 判断 arg 是含 API base 标识符的模板字符串 / 字符串拼接。
     *
     * 返回值：
     *   - 'direct'   字面引用 API base token（譬如 `${API_CONFIG.baseURL}/x`）
     *   - 'variable' 通过中间变量一层追溯命中（譬如 `${_alias}/x` 其中 _alias 解构自 chatApiBaseUrl）
     *   - false      未命中
     */
    function classifyTemplateLiteral(arg, scope) {
      if (!arg) return false
      if (arg.type !== 'TemplateLiteral') return false
      let kind = false
      for (const expr of arg.expressions) {
        const r = classifyExprApiBase(expr, scope)
        if (r === 'direct') return 'direct'
        if (r === 'variable') kind = 'variable'
      }
      return kind
    }

    /**
     * 判断表达式引用 API base 的方式：
     *   - 'direct'   字面引用 API_CONFIG.baseURL / apiBaseUrl() / API_BASE_URL 等
     *   - 'variable' 通过一层变量源追踪命中（解构重命名 / 模块级常量等）
     *   - false      未命中
     */
    function classifyExprApiBase(expr, scope) {
      if (!expr) return false
      if (expr.type === 'Identifier') {
        if (API_BASE_TOKENS.has(expr.name)) return 'direct'
        return identifierResolvesToApiBase(expr, scope) ? 'variable' : false
      }
      if (expr.type === 'CallExpression') {
        // URL join helper 调用嵌在模板表达式里（譬如 `${buildTableApiUrl(ep)}/x`）
        // 同样视为直接构造 API URL —— 修复"helper 在模板内逃逸"的盲区。
        if (isJoinHelperCall(expr)) return 'direct'
        const c = expr.callee
        if (c.type === 'Identifier' && API_BASE_TOKENS.has(c.name)) return 'direct'
        if (
          c.type === 'MemberExpression' &&
          c.property.type === 'Identifier' &&
          API_BASE_TOKENS.has(c.property.name)
        ) {
          return 'direct'
        }
      }
      if (expr.type === 'MemberExpression') {
        if (
          expr.object.type === 'Identifier' &&
          API_BASE_TOKENS.has(expr.object.name)
        ) {
          return 'direct'
        }
        if (
          expr.property.type === 'Identifier' &&
          API_BASE_TOKENS.has(expr.property.name)
        ) {
          return 'direct'
        }
      }
      return false
    }

    /**
     * 兼容内部调用：返回 boolean，表明 init 表达式是否引用 API base（含间接）。
     * 用在 identifierResolvesToApiBase 里追溯一层时使用。
     */
    function exprReferencesApiBase(expr, scope) {
      return classifyExprApiBase(expr, scope) !== false
    }

    /**
     * 一层变量源追踪：判断 Identifier 是否解析为某个 API base token。
     *
     * 覆盖两种"通过中间变量绕过规则"的反模式：
     *   1) 解构重命名：`const { chatApiBaseUrl: _foo } = getApiRuntimeConfig()`
     *      → `_foo` 解析为 `chatApiBaseUrl`
     *   2) 模块级常量：`const BILLING_BASE = joinApiPath(API_CONFIG.baseURL, ...)`
     *      → `BILLING_BASE` 解析为含 API base 的拼接表达式
     *
     * 设计取舍：只追一层（不递归），避免循环引用风险；极端情况下绕两层或更多
     * 的情况留给未来 ESLint type-aware 规则或 codegen 时检测。
     */
    function identifierResolvesToApiBase(idNode, scope) {
      if (!scope) return false
      const variable = findVariableByName(scope, idNode.name)
      if (!variable) return false
      for (const def of variable.defs || []) {
        if (def.type !== 'Variable') continue
        const declarator = def.node
        if (!declarator || declarator.type !== 'VariableDeclarator') continue

        if (declarator.id?.type === 'ObjectPattern') {
          for (const prop of declarator.id.properties) {
            if (prop.type !== 'Property') continue
            const valueIsThisVar =
              (prop.value?.type === 'Identifier' && prop.value.name === idNode.name) ||
              (prop.value?.type === 'AssignmentPattern' &&
                prop.value.left?.type === 'Identifier' &&
                prop.value.left.name === idNode.name)
            if (
              valueIsThisVar &&
              prop.key?.type === 'Identifier' &&
              API_BASE_TOKENS.has(prop.key.name)
            ) {
              return true
            }
          }
        }

        const init = declarator.init
        if (init) {
          if (isJoinHelperCall(init)) return true
          const declScope = sourceCode.getScope
            ? sourceCode.getScope(declarator)
            : scope
          if (classifyTemplateLiteral(init, declScope)) return true
          if (init.type === 'MemberExpression' || init.type === 'CallExpression') {
            if (exprReferencesApiBase(init, declScope)) return true
          }
        }
      }
      return false
    }

    /** 在 scope 链上层向下查 variable（ESLint scope manager API） */
    function findVariableByName(scope, name) {
      let cur = scope
      while (cur) {
        const found = cur.variables.find((v) => v.name === name)
        if (found) return found
        cur = cur.upper
      }
      return null
    }

    return {
      CallExpression(node) {
        if (!isBareFetchCall(node)) return
        const firstArg = node.arguments[0]
        if (!firstArg) return

        const scope = sourceCode.getScope
          ? sourceCode.getScope(node)
          : context.getScope?.()

        if (isJoinHelperCall(firstArg)) {
          context.report({ node, messageId: 'directFetchJoin' })
          return
        }
        const tmplKind = classifyTemplateLiteral(firstArg, scope)
        if (tmplKind === 'direct') {
          context.report({ node, messageId: 'directFetchApiBase' })
          return
        }
        if (tmplKind === 'variable') {
          // 模板字符串内 ${x} 中的 x 经一层追溯发现源自 API base —— 同样是变量绕过
          context.report({ node, messageId: 'directFetchVariable' })
          return
        }
        // 直接 fetch(url) 其中 url 来自 const url = joinApiPath(...)
        if (firstArg.type === 'Identifier') {
          if (identifierResolvesToApiBase(firstArg, scope)) {
            context.report({ node, messageId: 'directFetchVariable' })
          }
        }
      },
    }
  },
}

export default rule
