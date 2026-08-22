/**
 * Step 2: 生成完整 fixture 集（22 ContentBlock case + 7 边界 case + 6 envelope）。
 *
 * 输出：fixtures/samples/*.json
 *
 * 用法：tsx packages/wire-codegen/scripts/02_emit_fixtures.ts
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ContentBlockSchema,
  MessageStartSchema,
  MessageDeltaSchema,
  MessageStopSchema,
  ContentBlockStartSchema,
  ContentBlockDeltaSchema,
  ContentBlockStopSchema,
  AnyContentBlockStreamEventSchema,
} from '@tabtin/agent-wire';
import type {
  ContentBlock,
  MessageStart,
  MessageDelta,
  MessageStop,
  ContentBlockStart,
  ContentBlockDelta,
  ContentBlockStop,
  AnyContentBlockStreamEvent,
} from '@tabtin/agent-wire';
import { FIXTURE_SAMPLES_DIR, REPO_ROOT } from './lib/paths.js';

mkdirSync(FIXTURE_SAMPLES_DIR, { recursive: true });

// ════════════════════════════════════════════════════════════════════
// Fixture 1: ContentBlock 22 case 完整覆盖（W0-L5 修复）
// ════════════════════════════════════════════════════════════════════

const allContentBlocks: ContentBlock[] = [
  // 1. text + citations + 中英 emoji 混合
  {
    type: 'text',
    text: '我先想一下 🤔。Now let me check the file...',
    citations: [
      {
        type: 'char_location',
        cited_text: 'cited example',
        document_index: 0,
        document_title: 'src/main.ts',
        start_char_index: 100,
        end_char_index: 113,
      },
    ],
  },
  // 2. tool_use（含 input_parse_error）—— 注意 id 红线：toolu_* / call_* 上游原生 id
  {
    type: 'tool_use',
    id: 'toolu_01abc',
    name: 'read_file',
    input: { path: 'src/main.ts', limit: 100 },
    input_parse_error: {
      message: 'Unexpected end of JSON',
      partial: '{"path":"src/main.ts","lim',
    },
  },
  // 3. tool_result（string content 简写形态）
  {
    type: 'tool_result',
    tool_use_id: 'toolu_01abc',
    content: 'export function main() { return 0 }',
    is_error: false,
    tabtin_metadata: { duration_ms: 12, exit_code: 0, truncated: false },
  },
  // 4. thinking + signature
  {
    type: 'thinking',
    thinking: '用户想要一个 X，所以我需要先 read_file 看下当前实现。\n包含换行 + 反斜杠 \\ + 引号 "test"。',
    signature: 'sig_abc123_signature_payload',
  },
  // 5. redacted_thinking（base64 加密 data）
  {
    type: 'redacted_thinking',
    data: 'aGVsbG8gd29ybGQgZW5jcnlwdGVkIHBheWxvYWQ=',
  },
  // 6. image (base64)
  {
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/png',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII=',
    },
  },
  // 7. document（base64 PDF）
  {
    type: 'document',
    source: {
      type: 'base64',
      media_type: 'application/pdf',
      data: 'JVBERi0xLjQKJeTjz9IKMSAwIG9iago=',
    },
    title: 'spec.pdf',
    context: 'Anthropic protocol spec',
    citations: { enabled: true },
  },
  // 8. server_tool_use
  {
    type: 'server_tool_use',
    id: 'srv_tool_01',
    name: 'web_search',
    input: { query: 'anthropic messages api' },
  },
  // 9. web_search_tool_result
  {
    type: 'web_search_tool_result',
    tool_use_id: 'srv_tool_01',
    content: [
      {
        type: 'web_search_result',
        url: 'https://docs.anthropic.com/messages',
        title: 'Messages API',
        encrypted_content: 'enc_xxx',
        page_age: '2 days ago',
      },
    ],
  },
  // 10. code_execution_tool_result（Claude 4 Code Interpreter）
  {
    type: 'code_execution_tool_result',
    tool_use_id: 'srv_tool_02',
    content: {
      type: 'code_execution_result',
      stdout: 'Hello World\n',
      stderr: '',
      return_code: 0,
    },
  },
  // 11. bash_code_execution_tool_result（Claude 4 Bash）
  {
    type: 'bash_code_execution_tool_result',
    tool_use_id: 'srv_tool_03',
    content: {
      type: 'code_execution_result',
      stdout: 'total 16\n',
      stderr: '',
      return_code: 0,
    },
  },
  // 12. text_editor_code_execution_tool_result（Claude 4 文件编辑）
  {
    type: 'text_editor_code_execution_tool_result',
    tool_use_id: 'srv_tool_04',
    content: {
      type: 'code_execution_result',
      stdout: '@@ -1,2 +1,2 @@\n-old\n+new\n',
      stderr: '',
      return_code: 0,
    },
  },
  // 13. mcp_tool_use
  {
    type: 'mcp_tool_use',
    id: 'mcp_tool_05',
    name: 'list_files',
    server_name: 'fs-mcp-server',
    input: { path: '/' },
  },
  // 14. mcp_tool_result
  {
    type: 'mcp_tool_result',
    tool_use_id: 'mcp_tool_05',
    is_error: false,
    content: 'README.md\nsrc/\n',
  },
  // 15. container_upload
  {
    type: 'container_upload',
    file_id: 'file_xyz',
    container_id: 'cont_abc',
  },
  // 16. search_result（input 端 retrieval）
  {
    type: 'search_result',
    source: 'kb://product-spec',
    title: 'Product Spec',
    content: [{ type: 'text', text: 'TabTin 是一个让人和 AI Agent 一起干活的平台。' }],
    citations: { enabled: true },
  },
  // 17. tabtin_rich_content
  {
    type: 'tabtin_rich_content',
    kind: 'cli_output_table',
    summary: 'docker ps 输出',
    group_id: 'grp_01',
    payload: { headers: ['CONTAINER ID', 'IMAGE'], rows: [['abc', 'nginx']] },
  },
  // 18. tabtin_composer_preset
  {
    type: 'tabtin_composer_preset',
    preset_id: 'preset.refactor',
    params: { target: 'src/old.ts' },
    source: 'preset',
  },
  // 19. tabtin_ask_user_fields
  {
    type: 'tabtin_ask_user_fields',
    field_values: { name: 'Alice', age: 30 },
  },
  // 20. tabtin_skill_invocation
  {
    type: 'tabtin_skill_invocation',
    skill_id: 'skill.babysit',
    skill_name: 'Babysit PR',
    injected_text: '[Skill: Babysit] Keep PR merge-ready. ...',
    injected_text_summary: 'Babysit skill 已注入',
  },
  // 21. tabtin_source_ref（web kind）
  {
    type: 'tabtin_source_ref',
    source_id: 'src_web_01',
    ref_kind: 'web',
    snapshot: {
      kind: 'web',
      url: 'https://docs.anthropic.com/messages',
      title: 'Anthropic Messages API',
      preview: 'Messages allow you to ...',
      selected_text: 'content blocks array',
    },
  },
  // 22. tabtin_approval_request
  {
    type: 'tabtin_approval_request',
    approval_id: 'apr_01',
    prompt: '是否允许执行 rm -rf /tmp/cache？',
    options: [
      { id: 'allow_once', label: '本次允许' },
      { id: 'allow_session', label: '会话内允许' },
      { id: 'deny', label: '拒绝' },
    ],
    expires_at: '2026-05-10T22:00:00Z',
  },
];

// ════════════════════════════════════════════════════════════════════
// Fixture 2: 边界 case (W0-L1 / W0-L2 / W0-L5 7 类边界)
// ════════════════════════════════════════════════════════════════════

const edgeCases: ContentBlock[] = [
  // (1) 大整数（接近 JS Number.MAX_SAFE_INTEGER）—— int parse 不丢精度
  // 在 ContentBlock 内不直接表达，留 Wave 1 envelope 的 _seq 测；这里给个嵌套 number
  {
    type: 'tool_result',
    tool_use_id: 'toolu_big_int',
    content: [{ type: 'text', text: 'document_index can be large: 9007199254740992' }],
  },
  // (2) 真正的浮点数（必须保留小数）
  {
    type: 'tabtin_source_ref',
    source_id: 'src_doc_float',
    ref_kind: 'doc',
    snapshot: {
      kind: 'doc',
      doc_id: 'doc_xyz',
      page: 12,
      bbox: [0.123, 0.4567, 0.89012, 0.999],
      preview: '附录 A',
    },
  },
  // (3) 显式 null vs missing —— citations.document_title nullable
  {
    type: 'text',
    text: 'with null title citation',
    citations: [
      {
        type: 'char_location',
        cited_text: 'no title',
        document_index: 0,
        document_title: null,
        start_char_index: 0,
        end_char_index: 8,
      },
    ],
  },
  // (4) emoji + escape + surrogate pair + unicode
  {
    type: 'text',
    text: 'emoji 🤔🌍, escape \\n \\t \\" \\\\, unicode 中文 日本語 한국어, surrogate 𝕏 𝟙',
  },
  // (5) 空数组
  {
    type: 'tool_result',
    tool_use_id: 'toolu_empty',
    content: [],
  },
  // (6) 大 base64（10KB+，避免巨型 fixture 但仍是有意义的体量）—— 用 256 字节 *128 = 32KB
  {
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/jpeg',
      // 32KB base64 string
      data: 'A'.repeat(32 * 1024),
    },
  },
  // (7) 未知字段 forward-compat —— 这一项**不能放进 ContentBlockSchema fixture**
  // （zod parse 会拒绝），所以写进单独 forward-compat fixture（见下方）
];

// W0-L1 / W0-L5 (7) 未知字段 forward-compat fixture（独立文件，不经 zod parse）
const forwardCompatFixtures = [
  {
    type: 'text',
    text: 'hi from future',
    _v3_marker: 'future',
    nested_object: { future_field: 42 },
  },
  {
    type: 'tool_use',
    id: 'toolu_future',
    name: 'future_tool',
    input: { future_arg: true },
    future_top_level: 'should be ignored by Pydantic extra=ignore',
  },
];

// ════════════════════════════════════════════════════════════════════
// Fixture 3: tabtin_source_ref 5 ref_kind 全覆盖
// ════════════════════════════════════════════════════════════════════

const sourceRefAllKinds: ContentBlock[] = [
  {
    type: 'tabtin_source_ref',
    source_id: 'src_web_01',
    ref_kind: 'web',
    snapshot: {
      kind: 'web',
      url: 'https://docs.anthropic.com/messages',
      title: 'Anthropic Messages API',
    },
  },
  {
    type: 'tabtin_source_ref',
    source_id: 'src_doc_01',
    ref_kind: 'doc',
    snapshot: {
      kind: 'doc',
      doc_id: 'doc_xyz',
      page: 12,
      bbox: [0.1, 0.2, 0.5, 0.6],
    },
  },
  {
    type: 'tabtin_source_ref',
    source_id: 'src_table_01',
    ref_kind: 'table',
    snapshot: {
      kind: 'table',
      table_id: 'tbl_users',
      row_ids: ['r1', 'r2'],
      field_ids: ['name', 'email'],
      csv_preview: 'name,email\nAlice,a@b.com\n',
    },
  },
  {
    type: 'tabtin_source_ref',
    source_id: 'src_code_01',
    ref_kind: 'code',
    snapshot: {
      kind: 'code',
      file_path: 'src/main.ts',
      start_line: 10,
      end_line: 20,
      code_excerpt: 'export function main() { ... }',
      lang: 'typescript',
    },
  },
  {
    type: 'tabtin_source_ref',
    source_id: 'src_memo_01',
    ref_kind: 'memo',
    snapshot: {
      kind: 'memo',
      memo_id: 'memo_abc',
    },
  },
];

// ════════════════════════════════════════════════════════════════════
// Fixture 4: 6 envelope 全覆盖（W0-L5 修复——PoC 只覆盖 ContentBlockDeltaEvent）
// ════════════════════════════════════════════════════════════════════

const envelopeBase = {
  protocol_version: 'v2' as const,
  min_compatible_version: 'v2' as const,
  trace_id: 'trace_abc123',
  thread_id: 'thread_xyz789',
};

const messageStartFixture: MessageStart = {
  ...envelopeBase,
  _seq: 1,
  event_type: 'agent.stream.message_start',
  message_id: 'msg_01',
  role: 'assistant',
  model_id: 'claude-sonnet-4-7-20260321',
  model_name: 'Claude Sonnet 4.7',
  started_at: '2026-05-10T22:00:00Z',
  run_id: 'run_xyz',
  // 主 LLM 路径用 'llm'；本 fixture 是最常见的"主 LLM 第一轮 begin"形态。
  // 跨端 codegen 后 4 端 vendor 都会基于该 fixture 跑 round-trip 校验。
  message_kind: 'llm',
};

// 协议层 message_kind 3 档全覆盖 fixture（详见
// 让 4 端 vendor round-trip 测试同时验证 'llm' / 'tool_artifact' /
// 'error_envelope' 三种字面量都能正确 encode/decode。
const messageStartToolArtifactFixture: MessageStart = {
  ...envelopeBase,
  _seq: 50,
  event_type: 'agent.stream.message_start',
  message_id: 'msg_tool_artifact_01',
  role: 'assistant',
  // daemon emit `tool_artifact` mini-message 时 model_id 占位为 'tabtin-tool-runtime'
  // （单源在 agent-runtime/envelope-emitter.ts；wire 层不再 export 该字面量）。
  // 跨端识别走 message_kind === 'tool_artifact'，不再依赖此字面量。
  model_id: 'tabtin-tool-runtime',
  model_name: 'tabtin-tool-runtime',
  started_at: '2026-05-10T22:01:00Z',
  run_id: 'run_xyz',
  message_kind: 'tool_artifact',
};

const messageStartErrorEnvelopeFixture: MessageStart = {
  ...envelopeBase,
  _seq: 51,
  event_type: 'agent.stream.message_start',
  message_id: 'msg_error_envelope_01',
  role: 'assistant',
  model_id: 'claude-sonnet-4-7-20260321',
  model_name: 'Claude Sonnet 4.7',
  started_at: '2026-05-10T22:02:00Z',
  run_id: 'run_xyz',
  message_kind: 'error_envelope',
};

const messageDeltaFixture: MessageDelta = {
  ...envelopeBase,
  _seq: 100,
  event_type: 'agent.stream.message_delta',
  message_id: 'msg_01',
  delta: { stop_reason: 'tool_use', stop_sequence: null },
  usage: { input_tokens: 1234, output_tokens: 567, cache_read_input_tokens: 100 },
};

const messageStopFixture: MessageStop = {
  ...envelopeBase,
  _seq: 200,
  event_type: 'agent.stream.message_stop',
  message_id: 'msg_01',
  persisted_id: 'chat_msg_db_id_xxx',
  block_id_overrides: { '0': 'blk_renamed_0', '2': 'blk_renamed_2' },
};

// W4c-L5 · W4.5 第二波 B1：message_stop 兜底路径——partial_reason
// 三档语义 round-trip 验证。三个 fixture 各覆盖一档（aborted /
// stream_interrupted / message_stop_fallback），确保 4 端 codegen 后
// PartialReason 枚举落地正确。
//
// 注：上方 `messageStopFixture` 故意**不带 error_info**，作为"老消费者路径
// （旧版客户端 + W3 前 daemon）"的 baseline——验证 4 端 codegen 后 error_info
// 缺省也能正常 decode 出 nil/None/undefined。
const messageStopFallbackFixture: MessageStop = {
  ...envelopeBase,
  _seq: 201,
  event_type: 'agent.stream.message_stop',
  message_id: 'msg_02',
  persisted_id: 'chat_msg_db_id_fallback',
  error_info: {
    error_class: 'INCOMPLETE_STREAM',
    error_message: '消息结束时仍有未完成的内容块，已兜底保存',
    suggested_action: 'none',
    category: 'protocol_error',
    partial_reason: 'message_stop_fallback',
  },
};

const messageStopAbortedFixture: MessageStop = {
  ...envelopeBase,
  _seq: 202,
  event_type: 'agent.stream.message_stop',
  message_id: 'msg_03',
  persisted_id: 'chat_msg_db_id_aborted',
  error_info: {
    error_class: 'ABORT',
    error_message: '用户已中断',
    suggested_action: 'none',
    category: 'aborted',
    partial_reason: 'aborted',
  },
};

const messageStopInterruptedFixture: MessageStop = {
  ...envelopeBase,
  _seq: 203,
  event_type: 'agent.stream.message_stop',
  message_id: 'msg_04',
  persisted_id: 'chat_msg_db_id_interrupted',
  error_info: {
    error_class: 'LLM_ERROR',
    error_message: '流式响应中断',
    suggested_action: '请重试',
    category: 'timeout',
    partial_reason: 'stream_interrupted',
  },
};

const contentBlockStartFixture: ContentBlockStart = {
  ...envelopeBase,
  _seq: 2,
  event_type: 'agent.stream.content_block_start',
  message_id: 'msg_01',
  index: 0,
  block_id: 'blk_001',
  block: { type: 'text', text: '' },
};

const contentBlockDeltaFixtures: ContentBlockDelta[] = [
  // 6 种 delta.type 全覆盖
  {
    ...envelopeBase,
    _seq: 3,
    event_type: 'agent.stream.content_block_delta',
    message_id: 'msg_01',
    index: 0,
    delta: { type: 'text_delta', text: 'Hello, ' },
  },
  {
    ...envelopeBase,
    _seq: 4,
    event_type: 'agent.stream.content_block_delta',
    message_id: 'msg_01',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"path":"src' },
  },
  {
    ...envelopeBase,
    _seq: 5,
    event_type: 'agent.stream.content_block_delta',
    message_id: 'msg_01',
    index: 2,
    delta: { type: 'thinking_delta', thinking: '我需要思考...' },
  },
  {
    ...envelopeBase,
    _seq: 6,
    event_type: 'agent.stream.content_block_delta',
    message_id: 'msg_01',
    index: 2,
    delta: { type: 'signature_delta', signature: 'sig_abc_xyz_456' },
  },
  {
    ...envelopeBase,
    _seq: 7,
    event_type: 'agent.stream.content_block_delta',
    message_id: 'msg_01',
    index: 0,
    delta: {
      type: 'citations_delta',
      citation: {
        type: 'char_location',
        cited_text: 'cited',
        document_index: 0,
        document_title: 'doc.md',
        start_char_index: 0,
        end_char_index: 5,
      },
    },
  },
  {
    ...envelopeBase,
    _seq: 8,
    event_type: 'agent.stream.content_block_delta',
    message_id: 'msg_01',
    index: 0,
    delta: { type: 'connector_text_delta', connector_text: '\n' },
  },
];

const contentBlockStopFixture: ContentBlockStop = {
  ...envelopeBase,
  _seq: 9,
  event_type: 'agent.stream.content_block_stop',
  message_id: 'msg_01',
  index: 0,
};

// 顶层 union 事件（每种 envelope 一条 sample，序列化为完整对话流）
const anyEventStream: AnyContentBlockStreamEvent[] = [
  messageStartFixture,
  contentBlockStartFixture,
  ...contentBlockDeltaFixtures.slice(0, 1),
  contentBlockStopFixture,
  messageDeltaFixture,
  messageStopFixture,
];

// ════════════════════════════════════════════════════════════════════
// 写文件 + 自校验
// ════════════════════════════════════════════════════════════════════

interface FixtureSpec {
  name: string;
  data: unknown;
  validateWith?: { parse: (x: unknown) => unknown };
}

const fixtures: FixtureSpec[] = [
  { name: 'content_block_22cases.json', data: allContentBlocks, validateWith: ContentBlockSchema },
  { name: 'content_block_edge_cases.json', data: edgeCases, validateWith: ContentBlockSchema },
  // forward-compat 不进 zod schema 验证（故意带未知字段，验证 Pydantic extra=ignore）
  { name: 'content_block_forward_compat.json', data: forwardCompatFixtures },
  {
    name: 'tabtin_source_ref_5kinds.json',
    data: sourceRefAllKinds,
    validateWith: ContentBlockSchema,
  },
  // 6 envelope
  { name: 'envelope_message_start.json', data: messageStartFixture, validateWith: MessageStartSchema },
  // message_kind 三档 round-trip 覆盖（W0 协议层 message_kind 重构）
  {
    name: 'envelope_message_start_message_kinds.json',
    data: [
      messageStartFixture,
      messageStartToolArtifactFixture,
      messageStartErrorEnvelopeFixture,
    ],
    validateWith: MessageStartSchema,
  },
  { name: 'envelope_message_delta.json', data: messageDeltaFixture, validateWith: MessageDeltaSchema },
  { name: 'envelope_message_stop.json', data: messageStopFixture, validateWith: MessageStopSchema },
  // W4c-L5 · W4.5 第二波 B1：partial_reason 三档 round-trip
  {
    name: 'envelope_message_stop_partial_reasons.json',
    data: [
      messageStopFallbackFixture,
      messageStopAbortedFixture,
      messageStopInterruptedFixture,
    ],
    validateWith: MessageStopSchema,
  },
  {
    name: 'envelope_content_block_start.json',
    data: contentBlockStartFixture,
    validateWith: ContentBlockStartSchema,
  },
  {
    name: 'envelope_content_block_delta_6types.json',
    data: contentBlockDeltaFixtures,
    validateWith: ContentBlockDeltaSchema,
  },
  {
    name: 'envelope_content_block_stop.json',
    data: contentBlockStopFixture,
    validateWith: ContentBlockStopSchema,
  },
  {
    name: 'envelope_any_event_stream.json',
    data: anyEventStream,
    validateWith: AnyContentBlockStreamEventSchema,
  },
];

let okCount = 0;
let failCount = 0;
for (const fx of fixtures) {
  const outPath = resolve(FIXTURE_SAMPLES_DIR, fx.name);

  if (fx.validateWith) {
    const items = Array.isArray(fx.data) ? fx.data : [fx.data];
    for (const [i, item] of items.entries()) {
      try {
        fx.validateWith.parse(item);
      } catch (e) {
        console.error(`  ✘ ${fx.name}[${i}] zod self-validate FAIL: ${(e as Error).message}`);
        failCount++;
      }
    }
  }

  writeFileSync(outPath, JSON.stringify(fx.data, null, 2) + '\n');
  console.log(`  ✔ ${fx.name}`);
  okCount++;
}

// ════════════════════════════════════════════════════════════════════
// Cross-language fixtures（W4.5 B3 isStreamEventId 行为契约）
// ────────────────────────────────────────────────────────────────────
// 这些 fixture 不是 zod schema 派生的结构化数据，而是**跨语言函数行为契约**
// （详见 packages/agent-wire/src/cross-lang-fixtures/ 与 README）。本 script
// 把它们 cp 进 fixtures/samples/ 让 4 端 round-trip 测试一并喂——譬如
// Swift main.swift / Kotlin RoundTrip.kt 在拿 ContentBlock 22 case 跑完后
// 顺手对 wave45-isStreamEventId.json 跑 isStreamEventId(input) == expected。
// ════════════════════════════════════════════════════════════════════
const CROSS_LANG_FIXTURES = [
  // W4.5 B3：isStreamEventId 19 case + Unicode 分歧防御
  'wave45-isStreamEventId.json',
] as const;

const crossLangSrcDir = resolve(
  REPO_ROOT,
  'packages',
  'agent-wire',
  'src',
  'cross-lang-fixtures',
);
for (const filename of CROSS_LANG_FIXTURES) {
  const srcPath = resolve(crossLangSrcDir, filename);
  const dstPath = resolve(FIXTURE_SAMPLES_DIR, filename);
  copyFileSync(srcPath, dstPath);
  console.log(`  ✔ ${filename} (cross-lang fixture)`);
  okCount++;
}

console.log(`\n[02_emit_fixtures] 完成：${okCount} 个 fixture 输出到 ${FIXTURE_SAMPLES_DIR}`);
if (failCount > 0) {
  console.error(`✘ ${failCount} 个 fixture self-validate FAIL`);
  process.exit(1);
}
