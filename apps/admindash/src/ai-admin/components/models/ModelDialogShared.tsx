/**
 * `ModelDialogShared` — Create / Edit 共用的 form 状态 + 主表单 body。
 *
 * 为什么抽这一层：Create 和 Edit 90% 表单一样，用一份代码维护。两个上层 Dialog
 * 只负责"打开/关闭 + 提交按钮调哪个 API + audit 文案"。
 *
 * v0.1 关键约束（宪法 07 §1.3.3 + 04 §2）：
 *
 * 1. v0.1.x：model.capability_domain 必须落在 provider.capability_domains 集合内
 *    （前端选 provider 后如当前 domain 不在集合内会自动锁定为集合首项）
 * 2. 按 capability_domain 动态显示不同 panel：
 *    - chat / vision    → wire / tool / image / json_mode / caching + context_tiers + 计费
 *    - embedding        → embedding panel + 计费
 *    - asr / tts        → speech panel + 计费
 *    - image_gen / video_gen / audio_gen → media_gen panel + 计费
 * 3. 计费字段也按 billing_type 动态：token / request / time / custom
 *
 * 高级 JSON 模式：默认结构化字段；开启后用 raw JSON 编辑 capabilities_config /
 * custom_billing_config。运营改"未列出的字段"时切到高级模式。
 */

import { llmAdminApi } from '@/api/llm-admin'
import type {
  LiteLlmSearchModelItem,
  LlmAdminModel,
  LlmAdminProvider,
  ProviderScope,
} from '@/types/llm-admin'
import { AlertTriangle, Info } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CapabilityDomain } from '../../api/models'
import {
  ContextTiersField,
  type TierFormItem,
  parseTiersFromConfig,
  serializeTiersToConfig,
} from './ContextTiersField'
import {
  CACHING_MODE_OPTIONS,
  JSON_MODE_OPTIONS,
  hasJsonMode,
  toggleJsonMode,
} from './modelCapabilityOptions'

const CAPABILITY_DOMAINS: CapabilityDomain[] = [
  'chat',
  'embedding',
  'vision',
  'asr',
  'tts',
  'image_gen',
  'video_gen',
  'audio_gen',
]

const CAPABILITY_DOMAIN_LABELS: Record<CapabilityDomain, string> = {
  chat: '对话',
  embedding: '向量检索',
  vision: '图片理解',
  asr: '语音转文字',
  tts: '文字转语音',
  image_gen: '图片生成',
  video_gen: '视频生成',
  audio_gen: '音频生成',
}

const BILLING_TYPE_LABELS: Record<BillingType, string> = {
  token: '按 Token',
  request: '按次数',
  time: '按时长',
  custom: '自定义',
}

const BILLING_TYPES = ['token', 'request', 'time', 'custom'] as const
type BillingType = (typeof BILLING_TYPES)[number]

const IMAGE_INPUT_VIA_OPTIONS = [
  { value: 'base64', label: 'Base64', description: 'TabTin 下载图片后内联发送，兼容性最好' },
  { value: 'url', label: '公网 URL', description: '把 OSS 地址直接交给模型拉取' },
  { value: 'file_id', label: '厂商文件 ID', description: '使用 ms:// 等厂商文件引用' },
] as const

const IMAGE_FORMAT_OPTIONS = [
  { value: 'jpeg', label: 'JPEG' },
  { value: 'png', label: 'PNG' },
  { value: 'webp', label: 'WebP' },
  { value: 'gif', label: 'GIF' },
  { value: 'bmp', label: 'BMP' },
  { value: 'heic', label: 'HEIC' },
] as const

// capabilities_config 的"启发"字段——每个 domain 关心的子键。
// 这里只用作"前端默认填什么"，运营改了也存到 raw JSON。
interface ChatVisionCfg {
  // wire 子键
  wire_protocol: string // openai_chat_completions / anthropic_messages / gemini_generate_content
  stream_supported: boolean
  // tool 子键
  tool_enabled: boolean
  // image 子键
  image_enabled: boolean
  image_input_via_csv: string // "base64,url,file_id"
  image_formats_csv: string // "jpeg,png,webp,gif,bmp,heic"
  // 厂商原生文档附件能力（file_url / files API，不等于 Agent 工作文件）
  supports_document_input: boolean
  // 仅保留旧客户端 wire 兼容；当前客户端上传不受该字段控制，也不再提供结构化开关
  supports_zip_input: boolean
  // json_mode 子键
  json_mode_modes_csv: string // "json_schema,json_object"
  json_mode_strict: boolean
  // caching 子键
  caching_mode: string // automatic_implicit / explicit_cache_control / context_cache / none
  // limits 子键
  max_documents_per_request: string
  request_payload_max_mb: string
}

interface EmbeddingCfg {
  dimensions: string
  supports_dimensions_reduction: boolean
  max_batch_size: string
  max_input_tokens_per_text: string
}

interface SpeechCfg {
  max_audio_length_sec: string
  supported_formats_csv: string // "mp3,wav,pcm"
  supports_timestamps: boolean
  supports_language_hint: boolean
  available_voices_csv: string
  supports_speed_adjustment: boolean
  // wire 子键（asr/tts 也用）
  stream_supported: boolean
  // v0.1.x：ASR/TTS 厂商凭据字段（落到 capabilities_config 顶层，runtime 从顶层读）
  app_id: string
  secret_key: string
  default_speaker: string
  ws_endpoint: string
  // resource_ids 按 mode 区分（asr: flash/standard/streaming；tts: http/ws_bidirectional），
  // 当前用 CSV "<mode>=<resource_id>,..." 简化输入，runtime 仍读 dict
  resource_ids_csv: string
  // 单值 fallback（运营懒得按 mode 区分时填一个通用 resource_id）
  resource_id: string
}

interface MediaGenCfg {
  supported_aspect_ratios_csv: string
  min_resolution_w: string
  min_resolution_h: string
  max_resolution_w: string
  max_resolution_h: string
  max_duration_sec: string
  supports_seed_image: boolean
  supports_negative_prompt: boolean
  available_styles_csv: string
  async_only: boolean
}

export interface ModelFormState {
  provider_id: string
  model_name: string
  display_name: string
  description: string
  capability_domain: CapabilityDomain
  /**
   * v0.1.x Phase 2.5：每个 Model 自带 endpoint URL（Provider.base_url 已删）。
   * dashscope chat 走 /compatible-mode/v1、image_gen 走 /api/v1，必须按 model 区分。
   */
  base_url: string
  context_window_tokens: string
  max_input_tokens: string
  max_output_tokens: string

  billing_type: BillingType
  input_price_per_1k: string
  output_price_per_1k: string
  cache_read_input_price_per_1k: string
  cache_write_input_price_per_1k: string
  price_per_request: string
  price_per_second: string

  // 各 domain capabilities_config 结构化字段
  chat_vision: ChatVisionCfg
  embedding: EmbeddingCfg
  speech: SpeechCfg
  media_gen: MediaGenCfg

  // 上下文档位（仅 chat / vision 用）
  context_tiers: TierFormItem[]

  // raw JSON 模式（运营修改未列出字段）
  use_raw_json: boolean
  raw_capabilities_config: string
  raw_custom_billing_config: string
}

const DEFAULT_CHAT_VISION: ChatVisionCfg = {
  wire_protocol: 'openai_chat_completions',
  stream_supported: true,
  tool_enabled: true,
  image_enabled: false,
  image_input_via_csv: 'base64',
  image_formats_csv: 'jpeg,png,webp',
  supports_document_input: false,
  supports_zip_input: false,
  json_mode_modes_csv: 'json_object',
  json_mode_strict: false,
  caching_mode: 'none',
  max_documents_per_request: '',
  request_payload_max_mb: '',
}

const DEFAULT_EMBEDDING: EmbeddingCfg = {
  dimensions: '1024',
  supports_dimensions_reduction: false,
  max_batch_size: '50',
  max_input_tokens_per_text: '8192',
}

const DEFAULT_SPEECH: SpeechCfg = {
  max_audio_length_sec: '',
  supported_formats_csv: 'mp3,wav',
  supports_timestamps: false,
  supports_language_hint: true,
  available_voices_csv: '',
  supports_speed_adjustment: false,
  stream_supported: false,
  app_id: '',
  secret_key: '',
  default_speaker: '',
  ws_endpoint: '',
  resource_ids_csv: '',
  resource_id: '',
}

const DEFAULT_MEDIA_GEN: MediaGenCfg = {
  supported_aspect_ratios_csv: '1:1,16:9,9:16',
  min_resolution_w: '',
  min_resolution_h: '',
  max_resolution_w: '',
  max_resolution_h: '',
  max_duration_sec: '',
  supports_seed_image: false,
  supports_negative_prompt: false,
  available_styles_csv: '',
  async_only: false,
}

export function buildEmptyForm(domain: CapabilityDomain = 'chat'): ModelFormState {
  return {
    provider_id: '',
    model_name: '',
    display_name: '',
    description: '',
    capability_domain: domain,
    // v0.1.x Phase 2.5：每个 Model 必须填 base_url；按 domain 给个常用 default 提示
    base_url: '',
    context_window_tokens: domain === 'chat' || domain === 'vision' ? '128000' : '8192',
    max_input_tokens: '',
    max_output_tokens: '',
    billing_type: 'token',
    input_price_per_1k: '0',
    output_price_per_1k: '0',
    cache_read_input_price_per_1k: '',
    cache_write_input_price_per_1k: '',
    price_per_request: '0',
    price_per_second: '0',
    chat_vision: { ...DEFAULT_CHAT_VISION },
    embedding: { ...DEFAULT_EMBEDDING },
    speech: { ...DEFAULT_SPEECH },
    media_gen: { ...DEFAULT_MEDIA_GEN },
    context_tiers: [],
    use_raw_json: false,
    raw_capabilities_config: '{}',
    raw_custom_billing_config: '{}',
  }
}

function parseCsv(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function normalizeImageFormats(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.toLowerCase())
        .map((item) => (item === 'jpg' ? 'jpeg' : item))
    ),
  ]
}

function toggleCsvOption(csv: string, value: string, enabled: boolean): string {
  const selected = new Set(parseCsv(csv))
  if (enabled) selected.add(value)
  else selected.delete(value)
  return [...selected].join(',')
}

function parseInt0(value: string): number | undefined {
  const n = Number(value.trim())
  if (!value.trim() || !Number.isFinite(n) || n < 0) return undefined
  return Math.floor(n)
}

function parseInt1(value: string): number | undefined {
  const n = Number(value.trim())
  if (!value.trim() || !Number.isFinite(n) || n <= 0) return undefined
  return Math.floor(n)
}

function priceToFormValue(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && value.trim()) return value
  return ''
}

function appendOptionalPrice(
  target: Record<string, unknown>,
  key: 'cache_read_input_price_per_1k' | 'cache_write_input_price_per_1k',
  value: string,
  errors: string[]
) {
  const trimmed = value.trim()
  if (!trimmed) return
  const num = Number(trimmed)
  if (!Number.isFinite(num) || num < 0) {
    errors.push(`${key} 必须是非负数字`)
    return
  }
  target[key] = trimmed
}

function buildStructuredBillingConfig(
  form: ModelFormState,
  errors: string[],
  options: { includeModelCachePrices: boolean }
): Record<string, unknown> {
  const custom_billing_config: Record<string, unknown> = {}

  if (options.includeModelCachePrices) {
    appendOptionalPrice(
      custom_billing_config,
      'cache_read_input_price_per_1k',
      form.cache_read_input_price_per_1k,
      errors
    )
    appendOptionalPrice(
      custom_billing_config,
      'cache_write_input_price_per_1k',
      form.cache_write_input_price_per_1k,
      errors
    )
  }

  if (form.context_tiers.length > 0) {
    custom_billing_config.tiered_pricing = {
      tiers: serializeTiersToConfig(form.context_tiers),
    }
  }

  return custom_billing_config
}

function parsePreservedObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}')
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function mergeSection(
  owner: Record<string, unknown>,
  key: string,
  patch: Record<string, unknown>,
  removeKeys: string[] = []
) {
  const merged = { ...asObject(owner[key]), ...patch }
  for (const removeKey of removeKeys) delete merged[removeKey]
  if (Object.keys(merged).length > 0) owner[key] = merged
  else delete owner[key]
}

function mergeStructuredBillingConfig(
  form: ModelFormState,
  structured: Record<string, unknown>
): Record<string, unknown> {
  const preserved = parsePreservedObject(form.raw_custom_billing_config)
  delete preserved.cache_read_input_price_per_1k
  delete preserved.cache_write_input_price_per_1k

  if (structured.cache_read_input_price_per_1k !== undefined) {
    preserved.cache_read_input_price_per_1k = structured.cache_read_input_price_per_1k
  }
  if (structured.cache_write_input_price_per_1k !== undefined) {
    preserved.cache_write_input_price_per_1k = structured.cache_write_input_price_per_1k
  }

  if (structured.tiered_pricing) {
    preserved.tiered_pricing = {
      ...asObject(preserved.tiered_pricing),
      ...asObject(structured.tiered_pricing),
    }
  } else {
    delete preserved.tiered_pricing
  }
  return preserved
}

/**
 * 把 form state 序列化为后端期望的 capabilities_config JSON。
 *
 * 按 capability_domain 分支：
 * - chat / vision: 五大子键 (wire / tool / image / json_mode / caching)
 * - embedding: embedding 子键
 * - asr / tts: speech + wire
 * - image_gen / video_gen / audio_gen: media_gen 子键
 *
 * 如果运营开了 use_raw_json，直接用 raw JSON（覆盖结构化字段）。
 */
export function serializeCapabilitiesConfig(form: ModelFormState): {
  capabilities_config: Record<string, unknown>
  custom_billing_config: Record<string, unknown>
  errors: string[]
} {
  const errors: string[] = []

  if (form.use_raw_json) {
    let cap: Record<string, unknown> = {}
    let cust: Record<string, unknown> = buildStructuredBillingConfig(form, errors, {
      includeModelCachePrices: true,
    })
    try {
      cap = JSON.parse(form.raw_capabilities_config || '{}')
      if (typeof cap !== 'object' || cap === null || Array.isArray(cap))
        throw new Error('capabilities_config 必须是对象')
    } catch (err) {
      errors.push(
        `capabilities_config JSON 解析失败：${err instanceof Error ? err.message : String(err)}`
      )
    }
    if (form.raw_custom_billing_config && form.raw_custom_billing_config.trim() !== '{}') {
      try {
        const userCust = JSON.parse(form.raw_custom_billing_config)
        if (typeof userCust !== 'object' || userCust === null || Array.isArray(userCust))
          throw new Error('custom_billing_config 必须是对象')
        cust = { ...userCust, ...cust }
      } catch (err) {
        errors.push(
          `custom_billing_config JSON 解析失败：${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
    return { capabilities_config: cap, custom_billing_config: cust, errors }
  }

  const structuredBillingConfig = buildStructuredBillingConfig(form, errors, {
    includeModelCachePrices: true,
  })
  const custom_billing_config = mergeStructuredBillingConfig(form, structuredBillingConfig)

  // 结构化表单只覆盖页面负责的字段。模型原有 wire_adapter、厂商参数及未来
  // 扩展字段必须保留，否则一次普通编辑就会让已经验证过的运行契约失效。
  const cfg: Record<string, unknown> = {
    ...parsePreservedObject(form.raw_capabilities_config),
    version: 'v1.0',
    is_configured: true,
  }
  const domain = form.capability_domain

  if (domain === 'chat' || domain === 'vision') {
    const cv = form.chat_vision
    const imageInputVia = parseCsv(cv.image_input_via_csv)
    const imageFormats = parseCsv(cv.image_formats_csv)
    if (cv.image_enabled && imageInputVia.length === 0) {
      errors.push('图片理解至少选择一种传输方式')
    }
    if (cv.image_enabled && imageFormats.length === 0) {
      errors.push('图片理解至少选择一种文件格式')
    }
    const wirePatch = {
      request_protocol: cv.wire_protocol,
      response_protocol: cv.wire_protocol,
      stream_supported: cv.stream_supported,
    }
    const toolPatch = {
      enabled: cv.tool_enabled,
      choice_modes: ['auto', 'required', 'none'],
    }
    const imagePatch = {
      enabled: cv.image_enabled,
      input_via: imageInputVia,
      formats: imageFormats,
    }
    const jsonModePatch = {
      modes: parseCsv(cv.json_mode_modes_csv),
      strict_supported: cv.json_mode_strict,
    }
    const cachingPatch = { mode: cv.caching_mode || 'none' }
    mergeSection(cfg, 'wire', wirePatch)
    mergeSection(cfg, 'tool', toolPatch)
    mergeSection(cfg, 'image', imagePatch)
    mergeSection(cfg, 'json_mode', jsonModePatch)
    mergeSection(cfg, 'caching', cachingPatch)

    const limits: Record<string, unknown> = {}
    const maxDocs = parseInt1(cv.max_documents_per_request)
    if (maxDocs) limits.max_documents_per_request = maxDocs
    const maxMb = parseInt1(cv.request_payload_max_mb)
    if (maxMb) limits.request_payload_max_mb = maxMb
    mergeSection(cfg, 'limits', limits, [
      ...(maxDocs ? [] : ['max_documents_per_request']),
      ...(maxMb ? [] : ['request_payload_max_mb']),
    ])

    // 同步旧 Catalog/客户端仍在读取的兼容字段。
    cfg.supports_streaming = cv.stream_supported
    cfg.supports_function_calling = cv.tool_enabled
    cfg.supports_vision = cv.image_enabled
    cfg.supports_document_input = cv.supports_document_input
    cfg.supports_zip_input = cv.supports_zip_input
    cfg.supports_json_mode = jsonModePatch.modes.length > 0
    cfg.supports_prompt_caching = cachingPatch.mode !== 'none'

    const wireAdapter = asObject(cfg.wire_adapter)
    mergeSection(wireAdapter, 'wire', wirePatch)
    mergeSection(wireAdapter, 'tool', toolPatch)
    const existingImageAdapter = asObject(wireAdapter.image)
    const imageAdapterPatch: Record<string, unknown> = { ...imagePatch }
    if (!('upload_mode' in existingImageAdapter)) imageAdapterPatch.upload_mode = 'inline_base64'
    if (!('request_shape' in existingImageAdapter))
      imageAdapterPatch.request_shape = 'openai_image_url'
    mergeSection(wireAdapter, 'image', imageAdapterPatch)
    mergeSection(wireAdapter, 'json_mode', jsonModePatch)
    mergeSection(wireAdapter, 'caching', cachingPatch)
    mergeSection(wireAdapter, 'limits', limits, [
      ...(maxDocs ? [] : ['max_documents_per_request']),
      ...(maxMb ? [] : ['request_payload_max_mb']),
    ])
    cfg.wire_adapter = wireAdapter
  } else if (domain === 'embedding') {
    const e = form.embedding
    const dims = parseInt1(e.dimensions)
    if (!dims) errors.push('embedding.dimensions 必须为正整数')
    cfg.embedding = {
      dimensions: dims ?? 0,
      supports_dimensions_reduction: e.supports_dimensions_reduction,
      max_batch_size: parseInt1(e.max_batch_size) ?? 0,
      max_input_tokens_per_text: parseInt1(e.max_input_tokens_per_text) ?? 0,
    }
  } else if (domain === 'asr' || domain === 'tts') {
    const s = form.speech
    cfg.wire = {
      request_protocol: 'http',
      response_protocol: 'http',
      stream_supported: s.stream_supported,
    }
    const speech: Record<string, unknown> = {
      supported_formats: parseCsv(s.supported_formats_csv),
      supports_timestamps: s.supports_timestamps,
      supports_language_hint: s.supports_language_hint,
      supports_speed_adjustment: s.supports_speed_adjustment,
    }
    const maxLen = parseInt0(s.max_audio_length_sec)
    if (maxLen !== undefined) speech.max_audio_length_sec = maxLen
    const voices = parseCsv(s.available_voices_csv)
    if (voices.length > 0) speech.available_voices = voices
    cfg.speech = speech

    // v0.1.x：vendor 凭据字段落到 capabilities_config 顶层，
    // runtime（apps/services/speech/{asr,tts}/factory._config_from_model_info）从顶层读。
    const appId = s.app_id.trim()
    if (appId) cfg.app_id = appId
    const secretKey = s.secret_key.trim()
    if (secretKey) cfg.secret_key = secretKey
    const wsEndpoint = s.ws_endpoint.trim()
    if (wsEndpoint) cfg.ws_endpoint = wsEndpoint
    if (domain === 'tts') {
      const defaultSpeaker = s.default_speaker.trim()
      if (defaultSpeaker) cfg.default_speaker = defaultSpeaker
    }
    // resource_ids 按 mode 区分：解析 "flash=volc.bigasr.auc,standard=volc.seedasr.auc"
    const resourceIdsCsv = s.resource_ids_csv.trim()
    if (resourceIdsCsv) {
      const resource_ids: Record<string, string> = {}
      for (const pair of resourceIdsCsv
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)) {
        const eqIdx = pair.indexOf('=')
        if (eqIdx > 0) {
          const k = pair.slice(0, eqIdx).trim()
          const v = pair.slice(eqIdx + 1).trim()
          if (k && v) resource_ids[k] = v
        }
      }
      if (Object.keys(resource_ids).length > 0) {
        cfg.resource_ids = resource_ids
      }
    }
    const resourceId = s.resource_id.trim()
    if (resourceId) cfg.resource_id = resourceId
  } else {
    // image_gen / video_gen / audio_gen
    const m = form.media_gen
    const mg: Record<string, unknown> = {
      supported_aspect_ratios: parseCsv(m.supported_aspect_ratios_csv),
      supports_seed_image: m.supports_seed_image,
      supports_negative_prompt: m.supports_negative_prompt,
      async_only: m.async_only,
    }
    const minW = parseInt1(m.min_resolution_w)
    const minH = parseInt1(m.min_resolution_h)
    if (minW && minH) mg.min_resolution_px = [minW, minH]
    const maxW = parseInt1(m.max_resolution_w)
    const maxH = parseInt1(m.max_resolution_h)
    if (maxW && maxH) mg.max_resolution_px = [maxW, maxH]
    const dur = Number(m.max_duration_sec)
    if (m.max_duration_sec.trim() && Number.isFinite(dur) && dur > 0) mg.max_duration_sec = dur
    const styles = parseCsv(m.available_styles_csv)
    if (styles.length > 0) mg.available_styles = styles
    cfg.media_gen = mg
  }

  return { capabilities_config: cfg, custom_billing_config, errors }
}

/**
 * 反向：从已存在 model 的 capabilities_config 还原成 form state。
 *
 * 用在 Edit 对话框打开时。读不到的字段用默认值兜底。
 */
export function loadFromModel(model: LlmAdminModel): ModelFormState {
  const cfg = (model.capabilities_config || {}) as Record<string, unknown>
  const billingCfg = (model.custom_billing_config || {}) as Record<string, unknown>
  const tieredRaw = (billingCfg.tiered_pricing as Record<string, unknown> | undefined)?.tiers
  const baseDomain = (model.capability_domain || 'chat') as CapabilityDomain

  const form = buildEmptyForm(baseDomain)
  form.provider_id = model.provider_id
  form.model_name = model.model_name
  form.display_name = model.display_name
  form.description = model.description || ''
  // v0.1.x Phase 2.5：从 model 读取 endpoint
  form.base_url = (model as unknown as { base_url?: string }).base_url || ''
  form.context_window_tokens = String(model.context_window_tokens || '')
  form.max_input_tokens = model.max_input_tokens ? String(model.max_input_tokens) : ''
  form.max_output_tokens = model.max_output_tokens ? String(model.max_output_tokens) : ''
  form.billing_type = (model.billing_type as BillingType) || 'token'
  form.input_price_per_1k = String(model.input_price_per_1k ?? '0')
  form.output_price_per_1k = String(model.output_price_per_1k ?? '0')
  form.cache_read_input_price_per_1k = priceToFormValue(billingCfg.cache_read_input_price_per_1k)
  form.cache_write_input_price_per_1k = priceToFormValue(billingCfg.cache_write_input_price_per_1k)
  form.price_per_request = String(model.price_per_request ?? '0')
  form.price_per_second = String(model.price_per_second ?? '0')
  form.context_tiers = parseTiersFromConfig(tieredRaw)

  if (baseDomain === 'chat' || baseDomain === 'vision') {
    const wire = (cfg.wire as Record<string, unknown>) || {}
    const tool = (cfg.tool as Record<string, unknown>) || {}
    const image = (cfg.image as Record<string, unknown>) || {}
    const wireAdapter = (cfg.wire_adapter as Record<string, unknown>) || {}
    const wireAdapterImage = (wireAdapter.image as Record<string, unknown>) || {}
    const imageFormats = normalizeImageFormats(
      Array.isArray(wireAdapterImage.formats) ? wireAdapterImage.formats : image.formats
    )
    const jsonMode = (cfg.json_mode as Record<string, unknown>) || {}
    const caching = (cfg.caching as Record<string, unknown>) || {}
    const limits = (cfg.limits as Record<string, unknown>) || {}
    form.chat_vision = {
      wire_protocol:
        typeof wire.request_protocol === 'string'
          ? wire.request_protocol
          : DEFAULT_CHAT_VISION.wire_protocol,
      stream_supported: wire.stream_supported === true,
      tool_enabled: tool.enabled === true,
      image_enabled: image.enabled === true || wireAdapterImage.enabled === true,
      image_input_via_csv: Array.isArray(wireAdapterImage.input_via)
        ? (wireAdapterImage.input_via as string[]).join(',')
        : DEFAULT_CHAT_VISION.image_input_via_csv,
      image_formats_csv:
        imageFormats.length > 0 ? imageFormats.join(',') : DEFAULT_CHAT_VISION.image_formats_csv,
      supports_document_input: cfg.supports_document_input === true,
      supports_zip_input: cfg.supports_zip_input === true,
      json_mode_modes_csv: Array.isArray(jsonMode.modes)
        ? (jsonMode.modes as string[]).join(',')
        : '',
      json_mode_strict: jsonMode.strict_supported === true,
      caching_mode: typeof caching.mode === 'string' ? caching.mode : 'none',
      max_documents_per_request:
        typeof limits.max_documents_per_request === 'number'
          ? String(limits.max_documents_per_request)
          : '',
      request_payload_max_mb:
        typeof limits.request_payload_max_mb === 'number'
          ? String(limits.request_payload_max_mb)
          : '',
    }
  } else if (baseDomain === 'embedding') {
    const emb = (cfg.embedding as Record<string, unknown>) || {}
    form.embedding = {
      dimensions: typeof emb.dimensions === 'number' ? String(emb.dimensions) : '',
      supports_dimensions_reduction: emb.supports_dimensions_reduction === true,
      max_batch_size: typeof emb.max_batch_size === 'number' ? String(emb.max_batch_size) : '',
      max_input_tokens_per_text:
        typeof emb.max_input_tokens_per_text === 'number'
          ? String(emb.max_input_tokens_per_text)
          : '',
    }
  } else if (baseDomain === 'asr' || baseDomain === 'tts') {
    const wire = (cfg.wire as Record<string, unknown>) || {}
    const speech = (cfg.speech as Record<string, unknown>) || {}
    // v0.1.x：vendor 凭据从 capabilities_config 顶层读
    const resourceIds = (cfg.resource_ids as Record<string, string> | undefined) || {}
    const resourceIdsCsv = Object.entries(resourceIds)
      .map(([k, v]) => `${k}=${v}`)
      .join(',')
    form.speech = {
      max_audio_length_sec:
        typeof speech.max_audio_length_sec === 'number' ? String(speech.max_audio_length_sec) : '',
      supported_formats_csv: Array.isArray(speech.supported_formats)
        ? (speech.supported_formats as string[]).join(',')
        : '',
      supports_timestamps: speech.supports_timestamps === true,
      supports_language_hint: speech.supports_language_hint === true,
      available_voices_csv: Array.isArray(speech.available_voices)
        ? (speech.available_voices as string[]).join(',')
        : '',
      supports_speed_adjustment: speech.supports_speed_adjustment === true,
      stream_supported: wire.stream_supported === true,
      app_id: typeof cfg.app_id === 'string' ? cfg.app_id : '',
      secret_key: typeof cfg.secret_key === 'string' ? cfg.secret_key : '',
      default_speaker: typeof cfg.default_speaker === 'string' ? cfg.default_speaker : '',
      ws_endpoint: typeof cfg.ws_endpoint === 'string' ? cfg.ws_endpoint : '',
      resource_ids_csv: resourceIdsCsv,
      resource_id: typeof cfg.resource_id === 'string' ? cfg.resource_id : '',
    }
  } else {
    const m = (cfg.media_gen as Record<string, unknown>) || {}
    const minRes = m.min_resolution_px as number[] | undefined
    const maxRes = m.max_resolution_px as number[] | undefined
    form.media_gen = {
      supported_aspect_ratios_csv: Array.isArray(m.supported_aspect_ratios)
        ? (m.supported_aspect_ratios as string[]).join(',')
        : '',
      min_resolution_w: minRes?.[0] ? String(minRes[0]) : '',
      min_resolution_h: minRes?.[1] ? String(minRes[1]) : '',
      max_resolution_w: maxRes?.[0] ? String(maxRes[0]) : '',
      max_resolution_h: maxRes?.[1] ? String(maxRes[1]) : '',
      max_duration_sec: typeof m.max_duration_sec === 'number' ? String(m.max_duration_sec) : '',
      supports_seed_image: m.supports_seed_image === true,
      supports_negative_prompt: m.supports_negative_prompt === true,
      available_styles_csv: Array.isArray(m.available_styles)
        ? (m.available_styles as string[]).join(',')
        : '',
      async_only: m.async_only === true,
    }
  }

  form.raw_capabilities_config = JSON.stringify(cfg, null, 2)
  form.raw_custom_billing_config = JSON.stringify(billingCfg, null, 2)
  return form
}

/**
 * 用 LiteLLM 搜索结果回填 form。规则：
 *
 * - model_name → item.name
 * - display_name → 沿用 item.name（运营可改）
 * - context_window_tokens / max_input_tokens / max_output_tokens 直接用搜索值
 * - chat_vision.image_enabled = item.litellm_supports_vision || item.supports_vision
 * - 其他保持当前 form 值（只覆盖能确定的字段）
 */
export function applyLiteLlmPick(
  form: ModelFormState,
  item: LiteLlmSearchModelItem
): ModelFormState {
  const next = { ...form }
  next.model_name = item.name
  if (!form.display_name.trim()) next.display_name = item.name
  if (item.context_window_tokens && Number.isFinite(item.context_window_tokens)) {
    next.context_window_tokens = String(item.context_window_tokens)
  }
  if (item.max_input_tokens && Number.isFinite(item.max_input_tokens)) {
    next.max_input_tokens = String(item.max_input_tokens)
  }
  if (item.max_output_tokens && Number.isFinite(item.max_output_tokens)) {
    next.max_output_tokens = String(item.max_output_tokens)
  }
  if (item.cache_read_input_price_per_1k != null) {
    next.cache_read_input_price_per_1k = String(item.cache_read_input_price_per_1k)
  }
  if (item.cache_write_input_price_per_1k != null) {
    next.cache_write_input_price_per_1k = String(item.cache_write_input_price_per_1k)
  }
  if (form.capability_domain === 'chat' || form.capability_domain === 'vision') {
    const visionFlag = item.litellm_supports_vision ?? item.supports_vision
    if (visionFlag !== undefined) {
      next.chat_vision = { ...form.chat_vision, image_enabled: !!visionFlag }
    }
  }
  return next
}

export interface ModelProviderListFilter {
  scope?: ProviderScope
  organizationId?: string
}

interface ModelFormBodyProps {
  form: ModelFormState
  setForm: (next: ModelFormState | ((prev: ModelFormState) => ModelFormState)) => void
  /** 编辑时 provider 选项不能改（避免 capability_domain 漂移）；新建时可改。 */
  lockProvider?: boolean
  /** 限定可选 capability_domain（页面 Tab）；未指定则用 provider 推导。 */
  initialDomain?: CapabilityDomain
  /** 组织详情等场景：只列出 organization scope 的 BYOK 渠道 */
  providerListFilter?: ModelProviderListFilter
}

export function ModelFormBody({
  form,
  setForm,
  lockProvider = false,
  initialDomain,
  providerListFilter,
}: ModelFormBodyProps) {
  const [providers, setProviders] = useState<LlmAdminProvider[]>([])
  const [providersLoading, setProvidersLoading] = useState(true)
  const previousProviderIdRef = useRef('')
  const filterScope = providerListFilter?.scope
  const filterOrganizationId = providerListFilter?.organizationId

  useEffect(() => {
    let cancelled = false
    setProvidersLoading(true)
    llmAdminApi
      .listProviders({
        scope: filterScope,
        organizationId: filterOrganizationId,
        includeGlobalForOrganization: false,
        includeInactive: true,
      })
      .then((data) => {
        if (!cancelled) setProviders(data.providers || [])
      })
      .catch(() => {
        if (!cancelled) setProviders([])
      })
      .finally(() => {
        if (!cancelled) setProvidersLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [filterScope, filterOrganizationId])

  const filteredProviders = useMemo(() => {
    let list = providers
    if (filterScope) {
      list = list.filter((p) => p.scope === filterScope)
    }
    if (filterOrganizationId) {
      list = list.filter((p) => p.organization_id === filterOrganizationId)
    }
    if (!initialDomain) return list
    return list.filter((p) => (p.capability_domains ?? []).includes(initialDomain))
  }, [providers, initialDomain, filterScope, filterOrganizationId])

  // v0.1.x：Provider 可同时提供多 capability_domain。选 provider 时如果当前 form.capability_domain
  // 不在 provider.capability_domains 里，则默认锁定为集合首项（仍保留宪法 §1.3.3 单向同步）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 单向同步 provider → capability_domain，加依赖会造成无限重渲染
  useEffect(() => {
    if (!form.provider_id) return
    const p = providers.find((x) => x.id === form.provider_id)
    if (!p) return
    const caps = p.capability_domains ?? []
    if (caps.length === 0) return
    if (!caps.includes(form.capability_domain)) {
      setForm((prev) => ({ ...prev, capability_domain: caps[0] as CapabilityDomain }))
    }
  }, [form.provider_id, providers])

  // 新建模型时用渠道默认 endpoint 预填。切换渠道时仅替换空值或上一渠道的
  // 自动默认值，用户手动输入的 endpoint 保持不变。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 单向同步 provider → base_url
  useEffect(() => {
    if (!form.provider_id) return
    const provider = providers.find((item) => item.id === form.provider_id)
    if (!provider) return
    const previousProvider = providers.find((item) => item.id === previousProviderIdRef.current)
    setForm((prev) => {
      const currentValue = prev.base_url.trim()
      const previousDefault = previousProvider?.base_url?.trim() || ''
      const shouldUseDefault =
        !currentValue || (!!previousDefault && currentValue === previousDefault)
      if (!shouldUseDefault || prev.base_url === provider.base_url) return prev
      return { ...prev, base_url: provider.base_url || '' }
    })
    previousProviderIdRef.current = form.provider_id
  }, [form.provider_id, providers])

  const update = <K extends keyof ModelFormState>(key: K, value: ModelFormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  const updateChatVision = (patch: Partial<ChatVisionCfg>) =>
    setForm((prev) => ({ ...prev, chat_vision: { ...prev.chat_vision, ...patch } }))

  const updateEmbedding = (patch: Partial<EmbeddingCfg>) =>
    setForm((prev) => ({ ...prev, embedding: { ...prev.embedding, ...patch } }))

  const updateSpeech = (patch: Partial<SpeechCfg>) =>
    setForm((prev) => ({ ...prev, speech: { ...prev.speech, ...patch } }))

  const updateMediaGen = (patch: Partial<MediaGenCfg>) =>
    setForm((prev) => ({ ...prev, media_gen: { ...prev.media_gen, ...patch } }))

  const domainLockedFromProvider = !!form.provider_id

  return (
    <div className="space-y-5">
      {/* ────── 基础信息 ────── */}
      <section className="space-y-3">
        <h3 className="text-body font-semibold">基础信息</h3>
        <div className="grid grid-cols-2 gap-3">
          <Field label="模型渠道" required hint="先在渠道管理中配置 API 地址和密钥">
            <select
              className="w-full rounded-md border px-3 py-2 text-body bg-background disabled:opacity-50"
              value={form.provider_id}
              disabled={lockProvider || providersLoading}
              onChange={(e) => update('provider_id', e.target.value)}
            >
              <option value="">{providersLoading ? '加载中...' : '请选择'}</option>
              {filteredProviders.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.display_name}
                  {(p.capability_domains ?? []).length > 0
                    ? ` · ${(p.capability_domains ?? []).map((domain) => CAPABILITY_DOMAIN_LABELS[domain as CapabilityDomain] || domain).join('、')}`
                    : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label="模型用途" hint="选择渠道后会自动匹配">
            <select
              className="w-full rounded-md border px-3 py-2 text-body bg-background disabled:opacity-50"
              value={form.capability_domain}
              disabled={domainLockedFromProvider}
              onChange={(e) => update('capability_domain', e.target.value as CapabilityDomain)}
            >
              {CAPABILITY_DOMAINS.map((d) => (
                <option key={d} value={d}>
                  {CAPABILITY_DOMAIN_LABELS[d]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="上游模型 ID" required hint="从服务商的模型列表复制，例如 qwen3.5-plus">
            <input
              type="text"
              className="w-full rounded-md border px-3 py-2 text-body bg-background font-mono"
              value={form.model_name}
              onChange={(e) => update('model_name', e.target.value)}
            />
          </Field>
          <Field label="用户看到的名称" required>
            <input
              type="text"
              className="w-full rounded-md border px-3 py-2 text-body bg-background"
              value={form.display_name}
              onChange={(e) => update('display_name', e.target.value)}
            />
          </Field>
          <Field className="col-span-2" label="描述">
            <textarea
              className="w-full rounded-md border px-3 py-2 text-body bg-background min-h-[60px]"
              value={form.description}
              onChange={(e) => update('description', e.target.value)}
              placeholder="可选；简单说明模型特点和用途"
            />
          </Field>
          <Field
            className="col-span-2"
            label="API 地址"
            required
            hint={
              form.capability_domain === 'image_gen' ||
              form.capability_domain === 'video_gen' ||
              form.capability_domain === 'audio_gen'
                ? '示例：https://dashscope.aliyuncs.com/api/v1'
                : '示例：https://dashscope.aliyuncs.com/compatible-mode/v1'
            }
          >
            <input
              type="text"
              className="w-full rounded-md border px-3 py-2 text-body bg-background font-mono"
              value={form.base_url}
              onChange={(e) => update('base_url', e.target.value)}
              placeholder="例如 https://api.example.com/v1"
            />
          </Field>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Field label="上下文长度" required hint="模型一次能理解的最大 Token 数">
            <input
              type="number"
              className="w-full rounded-md border px-3 py-2 text-body bg-background"
              value={form.context_window_tokens}
              onChange={(e) => update('context_window_tokens', e.target.value)}
            />
          </Field>
          <Field label="最大输入长度" hint="留空则与上下文长度相同">
            <input
              type="number"
              className="w-full rounded-md border px-3 py-2 text-body bg-background"
              value={form.max_input_tokens}
              onChange={(e) => update('max_input_tokens', e.target.value)}
            />
          </Field>
          <Field label="最大输出长度" hint="留空则使用系统安全默认值">
            <input
              type="number"
              className="w-full rounded-md border px-3 py-2 text-body bg-background"
              value={form.max_output_tokens}
              onChange={(e) => update('max_output_tokens', e.target.value)}
            />
          </Field>
        </div>
      </section>

      {/* ────── 计费 ────── */}
      <section className="space-y-3">
        <h3 className="text-body font-semibold">计费</h3>
        <div className="grid grid-cols-3 gap-3">
          <Field label="计费类型">
            <select
              className="w-full rounded-md border px-3 py-2 text-body bg-background"
              value={form.billing_type}
              onChange={(e) => update('billing_type', e.target.value as BillingType)}
            >
              {BILLING_TYPES.map((t) => (
                <option key={t} value={t}>
                  {BILLING_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </Field>
          {form.billing_type === 'token' && (
            <>
              <Field label="输入价格 / 1K Token">
                <input
                  type="number"
                  step="0.000001"
                  className="w-full rounded-md border px-3 py-2 text-body bg-background"
                  value={form.input_price_per_1k}
                  onChange={(e) => update('input_price_per_1k', e.target.value)}
                />
              </Field>
              <Field label="输出价格 / 1K Token">
                <input
                  type="number"
                  step="0.000001"
                  className="w-full rounded-md border px-3 py-2 text-body bg-background"
                  value={form.output_price_per_1k}
                  onChange={(e) => update('output_price_per_1k', e.target.value)}
                />
              </Field>
              <Field label="缓存命中价格 / 1K" hint="留空使用渠道默认折扣">
                <input
                  type="number"
                  step="0.000001"
                  className="w-full rounded-md border px-3 py-2 text-body bg-background"
                  value={form.cache_read_input_price_per_1k}
                  onChange={(e) => update('cache_read_input_price_per_1k', e.target.value)}
                />
              </Field>
              <Field label="缓存写入价格 / 1K" hint="留空使用渠道默认折扣">
                <input
                  type="number"
                  step="0.000001"
                  className="w-full rounded-md border px-3 py-2 text-body bg-background"
                  value={form.cache_write_input_price_per_1k}
                  onChange={(e) => update('cache_write_input_price_per_1k', e.target.value)}
                />
              </Field>
            </>
          )}
          {form.billing_type === 'request' && (
            <Field label="每次请求价格" className="col-span-2">
              <input
                type="number"
                step="0.000001"
                className="w-full rounded-md border px-3 py-2 text-body bg-background"
                value={form.price_per_request}
                onChange={(e) => update('price_per_request', e.target.value)}
              />
            </Field>
          )}
          {form.billing_type === 'time' && (
            <Field label="每秒价格" className="col-span-2">
              <input
                type="number"
                step="0.000001"
                className="w-full rounded-md border px-3 py-2 text-body bg-background"
                value={form.price_per_second}
                onChange={(e) => update('price_per_second', e.target.value)}
              />
            </Field>
          )}
          {form.billing_type === 'custom' && (
            <div className="col-span-2 flex items-center gap-2 text-caption text-muted-foreground">
              <Info className="h-3.5 w-3.5" />
              custom 类型计费规则在「高级 JSON」中编辑 custom_billing_config
            </div>
          )}
        </div>
      </section>

      {/* ────── capabilities_config 按 domain 显示 ────── */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-body font-semibold">模型能力</h3>
          <label className="flex items-center gap-1.5 text-caption text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={form.use_raw_json}
              onChange={(e) => update('use_raw_json', e.target.checked)}
            />
            使用高级 JSON
          </label>
        </div>

        {form.use_raw_json ? (
          <RawJsonPanel form={form} setForm={setForm} />
        ) : (
          <>
            {(form.capability_domain === 'chat' || form.capability_domain === 'vision') && (
              <ChatVisionPanel cfg={form.chat_vision} update={updateChatVision} />
            )}
            {form.capability_domain === 'embedding' && (
              <EmbeddingPanel cfg={form.embedding} update={updateEmbedding} />
            )}
            {(form.capability_domain === 'asr' || form.capability_domain === 'tts') && (
              <SpeechPanel
                cfg={form.speech}
                update={updateSpeech}
                domain={form.capability_domain}
              />
            )}
            {(form.capability_domain === 'image_gen' ||
              form.capability_domain === 'video_gen' ||
              form.capability_domain === 'audio_gen') && (
              <MediaGenPanel
                cfg={form.media_gen}
                update={updateMediaGen}
                domain={form.capability_domain}
              />
            )}
          </>
        )}
      </section>

      {/* ────── 上下文档位（仅 chat / vision） ────── */}
      {(form.capability_domain === 'chat' || form.capability_domain === 'vision') && (
        <section className="space-y-3">
          <h3 className="text-body font-semibold">大上下文分档计价（高级）</h3>
          <ContextTiersField
            value={form.context_tiers}
            onChange={(next) => update('context_tiers', next)}
            showZenmuxPreset
          />
        </section>
      )}
    </div>
  )
}

function Field({
  label,
  required,
  hint,
  children,
  className,
}: {
  label: string
  required?: boolean
  hint?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={className}>
      <div className="text-caption font-medium mb-0.5">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </div>
      {children}
      {hint && <div className="text-[10px] text-muted-foreground mt-0.5">{hint}</div>}
    </div>
  )
}

function RawJsonPanel({
  form,
  setForm,
}: {
  form: ModelFormState
  setForm: (next: ModelFormState | ((prev: ModelFormState) => ModelFormState)) => void
}) {
  const update = <K extends keyof ModelFormState>(key: K, value: ModelFormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }))
  return (
    <div className="space-y-2">
      <div className="rounded border border-yellow-300 bg-yellow-50 px-3 py-2 text-caption text-yellow-900 flex items-start gap-2">
        <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
        <span>高级模式会直接编辑底层 JSON，仅建议熟悉对应模型协议的开发人员使用。</span>
      </div>
      <div className="space-y-1.5">
        <div className="text-caption font-medium">capabilities_config (JSON)</div>
        <textarea
          className="w-full rounded-md border px-3 py-2 text-caption font-mono bg-background min-h-[160px]"
          value={form.raw_capabilities_config}
          onChange={(e) => update('raw_capabilities_config', e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <div className="text-caption font-medium">custom_billing_config (JSON)</div>
        <textarea
          className="w-full rounded-md border px-3 py-2 text-caption font-mono bg-background min-h-[100px]"
          value={form.raw_custom_billing_config}
          onChange={(e) => update('raw_custom_billing_config', e.target.value)}
        />
      </div>
    </div>
  )
}

export function ChatVisionPanel({
  cfg,
  update,
}: {
  cfg: ChatVisionCfg
  update: (patch: Partial<ChatVisionCfg>) => void
}) {
  const supportsJsonSchema = hasJsonMode(cfg.json_mode_modes_csv, 'json_schema')

  const updateJsonMode = (mode: string, enabled: boolean) => {
    update({
      json_mode_modes_csv: toggleJsonMode(cfg.json_mode_modes_csv, mode, enabled),
      ...(!enabled && mode === 'json_schema' ? { json_mode_strict: false } : {}),
    })
  }

  const updateImageInputVia = (value: string, enabled: boolean) => {
    update({ image_input_via_csv: toggleCsvOption(cfg.image_input_via_csv, value, enabled) })
  }

  const updateImageFormat = (value: string, enabled: boolean) => {
    update({ image_formats_csv: toggleCsvOption(cfg.image_formats_csv, value, enabled) })
  }

  return (
    <div className="grid grid-cols-2 gap-3 rounded border bg-muted/10 p-3">
      <div className="col-span-2 flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-caption text-blue-800">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          这些声明会决定客户端入口和实际请求参数，请仅启用已通过厂商文档与真实请求验证的能力。
        </span>
      </div>
      <Field label="请求协议" hint="OpenAI-compatible 模型通常保持默认">
        <select
          className="w-full rounded-md border px-3 py-2 text-body bg-background"
          value={cfg.wire_protocol}
          onChange={(e) => update({ wire_protocol: e.target.value })}
        >
          <option value="openai_chat_completions">OpenAI Chat Completions</option>
          <option value="anthropic_messages">Anthropic Messages</option>
          <option value="gemini_generate_content">Gemini Generate Content</option>
        </select>
      </Field>
      <Field label="流式回复" hint="关闭后上游生成完整答案，再由 TabTin 一次性返回给客户端">
        <ToggleRow
          checked={cfg.stream_supported}
          onChange={(v) => update({ stream_supported: v })}
          label="支持流式"
        />
      </Field>
      <Field label="工具调用">
        <ToggleRow
          checked={cfg.tool_enabled}
          onChange={(v) => update({ tool_enabled: v })}
          label="支持工具调用"
        />
      </Field>
      <Field label="图片理解" hint="关闭后客户端隐藏图片入口，后端也会拒绝图片请求">
        <ToggleRow
          checked={cfg.image_enabled}
          onChange={(v) => update({ image_enabled: v })}
          label="支持视觉输入"
        />
      </Field>
      {cfg.image_enabled && (
        <>
          <Field
            label="图片传输方式"
            hint="按厂商真实能力选择；Kimi Code API 建议只选 Base64，不要直接发送 OSS URL"
            className="col-span-2"
          >
            <div className="grid grid-cols-3 gap-2">
              {IMAGE_INPUT_VIA_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className="flex cursor-pointer items-start gap-2 rounded-md border bg-background px-3 py-2"
                >
                  <input
                    className="mt-0.5"
                    type="checkbox"
                    checked={parseCsv(cfg.image_input_via_csv).includes(option.value)}
                    onChange={(event) => updateImageInputVia(option.value, event.target.checked)}
                  />
                  <span>
                    <span className="block text-body">{option.label}</span>
                    <span className="block text-[10px] text-muted-foreground">
                      {option.description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </Field>
          <Field
            label="支持的图片格式"
            hint="只声明厂商已验证支持的格式；不同模型可以不同"
            className="col-span-2"
          >
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
              {IMAGE_FORMAT_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className="flex cursor-pointer items-center gap-2 rounded-md border bg-background px-3 py-2 text-body"
                >
                  <input
                    type="checkbox"
                    checked={parseCsv(cfg.image_formats_csv).includes(option.value)}
                    onChange={(event) => updateImageFormat(option.value, event.target.checked)}
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </Field>
        </>
      )}
      <Field
        label="文档附件"
        hint="开启后客户端允许选择和发送 PDF、Word、Excel、PPT、TXT 等文档；若厂商不原生接收文件，还需在高级 JSON 中配置并验证解析适配"
      >
        <ToggleRow
          checked={cfg.supports_document_input}
          onChange={(v) => update({ supports_document_input: v })}
          label="允许文档附件"
        />
      </Field>
      <Field
        label="结构化输出"
        hint="可多选；全部关闭表示不声明结构化输出能力"
        className="col-span-2"
      >
        <div className="grid grid-cols-2 gap-2">
          {JSON_MODE_OPTIONS.map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer items-start gap-2 rounded-md border bg-background px-3 py-2"
            >
              <input
                className="mt-0.5"
                type="checkbox"
                checked={hasJsonMode(cfg.json_mode_modes_csv, option.value)}
                onChange={(event) => updateJsonMode(option.value, event.target.checked)}
              />
              <span>
                <span className="block text-body">{option.label}</span>
                <span className="block text-[10px] text-muted-foreground">
                  {option.description}
                </span>
              </span>
            </label>
          ))}
        </div>
      </Field>
      <Field
        label="严格遵循 JSON Schema"
        hint={
          supportsJsonSchema
            ? '严格保证不缺字段、不多字段；仅在上游明确支持 strict 时开启'
            : '需先启用 JSON Schema'
        }
      >
        <ToggleRow
          checked={cfg.json_mode_strict}
          onChange={(v) => update({ json_mode_strict: v })}
          label="支持严格模式"
          disabled={!supportsJsonSchema}
        />
      </Field>
      <Field
        label="上下文缓存"
        hint="表示 TabTin 可主动使用的缓存方式；选“不支持”不会抹掉厂商响应中真实发生的自动缓存用量"
      >
        <select
          className="w-full rounded-md border px-3 py-2 text-body bg-background"
          value={cfg.caching_mode}
          onChange={(e) => update({ caching_mode: e.target.value })}
        >
          {CACHING_MODE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label="单次最多上传文档数"
        hint={
          cfg.supports_document_input
            ? '一条模型请求最多附带的 PDF、Word 等文档数量；不含 ZIP、图片和视频，留空表示不额外限制'
            : '请先开启文档附件能力'
        }
      >
        <input
          type="number"
          min="1"
          step="1"
          placeholder="例如：5"
          className="w-full rounded-md border px-3 py-2 text-body bg-background"
          value={cfg.max_documents_per_request}
          onChange={(e) => update({ max_documents_per_request: e.target.value })}
          disabled={!cfg.supports_document_input}
        />
      </Field>
      <Field
        label="请求体大小上限（MB）"
        hint="发送给厂商的完整请求 JSON 上限，包含对话历史、工具定义及 Base64 附件；超出时发送前拒绝，留空表示不额外限制"
      >
        <input
          type="number"
          min="1"
          step="1"
          placeholder="例如：20"
          className="w-full rounded-md border px-3 py-2 text-body bg-background"
          value={cfg.request_payload_max_mb}
          onChange={(e) => update({ request_payload_max_mb: e.target.value })}
        />
      </Field>
    </div>
  )
}

function EmbeddingPanel({
  cfg,
  update,
}: {
  cfg: EmbeddingCfg
  update: (patch: Partial<EmbeddingCfg>) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-3 rounded border bg-muted/10 p-3">
      <Field label="embedding.dimensions" required hint="v0.1 全平台统一 1024（除非特殊用途）">
        <input
          type="number"
          className="w-full rounded-md border px-3 py-2 text-body bg-background"
          value={cfg.dimensions}
          onChange={(e) => update({ dimensions: e.target.value })}
        />
      </Field>
      <Field label="embedding.supports_dimensions_reduction">
        <ToggleRow
          checked={cfg.supports_dimensions_reduction}
          onChange={(v) => update({ supports_dimensions_reduction: v })}
          label="支持维度压缩"
        />
      </Field>
      <Field label="embedding.max_batch_size" required>
        <input
          type="number"
          className="w-full rounded-md border px-3 py-2 text-body bg-background"
          value={cfg.max_batch_size}
          onChange={(e) => update({ max_batch_size: e.target.value })}
        />
      </Field>
      <Field label="embedding.max_input_tokens_per_text" required>
        <input
          type="number"
          className="w-full rounded-md border px-3 py-2 text-body bg-background"
          value={cfg.max_input_tokens_per_text}
          onChange={(e) => update({ max_input_tokens_per_text: e.target.value })}
        />
      </Field>
    </div>
  )
}

function SpeechPanel({
  cfg,
  update,
  domain,
}: {
  cfg: SpeechCfg
  update: (patch: Partial<SpeechCfg>) => void
  domain: 'asr' | 'tts'
}) {
  return (
    <div className="grid grid-cols-2 gap-3 rounded border bg-muted/10 p-3">
      <Field label="speech.max_audio_length_sec" hint="0 / 留空 = 无上限（流式）">
        <input
          type="number"
          className="w-full rounded-md border px-3 py-2 text-body bg-background"
          value={cfg.max_audio_length_sec}
          onChange={(e) => update({ max_audio_length_sec: e.target.value })}
        />
      </Field>
      <Field label="speech.supported_formats（CSV）" hint="mp3,wav,pcm,ogg">
        <input
          type="text"
          className="w-full rounded-md border px-3 py-2 text-body bg-background"
          value={cfg.supported_formats_csv}
          onChange={(e) => update({ supported_formats_csv: e.target.value })}
        />
      </Field>
      {domain === 'asr' && (
        <>
          <Field label="speech.supports_timestamps">
            <ToggleRow
              checked={cfg.supports_timestamps}
              onChange={(v) => update({ supports_timestamps: v })}
              label="支持字级时间戳"
            />
          </Field>
          <Field label="speech.supports_language_hint">
            <ToggleRow
              checked={cfg.supports_language_hint}
              onChange={(v) => update({ supports_language_hint: v })}
              label="支持语种提示"
            />
          </Field>
        </>
      )}
      {domain === 'tts' && (
        <>
          <Field
            label="speech.available_voices（CSV）"
            className="col-span-2"
            hint="如 alloy,nova,onyx"
          >
            <input
              type="text"
              className="w-full rounded-md border px-3 py-2 text-body bg-background"
              value={cfg.available_voices_csv}
              onChange={(e) => update({ available_voices_csv: e.target.value })}
            />
          </Field>
          <Field label="speech.supports_speed_adjustment">
            <ToggleRow
              checked={cfg.supports_speed_adjustment}
              onChange={(v) => update({ supports_speed_adjustment: v })}
              label="支持语速调整"
            />
          </Field>
        </>
      )}
      <Field label="wire.stream_supported">
        <ToggleRow
          checked={cfg.stream_supported}
          onChange={(v) => update({ stream_supported: v })}
          label="支持流式 (WS bidirectional)"
        />
      </Field>

      {/* v0.1.x：vendor 凭据字段（字节跳动 ASR/TTS 必填） */}
      <div className="col-span-2 mt-2 border-t pt-3">
        <p className="text-caption font-medium mb-1">
          Vendor 凭据（写入 capabilities_config 顶层，runtime 实际调用时读取）
        </p>
        <p className="text-[10px] text-muted-foreground mb-3">
          字节跳动 ASR/TTS 必填 app_id；其他厂商按需补 secret_key / resource_ids / ws_endpoint。
          api_key（access_token）来自所在 Provider 的 api_key 字段，不在此填。
        </p>
      </div>
      <Field label="app_id" hint={domain === 'asr' ? '字节 ASR App ID' : '字节 TTS App ID'}>
        <input
          type="text"
          className="w-full rounded-md border px-3 py-2 text-body font-mono bg-background"
          value={cfg.app_id}
          onChange={(e) => update({ app_id: e.target.value })}
        />
      </Field>
      <Field label="secret_key" hint="若厂商 HMAC 签名需要，否则留空">
        <input
          type="password"
          autoComplete="off"
          className="w-full rounded-md border px-3 py-2 text-body font-mono bg-background"
          value={cfg.secret_key}
          onChange={(e) => update({ secret_key: e.target.value })}
        />
      </Field>
      <Field
        label="resource_ids（按 mode 区分，CSV）"
        className="col-span-2"
        hint={
          domain === 'asr'
            ? '例：flash=volc.bigasr.auc_turbo,standard=volc.bigasr.auc,streaming=volc.bigasr.sauc.duration'
            : '例：http=seed-tts-2.0,ws_bidirectional=seed-tts-2.0（来源：tts/providers/bytedance/base.py 顶部 RESOURCE_* 常量）'
        }
      >
        <input
          type="text"
          className="w-full rounded-md border px-3 py-2 text-body font-mono bg-background"
          value={cfg.resource_ids_csv}
          onChange={(e) => update({ resource_ids_csv: e.target.value })}
        />
      </Field>
      <Field label="resource_id（fallback，单值）" hint="所有 mode 共用一个 resource_id 时填这里">
        <input
          type="text"
          className="w-full rounded-md border px-3 py-2 text-body font-mono bg-background"
          value={cfg.resource_id}
          onChange={(e) => update({ resource_id: e.target.value })}
        />
      </Field>
      {domain === 'asr' && (
        <Field
          label="ws_endpoint"
          hint="字节 ASR 流式：bigmodel / bigmodel_async / bigmodel_nostream"
        >
          <input
            type="text"
            className="w-full rounded-md border px-3 py-2 text-body font-mono bg-background"
            value={cfg.ws_endpoint}
            onChange={(e) => update({ ws_endpoint: e.target.value })}
          />
        </Field>
      )}
      {domain === 'tts' && (
        <Field label="default_speaker" hint="默认音色 ID（zh_female_vv_uranus_bigtts 等）">
          <input
            type="text"
            className="w-full rounded-md border px-3 py-2 text-body font-mono bg-background"
            value={cfg.default_speaker}
            onChange={(e) => update({ default_speaker: e.target.value })}
          />
        </Field>
      )}
    </div>
  )
}

function MediaGenPanel({
  cfg,
  update,
  domain,
}: {
  cfg: MediaGenCfg
  update: (patch: Partial<MediaGenCfg>) => void
  domain: 'image_gen' | 'video_gen' | 'audio_gen'
}) {
  return (
    <div className="grid grid-cols-2 gap-3 rounded border bg-muted/10 p-3">
      <Field
        label="media_gen.supported_aspect_ratios（CSV）"
        className="col-span-2"
        hint="1:1,16:9,9:16"
      >
        <input
          type="text"
          className="w-full rounded-md border px-3 py-2 text-body bg-background"
          value={cfg.supported_aspect_ratios_csv}
          onChange={(e) => update({ supported_aspect_ratios_csv: e.target.value })}
        />
      </Field>
      <Field label="min_resolution_w">
        <input
          type="number"
          className="w-full rounded-md border px-3 py-2 text-body bg-background"
          value={cfg.min_resolution_w}
          onChange={(e) => update({ min_resolution_w: e.target.value })}
        />
      </Field>
      <Field label="min_resolution_h">
        <input
          type="number"
          className="w-full rounded-md border px-3 py-2 text-body bg-background"
          value={cfg.min_resolution_h}
          onChange={(e) => update({ min_resolution_h: e.target.value })}
        />
      </Field>
      <Field label="max_resolution_w">
        <input
          type="number"
          className="w-full rounded-md border px-3 py-2 text-body bg-background"
          value={cfg.max_resolution_w}
          onChange={(e) => update({ max_resolution_w: e.target.value })}
        />
      </Field>
      <Field label="max_resolution_h">
        <input
          type="number"
          className="w-full rounded-md border px-3 py-2 text-body bg-background"
          value={cfg.max_resolution_h}
          onChange={(e) => update({ max_resolution_h: e.target.value })}
        />
      </Field>
      {(domain === 'video_gen' || domain === 'audio_gen') && (
        <Field label="max_duration_sec" className="col-span-2">
          <input
            type="number"
            className="w-full rounded-md border px-3 py-2 text-body bg-background"
            value={cfg.max_duration_sec}
            onChange={(e) => update({ max_duration_sec: e.target.value })}
          />
        </Field>
      )}
      {domain !== 'audio_gen' && (
        <>
          <Field label="supports_seed_image">
            <ToggleRow
              checked={cfg.supports_seed_image}
              onChange={(v) => update({ supports_seed_image: v })}
              label="i2i / i2v"
            />
          </Field>
          <Field label="supports_negative_prompt">
            <ToggleRow
              checked={cfg.supports_negative_prompt}
              onChange={(v) => update({ supports_negative_prompt: v })}
              label="反向提示"
            />
          </Field>
        </>
      )}
      <Field label="available_styles（CSV）" className="col-span-2">
        <input
          type="text"
          className="w-full rounded-md border px-3 py-2 text-body bg-background"
          value={cfg.available_styles_csv}
          onChange={(e) => update({ available_styles_csv: e.target.value })}
        />
      </Field>
      <Field label="async_only">
        <ToggleRow
          checked={cfg.async_only}
          onChange={(v) => update({ async_only: v })}
          label="仅异步 API"
        />
      </Field>
    </div>
  )
}

function ToggleRow({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <label
      className={`flex items-center gap-2 rounded-md border bg-background px-3 py-2 ${
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="text-body">{label}</span>
    </label>
  )
}
