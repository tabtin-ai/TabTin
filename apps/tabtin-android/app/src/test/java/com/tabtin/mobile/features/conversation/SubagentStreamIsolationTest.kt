package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.WSEnvelope
import com.tabtin.mobile.data.websocket.AgentStreamEvent
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ：父 topic 上带 `subagent_run_id` 的 raw `agent.stream.*` 不得灌进主气泡。
 * 对齐 iOS `SubagentStreamIsolationTests` 纯函数门闩用例。
 */
class SubagentStreamIsolationTest {

    private fun env(short: String, payload: JsonObject): WSEnvelope =
        WSEnvelope.build(
            type = AgentStreamEvent.fullType(short),
            deviceId = "android-test",
            payload = payload,
            threadId = "chat-session-session-9120",
        )

    @Test
    fun routingIsolatesTaggedContentBlockButNotSubagentMeta() {
        val tagged = env(
            AgentStreamEvent.CONTENT_BLOCK_START,
            buildJsonObject {
                put("subagent_run_id", "child-1")
                put("index", 0)
                put(
                    "block",
                    buildJsonObject {
                        put("type", "thinking")
                        put("thinking", "子思考")
                        put("signature", "")
                    },
                )
            },
        )
        assertTrue(SubagentStreamRouting.shouldIsolateFromParentTimeline(tagged))
        assertEquals("child-1", SubagentStreamRouting.subagentRunId(tagged))

        val viaAlias = env(
            AgentStreamEvent.CONTENT_BLOCK_DELTA,
            buildJsonObject {
                put("subagent_id", "child-1")
                put("index", 0)
                put(
                    "delta",
                    buildJsonObject {
                        put("type", "thinking_delta")
                        put("thinking", "…")
                    },
                )
            },
        )
        assertTrue(SubagentStreamRouting.shouldIsolateFromParentTimeline(viaAlias))
        assertEquals("child-1", SubagentStreamRouting.subagentRunId(viaAlias))

        val parentThinking = env(
            AgentStreamEvent.CONTENT_BLOCK_START,
            buildJsonObject {
                put("index", 0)
                put(
                    "block",
                    buildJsonObject {
                        put("type", "thinking")
                        put("thinking", "父思考")
                        put("signature", "")
                    },
                )
            },
        )
        assertFalse(SubagentStreamRouting.shouldIsolateFromParentTimeline(parentThinking))

        for (short in listOf(
            AgentStreamEvent.SUBAGENT_STARTED,
            AgentStreamEvent.SUBAGENT_QUEUED,
            AgentStreamEvent.SUBAGENT_PROGRESS,
            AgentStreamEvent.SUBAGENT_COMPLETED,
            AgentStreamEvent.SUBAGENT_FAILED,
            AgentStreamEvent.SUBAGENT_STREAM_EVENT,
        )) {
            val meta = env(short, buildJsonObject { put("subagent_run_id", "child-1") })
            assertFalse(
                "meta $short must keep existing decode path",
                SubagentStreamRouting.shouldIsolateFromParentTimeline(meta),
            )
        }

        val persist = env(
            "persist_message",
            buildJsonObject {
                put("subagent_run_id", "child-1")
                put("message_id", "m-x")
            },
        )
        assertFalse(SubagentStreamRouting.shouldIsolateFromParentTimeline(persist))

        val messagePersisted = env(
            AgentStreamEvent.MESSAGE_PERSISTED,
            buildJsonObject {
                put("subagent_run_id", "child-1")
                put("message_id", "m-x")
            },
        )
        assertFalse(SubagentStreamRouting.shouldIsolateFromParentTimeline(messagePersisted))

        val messageCommitted = env(
            AgentStreamEvent.MESSAGE_COMMITTED,
            buildJsonObject {
                put("subagent_run_id", "child-1")
                put("message_id", "m-x")
            },
        )
        assertFalse(SubagentStreamRouting.shouldIsolateFromParentTimeline(messageCommitted))
    }

    @Test
    fun blankOrWhitespaceRunIdDoesNotIsolate() {
        val blank = env(
            AgentStreamEvent.CONTENT_BLOCK_START,
            buildJsonObject {
                put("subagent_run_id", "   ")
                put("index", 0)
            },
        )
        assertFalse(SubagentStreamRouting.shouldIsolateFromParentTimeline(blank))
        assertNull(SubagentStreamRouting.subagentRunId(blank))
    }

    @Test
    fun nonAgentStreamTypeDoesNotIsolateEvenWithRunId() {
        val other = WSEnvelope.build(
            type = "billing.notice",
            deviceId = "android-test",
            payload = buildJsonObject { put("subagent_run_id", "child-1") },
        )
        assertFalse(SubagentStreamRouting.shouldIsolateFromParentTimeline(other))
    }
}
