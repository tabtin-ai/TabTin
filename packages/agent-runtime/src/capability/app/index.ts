/**
 * `@tabtin/agent-runtime/capability/app` —— App 类 Capability barrel。
 *
 * **App 范畴**（capability.ts 的 CapabilityCategory 注释）：
 *   - 内置 App 的 Agent 侧入口（未来的 TabMemo / TabAgenda 等）
 *   - 与 core 类（FileSystem / Shell / Skills）区分；与 governance 类
 *     （Audit / Cost / Permission）区分
 *   - 工具命名以 App id 为前缀（`tabdoc_*` / `tabmemo_*`），与
 *     `packages/apps/<id>/app.json::id` 对齐
 *
 * **当前状态（2026-05-04 Wave 12 tabdoc CLI 退役）**：本 barrel **暂无可
 * 导出的 App Cap**。历史上的 `TabDataCap` / `TabDocCap` 都已退役，对应能力
 * 走 CLI（`tabtin table *` / `tabtin doc *`）。如未来需要新的 App Cap
 * （例如 `TabMemoCap`），新文件挂在 `app/<cap>.ts`，从本 barrel re-export。
 *
 * **历史记录**：
 *   - Wave 4a (2026-05-01)：`TabDataCap` 删除（D4 全删 FC）
 *   - Wave 12 (2026-05-04)：`TabDocCap` 删除（产品方向：tabdoc 主要靠 CLI 操作，
 *     不依赖 FC；capability 层装配的是 NOT_WIRED stub，未真实暴露给 LLM）
 */

export {};
