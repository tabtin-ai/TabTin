/**
 * 向后兼容 shim —— 真正的实现已拆分至 `./ContextTabs/index.tsx` + 子组件目录。
 *
 * 拆分动机（Wave 3 T6）：
 *   - 原文件 ~500 行混合 OverflowPopover + GroupTab + NormalTab + 大量状态
 *   - 难以单独测试每个 tab 类型
 *   - Wave 3 同时引入"关闭动画 + tabdoc dirty 指示符"，没有结构拆分会让单文件超过 700 行
 *
 * 任何外部代码继续使用 `import { ContextTabs } from '@components/context-space/ContextTabs'`
 * 就能拿到拆分后的实现 —— TypeScript / Vite 模块解析优先 .tsx 文件，因此本 shim
 * 必须存在；删除本文件会让默认解析落到 `./ContextTabs/index.tsx`，导致部分构建链
 * （deep import / chunk 名）发生变化。
 *
 * 子结构入口：
 *   - `./ContextTabs/index.tsx` —— orchestrator（组装所有 hooks + 子组件）
 *   - `./ContextTabs/NormalTab.tsx` —— 普通 tab（含关闭动画 + dirty 指示符 + 中键 + 拖拽）
 *   - `./ContextTabs/GroupTab.tsx` —— Canvas group 代表 tab（含 segment 布局 + 右键菜单）
 *   - `./ContextTabs/OverflowPopover.tsx` —— +N 溢出 popover
 *   - `./ContextTabs/hooks/useOverflowDetection.ts` —— 横向溢出检测
 *   - `./ContextTabs/hooks/useCloseAnimation.ts` —— 关闭动画状态机
 *   - `./ContextTabs/hooks/useTabDocDirtyIndicator.ts` —— tabdoc dirty 指示符订阅
 */
export { ContextTabs } from './ContextTabs/index'
