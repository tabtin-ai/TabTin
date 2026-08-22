package com.tabtin.mobile.data.model.tracker

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonNames
import kotlinx.serialization.json.JsonObject

@Serializable
public data class Tracker(
    val id: String,
    val name: String,
    val description: String = "",
    @SerialName("trigger_type") val triggerType: String = "manual",
    @SerialName("trigger_config") val triggerConfig: JsonObject = JsonObject(emptyMap()),
    val status: TrackerStatus = TrackerStatus.DRAFT,
    @SerialName("skill_key") val skillKey: String = "",
    @SerialName("skill_params") val skillParams: JsonObject? = null,
    @SerialName("total_runs") val totalRuns: Int = 0,
    @SerialName("success_runs") val successRuns: Int = 0,
    @SerialName("fail_runs") val failRuns: Int = 0,
    @SerialName("last_run_at") val lastRunAt: String? = null,
    @SerialName("next_run_at") val nextRunAt: String? = null,
    @SerialName("token_budget") val tokenBudget: Int = 0,
    @SerialName("project_mode") val projectMode: Boolean? = null,
    @SerialName("space_id") val spaceId: String? = null,
    @SerialName("space_name") val spaceName: String? = null,
    @SerialName("agent_id") val agentId: String? = null,
    @SerialName("workspace_id") val workspaceId: String? = null,
    val capabilities: TrackerCapabilities = TrackerCapabilities(),
    val steps: List<TrackerStep> = emptyList(),
    @SerialName("step_count") val stepCount: Int? = null,
    @SerialName("created_at") val createdAt: String = "",
    @SerialName("updated_at") val updatedAt: String = "",
)

@Serializable(with = TrackerStatusSerializer::class)
public enum class TrackerStatus {
    @SerialName("draft") DRAFT,
    @SerialName("active") ACTIVE,
    @SerialName("paused") PAUSED,
    @SerialName("disabled") DISABLED,
    @SerialName("archived") ARCHIVED,
    @SerialName("unknown") UNKNOWN,
}

internal object TrackerStatusSerializer : KSerializer<TrackerStatus> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("TrackerStatus", PrimitiveKind.STRING)

    override fun deserialize(decoder: Decoder): TrackerStatus = when (decoder.decodeString()) {
        "draft" -> TrackerStatus.DRAFT
        "active" -> TrackerStatus.ACTIVE
        "paused" -> TrackerStatus.PAUSED
        "disabled" -> TrackerStatus.DISABLED
        "archived" -> TrackerStatus.ARCHIVED
        else -> TrackerStatus.UNKNOWN
    }

    override fun serialize(encoder: Encoder, value: TrackerStatus) {
        encoder.encodeString(
            when (value) {
                TrackerStatus.DRAFT -> "draft"
                TrackerStatus.ACTIVE -> "active"
                TrackerStatus.PAUSED -> "paused"
                TrackerStatus.DISABLED -> "disabled"
                TrackerStatus.ARCHIVED -> "archived"
                TrackerStatus.UNKNOWN -> "unknown"
            },
        )
    }
}

/** 服务端按当前成员投影的 Tracker / Run 操作权限；字段缺失时一律只读。 */
@Serializable
public data class TrackerCapabilities(
    @SerialName("can_edit") val canEdit: Boolean = false,
    @SerialName("can_trigger") val canTrigger: Boolean = false,
    @SerialName("can_cancel") val canCancel: Boolean = false,
)

@Serializable
public data class TrackerStep(
    val id: String,
    val order: Int = 0,
    val name: String = "",
    val instruction: String = "",
    val capability: String = "agent",
    val checkpoint: Boolean = false,
    @SerialName("checkpoint_prompt") val checkpointPrompt: String = "",
    @SerialName("failure_strategy") val failureStrategy: String = "skip",
    @SerialName("max_retries") val maxRetries: Int = 0,
    @SerialName("is_enabled") val isEnabled: Boolean = true,
    @SerialName("model_preference") val modelPreference: String = "",
)

@OptIn(ExperimentalSerializationApi::class)
@Serializable
public data class TrackerRun(
    val id: String,
    // 后端 Tracker 收敛波次 3a 后输出 tracker_id；goal_id 仅为历史响应兼容读
    @SerialName("tracker_id") @JsonNames("goal_id") val trackerId: String,
    @SerialName("trigger_type") val triggerType: String = "manual",
    @SerialName("chat_session_id") val chatSessionId: String? = null,
    val status: TrackerRunStatus = TrackerRunStatus.RUNNING,
    @SerialName("total_steps") val totalSteps: Int = 0,
    @SerialName("completed_steps") val completedSteps: Int = 0,
    val progress: Double = 0.0,
    @SerialName("progress_pct") val progressPct: Int = 0,
    @SerialName("progress_message") val progressMessage: String = "",
    @SerialName("tokens_used") val tokensUsed: Int = 0,
    @SerialName("current_cycle") val currentCycle: Int = 1,
    @SerialName("max_cycles") val maxCycles: Int = 3,
    @SerialName("error_summary") val errorSummary: String = "",
    @SerialName("result_summary") val resultSummary: String = "",
    val capabilities: TrackerCapabilities = TrackerCapabilities(),
    @SerialName("started_at") val startedAt: String? = null,
    @SerialName("finished_at") val finishedAt: String? = null,
    val duration: Double? = null,
    @SerialName("step_runs") val stepRuns: List<StepRunInfo>? = null,
    @SerialName("created_at") val createdAt: String = "",
)

@Serializable(with = TrackerRunStatusSerializer::class)
public enum class TrackerRunStatus {
    @SerialName("pending") PENDING,
    @SerialName("running") RUNNING,
    @SerialName("waiting_device") WAITING_DEVICE,
    @SerialName("waiting_checkpoint") WAITING_CHECKPOINT,
    @SerialName("completed") COMPLETED,
    @SerialName("partial_failed") PARTIAL_FAILED,
    @SerialName("failed") FAILED,
    @SerialName("cancelled") CANCELLED,
    @SerialName("unknown") UNKNOWN;

    public val isTerminal: Boolean
        get() = this in setOf(COMPLETED, FAILED, PARTIAL_FAILED, CANCELLED)
}

/** Keep the mobile UI and action layer aligned with the server's one-active-run contract. */
public object TrackerRunExecutionPolicy {
    public fun canTrigger(latestRun: TrackerRun?): Boolean = latestRun?.status?.isTerminal != false
}

internal object TrackerRunStatusSerializer : KSerializer<TrackerRunStatus> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("TrackerRunStatus", PrimitiveKind.STRING)

    override fun deserialize(decoder: Decoder): TrackerRunStatus = when (decoder.decodeString()) {
        "pending" -> TrackerRunStatus.PENDING
        "running" -> TrackerRunStatus.RUNNING
        "waiting_device" -> TrackerRunStatus.WAITING_DEVICE
        "waiting_checkpoint" -> TrackerRunStatus.WAITING_CHECKPOINT
        "completed" -> TrackerRunStatus.COMPLETED
        "partial_failed" -> TrackerRunStatus.PARTIAL_FAILED
        "failed" -> TrackerRunStatus.FAILED
        "cancelled" -> TrackerRunStatus.CANCELLED
        else -> TrackerRunStatus.UNKNOWN
    }

    override fun serialize(encoder: Encoder, value: TrackerRunStatus) {
        encoder.encodeString(
            when (value) {
                TrackerRunStatus.PENDING -> "pending"
                TrackerRunStatus.RUNNING -> "running"
                TrackerRunStatus.WAITING_DEVICE -> "waiting_device"
                TrackerRunStatus.WAITING_CHECKPOINT -> "waiting_checkpoint"
                TrackerRunStatus.COMPLETED -> "completed"
                TrackerRunStatus.PARTIAL_FAILED -> "partial_failed"
                TrackerRunStatus.FAILED -> "failed"
                TrackerRunStatus.CANCELLED -> "cancelled"
                TrackerRunStatus.UNKNOWN -> "unknown"
            },
        )
    }
}

@Serializable
public data class StepRunInfo(
    val id: String,
    @SerialName("step_id") val stepId: String = "",
    @SerialName("step_name") val stepName: String = "",
    @SerialName("step_order") val stepOrder: Int = 0,
    val capability: String = "agent",
    val status: StepRunStatus = StepRunStatus.WAITING,
    @SerialName("output_summary") val outputSummary: String = "",
    @SerialName("started_at") val startedAt: String? = null,
    @SerialName("finished_at") val finishedAt: String? = null,
    val duration: Double? = null,
    @SerialName("retry_count") val retryCount: Int = 0,
    @SerialName("error_message") val errorMessage: String = "",
    val checkpoint: Boolean = false,
    @SerialName("checkpoint_prompt") val checkpointPrompt: String = "",
    @SerialName("tokens_used") val tokensUsed: Int = 0,
    @SerialName("cost_usd") val costUsd: Double = 0.0,
    @SerialName("model_used") val modelUsed: String = "",
)

@Serializable
public enum class StepRunStatus {
    @SerialName("waiting") WAITING,
    @SerialName("ready") READY,
    @SerialName("running") RUNNING,
    @SerialName("done") DONE,
    @SerialName("failed") FAILED,
    @SerialName("skipped") SKIPPED,
    @SerialName("checkpoint") CHECKPOINT;

    public val isTerminal: Boolean
        get() = this in setOf(DONE, FAILED, SKIPPED)
}

@OptIn(ExperimentalSerializationApi::class)
@Serializable
public data class TrackerListResponse(
    @JsonNames("goals", "events")
    val trackers: List<Tracker> = emptyList(),
    val total: Int = 0,
)

@Serializable
public data class TrackerRunListResponse(
    val runs: List<TrackerRun> = emptyList(),
)

/** `/tracker/templates` 的只读任务蓝图，创建时仍由用户确认 AI 分身与 Workspace。 */
@Serializable
public data class TrackerTemplate(
    val id: String,
    val version: String = "",
    val name: String = "",
    val description: String = "",
    val category: String = "",
    @SerialName("icon_key") val iconKey: String = "sparkles",
    @SerialName("default_name") val defaultName: String = "",
    val instructions: String = "",
    @SerialName("trigger_type") val triggerType: String = "manual",
    @SerialName("trigger_config") val triggerConfig: JsonObject = JsonObject(emptyMap()),
    val requirements: String = "",
)

@Serializable
public data class TrackerTemplateListResponse(
    val templates: List<TrackerTemplate> = emptyList(),
)

public data class TrackerAttentionItem(
    val tracker: Tracker,
    val run: TrackerRun,
    val reason: AttentionReason,
) {
    val id: String get() = "${tracker.id}_${run.id}"
}

public enum class AttentionReason { CHECKPOINT, FAILED }

@Serializable
public data class CheckpointProvideRequest(
    @SerialName("user_input") val userInput: String,
)

@Serializable
public data class CreateTrackerRequest(
    val name: String,
    val description: String = "",
    @SerialName("trigger_type") val triggerType: String = "manual",
    @SerialName("trigger_config") val triggerConfig: JsonObject = JsonObject(emptyMap()),
    @SerialName("skill_params") val skillParams: TrackerSkillParams,
    @SerialName("intent_snapshot") val intentSnapshot: JsonObject? = null,
    @SerialName("agent_id") val agentId: String,
    @SerialName("workspace_id") val workspaceId: String,
)

@Serializable
public data class TrackerSkillParams(
    val instructions: String,
)

@Serializable
public data class UpdateTrackerRequest(
    val name: String? = null,
    val description: String? = null,
    @SerialName("trigger_type") val triggerType: String? = null,
)

public object TrackerCapabilityIcons {
    public fun iconFor(capability: String): String = when (capability) {
        "agent" -> "smart_toy"
        "browser" -> "language"
        "table" -> "table_chart"
        "docs" -> "description"
        "slide" -> "slideshow"
        "code" -> "code"
        "notification" -> "notifications"
        "group_chat" -> "group"
        else -> "settings"
    }
}

public object TriggerTypeIcons {
    public fun iconFor(triggerType: String): String = when (triggerType) {
        "manual" -> "touch_app"
        "cron" -> "schedule"
        "interval" -> "timer"
        "extension_event" -> "extension"
        "table_event" -> "table_chart"
        "webhook" -> "webhook"
        "goal_completed" -> "check_circle"
        else -> "help_outline"
    }
}
