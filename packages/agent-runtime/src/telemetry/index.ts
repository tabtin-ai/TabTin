/**
 * @tabtin/agent-runtime/telemetry — 结构化埋点 API 统一出口。
 *
 * 使用指南：`packages/agent-runtime/TELEMETRY.md`
 */

export type {
  TelemetryRecord,
  TelemetrySink,
  TelemetryEmitOptions,
} from './types.js';

export {
  TelemetryEvents,
  type TelemetryEventName,
} from './events.js';

export {
  setTelemetrySink,
  resetTelemetrySink,
  setTelemetryDebug,
  emitTelemetryEvent,
} from './emitter.js';

export {
  hashSensitive,
  redactCustomRules,
  redactErrorBody,
  redactMessageContent,
  type CustomRulesFingerprint,
  type ErrorBodyFingerprint,
  type MessageFingerprint,
} from './redact.js';

export {
  emitMttrStart,
  emitMttrResolved,
  generateIncidentId,
  type MttrStartPayload,
  type MttrResolvedPayload,
} from './mttr.js';
