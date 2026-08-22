package com.tabtin.mobile.data.api

import com.tabtin.mobile.data.model.ApiEnvelope
import com.tabtin.mobile.data.model.tracker.CheckpointProvideRequest
import com.tabtin.mobile.data.model.tracker.CreateTrackerRequest
import com.tabtin.mobile.data.model.tracker.Tracker
import com.tabtin.mobile.data.model.tracker.TrackerListResponse
import com.tabtin.mobile.data.model.tracker.TrackerRun
import com.tabtin.mobile.data.model.tracker.TrackerRunListResponse
import com.tabtin.mobile.data.model.tracker.TrackerTemplateListResponse
import com.tabtin.mobile.data.model.tracker.UpdateTrackerRequest
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.PUT
import retrofit2.http.Path
import retrofit2.http.Query

public interface TrackerApi {
    @GET("tracker/templates")
    public suspend fun getTemplates(
        @Query("locale") locale: String = "zh-CN",
    ): ApiEnvelope<TrackerTemplateListResponse>

    @GET("tracker/events")
    public suspend fun getEvents(
        @Query("organization_id") organizationId: String,
        @Query("space_id") spaceId: String? = null,
    ): ApiEnvelope<TrackerListResponse>

    @GET("tracker/events/{eventId}")
    public suspend fun getEvent(
        @Path("eventId") eventId: String,
    ): ApiEnvelope<Tracker>

    @POST("tracker/events")
    public suspend fun createEvent(
        @Query("organization_id") organizationId: String,
        @Query("space_id") spaceId: String? = null,
        @Body body: CreateTrackerRequest,
    ): ApiEnvelope<Tracker>

    @PUT("tracker/events/{eventId}")
    public suspend fun updateEvent(
        @Path("eventId") eventId: String,
        @Body body: UpdateTrackerRequest,
    ): ApiEnvelope<Tracker>

    @DELETE("tracker/events/{eventId}")
    public suspend fun deleteEvent(
        @Path("eventId") eventId: String,
    ): ApiEnvelope<Unit>

    @POST("tracker/events/{eventId}/activate")
    public suspend fun activateEvent(
        @Path("eventId") eventId: String,
    ): ApiEnvelope<Tracker>

    @POST("tracker/events/{eventId}/pause")
    public suspend fun pauseEvent(
        @Path("eventId") eventId: String,
    ): ApiEnvelope<Unit>

    @POST("tracker/events/{eventId}/resume")
    public suspend fun resumeEvent(
        @Path("eventId") eventId: String,
    ): ApiEnvelope<Unit>

    @POST("tracker/events/{eventId}/trigger")
    public suspend fun triggerEvent(
        @Path("eventId") eventId: String,
    ): ApiEnvelope<TrackerRun>

    @GET("tracker/events/{eventId}/runs")
    public suspend fun getRuns(
        @Path("eventId") eventId: String,
    ): ApiEnvelope<TrackerRunListResponse>

    @POST("tracker/events/{eventId}/runs/{runId}/cancel")
    public suspend fun cancelRun(
        @Path("eventId") eventId: String,
        @Path("runId") runId: String,
    ): ApiEnvelope<Unit>

    @POST("tracker/step-runs/{stepRunId}/checkpoint/continue")
    public suspend fun checkpointContinue(
        @Path("stepRunId") stepRunId: String,
    ): ApiEnvelope<TrackerRun>

    @POST("tracker/step-runs/{stepRunId}/checkpoint/provide")
    public suspend fun checkpointProvide(
        @Path("stepRunId") stepRunId: String,
        @Body body: CheckpointProvideRequest,
    ): ApiEnvelope<TrackerRun>

    @POST("tracker/step-runs/{stepRunId}/checkpoint/abort")
    public suspend fun checkpointAbort(
        @Path("stepRunId") stepRunId: String,
    ): ApiEnvelope<TrackerRun>
}
