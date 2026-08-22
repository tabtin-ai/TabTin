package com.tabtin.mobile.data.model

import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PushNotificationVisibilityTest {
    private val shellXML = """
        A background command completed while you were doing other work:

        <task-notification>
        <command>sleep 7</command>
        <description>等待一会儿</description>
        <exit-code>0</exit-code>
        <exited-by>normal_exit</exited-by>
        <duration-ms>1000</duration-ms>
        </task-notification>
    """.trimIndent()

    private val subagentXML = """
        A background sub-agent finished while you were doing other work:

        <task-notification kind="subagent-completed">
        <label>抓取竞品价格</label>
        <status>completed</status>
        <summary>已完成</summary>
        </task-notification>
    """.trimIndent()

    @Test
    fun `triggered_by marks push notification`() {
        assertTrue(
            PushNotificationVisibility.isPushNotification("push-notification", "hello"),
        )
        assertFalse(
            PushNotificationVisibility.isPushNotification("user", "hello"),
        )
    }

    @Test
    fun `content fallback without triggered_by`() {
        assertTrue(PushNotificationVisibility.isPushNotification(null, shellXML))
    }

    @Test
    fun `shell summary stays on timeline`() {
        assertFalse(
            PushNotificationVisibility.shouldHideFromTimeline("push-notification", shellXML),
        )
        assertEquals(
            "后台命令完成：等待一会儿",
            PushNotificationVisibility.displaySummary("push-notification", shellXML),
        )
    }

    @Test
    fun `subagent-only hidden from timeline`() {
        assertTrue(
            PushNotificationVisibility.shouldHideFromTimeline("push-notification", subagentXML),
        )
    }

    @Test
    fun `ChatMessage flags from metadata`() {
        val push = ChatMessage(
            id = "p1",
            role = "system",
            content = shellXML,
            metadata = mapOf("triggered_by" to JsonPrimitive("push-notification")),
        )
        assertTrue(push.isPushNotification)
        assertFalse(push.shouldHidePushNotification)
        assertEquals("后台命令完成：等待一会儿", push.pushNotificationSummary)

        val subagent = ChatMessage(
            id = "p2",
            role = "system",
            content = subagentXML,
            metadata = mapOf("triggered_by" to JsonPrimitive("push-notification")),
        )
        assertTrue(subagent.isPushNotification)
        assertTrue(subagent.shouldHidePushNotification)
    }
}
