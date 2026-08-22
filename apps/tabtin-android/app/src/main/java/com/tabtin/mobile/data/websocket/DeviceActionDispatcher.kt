package com.tabtin.mobile.data.websocket

import android.os.SystemClock
import android.util.Log
import com.tabtin.mobile.data.automation.ActionRouter
import com.tabtin.mobile.data.automation.DeviceActionResult
import com.tabtin.mobile.data.automation.DeviceSecurityConfirm
import com.tabtin.mobile.data.automation.SecurityConfirmDecision
import com.tabtin.mobile.data.automation.SecurityPolicyChecker
import com.tabtin.mobile.data.automation.SessionPermissionApprovalCache
import com.tabtin.mobile.data.model.WSEnvelope
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.ConcurrentLinkedQueue
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Callback interface for security policy confirm dialogs.
 * Implementations should show a native AlertDialog and resume with
 * [SecurityConfirmDecision] when the user responds.
 */
public fun interface SecurityConfirmCallback {
    public suspend fun confirm(action: String, reason: String): SecurityConfirmDecision
}

/**
 * Handles incoming device action requests dispatched via WebSocket,
 * executes them through [ActionRouter], and sends the result back.
 *
 * Extracted from [WebSocketService] to isolate action execution logic.
 */
public class DeviceActionDispatcher(
    private val actionRouter: ActionRouter,
    private val scope: CoroutineScope,
    private val deviceId: () -> String,
    private val organizationId: () -> String?,
    private val sendEnvelope: (WSEnvelope) -> Unit,
    private val securityConfirm: SecurityConfirmCallback? = null,
    private val sessionApprovals: SessionPermissionApprovalCache = SessionPermissionApprovalCache(),
) {
    public companion object {
        private const val TAG = "DeviceActionDispatcher"
        // 会话级缓存已支持（见 SessionPermissionApprovalCache）；always/跨设备待 #20。
        internal const val CONFIRM_TIMEOUT_MS = 300_000L
    }

    private val inflightJobs = ConcurrentLinkedQueue<Job>()

    public fun cancelAll() {
        inflightJobs.forEach { it.cancel() }
        inflightJobs.clear()
        sessionApprovals.clear()
    }

    private fun resolveConfirm(): SecurityConfirmCallback? =
        securityConfirm ?: DeviceSecurityConfirm.callback()

    public fun handleRequest(envelope: WSEnvelope) {
        val taskId = envelope.payloadString("task_id")
        val action = envelope.payloadString("action")
        if (taskId.isNullOrBlank() || action.isNullOrBlank()) {
            Log.e(TAG, "Invalid device action request: missing task_id or action")
            return
        }

        val threadId = envelope.threadId ?: envelope.payloadString("thread_id")
        if (threadId.isNullOrBlank()) {
            Log.e(TAG, "Invalid device action request: missing thread_id")
            return
        }

        val currentOrganizationId = organizationId()
        val envelopeOrganizationId = envelope.organizationId
        if (!envelopeOrganizationId.isNullOrBlank() && envelopeOrganizationId != currentOrganizationId) {
            sendResult(
                taskId = taskId,
                threadId = threadId,
                traceId = envelope.traceId ?: envelope.payloadString("trace_id"),
                organizationId = envelopeOrganizationId,
                result = DeviceActionResult(
                    success = false,
                    error = "Organization mismatch for current Android runtime",
                    errorCode = "ORGANIZATION_MISMATCH",
                ),
                startedAtMs = SystemClock.elapsedRealtime(),
            )
            return
        }

        // Device permission check via unified security policy
        val sandboxPolicy = envelope.payloadDict("sandbox_policy")
        val policyResult = SecurityPolicyChecker.check(action, sandboxPolicy)
        if (!policyResult.allowed) {
            sendResult(
                taskId = taskId,
                threadId = threadId,
                traceId = envelope.traceId ?: envelope.payloadString("trace_id"),
                organizationId = envelopeOrganizationId ?: currentOrganizationId,
                result = DeviceActionResult(
                    success = false,
                    error = policyResult.reason ?: "Action blocked by security policy",
                    errorCode = "POLICY_BLOCKED",
                ),
                startedAtMs = SystemClock.elapsedRealtime(),
            )
            return
        }
        if (policyResult.needsConfirm) {
            val permissionKey = policyResult.permissionKey
                ?: SecurityPolicyChecker.permissionKeyFor(action)
            if (permissionKey != null) {
                when (sessionApprovals.get(permissionKey)) {
                    true -> {
                        // Session allow — fall through to execute below
                    }
                    false -> {
                        sendResult(
                            taskId = taskId,
                            threadId = threadId,
                            traceId = envelope.traceId ?: envelope.payloadString("trace_id"),
                            organizationId = envelopeOrganizationId ?: currentOrganizationId,
                            result = DeviceActionResult(
                                success = false,
                                error = "User denied the action",
                                errorCode = "APPROVAL_DENIED",
                            ),
                            startedAtMs = SystemClock.elapsedRealtime(),
                        )
                        return
                    }
                    null -> {
                        promptAndMaybeExecute(
                            envelope = envelope,
                            taskId = taskId,
                            threadId = threadId,
                            action = action,
                            permissionKey = permissionKey,
                            organizationId = envelopeOrganizationId ?: currentOrganizationId,
                            reason = policyResult.reason ?: "Agent wants to perform: $action",
                        )
                        return
                    }
                }
            } else {
                promptAndMaybeExecute(
                    envelope = envelope,
                    taskId = taskId,
                    threadId = threadId,
                    action = action,
                    permissionKey = null,
                    organizationId = envelopeOrganizationId ?: currentOrganizationId,
                    reason = policyResult.reason ?: "Agent wants to perform: $action",
                )
                return
            }
        }

        executeAction(
            envelope = envelope,
            taskId = taskId,
            threadId = threadId,
            action = action,
            organizationId = envelopeOrganizationId ?: currentOrganizationId,
        )
    }

    private fun promptAndMaybeExecute(
        envelope: WSEnvelope,
        taskId: String,
        threadId: String,
        action: String,
        permissionKey: String?,
        organizationId: String?,
        reason: String,
    ) {
        val confirm = resolveConfirm()
        if (confirm == null) {
            Log.w(TAG, "Action '$action' needs confirm but SecurityConfirmCallback not injected")
            sendResult(
                taskId = taskId,
                threadId = threadId,
                traceId = envelope.traceId ?: envelope.payloadString("trace_id"),
                organizationId = organizationId,
                result = DeviceActionResult(
                    success = false,
                    error = "Security confirm dialog is not available on this device",
                    errorCode = "CONFIRM_UNAVAILABLE",
                ),
                startedAtMs = SystemClock.elapsedRealtime(),
            )
            return
        }
        val job = scope.launch(Dispatchers.Main) {
            val decision = withTimeoutOrNull(CONFIRM_TIMEOUT_MS) {
                confirm.confirm(action, reason)
            }
            if (decision == null) {
                sendResult(
                    taskId = taskId,
                    threadId = threadId,
                    traceId = envelope.traceId ?: envelope.payloadString("trace_id"),
                    organizationId = organizationId,
                    result = DeviceActionResult(
                        success = false,
                        error = "User did not respond within ${CONFIRM_TIMEOUT_MS / 1000}s",
                        errorCode = "CONFIRM_TIMEOUT",
                    ),
                    startedAtMs = SystemClock.elapsedRealtime(),
                )
                return@launch
            }
            when (decision) {
                SecurityConfirmDecision.UNAVAILABLE -> {
                    sendResult(
                        taskId = taskId,
                        threadId = threadId,
                        traceId = envelope.traceId ?: envelope.payloadString("trace_id"),
                        organizationId = organizationId,
                        result = DeviceActionResult(
                            success = false,
                            error = "Security confirm dialog is not available on this device",
                            errorCode = "CONFIRM_UNAVAILABLE",
                        ),
                        startedAtMs = SystemClock.elapsedRealtime(),
                    )
                    return@launch
                }
                SecurityConfirmDecision.DENY -> {
                    if (permissionKey != null) {
                        sessionApprovals.put(permissionKey, allowed = false)
                    }
                    sendResult(
                        taskId = taskId,
                        threadId = threadId,
                        traceId = envelope.traceId ?: envelope.payloadString("trace_id"),
                        organizationId = organizationId,
                        result = DeviceActionResult(
                            success = false,
                            error = "User denied the action",
                            errorCode = "APPROVAL_DENIED",
                        ),
                        startedAtMs = SystemClock.elapsedRealtime(),
                    )
                    return@launch
                }
                SecurityConfirmDecision.ALLOW_SESSION -> {
                    if (permissionKey != null) {
                        sessionApprovals.put(permissionKey, allowed = true)
                    }
                }
                SecurityConfirmDecision.ALLOW_ONCE -> Unit
            }
            val innerParams = envelope.payloadDict("params") ?: JsonObject(emptyMap())
            val innerStartedAtMs = SystemClock.elapsedRealtime()
            val innerTimeoutMs = actionRouter.getTimeoutMs(action)
            val innerResult = withTimeoutOrNull(innerTimeoutMs) {
                actionRouter.execute(action, innerParams)
            } ?: DeviceActionResult(success = false, error = "Action timed out", errorCode = "TIMEOUT")
            sendResult(
                taskId = taskId,
                threadId = threadId,
                traceId = envelope.traceId ?: envelope.payloadString("trace_id"),
                organizationId = organizationId,
                result = innerResult,
                startedAtMs = innerStartedAtMs,
            )
        }
        inflightJobs.add(job)
        job.invokeOnCompletion { inflightJobs.remove(job) }
    }

    private fun executeAction(
        envelope: WSEnvelope,
        taskId: String,
        threadId: String,
        action: String,
        organizationId: String?,
    ) {
        val params = envelope.payloadDict("params") ?: JsonObject(emptyMap())
        val startedAtMs = SystemClock.elapsedRealtime()

        // 与 confirm 路径的内联执行（Dispatchers.Main）保持同一调度器：
        // 测试可注入 TestScope 控制时序；真正的 IO 由 ActionRouter 各 handler 自行切线程。
        val job = scope.launch(Dispatchers.Main) {
            val timeoutMs = actionRouter.getTimeoutMs(action)
            val result = try {
                withTimeoutOrNull(timeoutMs) {
                    actionRouter.execute(action, params)
                } ?: DeviceActionResult(
                    success = false,
                    error = "Action '$action' timed out after ${timeoutMs / 1000}s",
                    errorCode = "TIMEOUT",
                )
            } catch (e: Exception) {
                Log.e(TAG, "Action '$action' threw unexpected exception", e)
                DeviceActionResult(
                    success = false,
                    error = "Action failed: ${e.message}",
                    errorCode = "INTERNAL_ERROR",
                )
            }
            sendResult(
                taskId = taskId,
                threadId = threadId,
                traceId = envelope.traceId ?: envelope.payloadString("trace_id"),
                organizationId = organizationId,
                result = result,
                startedAtMs = startedAtMs,
            )
        }
        inflightJobs.add(job)
        job.invokeOnCompletion { inflightJobs.remove(job) }
    }

    private fun sendResult(
        taskId: String,
        threadId: String,
        traceId: String?,
        organizationId: String?,
        result: DeviceActionResult,
        startedAtMs: Long,
    ) {
        val executionTimeMs = SystemClock.elapsedRealtime() - startedAtMs
        val payload = buildJsonObject {
            put("task_id", taskId)
            put("thread_id", threadId)
            put("success", result.success)
            put("frontend_execution_time_ms", executionTimeMs)
            if (!traceId.isNullOrBlank()) {
                put("trace_id", traceId)
            }
            result.data?.let { put("data", it) }
            if (!result.error.isNullOrBlank()) {
                put("error", result.error)
            }
            if (!result.errorCode.isNullOrBlank()) {
                put("error_code", result.errorCode)
            }
        }
        sendEnvelope(
            WSEnvelope.build(
                type = "agent.action.result",
                deviceId = deviceId(),
                payload = payload,
                organizationId = organizationId,
                threadId = threadId,
                traceId = traceId,
            ),
        )
    }
}
