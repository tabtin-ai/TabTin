/**
 * Cross-platform device permission contract — single source of truth.
 *
 * Background
 * ----------
 * After security-policy v1 retirement (commit 3478d8972), the device
 * permission matrix is no longer maintained in this package. The runtime
 * authority is split:
 *
 *   - Django `apps/services/common/sandbox_policy.py` is the server-side
 *     policy authority (4 presets default values).
 *   - iOS `WebSocketService.swift` and Android `SecurityPolicyChecker.kt`
 *     each maintain their own `action → permission key` mapping for
 *     client-side evaluation.
 *
 * Without an explicit contract, any two of these three sides can silently
 * diverge — and historically they have (#L55(c1) get_system_setting
 * routed to set_system on mobile while Electron allowed; #L55(c2)
 * screen_wait_for_* routed to write semantics on mobile while TS treated
 * them as read).
 *
 * This module is the *embedded* contract: a textual SSoT that
 * `tests/cross-language-contract.test.ts` reads and verifies via grep
 * across the 3 enforcement sites + Django 4 presets. Any drift fails CI.
 *
 * Why not auto-generate the per-language mapping from this module?
 * ----------------------------------------------------------------
 * 1. Each side is owned by its own runtime team (iOS / Android / Django)
 *    and may need extra entries this contract does not cover (e.g. local
 *    tap-and-hold variants only meaningful on Android).
 * 2. Codegen would couple Swift / Kotlin / Python build pipelines to this
 *    package — a level of intrusion not justified for ~4 locked entries.
 * 3. The contract test approach (grep + drift assertion) is operationally
 *    cheap and catches the same class of bugs.
 *
 * When to add a new entry
 * -----------------------
 * Only when product decision has converged on all 3 enforcement sides
 * (iOS + Android + Django) AND the inter-side semantics is stable.
 * Add to `AUTHORITATIVE_ACTION_PERMISSION_MAPPING` + `MAPPING_NOTES`,
 * then ensure the new entry exists at all 3 sites (iOS / Android), plus
 * Django 4-preset entries if it is also a permission key.
 */

/**
 * Authoritative action → permission key mapping shared by iOS + Android.
 *
 * Each entry must satisfy:
 *   1. iOS WebSocketService.swift maps `<action>` to this permission key.
 *   2. Android SecurityPolicyChecker.kt maps `<action>` to this permission key.
 *   3. Django sandbox_policy.py 4 presets each declare a default value
 *      for the permission key (see {@link AUTHORITATIVE_DJANGO_PRESET_VALUES}).
 *
 * Drift on any of the above is a CI-blocking failure.
 */
export const AUTHORITATIVE_ACTION_PERMISSION_MAPPING: Readonly<
  Record<string, string>
> = {
  screen_force_stop_app: 'force_stop_app',
  get_system_setting: 'device_info',
  screen_wait_for_idle: 'screen_capture',
  screen_wait_for_element: 'screen_capture',
};

/**
 * Per-entry rationale — surfaced to engineers when the contract test fails.
 * Not part of the contract proper; do not consume programmatically.
 */
export const AUTHORITATIVE_ACTION_MAPPING_NOTES: Readonly<
  Record<string, string>
> = {
  screen_force_stop_app:
    'W A0.4: split from launch_app — irreversible action under cautious preset must not piggy-back on launch_app gating.',
  get_system_setting:
    '#L55(c1) bug fix: read semantics (Django tool def required_permission=read + risk_level=safe). Mobile previously mapped to set_system blocked under collaborative preset while Electron allowed — historical bug.',
  screen_wait_for_idle:
    '#L55(c2) Option B: passive wait + UI tree read = read semantics. Mobile prior screen_tap mapping leaked write-side mental model.',
  screen_wait_for_element:
    '#L55(c2) Option B: docstring states "Polls the UI tree" — read semantics, same as wait_for_idle.',
};

/**
 * Django 4 presets default values for permission keys appearing in
 * `AUTHORITATIVE_ACTION_PERMISSION_MAPPING`.
 *
 * Currently locks `force_stop_app` only. Extend when a new mapping entry
 * introduces a new permission key.
 */
export type DjangoPresetName =
  | 'cautious'
  | 'collaborative'
  | 'full_auto'
  | 'server_auto';

export const AUTHORITATIVE_DJANGO_PRESET_VALUES: Readonly<
  Record<string, Readonly<Record<DjangoPresetName, string>>>
> = {
  force_stop_app: {
    cautious: 'block',
    collaborative: 'confirm',
    full_auto: 'confirm',
    server_auto: 'confirm',
  },
};

/**
 * Enforcement site file paths (repo-relative). The contract test reads
 * these files and grep-asserts each `AUTHORITATIVE_ACTION_PERMISSION_MAPPING`
 * entry plus each `AUTHORITATIVE_DJANGO_PRESET_VALUES` block.
 *
 * When a site moves, update this constant — the contract test will then
 * verify the new path.
 */
export const ENFORCEMENT_SITES = {
  django: 'apps/tabtin_django/apps/services/common/sandbox_policy.py',
  ios: 'apps/tabtin-ios/tabtin-ios-odd/TabTin/Sources/Services/WebSocket/WebSocketService.swift',
  android:
    'apps/tabtin-android/app/src/main/java/com/tabtin/mobile/data/automation/SecurityPolicyChecker.kt',
} as const;

export type EnforcementSite = keyof typeof ENFORCEMENT_SITES;
