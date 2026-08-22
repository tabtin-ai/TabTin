package com.tabtin.mobile.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

@Serializable
public data class PendingInteractionListResponse(
    val interactions: List<PendingInteraction> = emptyList(),
)

@Serializable
public data class PendingInteractionDismissResponse(
    @SerialName("interaction_id") val interactionId: String,
    val status: String,
)

@Serializable
public data class PendingInteraction(
    val id: String,
    val kind: String,
    val status: String,
    @SerialName("thread_id") val threadId: String,
    @SerialName("session_id") val sessionId: String? = null,
    @SerialName("organization_id") val organizationId: String? = null,
    @SerialName("request_key") val requestKey: String,
    val source: String,
    val payload: JsonObject = JsonObject(emptyMap()),
    val result: JsonObject = JsonObject(emptyMap()),
    @SerialName("expires_at") val expiresAtMs: Long? = null,
) {
    public val stableKey: String get() = "$kind:$threadId:$requestKey"
    public val isPending: Boolean get() = status == "pending"
    public val isExpired: Boolean get() = expiresAtMs?.let { it <= System.currentTimeMillis() } == true

    /** session_id 优先；缺失时从 thread_id 的 `chat-session-<id>` 约定回退 */
    public val effectiveSessionId: String?
        get() = sessionId
            ?: threadId.takeIf { it.startsWith(CHAT_SESSION_THREAD_PREFIX) }
                ?.removePrefix(CHAT_SESSION_THREAD_PREFIX)
                ?.takeIf { it.isNotBlank() }

    public fun toStreamEvent(activeSessionId: String, currentUserId: String? = null): StreamEvent? {
        if (!isPending || isExpired) return null
        val resolutionAccess = HitlResolutionAccess.resolve(payload, currentUserId)
        return when (kind) {
            "tool_approval" -> toApprovalRequested(activeSessionId, currentUserId)
            "ask_choice" -> toAskUser(resolutionAccess)
            "ask_form" -> toAskForm(resolutionAccess)
            "permission_request" -> toRequestApproval(resolutionAccess)
            else -> null
        }
    }

    public fun toApprovalRequested(
        activeSessionId: String,
        currentUserId: String? = null,
    ): StreamEvent.ApprovalRequested? {
        if (kind != "tool_approval" || !isPending || isExpired) return null
        val resolutionAccess = HitlResolutionAccess.resolve(payload, currentUserId)
        return if (source == "agent_action" || payload.jsonString("event_type") == "agent.action.approval_request") {
            toActionApprovalRequested(activeSessionId, resolutionAccess)
        } else {
            toBatchApprovalRequested(resolutionAccess)
        }
    }

    private fun toBatchApprovalRequested(
        resolutionAccess: HitlResolutionAccess,
    ): StreamEvent.ApprovalRequested? {
        val batchId = payload.jsonString("batch_id")?.takeIf { it.isNotBlank() } ?: return null
        val approvalType = payload.jsonString("approval_type")?.takeIf { it == "tool_permission" } ?: return null
        val actionRequests = (payload["action_requests"] as? JsonArray)
            ?.mapNotNull { item -> (item as? JsonObject)?.toApprovalActionRequest() }
            .orEmpty()
        if (actionRequests.isEmpty()) return null
        val expiresAt = (payload["expires_at"] as? JsonPrimitive)?.contentOrNull?.toLongOrNull() ?: expiresAtMs
        return StreamEvent.ApprovalRequested(
            batchId = batchId,
            approvalType = approvalType,
            actionRequests = actionRequests,
            runtimeMode = payload.jsonString("runtime_mode"),
            expiresAtMs = expiresAt,
            resolutionAccess = resolutionAccess,
        )
    }

    private fun toActionApprovalRequested(
        activeSessionId: String,
        resolutionAccess: HitlResolutionAccess,
    ): StreamEvent.ApprovalRequested? {
        val approvalId = payload.jsonString("approval_id")?.takeIf { it.isNotBlank() } ?: requestKey
        val command = payload.jsonString("command").orEmpty()
        val detail = payload.jsonString("detail")?.takeIf { it.isNotBlank() } ?: command.takeIf { it.isNotBlank() }
        val actionName = payload.jsonString("action_type")
            ?: payload.jsonString("action")
            ?: command.substringBefore(' ', missingDelimiterValue = "").takeIf { it.isNotBlank() }
            ?: "sensitive_action"
        val toolInput = buildString {
            detail?.let { append(it) }
            if (command.isNotBlank() && command != detail) {
                if (isNotEmpty()) append('\n')
                append(command)
            }
        }.takeIf { it.isNotBlank() }
        val actionRequest = ApprovalActionRequest(
            requestId = approvalId,
            toolCallId = approvalId,
            toolName = actionName,
            toolNamespace = null,
            toolInputJson = toolInput,
            decisionReasonType = "user_interactive",
            decisionReasonFields = null,
            askHintSummary = detail,
            askHintSuggestedScope = "once",
            allowedScopes = listOf("once"),
            allowedOutcomes = listOf("allow", "deny"),
            riskLevel = "high",
            workspaceZone = null,
        )
        return StreamEvent.ApprovalRequested(
            batchId = "action-$approvalId",
            approvalType = "tool_permission",
            actionRequests = listOf(actionRequest),
            runtimeMode = null,
            expiresAtMs = expiresAtMs,
            actionApprovalId = approvalId,
            actionThreadId = payload.jsonString("thread_id") ?: threadId.ifBlank { "chat-session-$activeSessionId" },
            resolutionAccess = resolutionAccess,
        )
    }

    private fun toAskUser(resolutionAccess: HitlResolutionAccess): StreamEvent.AskUser? {
        val questions = (payload["questions"] as? JsonArray)
            ?.mapIndexedNotNull { index, item -> (item as? JsonObject)?.toAskUserQuestion(index) }
            .orEmpty()
        if (questions.isEmpty() && resolutionAccess.canResolve) return null
        return StreamEvent.AskUser(
            messageId = payload.jsonString("message_id"),
            hitlRequestId = firstNonBlank(
                payload.jsonString("request_id"),
                payload.jsonString("interrupt_id"),
                payload.jsonString("ask_id"),
                payload.jsonString("message_id"),
                requestKey,
            ),
            questions = questions,
            title = payload.jsonString("title"),
            resolutionAccess = resolutionAccess,
        )
    }

    private fun toAskForm(resolutionAccess: HitlResolutionAccess): StreamEvent.AskFormRequired? {
        val fields = (payload["fields"] as? JsonArray)
            ?.mapIndexedNotNull { index, item -> (item as? JsonObject)?.toAskFormField(index) }
            .orEmpty()
        if (fields.isEmpty() && resolutionAccess.canResolve) return null
        val requestId = firstNonBlank(
            payload.jsonString("request_id"),
            payload.jsonString("interrupt_id"),
            payload.jsonString("message_id"),
            requestKey,
        ) ?: return null
        return StreamEvent.AskFormRequired(
            AskFormRequest(
                requestId = requestId,
                title = payload.jsonString("title") ?: "请补充信息",
                submitLabel = payload.jsonString("submit_label"),
                fields = fields,
            ),
            resolutionAccess = resolutionAccess,
        )
    }

    private fun toRequestApproval(
        resolutionAccess: HitlResolutionAccess,
    ): StreamEvent.RequestApprovalRequired? {
        val requestId = firstNonBlank(
            payload.jsonString("request_id"),
            payload.jsonString("interrupt_id"),
            payload.jsonString("message_id"),
            requestKey,
        ) ?: return null
        return StreamEvent.RequestApprovalRequired(
            RequestApprovalRequest(
                requestId = requestId,
                title = payload.jsonString("title") ?: "需要你的批准",
                rationale = payload.jsonString("rationale") ?: payload.jsonString("message").orEmpty(),
                riskLevel = payload.jsonString("risk_level") ?: "medium",
                submitLabel = payload.jsonString("submit_label"),
                declineLabel = payload.jsonString("decline_label"),
            ),
            resolutionAccess = resolutionAccess,
        )
    }
}

private const val CHAT_SESSION_THREAD_PREFIX = "chat-session-"

private val pendingInteractionJson = Json { ignoreUnknownKeys = true }

private fun JsonObject.jsonString(key: String): String? = try {
    this[key]?.jsonPrimitive?.contentOrNull
} catch (_: IllegalArgumentException) {
    null
}

private fun JsonObject.jsonBool(key: String): Boolean? = try {
    val prim = this[key]?.jsonPrimitive ?: return null
    prim.booleanOrNull ?: when (prim.contentOrNull?.trim()?.lowercase()) {
        "true", "1", "yes", "required" -> true
        "false", "0", "no", "optional" -> false
        else -> null
    }
} catch (_: IllegalArgumentException) {
    null
}

private fun firstNonBlank(vararg values: String?): String? {
    for (value in values) {
        val trimmed = value?.trim()
        if (!trimmed.isNullOrEmpty()) return trimmed
    }
    return null
}

private fun JsonObject.toAskUserQuestion(index: Int): AskUserQuestion {
    val questionId = firstNonBlank(jsonString("id"), jsonString("key"), jsonString("name")) ?: "q-$index"
    val options = (this["options"] as? JsonArray)
        ?.mapIndexedNotNull { optionIndex, item -> (item as? JsonObject)?.toAskUserOption(optionIndex) }
        .orEmpty()
    return AskUserQuestion(
        id = questionId,
        text = firstNonBlank(jsonString("prompt"), jsonString("text"), jsonString("title")).orEmpty(),
        options = options,
        allowMultiple = jsonBool("allow_multiple") ?: false,
        allowFreeText = jsonBool("allow_free_text") ?: true,
        header = jsonString("header"),
    )
}

private fun JsonObject.toAskUserOption(index: Int): AskUserOption {
    val optionId = firstNonBlank(jsonString("id"), jsonString("value"), jsonString("key")) ?: "opt-$index"
    return AskUserOption(
        id = optionId,
        label = firstNonBlank(jsonString("label"), jsonString("title"), jsonString("text"), jsonString("name"))
            ?: optionId,
        description = firstNonBlank(jsonString("description"), jsonString("desc")),
        preview = jsonString("preview"),
    )
}

private fun JsonObject.toAskFormField(index: Int): AskFormField {
    val key = firstNonBlank(jsonString("key"), jsonString("name"), jsonString("id")) ?: "field-$index"
    val options = (this["options"] as? JsonArray)
        ?.mapIndexedNotNull { optionIndex, item -> (item as? JsonObject)?.toAskFormOption(optionIndex) }
        .orEmpty()
    return AskFormField(
        key = key,
        label = firstNonBlank(jsonString("label"), jsonString("title"), jsonString("prompt")) ?: key,
        type = jsonString("type") ?: "input",
        description = firstNonBlank(jsonString("description"), jsonString("desc")),
        placeholder = jsonString("placeholder"),
        required = jsonBool("required") ?: false,
        options = options,
    )
}

private fun JsonObject.toAskFormOption(index: Int): AskFormOption {
    val optionId = firstNonBlank(jsonString("id"), jsonString("value"), jsonString("key")) ?: "opt-$index"
    return AskFormOption(
        id = optionId,
        label = firstNonBlank(jsonString("label"), jsonString("title"), jsonString("text"), jsonString("name"))
            ?: optionId,
        description = firstNonBlank(jsonString("description"), jsonString("desc")),
    )
}

private fun JsonObject.toApprovalActionRequest(): ApprovalActionRequest? {
    val requestId = jsonString("request_id")?.takeIf { it.isNotBlank() } ?: return null
    val toolCallId = jsonString("tool_call_id")?.takeIf { it.isNotBlank() } ?: return null
    val toolName = jsonString("tool_name")?.takeIf { it.isNotBlank() } ?: return null
    val toolInputJson = when (val input = this["tool_input"]) {
        is JsonObject -> pendingInteractionJson.encodeToString(JsonObject.serializer(), input)
        is JsonArray -> pendingInteractionJson.encodeToString(JsonArray.serializer(), input)
        is JsonPrimitive -> input.contentOrNull
        else -> null
    }
    val askHint = this["ask_hint"] as? JsonObject
    val decisionReason = this["decision_reason"] as? JsonObject
    val scopes = (this["allowed_scopes"] as? JsonArray)
        ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
        ?.filter { it == "once" || it == "thread" || it == "always" }
        ?: listOf("once")
    val outcomes = (this["allowed_outcomes"] as? JsonArray)
        ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
        ?.filter { it == "allow" || it == "deny" }
        ?: listOf("allow", "deny")
    return ApprovalActionRequest(
        requestId = requestId,
        toolCallId = toolCallId,
        toolName = toolName,
        toolNamespace = jsonString("tool_namespace"),
        toolInputJson = toolInputJson,
        decisionReasonType = decisionReason?.jsonString("type"),
        decisionReasonFields = null,
        askHintSummary = askHint?.jsonString("summary"),
        askHintSuggestedScope = askHint?.jsonString("suggested_scope"),
        allowedScopes = scopes,
        allowedOutcomes = outcomes,
        riskLevel = jsonString("risk_level"),
        workspaceZone = jsonString("workspace_zone"),
    )
}
