/**
 * 为 Electron eval 包裹用户脚本（零 electron 依赖）：
 *  - 表达式（含 async IIFE / Promise 链等内部带 `;` 的表达式）原样透传，
 *    由下游 evalTool 统一补 `return`；
 *  - 语句序列在末行可求值时自动补 `return`，补完用语法校验兜底。
 *
 * 判定用 AsyncFunction 构造器做**只编译不执行**的语法级检测，
 * 取代旧的 `/[;\n]/` + `/\breturn\b/` 正则启发式——正则会把「嵌套函数体内的
 * `;` / `return`」误判成顶层多语句/已有返回，导致 async IIFE 求值结果被静默丢弃
 * 。Daemon eval 不调用（直传 expression）。
 */

// 兼容顶层 await：普通 Function 构造器无法 parse `await`。
const AsyncFunctionCtor = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => unknown

function parsesAsFunctionBody(body: string): boolean {
  try {
    new AsyncFunctionCtor(body)
    return true
  } catch {
    return false
  }
}

/**
 * 语法级判定：整段代码是否是一个合法的单表达式（只编译不执行）。
 * 末尾换行保护行尾 `//` 注释不吞掉收尾括号。
 */
export function isParsableExpression(code: string): boolean {
  return parsesAsFunctionBody(`return (${code}\n);`)
}

export function wrapEvalCode(code: string): string {
  const trimmed = code.trim()
  if (!trimmed) return code
  // 表达式（单行或多行）原样透传，evalTool 统一按表达式补 return。
  if (isParsableExpression(trimmed)) return code

  // 语句序列：末行是可求值表达式时补 return（保持既有「多语句末行补 return」契约）。
  const lines = trimmed.split('\n')
  let lastNonEmptyIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) {
      lastNonEmptyIdx = i
      break
    }
  }
  if (lastNonEmptyIdx < 0) return code

  const lastLine = lines[lastNonEmptyIdx].trimStart()
  if (/^(const|let|var|function|class|if|for|while|switch|try|throw|return)\b/.test(lastLine)) {
    return code
  }
  const indent = lines[lastNonEmptyIdx].match(/^(\s*)/)?.[1] || ''
  const candidate = [
    ...lines.slice(0, lastNonEmptyIdx),
    `${indent}return ${lastLine}`,
    ...lines.slice(lastNonEmptyIdx + 1),
  ].join('\n')
  // 语法兜底：补 return 后反而不合法（如末行是某语句的中段）则保持原样。
  return parsesAsFunctionBody(candidate) ? candidate : code
}
