import { RuleTester } from 'eslint'
import rule from '../no-direct-fetch-in-renderer.js'

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
})

ruleTester.run('no-direct-fetch-in-renderer', rule, {
  valid: [
    {
      name: '走 electronFetch 替代品',
      code: `import { electronFetch } from '@/services/electronFetch'\nawait electronFetch(joinApiPath(API_CONFIG.baseURL, '/x'))`,
    },
    {
      name: '走 apiService.request 替代品',
      code: `await apiService.request({ url: '/x', method: 'GET' })`,
    },
    {
      name: 'fetch 调用外部 URL 字面量（不拼 API base）',
      code: `await fetch('https://example.com/api/v1/data')`,
    },
    {
      name: 'fetch 调用变量 URL（无 API base 标识）',
      code: `await fetch(externalUrl, { method: 'POST' })`,
    },
    {
      name: '模板字符串无 API base 引用',
      code: `await fetch(\`\${someBaseUrl}/x\`)`,
    },
    {
      name: 'fetch 局部 url 来自外部输入（无 API base 派生）',
      code: `function f(externalUrl) { return fetch(externalUrl) }`,
    },
    {
      name: '局部变量初始化非 join helper / 非含 API base 模板字符串',
      code: `function f() { const url = '/relative-path'; return fetch(url) }`,
    },
    {
      name: 'async/arrow function 内裸 fetch 外部 URL',
      code: `const f = async () => fetch('https://example.com')`,
    },
  ],

  invalid: [
    {
      name: 'fetch(joinApiPath(API_CONFIG.baseURL, ...))',
      code: `await fetch(joinApiPath(API_CONFIG.baseURL, '/api/x'))`,
      errors: [{ messageId: 'directFetchJoin' }],
    },
    {
      name: 'fetch(joinApiPath(...))（裸 helper）',
      code: `await fetch(joinApiPath(base, '/api/x'), { method: 'POST' })`,
      errors: [{ messageId: 'directFetchJoin' }],
    },
    {
      name: 'fetch(`${API_CONFIG.baseURL}/x`)',
      code: 'await fetch(`${API_CONFIG.baseURL}/api/x`)',
      errors: [{ messageId: 'directFetchApiBase' }],
    },
    {
      name: 'fetch(`${apiBaseUrl()}/x`)',
      code: 'await fetch(`${apiBaseUrl()}/api/x`)',
      errors: [{ messageId: 'directFetchApiBase' }],
    },
    {
      name: 'fetch(`${API_BASE_URL}/x`)',
      code: 'await fetch(`${API_BASE_URL}/api/x`)',
      errors: [{ messageId: 'directFetchApiBase' }],
    },
    {
      name: '命名空间化 helper：fetch(cfg.joinApiPath(...))',
      code: `await fetch(cfg.joinApiPath(API_CONFIG.baseURL, '/x'))`,
      errors: [{ messageId: 'directFetchJoin' }],
    },
    {
      name: 'globalThis.fetch 同样命中',
      code: `await globalThis.fetch(joinApiPath('/x'))`,
      errors: [{ messageId: 'directFetchJoin' }],
    },
    {
      name: 'window.fetch 同样命中',
      code: 'await window.fetch(`${API_CONFIG.baseURL}/x`)',
      errors: [{ messageId: 'directFetchApiBase' }],
    },
    {
      name: 'fetch(`${chatApiBaseUrl}/x`)（新增 token）',
      code: 'await fetch(`${chatApiBaseUrl}/x`)',
      errors: [{ messageId: 'directFetchApiBase' }],
    },
    {
      name: '解构重命名绕过（模板字符串内）：const { chatApiBaseUrl: foo } = ... + fetch(`${foo}/x`)',
      code:
        `const { chatApiBaseUrl: _foo } = getApiRuntimeConfig();\n` +
        'await fetch(`${_foo}/api/x`)',
      errors: [{ messageId: 'directFetchVariable' }],
    },
    {
      name: '模块级常量绕过（模板字符串内）：const BILLING_BASE = joinApiPath(...) + fetch(`${BILLING_BASE}/x`)',
      code:
        `const BILLING_BASE = joinApiPath(API_CONFIG.baseURL, '/billing');\n` +
        'await fetch(`${BILLING_BASE}/x`)',
      errors: [{ messageId: 'directFetchVariable' }],
    },
    {
      name: '局部 url 变量绕过：const url = joinApiPath(...) + fetch(url)',
      code:
        `function downloadCsv() {\n` +
        `  const url = joinApiPath(API_CONFIG.baseURL, '/csv');\n` +
        `  return fetch(url);\n` +
        `}`,
      errors: [{ messageId: 'directFetchVariable' }],
    },
    {
      name: '局部 url 变量来自模板字符串绕过',
      code:
        `function downloadCsv() {\n` +
        '  const url = `${API_CONFIG.baseURL}/csv`;\n' +
        '  return fetch(url);\n' +
        `}`,
      errors: [{ messageId: 'directFetchVariable' }],
    },
    {
      name: 'arrow function 内的违例同样命中',
      code: `const f = async () => fetch(joinApiPath('/x'))`,
      errors: [{ messageId: 'directFetchJoin' }],
    },
    {
      name: 'fetch(`${apiOrigin}/x`)（新增 token）',
      code: 'await fetch(`${apiOrigin}/api/x`)',
      errors: [{ messageId: 'directFetchApiBase' }],
    },
    {
      name: 'fetch(`${wsBaseUrl}/x`)（新增 token —— 名单对称，理论上不会真用 fetch 发）',
      code: 'await fetch(`${wsBaseUrl}/api/x`)',
      errors: [{ messageId: 'directFetchApiBase' }],
    },
    {
      name: '解构 apiOrigin 绕过（模板字符串内追溯）',
      code:
        `const { apiOrigin: _o } = getApiRuntimeConfig();\n` +
        'await fetch(`${_o}/api/x`)',
      errors: [{ messageId: 'directFetchVariable' }],
    },
    {
      name: '混合模板：${API_CONFIG.baseURL} 与 ${_alias} 同时出现，应报 direct（更严重的字面命中优先）',
      code:
        `const { chatApiBaseUrl: _alias } = getApiRuntimeConfig();\n` +
        'await fetch(`${API_CONFIG.baseURL}/${_alias}/x`)',
      errors: [{ messageId: 'directFetchApiBase' }],
    },
  ],

  // ---------------------------------------------------------------------------
  // 已知规则局限：以下用例**应该不命中**（限制；登记 §五遗留池后续治理）。
  // 把它们放在 valid 数组里相当于显式断言"规则不会管这些"，未来若扩展规则
  // 应同步把对应 case 移到 invalid。
  // ---------------------------------------------------------------------------
})

const ruleTesterLimitations = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
})

ruleTesterLimitations.run('no-direct-fetch-in-renderer (known limitations)', rule, {
  valid: [
    {
      name: '【局限 1】两层别名：const a = joinApiPath(...); const b = a; fetch(`${b}/x`)',
      code:
        `const a = joinApiPath(API_CONFIG.baseURL, '/x');\n` +
        `const b = a;\n` +
        'await fetch(`${b}/x`)',
    },
    {
      name: '【局限 2】函数返回值：fetch(buildExportUrl(...))',
      code:
        `function buildExportUrl(id) { return joinApiPath(API_CONFIG.baseURL, '/exports/' + id) }\n` +
        `await fetch(buildExportUrl(1))`,
    },
    {
      name: '【局限 3】其他 HTTP primitive：navigator.sendBeacon(joinApiPath(...))',
      code: `navigator.sendBeacon(joinApiPath(API_CONFIG.baseURL, '/x'), payload)`,
    },
    {
      name: '【局限 3】其他 HTTP primitive：axios.get(joinApiPath(...))',
      code: `await axios.get(joinApiPath(API_CONFIG.baseURL, '/x'))`,
    },
  ],
  invalid: [],
})

console.log('no-direct-fetch-in-renderer: all tests passed')
