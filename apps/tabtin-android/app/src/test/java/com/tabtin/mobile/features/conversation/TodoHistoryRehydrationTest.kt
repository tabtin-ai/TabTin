package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.AgentTodoItem
import com.tabtin.mobile.data.model.BlockItem
import com.tabtin.mobile.data.model.ChatMessage
import com.tabtin.mobile.data.model.TodoStatus
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TodoHistoryRehydrationTest {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    @Test
    fun `open and later kwargs update restore an ordered active list`() {
        val messages = listOf(
            assistantMessage(
                "open",
                BlockItem(
                    type = "tool_use",
                    id = "todo-open",
                    name = "todo",
                    input = jsonElement(
                        """{
                          "action":"open",
                          "items":[
                            {"id":"one","content":"第一步","status":"in_progress"},
                            {"id":"two","content":"第二步","status":"pending"},
                            {"id":"three","content":"第三步","status":"pending"}
                          ]
                        }""",
                    ),
                ),
            ),
            assistantMessage(
                "update",
                BlockItem(
                    type = "tool_use",
                    id = "todo-update",
                    name = "todo",
                    inputJson = """{"kwargs":{"action":"update","id":"one","status":"completed"}}""",
                ),
            ),
        )

        val todos = TodoHistoryRehydration.deriveLatestTodos(messages)

        assertEquals(listOf("one", "two", "three"), todos.map { it.id })
        assertEquals(listOf("第一步", "第二步", "第三步"), todos.map { it.content })
        assertEquals(
            listOf(TodoStatus.COMPLETED, TodoStatus.PENDING, TodoStatus.PENDING),
            todos.map { it.status },
        )
    }

    @Test
    fun `failed todo call and subagent transcript never affect the parent list`() {
        val failedOpen = assistantMessage(
            "failed-open",
            BlockItem(
                type = "tool_use",
                id = "todo-failed",
                name = "todo",
                input = jsonElement(
                    """{"action":"open","items":[{"id":"ghost","content":"幽灵项","status":"pending"}]}""",
                ),
            ),
            BlockItem(
                type = "tool_result",
                toolUseId = "todo-failed",
                isError = true,
                content = "open failed",
            ),
        )
        val childOpen = assistantMessage(
            "child-open",
            BlockItem(
                type = "tool_use",
                id = "todo-child",
                name = "todo",
                input = jsonElement(
                    """{"action":"open","items":[{"id":"child","content":"子任务内部","status":"pending"}]}""",
                ),
            ),
        ).copy(subagentRunId = "child-run")

        assertTrue(
            TodoHistoryRehydration.deriveLatestTodos(listOf(failedOpen, childOpen)).isEmpty(),
        )
    }

    @Test
    fun `paused status survives history replay and unfinished list survives next send`() {
        val paused = assistantMessage(
            "paused",
            BlockItem(
                type = "tool_use",
                id = "todo-open",
                name = "todo",
                input = jsonElement(
                    """{"action":"open","items":[{"id":"one","content":"等待授权","status":"pending"}]}""",
                ),
            ),
            BlockItem(
                type = "tool_use",
                id = "todo-pause",
                name = "todo",
                input = jsonElement(
                    """{"action":"update","id":"one","status":"paused"}""",
                ),
            ),
        )

        val restored = TodoHistoryRehydration.deriveLatestTodos(listOf(paused))

        assertEquals(TodoStatus.PAUSED, restored.single().status)
        assertEquals(restored, TodoHistoryRehydration.retainForNextTurn(restored))
        assertTrue(
            TodoHistoryRehydration.retainForNextTurn(
                listOf(AgentTodoItem("done", "完成", TodoStatus.COMPLETED)),
            ).isEmpty(),
        )
    }

    @Test
    fun `empty terminal snapshot clears the previous list`() {
        val messages = listOf(
            assistantMessage(
                "open",
                BlockItem(
                    type = "tool_use",
                    id = "todo-open",
                    name = "todo",
                    input = jsonElement(
                        """{"action":"open","items":[{"id":"one","content":"临时项","status":"pending"}]}""",
                    ),
                ),
            ),
            assistantMessage(
                "remove",
                BlockItem(
                    type = "tool_use",
                    id = "todo-remove",
                    name = "todo",
                    input = jsonElement("""{"action":"remove","id":"one"}"""),
                ),
            ),
        )

        assertTrue(TodoHistoryRehydration.deriveLatestTodos(messages).isEmpty())
    }

    @Test
    fun `invalid second open does not replace the active list`() {
        val messages = listOf(
            assistantMessage(
                "first-open",
                BlockItem(
                    type = "tool_use",
                    id = "todo-open-one",
                    name = "todo",
                    input = jsonElement(
                        """{"action":"open","items":[{"id":"one","content":"保留项","status":"pending"}]}""",
                    ),
                ),
            ),
            assistantMessage(
                "second-open",
                BlockItem(
                    type = "tool_use",
                    id = "todo-open-two",
                    name = "todo",
                    input = jsonElement(
                        """{"action":"open","items":[{"id":"two","content":"非法替换","status":"pending"}]}""",
                    ),
                ),
            ),
        )

        val todos = TodoHistoryRehydration.deriveLatestTodos(messages)

        assertEquals(listOf("one"), todos.map { it.id })
    }

    private fun assistantMessage(id: String, vararg blocks: BlockItem): ChatMessage =
        ChatMessage(id = id, role = "assistant", blocksJson = blocks.toList())

    private fun jsonElement(raw: String): JsonElement = json.parseToJsonElement(raw)
}
