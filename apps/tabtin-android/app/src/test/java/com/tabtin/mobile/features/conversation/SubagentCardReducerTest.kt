package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.BlockItem
import com.tabtin.mobile.data.model.StepStatus
import com.tabtin.mobile.data.model.StepType
import com.tabtin.mobile.data.model.SubagentRunSnapshot
import com.tabtin.mobile.data.model.SubagentToolStep
import com.tabtin.mobile.data.model.SubagentTranscriptItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `SubagentCardReducer` 纯函数核心回归守卫——锁住子 Agent 卡「双数据源乐观渲染」的合并规则。
 *
 * 2026-05-29：本轮 Android 把桌面端「源 A（content_block tool_use(agent)）乐观建卡 → 源 B
 * （subagent_started 带 parent_tool_call_id）原地顶替不重复 → progress/completed 按 runId 命中」
 * 范式落地。`upsertSubagentRun` 的多锚点查找（runId → parentToolCallId → stepId）是「顶替不
 * 重复 + 不 remount」的根，提纯成 `SubagentCardReducer` 后用本测复现真实事件序列锁回归。
 *
 * 用例与 iOS `ChatMessageServiceTests` 对齐（7 核心 + 1 failed 回归）。
 */
class SubagentCardReducerTest {

    @Test
    fun `task becomes the card title when label is missing`() {
        val step = SubagentCardReducer.applyStarted(
            emptyList(), "run-1234", null, null, "调研 Android 待办展示", null,
        ).single()

        assertEquals("调研 Android 待办展示", step.name)
        assertEquals("调研 Android 待办展示", step.subagent?.task)
        assertEquals(
            "调研 Android 待办展示",
            SubagentDetailSectioning.sections(requireNotNull(step.subagent)).instruction,
        )
    }

    @Test
    fun `internal identifiers never become a user visible card title`() {
        val step = SubagentCardReducer.applyStarted(
            emptyList(),
            "6f4dc2aa-889f-4503-9197-5a0e12345678",
            null,
            "6f4dc2aa-889f-4503-9197-5a0e12345678",
            "model_kimi-k2-code",
            null,
        ).single()

        assertEquals("", step.name)
        assertNull(step.subagent?.label)
        assertNull(step.subagent?.task)
    }

    @Test
    fun `card title skips an internal first line and keeps the readable task`() {
        val step = SubagentCardReducer.applyStarted(
            emptyList(),
            "run-1234",
            null,
            "6f4dc2aa-889f-4503-9197-5a0e12345678\n调研 Android 待办展示",
            null,
            null,
        ).single()

        assertEquals("调研 Android 待办展示", step.name)
    }

    // ── 用例 1：源 A content_block_start → 乐观建卡 ─────────────────────────
    @Test
    fun `content_block_start creates optimistic card anchored by toolCallId`() {
        val steps = SubagentCardReducer.applyOptimisticStarted(
            steps = emptyList(),
            toolCallId = "toolu_1",
            task = "调研子任务",
        )
        assertEquals("源 A 建 1 张卡", 1, steps.size)
        assertEquals("stepId 锚定 toolCallId", "subagent-toolu_1", steps[0].id)
        assertEquals(StepType.SUBAGENT, steps[0].type)
        val snap = steps[0].subagent!!
        assertEquals("乐观卡置 PENDING（启动中）", SubagentRunSnapshot.Status.PENDING, snap.status)
        assertTrue("isOptimistic=true", snap.isOptimistic)
        assertEquals("parentToolCallId 锚点", "toolu_1", snap.parentToolCallId)
        assertEquals("runId 先用 toolCallId 占位", "toolu_1", snap.runId)
        assertEquals("调研子任务", snap.task)
        // PENDING/RUNNING 都映射到 StepStatus.RUNNING（转圈正常）
        assertEquals(StepStatus.RUNNING, steps[0].status)
    }

    // ── 用例 2：源 B subagent_started → 命中乐观卡、复用 stepId、原地升级、不新建 ──
    @Test
    fun `subagent_started upgrades optimistic card in place without creating a second`() {
        var steps = SubagentCardReducer.applyOptimisticStarted(emptyList(), "toolu_1", null)
        val optimisticStepId = steps[0].id

        steps = SubagentCardReducer.applyStarted(
            steps = steps,
            runId = "run_xyz",
            parentToolCallId = "toolu_1",
            label = null,
            task = "真实任务",
            startedAt = 1_700_000_000.0,
        )

        assertEquals("顶替不新建第二张卡", 1, steps.size)
        assertEquals("复用同一 stepId（不 remount）", optimisticStepId, steps[0].id)
        assertEquals("subagent-toolu_1", steps[0].id)
        val snap = steps[0].subagent!!
        assertEquals("写入真实 runId", "run_xyz", snap.runId)
        assertEquals(SubagentRunSnapshot.Status.RUNNING, snap.status)
        assertFalse("顶替后清乐观标记", snap.isOptimistic)
        assertEquals("toolu_1", snap.parentToolCallId)
        assertEquals("真实任务", snap.task)
        assertEquals(1_700_000_000.0, snap.startedAt!!, 0.0)
    }

    // ── 用例 3：progress / completed（只带 runId）→ 按 runId 命中同一张卡 ──────
    @Test
    fun `progress and completed match the same card by runId`() {
        var steps = SubagentCardReducer.applyOptimisticStarted(emptyList(), "toolu_1", null)
        steps = SubagentCardReducer.applyStarted(steps, "run_xyz", "toolu_1", null, null, null)

        // progress 只带 runId（无 parent_tool_call_id）
        steps = SubagentCardReducer.applyProgress(
            steps = steps,
            runId = "run_xyz",
            stepCount = 3,
            latestTool = "Read",
            latestSuccess = true,
            elapsedMs = 1_200,
            toolHistory = listOf(
                SubagentToolStep(toolName = "Read", success = true, elapsedMs = 800),
            ),
        )
        assertEquals("progress 不新建卡", 1, steps.size)
        assertEquals("仍是乐观卡的 stepId", "subagent-toolu_1", steps[0].id)
        assertEquals(3, steps[0].subagent!!.stepCount)
        assertEquals("Read", steps[0].subagent!!.latestTool)
        assertEquals(0, steps[0].subagent!!.toolHistory.size)

        // completed 只带 runId
        steps = SubagentCardReducer.applyCompleted(
            steps = steps,
            runId = "run_xyz",
            label = null,
            task = null,
            summary = "已完成",
            endedAt = 1_700_000_002.0,
            stats = null,
        )
        assertEquals("completed 不新建卡", 1, steps.size)
        assertEquals(SubagentRunSnapshot.Status.COMPLETED, steps[0].subagent!!.status)
        assertEquals("已完成", steps[0].subagent!!.summary)
    }

    // ── 用例 4：乱序防御——源 B 先升级真实 run，迟到/重复源 A 不把它降回 PENDING ──
    @Test
    fun `late or duplicate source A does not downgrade an already-real run`() {
        // 源 B 先到（带 parent_tool_call_id），建真实 RUNNING 卡
        var steps = SubagentCardReducer.applyStarted(
            emptyList(), runId = "run_xyz", parentToolCallId = "toolu_1",
            label = null, task = "真实任务", startedAt = null,
        )
        val stepId = steps[0].id
        assertEquals(SubagentRunSnapshot.Status.RUNNING, steps[0].subagent!!.status)
        assertFalse(steps[0].subagent!!.isOptimistic)

        // 迟到的 content_block（重复源 A）按 parentToolCallId 命中
        steps = SubagentCardReducer.applyOptimisticStarted(steps, "toolu_1", "迟到的task")

        assertEquals("不新建第二张", 1, steps.size)
        assertEquals(stepId, steps[0].id)
        assertEquals("不降回 PENDING", SubagentRunSnapshot.Status.RUNNING, steps[0].subagent!!.status)
        assertFalse("不重新标记为乐观", steps[0].subagent!!.isOptimistic)
        assertEquals("runId 保持真实值", "run_xyz", steps[0].subagent!!.runId)
    }

    // ── 用例 5：legacy——subagent_started 无 parent_tool_call_id 且无乐观卡 → 按 runId 新建 ──
    @Test
    fun `legacy subagent_started without parentToolCallId creates card by runId`() {
        var steps = SubagentCardReducer.applyStarted(
            emptyList(), runId = "run_legacy", parentToolCallId = null,
            label = null, task = "legacy 任务", startedAt = null,
        )
        assertEquals(1, steps.size)
        assertEquals("退回 runId 锚点（旧行为不回归）", "subagent-run_legacy", steps[0].id)
        assertEquals(SubagentRunSnapshot.Status.RUNNING, steps[0].subagent!!.status)
        assertFalse(steps[0].subagent!!.isOptimistic)
        assertEquals("run_legacy", steps[0].subagent!!.runId)

        // 后续 progress 仍按 runId 命中同卡
        steps = SubagentCardReducer.applyProgress(
            steps, "run_legacy", 1, "Glob", true, 100, emptyList(),
        )
        assertEquals(1, steps.size)
        assertEquals("subagent-run_legacy", steps[0].id)
        assertEquals(1, steps[0].subagent!!.stepCount)
    }

    // ── 用例 6：多子 Agent 不串台——两个 toolCallId 乐观卡 + 各自源 B → 两张独立卡 ──
    @Test
    fun `multiple subagents do not collide across anchors`() {
        var steps = SubagentCardReducer.applyOptimisticStarted(emptyList(), "toolu_A", "task A")
        steps = SubagentCardReducer.applyOptimisticStarted(steps, "toolu_B", "task B")
        assertEquals("两张乐观卡", 2, steps.size)

        // 各自源 B（parent_tool_call_id 区分）
        steps = SubagentCardReducer.applyStarted(steps, "run_A", "toolu_A", null, null, null)
        steps = SubagentCardReducer.applyStarted(steps, "run_B", "toolu_B", null, null, null)
        assertEquals("仍是两张独立卡", 2, steps.size)

        val a = steps.first { it.id == "subagent-toolu_A" }.subagent!!
        val b = steps.first { it.id == "subagent-toolu_B" }.subagent!!
        assertEquals("run_A", a.runId)
        assertEquals("run_B", b.runId)
        assertEquals("task A", a.task)
        assertEquals("task B", b.task)

        // run_A 的 progress 只命中 A，不串到 B
        steps = SubagentCardReducer.applyProgress(steps, "run_A", 5, "Read", true, 500, emptyList())
        val a2 = steps.first { it.id == "subagent-toolu_A" }.subagent!!
        val b2 = steps.first { it.id == "subagent-toolu_B" }.subagent!!
        assertEquals(5, a2.stepCount)
        assertNull("B 不被 A 的 progress 串台", b2.stepCount)
    }

    // ── 用例 7：content_block 未消费时 subagent_started 先到 → 直接建 RUNNING 卡（非乐观）──
    @Test
    fun `subagent_started first when content_block not consumed creates running card`() {
        val steps = SubagentCardReducer.applyStarted(
            emptyList(), runId = "run_z", parentToolCallId = "toolu_z",
            label = null, task = "直接 started", startedAt = null,
        )
        assertEquals(1, steps.size)
        assertEquals("用 parent_tool_call_id 锚点", "subagent-toolu_z", steps[0].id)
        assertEquals(SubagentRunSnapshot.Status.RUNNING, steps[0].subagent!!.status)
        assertFalse("started 建的卡不是乐观卡", steps[0].subagent!!.isOptimistic)
        assertEquals("run_z", steps[0].subagent!!.runId)
    }

    // ── 用例 8（回归）：failed 按 runId 命中并置 FAILED / CANCELLED ───────────
    @Test
    fun `failed and cancelled map to correct terminal status by runId`() {
        var steps = SubagentCardReducer.applyOptimisticStarted(emptyList(), "toolu_1", null)
        steps = SubagentCardReducer.applyStarted(steps, "run_xyz", "toolu_1", null, null, null)

        steps = SubagentCardReducer.applyFailed(
            steps = steps,
            runId = "run_xyz",
            label = "",
            task = null,
            error = "boom",
            cancelled = false,
            endedAt = 1_700_000_003.0,
            stats = null,
            nowEpochSeconds = 1_700_000_009.0,
        )
        assertEquals(1, steps.size)
        assertEquals(SubagentRunSnapshot.Status.FAILED, steps[0].subagent!!.status)
        assertEquals("boom", steps[0].subagent!!.error)
        assertEquals(StepStatus.FAILED, steps[0].status)

        // cancelled → CANCELLED（视觉中性，映射到 StepStatus.COMPLETED）
        val cancelledSteps = SubagentCardReducer.applyFailed(
            steps = SubagentCardReducer.applyStarted(emptyList(), "run_c", "toolu_c", null, null, null),
            runId = "run_c",
            label = "",
            task = null,
            error = "用户取消",
            cancelled = true,
            endedAt = null,
            stats = null,
            nowEpochSeconds = 1_700_000_009.0,
        )
        assertEquals(SubagentRunSnapshot.Status.CANCELLED, cancelledSteps[0].subagent!!.status)
        assertTrue(cancelledSteps[0].subagent!!.cancelled)
        assertEquals("CANCELLED 视觉中性映射到 COMPLETED", StepStatus.COMPLETED, cancelledSteps[0].status)
        assertEquals("endedAt 缺失时用 now 兜底", 1_700_000_009.0, cancelledSteps[0].subagent!!.endedAt!!, 0.0)
    }

    // ── 用例 9：queued 只在「尚未开跑」时生效，不降级已 RUNNING / 终态 ─────────
    @Test
    fun `queued sets QUEUED only when not yet running and never downgrades`() {
        // 乐观卡（PENDING）→ queued 到达（带 parentToolCallId）→ 命中同卡置 QUEUED，不新建
        var steps = SubagentCardReducer.applyOptimisticStarted(emptyList(), "toolu_q", null)
        steps = SubagentCardReducer.applyQueued(
            steps, runId = "run_q", parentToolCallId = "toolu_q", label = null, task = "排队任务",
        )
        assertEquals("queued 命中乐观卡、不新建第二张", 1, steps.size)
        assertEquals(SubagentRunSnapshot.Status.QUEUED, steps[0].subagent!!.status)
        assertEquals("写入真实 runId", "run_q", steps[0].subagent!!.runId)
        assertFalse("queued 后清乐观标记", steps[0].subagent!!.isOptimistic)
        // QUEUED 映射到 StepStatus.RUNNING（转圈/活跃）
        assertEquals(StepStatus.RUNNING, steps[0].status)

        // 已 RUNNING 后迟到的 queued 不得把它降级
        var running = SubagentCardReducer.applyStarted(emptyList(), "run_r", "toolu_r", null, null, null)
        running = SubagentCardReducer.applyQueued(running, runId = "run_r", parentToolCallId = "toolu_r", label = null, task = null)
        assertEquals("running 不被 queued 降级", SubagentRunSnapshot.Status.RUNNING, running[0].subagent!!.status)

        // 终态（COMPLETED）后迟到的 queued 也不得降级
        var done = SubagentCardReducer.applyStarted(emptyList(), "run_d", "toolu_d", null, null, null)
        done = SubagentCardReducer.applyCompleted(done, "run_d", null, null, "ok", null, null)
        done = SubagentCardReducer.applyQueued(done, runId = "run_d", parentToolCallId = "toolu_d", label = null, task = null)
        assertEquals("completed 不被 queued 降级", SubagentRunSnapshot.Status.COMPLETED, done[0].subagent!!.status)
    }

    // ── 用例 9b（回归）：源 A → queued → started 三连不产生重复卡 ───────────────
    @Test
    fun `optimistic then queued then started stays a single card`() {
        var steps = SubagentCardReducer.applyOptimisticStarted(emptyList(), "toolu_x", "任务")
        steps = SubagentCardReducer.applyQueued(steps, "run_x", "toolu_x", null, null)
        steps = SubagentCardReducer.applyStarted(steps, "run_x", "toolu_x", null, "任务", 1_700_000_000.0)
        assertEquals("三连事件后仍只有一张卡", 1, steps.size)
        assertEquals(SubagentRunSnapshot.Status.RUNNING, steps[0].subagent!!.status)
        assertEquals("run_x", steps[0].subagent!!.runId)
    }

    @Test
    fun `live transcript retains rich content resource identity`() {
        var steps = SubagentCardReducer.applyStarted(
            emptyList(), "run-rich", null, null, "创建资源", null,
        )
        val resource = BlockItem(
            type = "rich_content",
            kind = "resource_ref",
            resourceType = "document",
            resourceId = "doc-from-live-child",
        )

        steps = SubagentCardReducer.applyTranscript(
            steps = steps,
            runId = "run-rich",
            update = SubagentCardReducer.SubagentTranscriptUpdate(
                id = "child:0:rich",
                messageId = "child",
                index = 0,
                kind = SubagentTranscriptItem.Kind.RICH_CONTENT,
                richContent = resource,
                isFinal = true,
            ),
        )

        val retained = steps.single().subagent?.transcript?.single()?.richContent
        assertEquals("document", retained?.resourceType)
        assertEquals("doc-from-live-child", retained?.resourceId)
    }

    // ── 用例 10：check_agent_id 收尾 → 撤掉乐观卡，但不误删真实派发卡 ──────────
    @Test
    fun `removeOptimistic drops the optimistic card but never a real dispatch`() {
        // 乐观卡（check 调用）→ removeOptimistic → 撤掉
        val optimistic = SubagentCardReducer.applyOptimisticStarted(emptyList(), "toolu_check", null)
        val afterRemove = SubagentCardReducer.removeOptimistic(optimistic, "toolu_check")
        assertTrue("乐观 check 卡被撤掉", afterRemove.isEmpty())

        // 真实派发（已升级为 RUNNING）不因同名 toolCallId 被误删
        val real = SubagentCardReducer.applyStarted(emptyList(), "run_real", "toolu_real", null, "真实", null)
        val afterRemoveReal = SubagentCardReducer.removeOptimistic(real, "toolu_real")
        assertEquals("真实派发卡不被撤", 1, afterRemoveReal.size)
        assertEquals(SubagentRunSnapshot.Status.RUNNING, afterRemoveReal[0].subagent!!.status)
    }
}
