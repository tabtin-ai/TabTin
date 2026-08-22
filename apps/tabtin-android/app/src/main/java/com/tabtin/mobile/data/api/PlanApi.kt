package com.tabtin.mobile.data.api

import com.tabtin.mobile.data.model.ApiEnvelope
import com.tabtin.mobile.data.model.PlanExitRequest
import com.tabtin.mobile.data.model.PlanExitResponse
import retrofit2.http.Body
import retrofit2.http.POST

public interface PlanApi {
    @POST("plan/exit")
    public suspend fun exit(@Body body: PlanExitRequest): ApiEnvelope<PlanExitResponse>
}
