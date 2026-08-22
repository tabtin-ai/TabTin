/**
 * tabtin/no-api-prefix-in-cli-routes
 *
 * 禁止 `packages/cli-routes/src/routes/**` 下传给 `djangoRequest`（以及通过中间
 * 变量传入）的 path 字面量自带 `/api/` 前缀。
 *
 * 背景：cli-routes 是 Electron 和 Daemon 两端 cli-server 共享的路由实现。两端
 * `djangoRequest` 内部都会把 baseUrl 归一化成带 `/api` 结尾再用 `joinApiPath`
 * 拼接（详见 `packages/tabtin-config/src/index.ts` 的 `joinApiPath` /
 * `deriveApiBaseUrl`）。**path 自带 `/api` 会被自动剥前缀并在 dev 环境打出
 * 警告栈**，淹没真正的错误日志；隐藏更深的暗雷是哪天 Daemon serverUrl 真带
 * `/api` 后缀时，cli-routes 就会双 `/api` → 404。
 *
 * 触发模式（违例）：
 *   1) 字符串字面量：`djangoRequest('POST', '/api/tabdata/tables', ...)`
 *   2) 模板字面量：`` djangoRequest('GET', `/api/tabdata/tables/${id}`) ``
 *   3) 通过赋值中间变量：`const path = '/api/x'; djangoRequest('GET', path)`
 *      （只追一层）
 *
 * 合法写法：
 *   - `djangoRequest('GET', '/tabdata/tables', ...)`
 *   - `` djangoRequest('GET', `/tabdata/tables/${id}`) ``
 *
 * 例外：如果你**确实**需要直连某个不在 `/api/` 命名空间下的 Django 路径（极少
 * 见，比如 `/extensions/*` 这种），自然写不含 `/api` 前缀的路径即可；本规则只
 * 拦截 `/api/` 开头，不会误伤。
 */

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        '禁止 cli-routes 路由文件里传给 djangoRequest 的 path 自带 /api 前缀；baseUrl 已带 /api，再前缀会被自动剥并触发 dev warn。',
      url: 'https://github.com/TabTin/TabTinAgent/blob/main/eslint-rules/README.md#tabtinno-api-prefix-in-cli-routes',
    },
    schema: [],
    messages: {
      literalApiPrefix:
        'path "{{value}}" 自带 /api 前缀。cli-routes 的 djangoRequest 期望 path **不带** /api（baseUrl 会归一化成带 /api 结尾再拼接）。改成 "{{suggested}}" 即可。',
      templateApiPrefix:
        '模板字面量 path 以 /api 开头。cli-routes 的 djangoRequest 期望 path **不带** /api（baseUrl 会归一化成带 /api 结尾再拼接）。把开头的 `/api` 去掉即可。',
      variableApiPrefix:
        '此处通过中间变量传给 djangoRequest 的 path 源自一个以 /api 开头的字面量。cli-routes 的 djangoRequest 期望 path **不带** /api（baseUrl 会归一化成带 /api 结尾再拼接）。去掉源字面量的 /api 前缀即可。',
    },
  },

  create(context) {
    const sourceCode = context.sourceCode || context.getSourceCode();

    /** path 字符串是否以 /api 开头（含模板字面量首段判断） */
    function startsWithApi(value) {
      return /^\/api(?=\/|$)/.test(value);
    }

    function suggestStripped(value) {
      return value.replace(/^\/api(?=\/|$)/, '') || '/';
    }

    /** CallExpression callee 是否是 djangoRequest（裸或成员调用） */
    function isDjangoRequestCall(node) {
      const callee = node.callee;
      if (callee.type === 'Identifier' && callee.name === 'djangoRequest') return true;
      if (
        callee.type === 'MemberExpression' &&
        callee.property.type === 'Identifier' &&
        callee.property.name === 'djangoRequest'
      ) {
        return true;
      }
      return false;
    }

    /**
     * 检查 path 表达式是否违例。
     * 返回 'literal' | 'template' | 'variable' | false。
     */
    function classifyPathArg(arg, scope, depth = 0) {
      if (!arg) return false;

      if (arg.type === 'Literal' && typeof arg.value === 'string') {
        return startsWithApi(arg.value) ? 'literal' : false;
      }

      if (arg.type === 'TemplateLiteral') {
        const firstQuasi = arg.quasis[0];
        if (firstQuasi && startsWithApi(firstQuasi.value.cooked || firstQuasi.value.raw)) {
          return 'template';
        }
        return false;
      }

      if (arg.type === 'Identifier' && depth === 0) {
        const variable = findVariableByName(scope, arg.name);
        if (!variable) return false;
        for (const def of variable.defs || []) {
          if (def.type !== 'Variable') continue;
          const declarator = def.node;
          if (!declarator || declarator.type !== 'VariableDeclarator') continue;
          if (!declarator.init) continue;
          const declScope = sourceCode.getScope ? sourceCode.getScope(declarator) : scope;
          const inner = classifyPathArg(declarator.init, declScope, depth + 1);
          if (inner) return 'variable';
        }
      }

      return false;
    }

    function findVariableByName(scope, name) {
      let cur = scope;
      while (cur) {
        const found = cur.variables.find((v) => v.name === name);
        if (found) return found;
        cur = cur.upper;
      }
      return null;
    }

    return {
      CallExpression(node) {
        if (!isDjangoRequestCall(node)) return;
        const pathArg = node.arguments[1];
        if (!pathArg) return;

        const scope = sourceCode.getScope ? sourceCode.getScope(node) : context.getScope?.();
        const kind = classifyPathArg(pathArg, scope);
        if (!kind) return;

        if (kind === 'literal' && pathArg.type === 'Literal') {
          const value = String(pathArg.value);
          context.report({
            node: pathArg,
            messageId: 'literalApiPrefix',
            data: { value, suggested: suggestStripped(value) },
          });
          return;
        }
        if (kind === 'template') {
          context.report({ node: pathArg, messageId: 'templateApiPrefix' });
          return;
        }
        if (kind === 'variable') {
          context.report({ node: pathArg, messageId: 'variableApiPrefix' });
        }
      },
    };
  },
};

export default rule;
