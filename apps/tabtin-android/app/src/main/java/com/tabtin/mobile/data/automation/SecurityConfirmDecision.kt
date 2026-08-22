package com.tabtin.mobile.data.automation

/**
 * User response from a device-action security confirm dialog.
 *
 * - [ALLOW_ONCE]: run this action only; ask again next time
 * - [ALLOW_SESSION]: run and remember allow for this permission key until session ends
 * - [DENY]: reject and remember deny for this permission key until session ends
 * - [UNAVAILABLE]: dialog could not be shown (no Activity); do not cache
 */
public enum class SecurityConfirmDecision {
    ALLOW_ONCE,
    ALLOW_SESSION,
    DENY,
    UNAVAILABLE,
}
