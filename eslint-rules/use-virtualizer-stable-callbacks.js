/**
 * tabtin/use-virtualizer-stable-callbacks
 *
 * 强制 `useVirtualizer({...})` / `useWindowVirtualizer({...})` 的 measurement-
 * affecting 回调必须使用稳定引用（useCallback/useMemo/useEvent/useEffectEvent
 * 包装，或来自模块作用域 / import）。
 *
 * 背景：@tanstack/react-virtual v3.13+ 把以下选项作为"测量缓存 key"的一部分
 * （ 维护者明确："the virtualizer automatically invalidates its
 * measurement cache when measurement-affecting options change, for example
 * getItemKey"），如果传入 inline arrow / function expression：
 *   1. 每次 render 都是新引用
 *   2. virtualizer 测量缓存反复失效
 *   3. ResizeObserver `observeElementRect` 触发 onChange notify
 *   4. notify → dispatchReducerAction → setState → re-render
 *   5. 形成死循环 → React 抛 "Maximum update depth exceeded"
 *
 * 这条 lint 规则在 PR 阶段静态拦截，避免回归。本仓库 2026-05 修过 8 处同款
 *
 * 触发模式（违例）：
 *   1) inline 箭头：
 *        useVirtualizer({ getItemKey: (i) => items[i].id })
 *   2) inline function 表达式：
 *        useVirtualizer({ estimateSize: function (i) { return ... } })
 *   3) 局部命名函数（仍然 inline 引用，每次 render 新建）：
 *        function MyList() {
 *          const getKey = (i) => items[i].id
 *          useVirtualizer({ getItemKey: getKey })  // ← 命中
 *        }
 *
 * 合法形态：
 *   1) useCallback / useMemo / useEvent / useEffectEvent 包装：
 *        const getItemKey = useCallback((i) => itemsRef.current[i].id, [])
 *        useVirtualizer({ getItemKey })
 *   2) 模块级常量函数（引用永久稳定）：
 *        const getRowKey = (row) => `row:${row.id}`
 *        function MyList() {
 *          useVirtualizer({ getItemKey: (i) => getRowKey(rows[i]) }) // ← 这层 inline 仍命中
 *        }
 *      正确写法是把 inline 那层也提到 useCallback 里。
 *   3) import 进来的稳定函数：
 *        import { defaultEstimateSize } from './utils'
 *        useVirtualizer({ estimateSize: defaultEstimateSize })
 *
 * 规则覆盖以下 8 个 measurement-affecting 选项（@tanstack/react-virtual v3 文档
 * 中标注会进入测量 cache key 的字段）：
 *   getItemKey / estimateSize / getScrollElement / rangeExtractor /
 *   observeElementRect / observeElementOffset / scrollToFn / measureElement
 *
 * 非 measurement-affecting 字段（count / overscan / paddingStart / paddingEnd /
 * scrollMargin / enabled / horizontal 等）不在本规则范围。
 *
 * 局限（与 `no-direct-fetch-in-renderer` 一致，靠 PR review 兜底）：
 *   - 两层间接别名：`const a = useCallback(...); const b = a; useVirtualizer({ getItemKey: b })`
 *     —— 第二层不追溯，但 b 是组件 body 内 const，本规则会命中（误报，少见，加 disable 注释豁免）
 *   - SpreadElement：`useVirtualizer({ ...opts })` —— 静态不可达，跳过
 *   - 解构 / 类组件内 instance method —— 不在范围
 */

const VIRTUALIZER_HOOKS = new Set(['useVirtualizer', 'useWindowVirtualizer'])

const MEASUREMENT_AFFECTING_OPTIONS = new Set([
  'getItemKey',
  'estimateSize',
  'getScrollElement',
  'rangeExtractor',
  'observeElementRect',
  'observeElementOffset',
  'scrollToFn',
  'measureElement',
])

/** 视为"输出引用稳定"的包装 hook —— 命中后视为合法 */
const STABILIZING_HOOKS = new Set([
  'useCallback',
  'useMemo',
  'useEvent', // React 19 alias
  'useEffectEvent', // React 19 alias
])

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        '强制 useVirtualizer 的 measurement-affecting 回调（getItemKey / estimateSize / getScrollElement / rangeExtractor 等）使用稳定引用，避免 react-virtual 3.13+ 测量缓存失效引发的 "Maximum update depth exceeded" 死循环。',
      url: 'https://github.com/TabTin/TabTinAgent/blob/main/eslint-rules/README.md#tabtinuse-virtualizer-stable-callbacks',
    },
    schema: [],
    messages: {
      inlineFunction:
        '`useVirtualizer` 的 `{{option}}` 不能是 inline 函数。每次 render 都是新引用 → react-virtual 测量缓存反复失效 → ResizeObserver onChange 触发 setState → 死循环（"Maximum update depth exceeded"，参考 TanStack/virtual#1092）。改写法：在组件 body 内用 `const {{option}} = useCallback((...) => {...}, [])` 包装；如回调需要读取频繁变化的状态，配合 `const xxxRef = useRef(state); xxxRef.current = state` + 回调内读 `xxxRef.current` 让引用永久稳定（参考 MessageList.tsx 的修复模式）。',
      unstableIdentifier:
        '`useVirtualizer` 的 `{{option}}` 引用了 `{{name}}`，但它定义在组件 body 内且不是 useCallback/useMemo/useEvent/useEffectEvent 包装的稳定函数 —— 每次 render 都是新引用，等价于 inline。改写法：用 `const {{name}} = useCallback((...) => {...}, [])` 包装；或者把 `{{name}}` 上提到模块作用域成为模块级常量函数（如果它没有捕获组件 state）。',
    },
  },

  create(context) {
    const sourceCode = context.sourceCode || context.getSourceCode()

    /** 判断 callee 是否是 useVirtualizer / useWindowVirtualizer */
    function isVirtualizerHookCall(node) {
      const callee = node.callee
      if (callee.type === 'Identifier' && VIRTUALIZER_HOOKS.has(callee.name)) {
        return true
      }
      // 命名空间化（罕见但合法）：reactVirtual.useVirtualizer({...})
      if (
        callee.type === 'MemberExpression' &&
        callee.property.type === 'Identifier' &&
        VIRTUALIZER_HOOKS.has(callee.property.name)
      ) {
        return true
      }
      return false
    }

    /**
     * 判断 init 表达式是否是稳定包装：useCallback(...) / useMemo(...) /
     * useEvent(...) / useEffectEvent(...)。
     */
    function isStabilizingHookCall(initNode) {
      if (!initNode || initNode.type !== 'CallExpression') return false
      const callee = initNode.callee
      if (callee.type === 'Identifier' && STABILIZING_HOOKS.has(callee.name)) {
        return true
      }
      // import * as React from 'react'; React.useCallback(...)
      if (
        callee.type === 'MemberExpression' &&
        callee.property.type === 'Identifier' &&
        STABILIZING_HOOKS.has(callee.property.name)
      ) {
        return true
      }
      return false
    }

    /** 在 scope 链上层向下查 variable */
    function findVariableByName(scope, name) {
      let cur = scope
      while (cur) {
        const found = cur.variables.find((v) => v.name === name)
        if (found) return found
        cur = cur.upper
      }
      return null
    }

    /**
     * 判断 variable 的定义是否构成"稳定函数引用"。
     *
     * 视为稳定：
     *   - import 来的（包括 default / named / namespace）
     *   - 模块作用域的 function declaration / const fn = ...
     *   - useCallback / useMemo / useEvent / useEffectEvent 包装
     *
     * 视为不稳定：
     *   - 组件 / 函数 body 内的 const fn = (...) => ... / function fn() {}
     *     （每次组件 render 都新建一份）
     *
     * 返回值：
     *   - 'stable'   —— 稳定
     *   - 'unstable' —— 不稳定（应报错）
     *   - 'unknown'  —— 无法判定（保守不报，避免误报）
     */
    function classifyVariableStability(variable) {
      if (!variable || !variable.defs || variable.defs.length === 0) {
        return 'unknown'
      }

      for (const def of variable.defs) {
        // import 视为稳定
        if (def.type === 'ImportBinding') return 'stable'

        // 函数声明 `function fn() {}`：稳定性取决于声明所在 scope
        if (def.type === 'FunctionName') {
          const declScope = def.node.parent
            ? findEnclosingFunctionScope(def.node)
            : null
          if (!declScope) return 'stable' // 顶层 function declaration
          return 'unstable'
        }

        // 变量声明
        if (def.type === 'Variable') {
          const declarator = def.node
          if (!declarator || declarator.type !== 'VariableDeclarator') {
            return 'unknown'
          }

          const init = declarator.init

          // 没有 init（const x; 不存在；let x;）—— 罕见，保守
          if (!init) return 'unknown'

          // useCallback/useMemo/useEvent/useEffectEvent 包装 → 稳定
          if (isStabilizingHookCall(init)) return 'stable'

          // const x = otherFn —— 一层别名追溯
          if (init.type === 'Identifier') {
            const aliased = findVariableByName(
              sourceCode.getScope
                ? sourceCode.getScope(declarator)
                : declarator.parent.parent.parent,
              init.name,
            )
            if (aliased && aliased !== variable) {
              return classifyVariableStability(aliased)
            }
            return 'unknown'
          }

          // const x = () => ... / const x = function() {} —— inline，稳定性看声明所在 scope
          if (
            init.type === 'ArrowFunctionExpression' ||
            init.type === 'FunctionExpression'
          ) {
            const enclosingFn = findEnclosingFunctionScope(declarator)
            if (!enclosingFn) {
              // 模块作用域 const → 稳定
              return 'stable'
            }
            // 在某个 function（譬如 React 组件函数）内部 → 不稳定
            return 'unstable'
          }

          // 其他 init 形态（CallExpression 不是 stabilizing hook、ObjectExpression
          // 字段访问等）—— 保守不报。譬如 const fn = createHelper() 我们无法判定
          // createHelper 返回值是否稳定。
          return 'unknown'
        }
      }
      return 'unknown'
    }

    /**
     * 向上找包裹该 AST node 的最近 function scope（FunctionDeclaration /
     * FunctionExpression / ArrowFunctionExpression）。返回 null 表示在模块
     * 顶层。
     */
    function findEnclosingFunctionScope(node) {
      let cur = node.parent
      while (cur) {
        if (
          cur.type === 'FunctionDeclaration' ||
          cur.type === 'FunctionExpression' ||
          cur.type === 'ArrowFunctionExpression'
        ) {
          return cur
        }
        cur = cur.parent
      }
      return null
    }

    /**
     * 检查一个 ObjectExpression property 的 value 是否稳定，不稳定则 report。
     */
    function checkPropertyValue(property, scope) {
      if (property.type !== 'Property') return
      if (property.computed) return
      const key = property.key
      let optionName = null
      if (key.type === 'Identifier') optionName = key.name
      else if (key.type === 'Literal' && typeof key.value === 'string') {
        optionName = key.value
      }
      if (!optionName || !MEASUREMENT_AFFECTING_OPTIONS.has(optionName)) return

      const value = property.value

      // 直接 inline function → 必报
      if (
        value.type === 'ArrowFunctionExpression' ||
        value.type === 'FunctionExpression'
      ) {
        context.report({
          node: value,
          messageId: 'inlineFunction',
          data: { option: optionName },
        })
        return
      }

      // Identifier 引用 → 一层追溯
      if (value.type === 'Identifier') {
        const variable = findVariableByName(scope, value.name)
        if (!variable) return // 无法解析（譬如 global），保守不报
        const verdict = classifyVariableStability(variable)
        if (verdict === 'unstable') {
          context.report({
            node: value,
            messageId: 'unstableIdentifier',
            data: { option: optionName, name: value.name },
          })
        }
        // 'stable' / 'unknown' → 不报
      }

      // 其他形态（MemberExpression / CallExpression 等）保守不报
    }

    return {
      CallExpression(node) {
        if (!isVirtualizerHookCall(node)) return
        const firstArg = node.arguments[0]
        if (!firstArg || firstArg.type !== 'ObjectExpression') return

        const scope = sourceCode.getScope
          ? sourceCode.getScope(node)
          : context.getScope?.()

        for (const prop of firstArg.properties) {
          checkPropertyValue(prop, scope)
        }
      },
    }
  },
}

export default rule
