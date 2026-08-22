package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.AgentStep
import com.tabtin.mobile.data.model.StepStatus
import com.tabtin.mobile.data.model.StepType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 执行组的**呈现口径**测试：时间线只展示执行组一行，详情走抽屉。
 * 断言的是「谁算一步 / 组行怎么说 / 抽屉里先展开谁」，与 iOS
 * `ExecutionGroupPresentationTests` 逐条对齐。
 */
class ExecutionGroupPresentationTest {

    private fun thinking(text: String = "先看结构") = AssistantTimelineItem.Thinking(text)

    private fun tool(
        id: String,
        name: String = "bash",
        status: StepStatus = StepStatus.COMPLETED,
        input: String? = null,
    ) = AssistantTimelineItem.Tool(
        AgentStep(
            id = id,
            type = StepType.TOOL_CALL,
            name = name,
            status = status,
            input = input,
        ),
    )

    // region 谁算一步

    @Test
    fun `execution step covers thinking and ordinary tools but not subagent dispatch`() {
        assertTrue(ExecutionStepPresentation.isExecutionStep(thinking()))
        assertTrue(ExecutionStepPresentation.isExecutionStep(tool("t1")))
        assertFalse(ExecutionStepPresentation.isExecutionStep(tool("t2", name = "task")))
        assertFalse(
            ExecutionStepPresentation.isExecutionStep(AssistantTimelineItem.Text("结论")),
        )
    }

    /** 移动端两步就该收组——竖屏放不下连续步骤。 */
    @Test
    fun `two consecutive steps collapse into a group`() {
        val units = groupExecutionSteps(listOf(tool("t1"), tool("t2")))

        assertEquals(1, units.size)
        val group = units[0] as ExecutionTimelineUnit.Group
        assertEquals(2, group.items.size)
    }

    /** 单步不成组：「读取 Package.swift」比「执行详情 · 1 步」信息量更高。 */
    @Test
    fun `single step stays a plain row`() {
        val units = groupExecutionSteps(listOf(tool("t1")))

        assertEquals(1, units.size)
        assertTrue(units[0] is ExecutionTimelineUnit.Single)
    }

    /** 分组绝不改变非执行项的相对位置。 */
    @Test
    fun `grouping preserves position of non execution items`() {
        val units = groupExecutionSteps(
            listOf(
                thinking(),
                tool("t1"),
                AssistantTimelineItem.Text("小结"),
                tool("t2", name = "task"),
            ),
        )

        assertEquals(3, units.size)
        assertEquals(2, (units[0] as ExecutionTimelineUnit.Group).items.size)
        assertTrue((units[1] as ExecutionTimelineUnit.Single).item is AssistantTimelineItem.Text)
        assertTrue((units[2] as ExecutionTimelineUnit.Single).item is AssistantTimelineItem.Tool)
    }

    /** 文生图是交付物，不算可折叠执行步骤。 */
    @Test
    fun mediaImageGeneration_isNotExecutionStep() {
        val step = AgentStep(
            id = "img1",
            type = StepType.TOOL_CALL,
            name = "run_terminal_command",
            status = StepStatus.COMPLETED,
            output = """{"result_urls":["https://example.com/a.png"]}""",
            presentationKind = "media_image_generation",
            presentationPrompt = "红苹果",
        )
        assertFalse(
            ExecutionStepPresentation.isExecutionStep(AssistantTimelineItem.Tool(step)),
        )
    }

    /** 生图打断前后工具组：自身保持 Single，不进 ExecutionGroup。 */
    @Test
    fun mediaImage_breaksExecutionGroup() {
        val units = groupExecutionSteps(
            listOf(
                thinking(),
                tool("t1"),
                AssistantTimelineItem.Tool(
                    AgentStep(
                        id = "img1",
                        type = StepType.TOOL_CALL,
                        name = "run_terminal_command",
                        status = StepStatus.COMPLETED,
                        presentationKind = "media_image_generation",
                    ),
                ),
                tool("t2"),
            ),
        )
        assertTrue(
            units.any {
                it is ExecutionTimelineUnit.Single &&
                    (it.item as? AssistantTimelineItem.Tool)?.step?.isMediaImageGeneration == true
            },
        )
    }

    // endregion

    // region 组行摘要

    @Test
    fun `summary counts steps and surfaces failures`() {
        val summary = ExecutionGroupSummary.of(
            items = listOf(
                thinking(),
                tool("t1"),
                tool("t2", status = StepStatus.FAILED),
            ),
            isStreaming = false,
            isLastGroupInTimeline = true,
        )

        assertEquals(3, summary.stepCount)
        assertEquals(1, summary.failedCount)
        assertEquals(0, summary.runningCount)
    }

    /** 成功态不留「已完成」噪声，也不外露尾步。 */
    @Test
    fun `summary stays quiet when everything succeeded`() {
        val summary = ExecutionGroupSummary.of(
            items = listOf(tool("t1"), tool("t2")),
            isStreaming = false,
            isLastGroupInTimeline = true,
        )

        assertEquals(0, summary.failedCount)
        assertNull(summary.activeTailId)
        assertFalse(summary.isRunning)
    }

    /** 尾步在跑就必须留在时间线上实时可见，否则运行中界面看起来像卡死。 */
    @Test
    fun `running tail step is exposed`() {
        val summary = ExecutionGroupSummary.of(
            items = listOf(tool("t1"), tool("t2", status = StepStatus.RUNNING)),
            isStreaming = true,
            isLastGroupInTimeline = true,
        )

        assertTrue(summary.isRunning)
        assertEquals("tool-t2", summary.activeTailId)
    }

    /** 只认末尾那一步：中间步骤结果滞后不该把整组打散。 */
    @Test
    fun `only trailing step counts as active tail`() {
        val summary = ExecutionGroupSummary.of(
            items = listOf(tool("t1", status = StepStatus.RUNNING), tool("t2")),
            isStreaming = true,
            isLastGroupInTimeline = true,
        )

        assertTrue(summary.isRunning)
        assertNull(summary.activeTailId)
    }

    /** 思考没有 wire 终止标记：只有本轮仍在流式、且它是最后一步时才算运行中。 */
    @Test
    fun `thinking counts as running only while streaming at the tail`() {
        val streamingTail = ExecutionGroupSummary.of(
            items = listOf(tool("t1"), thinking()),
            isStreaming = true,
            isLastGroupInTimeline = true,
        )
        assertEquals("think-1", streamingTail.activeTailId)

        val historical = ExecutionGroupSummary.of(
            items = listOf(tool("t1"), thinking()),
            isStreaming = false,
            isLastGroupInTimeline = true,
        )
        assertNull(historical.activeTailId)

        // 本组不是时间线末尾（后面还有正文）——思考早已结束，不该标成运行中。
        val notLastGroup = ExecutionGroupSummary.of(
            items = listOf(tool("t1"), thinking()),
            isStreaming = true,
            isLastGroupInTimeline = false,
        )
        assertNull(notLastGroup.activeTailId)
    }

    // endregion

    // region 抽屉展开策略

    /** 单步抽屉（从时间线单行点进来）直接铺开，不再让用户多点一次。 */
    @Test
    fun `sole step always expands in the sheet`() {
        assertTrue(
            ExecutionStepDetailExpansion.initialExpanded(tool("t1"), isSoleStep = true),
        )
    }

    /** 多步时只展开需要看的：运行中 / 失败；其余折叠，避免整段倾泻。 */
    @Test
    fun `multi step sheet expands only noteworthy steps`() {
        assertFalse(
            ExecutionStepDetailExpansion.initialExpanded(tool("t1"), isSoleStep = false),
        )
        assertTrue(
            ExecutionStepDetailExpansion.initialExpanded(
                tool("t2", status = StepStatus.FAILED),
                isSoleStep = false,
            ),
        )
        assertTrue(
            ExecutionStepDetailExpansion.initialExpanded(
                tool("t3", status = StepStatus.RUNNING),
                isSoleStep = false,
            ),
        )
    }

    /** 打开抽屉先落到失败那一步——用户点进来通常就是为了找问题。 */
    @Test
    fun `sheet focus prefers failure then running`() {
        val items = listOf(
            tool("t1"),
            tool("t2", status = StepStatus.FAILED),
            tool("t3", status = StepStatus.RUNNING),
        )
        assertEquals(1, ExecutionStepDetailExpansion.focusTargetIndex(items))

        assertEquals(
            1,
            ExecutionStepDetailExpansion.focusTargetIndex(
                listOf(tool("t1"), tool("t3", status = StepStatus.RUNNING)),
            ),
        )
        assertNull(ExecutionStepDetailExpansion.focusTargetIndex(listOf(tool("t1"))))
    }

    // endregion

    // region 步骤文案

    /** 一句「AI 正在做什么」：优先模型给的 description，命令与路径只在抽屉里出现。 */
    @Test
    fun `tool label prefers model provided description`() {
        assertEquals(
            "生成 Word 文档",
            ExecutionStepPresentation.toolDescription("""{"description":"生成 Word 文档"}"""),
        )
        assertEquals(
            "跑一次基线构建",
            ExecutionStepPresentation.toolDescription(
                """{"kwargs":{"summary":"跑一次基线构建"}}""",
            ),
        )
        assertNull(ExecutionStepPresentation.toolDescription("""{"command":"swift build"}"""))
        assertNull(ExecutionStepPresentation.toolDescription("not json"))
        assertNull(ExecutionStepPresentation.toolDescription(null))
    }

    @Test
    fun `step id is stable per tool call and per thinking position`() {
        assertEquals("tool-t1", ExecutionStepPresentation.stepId(tool("t1"), 0))
        assertEquals("think-2", ExecutionStepPresentation.stepId(thinking(), 2))
    }

    // endregion

    // region 跨消息收组

    private fun stepOnlyMessage(
        id: String,
        toolId: String,
        checkpoint: Boolean = true,
    ) = com.tabtin.mobile.data.model.ChatMessage(
        id = id,
        role = "assistant",
        blocksJson = listOf(
            com.tabtin.mobile.data.model.BlockItem(
                type = "tool_use",
                id = toolId,
                name = "web_search",
            ),
        ),
        checkpointRecord = if (checkpoint) {
            com.tabtin.mobile.data.model.CheckpointRecord(checkpointId = "cp-$id")
        } else {
            null
        },
    )

    @Test
    fun `consecutive step-only assistant messages collapse even with checkpoint`() {
        val units = groupConversationRenderUnits(
            listOf(stepOnlyMessage("a", "t1"), stepOnlyMessage("b", "t2")),
        )
        assertEquals(1, units.size)
        val group = units[0] as ConversationRenderUnit.StepGroup
        assertEquals(listOf("a", "b"), group.messages.map { it.id })
    }

    @Test
    fun `error message breaks a cross message execution group`() {
        val error = com.tabtin.mobile.data.model.ChatMessage(
            id = "err",
            role = "assistant",
            content = "At most one task can be in_progress",
            errorCategory = "tool",
            errorMessage = "At most one task can be in_progress",
        )
        val units = groupConversationRenderUnits(
            listOf(error, stepOnlyMessage("a", "t1"), stepOnlyMessage("b", "t2")),
        )
        assertEquals(2, units.size)
        assertTrue(units[0] is ConversationRenderUnit.Single)
        assertEquals(2, (units[1] as ConversationRenderUnit.StepGroup).messages.size)
    }

    // endregion
}
