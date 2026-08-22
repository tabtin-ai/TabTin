package com.tabtin.mobile.sentry

import io.sentry.Breadcrumb
import io.sentry.SentryEvent
import io.sentry.SentryLevel
import io.sentry.protocol.Message
import io.sentry.protocol.SentryException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Date

/**
 * 脱敏规则单测。场景与 iOS `TabtinTests/SentryScrubTests.swift`、
 * TS `packages/tabtin-shared/src/__tests__/sentry-scrub.test.ts` 一一对应，
 * 三端规则改动需同步跑三份单测。
 */
class SentryScrubTest {

    // ── redact(_:) 纯文本规则 ─────────────────────────────

    @Test
    fun redactMasksPhoneNumber() {
        assertEquals("联系电话 138****5678 请回电", SentryScrub.redact("联系电话 13812345678 请回电"))
    }

    @Test
    fun redactMasksEmail() {
        assertEquals("邮箱 z***@example.com", SentryScrub.redact("邮箱 zhangsan@example.com"))
    }

    @Test
    fun redactMasksBearerToken() {
        val out = SentryScrub.redact("Authorization: Bearer abcdef123456==")
        assertFalse(out.contains("abcdef123456"))
        assertTrue(out.contains("<redacted>"))
    }

    @Test
    fun redactMasksKeyValueSecrets() {
        val input = """{"password": "sup3rSecret!", "token":"tok_abcdefgh"}"""
        val out = SentryScrub.redact(input)
        assertFalse(out.contains("sup3rSecret"))
        assertFalse(out.contains("tok_abcdefgh"))
    }

    @Test
    fun redactMasksJwt() {
        val jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
        assertFalse(SentryScrub.redact("token=$jwt").contains(jwt))
    }

    @Test
    fun redactMasksHomeDirectoryUsername() {
        assertEquals("/Users/<user>/Documents/a.txt", SentryScrub.redact("/Users/zhangsan/Documents/a.txt"))
    }

    @Test
    fun redactLeavesEmptyStringUnchanged() {
        assertEquals("", SentryScrub.redact(""))
    }

    @Test
    fun redactLeavesNonSensitiveTextUnchanged() {
        val input = "normal error message, nothing sensitive here"
        assertEquals(input, SentryScrub.redact(input))
    }

    // ── scrub(_ event:) beforeSend 钩子 ────────────────────

    @Test
    fun scrubDropsServerName() {
        val event = SentryEvent().apply { serverName = "zhangsandeMi14.local" }
        SentryScrub.scrub(event)
        assertNull(event.serverName)
    }

    @Test
    fun scrubRedactsMessage() {
        val event = SentryEvent().apply { message = Message().apply { formatted = "手机号 13812345678 报错" } }
        SentryScrub.scrub(event)
        assertEquals("手机号 138****5678 报错", event.message?.formatted)
    }

    @Test
    fun scrubRedactsExceptionValue() {
        val exception = SentryException().apply {
            value = "token=tok_abcdefgh1234 failed"
            type = "NetworkError"
        }
        val event = SentryEvent().apply { exceptions = listOf(exception) }
        SentryScrub.scrub(event)
        assertFalse(event.exceptions?.first()?.value?.contains("tok_abcdefgh1234") ?: true)
    }

    @Test
    fun scrubRedactsBreadcrumbMessageAndData() {
        val crumb = Breadcrumb(Date()).apply {
            level = SentryLevel.INFO
            category = "http"
            message = "邮箱 zhangsan@example.com 登录失败"
            setData("url", "https://api.example.com?token=tok_abcdefgh1234")
            setData("count", 3)
        }
        val event = SentryEvent().apply { breadcrumbs = listOf(crumb) }
        SentryScrub.scrub(event)

        val scrubbedCrumb = event.breadcrumbs?.first()
        assertEquals("邮箱 z***@example.com 登录失败", scrubbedCrumb?.message)
        assertFalse((scrubbedCrumb?.getData("url") as? String ?: "").contains("tok_abcdefgh1234"))
        assertEquals(3, scrubbedCrumb?.getData("count"))
    }

    @Test
    fun scrubLeavesEventWithoutSensitiveFieldsUnchanged() {
        val event = SentryEvent().apply { message = Message().apply { formatted = "boom" } }
        SentryScrub.scrub(event)
        assertEquals("boom", event.message?.formatted)
    }
}
