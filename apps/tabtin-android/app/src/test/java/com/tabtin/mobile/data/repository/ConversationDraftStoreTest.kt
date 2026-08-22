package com.tabtin.mobile.data.repository

import android.content.Context
import com.tabtin.mobile.data.model.ConversationDraftScope
import com.tabtin.mobile.data.model.ConversationDraftSnapshot
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class ConversationDraftStoreTest {
    private lateinit var context: Context
    private lateinit var store: ConversationDraftStore

    @Before
    fun setUp() {
        context = RuntimeEnvironment.getApplication()
        context.deleteSharedPreferences(PREFERENCES_NAME)
        store = ConversationDraftStore(context)
    }

    @After
    fun tearDown() {
        context.deleteSharedPreferences(PREFERENCES_NAME)
    }

    @Test
    fun `drafts are isolated by organization workspace and project`() {
        val personal = ConversationDraftScope("org-a", "workspace-a")
        val project = ConversationDraftScope("org-a", "workspace-a", "project-a")
        store.save(snapshot(personal, "personal-draft"))
        store.save(snapshot(project, "project-draft"))

        assertEquals("personal-draft", store.load(personal)?.draftId)
        assertEquals("project-draft", store.load(project)?.draftId)
        assertNull(store.load(ConversationDraftScope("org-b", "workspace-a")))
    }

    @Test
    fun `resave keeps stable draft and message ids then consume only removes a matching draft`() {
        val scope = ConversationDraftScope("org", "workspace")
        val first = store.save(snapshot(scope, "stable-draft", "stable-message"))
        val updated = store.save(
            first.copy(
                draftId = "replacement-draft",
                clientEventId = "replacement-message",
                text = "updated text",
            ),
        )

        assertEquals("stable-draft", updated.draftId)
        assertEquals("stable-message", updated.clientEventId)
        assertEquals("updated text", store.load(scope)?.text)
        assertFalse(store.consume(scope, "replacement-draft"))
        assertTrue(store.consume(scope, "stable-draft"))
        assertNull(store.load(scope))
    }

    @Test
    fun `pending session can be recovered by session id`() {
        val scope = ConversationDraftScope("org", "workspace")
        val saved = store.save(snapshot(scope, "draft-session"))
        val pending = requireNotNull(store.markPendingSession(scope, saved.draftId, "server-session"))

        assertEquals("server-session", pending.pendingSessionId)
        assertEquals(saved.draftId, store.loadForSession("server-session")?.draftId)
        assertEquals(saved.draftId, store.loadForSession("draft-session")?.draftId)
    }

    @Test
    fun `save and load preserve frozen context tier and thinking mode`() {
        val scope = ConversationDraftScope("org", "workspace")
        store.save(
            snapshot(scope, "draft-runtime").copy(
                contextTierId = "long_1m",
                thinkingMode = "deep",
            ),
        )

        val restored = requireNotNull(store.load(scope))
        assertEquals("long_1m", restored.contextTierId)
        assertEquals("deep", restored.thinkingMode)

        val updated = store.save(
            restored.copy(
                text = "updated",
                contextTierId = "standard",
                thinkingMode = "standard",
            ),
        )
        assertEquals("standard", updated.contextTierId)
        assertEquals("standard", updated.thinkingMode)
        assertEquals("standard", store.load(scope)?.contextTierId)
        assertEquals("standard", store.load(scope)?.thinkingMode)
    }

    private fun snapshot(
        scope: ConversationDraftScope,
        draftId: String,
        clientEventId: String = "message-$draftId",
    ): ConversationDraftSnapshot = ConversationDraftSnapshot(
        draftId = draftId,
        clientEventId = clientEventId,
        scope = scope,
        text = "draft text",
        agentId = "agent-id",
        modelId = "model-id",
    )

    private companion object {
        private const val PREFERENCES_NAME = "tabtin_conversation_drafts"
    }
}
