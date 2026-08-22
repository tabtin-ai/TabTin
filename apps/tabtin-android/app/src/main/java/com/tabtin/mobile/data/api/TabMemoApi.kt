package com.tabtin.mobile.data.api

import com.tabtin.mobile.data.model.ApiEnvelope
import com.tabtin.mobile.data.model.memo.AgentDiaryFeedResponse
import com.tabtin.mobile.data.model.memo.AttachmentAddRequest
import com.tabtin.mobile.data.model.memo.AttachmentOut
import com.tabtin.mobile.data.model.memo.BookmarkPreview
import com.tabtin.mobile.data.model.memo.BookmarkPreviewRequest
import com.tabtin.mobile.data.model.memo.CollectionAddMemosRequest
import com.tabtin.mobile.data.model.memo.MemoCollection
import com.tabtin.mobile.data.model.memo.MemoCollectionListResponse
import com.tabtin.mobile.data.model.memo.MemoCreateRequest
import com.tabtin.mobile.data.model.memo.MemoDetail
import com.tabtin.mobile.data.model.memo.MemoHeatmapResponse
import com.tabtin.mobile.data.model.memo.MemoListResponse
import com.tabtin.mobile.data.model.memo.MemoPinRequest
import com.tabtin.mobile.data.model.memo.MemoSummary
import com.tabtin.mobile.data.model.memo.MemoTagStatsResponse
import com.tabtin.mobile.data.model.memo.MemoUpdateRequest
import com.tabtin.mobile.data.model.memo.RecordStyleConfig
import com.tabtin.mobile.data.model.memo.RecordStyleUpdateRequest
import kotlinx.serialization.json.JsonObject
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.PATCH
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query

public interface TabMemoApi {

    // ── 记忆记录偏好（per-(user, organization)）────────────────────

    @GET("tabmemo/record-style/")
    public suspend fun getRecordStyle(
        @Query("organization_id") organizationId: String,
    ): ApiEnvelope<RecordStyleConfig>

    @PATCH("tabmemo/record-style/")
    public suspend fun updateRecordStyle(
        @Query("organization_id") organizationId: String,
        @Body body: RecordStyleUpdateRequest,
    ): ApiEnvelope<RecordStyleConfig>

    // ── Memo CRUD ─────────────────────────────────────────

    @GET("tabmemo/memos/")
    public suspend fun listMemos(
        @Query("organization_id") organizationId: String,
        @Query("space_id") spaceId: String? = null,
        @Query("status") status: String? = "active",
        @Query("sort") sort: String? = "-created_at",
        @Query("limit") limit: Int? = null,
        @Query("cursor") cursor: String? = null,
        @Query("search") search: String? = null,
        @Query("color") color: String? = null,
        @Query("collection_id") collectionId: String? = null,
        @Query("memo_type") memoType: String? = null,
        @Query("tags") tags: String? = null,
        @Query("source") source: String? = null,
        @Query("created_after") createdAfter: String? = null,
        @Query("created_before") createdBefore: String? = null,
    ): ApiEnvelope<MemoListResponse>

    @GET("tabmemo/stats/heatmap/")
    public suspend fun getHeatmap(
        @Query("organization_id") organizationId: String,
        @Query("days") days: Int? = 84,
    ): ApiEnvelope<MemoHeatmapResponse>

    @GET("tabmemo/tags/stats/")
    public suspend fun getTagStats(
        @Query("organization_id") organizationId: String,
    ): ApiEnvelope<MemoTagStatsResponse>

    /** Organization 级跨 Agent diary（AgentMemory 正典）。 */
    @GET("agent-memory/diary-feed/")
    public suspend fun listOrgDiaryFeed(
        @Query("organization_id") organizationId: String,
        @Query("state") state: String? = "active",
        @Query("search") search: String? = null,
        @Query("cursor") cursor: String? = null,
        @Query("limit") limit: Int? = null,
    ): ApiEnvelope<AgentDiaryFeedResponse>

    @POST("tabmemo/memos/")
    public suspend fun createMemo(@Body body: MemoCreateRequest): ApiEnvelope<MemoDetail>

    @GET("tabmemo/memos/{id}/")
    public suspend fun getMemo(@Path("id") id: String): ApiEnvelope<MemoDetail>

    @PATCH("tabmemo/memos/{id}/")
    public suspend fun updateMemo(
        @Path("id") id: String,
        @Body body: MemoUpdateRequest,
    ): ApiEnvelope<MemoSummary>

    /**
     * DELETE /memos/{id}/ 服务端语义是移入回收站（与 POST /trash/ 相同），
     * 不是归档。归档请用 [archiveMemo]。
     */
    @DELETE("tabmemo/memos/{id}/")
    public suspend fun deleteMemo(@Path("id") id: String): ApiEnvelope<JsonObject>

    @POST("tabmemo/memos/{id}/archive/")
    public suspend fun archiveMemo(
        @Path("id") id: String,
        @Body body: JsonObject,
    ): ApiEnvelope<JsonObject>

    @POST("tabmemo/memos/{id}/pin/")
    public suspend fun pinMemo(
        @Path("id") id: String,
        @Body body: MemoPinRequest,
    ): ApiEnvelope<MemoSummary>

    @POST("tabmemo/memos/{id}/retag/")
    public suspend fun retagMemo(
        @Path("id") id: String,
        @Body body: JsonObject,
    ): ApiEnvelope<JsonObject>

    @POST("tabmemo/memos/{id}/restore/")
    public suspend fun restoreMemo(
        @Path("id") id: String,
        @Body body: JsonObject,
    ): ApiEnvelope<MemoSummary>

    @POST("tabmemo/memos/{id}/trash/")
    public suspend fun trashMemo(
        @Path("id") id: String,
        @Body body: JsonObject,
    ): ApiEnvelope<JsonObject>

    @POST("tabmemo/memos/{id}/restore-from-trash/")
    public suspend fun restoreMemoFromTrash(
        @Path("id") id: String,
        @Body body: JsonObject,
    ): ApiEnvelope<MemoSummary>

    @POST("tabmemo/memos/{id}/attachments/")
    public suspend fun addAttachment(
        @Path("id") id: String,
        @Body body: AttachmentAddRequest,
    ): ApiEnvelope<AttachmentOut>

    // ── Collection ───────────────────────────────────────

    @GET("tabmemo/collections/")
    public suspend fun listCollections(
        @Query("organization_id") organizationId: String,
        @Query("space_id") spaceId: String? = null,
    ): ApiEnvelope<MemoCollectionListResponse>

    @POST("tabmemo/collections/{id}/memos/")
    public suspend fun addMemosToCollection(
        @Path("id") id: String,
        @Body body: CollectionAddMemosRequest,
    ): ApiEnvelope<JsonObject>

    @DELETE("tabmemo/collections/{id}/memos/{memoId}/")
    public suspend fun removeMemoFromCollection(
        @Path("id") id: String,
        @Path("memoId") memoId: String,
    ): ApiEnvelope<JsonObject>

    // ── Bookmark Preview ──────────────────────────────────

    @POST("tabmemo/bookmark-preview/")
    public suspend fun bookmarkPreview(@Body body: BookmarkPreviewRequest): ApiEnvelope<BookmarkPreview>
}
