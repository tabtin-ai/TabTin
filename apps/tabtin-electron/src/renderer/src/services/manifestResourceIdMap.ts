/**
 * manifestResourceIdMap — manifest 驱动的 app id 反查表。
 *
 * 提供两类查询，均通过 `import.meta.glob` 静态聚合 `packages/apps/<id>/app.json`：
 *
 *   1. `getResourceIdEnvelopeKey(appId)` — "envelope 中哪个字段是 resource id"，
 *      对应 manifest `agentIntegration.contextFields[].isResourceId=true`。`label`
 *      是 backend payload 的字段名（snake_case），envelope 走 camelCase 形态
 *      （与 Tracker 链接历史约定一致），这里做 snake → camel 转换。
 *
 *   2. `getPrimaryContextRefTypeForApp(appId)` — "产物指针的 ContextRefType
 *      `<type>` 轴用什么"，对应 manifest 顶层 `opens.types[0].type`（W2 与
 *      RFC §10.3 定的 D5 自有格式 path layout）。
 *
 * 设计哲学（D1 manifest 即 SSOT）：新加 `packages/apps/<新 app>` 只需在
 * manifest 里标注，本表自动收录，零 PR 维护成本——任何 app id / type / scheme
 * 字面量在业务代码里硬编码都是 D1 反例。
 */

interface ManifestField {
  name?: string
  label?: string
  isResourceId?: boolean
}

interface ManifestOpensTypeEntry {
  type?: string
  priority?: number
}

interface ManifestWithReverseLookup {
  id?: string
  agentIntegration?: {
    contextFields?: ManifestField[]
  }
  opens?: {
    types?: ManifestOpensTypeEntry[]
  }
}

const manifestModules = import.meta.glob<ManifestWithReverseLookup>(
  '../../../../../../../../packages/apps/*/app.json',
  { eager: true, import: 'default' },
)

/** 把 `memo_id` → `memoId` / `code_path` → `codePath` 等 snake → camel。 */
function snakeToCamel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())
}

interface ResourceIdFieldSpec {
  /** envelope 中真实使用的 key（camelCase，与 buildArtifactLink 历史约定一致） */
  envelopeKey: string
  /** manifest 原始 label（snake_case），便于调试 / 后续兼容 */
  manifestLabel: string
}

const _appIdToResourceIdField: Record<string, ResourceIdFieldSpec> = {}
const _appIdToPrimaryContextRefType: Record<string, string> = {}

for (const manifest of Object.values(manifestModules)) {
  if (!manifest || typeof manifest !== 'object') continue
  const appId = manifest.id
  if (!appId || typeof appId !== 'string') continue
  // 反查 1：isResourceId envelope key
  const fields = manifest.agentIntegration?.contextFields ?? []
  for (const f of fields) {
    if (!f || !f.isResourceId) continue
    const label = typeof f.label === 'string' && f.label.trim() ? f.label : f.name
    if (!label) continue
    _appIdToResourceIdField[appId] = {
      envelopeKey: snakeToCamel(label),
      manifestLabel: label,
    }
    break // 一个 app 只取第一个 isResourceId（manifest schema 也仅期望声明一个）
  }
  // 反查 2：opens.types[0].type 作为 ContextRefType primary
  const opensTypes = manifest.opens?.types ?? []
  for (const t of opensTypes) {
    if (t && typeof t.type === 'string' && t.type.trim()) {
      _appIdToPrimaryContextRefType[appId] = t.type
      break // priority desc 假设由 W2 manifest 校验脚本保证；本表只取声明顺序首项
    }
  }
}

/**
 * 兼容性别名表：少量历史 envelope key 与 manifest label 的 camelCase 推断对不上，
 * 这里手工列出。新 App 接入时**应当通过 manifest label 自然对齐**，避免再加新条目。
 *
 * - tabcode：manifest `label = "project_path"`（语义"项目根路径"），但
 *   `TrackerRunMeta.artifact_ref.code_path` 历史约定走 `codePath` envelope key
 *   （W6 续作 NEW-P0-1 的 buildArtifactLink 既成事实）。
 *   → manifestLabel 推断出 `projectPath`，与 envelope `codePath` 不一致；
 *     用别名表桥接，长期治理项 R-Long（RFC §11.2.2 注释）。
 */
const ENVELOPE_KEY_ALIASES: Record<string, string> = {
  // tabcode：manifest=projectPath（推断）/ envelope=codePath（既成）
  tabcode: 'codePath',
}

/**
 * 按 appId 查询"envelope 中哪个字段是 resource id"。
 *
 * 返回 undefined → manifest 未声明 isResourceId 字段，调用方应兜底用 appId
 * 自身（与原 switch default 分支语义一致）。
 */
export function getResourceIdEnvelopeKey(appId: string): string | undefined {
  if (ENVELOPE_KEY_ALIASES[appId]) return ENVELOPE_KEY_ALIASES[appId]
  return _appIdToResourceIdField[appId]?.envelopeKey
}

/**
 * 仅供测试：导出全部 appId → envelopeKey 映射，便于 unit test 守护
 * "新加产物 App manifest 即被自动识别"。
 */
export const _appIdToEnvelopeKeyForTests: Readonly<Record<string, string>> = {
  ..._appIdToResourceIdField
    ? Object.fromEntries(
        Object.entries(_appIdToResourceIdField).map(([k, v]) => [k, v.envelopeKey]),
      )
    : {},
  ...ENVELOPE_KEY_ALIASES,
}

/**
 * 按 appId 查询"产物指针 D5 自有格式 `<type>` 轴用什么 ContextRefType 字符串"。
 *
 * 反查 manifest 顶层 `opens.types[0].type`——W2 与 RFC §10.3 已对齐这一约定。
 *
 * 返回 undefined → manifest 未声明 opens.types，调用方应放弃生成自有格式
 * deep link（这种 app 通常是设备型 / 元 App，无对外打开语义）。
 */
export function getPrimaryContextRefTypeForApp(appId: string): string | undefined {
  return _appIdToPrimaryContextRefType[appId]
}

/**
 * 仅供测试：导出全部 appId → primary ContextRefType 映射。
 */
export const _appIdToPrimaryContextRefTypeForTests: Readonly<Record<string, string>> = {
  ..._appIdToPrimaryContextRefType,
}
