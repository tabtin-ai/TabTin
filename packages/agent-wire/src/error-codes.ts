/**
 * Unified ErrorCode taxonomy — Single Source of Truth for IPC / CLI / HTTP
 * failure responses across the entire TabTin platform.
 *
 * This file is the **TypeScript canonical source**. The Python and Go mirrors
 * (kept byte-equivalent in their respective code list) live at:
 *
 *   - `apps/tabtin_django/apps/services/common/error_codes.py`
 *     (the `ERROR_CODES` tuple + `ErrorCode` Literal alias section)
 *   - `packages/tabtin-cli-go/internal/errcode/codes.go`
 *
 * All three are sync-checked by `scripts/check-error-codes-sync.py` (wired into
 * `scripts/infra-gate.sh` as a blocking step). Adding / renaming / removing a
 * code MUST update all three files in the same change set.
 *
 * Why string union (not `const enum`, not zod):
 *   - preload bundle cannot import @tabtin/agent-wire (size budget); preload
 *     keeps a static mirror of the value list (same pattern as VALID_AGENT_MODES)
 *   - `as const` array gives both the runtime tuple and the literal union with
 *     no runtime cost and full IDE auto-complete
 *   - zod schema would force `z.infer` round-trips and pull in zod into every
 *     consumer that just wants the type — overkill for a flat string list
 *
 * ─── Two tiers of codes ──────────────────────────────────────────────
 *
 * 1. **Core / generic codes** (this file) — cross-cutting failure modes that
 *    every binding (IPC handler, HTTP route, CLI command) may legitimately
 *    return. Listed in `ERROR_CODES` below.
 *
 * 2. **Domain / business codes** — surface-specific failures (e.g.
 *    `TABDATA_VIEW_LOCKED`, `CHAT_SESSION_FORKED`). Live next to the surface
 *    that owns them, NOT in this file. Naming rule (enforced by review):
 *
 *        <DOMAIN_PREFIX>_<DETAIL>     // SCREAMING_SNAKE_CASE
 *
 *    Approved domain prefixes (extend list when new modules land):
 *
 *        TABDATA_*    TABDOC_*       TABDESIGN_*    TABSLIDE_*
 *        TABCODE_*    TABVIDEO_*     TABSITE_*      TABAGENDA_*
 *        AGENT_*      ORGANIZATION_*     SPACE_*        CHAT_*
 *        SESSION_*    SKILL_*        DEVICE_*       APP_*
 *        BROWSER_*    SHELL_*        FS_*           CREDENTIAL_*
 *
 *    Domain codes are NOT covered by `ErrorCode` type today (Wave 0 keeps the
 *    blast radius small). When Wave 6 migrates surfaces, each surface will
 *    declare its own union and the `errResponse` helper will accept that
 *    surface-local union via generics. Until then, callers wanting to use a
 *    domain code rely on `CliErrorCode`'s `(string & {})` branch (see
 *    `cli-envelope.ts`). The original v1 plan was to require explicit
 *    `as ErrorCode` casts at every call-site — that idea was abandoned
 *    because it violates AGENTS.md "靠工具不靠纪律" and W6 will retire
 *    the loose form anyway.
 *
 *    TODO(W3/W6): retire `CliErrorCode`'s `(string & {})` branch once
 *                 every surface declares its own union.
 *
 * ─── Cousin: GatewayEnvelope (D-7 out of scope) ──────────────────────
 *
 * `agent.stream.*` / `external.*` / `approval.*` traffic uses
 * `GatewayEnvelope` (canonical schema in `@tabtin/contracts/agent`,
 * re-exported from this package's `index.ts`). That envelope has its own
 * error vocabulary in `payload.error` and is intentionally NOT unified here.
 * Wave 0 only covers request-response (IPC invoke / HTTP REST / CLI single
 * call). A future RFC will reconcile streaming envelopes with this taxonomy.
 */

export const ERROR_CODES = [
  // ─── Authentication & Authorization ────────────────────────────────
  /**
   * The credentials presented were syntactically invalid or could not be
   * verified at all (e.g. malformed JWT, signature mismatch). Implies the
   * caller MAY succeed by re-authenticating with valid credentials.
   * For "no credentials provided" use UNAUTHORIZED instead. For "valid
   * but expired credentials" use AUTH_EXPIRED.
   */
  'AUTH_INVALID',
  /**
   * The credentials were valid at issuance but are now past their
   * expiry / revocation horizon. The recommended UX is "silently refresh
   * then retry" rather than full re-login. Distinct from AUTH_INVALID
   * (never valid) and UNAUTHORIZED (no credentials at all).
   */
  'AUTH_EXPIRED',
  /**
   * The request reached an authenticated boundary without proof of identity
   * — e.g. guardedHandle rejecting an untrusted senderFrame, missing JWT on
   * an HTTP route requiring auth, CLI invoked without `tabtin login`.
   */
  'UNAUTHORIZED',
  /**
   * The caller's identity is established but lacks the permission for this
   * specific operation — e.g. a Organization viewer attempting to delete a Space,
   * an Agent without disk access trying `fs:writeFile`.
   */
  'PERMISSION_DENIED',
  /**
   * The request itself is rejected at a security layer regardless of who
   * the caller is — e.g. CSRF check, browser-origin guard on a CLI socket,
   * blocked Host header. Tells the caller "the request shape is forbidden,
   * not your account". Used by `cli-server-core/guards.ts` for DNS
   * rebinding / browser-origin rejection.
   */
  'FORBIDDEN',

  // ─── Resource lookup / shape ───────────────────────────────────────
  /**
   * The addressed resource does not exist (or is not visible to the caller).
   * Generic — domain-specific NOT_FOUND variants (e.g. `ORGANIZATION_NOT_FOUND`)
   * SHOULD use a domain-prefixed code instead when the distinction matters.
   */
  'NOT_FOUND',
  /**
   * The request payload failed schema / business validation — wrong types,
   * missing required fields, value out of range, mutually exclusive flags.
   * Always pair with a `message` that names the offending field.
   */
  'VALIDATION_ERROR',
  /**
   * The operation cannot proceed because the resource is in an incompatible
   * state — concurrent edit, version mismatch, optimistic lock violation,
   * duplicate unique key. Caller MAY retry after refetching state.
   */
  'CONFLICT',

  // ─── Throttling / availability ─────────────────────────────────────
  /**
   * The caller exceeded a rate or quota window. The error SHOULD include a
   * `retryable: true` hint and the message SHOULD describe the window.
   * Distinct from QUOTA_EXCEEDED — RATE_LIMIT_EXCEEDED is "too fast",
   * QUOTA_EXCEEDED is "you've used your allotment".
   */
  'RATE_LIMIT_EXCEEDED',
  /**
   * The caller has consumed their allowed quota for this resource (e.g.
   * billing seats, monthly token budget, daily file-upload count). Unlike
   * RATE_LIMIT_EXCEEDED, this is NOT cleared by waiting — the caller must
   * either upgrade, free up resources, or wait for the next billing cycle.
   * `retryable` SHOULD usually be false; the message SHOULD point at the
   * remediation (`tabtin login` / "upgrade plan" / etc).
   */
  'QUOTA_EXCEEDED',
  /**
   * Operation timed out at the server / process boundary. Distinct from
   * UNAVAILABLE — TIMEOUT means we tried and ran out of time, UNAVAILABLE
   * means we never reached the dependency.
   */
  'TIMEOUT',
  /**
   * A required downstream dependency (Django backend, daemon, MCP server,
   * device runtime) is unreachable or returned 5xx. Caller may retry later.
   */
  'UNAVAILABLE',
  /**
   * Transport-level connectivity failure such as DNS resolution failure,
   * dial failure, or connection refused. Distinct from UNAVAILABLE: this
   * means the client could not establish a connection to the target at all.
   */
  'NETWORK_ERROR',

  // ─── User / cooperative cancellation ───────────────────────────────
  /**
   * The operation was deliberately cancelled — user pressed Esc / cancel
   * button, abort signal fired, parent operation rolled back. NOT a bug;
   * UX should silently dismiss rather than show an error toast. Distinct
   * from SOFT_FAIL (system-side recoverable failure) and INTERNAL_ERROR
   * (server bug).
   */
  'CANCELLED',

  // ─── Capability gating ─────────────────────────────────────────────
  /**
   * The endpoint exists but its handler is not yet implemented or is not
   * available in the current runtime mode (e.g. a Daemon-only command
   * invoked under Electron). UX should tell the user "this isn't
   * available yet" rather than "something went wrong".
   */
  'NOT_IMPLEMENTED',

  // ─── Server-side / catch-all ───────────────────────────────────────
  /**
   * Unexpected server-side error that does not map to any of the codes
   * above. This is the ONLY code that signals "we have a bug" and SHOULD
   * always be paired with a logged stack trace + trace_id.
   */
  'INTERNAL_ERROR',

  // ─── Soft-fail discipline (D-1) ────────────────────────────────────
  /**
   * The operation failed in a recoverable, non-user-visible way (e.g.
   * background memo sync hit an HTTP 500, proactive title generation
   * deferred to next tick). Per D-1 in the contract RFC, fail-soft is a
   * legitimate product semantic but MUST be expressed as `errResponse`
   * with this code so the renderer's preload shim sees `ok:false` and
   * does NOT inject the payload as if it were data.
   */
  'SOFT_FAIL',

  // ─── Transitional safety (D-2) ─────────────────────────────────────
  /**
   * The preload IPC shim received a response that lacks the `ok` field
   * (i.e. legacy `{success}` shape) AND the channel is not on the
   * LEGACY_HANDLERS allow-list. This code is thrown by the shim itself,
   * not produced by handlers — its presence in any response is a bug.
   * Used to surface drift fast during migration; will be removed once
   * Wave 7 collapses the LEGACY_HANDLERS allow-list to empty.
   */
  'LEGACY_SHAPE',

  // ─── IPC lazy-load infrastructure (Wave 2 W2-δ) ────────────────────
  /**
   * A `deferred` IPC stub failed to import its backing module on first
   * invoke. Distinct from INTERNAL_ERROR — this signals that the failure
   * is in IPC infrastructure (module resolution / circular import / build
   * artifact missing) rather than the handler's own business logic. The
   * stub deletes its load cache so the next invoke retries the import,
   * which is the right behaviour for transient `import()` failures (e.g.
   * dev server hot-swap mid-request). Non-transient failures will keep
   * surfacing the same code on every invoke until the module is fixed.
   *
   * Where it's produced: `apps/tabtin-electron/src/main/ipc-lazy.ts`
   * stub `catch` branch on the awaited `mod.load()` promise.
   */
  'LOAD_FAILED',
  /**
   * The deferred module loaded successfully but its exported `handlers`
   * map does not contain the requested channel. This is a config / build
   * bug (`DEFERRED_MODULES.channels` listed a channel the module forgot
   * to export), not a transient failure — every retry will produce the
   * same code until the module's handler map is corrected.
   *
   * Where it's produced: `apps/tabtin-electron/src/main/ipc-lazy.ts`
   * stub after the load promise resolves but `handlers[channel]` is
   * undefined. Distinct from NOT_IMPLEMENTED (which is a deliberate
   * "this surface isn't built yet" signal at the surface layer).
   */
  'HANDLER_NOT_FOUND',
] as const;

/**
 * The complete set of generic ErrorCode values used by TabTin's
 * request-response envelope. See file header for tier rules.
 */
export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Runtime guard — checks whether an arbitrary string is a recognized
 * generic ErrorCode. Useful at IPC / HTTP boundaries where the value
 * has been deserialized from JSON and erased to `string`.
 */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}
