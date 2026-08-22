package com.tabtin.mobile.data.repository

import android.content.Context
import com.tabtin.mobile.data.model.ActionLabel
import com.tabtin.mobile.data.model.AppError
import com.tabtin.mobile.data.model.ChatSession
import com.tabtin.mobile.data.model.ConversationDraftScope
import com.tabtin.mobile.data.model.ConversationDraftSnapshot
import com.tabtin.mobile.data.model.ConversationRuntimeConfiguration
import com.tabtin.mobile.data.model.Space
import com.tabtin.mobile.data.model.SwitchContextTierResponse
import com.tabtin.mobile.data.model.UpdateModelParamsResponse
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class ConversationDraftSessionCoordinatorTest {
    private lateinit var context: Context
    private lateinit var store: ConversationDraftStore
    private lateinit var chatRepository: ChatRepository
    private lateinit var llmRepository: LlmRepository
    private lateinit var coordinator: ConversationDraftSessionCoordinator

    @Before
    fun setUp() {
        context = RuntimeEnvironment.getApplication()
        context.deleteSharedPreferences(PREFERENCES_NAME)
        store = ConversationDraftStore(context)
        chatRepository = mockk()
        llmRepository = mockk(relaxed = true)
        coordinator = ConversationDraftSessionCoordinator(store, chatRepository, llmRepository)
    }

    @After
    fun tearDown() {
        context.deleteSharedPreferences(PREFERENCES_NAME)
    }

    @Test
    fun `prepareSession saves frozen runtime settings then flushes to session APIs`() = runBlocking {
        val scope = ConversationDraftScope("org-1", "workspace-1")
        val space = Space(
            id = "workspace-1",
            organizationId = "org-1",
            name = "Workspace",
            type = "workspace",
        )
        val modelId = "00000000-0000-0000-0000-0000000000aa"
        val agentId = "00000000-0000-0000-0000-0000000000bb"
        val session = ChatSession(
            id = "00000000-0000-0000-0000-0000000000cc",
            organizationId = "org-1",
            agentId = agentId,
            currentModelId = modelId,
        )
        coEvery {
            chatRepository.createSession(
                space = space,
                agentId = agentId,
                projectId = null,
                sessionId = any(),
                modelId = modelId,
                runtimeConfiguration = any(),
            )
        } returns session
        coEvery {
            chatRepository.switchContextTier(session.id, "long_1m")
        } returns SwitchContextTierResponse(
            success = true,
            sessionId = session.id,
            currentTierId = "long_1m",
        )
        coEvery {
            chatRepository.updateModelParams(
                sessionId = session.id,
                thinkingMode = "deep",
                preserving = null,
            )
        } returns UpdateModelParamsResponse(
            success = true,
            sessionId = session.id,
        )

        val prepared = coordinator.prepareSession(
            executionSpace = space,
            input = ConversationDraftInput(
                scope = scope,
                agentId = agentId,
                text = "画一张图",
                modelId = modelId,
                runtimeConfiguration = ConversationRuntimeConfiguration(),
                contextTierId = "long_1m",
                thinkingMode = "deep",
            ),
        )

        val saved = requireNotNull(store.load(scope))
        assertEquals("long_1m", saved.contextTierId)
        assertEquals("deep", saved.thinkingMode)
        assertEquals(prepared.draft.draftId, saved.draftId)
        assertEquals(session.id, prepared.draft.pendingSessionId)

        coVerify(exactly = 1) { chatRepository.switchContextTier(session.id, "long_1m") }
        coVerify(exactly = 1) {
            chatRepository.updateModelParams(
                sessionId = session.id,
                thinkingMode = "deep",
                preserving = null,
            )
        }
    }

    @Test
    fun `prepareSession preserves previously frozen runtime settings when input omits them`() = runBlocking {
        val scope = ConversationDraftScope("org-1", "workspace-1")
        val space = Space(
            id = "workspace-1",
            organizationId = "org-1",
            name = "Workspace",
            type = "workspace",
        )
        val modelId = "00000000-0000-0000-0000-0000000000aa"
        val agentId = "00000000-0000-0000-0000-0000000000bb"
        store.save(
            ConversationDraftSnapshot(
                draftId = "00000000-0000-0000-0000-0000000000dd",
                scope = scope,
                text = "旧草稿",
                agentId = agentId,
                modelId = modelId,
                contextTierId = "long_1m",
                thinkingMode = "deep",
            ),
        )
        val session = ChatSession(
            id = "00000000-0000-0000-0000-0000000000cc",
            organizationId = "org-1",
        )
        coEvery {
            chatRepository.createSession(any(), any(), any(), any(), any(), any())
        } returns session
        coEvery { chatRepository.switchContextTier(any(), any()) } returns SwitchContextTierResponse()
        coEvery {
            chatRepository.updateModelParams(any(), any(), any())
        } returns UpdateModelParamsResponse()

        coordinator.prepareSession(
            executionSpace = space,
            input = ConversationDraftInput(
                scope = scope,
                agentId = agentId,
                text = "新正文",
                modelId = modelId,
            ),
        )

        val saved = requireNotNull(store.load(scope))
        assertEquals("long_1m", saved.contextTierId)
        assertEquals("deep", saved.thinkingMode)
        coVerify { chatRepository.switchContextTier(session.id, "long_1m") }
        coVerify {
            chatRepository.updateModelParams(
                sessionId = session.id,
                thinkingMode = "deep",
                preserving = null,
            )
        }
    }

    @Test
    fun `prepareSession rotates draftId after createSession CONFLICT`() = runBlocking {
        val scope = ConversationDraftScope("org-1", "workspace-1")
        val space = Space(
            id = "workspace-1",
            organizationId = "org-1",
            name = "Workspace",
            type = "workspace",
        )
        val modelId = "00000000-0000-0000-0000-0000000000aa"
        val agentId = "00000000-0000-0000-0000-0000000000bb"
        val originalDraftId = "00000000-0000-0000-0000-0000000000dd"
        store.save(
            ConversationDraftSnapshot(
                draftId = originalDraftId,
                scope = scope,
                text = "画一张图",
                agentId = agentId,
                modelId = modelId,
            ),
        )
        val session = ChatSession(
            id = "00000000-0000-0000-0000-0000000000ee",
            organizationId = "org-1",
            agentId = agentId,
            currentModelId = modelId,
        )
        var createCalls = 0
        coEvery {
            chatRepository.createSession(
                space = space,
                agentId = agentId,
                projectId = null,
                sessionId = any(),
                modelId = modelId,
                runtimeConfiguration = any(),
            )
        } answers {
            createCalls += 1
            if (createCalls == 1) {
                throw AppError.ActionFailed(
                    ActionLabel.CREATE_SESSION,
                    "[CONFLICT] session_id 与既有会话的创建配置不一致，不能复用或覆盖",
                )
            }
            session
        }

        val prepared = coordinator.prepareSession(
            executionSpace = space,
            input = ConversationDraftInput(
                scope = scope,
                agentId = agentId,
                text = "画一张图",
                modelId = modelId,
            ),
        )

        assertEquals(2, createCalls)
        assertNotEquals(originalDraftId, prepared.draft.draftId)
        assertEquals(session.id, prepared.draft.pendingSessionId)
        assertEquals(prepared.draft.draftId, store.load(scope)?.draftId)
    }

    private companion object {
        private const val PREFERENCES_NAME = "tabtin_conversation_drafts"
    }
}
