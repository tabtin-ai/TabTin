/**
 * toolErrorClassification 单测 — 覆盖 Wave 2h 的 3 个分类判定和 1 个归一化。
 *
 * 目标：把"soft / hard / userInitiated / translatable / countsAsHardAnomaly"
 * 几个维度的真相表锁在测试里，后续新增 ToolErrorKind 漏配 catalog 时立即失败。
 */

import { describe, expect, it } from 'vitest'

import { TOOL_ERROR_CATALOG_DEFAULTS } from '@tabtin/tool-errors'

import {
  isSoftToolError,
  isTranslatableToolError,
  isUserInitiatedToolError,
  countsAsHardAnomaly,
  normalizeToolErrorI18nKey,
  resolveModeRestrictedI18nKey,
  TOOL_ERROR_CATALOG,
  TOOL_ERROR_UX_OVERRIDES,
} from '../toolErrorClassification'

/** Pre-Wave-2 catalog classifications that must remain byte-identical. */
const PRE_WAVE2_CATALOG_BASELINE: Record<
  string,
  { soft: boolean; translatable: boolean; countsAsAnomaly: boolean; userInitiated: boolean }
> = {
  budget_skipped: { soft: true, translatable: true, countsAsAnomaly: false, userInitiated: false },
  aborted: { soft: true, translatable: true, countsAsAnomaly: false, userInitiated: true },
  aborted_by_user: { soft: true, translatable: true, countsAsAnomaly: false, userInitiated: true },
  tool_timeout: { soft: true, translatable: true, countsAsAnomaly: true, userInitiated: false },
  execute_error: { soft: false, translatable: true, countsAsAnomaly: true, userInitiated: false },
  tool_stale_read: { soft: true, translatable: true, countsAsAnomaly: false, userInitiated: false },
  unknown_tool: { soft: false, translatable: false, countsAsAnomaly: true, userInitiated: false },
  schema_invalid: { soft: false, translatable: false, countsAsAnomaly: true, userInitiated: false },
  validate_input: { soft: false, translatable: false, countsAsAnomaly: true, userInitiated: false },
  permission_denied: { soft: false, translatable: true, countsAsAnomaly: true, userInitiated: false },
  plan_guard_deny: { soft: false, translatable: false, countsAsAnomaly: true, userInitiated: false },
  missing_required_param: { soft: false, translatable: true, countsAsAnomaly: true, userInitiated: false },
  invalid_param_format: { soft: false, translatable: true, countsAsAnomaly: true, userInitiated: false },
  param_too_large: { soft: false, translatable: true, countsAsAnomaly: true, userInitiated: false },
  mutually_exclusive_params: { soft: false, translatable: true, countsAsAnomaly: true, userInitiated: false },
  no_ui_session: { soft: false, translatable: true, countsAsAnomaly: true, userInitiated: false },
  runtime_misconfig: { soft: false, translatable: true, countsAsAnomaly: true, userInitiated: false },
  host_unsupported: { soft: false, translatable: true, countsAsAnomaly: true, userInitiated: false },
  network_failed: { soft: false, translatable: true, countsAsAnomaly: true, userInitiated: false },
  request_timeout: { soft: false, translatable: true, countsAsAnomaly: true, userInitiated: false },
  auth_failed: { soft: false, translatable: true, countsAsAnomaly: true, userInitiated: false },
  resource_not_found: { soft: false, translatable: true, countsAsAnomaly: true, userInitiated: false },
  document_not_ready: { soft: true, translatable: true, countsAsAnomaly: false, userInitiated: false },
  rate_limited: { soft: true, translatable: true, countsAsAnomaly: true, userInitiated: false },
  upstream_error: { soft: false, translatable: true, countsAsAnomaly: true, userInitiated: false },
  skill_unsupported_prefix: { soft: true, translatable: true, countsAsAnomaly: false, userInitiated: false },
  skill_not_found: { soft: false, translatable: true, countsAsAnomaly: true, userInitiated: false },
  skill_disabled: { soft: false, translatable: true, countsAsAnomaly: true, userInitiated: false },
  skill_not_ready: { soft: true, translatable: true, countsAsAnomaly: false, userInitiated: false },
  skill_not_installed: { soft: false, translatable: true, countsAsAnomaly: true, userInitiated: false },
  version_conflict: { soft: true, translatable: true, countsAsAnomaly: true, userInitiated: false },
  command_blocked_by_policy: { soft: true, translatable: true, countsAsAnomaly: true, userInitiated: false },
  command_denied_by_validator: { soft: true, translatable: true, countsAsAnomaly: true, userInitiated: false },
  mode_restricted: { soft: true, translatable: true, countsAsAnomaly: false, userInitiated: false },
  cwd_not_found: { soft: false, translatable: true, countsAsAnomaly: true, userInitiated: false },
  os_access_error: { soft: false, translatable: true, countsAsAnomaly: true, userInitiated: false },
  widget_render_failed: { soft: false, translatable: true, countsAsAnomaly: true, userInitiated: false },
  internal_error: { soft: false, translatable: true, countsAsAnomaly: true, userInitiated: false },
  file_not_found: { soft: false, translatable: true, countsAsAnomaly: true, userInitiated: false },
  file_too_large: { soft: false, translatable: true, countsAsAnomaly: true, userInitiated: false },
  encrypted: { soft: false, translatable: true, countsAsAnomaly: true, userInitiated: false },
  corrupted: { soft: false, translatable: true, countsAsAnomaly: true, userInitiated: false },
  scanned_pdf: { soft: false, translatable: true, countsAsAnomaly: true, userInitiated: false },
  garbled_text_layer: { soft: false, translatable: true, countsAsAnomaly: true, userInitiated: false },
  unsupported_format: { soft: false, translatable: true, countsAsAnomaly: true, userInitiated: false },
  parse_timeout: { soft: false, translatable: true, countsAsAnomaly: true, userInitiated: false },
  image_resize_failed: { soft: false, translatable: true, countsAsAnomaly: true, userInitiated: false },
}

describe('toolErrorClassification', () => {
  describe('isSoftToolError', () => {
    it('budget_skipped / aborted / aborted_by_user / tool_timeout 是软错误', () => {
      expect(isSoftToolError('budget_skipped')).toBe(true)
      expect(isSoftToolError('aborted')).toBe(true)
      expect(isSoftToolError('aborted_by_user')).toBe(true)
      expect(isSoftToolError('tool_timeout')).toBe(true)
    })

    it('execute_error / permission_denied / unknown_tool 是硬错误', () => {
      expect(isSoftToolError('execute_error')).toBe(false)
      expect(isSoftToolError('permission_denied')).toBe(false)
      expect(isSoftToolError('unknown_tool')).toBe(false)
      expect(isSoftToolError('schema_invalid')).toBe(false)
    })

    it('undefined / 未知 code 按硬错误处理（保守）', () => {
      expect(isSoftToolError(undefined)).toBe(false)
      expect(isSoftToolError('nonexistent_kind')).toBe(false)
    })
  })

  describe('isUserInitiatedToolError', () => {
    it('只有 aborted 系列算用户主动', () => {
      expect(isUserInitiatedToolError('aborted')).toBe(true)
      expect(isUserInitiatedToolError('aborted_by_user')).toBe(true)
    })

    it('系统侧暂停（budget_skipped）不算用户主动', () => {
      expect(isUserInitiatedToolError('budget_skipped')).toBe(false)
      expect(isUserInitiatedToolError('tool_timeout')).toBe(false)
      expect(isUserInitiatedToolError('execute_error')).toBe(false)
    })
  })

  describe('isTranslatableToolError', () => {
    it('UX 关键的 4 个 code 走 i18n 文案', () => {
      expect(isTranslatableToolError('budget_skipped')).toBe(true)
      expect(isTranslatableToolError('aborted')).toBe(true)
      expect(isTranslatableToolError('aborted_by_user')).toBe(true)
      expect(isTranslatableToolError('tool_timeout')).toBe(true)
      expect(isTranslatableToolError('execute_error')).toBe(true)
    })

    it('已有详细 detail 的顶层 runtime kind 不翻译，工具层业务 kind 走 i18n', () => {
      expect(isTranslatableToolError('permission_denied')).toBe(true)
      expect(isTranslatableToolError('unknown_tool')).toBe(false)
      expect(isTranslatableToolError('schema_invalid')).toBe(false)
      expect(isTranslatableToolError('plan_guard_deny')).toBe(false)
    })
  })

  describe('countsAsHardAnomaly', () => {
    it('Wave 2h R1：budget_skipped / aborted 不算异常（折叠视图不报红）', () => {
      expect(countsAsHardAnomaly('budget_skipped')).toBe(false)
      expect(countsAsHardAnomaly('aborted')).toBe(false)
      expect(countsAsHardAnomaly('aborted_by_user')).toBe(false)
    })

    it('execute_error / permission_denied / tool_timeout 算异常', () => {
      expect(countsAsHardAnomaly('execute_error')).toBe(true)
      expect(countsAsHardAnomaly('permission_denied')).toBe(true)
      expect(countsAsHardAnomaly('tool_timeout')).toBe(true)
    })

    it('没有 errorCode（旧 runtime）保守视为异常，保护老行为', () => {
      expect(countsAsHardAnomaly(undefined)).toBe(true)
      expect(countsAsHardAnomaly(undefined as unknown as string)).toBe(true)
    })
  })

  describe('normalizeToolErrorI18nKey', () => {
    it('aborted_by_user 归一到 aborted，避免 locale 重复键', () => {
      expect(normalizeToolErrorI18nKey('aborted_by_user')).toBe('aborted')
    })

    it('其它 code 原样返回', () => {
      expect(normalizeToolErrorI18nKey('budget_skipped')).toBe('budget_skipped')
      expect(normalizeToolErrorI18nKey('execute_error')).toBe('execute_error')
      expect(normalizeToolErrorI18nKey('tool_timeout')).toBe('tool_timeout')
    })
  })

  // ─── P1-7 修复（2026-05-27）：resolveModeRestrictedI18nKey 子键映射 ──
  //
  // **背景**：mode_restricted 错误的细粒度 i18n humanize 链路缺前端单测。
  // 6 个 deny_code → 6 个 `mode_restricted_<deny_code>` 子键的映射如果
  // 因 typo / 漏配出错，UI 会静默退化到通用 `mode_restricted` 文案——
  // 用户卡片就少了关键信息（"为什么被拒 / 怎么办"）。
  //
  // 本测试集守护：6 个 deny_code 必须各自映射到正确子键 + 缺失场景 fallback。
  describe('resolveModeRestrictedI18nKey · 6 种 deny_code 子键映射', () => {
    const DENY_CODES = [
      'mode_disallowed_tool',
      'mode_tool_only_in_plan',
      'no_active_plan',
      'wrong_target_document',
      'invalid_document_id_type',
      'mode_disallowed_path',
    ] as const

    for (const denyCode of DENY_CODES) {
      it(`deny_code='${denyCode}' → mode_restricted_${denyCode}`, () => {
        expect(resolveModeRestrictedI18nKey(denyCode)).toBe(`mode_restricted_${denyCode}`)
      })
    }

    it('缺 deny_code（undefined）→ fallback mode_restricted', () => {
      expect(resolveModeRestrictedI18nKey(undefined)).toBe('mode_restricted')
    })

    it('未知 deny_code（不在白名单内）→ fallback mode_restricted（防 typo 漏配）', () => {
      expect(resolveModeRestrictedI18nKey('something_new_we_did_not_register')).toBe('mode_restricted')
      expect(resolveModeRestrictedI18nKey('')).toBe('mode_restricted')
    })

    it('每个 mode_restricted_* 子键都有 i18n 文案登记（en-US / zh-CN）', async () => {
      // i18n 真实文件检查（防止 catalog 加新 deny_code 但 locales 漏配）。
      const fs = await import('node:fs')
      const path = await import('node:path')
      const repoRoot = path.resolve(__dirname, '../../../../../../../../../')
      const localeDir = path.join(repoRoot, 'apps/tabtin-electron/src/renderer/src/i18n/locales')
      for (const locale of ['en-US', 'zh-CN']) {
        const chatJson = JSON.parse(
          fs.readFileSync(path.join(localeDir, locale, 'chat.json'), 'utf-8'),
        ) as { toolError: Record<string, string> }
        // 通用 fallback 必须存在
        expect(chatJson.toolError.mode_restricted, `${locale} missing toolError.mode_restricted`).toBeTruthy()
        for (const denyCode of DENY_CODES) {
          const key = `mode_restricted_${denyCode}`
          expect(
            chatJson.toolError[key],
            `${locale}/chat.json: toolError.${key} missing — add localization for new deny_code`,
          ).toBeTruthy()
        }
      }
    })
  })

  describe('catalog 完整性', () => {
    it('Wave 2：defaults + UX overrides 合并后保持全部既有分类值', () => {
      expect(Object.keys(TOOL_ERROR_CATALOG_DEFAULTS).length).toBeGreaterThan(0)
      for (const [kind, expected] of Object.entries(PRE_WAVE2_CATALOG_BASELINE)) {
        expect(TOOL_ERROR_CATALOG[kind], `missing catalog entry for ${kind}`).toEqual(expected)
      }
    })

    it('每个手工 UX override 必须至少改变一个 generated default 字段', () => {
      for (const [kind, override] of Object.entries(TOOL_ERROR_UX_OVERRIDES)) {
        const generatedDefault = TOOL_ERROR_CATALOG_DEFAULTS[kind]
        expect(
          generatedDefault,
          `UX override ${kind} must target a generated catalog default`,
        ).toBeDefined()
        expect(
          Object.entries(override).some(
            ([field, value]) =>
              generatedDefault[field as keyof typeof generatedDefault] !== value,
          ),
          `UX override ${kind} is identical to its generated default — remove it`,
        ).toBe(true)
      }
    })

    it('generated defaults cover every catalog key used by helpers', () => {
      for (const kind of Object.keys(PRE_WAVE2_CATALOG_BASELINE)) {
        expect(
          TOOL_ERROR_CATALOG_DEFAULTS[kind],
          `missing generated default for ${kind}`,
        ).toBeDefined()
      }
    })

    it('runtime ToolErrorKind 枚举里的 9 个 W2h kind 都在 catalog 中', () => {
      // 这份硬编码列表对齐 `packages/agent-runtime/src/engine/tool-error.ts`
      // 的 ToolErrorKind。runtime 新增 kind 时这里会失败提醒。
      const runtimeKinds = [
        'unknown_tool',
        'schema_invalid',
        'validate_input',
        'permission_denied',
        'plan_guard_deny',
        'aborted',
        'budget_skipped',
        'tool_timeout',
        'execute_error',
      ]
      for (const kind of runtimeKinds) {
        expect(TOOL_ERROR_CATALOG[kind], `missing catalog entry for ${kind}`).toBeDefined()
      }
    })

    it('W1 file pipeline 专属 ToolErrorKind 全部在 catalog 中且 translatable（自动遍历 SSoT，加新 kind 自动覆盖）', async () => {
      // **W1.3 第 3 轮 Review 3 M-5（2026-05-13）**：原硬编码 8 字面值，新增类时需要手动
      // 同步本测试列表——本测试本意防漂移但自己也是漂移源。改为从 SSoT 包（通过 local-docparse
      // re-export，与 main process 同款 import 路径）导入 `FILE_PIPELINE_ERROR_KINDS` 自动
      // 遍历（减去与顶层 W13 entry 复用的 5 类：permission_denied / aborted / network_failed /
      // invalid_param_format / upstream_error）。SSoT 加 1 类 → 本测试自动覆盖。
      //
      // **W5 L17 / L38（2026-05-14）**：硬编码"应为 8 类（13 - 5 共享）"防御性断言改为
      // 动态推算"specific = total - sharedWithTopLevel.size"——SSoT 加 IMAGE_RESIZE_FAILED
      // 后 14 - 5 = 9 类，旧硬编码 8 立即 fail（反思 §八 #14 / #15 教训：SSoT 加新条目时
      // 测试硬编码立刻退化）。改为推算后 SSoT 任意扩缩本测试自动跟随。
      const { FILE_PIPELINE_ERROR_KINDS, FilePipelineErrorCode } = await import('@tabtin/local-docparse')
      const sharedWithTopLevel = new Set<string>([
        FilePipelineErrorCode.PERMISSION_DENIED,
        FilePipelineErrorCode.USER_ABORTED,
        FilePipelineErrorCode.NETWORK_ERROR,
        FilePipelineErrorCode.INVALID_PARAMETER,
        FilePipelineErrorCode.UNKNOWN_ERROR,
      ])
      const filePipelineSpecific = FILE_PIPELINE_ERROR_KINDS.filter(
        (k) => !sharedWithTopLevel.has(k),
      )
      // 动态推算：total - 已共享 = 专属类数；让 SSoT 扩到 N 类后本测试自动跟随
      // （而不是退化为"硬编码常数失配 → 维护负担转嫁回测试"反模式）
      expect(filePipelineSpecific.length).toBe(
        FILE_PIPELINE_ERROR_KINDS.length - sharedWithTopLevel.size,
      )
      // sanity check：sharedWithTopLevel 5 类必须真在 SSoT 集合中（否则推算错位）
      for (const shared of sharedWithTopLevel) {
        expect(
          (FILE_PIPELINE_ERROR_KINDS as readonly string[]).includes(shared),
          `sharedWithTopLevel ${shared} must exist in FILE_PIPELINE_ERROR_KINDS`,
        ).toBe(true)
      }
      for (const kind of filePipelineSpecific) {
        expect(TOOL_ERROR_CATALOG[kind], `missing catalog entry for file pipeline kind: ${kind}`).toBeDefined()
        expect(TOOL_ERROR_CATALOG[kind].translatable, `file pipeline kind ${kind} should be translatable`).toBe(true)
      }
    })

    it('PRD 08 W13 新增的 ToolErrorKind 都在 catalog 中', () => {
      // 对齐 `packages/agent-runtime/src/engine/error-kinds.ts::TOOL_ERROR_KINDS`。
      // 任何运行时新增 kind 但前端 catalog 漏配 → 这里 fail，避免错误流到
      // GenericToolCard 时找不到 `translatable` 配置导致裸 JSON 兜底。
      const w13Kinds = [
        'missing_required_param',
        'invalid_param_format',
        'param_too_large',
        'mutually_exclusive_params',
        'no_ui_session',
        'runtime_misconfig',
        'host_unsupported',
        'network_failed',
        'request_timeout',
        'auth_failed',
        'permission_denied',
        'resource_not_found',
        'document_not_ready',
        'rate_limited',
        'upstream_error',
        'skill_unsupported_prefix',
        'skill_not_found',
        'skill_disabled',
        'skill_not_ready',
        'skill_not_installed',
        // W3 (2026-05-10): tool_result_not_found removed.
        'version_conflict',
        'tool_stale_read',
        'command_blocked_by_policy',
        'command_denied_by_validator',
        'mode_restricted',
        'cwd_not_found',
        'os_access_error',
        'widget_render_failed',
        'internal_error',
      ]
      for (const kind of w13Kinds) {
        expect(TOOL_ERROR_CATALOG[kind], `missing catalog entry for W13 kind: ${kind}`).toBeDefined()
        expect(TOOL_ERROR_CATALOG[kind].translatable, `W13 kind ${kind} should be translatable`).toBe(true)
      }
    })
  })
})
