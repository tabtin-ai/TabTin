package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.ChatMessage
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AskUserResultPresentationTest {
    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `resolved ask choice maps option ids to visible labels`() {
        val message = json.decodeFromString<ChatMessage>(
            """
                {
                  "id": "hitl-choice-result",
                  "role": "assistant",
                  "message_kind": "hitl_interaction",
                  "metadata": {
                    "hitl": {
                      "kind": "ask_choice",
                      "request_key": "ask-1",
                      "status": "resolved",
                      "payload": {
                        "questions": [
                          {
                            "id": "q1",
                            "prompt": "你更喜欢哪种方案？",
                            "options": [
                              { "id": "simple", "label": "简单方案" },
                              { "id": "complete", "label": "完整方案" }
                            ]
                          }
                        ]
                      },
                      "result": {
                        "answers": [
                          { "question_id": "q1", "selected_options": ["complete"] }
                        ]
                      }
                    }
                  }
                }
            """.trimIndent(),
        )

        assertEquals(
            AskUserResultPresentation(
                questions = listOf(
                    AskUserResultQuestion(
                        prompt = "你更喜欢哪种方案？",
                        answers = listOf("完整方案"),
                    ),
                ),
            ),
            AskUserResultPresentation.from(message),
        )
    }

    @Test
    fun `pending and non ask facts stay out of the result timeline`() {
        val pending = ChatMessage(
            id = "pending",
            role = "assistant",
            messageKind = "hitl_interaction",
        )
        val regular = ChatMessage(id = "regular", role = "assistant", content = "回复")

        assertNull(AskUserResultPresentation.from(pending))
        assertNull(AskUserResultPresentation.from(regular))
    }

    @Test
    fun `skipped ask choice stays out of the result timeline`() {
        val message = json.decodeFromString<ChatMessage>(
            """
                {
                  "id": "hitl-skipped",
                  "role": "assistant",
                  "message_kind": "hitl_interaction",
                  "metadata": { "hitl": {
                    "kind": "ask_choice",
                    "status": "resolved",
                    "payload": { "questions": [{
                      "id": "q1",
                      "prompt": "选一个",
                      "options": [{ "id": "a", "label": "A" }]
                    }] },
                    "result": { "outcome": "skipped", "skipped": true }
                  } }
                }
            """.trimIndent(),
        )

        assertNull(AskUserResultPresentation.from(message))
    }

    @Test
    fun `accepts local response wrapper while runtime terminal fact converges`() {
        val message = json.decodeFromString<ChatMessage>(
            """
                {
                  "id": "hitl-local-result",
                  "role": "assistant",
                  "message_kind": "hitl_interaction",
                  "metadata": {
                    "hitl": {
                      "kind": "ask_choice",
                      "status": "resolved",
                      "payload": {
                        "questions": [{
                          "id": "q1",
                          "prompt": "选一个",
                          "options": [{ "id": "a", "label": "A" }]
                        }]
                      },
                      "result": {
                        "response": {
                          "answers": [{ "question_id": "q1", "selected_options": ["a"] }]
                        }
                      }
                    }
                  }
                }
            """.trimIndent(),
        )

        assertEquals(listOf("A"), AskUserResultPresentation.from(message)?.questions?.single()?.answers)
    }
}
