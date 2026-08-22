/**
 * components/ui — renderer 端通用组件**唯一导入口**（design-system 收敛落点）
 *
 * 约定（见 apps/tabtin-electron/docs/design-system.md + 收敛计划）：
 *   - 业务模块一律从 `@components/ui` 导入通用 primitives，不直接散引
 *     `@tabtin/smartsheet-ui`，也不在业务层手写 `bg-popover` / `backdrop-blur-*` /
 *     `shadow-*` 浮层、裸 `<button>` / `<input>`。
 *   - 本层**只包裹 + 再导出** `@tabtin/smartsheet-ui`（Radix + CVA 原子/分子组件），
 *     **不重写**，避免再造双轨；renderer 专用的合规积木（如 `OverlayScrim`）在此补齐。
 *   - 在本层验证成熟、被多模块复用的 primitive，后续再提升回 `@tabtin/smartsheet-ui`。
 *
 * 浮层材质统一走 `OVERLAY_SURFACE_CLASS`（已由 smartsheet-ui 再导出），
 * 确认/编辑浮层用 `ConfirmDialog` / `Dialog` / `Sheet`，非表单自定义浮层用 `OverlayScrim`。
 *
 * Toast：Electron Vite 把 `@tabtin/smartsheet-ui` 包根 alias 到
 * `shims/smartsheet-ui-entry.ts`，`toast` / `Toaster` 与
 * `@tabtin/smartsheet-ui/toast` 同源（overlay shim），避免 packaged 双实例。
 */
export * from '@tabtin/smartsheet-ui'

export { OverlayScrim } from './OverlayScrim'
export type { OverlayScrimProps } from './OverlayScrim'
