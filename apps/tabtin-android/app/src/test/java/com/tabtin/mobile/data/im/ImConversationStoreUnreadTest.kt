package com.tabtin.mobile.data.im

import android.app.Application
import com.tabtin.mobile.R
import com.tabtin.mobile.data.api.TokenRefreshCoordinator
import com.tabtin.mobile.diagnostics.DiagnosticRecorder
import com.tabtin.mobile.util.TokenManager
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * [ImConversationStore] 未读角标本地同步：进会话清零、personal `im.unread.update`
 * 已读回写清零、非活动会话递增、活动会话不涨。对齐 iOS `IMConversationStoreUnreadTests`。
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class)
class ImConversationStoreUnreadTest {

    @Test
    fun `reconnect delay keeps retrying after former attempt limit`() {
        assertEquals(500L, centrifugoReconnectDelayMillis(1))
        assertEquals(20_000L, centrifugoReconnectDelayMillis(11))
        assertEquals(20_000L, centrifugoReconnectDelayMillis(50))
    }

    @Test
    fun `chat subscription availability only maps real chat channels`() {
        assertEquals("conv-1", centrifugoChatConversationId("chat:conv-1"))
        assertEquals(null, centrifugoChatConversationId("chat:"))
        assertEquals(null, centrifugoChatConversationId("personal:user-1"))
    }

    @Test
    fun `catch up availability follows confirmed personal and chat subscriptions`() {
        assertEquals(
            CentrifugoSubscriptionAvailability.Personal,
            centrifugoSubscriptionAvailability("personal:user-1"),
        )
        assertEquals(
            CentrifugoSubscriptionAvailability.Chat("conv-1"),
            centrifugoSubscriptionAvailability("chat:conv-1"),
        )
        assertEquals(null, centrifugoSubscriptionAvailability("personal:"))
        assertEquals(null, centrifugoSubscriptionAvailability("other:user-1"))
    }

    @Test
    fun `transient missing token keeps retrying`() {
        Dispatchers.setMain(Dispatchers.Unconfined)
        val tokenManager = mockk<TokenManager>()
        every { tokenManager.userId } returns "authenticated-user"
        every { tokenManager.isAccessTokenExpiringSoon } returns false
        every { tokenManager.accessToken } returns null
        val client = CentrifugoClient(
            tokenManager = tokenManager,
            refreshCoordinator = mockk<TokenRefreshCoordinator>(relaxed = true),
            diagnosticRecorder = mockk<DiagnosticRecorder>(relaxed = true),
        )

        client.connect()
        Thread.sleep(800)
        client.disconnect()

        verify(atLeast = 2) { tokenManager.accessToken }
    }

    private class FakePersonalRealtimeSource : ImPersonalRealtimeSource {
        var listener: ((ByteArray) -> Unit)? = null
        var onConnectionAvailable: (() -> Unit)? = null

        override fun setPersonalPublicationListener(listener: ((ByteArray) -> Unit)?) {
            this.listener = listener
        }

        override fun setConnectionAvailableListener(listener: (() -> Unit)?) {
            onConnectionAvailable = listener
        }

        fun publish(json: String) {
            listener?.invoke(json.toByteArray())
        }

        fun restoreConnection() {
            onConnectionAvailable?.invoke()
        }
    }

    // store 的 init 会建 Dispatchers.Main.immediate scope，纯 JVM 单测需先装 Main。
    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun newStore(): ImConversationStore =
        ImConversationStore(dataPlane = mockk(relaxed = true))

    @Test
    fun `personal realtime source feeds store and is detached on clear`() {
        val realtime = FakePersonalRealtimeSource()
        val store = ImConversationStore(
            dataPlane = mockk(relaxed = true),
            personalRealtimeSource = realtime,
        )
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting(listOf(conversation("c1", unread = 0)))

        store.startListeningPersonalForTesting()
        realtime.publish(
            """{"type":"im.unread.update","data":{"conversation_id":"c1","organization_id":"org-1","message_id":7,"message_seq":7,"preview":"实时消息"}}""",
        )

        assertEquals(1, store.conversations.value.single().unreadCount)
        assertEquals("实时消息", store.conversations.value.single().lastMessagePreview)
        assertNotNull(realtime.listener)

        realtime.publish(
            """{"type":"im.ai.error","data":{"agent_name":"研究员","reason":"执行现场不可用"}}""",
        )
        assertEquals(ImConversationStore.PersonalNoticeKind.AI_ERROR, store.personalNotice.value?.kind)
        assertEquals("研究员", store.personalNotice.value?.agentName)
        assertEquals("执行现场不可用", store.personalNotice.value?.reason)

        store.clear()
        assertEquals(null, realtime.listener)
        assertEquals(null, store.personalNotice.value)
    }

    @Test
    fun `personal preview update refreshes subtitle without unread increment`() {
        val realtime = FakePersonalRealtimeSource()
        val store = ImConversationStore(
            dataPlane = mockk(relaxed = true),
            personalRealtimeSource = realtime,
        )
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting(
            listOf(conversation("c1", unread = 3, preview = "旧摘要", lastSeq = 9)),
        )
        store.startListeningPersonalForTesting()

        realtime.publish(
            """{"type":"im.conversation.preview.updated","data":{"conversation_id":"c1","organization_id":"org-1","message_id":99,"message_seq":9,"preview":"消息已撤回","last_message_at":"2026-07-20T11:00:00Z"}}""",
        )

        assertEquals("消息已撤回", store.conversations.value.single().lastMessagePreview)
        assertEquals("2026-07-20T11:00:00Z", store.conversations.value.single().lastMessageAt)
        assertEquals(3, store.conversations.value.single().unreadCount)
    }

    @Test
    fun `personal realtime advances activity time and reorders conversations`() {
        val realtime = FakePersonalRealtimeSource()
        val store = ImConversationStore(
            dataPlane = mockk(relaxed = true),
            personalRealtimeSource = realtime,
        )
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting(
            listOf(
                conversation(
                    id = "newer-before-event",
                    unread = 0,
                    lastMessageAt = "2026-07-20T10:30:00Z",
                ),
                conversation(
                    id = "c1",
                    unread = 0,
                    preview = "旧摘要",
                    lastSeq = 9,
                    lastMessageAt = "2026-07-20T10:00:00Z",
                ),
            ),
        )
        store.startListeningPersonalForTesting()

        realtime.publish(
            """{"type":"im.unread.update","data":{"conversation_id":"c1","organization_id":"org-1","message_id":10,"message_seq":10,"preview":"最新摘要","last_message_at":"2026-07-20T11:00:00Z"}}""",
        )

        assertEquals(listOf("c1", "newer-before-event"), store.conversations.value.map { it.id })
        assertEquals("最新摘要", store.conversations.value.first().lastMessagePreview)
        assertEquals("2026-07-20T11:00:00Z", store.conversations.value.first().lastMessageAt)
    }

    @Test
    fun `connection recovery reloads conversation directory`() = runTest {
        val realtime = FakePersonalRealtimeSource()
        val dataPlane = mockk<ImConversationDataPlane>(relaxed = true)
        coEvery { dataPlane.listConversations("org-1") } returns emptyList()
        val store = ImConversationStore(
            dataPlane = dataPlane,
            personalRealtimeSource = realtime,
        )
        store.prepareOrganizationForTesting("org-1")
        store.startListeningPersonalForTesting()

        realtime.restoreConnection()

        coVerify(exactly = 1) { dataPlane.listConversations("org-1") }
    }

    private fun conversation(
        id: String,
        unread: Int,
        preview: String = "hi",
        lastSeq: Int = 0,
        lastMessageAt: String? = null,
        pinned: Boolean = false,
        muted: Boolean = false,
        createdAt: String = "",
        labels: List<ImConversationLabel> = emptyList(),
    ): ImConversation = ImConversation(
        id = id,
        unreadCount = unread,
        lastMessagePreview = preview,
        lastMessageSeq = lastSeq,
        lastMessageAt = lastMessageAt,
        pinned = pinned,
        isMuted = muted,
        createdAt = createdAt,
        labels = labels,
    )

    @Test
    fun `existing direct message resolves locally without remote request`() = runTest {
        var remoteRequests = 0
        val conversations = listOf(
            conversation("dm-other-org", unread = 0).copy(
                organizationId = "org-2",
                type = ImConversationType.DM,
                dmPeerUserId = "user-2",
            ),
            conversation("group-same-peer", unread = 0).copy(
                organizationId = "org-1",
                type = ImConversationType.GROUP,
                dmPeerUserId = "user-2",
            ),
            conversation("dm-local", unread = 0).copy(
                organizationId = "org-1",
                type = ImConversationType.DM,
                memberCount = 2,
                dmPeerUserId = "user-2",
            ),
        )

        val conversationId = resolveDirectMessageConversationId(
            conversations = conversations,
            organizationId = "org-1",
            otherUserId = "user-2",
        ) {
            remoteRequests += 1
            "dm-remote"
        }

        assertEquals("dm-local", conversationId)
        assertEquals(0, remoteRequests)
    }

    @Test
    fun `missing direct message falls back to remote request`() = runTest {
        var remoteRequests = 0

        val conversationId = resolveDirectMessageConversationId(
            conversations = emptyList(),
            organizationId = "org-1",
            otherUserId = "user-2",
        ) {
            remoteRequests += 1
            "dm-remote"
        }

        assertEquals("dm-remote", conversationId)
        assertEquals(1, remoteRequests)
    }

    @Test
    fun `removed member direct message falls back to remote request`() = runTest {
        var remoteRequests = 0
        val stale = conversation("dm-stale", unread = 0).copy(
            organizationId = "org-1",
            type = ImConversationType.DM,
            memberCount = 1,
            dmPeerUserId = "user-2",
        )

        val conversationId = resolveDirectMessageConversationId(
            conversations = listOf(stale),
            organizationId = "org-1",
            otherUserId = "user-2",
        ) {
            remoteRequests += 1
            "dm-restored"
        }

        assertEquals("dm-restored", conversationId)
        assertEquals(1, remoteRequests)
    }

    @Test
    fun `new remote direct message is remembered locally for the next open`() {
        val store = newStore()
        store.prepareOrganizationForTesting("org-1")

        store.rememberDirectMessage(
            conversationId = "dm-created",
            organizationId = "org-1",
            otherUserId = "user-2",
            displayName = "用户二",
        )
        store.rememberDirectMessage(
            conversationId = "dm-created",
            organizationId = "org-1",
            otherUserId = "user-2",
            displayName = "用户二",
        )

        val remembered = store.conversations.value.single()
        assertEquals("dm-created", remembered.id)
        assertEquals("org-1", remembered.organizationId)
        assertEquals(ImConversationType.DM, remembered.type)
        assertEquals("user-2", remembered.dmPeerUserId)
        assertEquals("用户二", remembered.name)
    }

    @Test
    fun `pinned conversations stay above newer ordinary conversations`() {
        val store = newStore()
        store.replaceConversationsForTesting(
            listOf(
                conversation("ordinary-new", unread = 0, createdAt = "2026-07-28T00:00:00Z"),
                conversation("pinned-old", unread = 0, pinned = true, createdAt = "2026-07-20T00:00:00Z"),
            ),
        )

        assertEquals(listOf("pinned-old", "ordinary-new"), store.conversations.value.map { it.id })
    }

    @Test
    fun `conversation rename and mute settings update list immediately`() {
        val store = newStore()
        store.replaceConversationsForTesting(listOf(conversation("group-1", unread = 0).copy(name = "旧群名")))

        store.updateConversationName("group-1", "新群名")
        store.updateMuteState("group-1", true)

        assertEquals("新群名", store.conversations.value.single().name)
        assertEquals(true, store.conversations.value.single().isMuted)
    }

    @Test
    fun `toggle pin persists server result and immediately reorders list`() = runTest {
        val dataPlane = mockk<ImConversationDataPlane>(relaxed = true)
        val store = ImConversationStore(dataPlane)
        store.replaceConversationsForTesting(
            listOf(
                conversation("ordinary", unread = 0, createdAt = "2026-07-20T00:00:00Z"),
                conversation("newer", unread = 0, createdAt = "2026-07-28T00:00:00Z"),
            ),
        )

        store.togglePin("ordinary")

        assertEquals(listOf("ordinary", "newer"), store.conversations.value.map { it.id })
        assertEquals(true, store.conversations.value.first().pinned)
    }

    @Test
    fun `mute result updates the current conversation without a list reload`() {
        val store = newStore()
        store.replaceConversationsForTesting(
            listOf(
                conversation("c1", unread = 0, muted = false),
                conversation("c2", unread = 0, muted = false),
            ),
        )

        store.updateMuteState("c1", muted = true)

        assertEquals(true, store.conversations.value.first { it.id == "c1" }.isMuted)
        assertEquals(false, store.conversations.value.first { it.id == "c2" }.isMuted)
    }

    @Test
    fun `toggle mute writes explicit target and updates list immediately`() = runTest {
        val dataPlane = mockk<ImConversationDataPlane>(relaxed = true)
        val store = ImConversationStore(dataPlane)
        store.replaceConversationsForTesting(listOf(conversation("c1", unread = 0, muted = false)))

        store.toggleMute("c1")

        coVerify(exactly = 1) { dataPlane.setConversationMuted("c1", true) }
        assertEquals(true, store.conversations.value.single().isMuted)
    }

    @Test
    fun `toggle mute rolls back local state when provider write fails`() = runTest {
        val dataPlane = mockk<ImConversationDataPlane>(relaxed = true)
        coEvery { dataPlane.setConversationMuted("c1", true) } throws IllegalStateException("provider failed")
        val store = ImConversationStore(dataPlane)
        store.replaceConversationsForTesting(listOf(conversation("c1", unread = 0, muted = false)))

        store.toggleMute("c1")

        assertEquals(false, store.conversations.value.single().isMuted)
        assertNotNull(store.muteActionError.value)
    }

    @Test
    fun `leaving a group removes it from the list and clears foreground state`() {
        val store = newStore()
        store.replaceConversationsForTesting(
            listOf(conversation("group-1", unread = 3), conversation("dm-1", unread = 2)),
        )
        store.enterConversation("group-1")

        store.removeConversation("group-1")

        assertEquals(listOf("dm-1"), store.conversations.value.map { it.id })
        store.applyUnreadUpdate(newMessageUpdate("group-1"))
        assertEquals(1, store.conversations.value.size)
    }

    private fun newMessageUpdate(conversationId: String, preview: String = "new"): ImUnreadUpdate =
        ImUnreadUpdate(conversationId = conversationId, messageId = 11, preview = preview)

    private fun markedReadUpdate(conversationId: String): ImUnreadUpdate =
        ImUnreadUpdate(conversationId = conversationId, markedRead = 9)

    @Test
    fun `enterConversation clears local unread`() {
        val store = newStore()
        store.replaceConversationsForTesting(listOf(conversation("c1", unread = 5)))

        store.enterConversation("c1")

        assertEquals(0, store.conversations.value.first { it.id == "c1" }.unreadCount)
    }

    @Test
    fun `aggregate unread sums non-negative conversation counts`() {
        val store = newStore()
        store.replaceConversationsForTesting(
            listOf(
                conversation("c1", unread = 2),
                conversation("c2", unread = 5),
                conversation("c3", unread = -9),
            ),
        )

        assertEquals(7, store.aggregateUnreadCount.value)
    }

    @Test
    fun `aggregate and realtime increment saturate at int max`() {
        val store = newStore()
        store.replaceConversationsForTesting(
            listOf(conversation("c1", unread = Int.MAX_VALUE), conversation("c2", unread = 1)),
        )

        assertEquals(Int.MAX_VALUE, store.aggregateUnreadCount.value)

        store.applyUnreadUpdate(newMessageUpdate("c1"))
        assertEquals(Int.MAX_VALUE, store.conversations.value.first { it.id == "c1" }.unreadCount)
        assertEquals(Int.MAX_VALUE, store.aggregateUnreadCount.value)
    }

    @Test
    fun `marked_read writeback clears unread`() {
        val store = newStore()
        store.replaceConversationsForTesting(listOf(conversation("c1", unread = 3)))

        store.applyUnreadUpdate(markedReadUpdate("c1"))

        assertEquals(0, store.conversations.value.first { it.id == "c1" }.unreadCount)
    }

    @Test
    fun `new message increments non-active conversation and updates preview`() {
        val store = newStore()
        store.replaceConversationsForTesting(listOf(conversation("c1", unread = 2, preview = "old")))

        store.applyUnreadUpdate(newMessageUpdate("c1", preview = "brand new"))

        val updated = store.conversations.value.first { it.id == "c1" }
        assertEquals(3, updated.unreadCount)
        assertEquals("brand new", updated.lastMessagePreview)
        assertEquals(3, store.aggregateUnreadCount.value)
    }

    @Test
    fun `mention unread adds system label and read removes only that label`() {
        val custom = ImConversationLabel(id = "custom:priority", name = "Priority")
        val store = newStore()
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting(
            listOf(conversation("c1", unread = 0, labels = listOf(custom))),
        )

        store.applyUnreadUpdate(
            ImUnreadUpdate(
                conversationId = "c1",
                organizationId = "org-1",
                messageId = 21,
                messageSeq = 21,
                preview = "@你 看一下",
                mention = true,
            ),
        )
        assertEquals(setOf("custom:priority", "sys:mention"), store.conversations.value.single().labels.map { it.id }.toSet())

        store.enterConversation("c1")
        assertEquals(listOf("custom:priority"), store.conversations.value.single().labels.map { it.id })
    }

    @Test
    fun `buffered mention survives unread before conversation new`() {
        val store = newStore()
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting(emptyList())

        store.applyUnreadUpdate(
            ImUnreadUpdate(
                conversationId = "c-new",
                organizationId = "org-1",
                messageId = 22,
                messageSeq = 22,
                preview = "@你 新会话",
                mention = true,
            ),
        )
        store.applyConversationNew(conversation("c-new", unread = 0))

        assertEquals(true, store.conversations.value.single().labels.any { it.id == "sys:mention" })
    }

    @Test
    fun `mention arriving during load survives older snapshot commit`() {
        val store = newStore()
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting(listOf(conversation("c1", unread = 0, lastSeq = 20)))

        store.beginLoadWindowForTesting()
        store.applyUnreadUpdate(
            ImUnreadUpdate(
                conversationId = "c1",
                organizationId = "org-1",
                messageId = 21,
                messageSeq = 21,
                preview = "@你 窗口内",
                mention = true,
            ),
        )
        store.commitLoadForTesting(listOf(conversation("c1", unread = 0, lastSeq = 20)))

        assertEquals(true, store.conversations.value.single().labels.any { it.id == "sys:mention" })
    }

    @Test
    fun `latest preview update can replace recalled last message without unread increment`() {
        val store = newStore()
        store.replaceConversationsForTesting(listOf(conversation("c1", unread = 2, preview = "待撤回", lastSeq = 9)))

        store.applyLatestPreviewUpdate("c1", messageSeq = 9, preview = "消息已撤回")

        val updated = store.conversations.value.first { it.id == "c1" }
        assertEquals(2, updated.unreadCount)
        assertEquals("消息已撤回", updated.lastMessagePreview)
        assertEquals(9, updated.lastMessageSeq)
    }

    @Test
    fun `recalled latest preview survives stale conversation snapshot`() {
        val store = newStore()
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting(listOf(conversation("c1", unread = 0, preview = "待撤回", lastSeq = 9)))

        store.applyLatestPreviewUpdate("c1", messageSeq = 9, preview = "消息已撤回")
        store.beginLoadWindowForTesting()
        store.commitLoadForTesting(listOf(conversation("c1", unread = 0, preview = "待撤回", lastSeq = 9)))

        val updated = store.conversations.value.first { it.id == "c1" }
        assertEquals("消息已撤回", updated.lastMessagePreview)
        assertEquals(9, updated.lastMessageSeq)
    }

    @Test
    fun `recalled latest preview can be recorded before conversation list loads`() {
        val store = newStore()
        store.prepareOrganizationForTesting("org-1")

        store.applyLatestPreviewUpdate("c1", messageSeq = 9, preview = "消息已撤回")
        store.beginLoadWindowForTesting()
        store.commitLoadForTesting(listOf(conversation("c1", unread = 0, preview = "待撤回", lastSeq = 9)))

        val updated = store.conversations.value.first { it.id == "c1" }
        assertEquals("消息已撤回", updated.lastMessagePreview)
        assertEquals(9, updated.lastMessageSeq)
    }

    @Test
    fun `newer snapshot replaces recalled latest preview override`() {
        val store = newStore()
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting(listOf(conversation("c1", unread = 0, preview = "待撤回", lastSeq = 9)))

        store.applyLatestPreviewUpdate("c1", messageSeq = 9, preview = "消息已撤回")
        store.beginLoadWindowForTesting()
        store.commitLoadForTesting(listOf(conversation("c1", unread = 0, preview = "新消息", lastSeq = 10)))

        val updated = store.conversations.value.first { it.id == "c1" }
        assertEquals("新消息", updated.lastMessagePreview)
        assertEquals(10, updated.lastMessageSeq)
    }

    @Test
    fun `latest preview update ignores older recalled message`() {
        val store = newStore()
        store.replaceConversationsForTesting(listOf(conversation("c1", unread = 0, preview = "最新消息", lastSeq = 10)))

        store.applyLatestPreviewUpdate("c1", messageSeq = 9, preview = "消息已撤回")

        val updated = store.conversations.value.first { it.id == "c1" }
        assertEquals("最新消息", updated.lastMessagePreview)
        assertEquals(10, updated.lastMessageSeq)
    }

    @Test
    fun `active conversation refreshes preview without incrementing unread`() {
        val store = newStore()
        store.replaceConversationsForTesting(listOf(conversation("c1", unread = 0, preview = "旧摘要", lastSeq = 10)))
        store.enterConversation("c1")

        store.applyUnreadUpdate(
            ImUnreadUpdate(
                conversationId = "c1",
                organizationId = "org-1",
                messageId = 11,
                messageSeq = 11,
                preview = "正在看的新消息",
            ),
        )

        val updated = store.conversations.value.first { it.id == "c1" }
        assertEquals(0, updated.unreadCount)
        assertEquals("正在看的新消息", updated.lastMessagePreview)
        assertEquals(11, updated.lastMessageSeq)
    }

    @Test
    fun `leaveConversation re-enables increment`() {
        val store = newStore()
        store.replaceConversationsForTesting(listOf(conversation("c1", unread = 0)))
        store.enterConversation("c1")
        store.leaveConversation("c1")

        store.applyUnreadUpdate(newMessageUpdate("c1"))

        assertEquals(1, store.conversations.value.first { it.id == "c1" }.unreadCount)
    }

    @Test
    fun `mark read and clear reduce aggregate unread immediately`() {
        val store = newStore()
        store.replaceConversationsForTesting(
            listOf(conversation("c1", unread = 4), conversation("c2", unread = 3)),
        )

        store.clearUnread("c1")
        assertEquals(3, store.aggregateUnreadCount.value)

        store.clear()
        assertEquals(0, store.aggregateUnreadCount.value)
    }

    @Test
    fun `organization switch clears old unread before new list returns`() {
        val dataPlane = mockk<ImConversationDataPlane>(relaxed = true)
        val delayedSecond = CompletableDeferred<List<ImConversation>>()
        coEvery { dataPlane.listConversations("org-a") } returns listOf(conversation("c1", unread = 6))
        coEvery { dataPlane.listConversations("org-b") } coAnswers { delayedSecond.await() }
        val store = ImConversationStore(dataPlane)

        store.loadConversations("org-a")
        assertEquals(6, store.aggregateUnreadCount.value)

        store.loadConversations("org-b")
        assertEquals(0, store.aggregateUnreadCount.value)
        assertEquals(emptyList<ImConversation>(), store.conversations.value)

        store.clear()
        delayedSecond.cancel()
    }

    @Test
    fun `synchronous reload reports catalog failure`() = runTest {
        val dataPlane = mockk<ImConversationDataPlane>(relaxed = true)
        coEvery { dataPlane.listConversations("org-a") } throws IllegalStateException("catalog unavailable")
        val store = ImConversationStore(dataPlane)

        val loaded = store.reload("org-a")

        assertEquals(false, loaded)
        assertEquals(R.string.error_unknown, store.loadErrorRes.value)
    }

    @Test
    fun `update for unknown conversation is ignored`() {
        val store = newStore()
        store.replaceConversationsForTesting(listOf(conversation("c1", unread = 1)))

        store.applyUnreadUpdate(newMessageUpdate("missing"))

        assertEquals(1, store.conversations.value.first { it.id == "c1" }.unreadCount)
        assertEquals(1, store.conversations.value.size)
    }

    @Test
    fun `out of order unread events are both counted`() {
        // 回归  issue 2：标量 seq 水位会把「先到 seq=10、后到此前未处理的 seq=9」中的 seq=9
        // 误当已计入而丢弃、造成少计。现在两条不同消息各自 +1，乱序也不丢。
        val store = newStore()
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting(listOf(conversation("c1", unread = 0)))

        store.applyUnreadUpdate(ImUnreadUpdate(conversationId = "c1", organizationId = "org-1", messageId = 10, messageSeq = 10))
        store.applyUnreadUpdate(ImUnreadUpdate(conversationId = "c1", organizationId = "org-1", messageId = 9, messageSeq = 9))
        assertEquals(2, store.conversations.value.first { it.id == "c1" }.unreadCount)
    }

    @Test
    fun `out of order window preview keeps highest seq not last arrived`() {
        // 回归 ：加载窗口内 realtime 可乱序到达——先 seq=10（预览 A）、后 seq=9（预览 B）。
        // 快照水位=8（未含 9/10）→ 净增 2；摘要必须停在最高 seq(10) 的 A，不被后到的旧消息 B 退回。
        val store = newStore()
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting(listOf(conversation("c1", unread = 0)))

        store.beginLoadWindowForTesting()
        store.applyUnreadUpdate(ImUnreadUpdate(conversationId = "c1", organizationId = "org-1", messageId = 10, messageSeq = 10, preview = "A"))
        store.applyUnreadUpdate(ImUnreadUpdate(conversationId = "c1", organizationId = "org-1", messageId = 9, messageSeq = 9, preview = "B"))
        store.commitLoadForTesting(listOf(conversation("c1", unread = 0, preview = "旧", lastSeq = 8)))

        val c1 = store.conversations.value.first { it.id == "c1" }
        assertEquals(2, c1.unreadCount)
        assertEquals("A", c1.lastMessagePreview)
    }

    @Test
    fun `waterline covers window keeps snapshot preview not last arrived`() {
        // 回归  复现原样：加载期间先到 seq=10（A）再到 seq=9（B），快照水位=10（已含二者）。
        // 未读不叠加（都 <= 水位），摘要必须用权威快照（seq=10 的 A），绝不落到后到的旧 B。
        val store = newStore()
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting(listOf(conversation("c1", unread = 0)))

        store.beginLoadWindowForTesting()
        store.applyUnreadUpdate(ImUnreadUpdate(conversationId = "c1", organizationId = "org-1", messageId = 10, messageSeq = 10, preview = "A"))
        store.applyUnreadUpdate(ImUnreadUpdate(conversationId = "c1", organizationId = "org-1", messageId = 9, messageSeq = 9, preview = "B"))
        store.commitLoadForTesting(listOf(conversation("c1", unread = 1, preview = "A", lastSeq = 10)))

        val c1 = store.conversations.value.first { it.id == "c1" }
        assertEquals(1, c1.unreadCount)
        assertEquals("A", c1.lastMessagePreview)
    }

    @Test
    fun `out of order live preview keeps highest seq`() {
        // 稳态（无加载窗口）乱序：先 seq=10（A）后 seq=9（B），摘要应停在 A。
        val store = newStore()
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting(listOf(conversation("c1", unread = 0, preview = "旧")))

        store.applyUnreadUpdate(ImUnreadUpdate(conversationId = "c1", organizationId = "org-1", messageId = 10, messageSeq = 10, preview = "A"))
        store.applyUnreadUpdate(ImUnreadUpdate(conversationId = "c1", organizationId = "org-1", messageId = 9, messageSeq = 9, preview = "B"))

        val c1 = store.conversations.value.first { it.id == "c1" }
        assertEquals(2, c1.unreadCount)
        assertEquals("A", c1.lastMessagePreview)
    }

    @Test
    fun `non-zero stale baseline merges snapshot plus window delta only`() {
        // 回归 ：被触碰会话不得保留「完整本地未读」（含陈旧基线），只在权威快照上叠加窗口净增量。
        // 本地旧 unread=5、对端已读到 0；刷新在途来一条新消息；REST 权威=0、水位=0 → 最终应为 1（不是 6）。
        val store = newStore()
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting(listOf(conversation("c1", unread = 5)))

        store.beginLoadWindowForTesting()
        store.applyPersonalEvent(
            ImRealtimeEvent.UnreadUpdate(
                ImUnreadUpdate(conversationId = "c1", organizationId = "org-1", messageId = 5, messageSeq = 5, preview = "窗口内"),
            ),
        )
        store.commitLoadForTesting(listOf(conversation("c1", unread = 0, lastSeq = 0)))
        assertEquals(1, store.conversations.value.first { it.id == "c1" }.unreadCount)
    }

    @Test
    fun `snapshot before publication counts window delta`() {
        // snapshot-before-publication：快照水位=4（未含 seq=5）→ seq=5 计净增。
        val store = newStore()
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting(listOf(conversation("c1", unread = 0)))

        store.beginLoadWindowForTesting()
        store.applyPersonalEvent(
            ImRealtimeEvent.UnreadUpdate(
                ImUnreadUpdate(conversationId = "c1", organizationId = "org-1", messageId = 5, messageSeq = 5, preview = "窗口内"),
            ),
        )
        store.commitLoadForTesting(listOf(conversation("c1", unread = 0, lastSeq = 4)))
        assertEquals(1, store.conversations.value.first { it.id == "c1" }.unreadCount)
    }

    @Test
    fun `snapshot includes publication does not double count`() {
        // snapshot-includes-publication：快照 unread=1、水位=5（已含 seq=5）→ 窗口同一 seq=5 不重复计。
        val store = newStore()
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting(listOf(conversation("c1", unread = 0)))

        store.beginLoadWindowForTesting()
        store.applyPersonalEvent(
            ImRealtimeEvent.UnreadUpdate(
                ImUnreadUpdate(conversationId = "c1", organizationId = "org-1", messageId = 5, messageSeq = 5, preview = "窗口内"),
            ),
        )
        store.commitLoadForTesting(listOf(conversation("c1", unread = 1, lastSeq = 5)))
        assertEquals(1, store.conversations.value.first { it.id == "c1" }.unreadCount)
    }

    @Test
    fun `active consumed message is not republished as unread after leave`() {
        // 回归 ：前台（active）收到 message_id=42 已消费；离开后 Centrifugo 重投 42 不得冒伪未读。
        val store = newStore()
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting(listOf(conversation("c1", unread = 0)))
        store.enterConversation("c1")
        val ev = ImRealtimeEvent.UnreadUpdate(
            ImUnreadUpdate(conversationId = "c1", organizationId = "org-1", messageId = 42, messageSeq = 42, preview = "hi"),
        )
        store.applyPersonalEvent(ev) // 前台消费：清零 + 登记 message_id
        assertEquals(0, store.conversations.value.first { it.id == "c1" }.unreadCount)
        store.leaveConversation("c1")
        store.applyPersonalEvent(ev) // 离开后重投同一 message_id
        assertEquals(0, store.conversations.value.first { it.id == "c1" }.unreadCount)
    }

    @Test
    fun `quiet window snapshot is authoritative for untouched conversation`() {
        // 未被触碰的会话（加载窗口内无并发事件）以权威快照为准，不叠加历史本地值。
        val store = newStore()
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting(listOf(conversation("c1", unread = 5)))

        store.beginLoadWindowForTesting()
        store.commitLoadForTesting(listOf(conversation("c1", unread = 2)))
        assertEquals(2, store.conversations.value.first { it.id == "c1" }.unreadCount)
    }

    @Test
    fun `in-flight conversation new is preserved after commit`() {
        // 加载在途期间新建 DM（im.conversation.new）：结果落地时该会话应保留，不被快照覆盖丢失。
        val store = newStore()
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting(listOf(conversation("c1", unread = 0)))

        store.beginLoadWindowForTesting()
        store.applyPersonalEvent(
            ImRealtimeEvent.ConversationNew(
                ImConversation(id = "c-new", organizationId = "org-1", type = ImConversationType.DM),
            ),
        )
        // 陈旧快照不含 c-new：合并后 c-new 仍保留。
        store.commitLoadForTesting(listOf(conversation("c1", unread = 0)))
        assertEquals(true, store.conversations.value.any { it.id == "c-new" })
    }

    @Test
    fun `duplicate publication for existing conversation does not double count`() {
        // 回归 ：Centrifugo 重连/重投同一 message_id，已有会话不得重复 +1。
        val store = newStore()
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting(listOf(conversation("c1", unread = 0)))
        val ev = ImRealtimeEvent.UnreadUpdate(
            ImUnreadUpdate(conversationId = "c1", organizationId = "org-1", messageId = 42, messageSeq = 42, preview = "hi"),
        )
        store.applyPersonalEvent(ev)
        store.applyPersonalEvent(ev) // 重投同一 message_id
        store.applyPersonalEvent(ev)
        assertEquals(1, store.conversations.value.first { it.id == "c1" }.unreadCount)
    }

    @Test
    fun `marked read clears buffered unknown unread before conversation new`() {
        // 回归 ：unknown unread -> marked_read -> conversation.new。
        // 未知会话未读先到被缓冲；随后另一端已读 marked_read 到达（会话仍未插入，clearUnread 无效）；
        // 已读应清掉缓冲，避免延迟的 conversation.new 把已读消息回放成未读。
        val store = newStore()
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting(emptyList())

        // 1) 未知会话未读先到 → 缓冲。
        store.applyPersonalEvent(
            ImRealtimeEvent.UnreadUpdate(
                ImUnreadUpdate(conversationId = "c-new", organizationId = "org-1", messageId = 1, messageSeq = 1, preview = "在吗"),
            ),
        )
        // 2) 另一端已读的 marked_read 到达（会话尚未插入）。
        store.applyPersonalEvent(
            ImRealtimeEvent.UnreadUpdate(ImUnreadUpdate(conversationId = "c-new", markedRead = 1)),
        )
        // 3) 延迟的 conversation.new 插入：不得把已读消息回放成未读。
        store.applyPersonalEvent(
            ImRealtimeEvent.ConversationNew(
                ImConversation(id = "c-new", organizationId = "org-1", type = ImConversationType.DM),
            ),
        )
        val c = store.conversations.value.first { it.id == "c-new" }
        assertEquals(0, c.unreadCount)
        assertEquals(0, store.aggregateUnreadCount.value)
    }

    @Test
    fun `buffered unknown unread dedups by message id`() {
        // 未知会话未读缓冲经全局 message_id 去重：同一条消息重复投递（重连）不得把缓冲变成 2。
        val store = newStore()
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting(emptyList())
        val ev = ImRealtimeEvent.UnreadUpdate(
            ImUnreadUpdate(conversationId = "c-new", organizationId = "org-1", messageId = 3, messageSeq = 3, preview = "在吗"),
        )
        store.applyPersonalEvent(ev)
        store.applyPersonalEvent(ev) // 重复投递同一 messageId
        store.applyPersonalEvent(
            ImRealtimeEvent.ConversationNew(
                ImConversation(id = "c-new", organizationId = "org-1", type = ImConversationType.DM),
            ),
        )
        val c = store.conversations.value.first { it.id == "c-new" }
        assertEquals(1, c.unreadCount)
        assertEquals("在吗", c.lastMessagePreview)
    }

    @Test
    fun `conversation new inserts so badge appears without manual refresh`() {
        // 回归  issue 2：在线用户收到新 DM 时，im.conversation.new 应插入会话，
        // 随后第一条消息的 im.unread.update 才能命中并让聚合角标即时出现。
        val store = newStore()
        store.replaceConversationsForTesting(listOf(conversation("c-old", unread = 0)))

        store.applyPersonalEvent(
            ImRealtimeEvent.ConversationNew(
                ImConversation(id = "c-new", type = ImConversationType.DM, lastMessageAt = "2026-07-21T10:00:00Z"),
            ),
        )
        assertEquals("c-new", store.conversations.value.first().id)
        assertEquals(2, store.conversations.value.size)

        store.applyUnreadUpdate(newMessageUpdate("c-new", preview = "在吗"))
        val updated = store.conversations.value.first { it.id == "c-new" }
        assertEquals(1, updated.unreadCount)
        assertEquals("在吗", updated.lastMessagePreview)
        assertEquals(1, store.aggregateUnreadCount.value)
    }

    @Test
    fun `cross organization events do not pollute current org list or unread`() {
        // 回归 ：personal:{user} 是用户级频道、跨组织共用。用户当前停在 org-a，
        // org-b 新建含该用户的 DM 时，im.conversation.new / im.unread.update 携带 org-b，
        // 不得插入 org-a 列表、不得计入 org-a 聚合角标。
        val store = newStore()
        store.prepareOrganizationForTesting("org-a")
        store.replaceConversationsForTesting(listOf(conversation("a1", unread = 2)))

        store.applyPersonalEvent(
            ImRealtimeEvent.ConversationNew(
                ImConversation(
                    id = "b1",
                    organizationId = "org-b",
                    type = ImConversationType.DM,
                    lastMessageAt = "2026-07-21T10:00:00Z",
                ),
            ),
        )
        assertEquals(1, store.conversations.value.size)
        assertEquals(false, store.conversations.value.any { it.id == "b1" })

        store.applyUnreadUpdate(
            ImUnreadUpdate(conversationId = "b1", organizationId = "org-b", messageId = 1, preview = "hi"),
        )
        assertEquals(false, store.conversations.value.any { it.id == "b1" })
        assertEquals(2, store.aggregateUnreadCount.value)
    }

    @Test
    fun `external conversation uses participant directory for realtime filtering`() {
        val store = newStore()
        store.prepareOrganizationForTesting("org-peer")
        store.replaceConversationsForTesting(emptyList())

        store.applyPersonalEvent(
            ImRealtimeEvent.ConversationNew(
                ImConversation(
                    id = "external-1",
                    organizationId = "org-host",
                    participantOrganizationId = "org-peer",
                    directoryScopeId = "org-peer",
                    isExternal = true,
                    type = ImConversationType.GROUP,
                ),
            ),
        )
        assertEquals(listOf("external-1"), store.conversations.value.map { it.id })

        store.applyUnreadUpdate(
            ImUnreadUpdate(
                conversationId = "external-1",
                organizationId = "org-host",
                directoryScopeId = "org-peer",
                messageId = 9,
                messageSeq = 9,
                preview = "进展",
            ),
        )
        assertEquals(1, store.conversations.value.single().unreadCount)
        assertEquals("进展", store.conversations.value.single().lastMessagePreview)
    }

    @Test
    fun `unread before conversation new is buffered and replayed`() {
        // 回归 ：im.unread.update 与 im.conversation.new 是两条独立 outbox 记录、投递顺序不保证。
        // 未读先到时之前会被直接丢弃、会话插入后停留 unreadCount=0、首条消息漏角标。
        // 现在应缓存未读、在会话插入时回放。
        val store = newStore()
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting(emptyList())

        // 1) 首条消息未读先到（会话还不在列表）——缓存，不落地。
        store.applyUnreadUpdate(
            ImUnreadUpdate(conversationId = "c-new", organizationId = "org-1", messageId = 1, preview = "在吗"),
        )
        assertEquals(0, store.conversations.value.size)
        assertEquals(0, store.aggregateUnreadCount.value)

        // 2) 新会话摘要后到——插入时回放缓存的未读。
        store.applyPersonalEvent(
            ImRealtimeEvent.ConversationNew(
                ImConversation(
                    id = "c-new",
                    organizationId = "org-1",
                    type = ImConversationType.DM,
                    lastMessageAt = "2026-07-21T10:00:00Z",
                ),
            ),
        )
        val inserted = store.conversations.value.first { it.id == "c-new" }
        assertEquals(1, inserted.unreadCount)
        assertEquals("在吗", inserted.lastMessagePreview)
        assertEquals(1, store.aggregateUnreadCount.value)
    }

    @Test
    fun `buffered unread cleared on organization switch`() {
        // 缓存的未读随组织切换清空，避免跨组织串到新组织的会话上。
        val store = newStore()
        store.prepareOrganizationForTesting("org-a")
        store.applyUnreadUpdate(
            ImUnreadUpdate(conversationId = "c-x", organizationId = "org-a", messageId = 1, preview = "x"),
        )
        store.prepareOrganizationForTesting("org-b")
        store.applyPersonalEvent(
            ImRealtimeEvent.ConversationNew(
                ImConversation(id = "c-x", organizationId = "org-b", type = ImConversationType.DM),
            ),
        )
        assertEquals(0, store.conversations.value.first { it.id == "c-x" }.unreadCount)
    }

    @Test
    fun `conversation new is idempotent for existing conversation`() {
        val store = newStore()
        store.replaceConversationsForTesting(listOf(conversation("c1", unread = 3)))

        store.applyPersonalEvent(ImRealtimeEvent.ConversationNew(ImConversation(id = "c1")))

        assertEquals(1, store.conversations.value.size)
        assertEquals(3, store.conversations.value.first { it.id == "c1" }.unreadCount)
    }

    @Test
    fun `profile update refreshes direct message snapshot and revision`() {
        val store = newStore()
        store.prepareOrganizationForTesting("org-1")
        store.replaceConversationsForTesting(
            listOf(
                conversation("dm-1", unread = 0).copy(
                    organizationId = "org-1",
                    type = ImConversationType.DM,
                    dmPeerUserId = "user-2",
                    name = "旧昵称",
                    avatarUrl = "https://cdn.example/old.png",
                    memberCount = 2,
                ),
            ),
        )
        val previousRevision = store.profileRevision.value

        store.applyPersonalEvent(
            ImRealtimeEvent.UserProfileUpdated(
                ImUserProfileUpdated(
                    userId = "user-2",
                    nickname = "新昵称",
                    username = "alice",
                    avatar = "https://cdn.example/new.png",
                    avatarVersion = "8",
                    revision = 8,
                ),
            ),
        )

        assertEquals("新昵称", store.conversations.value.single().name)
        assertEquals("https://cdn.example/new.png", store.conversations.value.single().avatarUrl)
        assertEquals(previousRevision + 1, store.profileRevision.value)
    }
}
