/**
 * tabtin/no-empty-catch
 *
 * 禁止"显式忽略错误"形态的空 catch 子句静默吞错。
 *
 * 触发形态（违例）：
 *   1) `try { ... } catch {}`              ← 不接 param，显式不关心
 *   2) `try { ... } catch (_) {}`          ← param 是裸下划线
 *
 * 不在本规则范围内（属于另一类反模式，baseline 上千处历史代码，需独立 wave 治理）：
 *   - `try { ... } catch (err) {}` ← 接 param 但 body 空（吞 err）
 *   - `try { ... } catch (err) { console.warn(err) }` ← 仅 console（生产环境通常被丢弃）
 *   - `try { ... } catch (_xxx) {}` ← param 以下划线开头（已被
 *      `@typescript-eslint/no-unused-vars` 默认 argsIgnorePattern 放行）
 *
 * 选择上述边界的原因：本规则跟 contract Wave 1 北极星 grep
 *   `catch\s*\(\s*_\s*\)\s*\{\s*\}|catch\s*\{\s*\}` 完全语义对齐——这两种"显式
 *   表达不在乎"的形态是最值得拦截的反模式。带 named param 的空 catch 数量级
 *   在 500+，需要单独 wave 配套迁移工具一起做，不在 W1-B 范围内。
 *
 * 出口（合法 fail-soft）：catch 上方紧邻的注释行写 `fail-soft: <理由>` 即可放行。
 *   例：
 *     try { await syncBackground() }
 *     catch {
 *       // fail-soft: 后台同步失败不打扰用户，下次心跳重试
 *     }
 *
 *   注释也可以放在 try 块上方（适合整段降级）。
 *   `fail-soft:` 后面必须有非空理由——只写 `// fail-soft:` 不算合法标记。
 *
 *   出口替代写法：在 catch body 内部写任意注释（譬如 `/* expected when offline *\/`）
 *   也算"已说明降级原因"——本规则不强求 body 内注释含 `fail-soft:` 关键字，
 *   毕竟 body 里写多行 `// noop`、`// 历史保留` 等也表明开发者意识到了这是有意降级。
 *
 * 设计取舍：不依赖 ESLint `// eslint-disable-next-line` 注释——ESLint 内核的
 *   disable 不强制 reason，开发者可以裸 disable。规则自带语义化出口能强制理由出现。
 */

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        '禁止 `catch {}` / `catch (_) {}` 形态的空 catch 子句静默吞错。如属合法 fail-soft，请在 catch 上方写 `// fail-soft: <理由>` 注释。',
      url: 'https://github.com/TabTin/TabTinAgent/blob/main/eslint-rules/README.md#tabtinno-empty-catch',
    },
    schema: [],
    messages: {
      emptyCatch:
        '空 catch 子句会静默吞掉错误，破坏失败可见性。合法降级请用以下任一出口：(A) 在 try 或 catch 紧上方的注释行写 `// fail-soft: <理由>`（冒号后必须有非空理由）；(B) 在 catch body 内写任意一条说明注释（譬如 `/* expected when offline */`）。否则改用 `throw` / `toast` / `log.warn(...)` 让失败可见。详见 eslint-rules/README.md#出口。',
    },
  },

  create(context) {
    const sourceCode = context.sourceCode || context.getSourceCode()

    /**
     * 是否有 fail-soft 注释（catch / try 上方），且后面有非空理由。
     *
     * 正则要求 `fail-soft` 后必须接 `:` `：` `-` `—`（任一），再接至少一个非空白字符。
     * 这样"// fail-soft:"（无理由）会被拦下，强迫开发者写出降级原因。
     */
    function hasFailSoftCommentWithReason(comments) {
      return comments.some((c) =>
        /\bfail-soft\s*[:：\-—]\s*\S/i.test(c.value),
      )
    }

    /**
     * catch body 内部有任意注释（即便是简单的 `// noop`）就视为已说明降级原因。
     *
     * 这是本规则有意保留的"软出口"——避免在 try-catch 嵌套常见、且 catch body
     * 写一行注释比写整段 fail-soft 标识更自然的场景下，开发者被迫违心地写
     * `// fail-soft: ...` 长描述。注释内容不强制 `fail-soft:` 关键字。
     */
    function hasAnyExplanationComment(catchNode) {
      const tryStatement = catchNode.parent
      const insideBlockComments = sourceCode.getCommentsInside(catchNode.body)
      if (insideBlockComments.length > 0) return true
      // 对应 try 上方 / catch 上方的 fail-soft 注释也算（适合整段降级）
      const tryParentComments = tryStatement
        ? sourceCode.getCommentsBefore(tryStatement)
        : []
      const catchLeading = sourceCode.getCommentsBefore(catchNode)
      return hasFailSoftCommentWithReason([
        ...tryParentComments,
        ...catchLeading,
      ])
    }

    /**
     * 是否属于"显式不关心错误"的 catch 形态：
     *   - 无 param（`catch {}`，AST: param === null）
     *   - param 是裸下划线（`catch (_)`，AST: Identifier name === '_'）
     *
     * `catch (_xxx)` 这种"underscore-prefix unused"不属于本规则范围 ——
     * `@typescript-eslint/no-unused-vars` 已默认放过这种命名，跟 contract Wave 1-B
     * 的北极星 grep 也对齐（北极星只扫 `catch (_)` 字面）。
     */
    function isExplicitlyIgnoredCatch(catchNode) {
      const param = catchNode.param
      if (param == null) return true
      if (param.type === 'Identifier' && param.name === '_') return true
      return false
    }

    return {
      CatchClause(node) {
        const body = node.body && node.body.body
        const isEmpty = !body || body.length === 0
        if (!isEmpty) return
        if (!isExplicitlyIgnoredCatch(node)) return
        // body 内部任何注释 / 对应 try 上方的 fail-soft 标记 → 认为已说明
        if (hasAnyExplanationComment(node)) return

        context.report({
          node: node.body || node,
          messageId: 'emptyCatch',
        })
      },
    }
  },
}

export default rule
