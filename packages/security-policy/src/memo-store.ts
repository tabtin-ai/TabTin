/**
 * memo-store.ts — `MemoStore` interface 入口
 *
 * 设计：本文件只定义 interface，**不**提供具体实现。
 * 实现归宿主层（典型在 `packages/agent-runtime/src/permissions/memo-store.ts`，
 * 由 W2 将现有 `InMemoryApprovalMemoStore` 通过 adapter 满足本接口）。
 *
 * 实现方提示：
 *   - `lookup` 是同步纯查（judge 热路径调用，禁止 await 网络）；推荐做法是
 *     内部缓存所有 entries → 调 `lookupMemo(entries, params)` helper（见
 *     `pattern-key.ts`）—— 接口契约由该 helper 统一保证 specificity 顺序与
 *     冲突解析。
 *   - `putAlways` 典型走"本地缓存先写 + fire-and-forget HTTP PUT"。失败容错
 *     由实现方自决（commit log / retry / DeliveryBatchBuffer 都可以）。
 *   - `revoke` 典型走 HTTP DELETE，再用 `replaceAll` 同步 generation。
 *   - `maybeRefetch` 由 host 在收到 WS `approval_memo_updated` 时调用；本接口
 *     只承诺"如果 server generation 比本地新就触发 refetch"。
 *   - `bootstrap` 在 host 装配 store 时主动拉一次（避免多设备首启时冷启）。
 *   - `replaceAll` 是 refetch / bootstrap 完成后批量灌入 cache 的接口。
 *
 * 这套接口故意做得最小，让 W2 实现能用 ≤30 行 adapter 把现有
 * `InMemoryApprovalMemoStore`（agent-runtime）wrap 出 `MemoStore` 实现。
 */

export type {
  MemoStore,
  MemoSyncSurface,
  ApprovalMemoEntry,
  ApprovalMemoSnapshot,
  ApprovalMemoLookupResult,
  MemoSpecificity,
} from './types-v3.js';
