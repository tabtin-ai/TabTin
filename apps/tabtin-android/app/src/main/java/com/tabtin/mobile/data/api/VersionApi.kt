package com.tabtin.mobile.data.api

import com.tabtin.mobile.data.model.ApiEnvelope
import com.tabtin.mobile.data.model.VersionGateDecision
import retrofit2.http.GET
import retrofit2.http.Query

/** 移动端版本门禁（匿名接口）。 */
public interface VersionApi {
    @GET("client/version-gate")
    public suspend fun checkVersionGate(
        @Query("platform") platform: String = "android",
        @Query("build") build: Int,
    ): ApiEnvelope<VersionGateDecision>
}
