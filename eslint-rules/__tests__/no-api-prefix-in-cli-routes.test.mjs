import { RuleTester } from 'eslint'
import rule from '../no-api-prefix-in-cli-routes.js'

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
})

ruleTester.run('no-api-prefix-in-cli-routes', rule, {
  valid: [
    {
      name: '字符串字面量 path 不含 /api 前缀',
      code: `await djangoRequest('GET', '/tabdata/tables')`,
    },
    {
      name: '模板字面量 path 不含 /api 前缀',
      code: 'await djangoRequest("GET", `/tabdata/tables/${tableId}`)',
    },
    {
      name: '中间变量 path 来源也不含 /api',
      code: `const path = '/tabdata/tables'; await djangoRequest('GET', path)`,
    },
    {
      name: '直连非 /api 命名空间的 Django 路径（譬如 /extensions）',
      code: `await djangoRequest('GET', '/extensions/cli-commands/')`,
    },
    {
      name: '非 djangoRequest 调用即使 path 自带 /api 也不命中',
      code: `await otherClient('GET', '/api/v1/tables')`,
    },
    {
      name: 'path 是动态拼接但开头不是 /api',
      code: 'await djangoRequest("GET", `/tabdata/${prefix}/api/sub`)',
    },
    {
      name: '路径里含 /apidoc 等以 /api 开头但非真前缀的字符串',
      code: `await djangoRequest('GET', '/apidoc/v1/openapi.json')`,
    },
  ],

  invalid: [
    {
      name: '字符串字面量 path 以 /api/ 开头',
      code: `await djangoRequest('POST', '/api/tabdata/tables', body)`,
      errors: [{ messageId: 'literalApiPrefix' }],
    },
    {
      name: '字符串字面量 path 正好等于 /api',
      code: `await djangoRequest('GET', '/api')`,
      errors: [{ messageId: 'literalApiPrefix' }],
    },
    {
      name: '模板字面量 path 以 /api/ 开头',
      code: 'await djangoRequest("GET", `/api/tabdata/tables/${tableId}`)',
      errors: [{ messageId: 'templateApiPrefix' }],
    },
    {
      name: '中间变量 path 源自 /api 前缀字面量',
      code: `const path = '/api/tabdata/tables'; await djangoRequest('GET', path)`,
      errors: [{ messageId: 'variableApiPrefix' }],
    },
    {
      name: '中间变量 path 源自 /api 前缀模板字面量',
      code: 'const path = `/api/tabdata/${id}`; await djangoRequest("GET", path)',
      errors: [{ messageId: 'variableApiPrefix' }],
    },
    {
      name: '成员调用形态：bindings.djangoRequest',
      code: `await bindings.djangoRequest('POST', '/api/tabdata/x', body)`,
      errors: [{ messageId: 'literalApiPrefix' }],
    },
  ],
})

console.log('no-api-prefix-in-cli-routes: all tests passed')
