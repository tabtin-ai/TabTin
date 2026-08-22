/**
 * Step 1: zod schema (`@tabtin/agent-wire`) → JSON Schema (Draft 7) +
 * 后处理（注入 `oneOf + discriminator: {propertyName: type}`，覆盖 zod-to-
 * json-schema 默认输出 anyOf 没 discriminator marker 的问题）。
 *
 * 输出：fixtures/json-schemas/*.json
 *
 * 用法：tsx packages/wire-codegen/scripts/01_emit_json_schema.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  ContentBlockSchema,
  MessageStartSchema,
  MessageDeltaSchema,
  MessageStopSchema,
  ContentBlockStartSchema,
  ContentBlockDeltaSchema,
  ContentBlockStopSchema,
  AnyContentBlockStreamEventSchema,
  ToolResultBlockSchema,
  TabTinSourceRefBlockSchema,
  ImageBlockSchema,
  CitationSchema,
  ImageSourceSchema,
  DocumentSourceSchema,
  ToolExecutionMetadataSchema,
  CodeExecutionResultContentSchema,
  ToolResultInlineBlockSchema,
  StreamEnvelopeBaseSchema,
  ContentBlockDeltaPayloadSchema,
  MessageUsageSchema,
  ErrorInfoSchema,
  PartialReasonSchema,
  // 战场 B · 第一类：已有 zod schema，扩 codegen 生成 Swift
  StreamLifecycleSchema,
  StreamDoneSchema,
  StreamStepSchema,
  StreamSystemNoticeSchema,
  StreamCompactionSchema,
  CompactionStatsSchema,
  PlanProposalEventPayloadSchema,
  ModeSwitchProposalEventPayloadSchema,
  SourceMetaSchema,
  PlanEntrySchema,
  UsageReportSchema,
  // 战场 B · 第二类：approval / ask（需 const/enum Swift 生成器支持）
  ApprovalRequestedPayloadSchema,
  ApprovalResolvedPayloadSchema,
  AskInteractionRequestSchema,
  AskUserRequestSchema,
  AskFormRequestSchema,
  RequestApprovalRequestSchema,
  DecisionReasonSchema,
} from '@tabtin/agent-wire';
import { SCHEMAS_DIR } from './lib/paths.js';
import { injectDiscriminatorMarkers } from './lib/inject_discriminator.js';

interface Job {
  name: string;
  rootName: string;
  schema: unknown;
}

const jobs: Job[] = [
  // 顶层联合（Wave 2-6 主要消费）
  { name: 'content_block', rootName: 'ContentBlock', schema: ContentBlockSchema },
  // 6 envelope schema 全覆盖（W0-L5：PoC 只覆盖 ContentBlockDeltaEvent）
  { name: 'message_start', rootName: 'MessageStart', schema: MessageStartSchema },
  { name: 'message_delta', rootName: 'MessageDelta', schema: MessageDeltaSchema },
  { name: 'message_stop', rootName: 'MessageStop', schema: MessageStopSchema },
  { name: 'content_block_start', rootName: 'ContentBlockStart', schema: ContentBlockStartSchema },
  { name: 'content_block_delta', rootName: 'ContentBlockDelta', schema: ContentBlockDeltaSchema },
  { name: 'content_block_stop', rootName: 'ContentBlockStop', schema: ContentBlockStopSchema },
  // 顶层事件 union（消费方分发用）
  {
    name: 'any_event',
    rootName: 'AnyContentBlockStreamEvent',
    schema: AnyContentBlockStreamEventSchema,
  },
  // 单类型 schema（fixture round-trip 验证用，方便 Pydantic 单 Model.model_validate）
  { name: 'tool_result_block', rootName: 'ToolResultBlock', schema: ToolResultBlockSchema },
  {
    name: 'tabtin_source_ref_block',
    rootName: 'TabTinSourceRefBlock',
    schema: TabTinSourceRefBlockSchema,
  },
  { name: 'image_block', rootName: 'ImageBlock', schema: ImageBlockSchema },
  // 战场 B · 第一类：stream 业务事件 payload（lifecycle/done/plan 等）
  { name: 'stream_lifecycle', rootName: 'StreamLifecycle', schema: StreamLifecycleSchema },
  { name: 'stream_done', rootName: 'StreamDone', schema: StreamDoneSchema },
  { name: 'stream_step', rootName: 'StreamStep', schema: StreamStepSchema },
  {
    name: 'stream_system_notice',
    rootName: 'StreamSystemNotice',
    schema: StreamSystemNoticeSchema,
  },
  { name: 'stream_compaction', rootName: 'StreamCompaction', schema: StreamCompactionSchema },
  {
    name: 'plan_proposal',
    rootName: 'PlanProposalEventPayload',
    schema: PlanProposalEventPayloadSchema,
  },
  {
    name: 'mode_switch_proposal',
    rootName: 'ModeSwitchProposalEventPayload',
    schema: ModeSwitchProposalEventPayloadSchema,
  },
  // 战场 B · 第二类：approval / ask
  {
    name: 'approval_requested',
    rootName: 'ApprovalRequestedPayload',
    schema: ApprovalRequestedPayloadSchema,
  },
  {
    name: 'approval_resolved',
    rootName: 'ApprovalResolvedPayload',
    schema: ApprovalResolvedPayloadSchema,
  },
  {
    name: 'ask_interaction_request',
    rootName: 'AskInteractionRequest',
    schema: AskInteractionRequestSchema,
  },
  { name: 'ask_user_request', rootName: 'AskUserRequest', schema: AskUserRequestSchema },
  { name: 'ask_form_request', rootName: 'AskFormRequest', schema: AskFormRequestSchema },
  {
    name: 'request_approval_request',
    rootName: 'RequestApprovalRequest',
    schema: RequestApprovalRequestSchema,
  },
  { name: 'decision_reason', rootName: 'DecisionReason', schema: DecisionReasonSchema },
];

/**
 * 共享 definitions——所有 schema 文件都注入这套命名子结构。
 * 让 zod-to-json-schema 输出 `$ref: #/definitions/Citation` 而非内联展开。
 *
 * 必要性（W0-L4 + Swift codegen 嵌套 anyOf path 解析问题）：
 * 没有 named definitions 时，ImageSourceSchema 在 ContentBlock 的 image case
 * 内 inline 展开为 anyOf，路径变成 `#/definitions/ContentBlock/anyOf/N/properties/source`
 * ——Swift/Kotlin codegen 解析这种深路径会失败 + 重复生成"颜色命名"垃圾类型。
 *
 * 注入命名 definitions 后所有引用统一为 `#/definitions/ImageSource`，codegen
 * 一次生成 `ImageSource` enum，跨 schema 复用。
 */
const sharedDefinitions = {
  Citation: CitationSchema,
  ImageSource: ImageSourceSchema,
  DocumentSource: DocumentSourceSchema,
  ToolExecutionMetadata: ToolExecutionMetadataSchema,
  CodeExecutionResultContent: CodeExecutionResultContentSchema,
  ToolResultInlineBlock: ToolResultInlineBlockSchema,
  StreamEnvelopeBase: StreamEnvelopeBaseSchema,
  ContentBlockDeltaPayload: ContentBlockDeltaPayloadSchema,
  MessageUsage: MessageUsageSchema,
  // W4c-L5 · W4.5 第二波 B1：让 MessageStop.error_info 引用命名 ErrorInfo
  // 而非 inline 展开（避免 Python anonymous BaseModel / Swift 重复匿名 enum
  // / Kotlin inner sealed class 等 codegen 蛛网类型）。partial_reason 三档
  // 字面量同步命名，方便 4 端引用 PartialReason 类型。
  ErrorInfo: ErrorInfoSchema,
  PartialReason: PartialReasonSchema,
  // 战场 B · 第一类：stream 事件 payload 引用的共享子结构
  SourceMeta: SourceMetaSchema,
  PlanEntry: PlanEntrySchema,
  UsageReport: UsageReportSchema,
  CompactionStats: CompactionStatsSchema,
} as const;

mkdirSync(SCHEMAS_DIR, { recursive: true });

let okCount = 0;
for (const job of jobs) {
  // ContentBlock schema 加进 definitions（让 envelope schemas 引用它而不内联）
  const definitions: Record<string, unknown> = { ...sharedDefinitions };
  if (job.name !== 'content_block') {
    definitions['ContentBlock'] = ContentBlockSchema;
  }

  const json = zodToJsonSchema(job.schema as never, {
    name: job.rootName,
    target: 'jsonSchema7',
    // zod-to-json-schema 的 definitions 期望 Record<string, ZodType>；
    // 我们 sharedDefinitions 里都是 zod schema，TS 推断成 Record<string, unknown>
    // 是因为 spread 时丢了具体类型。强制转成期望类型即可。
    definitions: definitions as never,
  });
  // 后处理：把 anyOf 含 type literal discriminator 的转换为 oneOf + discriminator 标注
  const patched = injectDiscriminatorMarkers(json as Record<string, unknown>);
  const outPath = resolve(SCHEMAS_DIR, `${job.name}.json`);
  writeFileSync(outPath, JSON.stringify(patched, null, 2) + '\n');
  console.log(`  ✔ ${job.name}.json`);
  okCount++;
}

console.log(`\n[01_emit_json_schema] 完成：${okCount} 个 JSON Schema 输出到 ${SCHEMAS_DIR}`);
