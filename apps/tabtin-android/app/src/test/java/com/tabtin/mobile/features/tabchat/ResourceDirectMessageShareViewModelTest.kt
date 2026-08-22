package com.tabtin.mobile.features.tabchat

import android.util.Log
import com.tabtin.mobile.data.im.ImConversationDataPlane
import com.tabtin.mobile.data.im.ImConversationService
import com.tabtin.mobile.data.im.ImConversationStore
import com.tabtin.mobile.data.im.ImMessage
import com.tabtin.mobile.data.im.ImMessageTransport
import com.tabtin.mobile.data.im.ImOutgoingAttachment
import com.tabtin.mobile.data.im.ImOutgoingCard
import com.tabtin.mobile.data.im.ImResourceCardType
import com.tabtin.mobile.data.im.ImSendMessageResult
import com.tabtin.mobile.data.model.CloudDocsCollaborator
import com.tabtin.mobile.data.model.CloudDocsCollaboratorsResponse
import com.tabtin.mobile.data.model.CloudDocsOwner
import com.tabtin.mobile.data.model.MemberUser
import com.tabtin.mobile.data.model.OrganizationMember
import com.tabtin.mobile.data.model.OrganizationRole
import com.tabtin.mobile.data.repository.OrganizationRepository
import com.tabtin.mobile.data.repository.CloudDocsShareService
import com.tabtin.mobile.util.TokenManager
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import io.mockk.mockkStatic
import io.mockk.unmockkStatic
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ResourceDirectMessageShareViewModelTest {

    private val dispatcher = StandardTestDispatcher()

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        mockkStatic(Log::class)
        every { Log.i(any(), any()) } returns 0
        every { Log.w(any(), any<String>()) } returns 0
        every { Log.e(any(), any<String>(), any()) } returns 0
    }

    @After
    fun tearDown() {
        unmockkStatic(Log::class)
        Dispatchers.resetMain()
    }

    @Test
    fun `activate exposes organization human members except the current user`() = runTest(dispatcher) {
        val repository = mockk<OrganizationRepository>()
        coEvery { repository.loadMembers("org-1", null, null) } returns listOf(
            member("me", "Me"),
            member("zoe", "Zoe"),
            member("amy", "Amy"),
        )
        val viewModel = viewModel(repository = repository)

        viewModel.activate(documentResource())
        advanceUntilIdle()

        assertEquals(listOf("amy", "zoe"), viewModel.uiState.value.members.map { it.userId })
        assertTrue(viewModel.uiState.value.hasLoadedRecipients)
        assertFalse(viewModel.uiState.value.isLoading)
    }

    @Test
    fun `document and table resources reuse the existing outgoing card protocol`() {
        val document = documentResource()
        val table = ResourceDirectMessageResource(
            resourceType = ImResourceCardType.TABLE,
            resourceId = "table-1",
            name = "Roadmap",
            organizationId = "org-1",
            spaceId = null,
        )

        assertEquals(
            ImOutgoingCard.resource(
                type = ImResourceCardType.DOCUMENT,
                resourceId = "doc-1",
                name = "Plan",
                spaceId = "space-1",
                organizationId = "org-1",
            ),
            document.toOutgoingCard(),
        )
        assertEquals(ImResourceCardType.TABLE, table.toOutgoingCard().type)
        assertEquals("table-1", table.toOutgoingCard().requestPayload().resourceId)
    }

    @Test
    fun `failed send retries the same resource card with the same request id`() = runTest(dispatcher) {
        val repository = mockk<OrganizationRepository>()
        coEvery { repository.loadMembers("org-1", null, null) } returns listOf(member("amy", "Amy"))
        val service = mockk<ImConversationService>()
        coEvery { service.createOrGetDM("org-1", "amy") } returns "dm-1"
        val transport = RecordingTransport(failFirst = true)
        val viewModel = viewModel(
            repository = repository,
            conversationService = service,
            transport = transport,
        )

        viewModel.activate(documentResource())
        advanceUntilIdle()
        viewModel.selectRecipient("amy")
        viewModel.submit()
        advanceUntilIdle()

        assertEquals(ResourceDirectMessageSharePhase.FAILED, viewModel.uiState.value.phase)
        val requestId = transport.calls.single().clientRequestId
        assertEquals(ImResourceCardType.DOCUMENT, transport.calls.single().card?.type)

        viewModel.retrySend()
        runCurrent()

        assertEquals(ResourceDirectMessageSharePhase.SENT, viewModel.uiState.value.phase)
        assertEquals(listOf(requestId, requestId), transport.calls.map { it.clientRequestId })
        assertEquals(listOf(false, true), transport.calls.map { it.isRetry })
    }

    @Test
    fun `editing recipient search abandons a failed send attempt`() = runTest(dispatcher) {
        val repository = mockk<OrganizationRepository>()
        coEvery { repository.loadMembers("org-1", null, null) } returns listOf(member("amy", "Amy"))
        val service = mockk<ImConversationService>()
        coEvery { service.createOrGetDM("org-1", "amy") } returns "dm-1"
        val transport = RecordingTransport(failFirst = true)
        val viewModel = viewModel(
            repository = repository,
            conversationService = service,
            transport = transport,
        )

        viewModel.activate(documentResource())
        advanceUntilIdle()
        viewModel.selectRecipient("amy")
        viewModel.submit()
        advanceUntilIdle()
        assertEquals(ResourceDirectMessageSharePhase.FAILED, viewModel.uiState.value.phase)

        viewModel.setQuery("am")
        viewModel.retrySend()
        runCurrent()

        assertEquals(ResourceDirectMessageSharePhase.IDLE, viewModel.uiState.value.phase)
        assertEquals(null, viewModel.uiState.value.selectedUserId)
        assertEquals(1, transport.calls.size)
    }

    @Test
    fun `owner invitation failure sends no card and later retries keep one message identity`() =
        runTest(dispatcher) {
            val repository = mockk<OrganizationRepository>()
            coEvery { repository.loadMembers("org-1", null, null) } returns listOf(member("amy", "Amy"))
            val shareService = mockk<CloudDocsShareService>()
            coEvery { shareService.collaborators(any(), "doc-1") } returns collaborators()
            var invitationCalls = 0
            coEvery {
                shareService.inviteCollaborators(any(), "doc-1", listOf("amy"), "viewer")
            } coAnswers {
                invitationCalls += 1
                if (invitationCalls == 1) throw IllegalStateException("invite failed")
            }
            val conversationService = mockk<ImConversationService>()
            coEvery { conversationService.createOrGetDM("org-1", "amy") } returns "dm-1"
            val transport = RecordingTransport(failFirst = true)
            val viewModel = viewModel(
                repository = repository,
                cloudDocsShareService = shareService,
                conversationService = conversationService,
                transport = transport,
            )

            viewModel.activate(documentResource(currentUserRole = "owner"))
            advanceUntilIdle()
            viewModel.selectRecipient("amy")
            viewModel.submit()
            advanceUntilIdle()

            assertEquals(ResourceDirectMessageSharePhase.FAILED, viewModel.uiState.value.phase)
            assertTrue(transport.calls.isEmpty())
            coVerify(exactly = 0) { conversationService.createOrGetDM(any(), any()) }

            viewModel.retrySend()
            advanceUntilIdle()
            val requestId = transport.calls.single().clientRequestId

            viewModel.retrySend()
            runCurrent()

            assertEquals(ResourceDirectMessageSharePhase.SENT, viewModel.uiState.value.phase)
            assertEquals(2, invitationCalls)
            assertEquals(listOf(requestId, requestId), transport.calls.map { it.clientRequestId })
            coVerify(exactly = 2) { shareService.collaborators(any(), "doc-1") }
            coVerify(exactly = 1) { conversationService.createOrGetDM("org-1", "amy") }
        }

    @Test
    fun `owner skips invitation when recipient already has resource access`() = runTest(dispatcher) {
        val repository = mockk<OrganizationRepository>()
        coEvery { repository.loadMembers("org-1", null, null) } returns listOf(member("amy", "Amy"))
        val shareService = mockk<CloudDocsShareService>(relaxed = true)
        coEvery { shareService.collaborators(any(), "doc-1") } returns collaborators("amy")
        val conversationService = mockk<ImConversationService>()
        coEvery { conversationService.createOrGetDM("org-1", "amy") } returns "dm-1"
        val viewModel = viewModel(
            repository = repository,
            cloudDocsShareService = shareService,
            conversationService = conversationService,
        )

        viewModel.activate(documentResource(currentUserRole = "admin"))
        advanceUntilIdle()
        viewModel.selectRecipient("amy")
        viewModel.submit()
        runCurrent()

        assertEquals(ResourceDirectMessageSharePhase.SENT, viewModel.uiState.value.phase)
        coVerify(exactly = 0) {
            shareService.inviteCollaborators(any(), any(), any(), any())
        }
    }

    @Test
    fun `owner access lookup failure creates no conversation and sends no card`() = runTest(dispatcher) {
        val repository = mockk<OrganizationRepository>()
        coEvery { repository.loadMembers("org-1", null, null) } returns listOf(member("amy", "Amy"))
        val shareService = mockk<CloudDocsShareService>()
        coEvery {
            shareService.collaborators(any(), "doc-1")
        } throws IllegalStateException("access lookup failed")
        val conversationService = mockk<ImConversationService>()
        val transport = RecordingTransport()
        val viewModel = viewModel(
            repository = repository,
            cloudDocsShareService = shareService,
            conversationService = conversationService,
            transport = transport,
        )

        viewModel.activate(documentResource(currentUserRole = "owner"))
        advanceUntilIdle()
        viewModel.selectRecipient("amy")
        viewModel.submit()
        advanceUntilIdle()

        assertEquals(ResourceDirectMessageSharePhase.FAILED, viewModel.uiState.value.phase)
        assertTrue(transport.calls.isEmpty())
        coVerify(exactly = 0) {
            shareService.inviteCollaborators(any(), any(), any(), any())
        }
        coVerify(exactly = 0) { conversationService.createOrGetDM(any(), any()) }
    }

    private fun viewModel(
        repository: OrganizationRepository,
        cloudDocsShareService: CloudDocsShareService = mockk(relaxed = true),
        conversationService: ImConversationService = mockk(relaxed = true),
        transport: RecordingTransport = RecordingTransport(),
    ): ResourceDirectMessageShareViewModel {
        val tokenManager = mockk<TokenManager>()
        every { tokenManager.userId } returns "me"
        val dataPlane = mockk<ImConversationDataPlane>(relaxed = true)
        every { dataPlane.setConversationChangedListener(any()) } returns Unit
        return ResourceDirectMessageShareViewModel(
            organizationRepository = repository,
            cloudDocsShareService = cloudDocsShareService,
            conversationService = conversationService,
            conversationStore = ImConversationStore(dataPlane),
            messageTransport = transport,
            tokenManager = tokenManager,
        )
    }

    private fun documentResource(currentUserRole: String? = null): ResourceDirectMessageResource =
        ResourceDirectMessageResource(
            resourceType = ImResourceCardType.DOCUMENT,
            resourceId = "doc-1",
            name = "Plan",
            organizationId = "org-1",
            spaceId = "space-1",
            currentUserRole = currentUserRole,
        )

    private fun member(userId: String, name: String): OrganizationMember = OrganizationMember(
        id = "member-$userId",
        organizationId = "org-1",
        userId = userId,
        role = OrganizationRole.VIEWER,
        user = MemberUser(id = userId, nickname = name, username = userId),
    )

    private fun collaborators(existingUserId: String? = null): CloudDocsCollaboratorsResponse =
        CloudDocsCollaboratorsResponse(
            owner = CloudDocsOwner(userId = "owner"),
            collaborators = existingUserId?.let {
                listOf(CloudDocsCollaborator(userId = it, permission = "viewer"))
            }.orEmpty(),
        )

    private data class SendCall(
        val clientRequestId: String,
        val card: ImOutgoingCard?,
        val isRetry: Boolean,
    )

    private class RecordingTransport(private val failFirst: Boolean = false) : ImMessageTransport {
        val calls = mutableListOf<SendCall>()

        override suspend fun fetchMessages(
            conversationId: String,
            before: Int?,
            limit: Int,
        ): List<ImMessage> = emptyList()

        override suspend fun sendMessage(
            conversationId: String,
            content: String,
            messageType: Int,
            replyToId: Int?,
            mentionedUserIds: List<String>,
            mentionedAgentIds: List<String>,
            mentionAll: Boolean,
            attachment: ImOutgoingAttachment?,
            clientRequestId: String,
        ): ImSendMessageResult = error("card overload expected")

        override suspend fun sendMessage(
            conversationId: String,
            content: String,
            messageType: Int,
            replyToId: Int?,
            mentionedUserIds: List<String>,
            mentionedAgentIds: List<String>,
            mentionAll: Boolean,
            attachment: ImOutgoingAttachment?,
            card: ImOutgoingCard?,
            clientRequestId: String,
        ): ImSendMessageResult {
            val retry = calls.any { it.clientRequestId == clientRequestId }
            calls += SendCall(clientRequestId, card, retry)
            if (failFirst && calls.size == 1) throw IllegalStateException("offline")
            return ImSendMessageResult(
                id = calls.size,
                seq = calls.size,
                conversationId = conversationId,
            )
        }

        override suspend fun editMessage(
            conversationId: String,
            messageId: Int,
            content: String,
        ): ImMessage = error("unused")

        override suspend fun recallMessage(conversationId: String, messageId: Int): Unit = Unit
        override suspend fun addReaction(conversationId: String, messageId: Int, emoji: String): Unit = Unit
        override suspend fun removeReaction(conversationId: String, messageId: Int, emoji: String): Unit = Unit
        override suspend fun markRead(conversationId: String, lastMessageId: Int): Unit = Unit
    }
}
