/**
 * 工具 inputSchema 构建器（JSON Schema Draft-07 子集）。
 *
 * 取代手写裸对象字面量 + `as unknown as Tool['inputSchema']` 强转：
 * - `arr` 的 `items` 是必填参数 —— array 永远带合法 items，杜绝漏写。
 * - 返回类型即 `JsonSchema`，可直接赋给 `Tool.inputSchema`，调用处不再强转。
 * - 可选项缺省即不写入对应 key，产出与等价手写对象逐字节一致（便于纯重构迁移）。
 *
 * 仅覆盖 `tool-schema-validator` 支持的子集：type / properties / required /
 * enum / items / minItems / maxItems / additionalProperties / default /
 * description。需要更多构造（oneOf / pattern 等）时先扩 validator 再扩本文件。
 */
import type {
  JsonSchema,
} from '../engine/contracts/tools.js';

export interface StringSchemaOptions {
  minLength?: number
  enum?: readonly string[]
  default?: string
  description?: string
}

export function str(options: StringSchemaOptions = {}): JsonSchema {
  const schema: Record<string, unknown> = { type: 'string' }
  if (options.minLength !== undefined) schema.minLength = options.minLength
  if (options.enum !== undefined) schema.enum = options.enum
  if (options.default !== undefined) schema.default = options.default
  if (options.description !== undefined) schema.description = options.description
  return schema
}

export interface ArraySchemaOptions {
  minItems?: number
  maxItems?: number
  description?: string
}

export function arr(items: JsonSchema, options: ArraySchemaOptions = {}): JsonSchema {
  const schema: Record<string, unknown> = { type: 'array' }
  if (options.minItems !== undefined) schema.minItems = options.minItems
  if (options.maxItems !== undefined) schema.maxItems = options.maxItems
  schema.items = items
  if (options.description !== undefined) schema.description = options.description
  return schema
}

export interface ObjectSchemaOptions {
  properties?: Record<string, JsonSchema>
  required?: readonly string[]
  additionalProperties?: boolean
  description?: string
}

export function obj(options: ObjectSchemaOptions = {}): JsonSchema {
  const schema: Record<string, unknown> = { type: 'object' }
  if (options.properties !== undefined) schema.properties = options.properties
  if (options.required !== undefined) schema.required = options.required
  if (options.description !== undefined) schema.description = options.description
  if (options.additionalProperties !== undefined) schema.additionalProperties = options.additionalProperties
  return schema
}

/** 顶层工具 inputSchema —— 与 `obj` 等价，仅语义标注它是工具入口 schema。 */
export function toolInput(options: ObjectSchemaOptions): JsonSchema {
  return obj(options)
}
