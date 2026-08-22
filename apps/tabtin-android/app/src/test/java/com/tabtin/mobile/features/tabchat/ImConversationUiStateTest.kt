package com.tabtin.mobile.features.tabchat

import com.tabtin.mobile.data.im.ImAgentSummary
import com.tabtin.mobile.data.im.ImMessage
import com.tabtin.mobile.data.im.ImPendingMessage
import com.tabtin.mobile.data.im.ImTaskShareMode
import com.tabtin.mobile.data.model.ChatMessage
import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ImConversationUiStateTest {
    @Test
    fun `pin jump uses rendered timeline index when pending precedes target`() {
        val target = ImMessage(
            id = 92,
            seq = 92,
            conversationId = "conv-1",
            content = "pinned",
            createdAt = "1970-01-01T00:00:02Z",
        )
        val pending = pendingMessage(createdAtEpochMs = 1_000)
        val rows = imConversationTimelineRows(listOf(target), listOf(pending))

        assertEquals(
            3,
            imConversationMessageListIndex(
                targetMessageId = target.id,
                timelineRows = rows,
                hasGroupCreatedNotice = true,
                hasLoadMoreRow = true,
            ),
        )
    }

    @Test
    fun `failed send stays before same-second remote confirmation`() {
        val pending = pendingMessage(createdAtEpochMs = 1_500)
        val confirmed = ImMessage(
            id = 92,
            seq = 92,
            conversationId = "conv-1",
            content = "second",
            createdAt = "1970-01-01T00:00:01.700Z",
        )

        val rows = imConversationTimelineRows(listOf(confirmed), listOf(pending))

        assertEquals(listOf("p-request-1", "m-92"), rows.map { it.stableKey })
    }

    @Test
    fun `precise confirmed send stays before later pending in same second`() {
        val pending = pendingMessage(createdAtEpochMs = 1_700)
        val confirmed = ImMessage(
            id = 91,
            seq = 91,
            conversationId = "conv-1",
            content = "first",
            createdAt = "1970-01-01T00:00:01.200Z",
        )

        val rows = imConversationTimelineRows(listOf(confirmed), listOf(pending))

        assertEquals(listOf("m-91", "p-request-1"), rows.map { it.stableKey })
    }

    @Test
    fun `shared session timeline hides runtime context and compaction summary`() {
        val messages = listOf(
            ChatMessage(id = "user", role = "user", content = "真实问题"),
            ChatMessage(
                id = "environment",
                role = "system",
                messageKind = "environment_context",
                content = "current_model: internal",
            ),
            ChatMessage(
                id = "compaction",
                role = "user",
                messageKind = "compaction_summary",
                content = "内部压缩摘要",
            ),
            ChatMessage(id = "assistant", role = "assistant", content = "正常回复"),
        )

        assertEquals(
            listOf("user", "assistant"),
            SharedSessionMessageVisibility.filter(messages).map { it.id },
        )
    }

    @Test
    fun `failed first send stays before a later confirmed message`() {
        val pending = pendingMessage(createdAtEpochMs = 1_000)
        val confirmed = ImMessage(
            id = 92,
            seq = 92,
            conversationId = "conv-1",
            content = "second",
            createdAt = "1970-01-01T00:00:02Z",
        )

        val rows = imConversationTimelineRows(listOf(confirmed), listOf(pending))

        assertEquals(listOf("p-request-1", "m-92"), rows.map { it.stableKey })
    }

    private fun pendingMessage(createdAtEpochMs: Long): ImPendingMessage = ImPendingMessage(
        clientRequestId = "request-1",
        content = "first",
        messageType = 1,
        replyToId = null,
        mentionedUserIds = emptyList(),
        mentionedAgentIds = emptyList(),
        mentionAll = false,
        attachment = null,
        card = null,
        createdAtEpochMs = createdAtEpochMs,
        errorMessage = null,
        status = ImPendingMessage.Status.FAILED,
    )

    @Test
    fun `agent draft mention keeps agent identity`() {
        val mention = ImDraftMention.from(ImAgentSummary(id = "agent-7", name = "设计助手"))

        assertEquals("agent:agent-7", mention.id)
        assertEquals("设计助手", mention.displayName)
        assertEquals("agent-7", mention.agentId)
        assertEquals(null, mention.userId)
    }

    @Test
    fun `message projection keeps latest content for duplicate row id`() {
        val projected = uniqueImConversationMessages(
            listOf(
                ImMessage(id = 20, seq = 20, content = "原消息"),
                ImMessage(id = 21, seq = 21, content = "下一条"),
                ImMessage(id = 20, seq = 20, content = "刷新后的消息"),
            ),
        )

        assertEquals(listOf(20, 21), projected.map { it.id })
        assertEquals("刷新后的消息", projected.first().content)
    }

    @Test
    fun `short conversation at top does not request earlier history without a user drag`() {
        assertEquals(
            EarlierHistoryLoadAction.NONE,
            earlierHistoryLoadAction(
                firstVisibleItemIndex = 0,
                canScrollForward = false,
                isUserDragging = false,
                hasSettledInitialPosition = true,
                hasMessages = true,
                hasMoreHistory = true,
                isLoadingHistory = false,
                loadMoreRequested = false,
            ),
        )
    }

    @Test
    fun `user dragging a scrollable conversation to the top requests earlier history`() {
        assertEquals(
            EarlierHistoryLoadAction.REQUEST,
            earlierHistoryLoadAction(
                firstVisibleItemIndex = 0,
                canScrollForward = true,
                isUserDragging = true,
                hasSettledInitialPosition = true,
                hasMessages = true,
                hasMoreHistory = true,
                isLoadingHistory = false,
                loadMoreRequested = false,
            ),
        )
    }

    @Test
    fun `cached rows remain visible while initial history refresh is still in flight`() {
        assertFalse(
            shouldHideInitialImRows(
                hasConversationRows = true,
                hasSettledInitialPosition = false,
                hadCachedRowsOnEntry = true,
            ),
        )
    }

    @Test
    fun `cold rows stay hidden until initial scroll settles`() {
        assertTrue(
            shouldHideInitialImRows(
                hasConversationRows = true,
                hasSettledInitialPosition = false,
                hadCachedRowsOnEntry = false,
            ),
        )
    }

    @Test
    fun `initial list index points at cached tail row`() {
        assertEquals(
            2,
            initialImConversationTailIndex(
                messageCount = 3,
                pendingCount = 0,
                typingActive = false,
                hasLoadMoreRow = false,
            ),
        )
    }

    @Test
    fun `initial list index includes non-message tail rows`() {
        assertEquals(
            5,
            initialImConversationTailIndex(
                messageCount = 3,
                pendingCount = 1,
                typingActive = true,
                hasLoadMoreRow = true,
            ),
        )
    }

    @Test
    fun `initial list index is safe for an empty conversation`() {
        assertEquals(
            0,
            initialImConversationTailIndex(
                messageCount = 0,
                pendingCount = 0,
                typingActive = false,
                hasLoadMoreRow = false,
            ),
        )
    }

    @Test
    fun `loading an earlier page does not follow the conversation tail`() {
        assertFalse(
            shouldFollowImConversationTail(
                previousTailMessageId = 90,
                currentTailMessageId = 90,
                previousPendingCount = 0,
                currentPendingCount = 0,
            ),
        )
    }

    @Test
    fun `a newly appended message still follows the conversation tail`() {
        assertTrue(
            shouldFollowImConversationTail(
                previousTailMessageId = 90,
                currentTailMessageId = 91,
                previousPendingCount = 0,
                currentPendingCount = 0,
            ),
        )
    }

    @Test
    fun `starting an outgoing pending message follows the conversation tail`() {
        assertTrue(
            shouldFollowImConversationTail(
                previousTailMessageId = 90,
                currentTailMessageId = 90,
                previousPendingCount = 0,
                currentPendingCount = 1,
            ),
        )
    }

    @Test
    fun `every peer-read direct message keeps its indicator after recycling`() {
        assertTrue(
            shouldShowDmReadIndicator(
                isMine = true,
                isReadByPeer = true,
            ),
        )
    }

    @Test
    fun `incoming direct messages hide indicator while outgoing unread messages keep a hollow indicator`() {
        assertFalse(shouldShowDmReadIndicator(isMine = false, isReadByPeer = true))
        assertTrue(shouldShowDmReadIndicator(isMine = true, isReadByPeer = false))
    }

    @Test
    fun `sent historical task share keeps owner actions when snapshot omits owner id`() {
        assertTrue(
            isSessionShareOwner(
                currentUserId = "owner-1",
                ownerUserId = null,
                isMine = true,
            ),
        )
        assertFalse(
            isSessionShareOwner(
                currentUserId = "grantee-1",
                ownerUserId = "owner-1",
                isMine = true,
            ),
        )
    }

    @Test
    fun `session share submission locks synchronously and recovers after failure`() {
        val submission = ImSessionShareSubmissionController()
        val intent = ImSessionShareSubmissionController.Intent(
            sessionId = "session-1",
            peerUserId = "user-2",
            mode = ImTaskShareMode.VIEW,
        )

        val requestId = submission.start(intent)
        assertTrue(requestId != null)
        java.util.UUID.fromString(requestId)
        assertTrue(submission.isSubmitting)
        assertEquals("请求在途时连续点击必须被拒绝", null, submission.start(intent))

        submission.fail("共享失败，请重试")
        assertFalse(submission.isSubmitting)
        assertEquals("共享失败，请重试", submission.errorMessage)
        assertEquals("同一意图失败重试必须复用幂等键", requestId, submission.start(intent))
    }

    @Test
    fun `session share request id changes after success reset or intent change`() {
        val generatedIds = ArrayDeque(
            listOf(
                "11111111-1111-4111-8111-111111111111",
                "22222222-2222-4222-8222-222222222222",
                "33333333-3333-4333-8333-333333333333",
                "44444444-4444-4444-8444-444444444444",
            ),
        )
        val submission = ImSessionShareSubmissionController { generatedIds.removeFirst() }
        val viewOnly = ImSessionShareSubmissionController.Intent(
            "session-1",
            "user-2",
            ImTaskShareMode.VIEW,
        )
        val continuation = viewOnly.copy(mode = ImTaskShareMode.CONTINUE)

        val first = submission.start(viewOnly)
        submission.succeed()
        val afterSuccess = submission.start(viewOnly)
        submission.fail("共享失败")
        val afterIntentChange = submission.start(continuation)
        submission.fail("共享失败")
        submission.reset()
        val afterReset = submission.start(continuation)

        assertEquals("11111111-1111-4111-8111-111111111111", first)
        assertEquals("22222222-2222-4222-8222-222222222222", afterSuccess)
        assertEquals("33333333-3333-4333-8333-333333333333", afterIntentChange)
        assertEquals("44444444-4444-4444-8444-444444444444", afterReset)
    }

    @Test
    fun `session share sheet rejects state changes while submitting`() {
        assertTrue(canChangeSessionShareSheetState(isSubmitting = false))
        assertFalse(canChangeSessionShareSheetState(isSubmitting = true))
    }

    @Test
    fun `forward source shows other members and hides self`() {
        assertEquals(
            "转发自 小林",
            imForwardSourceText(
                source = com.tabtin.mobile.data.im.ImForwardedFrom(
                    originalSenderId = "user-2",
                    originalSenderName = " 小林 ",
                ),
                currentUserId = "user-1",
            ),
        )
        assertEquals(
            null,
            imForwardSourceText(
                source = com.tabtin.mobile.data.im.ImForwardedFrom(
                    originalSenderId = "user-1",
                    originalSenderName = "我",
                ),
                currentUserId = "user-1",
            ),
        )
        assertEquals(
            "转发自 离线成员",
            imForwardSourceText(
                source = com.tabtin.mobile.data.im.ImForwardedFrom(
                    originalSenderName = "离线成员",
                ),
                currentUserId = "user-1",
            ),
        )
    }
}
