package com.tabtin.mobile.data.im

import com.tabtin.mobile.data.api.json
import com.tabtin.mobile.data.model.ApiEnvelope
import kotlinx.serialization.decodeFromString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ImModelsNaturalActionsTest {

    @Test
    fun `handoff card keeps a transport neutral locator and decodes authoritative detail`() {
        val message = json.decodeFromString<ImMessage>(
            """{
              "id":42,"seq":9,"conversation_id":"conversation-1","sender_id":"user-1",
              "message_type":1,"content":"[交接] 完成竞品分析",
              "metadata":{"card":{"type":"handoff","handoff_id":"handoff-1",
                "goal":"完成竞品分析","scope":"continuable","recipient_count":1}}
            }""",
        )
        val detail = json.decodeFromString<ImHandoffPackage>(
            """{
              "id":"handoff-1","conversation_id":"conversation-1","organization_id":"org-1",
              "goal":"完成竞品分析","progress":[{"text":"已收集资料"}],
              "next_steps":[{"text":"补充定价","checked":false}],
              "risks":[{"text":"来源待确认","high_risk":true}],
              "recipients":[{"user_id":"user-2","state":"viewed"}],
              "references":[{"id":"reference-1","ref_type":"im_message","resource_id":"42",
                "accessible":true,"source_link":{"conversation_id":"conversation-1","message_id":42}}]
            }""",
        )

        assertEquals("handoff-1", message.handoffCard?.handoffId)
        assertTrue(message.hasStructuredCard)
        assertFalse(message.isPlainText)
        assertTrue(message.isForwardRestrictedCard)
        assertEquals("已收集资料", detail.progress.single().text)
        assertEquals(true, detail.risks.single().highRisk)
        assertEquals(42, detail.references.single().sourceLink.messageId)
    }

    @Test
    fun `handoff detail preserves openable resources and frozen transcript attachments`() {
        val detail = json.decodeFromString<ImHandoffPackage>(
            """{
              "id":"handoff-1","conversation_id":"conversation-1","organization_id":"org-1",
              "references":[
                {"id":"doc-ref","ref_type":"document","resource_id":"doc-1","title":"方案",
                 "accessible":true,"source_link":{"organization_id":"org-1","space_id":"space-1"}},
                {"id":"session-ref","ref_type":"chat_session","resource_id":"session-1",
                 "accessible":true,"frozen_snapshot":{"title":"任务记录","message_count":2,
                 "turns":[{"role":"user","text":"继续分析","attachments":[
                   {"file_id":"file-1","filename":"brief.pdf","mime_type":"application/pdf"}
                 ]}]}}
              ]
            }""",
        )

        val document = detail.references.first()
        val transcript = detail.references.last().frozenSnapshot
        assertEquals("org-1", document.sourceLink.organizationId)
        assertEquals("space-1", document.sourceLink.spaceId)
        assertEquals("任务记录", transcript?.title)
        assertEquals("file-1", transcript?.turns?.single()?.attachments?.single()?.fileId)
    }

    @Test
    fun `conversation models decode external membership gate compatibly`() {
        val conversation = json.decodeFromString<ImConversation>(
            """{"id":"group-1","type":2,"member_count":2,"is_external":true}""",
        )
        val detail = json.decodeFromString<ImConversationDetail>(
            """{"id":"group-1","type":2,"member_count":2,"is_external":true}""",
        )
        val legacy = json.decodeFromString<ImConversation>(
            """{"id":"group-legacy","type":2,"member_count":2}""",
        )

        assertTrue(conversation.isExternal)
        assertTrue(detail.isExternal)
        assertFalse(legacy.isExternal)
    }

    @Test
    fun `legacy member shape still recognizes an Agent identity`() {
        val member = ImMember(userId = null, agentId = "agent-legacy")

        assertTrue(member.isAgent)
    }

    @Test
    fun `member model decodes external and Agent ownership metadata`() {
        val member = json.decodeFromString<ImMember>(
            """{
              "member_type":"agent",
              "agent_id":"agent-1",
              "owner_user_id":"owner-1",
              "owner_display_name":"沈庚涛",
              "is_execution_online":true,
              "is_external":true,
              "organization_name":"外部组织"
            }""",
        )

        assertEquals("owner-1", member.ownerUserId)
        assertEquals("沈庚涛", member.ownerDisplayName)
        assertEquals(true, member.isExecutionOnline)
        assertTrue(member.isExternal)
        assertEquals("外部组织", member.organizationName)
    }

    @Test
    fun `removed member dm is read only and filtered from forward targets`() {
        val stale = ImConversation(
            id = "dm-stale",
            organizationId = "org-1",
            type = ImConversationType.DM,
            memberCount = 1,
            dmPeerUserId = "user-2",
        )
        val active = ImConversation(
            id = "group-active",
            organizationId = "org-1",
            type = ImConversationType.GROUP,
            memberCount = 3,
        )

        assertTrue(stale.isRemovedMemberDirectMessage)
        assertFalse(stale.canReceiveMessages)
        assertEquals(listOf("group-active"), imForwardTargets(listOf(stale, active), "source").map { it.id })
    }

    @Test
    fun `external forward target requires plain text permission`() {
        val external = ImConversation(
            id = "external-group",
            organizationId = "org-1",
            type = ImConversationType.GROUP,
            memberCount = 3,
            isExternal = true,
        )

        assertTrue(imForwardTargets(listOf(external), "source").isEmpty())
        assertEquals(
            listOf("external-group"),
            imForwardTargets(listOf(external), "source", allowExternal = true).map { it.id },
        )
    }

    @Test
    fun `external conversation keeps host organization but uses participant directory and send gate`() {
        val conversation = ImConversation(
            id = "external",
            organizationId = "org-host",
            participantOrganizationId = "org-peer",
            directoryScopeId = "org-peer",
            isExternal = true,
            type = ImConversationType.GROUP,
            canSend = false,
        )

        assertEquals("org-host", conversation.organizationId)
        assertEquals("org-peer", conversation.directoryOrganizationId)
        assertTrue(isImConversationReadOnly(conversation, null))
    }

    @Test
    fun `resource card decodes authoritative navigation fields`() {
        val message = json.decodeFromString<ImMessage>(
            """
            {
              "id": 8, "seq": 8, "conversation_id": "conv-1", "sender_id": "user-2",
              "sender_type": "user", "content": "", "message_type": 1,
              "metadata": {"card": {
                "type": "table", "name": "项目数据",
                "resource_id": "10000000-0000-0000-0000-000000000001",
                "space_id": "20000000-0000-0000-0000-000000000002",
                "organization_id": "30000000-0000-0000-0000-000000000003",
                "hint_carrier_app_id": "tabdata"
              }}
            }
            """.trimIndent(),
        )

        val card = message.resourceCard
        assertNotNull(card)
        assertEquals(ImResourceCardType.TABLE, card?.type)
        assertEquals("10000000-0000-0000-0000-000000000001", card?.resourceId)
        assertEquals("20000000-0000-0000-0000-000000000002", card?.spaceId)
        assertEquals("30000000-0000-0000-0000-000000000003", card?.organizationId)
        assertEquals("tabdata", card?.hintCarrierAppId)
    }

    @Test
    fun `workspace cards keep their Space identity and reject missing locators`() {
        val workspace = json.decodeFromString<ImMessage>(
            """{"id":81,"message_type":1,"metadata":{"card":{
              "type":"space","space_id":" workspace-1 ","name":"研发 Workspace","icon":"🚀"
            }}}""",
        )
        val agentWorkspace = json.decodeFromString<ImMessage>(
            """{"id":82,"message_type":1,"metadata":{"card":{
              "type":"agent_space","space_id":"workspace-2","name":"数据助手"
            }}}""",
        )
        val missingSpaceId = json.decodeFromString<ImMessage>(
            """{"id":83,"message_type":1,"metadata":{"card":{
              "type":"space","space_id":"   ","name":"损坏卡片"
            }}}""",
        )

        assertEquals("workspace-1", workspace.resourceCard?.spaceCard?.spaceId)
        assertEquals("研发 Workspace", workspace.resourceCard?.spaceCard?.displayName)
        assertEquals("🚀", workspace.resourceCard?.spaceCard?.icon)
        assertEquals(ImResourceCardType.AGENT_SPACE, agentWorkspace.resourceCard?.type)
        assertEquals("workspace-2", agentWorkspace.resourceCard?.spaceCard?.spaceId)
        assertEquals(ImResourceCardType.SPACE, workspace.forwardableCard?.type)
        assertEquals("workspace-1", workspace.forwardableCard?.requestPayload()?.spaceId)
        assertEquals("研发 Workspace", workspace.forwardableCard?.toLocalCard()?.displayName)
        assertEquals("🚀", workspace.forwardableCard?.toLocalCard()?.icon)
        assertTrue(workspace.canForward)
        assertTrue(missingSpaceId.hasStructuredCard)
        assertNull(missingSpaceId.resourceCard)
        assertNull(missingSpaceId.forwardableCard)
        assertFalse(missingSpaceId.canForward)
    }

    @Test
    fun `resource card display name uses compatible title fields`() {
        val document = json.decodeFromString<ImMessage>(
            """
            {
              "id": 101, "seq": 101, "conversation_id": "conv-1", "sender_id": "user-2",
              "message_type": 1,
              "metadata": {"card": {"type": "document", "resource_id": "doc-1", "title": "云文档标题"}}
            }
            """.trimIndent(),
        )
        val table = json.decodeFromString<ImMessage>(
            """
            {
              "id": 102, "seq": 102, "conversation_id": "conv-1", "sender_id": "user-2",
              "message_type": 1,
              "metadata": {"card": {"type": "table", "resource_id": "table-1", "displayName": "客户表"}}
            }
            """.trimIndent(),
        )
        val contact = json.decodeFromString<ImMessage>(
            """
            {
              "id": 103, "seq": 103, "conversation_id": "conv-1", "sender_id": "user-2",
              "message_type": 1,
              "metadata": {"card": {"type": "contact", "user_id": "user-1", "display_name": "沈庾涛", "username": "syt"}}
            }
            """.trimIndent(),
        )

        assertEquals("云文档标题", document.resourceCard?.displayName)
        assertEquals("客户表", table.resourceCard?.displayName)
        assertEquals("沈庾涛", contact.resourceCard?.displayName)

        val fileNamedDocument = json.decodeFromString<ImMessage>(
            """
            {
              "id": 104, "seq": 104, "conversation_id": "conv-1", "sender_id": "user-2",
              "message_type": 1,
              "metadata": {"card": {"type": "document", "resource_id": "doc-2", "file_name": "会议纪要"}}
            }
            """.trimIndent(),
        )
        assertEquals("会议纪要", fileNamedDocument.resourceCard?.displayName)
    }

    @Test
    fun `resource card display name falls back to specific type`() {
        val document = json.decodeFromString<ImResourceCard>(
            """{"type":"document","resource_id":"doc-1"}""",
        )
        val table = json.decodeFromString<ImResourceCard>(
            """{"type":"table","resource_id":"table-1"}""",
        )
        val contact = json.decodeFromString<ImResourceCard>(
            """{"type":"contact","user_id":"user-1"}""",
        )

        assertEquals("云文档", document.displayName)
        assertEquals("表格", table.displayName)
        assertEquals("用户", contact.displayName)
    }

    @Test
    fun `resource card display name uses message content fallback`() {
        val contact = json.decodeFromString<ImMessage>(
            """
            {
              "id": 105, "seq": 105, "conversation_id": "conv-1", "sender_id": "user-2",
              "content": "[名片] 童俊芳",
              "message_type": 1,
              "metadata": {"card": {"type": "contact", "user_id": "user-1"}}
            }
            """.trimIndent(),
        )
        val document = json.decodeFromString<ImMessage>(
            """
            {
              "id": 106, "seq": 106, "conversation_id": "conv-1", "sender_id": "user-2",
              "content": "[文档] 未命名",
              "message_type": 1,
              "metadata": {"card": {"type": "document", "resource_id": "doc-1"}}
            }
            """.trimIndent(),
        )

        assertEquals("童俊芳", contact.resourceCardDisplayName)
        assertEquals("未命名", document.resourceCardDisplayName)
    }

    @Test
    fun `resource card opens organization-only resources without a Space`() {
        val card = json.decodeFromString<ImResourceCard>(
            """{"type":"document","resource_id":"doc-1","organization_id":"org-card","space_id":null}""",
        )

        val target = card.resolveOpenTarget(conversationOrganizationId = "org-conversation")

        assertEquals("tabdoc", target?.resourceType)
        assertEquals("doc-1", target?.resourceId)
        assertEquals("org-card", target?.organizationId)
        assertNull(target?.spaceId)
    }

    @Test
    fun `historical resource card falls back to its conversation Organization`() {
        val card = json.decodeFromString<ImResourceCard>(
            """{"type":"table","resource_id":"table-1","space_id":"space-1"}""",
        )

        val target = card.resolveOpenTarget(conversationOrganizationId = "org-conversation")

        assertEquals("tabdata", target?.resourceType)
        assertEquals("org-conversation", target?.organizationId)
        assertEquals("space-1", target?.spaceId)

        val previewTarget = card.resolveOpenTarget(
            conversationOrganizationId = "org-conversation",
            preview = ImResourceCardPreview(
                name = "权威表格",
                spaceId = null,
                organizationId = "org-preview",
                currentUserRole = "viewer",
            ),
        )
        assertEquals("org-preview", previewTarget?.organizationId)
        assertNull(previewTarget?.spaceId)

        val legacyTarget = card.resolveOpenTarget(
            conversationOrganizationId = "org-conversation",
            preview = ImResourceCardPreview(
                name = "缺少组织的预览",
                spaceId = "space-preview",
                organizationId = " ",
                currentUserRole = "viewer",
            ),
        )
        assertEquals("org-conversation", legacyTarget?.organizationId)
        assertEquals("space-1", legacyTarget?.spaceId)

        val incomplete = json.decodeFromString<ImResourceCard>(
            """{"type":"document","organization_id":"org-card"}""",
        )
        assertNull(incomplete.resolveOpenTarget(conversationOrganizationId = "org-conversation"))
    }

    @Test
    fun `prompt card remains structured and exposes reusable instruction`() {
        val message = json.decodeFromString<ImMessage>(
            """
            {
              "id": 9, "seq": 9, "conversation_id": "conv-1", "sender_id": "user-2",
              "content": "[指令] 整理本周进展", "message_type": 1,
              "metadata": {"card": {
                "type": "prompt", "title": "整理本周进展",
                "prompt_text": "整理本周进展\n列出风险和下一步。", "prompt_version": 1
              }}
            }
            """.trimIndent(),
        )

        assertTrue(message.hasStructuredCard)
        assertFalse(message.isPlainText)
        assertEquals("整理本周进展", message.promptCard?.displayTitle)
        assertEquals("整理本周进展\n列出风险和下一步。", message.promptCard?.promptText)
    }

    @Test
    fun `forwardable cards keep their structured payload`() {
        val table = json.decodeFromString<ImMessage>(
            """
            {
              "id": 20, "message_type": 1, "content": "[表格] 项目任务清单",
              "metadata": {"card": {
                "type": "table", "resource_id": "table-1", "name": "项目任务清单",
                "space_id": "space-1", "organization_id": "org-1"
              }}
            }
            """.trimIndent(),
        )
        val contact = json.decodeFromString<ImMessage>(
            """
            {
              "id": 21, "message_type": 1, "content": "[名片] 童俊芳",
              "metadata": {"card": {
                "type": "contact", "user_id": "user-3", "name": "童俊芳",
                "username": "tongjunfang", "avatar": "https://example.com/avatar.png"
              }}
            }
            """.trimIndent(),
        )

        assertEquals(ImResourceCardType.TABLE, table.forwardableCard?.type)
        assertEquals("table-1", table.forwardableCard?.requestPayload()?.resourceId)
        assertEquals(ImResourceCardType.CONTACT, contact.forwardableCard?.type)
        assertEquals("user-3", contact.forwardableCard?.requestPayload()?.userId)
    }

    @Test
    fun `restricted and unknown cards never produce forward payload`() {
        val sessionShareV2 = json.decodeFromString<ImMessage>(
            """{"id":22,"message_type":1,"content":"[共享任务] 新任务","metadata":{"card":{"type":"session_share_v2","object_id":"share-1"}}}""",
        )
        val unknown = json.decodeFromString<ImMessage>(
            """{"id":23,"message_type":1,"content":"[未知卡片]","metadata":{"card":{"type":"future_card","object_id":"object-1"}}}""",
        )

        assertTrue(sessionShareV2.isForwardRestrictedCard)
        assertNull(sessionShareV2.forwardableCard)
        assertNull(unknown.forwardableCard)
        assertFalse(sessionShareV2.canForward)
        assertFalse(unknown.canForward)
    }

    @Test
    fun `codex session card exposes downloadable session metadata`() {
        val message = json.decodeFromString<ImMessage>(
            """
            {
              "id": 231, "message_type": 3, "has_attachment": true,
              "content": "[Codex 会话] 排查 IM",
              "metadata": {
                "file_id": "file-codex-1", "file_name": "session.zip", "file_size": 2048,
                "card": {
                  "type": "codex_session", "schema_version": 1,
                  "codex_session_id": " session-1 ",
                  "codex_session_name": " 排查 IM ",
                  "suggested_working_directory": " /workspace/tabtin "
                }
              }
            }
            """.trimIndent(),
        )

        assertEquals("session-1", message.codexSessionCard?.sessionId)
        assertEquals("排查 IM", message.codexSessionCard?.sessionName)
        assertEquals("/workspace/tabtin", message.codexSessionCard?.suggestedWorkingDirectory)
        assertTrue(message.isFileAttachment)
        assertFalse(message.isForwardRestrictedCard)
        assertEquals("codex_session", message.forwardableCard?.requestPayload()?.type)
        assertEquals(1, message.forwardableCard?.requestPayload()?.schemaVersion)
        assertEquals("session-1", message.forwardableCard?.requestPayload()?.codexSessionId)
        assertEquals("排查 IM", message.forwardableCard?.requestPayload()?.codexSessionName)
        assertEquals(
            "/workspace/tabtin",
            message.forwardableCard?.requestPayload()?.suggestedWorkingDirectory,
        )
    }

    @Test
    fun `codex session card rejects future schema and incomplete payloads`() {
        val future = json.decodeFromString<ImMessage>(
            """{"id":232,"message_type":3,"metadata":{"card":{
              "type":"codex_session","schema_version":2,
              "codex_session_id":"session-1","codex_session_name":"排查 IM"}}}""",
        )
        val incomplete = json.decodeFromString<ImMessage>(
            """{"id":233,"message_type":3,"metadata":{"card":{
              "type":"codex_session","schema_version":1,
              "codex_session_id":"session-1","codex_session_name":"   "}}}""",
        )

        assertNull(future.codexSessionCard)
        assertNull(incomplete.codexSessionCard)
        assertNull(future.forwardableCard)
        assertNull(incomplete.forwardableCard)
        assertTrue(future.hasStructuredCard)
        assertTrue(incomplete.hasStructuredCard)
    }

    @Test
    fun `session share v2 decodes a collaboration snapshot`() {
        val message = json.decodeFromString<ImMessage>(
            """
            {
              "id": 24, "seq": 24, "conversation_id": "conv-1", "sender_id": "user-1",
              "content": "[共享任务] 创建表格和文档", "message_type": 1,
              "metadata": {"card": {
                "type": "session_share_v2", "schema_version": 1, "version": 3,
                "object_id": " share-24 ", "title_snapshot": " 创建表格和文档 ",
                "sender_id": " user-1 ", "recipient_id": " user-2 "
              }}
            }
            """.trimIndent(),
        )

        val card = message.sessionShareV2Card

        assertNotNull(card)
        assertEquals("share-24", card?.objectId)
        assertEquals("创建表格和文档", card?.title)
        assertEquals("user-1", card?.senderId)
        assertEquals("user-2", card?.recipientId)
        assertEquals(3, card?.version)
        assertTrue(message.isForwardRestrictedCard)
        assertNull(message.sessionShareCard)
        assertNull(message.forwardableCard)
    }

    @Test
    fun `session continuation decodes only the locator and keeps frozen context authoritative`() {
        val message = json.decodeFromString<ImMessage>(
            """
            {
              "id": 27, "seq": 27, "conversation_id": "conv-1", "sender_id": "user-1",
              "content": "[任务续接] 创建表格和文档", "message_type": 1,
              "metadata": {"card": {
                "type": "session_continuation", "schema_version": 1, "version": 4,
                "object_id": " continuation-27 ", "title_snapshot": " 创建表格和文档 ",
                "sender_id": " user-1 ", "recipient_id": " user-2 ",
                "frozen_context": [{"role":"user","content":"must not decode"}]
              }}
            }
            """.trimIndent(),
        )

        val card = message.sessionContinuationCard

        assertNotNull(card)
        assertEquals("continuation-27", card?.objectId)
        assertEquals("创建表格和文档", card?.title)
        assertEquals(4, card?.version)
        assertTrue(message.isForwardRestrictedCard)
        assertNull(message.forwardableCard)
    }

    @Test
    fun `session continuation detail decodes creation target without source transcript`() {
        val detail = json.decodeFromString<ImSessionContinuationDetail>(
            """
            {
              "object_id": "continuation-27", "version": 5, "role": "recipient",
              "title_snapshot": "创建表格和文档", "context_status": "truncated",
              "snapshot_turn_count": 18, "resource_status": "partial",
              "resources": [{"label":"需求文档","unavailable":true,"reason":"需要原资源权限"}],
              "delivery_status": "confirmed", "creation_status": "created",
              "linked_session_id": "session-new", "target_workspace_id": "workspace-1",
              "organization_id": "org-1", "eligibility": {"can_create": true, "reason": ""},
              "created_at": "2026-08-17T00:00:00Z", "updated_at": "2026-08-17T00:01:00Z"
            }
            """.trimIndent(),
        )

        assertEquals("session-new", detail.linkedSessionId)
        assertEquals("workspace-1", detail.targetWorkspaceId)
        assertEquals(18, detail.snapshotTurnCount)
        assertTrue(detail.resources.single().unavailable)
    }

    @Test
    fun `session share v2 request derives collaboration fork and view access modes`() {
        val collaboration = ImSessionShareRequest(
            sessionId = "session-1",
            granteeUserId = "user-2",
            canFork = false,
            canChat = true,
        )
        val fork = ImSessionShareRequest(
            sessionId = "session-1",
            granteeUserId = "user-2",
            canFork = true,
            canChat = false,
        )
        val view = ImSessionShareRequest(
            sessionId = "session-1",
            granteeUserId = "user-2",
            canFork = false,
            canChat = false,
        )

        assertEquals(ImResourceCardType.SESSION_SHARE_V2, fork.cardContract)
        assertEquals("collaborate", collaboration.accessMode)
        assertEquals("fork", fork.accessMode)
        assertEquals("view", view.accessMode)
    }

    @Test
    fun `session share v2 detail projects to the existing shared session viewer card`() {
        val detail = json.decodeFromString<ImSessionShareV2Detail>(
            """
            {
              "id": "share-24", "session_id": "session-1", "session_title": "创建表格和文档",
              "owner_user_id": "user-1", "grantee_user_id": "user-2",
              "can_fork": true, "can_chat": false, "status": "active",
              "owner_display_name": "沈庾涛", "grantee_display_name": "Alex",
              "card_contract": "session_share_v2", "version": 4,
              "role": "recipient", "phase": "activeView", "access_mode": "fork",
              "actions": {"can_join": false, "can_open": true, "can_stop": false, "can_restore": false, "can_change_access": false}
            }
            """.trimIndent(),
        )

        val card = detail.toCardSnapshot()

        assertEquals("share-24", card.shareId)
        assertEquals("session-1", card.sessionId)
        assertEquals("创建表格和文档", card.displayTitle)
        assertEquals("user-1", card.ownerUserId)
        assertEquals("user-2", card.granteeUserId)
        assertTrue(card.canFork)
        assertEquals("active", card.normalizedStatus)
        assertTrue(detail.actions?.canOpen == true)
    }

    @Test
    fun `session share v2 detail accepts null session id before join and after stop`() {
        val detail = json.decodeFromString<ImSessionShareV2Detail>(
            """
            {
              "id": "share-stopped", "session_id": null, "session_title": "测试桩体",
              "owner_user_id": "user-1", "grantee_user_id": "user-2",
              "status": "revoked", "card_contract": "session_share_v2", "version": 4,
              "role": "recipient", "phase": "stopped", "access_mode": "view",
              "actions": {"can_join": false, "can_open": false, "can_stop": false, "can_restore": false, "can_change_access": false}
            }
            """.trimIndent(),
        )

        assertNull(detail.sessionId)
        assertEquals("stopped", detail.phase)
        assertEquals("revoked", detail.toCardSnapshot().normalizedStatus)
        assertEquals("", detail.toCardSnapshot().sessionId)
    }

    @Test
    fun `session share v2 rejects future schemas and incomplete snapshots`() {
        val futureSchema = json.decodeFromString<ImMessage>(
            """
            {
              "id": 25, "message_type": 1,
              "metadata": {"card": {
                "type": "session_share_v2", "schema_version": 2, "version": 1,
                "object_id": "share-25", "title_snapshot": "新协议",
                "sender_id": "user-1", "recipient_id": "user-2"
              }}
            }
            """.trimIndent(),
        )
        val missingRecipient = json.decodeFromString<ImMessage>(
            """
            {
              "id": 26, "message_type": 1,
              "metadata": {"card": {
                "type": "session_share_v2", "schema_version": 1, "version": 1,
                "object_id": "share-26", "title_snapshot": "缺少参与人",
                "sender_id": "user-1"
              }}
            }
            """.trimIndent(),
        )

        assertNull(futureSchema.sessionShareV2Card)
        assertTrue(futureSchema.hasStructuredCard)
        assertNull(missingRecipient.sessionShareV2Card)
        assertTrue(missingRecipient.hasStructuredCard)
    }

    @Test
    fun `session share card decodes and stays forward restricted`() {
        val message = json.decodeFromString<ImMessage>(
            """
            {
              "id": 12, "seq": 12, "conversation_id": "conv-1", "sender_id": "owner-1",
              "content": "[共享任务] 新任务", "message_type": 1,
              "metadata": {"card": {
                "type": "session_share",
                "share_id": "share-1",
                "session_id": "session-1",
                "session_title": "新任务",
                "owner_user_id": "owner-1",
                "grantee_user_id": "user-2",
                "can_fork": true,
                "can_chat": false,
                "status": "active"
              }}
            }
            """.trimIndent(),
        )

        val card = message.sessionShareCard
        assertNotNull(card)
        assertTrue(message.hasStructuredCard)
        assertTrue(message.isForwardRestrictedCard)
        assertNull(message.resourceCard)
        assertEquals("share-1", card?.shareId)
        assertEquals("session-1", card?.sessionId)
        assertEquals("新任务", card?.displayTitle)
        assertEquals("查看并创建副本", card?.permissionLabel)
    }

    @Test
    fun `api envelope decodes numeric code as string`() {
        val envelope = json.decodeFromString<ApiEnvelope<Unit>>(
            """{"success":false,"message":"forbidden","code":403}""",
        )

        assertEquals("403", envelope.code)
    }

    @Test
    fun `unknown and malformed cards never become editable plain text`() {
        val unknown = json.decodeFromString<ImMessage>(
            """{"id":10,"message_type":1,"content":"[交接]","metadata":{"card":{"type":"handoff","scope":"private"}}}""",
        )
        val malformed = json.decodeFromString<ImMessage>(
            """{"id":11,"message_type":1,"content":"[卡片]","metadata":{"card":["not","an","object"]}}""",
        )

        assertTrue(unknown.hasStructuredCard)
        assertEquals("handoff", unknown.metadata?.cardType)
        assertNull(unknown.resourceCard)
        assertFalse(unknown.isPlainText)
        assertTrue(unknown.isForwardRestrictedCard)

        assertTrue(malformed.hasStructuredCard)
        assertNull(malformed.metadata?.cardType)
        assertNull(malformed.resourceCard)
        assertFalse(malformed.isPlainText)
        assertFalse(malformed.isForwardRestrictedCard)
    }

    @Test
    fun `create dm response decodes conversation id`() {
        val result = json.decodeFromString<ImCreateDMResult>("""{"conversation_id":"dm-123"}""")
        assertEquals("dm-123", result.conversationId)
    }
}
