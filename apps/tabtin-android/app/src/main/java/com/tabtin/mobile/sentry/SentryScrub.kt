package com.tabtin.mobile.sentry

import io.sentry.Breadcrumb
import io.sentry.SentryEvent

/**
 * Sentry 事件脱敏。
 *
 * 规则口径与 `packages/tabtin-shared/src/diagnostics-redact.ts`（Electron/Daemon 共用）及
 * iOS 侧 `Tabtin/Core/Diagnostics/SentryScrub.swift` 严格对齐：token / 手机号 / 邮箱 / 家目录
 * 用户名不出境。契约见 `docs/agent/error-context-schema.md`。三份规则改一处需同步另外两处并跑
 * 各自单测（Android 无法直接依赖 TS/Swift 包，故各端各自维护一份移植）。
 */
public object SentryScrub {
    private val templateRules: List<Pair<Regex, String>> = listOf(
        Regex("(?i)(bearer\\s+)[A-Za-z0-9\\-._~+/]{8,}=*") to "$1<redacted>",
        Regex(
            "(?i)(\"?(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?token|" +
                "refresh[_-]?token|authorization|cookie|set-cookie)\"?\\s*[:=]\\s*\"?)([^\\s\"',}]{4,})",
        ) to "$1<redacted>",
        Regex("\\beyJ[A-Za-z0-9\\-_]+\\.[A-Za-z0-9\\-_]+\\.[A-Za-z0-9\\-_]+") to "<redacted-jwt>",
        Regex("(/Users/)[^/\\s]+") to "$1<user>",
        Regex("(/home/)[^/\\s]+") to "$1<user>",
    )

    private val emailRegex = Regex("([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\\.[A-Za-z]{2,})")
    private val phoneRegex = Regex("\\b1[3-9]\\d{9}\\b")

    /** 对一段文本做全量脱敏。空字符串原样返回。 */
    public fun redact(input: String): String {
        if (input.isEmpty()) return input
        var out = input
        for ((regex, template) in templateRules) {
            out = regex.replace(out, template)
        }
        out = emailRegex.replace(out) { match ->
            val local = match.groupValues[1]
            val domain = match.groupValues[2]
            "${local.take(1)}***@$domain"
        }
        out = phoneRegex.replace(out) { match ->
            val phone = match.value
            "${phone.take(3)}****${phone.takeLast(4)}"
        }
        return out
    }

    /**
     * beforeSend 钩子：对事件文本部位全量脱敏，原地修改并返回。
     * - `message.formatted` / `message.message` / `exceptions[].value` /
     *   `breadcrumbs[].message` / `breadcrumbs[].data`（字符串值）过 [redact]；
     * - `serverName`（设备名，常含真名）整体丢弃——与 TS/Swift 侧同口径；
     * - Android SDK 不默认采集 HTTP request body，无需额外处理。
     */
    public fun scrub(event: SentryEvent): SentryEvent {
        event.serverName = null

        event.message?.let { message ->
            message.formatted?.let { message.formatted = redact(it) }
            message.message?.let { message.message = redact(it) }
        }

        event.exceptions?.forEach { exception ->
            exception.value?.let { exception.value = redact(it) }
        }

        event.breadcrumbs?.forEach { crumb -> redactBreadcrumb(crumb) }

        return event
    }

    private fun redactBreadcrumb(crumb: Breadcrumb) {
        crumb.message?.let { crumb.message = redact(it) }
        val data = crumb.data
        for (key in data.keys.toList()) {
            val value = data[key]
            if (value is String) {
                crumb.setData(key, redact(value))
            }
        }
    }
}
