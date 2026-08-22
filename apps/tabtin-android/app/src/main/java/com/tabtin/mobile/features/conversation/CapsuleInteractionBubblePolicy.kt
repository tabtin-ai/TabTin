package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.ApprovalActionRequest
import com.tabtin.mobile.data.model.AskUserQuestion

/** User intents exposed by the capsule interaction bubble. */
internal sealed interface CapsuleInteractionIntent {
    val expectedStableId: String

    data class ApproveRequest(
        override val expectedStableId: String,
    ) : CapsuleInteractionIntent
    data class RejectRequest(
        override val expectedStableId: String,
    ) : CapsuleInteractionIntent
    data class SubmitToolApproval(
        override val expectedStableId: String,
        val outcome: String,
        val scope: String?,
    ) : CapsuleInteractionIntent
    data class SubmitAskUserOption(
        override val expectedStableId: String,
        val questionId: String,
        val optionId: String,
    ) : CapsuleInteractionIntent
    data class OpenConversation(
        override val expectedStableId: String,
        val reviewChanges: Boolean = false,
    ) : CapsuleInteractionIntent
}

internal data class CapsuleInteractionAction(
    val intent: CapsuleInteractionIntent,
    val enabled: Boolean,
    val label: String? = null,
)

/**
 * Small, action-oriented projection of the existing HITL state.
 *
 * The bubble deliberately owns no optimistic "resolved" state. It remains mounted while the
 * authoritative pending request exists; successful/consumed responses clear that request in
 * [ConversationViewModel], while failures leave it available for retry.
 */
internal sealed interface CapsuleInteractionBubbleModel {
    val stableId: String
    val title: String
    val message: String
    val submitting: Boolean
    val errorMessage: String?

    data class Approval(
        override val stableId: String,
        override val title: String,
        override val message: String,
        override val submitting: Boolean,
        override val errorMessage: String?,
        val actions: List<CapsuleInteractionAction>,
    ) : CapsuleInteractionBubbleModel

    data class Choice(
        override val stableId: String,
        override val title: String,
        override val message: String,
        override val submitting: Boolean,
        override val errorMessage: String?,
        val options: List<CapsuleInteractionChoiceOption>,
        val openConversationAction: CapsuleInteractionAction?,
    ) : CapsuleInteractionBubbleModel

    data class ReadOnly(
        override val stableId: String,
        override val title: String = "",
        override val message: String = "",
        override val submitting: Boolean = false,
        override val errorMessage: String? = null,
        val executionOwnerDisplayName: String?,
        val openConversationAction: CapsuleInteractionAction,
    ) : CapsuleInteractionBubbleModel
}

internal data class CapsuleInteractionChoiceOption(
    val id: String,
    val label: String,
    val intent: CapsuleInteractionIntent,
    val enabled: Boolean,
)

/** Stable prompt identity shared by Compose actions and ViewModel submit guards. */
internal object CapsuleInteractionPendingKey {
    fun toolApproval(pending: PendingApproval): String = pending.actionApprovalId
        ?.let { "tool-approval:action:$it" }
        ?: "tool-approval:${pending.batchId}"

    fun resolvedToolApproval(batchId: String): String = if (batchId.startsWith("action-")) {
        "tool-approval:action:${batchId.removePrefix("action-")}"
    } else {
        "tool-approval:$batchId"
    }

    fun requestApproval(pending: PendingRequestApproval): String =
        "request-approval:${pending.request.requestId}"

    fun askUser(pending: PendingAskUser): String =
        "ask-user:${pending.hitlRequestId ?: pending.messageId.orEmpty()}"

    fun askForm(pending: PendingAskForm): String = "ask-form:${pending.request.requestId}"

    fun terminalKeys(kind: String, requestKey: String): List<String> = when (kind) {
        "tool_approval" -> buildList {
            add("tool-approval:$requestKey")
            add("tool-approval:action:$requestKey")
            if (requestKey.startsWith("action-")) {
                add("tool-approval:action:${requestKey.removePrefix("action-")}")
            }
        }
        "ask_choice" -> listOf("ask-user:$requestKey")
        "ask_form" -> listOf("ask-form:$requestKey")
        "permission_request" -> listOf("request-approval:$requestKey")
        else -> emptyList()
    }

    fun matchesToolApproval(pending: PendingApproval, expectedStableId: String): Boolean =
        toolApproval(pending) == expectedStableId

    fun sameToolApproval(current: PendingApproval?, submitted: PendingApproval): Boolean {
        if (current == null) return false
        return current.batchId == submitted.batchId &&
            current.actionApprovalId == submitted.actionApprovalId
    }

    fun matchesRequestApproval(
        pending: PendingRequestApproval,
        expectedStableId: String,
    ): Boolean = requestApproval(pending) == expectedStableId

    fun matchesAskUser(pending: PendingAskUser, expectedStableId: String): Boolean =
        askUser(pending) == expectedStableId
}

/** Identity token for the one global HITL submitting flag. */
internal data class HitlSubmissionToken(
    val key: String,
    val generation: Long,
)

internal class HitlSubmissionOwnership {
    private var nextGeneration: Long = 0
    private var activeToken: HitlSubmissionToken? = null

    val activeKey: String? get() = activeToken?.key

    fun claim(key: String): HitlSubmissionToken {
        val token = HitlSubmissionToken(key, ++nextGeneration)
        activeToken = token
        return token
    }

    fun release(token: HitlSubmissionToken): Boolean {
        if (activeToken != token) return false
        activeToken = null
        return true
    }

    fun releaseKey(key: String): Boolean {
        if (activeToken?.key != key) return false
        activeToken = null
        return true
    }

    fun clear() {
        activeToken = null
    }
}

/** Defense-in-depth for bubble-only direct actions; full HITL panels keep their existing contract. */
internal object CapsuleInteractionSubmissionGuard {
    fun allowsRequestApproval(pending: PendingRequestApproval, approved: Boolean): Boolean {
        if (!pending.resolutionAccess.canResolve) return false
        if (!approved) return true
        return pending.request.riskLevel.trim().lowercase() == "safe"
    }

    fun allowsToolApproval(
        pending: PendingApproval,
        outcome: String,
        scope: String?,
    ): Boolean {
        if (!pending.resolutionAccess.canResolve) return false
        val actions = pending.actionRequests
        if (actions.isEmpty() || detailsRedacted(actions)) return false
        if (outcome !in commonAllowedOutcomes(actions)) return false
        return when (outcome) {
            "allow" -> {
                val leastScope = commonAllowedScopes(actions).firstOrNull()
                leastScope != null &&
                    scope == leastScope &&
                    ApprovalPresentation.allowsDirectApproval(actions)
            }
            "deny" -> scope == null
            else -> false
        }
    }

    fun allowsAskUser(
        pending: PendingAskUser,
        answers: List<AskUserAnswerSelection>,
    ): Boolean {
        if (!pending.resolutionAccess.canResolve) return false
        val question = inlineAskUserQuestion(pending) ?: return false
        val answer = answers.singleOrNull() ?: return false
        val optionId = answer.selectedOptions.singleOrNull() ?: return false
        return answer.questionId == question.id &&
            answer.freeText.isNullOrEmpty() &&
            question.options.any { it.id == optionId }
    }

    fun inlineAskUserQuestion(pending: PendingAskUser): AskUserQuestion? {
        if (pending.hitlRequestId.isNullOrBlank()) return null
        return pending.questions.singleOrNull()?.takeIf { question ->
            !question.allowMultiple &&
                !question.allowFreeText &&
                question.options.none { it.id == OTHER_OPTION_ID } &&
                question.options.size in 1..MAX_QUICK_OPTIONS
        }
    }

    fun commonAllowedScopes(actions: List<ApprovalActionRequest>): List<String> =
        commonValues(actions.map { it.allowedScopes }, listOf("once", "thread", "always"))

    fun commonAllowedOutcomes(actions: List<ApprovalActionRequest>): List<String> =
        commonValues(actions.map { it.allowedOutcomes }, listOf("allow", "deny"))

    fun detailsRedacted(actions: List<ApprovalActionRequest>): Boolean =
        ApprovalPresentation.detailsAreRedacted(actions)

    private fun commonValues(values: List<List<String>>, order: List<String>): List<String> {
        if (values.isEmpty()) return emptyList()
        val common = values
            .map { it.toSet() }
            .reduce { current, next -> current.intersect(next) }
        return order.filter { it in common }
    }

    private const val MAX_QUICK_OPTIONS = 4
    private const val OTHER_OPTION_ID = "__other__"
}

internal object CapsuleInteractionBubblePolicy {
    fun project(state: ConversationUiState): CapsuleInteractionBubbleModel? {
        val enabled = !state.hitlSubmitting
        state.pendingApproval?.let { pending ->
            val stableId = CapsuleInteractionPendingKey.toolApproval(pending)
            if (!pending.resolutionAccess.canResolve) {
                return readOnly(stableId, pending.resolutionAccess.executionOwnerDisplayName)
            }
            val actions = pending.actionRequests
            val detailsRedacted = CapsuleInteractionSubmissionGuard.detailsRedacted(actions)
            val allowedScopes = CapsuleInteractionSubmissionGuard.commonAllowedScopes(actions)
            val leastScope = allowedScopes.firstOrNull()
            val first = actions.firstOrNull()?.takeUnless { detailsRedacted }
            val bubbleActions = buildList {
                if (
                    CapsuleInteractionSubmissionGuard.allowsToolApproval(
                        pending,
                        outcome = "allow",
                        scope = leastScope,
                    )
                ) {
                    add(
                        CapsuleInteractionAction(
                            intent = CapsuleInteractionIntent.SubmitToolApproval(
                                expectedStableId = stableId,
                                outcome = "allow",
                                scope = leastScope,
                            ),
                            enabled = enabled,
                        ),
                    )
                }
                if (
                    CapsuleInteractionSubmissionGuard.allowsToolApproval(
                        pending,
                        outcome = "deny",
                        scope = null,
                    )
                ) {
                    add(
                        CapsuleInteractionAction(
                            intent = CapsuleInteractionIntent.SubmitToolApproval(
                                expectedStableId = stableId,
                                outcome = "deny",
                                scope = null,
                            ),
                            enabled = enabled,
                        ),
                    )
                }
                add(
                    CapsuleInteractionAction(
                        CapsuleInteractionIntent.OpenConversation(
                            expectedStableId = stableId,
                            reviewChanges = actions.isNotEmpty() && !detailsRedacted,
                        ),
                        enabled,
                    ),
                )
            }
            return CapsuleInteractionBubbleModel.Approval(
                stableId = stableId,
                title = first?.toolName.orEmpty(),
                message = first?.askHintSummary
                    ?.takeIf { it.isNotBlank() }
                    ?: first?.toolName.orEmpty(),
                submitting = state.hitlSubmitting,
                errorMessage = state.errorMessage
                    ?.takeUnless { state.hitlSubmitting || detailsRedacted },
                actions = bubbleActions,
            )
        }

        state.pendingRequestApproval?.let { pending ->
            val stableId = CapsuleInteractionPendingKey.requestApproval(pending)
            if (!pending.resolutionAccess.canResolve) {
                return readOnly(stableId, pending.resolutionAccess.executionOwnerDisplayName)
            }
            val actions = buildList {
                if (CapsuleInteractionSubmissionGuard.allowsRequestApproval(pending, true)) {
                    add(
                        CapsuleInteractionAction(
                            CapsuleInteractionIntent.ApproveRequest(stableId),
                            enabled,
                            pending.request.submitLabel,
                        ),
                    )
                }
                add(
                    CapsuleInteractionAction(
                        CapsuleInteractionIntent.RejectRequest(stableId),
                        enabled,
                        pending.request.declineLabel,
                    ),
                )
                add(
                    CapsuleInteractionAction(
                        CapsuleInteractionIntent.OpenConversation(stableId),
                        enabled,
                    ),
                )
            }
            return CapsuleInteractionBubbleModel.Approval(
                stableId = stableId,
                title = pending.request.title,
                message = pending.request.rationale,
                submitting = state.hitlSubmitting,
                errorMessage = state.errorMessage?.takeUnless { state.hitlSubmitting },
                actions = actions,
            )
        }

        state.pendingAskUser?.let { pending ->
            val stableId = CapsuleInteractionPendingKey.askUser(pending)
            if (!pending.resolutionAccess.canResolve) {
                return readOnly(stableId, pending.resolutionAccess.executionOwnerDisplayName)
            }
            val question = pending.questions.singleOrNull()
            val inlineQuestion = CapsuleInteractionSubmissionGuard.inlineAskUserQuestion(pending)
            val quickOptions = if (inlineQuestion != null) {
                inlineQuestion.options.map { option ->
                    CapsuleInteractionChoiceOption(
                        id = option.id,
                        label = option.label,
                        intent = CapsuleInteractionIntent.SubmitAskUserOption(
                            expectedStableId = stableId,
                            questionId = inlineQuestion.id,
                            optionId = option.id,
                        ),
                        enabled = enabled,
                    )
                }
            } else {
                emptyList()
            }
            return CapsuleInteractionBubbleModel.Choice(
                stableId = stableId,
                title = pending.title.orEmpty(),
                message = question?.text ?: pending.questions.firstOrNull()?.text.orEmpty(),
                submitting = state.hitlSubmitting,
                errorMessage = state.errorMessage?.takeUnless { state.hitlSubmitting },
                options = quickOptions,
                openConversationAction = if (inlineQuestion == null) {
                    CapsuleInteractionAction(CapsuleInteractionIntent.OpenConversation(stableId), enabled)
                } else {
                    null
                },
            )
        }

        state.pendingAskForm?.let { pending ->
            val stableId = CapsuleInteractionPendingKey.askForm(pending)
            if (!pending.resolutionAccess.canResolve) {
                return readOnly(stableId, pending.resolutionAccess.executionOwnerDisplayName)
            }
            val field = pending.request.fields.firstOrNull()
            return CapsuleInteractionBubbleModel.Choice(
                stableId = stableId,
                title = pending.request.title,
                message = field?.label ?: pending.request.title,
                submitting = state.hitlSubmitting,
                errorMessage = state.errorMessage?.takeUnless { state.hitlSubmitting },
                options = emptyList(),
                openConversationAction = CapsuleInteractionAction(
                    CapsuleInteractionIntent.OpenConversation(stableId),
                    enabled,
                ),
            )
        }

        return null
    }

    private fun readOnly(
        stableId: String,
        executionOwnerDisplayName: String?,
    ): CapsuleInteractionBubbleModel.ReadOnly = CapsuleInteractionBubbleModel.ReadOnly(
        stableId = stableId,
        executionOwnerDisplayName = executionOwnerDisplayName,
        openConversationAction = CapsuleInteractionAction(
            CapsuleInteractionIntent.OpenConversation(stableId),
            enabled = true,
        ),
    )

    fun matchesCurrent(intent: CapsuleInteractionIntent, state: ConversationUiState): Boolean =
        project(state)?.stableId == intent.expectedStableId

}
