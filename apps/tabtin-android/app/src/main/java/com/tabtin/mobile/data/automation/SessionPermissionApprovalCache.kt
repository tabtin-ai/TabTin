package com.tabtin.mobile.data.automation

import java.util.concurrent.ConcurrentHashMap

/**
 * In-memory session-scoped approval decisions for device actions, keyed by
 * [SecurityPolicyChecker] permission key (e.g. `screen_tap` shared by tap/swipe).
 *
 * Cleared when the WebSocket / dispatcher session ends ([clear]). Process death
 * also drops the map — never persisted.
 */
public class SessionPermissionApprovalCache {
    private val decisions = ConcurrentHashMap<String, Boolean>()

    /** `true` = allow without prompt; `false` = deny without prompt; `null` = ask. */
    public fun get(permissionKey: String): Boolean? = decisions[permissionKey]

    public fun put(permissionKey: String, allowed: Boolean) {
        decisions[permissionKey] = allowed
    }

    public fun clear() {
        decisions.clear()
    }

    public fun size(): Int = decisions.size
}
