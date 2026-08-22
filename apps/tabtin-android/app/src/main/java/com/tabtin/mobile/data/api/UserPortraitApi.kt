package com.tabtin.mobile.data.api

import com.tabtin.mobile.data.model.ApiEnvelope
import com.tabtin.mobile.data.model.SnapshotListResponse
import com.tabtin.mobile.data.model.SubmitHintRequest
import com.tabtin.mobile.data.model.UserPortrait
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query

/**
 * UserPortrait Retrofit API（per-Agent）。
 *
 * 严格对齐 Electron `apps/tabtin-electron/src/renderer/src/services/userPortraitApi.ts`：
 *
 *   GET    /user-portrait/me/{organization_id}?agent_id=...                获取画像
 *   POST   /user-portrait/me/{organization_id}/hint?agent_id=...           提交 hint（实时触发蒸馏）
 *   POST   /user-portrait/me/{organization_id}/distill?agent_id=...        主动触发蒸馏
 *   GET    /user-portrait/me/{organization_id}/snapshots?agent_id=...      历史快照
 *
 * 错误码（来自后端 ErrorCode）：
 *   PORTRAIT_NOT_FOUND / INVALID_HINT / INVALID_ORGANIZATION_ID / INVALID_INPUT
 *   DISTILL_IN_PROGRESS / DISTILL_FAILED / UNAUTHORIZED / PERMISSION_DENIED
 *
 * 失败时 [unwrap] 抛 [com.tabtin.mobile.data.model.AppError.RequestFailed]；
 * 上层 (UserPortraitViewModel) 把 HTTP / 网络异常归并到 [UserPortraitApiException]
 * 用于 banner / notice 展示。
 */
public interface UserPortraitApi {

    @GET("user-portrait/me/{organization_id}")
    public suspend fun getMyPortrait(
        @Path("organization_id") organizationId: String,
        @Query("agent_id") agentId: String,
    ): ApiEnvelope<UserPortrait>

    @POST("user-portrait/me/{organization_id}/hint")
    public suspend fun submitHint(
        @Path("organization_id") organizationId: String,
        @Query("agent_id") agentId: String,
        @Body body: SubmitHintRequest,
    ): ApiEnvelope<UserPortrait>

    @POST("user-portrait/me/{organization_id}/distill")
    public suspend fun triggerDistill(
        @Path("organization_id") organizationId: String,
        @Query("agent_id") agentId: String,
        // 后端历史兼容：body 是空对象，发送 {} 即可
        @Body body: Map<String, String> = emptyMap(),
    ): ApiEnvelope<UserPortrait>

    @GET("user-portrait/me/{organization_id}/snapshots")
    public suspend fun listSnapshots(
        @Path("organization_id") organizationId: String,
        @Query("agent_id") agentId: String,
        @Query("limit") limit: Int = 20,
    ): ApiEnvelope<SnapshotListResponse>
}

/**
 * UserPortrait API 异常 —— 与 Electron `UserPortraitApiError` 同款字段集
 * （message / statusCode / errorCode），方便 UI 统一处理。
 */
public class UserPortraitApiException(
    public val statusCode: Int,
    public val errorCode: String? = null,
    message: String? = null,
    cause: Throwable? = null,
) : Exception(message, cause)
