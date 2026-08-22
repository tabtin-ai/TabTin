/**
 * Unified CLI / IPC response envelope for Engine ↔ CLI ↔ Renderer
 * communication.
 *
 * The Electron main process (IPC), Daemon CLI Server (Unix socket) and the
 * `tabtin` CLI binary (HTTP-style stdout) all produce `{ ok, data }` /
 * `{ ok, error }` envelopes via these helpers. Centralizing the shape keeps
 * all three transports observable (preload shim can detect failure without
 * knowing the channel) and traceable (`trace_id` flows from main → renderer
 * → toast).
 *
 * NOT used for:
 *   - Backend Django REST APIs — Django still emits a mix of two shapes:
 *     the legacy `{ success, code, message, data }` helper
 *     (`apps.i18n.response.success_response` / `error_response`) and the
 *     new envelope `{ ok, data }` / `{ ok, error, trace_id, ... }` helper
 *     (`apps.services.common.error_codes.ok_response` / `err_response`).
 *     **W6 / W7 will retire the legacy helper**; until then both shapes
 *     coexist on the wire.
 *
 *     **Wave 2 status (renderer-side handling).** `api-proxy` (Electron
 *     main) **passes Django responses through unmodified** — it only
 *     stamps `X-Request-Id` for trace continuity, never rewrites the body.
 *     Two renderer-side adapters interpret the body:
 *       1. `tabtin-chat-client/src/core/http-client.ts.unwrapResponse`
 *          accepts **both** shapes — it identifies the new envelope first
 *          (`'ok' in json`), throws `ChatAPIError` with `code` /
 *          `trace_id` / `detail` on `ok:false`, and falls back to the
 *          legacy `'success' in json` branch for backward compatibility.
 *       2. `apps/tabtin-electron/src/renderer/src/services/api.ts`
 *          (axios-based) currently only unwraps the legacy
 *          `{ success, data }` shape. Migrating that path to envelope-
 *          aware unwrap is tracked in the contract project as part of the
 *          PlatformSurface framework rollout (W3+).
 *
 *     **Wave 3+ direction.** Once `definePlatformSurface` lands, every
 *     surface emits envelope at its **main-process binding boundary**, so
 *     api-proxy / IPC pass-through carry envelope only. The legacy
 *     unwrap branch in `HttpClient.unwrapResponse` becomes a deprecation
 *     guard until W6 / W7 deletes it altogether.
 *
 *   - WS Gateway protocol — uses `GatewayEnvelope` (canonical schema lives
 *     in `@tabtin/contracts/agent`; this package re-exports it from
 *     `./index.ts`). D-7 in the contract RFC keeps streaming envelopes out
 *     of scope.
 *
 * ─── Field placement ─────────────────────────────────────────────────
 *
 * `trace_id` lives at the **envelope top level** (alongside `ok`), the
 * same position it occupies on `GatewayEnvelope`. This single placement:
 *
 *   - Lets log-aggregation pipelines join Cli + Gateway streams on a
 *     single field path (no `r.error?.trace_id ?? r.meta?.trace_id`
 *     fallback chain).
 *   - Avoids the original v1 design's split between `error.trace_id`
 *     (errors only) and `meta.trace_id` (everything else) — Wave 0
 *     review surfaced that as a footgun.
 *
 * `duration_ms` (server-measured execution time) likewise lives at the
 * top level. Anything else "metadata-shaped" should be added with
 * intent: prefer adding a top-level field over reintroducing a `meta`
 * sub-object.
 */

import type { ErrorCode } from './error-codes.js';

// ─── Types ───────────────────────────────────────────────────────────

/**
 * Loose union over the unified `ErrorCode` taxonomy.
 *
 * The intent of this type is "IDE auto-completes the canonical codes
 * but legacy / surface-local codes still type-check during the migration
 * window". Concretely:
 *
 *   - Typing `'NOT_FO'` in your editor → completes to `'NOT_FOUND'` (good)
 *   - Passing `'TABDATA_VIEW_LOCKED'` → still type-checks (no false break)
 *
 * The `(string & {})` branch is a well-known TypeScript escape hatch for
 * "string union plus arbitrary string"; without it, the union collapses
 * to `string` and loses auto-complete entirely.
 *
 * ─── ⚠️  PRICE OF THE LOOSE BRANCH (read this) ────────────────────────
 *
 * The `(string & {})` branch is **load-bearing for migration speed** but
 * it is **not** a substitute for validation:
 *
 *   - `errResponse('not_found', ...)` (lowercase) — type-checks ❌
 *   - `errResponse('NOT-FOUND', ...)` (hyphen)    — type-checks ❌
 *   - `errResponse('NOT_FOUDN', ...)` (typo)      — type-checks ❌
 *
 * In other words: the IDE will guide you to the canonical names, but it
 * will NOT stop you from inventing your own. Until the lint rule in W2
 * lands (`scripts/check-error-codes-sync.py` only checks the source-of-
 * truth lists, not call-sites), every PR introducing an `errResponse(...)`
 * call MUST be reviewed for code-string correctness — this is one of the
 * few places where AGENTS.md "靠工具不靠纪律" is temporarily relaxed.
 *
 * Once Wave 6 introduces per-surface generics
 * (`definePlatformSurface({ errorCodes: [...] })`), each surface will
 * narrow `code` to its own union and this loose form will be retired.
 *
 * TODO(W2): add ESLint rule `no-unknown-error-code` — argument literal
 *           must be in `ERROR_CODES` or match the domain prefix list.
 * TODO(W6): replace `CliErrorCode` with per-surface unions; delete the
 *           `(string & {})` branch.
 */
// eslint-disable-next-line @typescript-eslint/ban-types
export type CliErrorCode = ErrorCode | (string & {});

/**
 * Shape returned in `error` of a failed envelope. The `code` field uses
 * the loose `CliErrorCode` form — see its docstring for migration plan.
 *
 * `trace_id` is intentionally NOT here — it lives on the envelope top
 * level so successful responses can carry it too.
 */
export interface CliErrorDetail {
  code: CliErrorCode;
  message: string;
  /**
   * Hint to the caller that retrying with the same input may succeed
   * (e.g. RATE_LIMIT_EXCEEDED, TIMEOUT, UNAVAILABLE). Defaults to false.
   */
  retryable?: boolean;
  /**
   * Human-readable suggestions surfaced in toasts / CLI hints (e.g.
   * "run `tabtin login` to refresh your session").
   */
  suggestions?: string[];
  /**
   * Structured diagnostic payload (D-1 SOFT_FAIL contract).
   *
   * The most common shape is `{ fallback: <originalData> }` for
   * fail-soft paths (titleGen / approval-memo background sync /
   * proactive poller etc.) where the server still wants to surface
   * "best-effort" data the renderer MAY opt into. Default behaviour is
   * "throw on ok:false" so forgetting the opt-in keeps the failure
   * visible — exactly the trap-door fix W1 A2 was created for.
   *
   * Other domain-specific keys (e.g. `current_generation` for memo
   * conflicts, `retry_after` for rate limits) may be added — but
   * `detail.fallback` is the contract for SOFT_FAIL.
   */
  detail?: Record<string, unknown>;
}

/**
 * Fields that may appear on **every** envelope (success or failure)
 * regardless of whether `data` or `error` is set.
 */
interface CliEnvelopeMeta {
  /**
   * End-to-end trace identifier for observability. Snake-case to match
   * `GatewayEnvelope.trace_id`.
   *
   * ─── Wave 0 status: field-only (schema lives, links don't) ──────────
   *
   * The wire shape exposes this slot, but the producers / consumers that
   * make it meaningful are split across later Waves. Concretely:
   *
   *   - **Producer (server side).** Django auto-injects from
   *     `request.request_id` via `apps.services.common.error_codes
   *     .err_response()` / `ok_response()`. Electron main and the daemon
   *     CLI server do NOT yet inject — Wave 1 D3 will populate via a
   *     main-process `AsyncLocalStorage` mirror of the outgoing
   *     `X-Request-Id`, plus a Django middleware change that echoes the
   *     header back on the response so the main side can read it without
   *     parsing every body.
   *   - **Consumer (renderer side).** Wave 2 will introduce a preload
   *     shim that, on `ok:false` envelopes, displays the last 6 chars of
   *     `trace_id` in toasts so users can quote it in bug reports. There
   *     is **no such consumer today** — assertions like "user reads
   *     trace_id from a toast" hold only after W2 ships.
   *   - **Audit-log join key.** Wave 5 will adopt the full value as the
   *     join key across the cross-stack audit log; depends on the W1
   *     producer landing first.
   *
   * In other words: the schema is in place so callers can already round-
   * trip `trace_id` end-to-end without breaking, but until Wave 2 ships,
   * IPC / CLI binary call paths typically carry `trace_id: undefined`
   * and no UI surfaces it.
   */
  trace_id?: string;
  /**
   * Server-measured execution time, milliseconds. Same Wave-status
   * caveat as `trace_id` — the field is available on the wire today,
   * the audit-log dashboard that consumes it lands in Wave 5.
   */
  duration_ms?: number;
}

export interface CliOkResponse<T = unknown> extends CliEnvelopeMeta {
  ok: true;
  data: T;
}

export interface CliErrorResponse extends CliEnvelopeMeta {
  ok: false;
  error: CliErrorDetail;
}

export type CliResponse<T = unknown> = CliOkResponse<T> | CliErrorResponse;

// ─── Factories ───────────────────────────────────────────────────────

export interface OkResponseOptions {
  /** See {@link CliEnvelopeMeta.trace_id}. */
  trace_id?: string;
  /** See {@link CliEnvelopeMeta.duration_ms}. */
  duration_ms?: number;
}

/**
 * Build a successful envelope. Optional fields are only emitted when
 * provided so the common case `okResponse(data)` produces the minimal
 * `{ ok: true, data }` shape.
 */
export function okResponse<T>(data: T, opts?: OkResponseOptions): CliOkResponse<T> {
  const env: CliOkResponse<T> = { ok: true, data };
  if (opts?.trace_id !== undefined) env.trace_id = opts.trace_id;
  if (opts?.duration_ms !== undefined) env.duration_ms = opts.duration_ms;
  return env;
}

export interface ErrResponseOptions {
  /** See {@link CliErrorDetail.retryable}. Defaults to `false`. */
  retryable?: boolean;
  /** See {@link CliErrorDetail.suggestions}. Empty array is dropped. */
  suggestions?: string[];
  /** See {@link CliEnvelopeMeta.trace_id}. */
  trace_id?: string;
  /** See {@link CliEnvelopeMeta.duration_ms}. */
  duration_ms?: number;
  /**
   * See {@link CliErrorDetail.detail}. The canonical SOFT_FAIL shape is
   * `{ fallback: <originalData> }`; pass-through other domain keys as
   * needed (e.g. `current_generation` for CONFLICT).
   */
  detail?: Record<string, unknown>;
}

export function errResponse(
  code: CliErrorCode,
  message: string,
  opts?: ErrResponseOptions,
): CliErrorResponse {
  const error: CliErrorDetail = {
    code,
    message,
    retryable: opts?.retryable ?? false,
  };
  if (opts?.suggestions?.length) {
    error.suggestions = opts.suggestions;
  }
  if (opts?.detail !== undefined) {
    error.detail = opts.detail;
  }
  const env: CliErrorResponse = { ok: false, error };
  if (opts?.trace_id !== undefined) env.trace_id = opts.trace_id;
  if (opts?.duration_ms !== undefined) env.duration_ms = opts.duration_ms;
  return env;
}
