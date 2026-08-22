/**
 * @tabtin/chat-client 类型边界 — snake_case ↔ camelCase 转换工具
 *
 * **背景**(charter v1.8 §4.4 + Wave 6 mini 二次验证 P1):
 *   chat-client schema 沿用后端 Django/REST 习惯(snake_case),main 进程 types
 *   沿用 Electron/JS 习惯(camelCase),两侧的转换历史上散落在 resolver、
 *   navigator、handler 多个位置,易产生"字段加在 schema 但前端 0 处使用"
 *   的死字段(参见反思 14/20 — Wave 6 续作 `TrackerRunMeta.artifact_ref` 死
 *   字段事件)。
 *
 * **本模块定位**:
 *   - 提供小而稳定的 helper,只负责"键名转换",不假设业务语义
 *   - 关键 helper 同时提供**类型层**映射(`SnakeToCamel<T>`)与**运行时**实现
 *   - 真实业务的"边界"按 `README.md → 类型边界约定`走两个固定位置:
 *       1) 后端 envelope 序列化(`apps/tabtin_django/apps/scheduler/services/
 *          goal_notification.py` `_extract_artifact_ref`)
 *       2) 前端 resolver 入口(`apps/tabtin-electron/src/renderer/src/
 *          services/notificationTargetResolver.ts`)
 *     不在 manager / handler / store 里二次混用。
 *
 * **不要做的事**:
 *   - 不要在业务调用方"按需 inline 转换"——一定走 README 指定的边界文件
 *   - 不要把这套 helper 用作"通用 JSON 改名工具",它只服务 chat-client schema
 *     ↔ main types 这条专属链路
 */

// ── 类型层:键名 snake_case ↔ camelCase ──────────────────────────

/**
 * 把 snake_case 字符串字面量类型转为 camelCase 字符串字面量类型。
 *
 * @example
 *   type T1 = SnakeToCamelKey<'artifact_id'>     // 'artifactId'
 *   type T2 = SnakeToCamelKey<'record_ids'>      // 'recordIds'
 *   type T3 = SnakeToCamelKey<'already_camel'>   // 'alreadyCamel'
 *   type T4 = SnakeToCamelKey<'doc'>             // 'doc'(无下划线原样返回)
 */
export type SnakeToCamelKey<S extends string> = S extends `${infer Head}_${infer Tail}`
  ? `${Head}${Capitalize<SnakeToCamelKey<Tail>>}`
  : S

/**
 * 把 camelCase 字符串字面量类型转为 snake_case 字符串字面量类型。
 *
 * 实现说明:对每个大写字符 `X` 替换为 `_x`,首字符大写视情况(本模块不期望
 * 收到首字大写的 PascalCase,只针对 camelCase)。
 *
 * @example
 *   type T1 = CamelToSnakeKey<'artifactId'>      // 'artifact_id'
 *   type T2 = CamelToSnakeKey<'recordIds'>       // 'record_ids'
 *   type T3 = CamelToSnakeKey<'doc'>             // 'doc'
 */
export type CamelToSnakeKey<S extends string> = S extends `${infer Head}${infer Tail}`
  ? Tail extends Uncapitalize<Tail>
    ? `${Head}${CamelToSnakeKey<Tail>}`
    : `${Head}_${Lowercase<Extract<Tail[0], string>>}${CamelToSnakeKey<Slice1<Tail>>}`
  : S

// 辅助:从字符串字面量中切去第一个字符
type Slice1<S extends string> = S extends `${string}${infer Rest}` ? Rest : S

/**
 * 把对象类型 T 的所有顶层键 snake_case → camelCase。
 *
 * @example
 *   type Original = { artifact_id?: string; record_ids?: string[]; doc?: string }
 *   type Mapped = SnakeToCamel<Original>
 *   //   ⇒ { artifactId?: string; recordIds?: string[]; doc?: string }
 */
export type SnakeToCamel<T> = {
  [K in keyof T as K extends string ? SnakeToCamelKey<K> : K]: T[K]
}

/**
 * 把对象类型 T 的所有顶层键 camelCase → snake_case。
 *
 * @example
 *   type Original = { artifactId?: string; recordIds?: string[] }
 *   type Mapped = CamelToSnake<Original>
 *   //   ⇒ { artifact_id?: string; record_ids?: string[] }
 */
export type CamelToSnake<T> = {
  [K in keyof T as K extends string ? CamelToSnakeKey<K> : K]: T[K]
}

// ── 运行时:键名转换实现 ────────────────────────────────────────

/**
 * snake_case 字符串 → camelCase 字符串。
 *
 * - 连续多个下划线被视为一段,后续首字母大写(`a__b` → `aB`)
 * - 末尾下划线被忽略(`a_` → `a`)
 * - 没有下划线原样返回
 * - 空串原样返回
 */
export function snakeToCamelKey(key: string): string {
  if (!key) return key
  return key.replace(/_+([a-zA-Z])/g, (_, c: string) => c.toUpperCase()).replace(/_+$/, '')
}

/**
 * camelCase 字符串 → snake_case 字符串。
 *
 * - 每个大写字符前插入下划线并小写化
 * - 首字符是大写(PascalCase)时不加前导下划线,只小写化
 * - 没有大写字符原样返回
 */
export function camelToSnakeKey(key: string): string {
  if (!key) return key
  return key.replace(/([A-Z])/g, (_, c: string, offset: number) =>
    offset === 0 ? c.toLowerCase() : `_${c.toLowerCase()}`,
  )
}

/**
 * 浅层把对象的顶层键 snake_case → camelCase(值原样不递归)。
 *
 * 适用于扁平的 schema 边界对象(如 `ArtifactRef`),**不**用于嵌套深层
 * 业务对象 — 嵌套深层走对应 schema 类型,不要把它当 generic JSON walker。
 *
 * 当输入不是 plain object(null / array / 基本类型)时,原样返回以避免
 * 在调用方处必须额外做类型守卫。
 */
export function snakeToCamelObject<T extends Record<string, unknown>>(
  obj: T,
): SnakeToCamel<T> {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return obj as unknown as SnakeToCamel<T>
  }
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    result[snakeToCamelKey(key)] = value
  }
  return result as SnakeToCamel<T>
}

/**
 * 浅层把对象的顶层键 camelCase → snake_case(值原样不递归)。
 *
 * 适用范围与限制同 `snakeToCamelObject`。
 */
export function camelToSnakeObject<T extends Record<string, unknown>>(
  obj: T,
): CamelToSnake<T> {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return obj as unknown as CamelToSnake<T>
  }
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    result[camelToSnakeKey(key)] = value
  }
  return result as CamelToSnake<T>
}
