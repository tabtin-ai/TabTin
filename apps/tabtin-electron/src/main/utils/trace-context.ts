/**
 * 主进程 trace_id 上下文（Wave 1 D3 / contract 项目）。
 *
 * 业务目标：用户截图含 "操作失败 (req: a3b2c1)" → 开发者拿 a3b2c1
 * 直接 grep main log + Django log 命中同一条调用链。本模块负责让
 * trace_id 在 main 进程内部跨 await 边界不丢失，并自动注入到三个
 * 边界点：
 *
 *   1. IPC handler 入口（renderer → main）：每次 invoke 进来时由
 *      `guardedHandle` / `ipc-lazy` stub 启动一个 trace context；
 *      handler 内部直到 await 链尾的所有 envelope 自动 stamp 同一个
 *      trace_id。
 *   2. HTTP 出口（main → Django）：`api-proxy.ts::executeApiRequestWithRetry`
 *      在发请求前从 ALS 读 trace_id，写入 `X-Request-Id` 请求头；
 *      Django middleware 看到 header 就用它（不另 generate）。
 *   3. envelope 写入（main → renderer）：`okResponse` / `errResponse`
 *      产物经 `stampTraceIntoEnvelope` 自动加上 trace_id；renderer 端
 *      Wave 2 preload shim 把末 6 位渲染到 toast。
 *
 * ─── 为什么用 AsyncLocalStorage ─────────────────────────────────────
 *
 * 一个 IPC handler 在 await 链里可能调用：
 *   - api-proxy 发 HTTP 请求（要注入 X-Request-Id）
 *   - 多个 service 函数（每一处 errResponse 都该带 trace_id）
 *   - 嵌套 Promise.all / setImmediate / 微任务 chain
 *
 * 用全局变量做 trace 会被并发请求互相覆盖；用参数手动透传会污染所有
 * 业务函数签名，并且漏一处就丢一段调用链。Node.js 的 `node:async_hooks`
 * 提供了 `AsyncLocalStorage`，原生跟 Promise / async 函数 / setTimeout
 * / EventEmitter 全部 hook 上，跨 await 边界自动复制 store——这正是
 * 为什么本模块没采用其他变通方案（譬如自建 Map<promise, traceId>）。
 *
 * ─── 模块职责边界 ─────────────────────────────────────────────────
 *
 * 本模块只解决"main 进程内 trace 流转"。**不**做：
 *   - W2 preload shim：从 envelope.trace_id 拿到 toast 末 6 位
 *     （由 `apps/tabtin-electron/src/preload/ipc-shim.ts` 在 W2 落地）
 *   - W5 audit log：把 trace_id 当跨表 join key 写到本地审计文件
 *     （由 W5 wave 在 surface 框架就位后落地）
 *   - Daemon CLI server / cli-binary：与本模块独立的 Node 进程，需要
 *     在 daemon 进程自己 mirror 一份 ALS（Wave 1 不在范围）
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { nanoid } from 'nanoid'

/**
 * Trace context store。
 *
 * 当前只有 `trace_id` 一个字段。未来 Wave 5 audit log 需要再加
 * `user_id` / `space_id` 时直接扩展这个 interface，不要改成 `Map`
 * 或 `Record<string, unknown>`——Type 化的 store 能让消费侧通过
 * IDE 自动补全发现可用字段。
 */
export interface TraceContext {
  trace_id: string
}

/**
 * 单例 ALS。导出仅供测试（譬如 `tests/trace-context.test.ts` 直接
 * `enterWith` 注入固定 trace 验证 envelope 写入路径）。生产代码请用
 * 下方暴露的 helper，不要直接操作 `traceContextStorage`。
 */
export const traceContextStorage = new AsyncLocalStorage<TraceContext>()

/**
 * 生成一个 trace_id。
 *
 * 长度 12 个字符（base62）→ 约 71 bit 熵，每秒生成 1000 个的话碰撞
 * 概率约 10^-9 量级，足够单机短时间窗口内唯一；末 6 位（约 36 bit）
 * 在 toast / 截图场景下作为索引也够稳。
 *
 * 选 nanoid 而不是 uuid v4：
 *   - 字符集 base62（无 `-`），grep 时不需要转义
 *   - 12 字符比 uuid 36 字符更短，便于截图时用户读出末 6 位
 *   - 已在 electron 包 dependencies 里（preload / renderer 之前用过），
 *     不引入新依赖
 *
 * `request_id` 这个名字在 Django middleware 里是 `{timestamp}_{random}`
 * 格式（譬如 `20260503105500_a3b2c1d4`）。我们 main 端如果先 generate
 * 然后通过 X-Request-Id 传给 Django，Django middleware 会**直接用 main
 * 端发的字符串**而不是它自己 generate 的格式——所以 nanoid 形态会
 * 流到 Django log 里，这是预期行为，不要混淆"格式应该跟 Django 一致"。
 */
export function generateTraceId(): string {
  return nanoid(12)
}

/**
 * 读当前 ALS context 的 trace_id。
 *
 * 不在 trace context 内（譬如 main 进程启动早期同步代码）返
 * `undefined`——调用方应当判空，不要默认 `''` / `'unknown'`。
 * 默认值会污染 audit log 跨表 join 的语义。
 */
export function getCurrentTraceId(): string | undefined {
  return traceContextStorage.getStore()?.trace_id
}

/**
 * 在指定 trace_id 下执行 fn。同步 / 异步 fn 都支持（ALS 会跟着
 * Promise / setTimeout / queueMicrotask 链向下传递）。
 *
 * 嵌套调用合法但语义是"内层 trace 覆盖外层 trace 直到 fn 结束"——
 * 当前没有"恢复外层 trace"的需求，如果未来需要请显式实现而不是
 * 依赖嵌套自动堆栈。
 */
export function runWithTraceId<T>(traceId: string, fn: () => T): T {
  return traceContextStorage.run({ trace_id: traceId }, fn)
}

/**
 * 自动 generate 一个 trace_id 并在该 context 下执行 fn。
 *
 * IPC handler 入口默认走这条路径。**不要**在 fn 内部再次调用
 * `runWithGeneratedTrace` 嵌套——会产生新 trace，跟外层失联。
 */
export function runWithGeneratedTrace<T>(fn: () => T): T {
  return traceContextStorage.run({ trace_id: generateTraceId() }, fn)
}

/**
 * 修改当前 ALS context 的 trace_id。
 *
 * 主要用途：**HTTP 响应反读**——main 发请求时 X-Request-Id 是 ALS
 * 当前值；如果 Django 因为某种原因 echo 回来的是别的字符串（譬如
 * Django middleware 配置错误重新 generate），调用方有必要把权威值
 * 写回 ALS，让后续 envelope 的 trace_id 跟 Django log 一致。
 *
 * 不在 ALS context 内调用（store 为 undefined）会被静默忽略——
 * 抛错没意义，调用方此时也没什么补救动作。
 */
export function setCurrentTraceId(traceId: string): void {
  const store = traceContextStorage.getStore()
  if (store) {
    store.trace_id = traceId
  }
}

/**
 * Envelope 形态识别 + trace_id 自动 stamp。
 *
 * 检查 value 是否是 wire envelope（`{ ok: boolean, ... }`），是的话
 * 在没有 trace_id 时 mutate 加上当前 ALS 的 trace_id；不是的话原样返。
 *
 * 为什么是 mutate 而不是浅拷贝：
 *   - main 端的 envelope 是临时构造的（来自 `errResponse` / `okResponse`
 *     的工厂调用），调用方不会持有引用做后续比较
 *   - 拷贝会把 `data: T` 这个潜在大对象重新分配，浪费 GC
 *   - 唯一例外是 W0 期的 `UNAUTHORIZED_REJECT_RESPONSE` deep-frozen
 *     singleton——本 helper 不能 mutate frozen 对象。`guarded-handle.ts`
 *     在 W1 D3 改造中已升级为 `buildUnauthorizedReject()` 工厂，每次
 *     调用产生独立 envelope（详见该文件注释）。
 *
 * `value` 是 `unknown`：调用方传过来的 handler return 值，类型不可知；
 * 这里只在确认是 envelope 形态时才 stamp。返回类型保持原 `T`，调用
 * 方拿到的还是原引用。
 */
export function stampTraceIntoEnvelope<T>(value: T): T {
  if (!value || typeof value !== 'object') return value
  const obj = value as Record<string, unknown>
  if (!('ok' in obj)) return value
  if (typeof obj.ok !== 'boolean') return value
  if ('trace_id' in obj) return value
  const traceId = getCurrentTraceId()
  if (traceId === undefined) return value
  obj.trace_id = traceId
  return value
}

/**
 * 仅供测试：清空当前 ALS context（脱离 trace 上下文）。
 *
 * vitest 的 `beforeEach` / `afterEach` 不会自动重置 ALS——一个 test
 * 内 `enterWith` 设置的 store 会泄漏到下一个 test。本 helper 提供
 * 显式 disable。生产代码不要调。
 */
export function __disableTraceContextForTesting(): void {
  traceContextStorage.disable()
}
