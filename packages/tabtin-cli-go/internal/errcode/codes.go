// Package errcode provides the unified ErrorCode taxonomy used by the
// `tabtin` CLI binary when emitting envelope responses (see internal/output).
//
// **DO NOT EDIT IN ISOLATION** — this file is a strict mirror of:
//
//	packages/agent-wire/src/error-codes.ts        (TypeScript canonical source)
//	apps/tabtin_django/apps/services/common/error_codes.py  (Python mirror)
//
// Sync is enforced by scripts/check-error-codes-sync.py (blocking step in
// scripts/infra-gate.sh). Any add / rename / remove MUST update all three
// files in the same change set.
//
// Why mirror instead of generate? At the time this was set up the three
// stacks (TS / Py / Go) had different release cadences and code-gen would
// have introduced a build-order coupling. The canonical source is TypeScript;
// add the new code there first, then mirror here and in Python.
//
// Two tiers of codes — see TS file header for details:
//
//  1. Generic codes (this file) — cross-cutting failure modes.
//  2. Domain codes (NOT here) — surface-specific, kept next to the surface
//     that owns them. Naming rule: <DOMAIN_PREFIX>_<DETAIL>, all-caps.
//
// ─── 中文工作说明 ─────────────────────────────────────────────
//
// 错误码闭集分两层（详见 docs/agent/cli-spec/cli-protocol.md §5）：
//
//  1. Generic 闭集：本文件下方的 const 块 + All()，是 TS canonical /
//     Py mirror / Go mirror 三栈强制同步的部分。
//     校验脚本：scripts/check-error-codes-sync.py（接入 infra-gate）。
//     ⚠️ 修改这层 const 块必须同步三栈，否则 CI fail。
//
//  2. Domain 闭集：每个 App 通过 errcode.RegisterDomain 注册自己的
//     prefix + codes（见 domain.go）。命名规则：全大写下划线、必须以
//     domain 前缀开头、长度 ≤ 40、不含数字。
//
// IsErrorCode 同时识别上述两层；只想判 domain 用 IsDomainCode；
// 只想拿 generic 列表（如三栈 mirror 校验）用 All()，它语义只覆盖第 1 层。
package errcode

// ErrorCode is the type of an envelope error.code value. CLI consumers
// SHOULD compare against the constants below rather than raw strings so
// the compiler catches typos.
type ErrorCode string

// Generic ErrorCode constants. Keep ordered identically to the TS / Py
// mirrors to make code review easier (the sync checker compares as sets,
// not lists, so order is not enforced — but matching order helps humans).
const (
	// AuthInvalid: credentials presented were syntactically invalid or
	// could not be verified at all (malformed JWT, signature mismatch).
	// Distinct from AuthExpired (valid then expired) and Unauthorized
	// (no credentials at all).
	AuthInvalid ErrorCode = "AUTH_INVALID"
	// AuthExpired: credentials were valid at issuance but past expiry.
	// UX recommendation is silent refresh + retry rather than re-login.
	AuthExpired ErrorCode = "AUTH_EXPIRED"
	// Unauthorized: request reached an authenticated boundary without proof
	// of identity (no JWT, untrusted senderFrame, no `tabtin login`).
	Unauthorized ErrorCode = "UNAUTHORIZED"
	// PermissionDenied: identity is established but lacks permission for
	// this operation.
	PermissionDenied ErrorCode = "PERMISSION_DENIED"
	// Forbidden: request itself is rejected at a security layer regardless
	// of caller identity (CSRF / browser-origin / DNS rebinding guard).
	Forbidden ErrorCode = "FORBIDDEN"

	// NotFound: addressed resource does not exist or is not visible.
	NotFound ErrorCode = "NOT_FOUND"
	// ValidationError: payload failed schema / business validation.
	ValidationError ErrorCode = "VALIDATION_ERROR"
	// Conflict: incompatible state (concurrent edit, version mismatch).
	Conflict ErrorCode = "CONFLICT"

	// RateLimitExceeded: caller exceeded a rate window ("too fast"). Use
	// QuotaExceeded for allotment-style limits ("used your share").
	RateLimitExceeded ErrorCode = "RATE_LIMIT_EXCEEDED"
	// QuotaExceeded: caller has consumed their allowed allotment (billing
	// seats, monthly tokens, daily uploads). Not cleared by waiting; caller
	// must upgrade / free resources / wait for the next billing cycle.
	QuotaExceeded ErrorCode = "QUOTA_EXCEEDED"
	// Timeout: server-side operation ran out of time.
	Timeout ErrorCode = "TIMEOUT"
	// Unavailable: required downstream dependency is unreachable.
	Unavailable ErrorCode = "UNAVAILABLE"
	// NetworkError: transport-level connectivity failure (dial failed,
	// connection refused, DNS resolution error). Distinct from Unavailable
	// which indicates the service exists but is temporarily down.
	NetworkError ErrorCode = "NETWORK_ERROR"

	// Cancelled: deliberate user / parent cancellation. UX should silently
	// dismiss; not a bug. Distinct from SoftFail (recoverable system
	// failure) and InternalError (server bug).
	Cancelled ErrorCode = "CANCELLED"

	// NotImplemented: endpoint exists but handler is unimplemented or
	// unavailable in the current runtime mode.
	NotImplemented ErrorCode = "NOT_IMPLEMENTED"

	// InternalError: unexpected server-side bug; pair with logged stack
	// trace + trace_id.
	InternalError ErrorCode = "INTERNAL_ERROR"

	// SoftFail: recoverable, non-user-visible failure (background sync,
	// proactive prefetch). Per D-1 in the contract RFC, fail-soft is a
	// legitimate semantic but MUST be expressed via this code so consumers
	// can branch on ok=false rather than mis-interpreting the payload.
	SoftFail ErrorCode = "SOFT_FAIL"

	// LegacyShape: surfaced by the preload IPC shim when it sees a
	// response that lacks `ok` AND the channel is not on the
	// LEGACY_HANDLERS allow-list. A handler producing this code is a bug.
	LegacyShape ErrorCode = "LEGACY_SHAPE"

	// LoadFailed: a deferred IPC stub failed to import its backing module
	// on first invoke. Signals an infrastructure-layer failure (module
	// resolution / circular import / build artifact missing) rather than
	// a handler-side business error. Distinct from InternalError so
	// callers can branch retry logic appropriately.
	LoadFailed ErrorCode = "LOAD_FAILED"

	// HandlerNotFound: deferred module loaded successfully but its
	// handlers map does not contain the requested channel. A config /
	// build bug (the module's DEFERRED_MODULES.channels listing drifted
	// from its actual `handlers` export); retrying will not help.
	// Distinct from NotImplemented which is a deliberate "this surface
	// isn't built yet" at the surface layer.
	HandlerNotFound ErrorCode = "HANDLER_NOT_FOUND"
)

// All returns the full set of generic ErrorCode values. Useful for
// validation, listing in `--help` output, and the sync checker.
func All() []ErrorCode {
	return []ErrorCode{
		AuthInvalid,
		AuthExpired,
		Unauthorized,
		PermissionDenied,
		Forbidden,
		NotFound,
		ValidationError,
		Conflict,
		RateLimitExceeded,
		QuotaExceeded,
		Timeout,
		Unavailable,
		NetworkError,
		Cancelled,
		NotImplemented,
		InternalError,
		SoftFail,
		LegacyShape,
		LoadFailed,
		HandlerNotFound,
	}
}

// IsErrorCode reports whether the given string is a recognized ErrorCode
// from either the generic closed set (see All()) or any domain closed set
// registered via RegisterDomain (see domain.go).
//
// 行为变更说明：在 domain 注册机制引入之前，本函数只命中 generic 闭集；
// 现在也命中所有已 RegisterDomain 过的 domain code。仅想判定 generic
// 请直接遍历 All()；仅想判定 domain 请用 IsDomainCode。
func IsErrorCode(value string) bool {
	for _, c := range All() {
		if string(c) == value {
			return true
		}
	}
	return IsDomainCode(ErrorCode(value))
}
