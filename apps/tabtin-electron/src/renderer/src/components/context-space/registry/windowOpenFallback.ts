/**
 * windowOpenFallback — W8 L33 / L88 收敛
 *
 * `isModifierExternalDisposition`：把 main 进程 setWindowOpenHandler 透传的
 * Chromium WindowOpenHandlerDetails.disposition 映射到 D2 第 5 层 modifierExternal。
 *
 * 业务背景：
 *   - ⌘+click（macOS）/ Ctrl+click（Win/Linux）/ 中键 → disposition='foreground-tab'
 *   - 普通点击 / target=_blank → disposition='default' 或 'new-window'
 *   - 后台新窗口 → 'background-tab'（用户语义"后台预读，焦点不动"——不应触发系统应用打开）
 *
 * renderer 端 fallback handler 收不到原始 e.metaKey（click 已被 main 进程吞掉），
 * 所以 D2 第 5 层「⌘ 修饰键短路」在 fallback 路径只能靠 disposition 还原。
 *
 * 抽到独立模块的两层考虑：
 *   1. registry/index.ts 顶层 import 链路较重（拉 contextRegistry / handlers /
 *      stores），单元测试只想测 disposition 映射不应被那条链路阻塞
 *   2. 任何 Chromium / Electron 版本升级带来的 disposition 字段变化都能在
 *      `windowOpenFallback.test.ts` 守门 fail，提示需要同步映射
 */

export function isModifierExternalDisposition(disposition: string | undefined): boolean {
  return disposition === 'foreground-tab'
}
