package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.AllChatSession
import com.tabtin.mobile.data.model.SessionRunState
import com.tabtin.mobile.data.model.SessionRunStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/** 任务行状态收敛与归属名解析，与 iOS `TaskRowStatusPresentation` / `TaskRowContentPolicy` 同口径。 */
class TaskRowStatusPresentationTest {

    @Test
    fun `server run state wins over local aggregates`() {
        // 服务端说在跑，本机聚合字段说没有活跃任务——以服务端为准。
        val session = session(runStatus = SessionRunStatus.RUNNING, hasActiveTask = false)
        assertEquals(
            TaskRowStatus.RUNNING,
            TaskRowStatusPresentation.resolve(session, hasPendingInteraction = false),
        )
    }

    @Test
    fun `queued and cancelling read as running`() {
        // 用户不关心 queued 和 running 的技术差异，只关心「它在跑」。
        for (status in listOf(SessionRunStatus.QUEUED, SessionRunStatus.CANCELLING)) {
            assertEquals(
                TaskRowStatus.RUNNING,
                TaskRowStatusPresentation.resolve(session(runStatus = status), false),
            )
        }
    }

    @Test
    fun `waiting user and paused both need attention but read differently`() {
        val waiting = TaskRowStatusPresentation.resolve(
            session(runStatus = SessionRunStatus.WAITING_USER), false,
        )
        val paused = TaskRowStatusPresentation.resolve(
            session(runStatus = SessionRunStatus.PAUSED), false,
        )
        assertEquals(TaskRowStatus.WAITING_USER, waiting)
        assertEquals(TaskRowStatus.PAUSED, paused)
        assertEquals(true, waiting.isAttention)
        assertEquals(true, paused.isAttention)
        assertNotNull(TaskRowStatusPresentation.statusTextRes(waiting))
        assertNotNull(TaskRowStatusPresentation.statusTextRes(paused))
    }

    @Test
    fun `completed splits on unread`() {
        assertEquals(
            TaskRowStatus.DONE_UNREAD,
            TaskRowStatusPresentation.resolve(
                session(runStatus = SessionRunStatus.COMPLETED, hasUnreadReply = true), false,
            ),
        )
        assertEquals(
            TaskRowStatus.DONE,
            TaskRowStatusPresentation.resolve(
                session(runStatus = SessionRunStatus.COMPLETED, hasUnreadReply = false), false,
            ),
        )
    }

    @Test
    fun `cancelled and interrupted read as done`() {
        // 不是 completed，但对读者的行动含义相同：不用管。
        for (status in listOf(SessionRunStatus.CANCELLED, SessionRunStatus.INTERRUPTED)) {
            assertEquals(
                TaskRowStatus.DONE,
                TaskRowStatusPresentation.resolve(session(runStatus = status), false),
            )
        }
    }

    @Test
    fun `legacy backend without run state falls back to aggregates`() {
        assertEquals(
            TaskRowStatus.RUNNING,
            TaskRowStatusPresentation.resolve(session(hasActiveTask = true), false),
        )
        assertEquals(
            TaskRowStatus.FAILED,
            TaskRowStatusPresentation.resolve(session(lastRunFailed = true), false),
        )
        assertEquals(
            TaskRowStatus.DONE_UNREAD,
            TaskRowStatusPresentation.resolve(session(hasUnreadReply = true), false),
        )
        assertEquals(
            TaskRowStatus.DONE,
            TaskRowStatusPresentation.resolve(session(), false),
        )
    }

    @Test
    fun `local pending interaction only fills the legacy gap`() {
        assertEquals(
            TaskRowStatus.WAITING_USER,
            TaskRowStatusPresentation.resolve(session(), hasPendingInteraction = true),
        )
        // 有服务端事实时不被本机 HITL 缓存改写。
        assertEquals(
            TaskRowStatus.RUNNING,
            TaskRowStatusPresentation.resolve(
                session(runStatus = SessionRunStatus.RUNNING), hasPendingInteraction = true,
            ),
        )
    }

    @Test
    fun `malformed run state falls back instead of poisoning the row`() {
        val broken = session(hasActiveTask = true).copy(
            runState = SessionRunState(
                runId = "",
                sequence = -1,
                revision = 0L,
                status = "bogus",
                queueDepth = 0,
                stateChangedAt = "",
            ),
        )
        assertEquals(TaskRowStatus.RUNNING, TaskRowStatusPresentation.resolve(broken, false))
    }

    @Test
    fun `done states carry no second line text`() {
        assertNull(TaskRowStatusPresentation.statusTextRes(TaskRowStatus.DONE))
        assertNull(TaskRowStatusPresentation.statusTextRes(TaskRowStatus.DONE_UNREAD))
    }

    @Test
    fun `location prefers project name inside a project`() {
        assertEquals(
            "增长项目",
            session(projectId = "p-1", projectName = "增长项目", spaceName = "宿主 Space")
                .taskRowLocationName(),
        )
    }

    @Test
    fun `location falls back to workspace name`() {
        assertEquals("默认 Workspace", session(spaceName = "默认 Workspace").taskRowLocationName())
        // 没有 project_id 时，孤儿 project_name 不参与
        assertEquals(
            "默认 Workspace",
            session(projectName = "孤儿项目名", spaceName = "默认 Workspace").taskRowLocationName(),
        )
        assertNull(session(spaceName = " ").taskRowLocationName())
    }

    private fun session(
        runStatus: String? = null,
        hasActiveTask: Boolean = false,
        hasUnreadReply: Boolean = false,
        lastRunFailed: Boolean = false,
        projectId: String? = null,
        projectName: String? = null,
        spaceName: String? = null,
    ): AllChatSession = AllChatSession(
        id = "session-1",
        spaceName = spaceName,
        projectId = projectId,
        projectName = projectName,
        hasActiveTask = hasActiveTask,
        hasUnreadReply = hasUnreadReply,
        lastRunFailed = lastRunFailed,
        runState = runStatus?.let {
            SessionRunState(
                runId = "run-1",
                sequence = 1,
                revision = 1L,
                status = it,
                queueDepth = 0,
                stateChangedAt = "2026-01-01T00:00:00Z",
            )
        },
    )
}
