package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.ApprovalActionRequest
import com.tabtin.mobile.data.model.AskFormField
import com.tabtin.mobile.data.model.AskFormOption
import com.tabtin.mobile.data.model.AskFormRequest
import com.tabtin.mobile.data.model.AskUserOption
import com.tabtin.mobile.data.model.AskUserQuestion
import com.tabtin.mobile.data.model.RequestApprovalRequest
import com.tabtin.mobile.data.model.HitlResolutionAccess
import com.tabtin.mobile.data.model.PendingInteraction
import com.tabtin.mobile.data.model.StreamEvent
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CapsuleInteractionBubblePolicyTest {
    @Test
    fun `team HITL access is owner only and malformed metadata fails closed`() {
        val personal = HitlResolutionAccess.resolve(JsonObject(emptyMap()), currentUserId = null)
        assertTrue(personal.canResolve)

        val teamPayload = JsonObject(
            mapOf(
                "team_space_execution" to JsonObject(
                    mapOf(
                        "execution_owner_user_id" to JsonPrimitive("owner-1"),
                        "execution_owner_display_name" to JsonPrimitive("小 Tin"),
                    ),
                ),
            ),
        )
        val owner = HitlResolutionAccess.resolve(teamPayload, currentUserId = "owner-1")
        val member = HitlResolutionAccess.resolve(teamPayload, currentUserId = "member-1")
        val signedOut = HitlResolutionAccess.resolve(teamPayload, currentUserId = null)
        assertTrue(owner.canResolve)
        assertEquals("小 Tin", owner.executionOwnerDisplayName)
        assertFalse(member.canResolve)
        assertFalse(signedOut.canResolve)

        val malformed = HitlResolutionAccess.resolve(
            JsonObject(mapOf("team_space_execution" to JsonPrimitive("corrupt"))),
            currentUserId = "owner-1",
        )
        val blankOwner = HitlResolutionAccess.resolve(
            JsonObject(
                mapOf(
                    "team_space_execution" to JsonObject(
                        mapOf("execution_owner_user_id" to JsonPrimitive("  ")),
                    ),
                ),
            ),
            currentUserId = "owner-1",
        )
        val enrichmentFailed = HitlResolutionAccess.resolve(
            JsonObject(
                mapOf("__team_space_execution_redaction_required" to JsonPrimitive(true)),
            ),
            currentUserId = "owner-1",
        )
        assertFalse(malformed.canResolve)
        assertFalse(blankOwner.canResolve)
        assertFalse(enrichmentFailed.canResolve)
        assertFalse(personal.merging(member).canResolve)
    }

    @Test
    fun `readonly team request hides sensitive prompt and exposes no decision`() {
        val pending = PendingAskUser(
            sessionId = "session-1",
            messageId = "message-1",
            hitlRequestId = "ask-1",
            questions = listOf(
                AskUserQuestion(
                    id = "secret-question",
                    text = "包含敏感客户名称的问题",
                    options = listOf(AskUserOption("secret-option", "敏感选项")),
                    allowMultiple = false,
                    allowFreeText = false,
                ),
            ),
            title = "敏感标题",
            resolutionAccess = HitlResolutionAccess.resolve(
                JsonObject(
                    mapOf(
                        "team_space_execution" to JsonObject(
                            mapOf("execution_owner_user_id" to JsonPrimitive("owner-1")),
                        ),
                    ),
                ),
                currentUserId = "member-1",
            ),
        )

        val model = CapsuleInteractionBubblePolicy.project(
            ConversationUiState(
                pendingAskUser = pending,
                errorMessage = "不应泄露的服务端详情",
            ),
        ) as CapsuleInteractionBubbleModel.ReadOnly

        assertEquals("ask-user:ask-1", model.stableId)
        assertEquals("", model.title)
        assertEquals("", model.message)
        assertNull(model.errorMessage)
        assertTrue(model.openConversationAction.enabled)
    }

    @Test
    fun `pending interaction hydration evaluates access with the signed in user`() {
        val payload = Json.parseToJsonElement(
            """{
                "request_id":"ask-1",
                "questions":[{
                    "id":"q-1",
                    "prompt":"private question",
                    "allow_multiple":false,
                    "allow_free_text":false,
                    "options":[{"id":"yes","label":"Yes"}]
                }],
                "team_space_execution":{
                    "execution_owner_user_id":"owner-1"
                }
            }""",
        ).jsonObject
        val interaction = PendingInteraction(
            id = "interaction-1",
            kind = "ask_choice",
            status = "pending",
            threadId = "chat-session-session-1",
            sessionId = "session-1",
            requestKey = "ask-1",
            source = "runtime",
            payload = payload,
        )

        val memberEvent = interaction.toStreamEvent("session-1", "member-1") as StreamEvent.AskUser
        val ownerEvent = interaction.toStreamEvent("session-1", "owner-1") as StreamEvent.AskUser
        assertFalse(memberEvent.resolutionAccess.canResolve)
        assertTrue(ownerEvent.resolutionAccess.canResolve)
    }

    @Test
    fun `redacted team hydration keeps readonly ask and form while empty owner payload is rejected`() {
        val teamMetadata = JsonObject(
            mapOf(
                "team_space_execution" to JsonObject(
                    mapOf("execution_owner_user_id" to JsonPrimitive("owner-1")),
                ),
            ),
        )
        val ask = PendingInteraction(
            id = "ask-interaction",
            kind = "ask_choice",
            status = "pending",
            threadId = "chat-session-session-1",
            sessionId = "session-1",
            requestKey = "ask-redacted",
            source = "runtime",
            payload = teamMetadata,
        )
        val form = PendingInteraction(
            id = "form-interaction",
            kind = "ask_form",
            status = "pending",
            threadId = "chat-session-session-1",
            sessionId = "session-1",
            requestKey = "form-redacted",
            source = "runtime",
            payload = teamMetadata,
        )

        val readonlyAsk = ask.toStreamEvent("session-1", "member-1") as StreamEvent.AskUser
        val readonlyForm = form.toStreamEvent("session-1", "member-1") as StreamEvent.AskFormRequired
        assertTrue(readonlyAsk.questions.isEmpty())
        assertTrue(readonlyForm.request.fields.isEmpty())
        assertFalse(readonlyAsk.resolutionAccess.canResolve)
        assertFalse(readonlyForm.resolutionAccess.canResolve)
        assertNull(ask.toStreamEvent("session-1", "owner-1"))
        assertNull(form.toStreamEvent("session-1", "owner-1"))
        assertNull(ask.copy(payload = JsonObject(emptyMap())).toStreamEvent("session-1", "member-1"))
        assertNull(form.copy(payload = JsonObject(emptyMap())).toStreamEvent("session-1", "member-1"))
    }

    @Test
    fun `submission ownership releases only the prompt that owns the flag`() {
        val ownership = HitlSubmissionOwnership()
        val first = ownership.claim("ask-user:A")
        assertTrue(ownership.release(first))

        val stale = ownership.claim("ask-user:A")
        val current = ownership.claim("ask-user:B")
        assertFalse(ownership.release(stale))
        assertEquals("ask-user:B", ownership.activeKey)
        assertTrue(ownership.release(current))
        assertNull(ownership.activeKey)

        val staleSameKey = ownership.claim("ask-user:A")
        val currentSameKey = ownership.claim("ask-user:A")
        assertFalse(ownership.release(staleSameKey))
        assertTrue(ownership.release(currentSameKey))
    }

    @Test
    fun `terminal releases overwritten prompt before a late ack without touching the next submission`() {
        val ownership = HitlSubmissionOwnership()
        val submissionA = ownership.claim("ask-user:A")

        val terminalReleased = CapsuleInteractionPendingKey
            .terminalKeys(kind = "ask_choice", requestKey = "A")
            .any(ownership::releaseKey)
        assertTrue(terminalReleased)
        assertNull(ownership.activeKey)

        val submissionB = ownership.claim("ask-user:B")
        assertFalse(ownership.release(submissionA))
        assertEquals("ask-user:B", ownership.activeKey)
        assertTrue(ownership.release(submissionB))
        assertEquals(
            listOf("tool-approval:batch-A", "tool-approval:action:batch-A"),
            CapsuleInteractionPendingKey.terminalKeys("tool_approval", "batch-A"),
        )
        assertTrue(
            "tool-approval:action:approval-A" in CapsuleInteractionPendingKey.terminalKeys(
                "tool_approval",
                "action-approval-A",
            ),
        )
    }

    @Test
    fun `approval stays actionable until resolved and submitting disables duplicate decisions`() {
        val pending = PendingRequestApproval(
            sessionId = "session-1",
            request = RequestApprovalRequest(
                requestId = "approval-1",
                title = "允许覆盖文档吗",
                rationale = "将替换第三节的四段内容",
                riskLevel = "safe",
            ),
        )

        val ready = CapsuleInteractionBubblePolicy.project(
            ConversationUiState(pendingRequestApproval = pending),
        ) as CapsuleInteractionBubbleModel.Approval

        assertEquals("request-approval:approval-1", ready.stableId)
        assertEquals("允许覆盖文档吗", ready.title)
        assertEquals("将替换第三节的四段内容", ready.message)
        assertTrue(
            ready.actions.any {
                it.intent == CapsuleInteractionIntent.ApproveRequest("request-approval:approval-1")
            },
        )
        assertTrue(
            ready.actions.any {
                it.intent == CapsuleInteractionIntent.RejectRequest("request-approval:approval-1")
            },
        )
        assertTrue(
            ready.actions.any {
                it.intent == CapsuleInteractionIntent.OpenConversation("request-approval:approval-1")
            },
        )
        assertTrue(ready.actions.all { it.enabled })

        val submitting = CapsuleInteractionBubblePolicy.project(
            ConversationUiState(
                pendingRequestApproval = pending,
                hitlSubmitting = true,
            ),
        ) as CapsuleInteractionBubbleModel.Approval
        assertTrue(submitting.submitting)
        assertFalse(submitting.actions.any { it.enabled })

        val failed = CapsuleInteractionBubblePolicy.project(
            ConversationUiState(
                pendingRequestApproval = pending,
                errorMessage = "网络中断",
            ),
        ) as CapsuleInteractionBubbleModel.Approval
        assertEquals("网络中断", failed.errorMessage)
        assertTrue(failed.actions.all { it.enabled })

        assertNull(
            "气泡必须常驻到 resolved，而不是本地点击后提前消失",
            CapsuleInteractionBubblePolicy.project(ConversationUiState()),
        )
    }

    @Test
    fun `elevated request approval requires full review before approval`() {
        listOf("medium", "review", "high", "critical").forEach { risk ->
            val pending = PendingRequestApproval(
                sessionId = "session-1",
                request = RequestApprovalRequest(
                    requestId = "approval-$risk",
                    title = "允许敏感操作吗",
                    rationale = "需要先查看完整上下文",
                    riskLevel = risk,
                ),
            )

            val model = CapsuleInteractionBubblePolicy.project(
                ConversationUiState(pendingRequestApproval = pending),
            ) as CapsuleInteractionBubbleModel.Approval

            assertFalse(model.actions.any { it.intent is CapsuleInteractionIntent.ApproveRequest })
            assertTrue(model.actions.any { it.intent is CapsuleInteractionIntent.RejectRequest })
            assertTrue(model.actions.any { it.intent is CapsuleInteractionIntent.OpenConversation })
        }
    }

    @Test
    fun `safe tool approval exposes real decisions with the least common scope`() {
        val action = ApprovalActionRequest(
            requestId = "request-1",
            toolCallId = "tool-call-1",
            toolName = "write_file",
            toolNamespace = null,
            toolInputJson = null,
            decisionReasonType = "user_interactive",
            decisionReasonFields = null,
            askHintSummary = "覆盖竞品分析第三节",
            askHintSuggestedScope = "thread",
            allowedScopes = listOf("once", "thread"),
            allowedOutcomes = listOf("allow", "deny"),
            riskLevel = "low",
            workspaceZone = null,
        )
        val pending = PendingApproval(
            batchId = "batch-1",
            approvalType = "tool_permission",
            actionRequests = listOf(action),
            runtimeMode = null,
            expiresAtMs = null,
        )

        val model = CapsuleInteractionBubblePolicy.project(
            ConversationUiState(pendingApproval = pending),
        ) as CapsuleInteractionBubbleModel.Approval

        assertEquals("tool-approval:batch-1", model.stableId)
        assertEquals("write_file", model.title)
        assertEquals("覆盖竞品分析第三节", model.message)
        assertTrue(
            model.actions.any {
                it.intent == CapsuleInteractionIntent.SubmitToolApproval(
                    expectedStableId = "tool-approval:batch-1",
                    outcome = "allow",
                    scope = "once",
                )
            },
        )
        assertTrue(
            model.actions.any {
                it.intent == CapsuleInteractionIntent.SubmitToolApproval(
                    expectedStableId = "tool-approval:batch-1",
                    outcome = "deny",
                    scope = null,
                )
            },
        )
        assertTrue(
            model.actions.any {
                it.intent == CapsuleInteractionIntent.OpenConversation(
                    expectedStableId = "tool-approval:batch-1",
                    reviewChanges = true,
                )
            },
        )

        val withoutCommonScope = CapsuleInteractionBubblePolicy.project(
            ConversationUiState(
                pendingApproval = pending.copy(
                    batchId = "batch-no-scope",
                    actionRequests = listOf(action.copy(allowedScopes = emptyList())),
                ),
            ),
        ) as CapsuleInteractionBubbleModel.Approval
        assertFalse(
            withoutCommonScope.actions.any {
                (it.intent as? CapsuleInteractionIntent.SubmitToolApproval)?.outcome == "allow"
            },
        )
    }

    @Test
    fun `empty tool approval batch only opens the full conversation`() {
        val model = CapsuleInteractionBubblePolicy.project(
            ConversationUiState(
                pendingApproval = PendingApproval(
                    batchId = "batch-empty",
                    approvalType = "tool_permission",
                    actionRequests = emptyList(),
                    runtimeMode = null,
                    expiresAtMs = null,
                ),
            ),
        ) as CapsuleInteractionBubbleModel.Approval

        assertEquals(
            listOf(CapsuleInteractionIntent.OpenConversation("tool-approval:batch-empty")),
            model.actions.map { it.intent },
        )
    }

    @Test
    fun `redacted tool approval never exposes a decision from placeholder details`() {
        val redacted = ApprovalActionRequest(
            requestId = "request-redacted",
            toolCallId = "tool-call-redacted",
            toolName = "redacted_tool",
            toolNamespace = null,
            toolInputJson = null,
            decisionReasonType = null,
            decisionReasonFields = null,
            askHintSummary = null,
            askHintSuggestedScope = null,
            allowedScopes = listOf("once"),
            allowedOutcomes = listOf("allow", "deny"),
            riskLevel = null,
            workspaceZone = null,
        )
        val model = CapsuleInteractionBubblePolicy.project(
            ConversationUiState(
                pendingApproval = PendingApproval(
                    batchId = "batch-redacted",
                    approvalType = "tool_permission",
                    actionRequests = listOf(redacted),
                    runtimeMode = null,
                    expiresAtMs = null,
                ),
                errorMessage = "包含上一条请求的内部详情",
            ),
        ) as CapsuleInteractionBubbleModel.Approval

        assertTrue(model.title.isBlank())
        assertTrue(model.message.isBlank())
        assertNull(model.errorMessage)
        assertFalse(ApprovalPresentation.allowsDirectApproval(listOf(redacted)))
        assertEquals(
            listOf(CapsuleInteractionIntent.OpenConversation("tool-approval:batch-redacted")),
            model.actions.map { it.intent },
        )
    }

    @Test
    fun `simple single choice ask user projects all option chips`() {
        val pending = PendingAskUser(
            sessionId = "session-1",
            messageId = "message-1",
            hitlRequestId = "ask-1",
            title = "定价怎么展示",
            questions = listOf(
                AskUserQuestion(
                    id = "billing",
                    text = "定价列按什么周期展示？",
                    options = listOf(
                        AskUserOption("monthly", "月付"),
                        AskUserOption("yearly", "年付"),
                    ),
                    allowMultiple = false,
                    allowFreeText = false,
                ),
            ),
        )

        val model = CapsuleInteractionBubblePolicy.project(
            ConversationUiState(pendingAskUser = pending),
        ) as CapsuleInteractionBubbleModel.Choice

        assertEquals("ask-user:ask-1", model.stableId)
        assertEquals("定价怎么展示", model.title)
        assertEquals("定价列按什么周期展示？", model.message)
        assertEquals(
            listOf("月付", "年付"),
            model.options.map { it.label },
        )
        assertEquals(
            CapsuleInteractionIntent.SubmitAskUserOption(
                expectedStableId = "ask-user:ask-1",
                questionId = "billing",
                optionId = "monthly",
            ),
            model.options.first().intent,
        )
        assertNull(model.openConversationAction)
    }

    @Test
    fun `complex or truncated ask user offers only the full answer flow`() {
        fun project(
            question: AskUserQuestion,
            requestId: String? = "ask-complex",
        ): CapsuleInteractionBubbleModel.Choice =
            CapsuleInteractionBubblePolicy.project(
                ConversationUiState(
                    pendingAskUser = PendingAskUser(
                        sessionId = "session-1",
                        messageId = "message-1",
                        hitlRequestId = requestId,
                        title = "复杂问题",
                        questions = listOf(question),
                    ),
                ),
            ) as CapsuleInteractionBubbleModel.Choice

        val freeText = project(
            AskUserQuestion(
                id = "billing",
                text = "请补充选择原因",
                options = listOf(AskUserOption("monthly", "月付")),
                allowMultiple = false,
                allowFreeText = true,
            ),
        )
        assertTrue(freeText.options.isEmpty())
        assertTrue(freeText.openConversationAction?.enabled == true)

        val tooMany = project(
            AskUserQuestion(
                id = "size",
                text = "请选择规格",
                options = (1..5).map { AskUserOption("option-$it", "选项 $it") },
                allowMultiple = false,
                allowFreeText = false,
            ),
        )
        assertTrue(tooMany.options.isEmpty())
        assertTrue(tooMany.openConversationAction?.enabled == true)

        val simpleQuestion = AskUserQuestion(
            id = "billing",
            text = "请选择周期",
            options = listOf(AskUserOption("monthly", "月付")),
            allowMultiple = false,
            allowFreeText = false,
        )
        val missingRequestId = project(simpleQuestion, requestId = null)
        assertTrue(missingRequestId.options.isEmpty())
        assertTrue(missingRequestId.openConversationAction?.enabled == true)

        val containsOther = project(
            simpleQuestion.copy(
                options = simpleQuestion.options + AskUserOption("__other__", "其他"),
            ),
        )
        assertTrue(containsOther.options.isEmpty())
        assertTrue(containsOther.openConversationAction?.enabled == true)
    }

    @Test
    fun `ask form always hands off to its complete answer flow`() {
        val request = AskFormRequest(
            requestId = "form-1",
            title = "选择展示周期",
            fields = listOf(
                AskFormField(
                    key = "billing",
                    label = "计费周期",
                    type = "select",
                    options = listOf(
                        AskFormOption("monthly", "月付"),
                        AskFormOption("yearly", "年付"),
                    ),
                ),
            ),
        )

        val model = CapsuleInteractionBubblePolicy.project(
            ConversationUiState(
                pendingAskForm = PendingAskForm("session-1", request),
            ),
        ) as CapsuleInteractionBubbleModel.Choice

        assertEquals("ask-form:form-1", model.stableId)
        assertEquals("计费周期", model.message)
        assertTrue(model.options.isEmpty())
        assertEquals(
            CapsuleInteractionIntent.OpenConversation("ask-form:form-1"),
            model.openConversationAction?.intent,
        )

        val complex = CapsuleInteractionBubblePolicy.project(
            ConversationUiState(
                pendingAskForm = PendingAskForm(
                    "session-1",
                    request.copy(
                        requestId = "form-2",
                        fields = request.fields + AskFormField(
                            key = "notes",
                            label = "补充说明",
                            type = "textarea",
                        ),
                    ),
                ),
            ),
        ) as CapsuleInteractionBubbleModel.Choice
        assertTrue(complex.options.isEmpty())
        assertTrue(complex.openConversationAction?.enabled == true)

        val tooManyOptions = CapsuleInteractionBubblePolicy.project(
            ConversationUiState(
                pendingAskForm = PendingAskForm(
                    "session-1",
                    request.copy(
                        requestId = "form-3",
                        fields = listOf(
                            request.fields.single().copy(
                                options = (1..5).map {
                                    AskFormOption("option-$it", "选项 $it")
                                },
                            ),
                        ),
                    ),
                ),
            ),
        ) as CapsuleInteractionBubbleModel.Choice
        assertTrue(tooManyOptions.options.isEmpty())
        assertTrue(tooManyOptions.openConversationAction?.enabled == true)
    }

    @Test
    fun `intent only matches the pending prompt it was rendered for`() {
        val first = PendingRequestApproval(
            sessionId = "session-1",
            request = RequestApprovalRequest("approval-1", "第一个", "说明", "low"),
        )
        val second = PendingRequestApproval(
            sessionId = "session-1",
            request = RequestApprovalRequest("approval-2", "第二个", "说明", "low"),
        )
        val intent = CapsuleInteractionIntent.ApproveRequest("request-approval:approval-1")

        assertTrue(
            CapsuleInteractionBubblePolicy.matchesCurrent(
                intent,
                ConversationUiState(pendingRequestApproval = first),
            ),
        )
        assertFalse(
            CapsuleInteractionBubblePolicy.matchesCurrent(
                intent,
                ConversationUiState(pendingRequestApproval = second),
            ),
        )

        val firstTool = PendingApproval(
            batchId = "batch-1",
            approvalType = "tool_permission",
            actionRequests = emptyList(),
            runtimeMode = null,
            expiresAtMs = null,
        )
        val secondTool = firstTool.copy(batchId = "batch-2")
        assertEquals("tool-approval:batch-1", CapsuleInteractionPendingKey.toolApproval(firstTool))
        assertTrue(
            CapsuleInteractionPendingKey.matchesToolApproval(
                firstTool,
                expectedStableId = "tool-approval:batch-1",
            ),
        )
        assertFalse(
            CapsuleInteractionPendingKey.matchesToolApproval(
                secondTool,
                expectedStableId = "tool-approval:batch-1",
            ),
        )
        assertFalse(
            CapsuleInteractionPendingKey.sameToolApproval(
                current = firstTool.copy(actionApprovalId = "approval-B"),
                submitted = firstTool.copy(actionApprovalId = "approval-A"),
            ),
        )
    }

    @Test
    fun `bubble submission guard revalidates current risk scope and answer payload`() {
        val safeRequest = PendingRequestApproval(
            sessionId = "session-1",
            request = RequestApprovalRequest("approval", "批准", "说明", "safe"),
        )
        assertTrue(CapsuleInteractionSubmissionGuard.allowsRequestApproval(safeRequest, true))
        assertFalse(
            CapsuleInteractionSubmissionGuard.allowsRequestApproval(
                safeRequest.copy(request = safeRequest.request.copy(riskLevel = "low")),
                approved = true,
            ),
        )
        assertFalse(
            CapsuleInteractionSubmissionGuard.allowsRequestApproval(
                safeRequest.copy(request = safeRequest.request.copy(riskLevel = "medium")),
                approved = true,
            ),
        )
        assertTrue(
            CapsuleInteractionSubmissionGuard.allowsRequestApproval(
                safeRequest.copy(request = safeRequest.request.copy(riskLevel = "critical")),
                approved = false,
            ),
        )

        val toolAction = ApprovalActionRequest(
            requestId = "request",
            toolCallId = "tool-call",
            toolName = "write_file",
            toolNamespace = null,
            toolInputJson = null,
            decisionReasonType = "user_interactive",
            decisionReasonFields = null,
            askHintSummary = "更新文档",
            askHintSuggestedScope = "thread",
            allowedScopes = listOf("once", "thread"),
            allowedOutcomes = listOf("allow", "deny"),
            riskLevel = "low",
            workspaceZone = null,
        )
        val toolPending = PendingApproval(
            batchId = "batch",
            approvalType = "tool_permission",
            actionRequests = listOf(toolAction),
            runtimeMode = null,
            expiresAtMs = null,
        )
        assertTrue(
            CapsuleInteractionSubmissionGuard.allowsToolApproval(
                toolPending,
                outcome = "allow",
                scope = "once",
            ),
        )
        assertFalse(
            CapsuleInteractionSubmissionGuard.allowsToolApproval(
                toolPending,
                outcome = "allow",
                scope = "thread",
            ),
        )
        assertFalse(
            CapsuleInteractionSubmissionGuard.allowsToolApproval(
                toolPending.copy(
                    actionRequests = listOf(toolAction.copy(toolName = "redacted_tool")),
                ),
                outcome = "deny",
                scope = null,
            ),
        )

        val ask = PendingAskUser(
            sessionId = "session-1",
            messageId = "message",
            hitlRequestId = "ask",
            title = "选择",
            questions = listOf(
                AskUserQuestion(
                    id = "billing",
                    text = "请选择周期",
                    options = listOf(AskUserOption("monthly", "月付")),
                    allowMultiple = false,
                    allowFreeText = false,
                ),
            ),
        )
        val answer = AskUserAnswerSelection("billing", listOf("monthly"), null)
        assertTrue(CapsuleInteractionSubmissionGuard.allowsAskUser(ask, listOf(answer)))
        assertFalse(
            CapsuleInteractionSubmissionGuard.allowsAskUser(
                ask.copy(questions = listOf(ask.questions.single().copy(allowFreeText = true))),
                listOf(answer),
            ),
        )
        assertFalse(
            CapsuleInteractionSubmissionGuard.allowsAskUser(
                ask.copy(
                    questions = listOf(
                        ask.questions.single().copy(
                            options = listOf(AskUserOption("yearly", "年付")),
                        ),
                    ),
                ),
                listOf(answer),
            ),
        )
    }
}

class CapsuleInteractionBubbleGeometryTest {
    @Test
    fun `bubble follows dock side and remains inside phone and tablet safe bounds`() {
        val right = CapsuleInteractionBubbleGeometry.place(
            side = CapsuleDockSide.RIGHT,
            capsuleX = 330f,
            capsuleY = 720f,
            capsuleWidth = 48f,
            capsuleHeight = 48f,
            bubbleWidth = 288f,
            bubbleHeight = 180f,
            viewportWidth = 390f,
            viewportHeight = 844f,
            safeMargin = 12f,
            gap = 8f,
        )
        assertEquals(90f, right.x, 0.01f)
        assertEquals(532f, right.y, 0.01f)
        assertTrue(right.aboveCapsule)

        val leftNearTop = CapsuleInteractionBubbleGeometry.place(
            side = CapsuleDockSide.LEFT,
            capsuleX = 12f,
            capsuleY = 40f,
            capsuleWidth = 48f,
            capsuleHeight = 48f,
            bubbleWidth = 288f,
            bubbleHeight = 240f,
            viewportWidth = 1_024f,
            viewportHeight = 768f,
            safeMargin = 12f,
            gap = 8f,
        )
        assertEquals(12f, leftNearTop.x, 0.01f)
        assertEquals(96f, leftNearTop.y, 0.01f)
        assertFalse(leftNearTop.aboveCapsule)
        assertTrue(leftNearTop.x + 288f <= 1_024f - 12f)
        assertTrue(leftNearTop.y + 240f <= 768f - 12f)
    }
}
