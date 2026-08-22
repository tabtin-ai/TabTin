package com.tabtin.mobile.data.api

import com.tabtin.mobile.data.model.ApiEnvelope
import com.tabtin.mobile.data.model.slide.TabSlideDetailResponse
import retrofit2.http.GET
import retrofit2.http.Path

public interface TabSlideApi {
    @GET("tabslide/projects/{id}/")
    public suspend fun getSlideDetail(
        @Path("id") slideId: String,
    ): ApiEnvelope<TabSlideDetailResponse>
}
