package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.api.TrackerApi
import com.tabtin.mobile.data.model.tracker.CheckpointProvideRequest
import com.tabtin.mobile.data.model.tracker.CreateTrackerRequest
import com.tabtin.mobile.data.model.tracker.Tracker
import com.tabtin.mobile.data.model.tracker.TrackerRun
import com.tabtin.mobile.data.model.tracker.TrackerSkillParams
import com.tabtin.mobile.data.model.tracker.TrackerTemplate
import com.tabtin.mobile.data.model.tracker.UpdateTrackerRequest
import com.tabtin.mobile.util.TokenManager
import kotlinx.serialization.json.JsonObject
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
public class TrackerRepository @Inject constructor(
    private val trackerApi: TrackerApi,
    private val tokenManager: TokenManager,
) {
    private fun requireOrganizationId(): String =
        tokenManager.organizationId ?: throw IllegalStateException("No organization selected")

    public suspend fun getEvents(spaceId: String? = null): List<Tracker> =
        trackerApi.getEvents(requireOrganizationId(), spaceId).unwrap().trackers

    public suspend fun getEvent(eventId: String): Tracker =
        trackerApi.getEvent(eventId).unwrap()

    public suspend fun getTemplates(locale: String = "zh-CN"): List<TrackerTemplate> =
        trackerApi.getTemplates(locale).unwrap().templates

    public suspend fun createEvent(
        name: String,
        description: String = "",
        hostSpaceId: String,
        workspaceId: String,
        agentId: String,
    ): Tracker {
        val instructions = description.ifBlank { name }
        val request = CreateTrackerRequest(
            name = name,
            description = description,
            skillParams = TrackerSkillParams(instructions = instructions),
            agentId = agentId,
            workspaceId = workspaceId,
        )
        return trackerApi.createEvent(requireOrganizationId(), hostSpaceId, request).unwrap()
    }

    /**
     * 手机自动化的创建契约：执行 Workspace 同时是 host Space，创建后由调用方立即 activate。
     * 这避免了任务显示在一个现场、实际运行在另一个现场的歧义。
     */
    public suspend fun createMobileAutomation(
        name: String,
        instructions: String,
        triggerType: String,
        triggerConfig: JsonObject,
        agentId: String,
        workspaceId: String,
        intentSnapshot: JsonObject,
    ): Tracker {
        val request = CreateTrackerRequest(
            name = name,
            triggerType = triggerType,
            triggerConfig = triggerConfig,
            skillParams = TrackerSkillParams(instructions = instructions),
            intentSnapshot = intentSnapshot,
            agentId = agentId,
            workspaceId = workspaceId,
        )
        return trackerApi.createEvent(
            organizationId = requireOrganizationId(),
            spaceId = workspaceId,
            body = request,
        ).unwrap()
    }

    public suspend fun updateEvent(eventId: String, name: String? = null, description: String? = null): Tracker =
        trackerApi.updateEvent(eventId, UpdateTrackerRequest(name = name, description = description)).unwrap()

    public suspend fun deleteEvent(eventId: String) {
        trackerApi.deleteEvent(eventId).unwrap()
    }

    public suspend fun activateEvent(eventId: String): Tracker =
        trackerApi.activateEvent(eventId).unwrap()

    public suspend fun pauseEvent(eventId: String) {
        trackerApi.pauseEvent(eventId).unwrap()
    }

    public suspend fun resumeEvent(eventId: String) {
        trackerApi.resumeEvent(eventId).unwrap()
    }

    public suspend fun triggerEvent(eventId: String): TrackerRun =
        trackerApi.triggerEvent(eventId).unwrap()

    public suspend fun getRuns(eventId: String): List<TrackerRun> =
        trackerApi.getRuns(eventId).unwrap().runs

    public suspend fun cancelRun(eventId: String, runId: String) {
        trackerApi.cancelRun(eventId, runId).unwrap()
    }

    public suspend fun checkpointContinue(stepRunId: String): TrackerRun =
        trackerApi.checkpointContinue(stepRunId).unwrap()

    public suspend fun checkpointProvide(stepRunId: String, userInput: String): TrackerRun =
        trackerApi.checkpointProvide(stepRunId, CheckpointProvideRequest(userInput)).unwrap()

    public suspend fun checkpointAbort(stepRunId: String): TrackerRun =
        trackerApi.checkpointAbort(stepRunId).unwrap()
}
