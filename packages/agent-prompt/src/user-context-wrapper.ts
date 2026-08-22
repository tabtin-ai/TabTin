/**
 * 兼容再导出：实现已迁至 `@tabtin/agent-runtime`
 * （ Stage 2c）。
 *
 * **禁止**从 `@tabtin/agent-runtime` 根 barrel 或 `./engine` god-barrel 再导出——
 * 二者会把 `node:crypto` / `node:fs` 拖进 Electron Renderer。
 * 浏览器 / Vite 客户端与本包再导出一律走 leaf 子路径。
 */

export {
  buildUserContextWrapper,
  findFirstUserContextWrapper,
  findAllUserContextWrappers,
  VALID_USER_CONTEXT_WRAPPER_TYPES,
  type UserContextWrapperType,
  type UserContextWrapperAttrs,
  type ParsedUserContextWrapper,
} from '@tabtin/agent-runtime/engine/user-context-wrapper'
