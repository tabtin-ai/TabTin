package com.tabtin.mobile.data.im

import com.tabtin.mobile.data.model.ApiEnvelope
import com.tabtin.mobile.data.model.ChatSession
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

public class ImConversationServiceDjangoTest {
    @Test
    public fun `history visibility reads the Django personal watermark`() = runTest {
        val api = mockk<ImApi>()
        coEvery { api.historyState("conversation-1") } returns ApiEnvelope(
            success = true,
            data = ImHistoryState(historyClearedSeq = 42),
        )
        val adapter = DjangoImAdapter(api)

        val clearedThroughSeq = adapter.fetchHistoryClearedSeq("conversation-1")

        assertEquals(42, clearedThroughSeq)
        coVerify(exactly = 1) { api.historyState("conversation-1") }
    }

    @Test
    public fun `clear history preserves the authoritative Django watermark`() = runTest {
        val api = mockk<ImApi>()
        coEvery { api.clearHistory("conversation-1") } returns ApiEnvelope(
            success = true,
            data = ImClearHistoryResult(clearedSeq = 51),
        )
        val adapter = DjangoImAdapter(api)

        val clearedThroughSeq = adapter.clearHistoryAndFetchWatermark("conversation-1")

        assertEquals(51, clearedThroughSeq)
        coVerify(exactly = 1) { api.clearHistory("conversation-1") }
    }

    @Test
    public fun `conversation preferences send idempotent target state`() = runTest {
        val api = mockk<ImApi>()
        val pinBody = slot<SetConversationPinnedBody>()
        val muteBody = slot<SetConversationMutedBody>()
        coEvery {
            api.setConversationPinned("conversation-1", capture(pinBody))
        } returns ApiEnvelope(
            success = true,
            data = ImConversationPinResult(pinned = true),
        )
        coEvery {
            api.setConversationMuted("conversation-1", capture(muteBody))
        } returns ApiEnvelope(
            success = true,
            data = ImConversationMuteResult(muted = false),
        )
        val adapter = DjangoImAdapter(api)

        adapter.pinConversation("conversation-1", true)
        adapter.setConversationMuted("conversation-1", false)

        assertTrue(pinBody.captured.pinned)
        assertFalse(muteBody.captured.muted)
        coVerify(exactly = 1) { api.setConversationPinned("conversation-1", any()) }
        coVerify(exactly = 1) { api.setConversationMuted("conversation-1", any()) }
    }

    @Test
    public fun `history snapshots make empty reaction and pin state authoritative`() = runTest {
        val api = mockk<ImApi>()
        coEvery { api.getMessages("conversation-1", null, 31) } returns ApiEnvelope(
            success = true,
            data = listOf(
                ImMessage(
                    id = 7,
                    seq = 7,
                    conversationId = "conversation-1",
                    content = "hello",
                    isPinned = false,
                    reactions = emptyMap(),
                ),
            ),
        )
        val adapter = DjangoImAdapter(api)

        val message = adapter.fetchMessages("conversation-1", null, 31).single()

        assertTrue(message.pinStateKnown)
        assertTrue(message.reactionStateKnown)
    }

    @Test
    public fun `handoff repository uses self hosted domain routes for the full lifecycle`() = runTest {
        val api = mockk<ImApi>()
        val createBody = slot<ImHandoffCreateRequest>()
        val actionBody = slot<ImHandoffActionRequest>()
        val takeOverBody = slot<ImHandoffTakeOverRequest>()
        val detail = ImHandoffPackage(
            id = "handoff-1",
            conversationId = "conversation-1",
            organizationId = "org-1",
        )
        coEvery { api.createHandoff(capture(createBody)) } returns ApiEnvelope(success = true, data = detail)
        coEvery { api.getHandoff("handoff-1") } returns ApiEnvelope(success = true, data = detail)
        coEvery {
            api.actOnHandoff("handoff-1", capture(actionBody))
        } returns ApiEnvelope(success = true, data = detail)
        coEvery { api.revokeHandoff("handoff-1") } returns ApiEnvelope(success = true, data = detail)
        coEvery {
            api.takeOverHandoff("handoff-1", capture(takeOverBody))
        } returns ApiEnvelope(
            success = true,
            data = ChatSession(
                id = "session-1",
                organizationId = "org-1",
                workspaceId = "workspace-1",
            ),
        )
        val repository = ImHandoffRepository(api)

        repository.create(
            conversationId = "conversation-1",
            goal = "  完成交接  ",
            recipientIds = listOf("user-2", "user-2"),
            references = listOf(ImHandoffReferenceRequest("im_message", "42")),
        )
        repository.get("handoff-1")
        repository.act("handoff-1", "take_over", "  我来继续  ")
        repository.revoke("handoff-1")
        val session = repository.takeOver("handoff-1", "agent-1", "workspace-1")

        assertEquals("完成交接", createBody.captured.goal)
        assertEquals(listOf("user-2"), createBody.captured.recipients)
        assertEquals("take_over", actionBody.captured.action)
        assertEquals("我来继续", actionBody.captured.note)
        assertEquals("agent-1", takeOverBody.captured.agentId)
        assertEquals("workspace-1", takeOverBody.captured.workspaceId)
        assertEquals("session-1", session.id)
    }

    @Test
    public fun `external DM uses Django DM contract with contact identity`() = runTest {
        val api = mockk<ImApi>()
        val body = slot<CreateDMBody>()
        coEvery { api.createDM(capture(body)) } returns ApiEnvelope(
            success = true,
            data = ImCreateDMResult(conversationId = "dm-external"),
        )

        val conversationId = ImConversationService(api).createOrGetExternalDM(
            organizationId = "org-local",
            externalContactId = "contact-remote",
        )

        assertEquals("dm-external", conversationId)
        assertEquals("org-local", body.captured.organizationId)
        assertEquals("", body.captured.otherUserId)
        assertEquals("contact-remote", body.captured.externalContactId)
    }

    @Test
    public fun `adding external members uses Django member contract`() = runTest {
        val api = mockk<ImApi>()
        val body = slot<AddMembersBody>()
        coEvery { api.addMembers("conversation-1", capture(body)) } returns ApiEnvelope(
            success = true,
            data = ImAddMembersResult(addedExternalContactIds = listOf("contact-remote")),
        )

        val added = ImConversationService(api).addExternalMembers(
            conversationId = "conversation-1",
            externalContactIds = listOf("contact-remote"),
        )

        assertEquals(listOf("contact-remote"), added)
        assertEquals(emptyList<String>(), body.captured.memberIds)
        assertEquals(listOf("contact-remote"), body.captured.externalContactIds)
    }

    @Test
    public fun `external group uses Django group contract with separate member lists`() = runTest {
        val api = mockk<ImApi>()
        val body = slot<CreateGroupBody>()
        coEvery { api.createGroup(capture(body)) } returns ApiEnvelope(
            success = true,
            data = ImCreateDMResult(conversationId = "conv-external"),
        )
        val service = ImConversationService(api)

        val conversationId = service.createExternalGroup(
            organizationId = "org-host",
            name = "跨组织协作",
            memberIds = listOf("user-internal"),
            externalContactIds = listOf("contact-external"),
            clientRequestId = "request-1",
        )

        assertEquals("conv-external", conversationId)
        assertEquals("org-host", body.captured.organizationId)
        assertEquals(listOf("user-internal"), body.captured.memberIds)
        assertEquals(listOf("contact-external"), body.captured.externalContactIds)
        assertEquals("request-1", body.captured.clientRequestId)
        coVerify(exactly = 1) { api.createGroup(any()) }
    }

    @Test
    public fun `adding Agent uses binding contract with execution workspace`() = runTest {
        val api = mockk<ImApi>()
        val body = slot<BindConversationAgentBody>()
        coEvery { api.bindAgent("conversation-1", capture(body)) } returns ApiEnvelope(
            success = true,
            data = ImConversationAgentBinding(
                agentId = "agent-1",
                workspaceId = "workspace-1",
                isExecutable = true,
            ),
        )

        val binding = ImConversationService(api).bindAgent(
            conversationId = "conversation-1",
            agentId = "agent-1",
            workspaceId = "workspace-1",
        )

        assertEquals("agent-1", body.captured.agentId)
        assertEquals("workspace-1", body.captured.workspaceId)
        assertEquals("workspace-1", binding.workspaceId)
        coVerify(exactly = 1) { api.bindAgent("conversation-1", any()) }
    }

    @Test
    public fun `channel message Agent task uses Django contract and preserves navigation scope`() = runTest {
        val api = mockk<ImApi>()
        val body = slot<CreateAgentTaskFromMessageBody>()
        coEvery {
            api.createAgentTaskFromMessage("channel-1", 42, capture(body))
        } returns ApiEnvelope(
            success = true,
            data = ImAgentTaskThreadResult(
                sessionId = "session-1",
                projectId = "project-1",
                workspaceId = "workspace-1",
                organizationId = "org-1",
                defaultPrompt = "source context",
            ),
        )

        val result = ImConversationService(api).createAgentTaskFromMessage(
            conversationId = "channel-1",
            messageId = 42,
            agentId = "agent-1",
            additionalContext = "  focus on risks  ",
        )

        assertEquals("agent-1", body.captured.agentId)
        assertEquals("focus on risks", body.captured.additionalContext)
        assertEquals("workspace-1", result.workspaceId)
        assertEquals("project-1", result.projectId)
    }

    @Test
    public fun `member and Agent removal use Django management routes`() = runTest {
        val api = mockk<ImApi>()
        coEvery { api.removeMember("conversation-1", "user-2") } returns ApiEnvelope(success = true)
        coEvery { api.removeAgent("conversation-1", "agent-admin") } returns ApiEnvelope(success = true)
        coEvery { api.deleteAgentBinding("conversation-1", "agent-owned") } returns ApiEnvelope(success = true)
        val service = ImConversationService(api)

        service.removeMember("conversation-1", "user-2")
        service.removeAgent("conversation-1", "agent-admin")
        service.deleteAgentBinding("conversation-1", "agent-owned")

        coVerify(exactly = 1) { api.removeMember("conversation-1", "user-2") }
        coVerify(exactly = 1) { api.removeAgent("conversation-1", "agent-admin") }
        coVerify(exactly = 1) { api.deleteAgentBinding("conversation-1", "agent-owned") }
    }

    @Test
    public fun `conversation labels use transport neutral Django routes`() = runTest {
        val api = mockk<ImApi>()
        val createBody = slot<CreateConversationLabelBody>()
        val addBody = slot<AddConversationLabelsBody>()
        val label = ImConversationLabel(id = "label-1", name = "重要", color = "#ef4444")
        coEvery { api.createLabel(capture(createBody)) } returns ApiEnvelope(success = true, data = label)
        coEvery {
            api.addConversationLabels("conversation-1", capture(addBody))
        } returns ApiEnvelope(
            success = true,
            data = ImConversationLabelsResult("conversation-1", listOf(label)),
        )
        coEvery {
            api.removeConversationLabel("conversation-1", "label-1")
        } returns ApiEnvelope(
            success = true,
            data = ImConversationLabelsResult("conversation-1", emptyList()),
        )
        val repository = ImConversationLabelRepository(api)

        val created = repository.create("org-1", "  重要  ", "#ef4444")
        val assigned = repository.addToConversation("conversation-1", listOf("label-1"))
        val removed = repository.removeFromConversation("conversation-1", "label-1")

        assertEquals("重要", createBody.captured.name)
        assertEquals("org-1", createBody.captured.organizationId)
        assertEquals(listOf("label-1"), addBody.captured.labelIds)
        assertEquals(label, created)
        assertEquals(listOf(label), assigned)
        assertEquals(emptyList<ImConversationLabel>(), removed)
    }
}
