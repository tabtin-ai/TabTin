/**
 * 把 zod-to-json-schema 输出的 `anyOf` 升级为 `oneOf + discriminator: {propertyName: type}`。
 *
 * 触发条件（保守判定，避免误伤）：
 *   - 是 `anyOf` 数组
 *   - 每个 variant 都是 object 且含 `properties.type` 是 literal const string
 *
 * 这样 datamodel-codegen 0.57.0 看到 `oneOf + discriminator` 才能生成
 * `Annotated[Union[...], Field(discriminator='type')]`（虽然仍是 v1 老语法，但
 * 后续 post_pydantic.py 会再升到 v2 新语法 `Discriminator('type')`）。
 *
 * 递归处理嵌套 union（snapshot.kind 等二级 discriminator）。
 *
 * 不修改 anyOf 中含 `null` variant 的（如 `string | null`）—— 这种是 nullable
 * 字段，不是 tagged union。
 */
type JsonSchema = Record<string, unknown>;

const isObj = (x: unknown): x is JsonSchema => typeof x === 'object' && x !== null && !Array.isArray(x);

function tryGetTypeLiteral(variant: unknown): { property: string; const: string } | null {
  if (!isObj(variant)) return null;
  const props = variant['properties'];
  if (!isObj(props)) return null;
  // 已知 wire 协议 discriminator 字段（按优先级）；新增 union 时在此追加。
  for (const propName of ['type', 'kind', 'event_type', 'tool_name', 'approval_type']) {
    const p = props[propName];
    if (isObj(p) && typeof p['const'] === 'string') {
      return { property: propName, const: p['const'] };
    }
  }
  return null;
}

function detectDiscriminator(anyOfArr: unknown[]): string | null {
  if (anyOfArr.length < 2) return null;
  // 排除含 null/{} 的 nullable union
  const variants = anyOfArr.filter((v) => isObj(v) && v['type'] !== 'null');
  if (variants.length !== anyOfArr.length) return null;

  const found: string[] = [];
  for (const v of variants) {
    const lit = tryGetTypeLiteral(v);
    if (!lit) return null;
    found.push(lit.property);
  }
  // 所有 variant discriminator 字段名一致才算 tagged union
  if (found.every((p) => p === found[0])) return found[0]!;
  return null;
}

function transform(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(transform);
  }
  if (!isObj(node)) {
    return node;
  }

  const out: JsonSchema = {};
  for (const [k, v] of Object.entries(node)) {
    out[k] = transform(v);
  }

  if (Array.isArray(out['anyOf'])) {
    const arr = out['anyOf'];
    const discriminator = detectDiscriminator(arr);
    if (discriminator) {
      // 升级为 oneOf + discriminator
      out['oneOf'] = arr;
      delete out['anyOf'];
      out['discriminator'] = { propertyName: discriminator };
    }
  }

  return out;
}

export function injectDiscriminatorMarkers(schema: JsonSchema): JsonSchema {
  return transform(schema) as JsonSchema;
}
