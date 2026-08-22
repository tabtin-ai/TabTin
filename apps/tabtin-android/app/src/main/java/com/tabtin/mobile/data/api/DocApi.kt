package com.tabtin.mobile.data.api

import com.tabtin.mobile.data.model.ApiEnvelope
import com.tabtin.mobile.data.model.CloudDocShareDisableResponse
import com.tabtin.mobile.data.model.CloudDocShareFetchResponse
import com.tabtin.mobile.data.model.CloudDocShareMutationResponse
import com.tabtin.mobile.data.model.CloudDocsCollaboratorsResponse
import com.tabtin.mobile.data.model.CloudDocsInviteRequest
import com.tabtin.mobile.data.model.CloudDocsUpdateCollaboratorRequest
import com.tabtin.mobile.data.model.SharedDocsResponse
import com.tabtin.mobile.data.model.doc.*
import kotlinx.serialization.json.JsonObject
import retrofit2.http.*

public interface DocApi {
    @GET("tabdoc/documents")
    public suspend fun listDocuments(
        @Query("organization_id") organizationId: String,
        @Query("parent_id") parentId: String? = null,
        @Query("include_archived") includeArchived: Boolean? = null,
    ): ApiEnvelope<DocListResponse>

    /**
     * 列出分享给我的文档（资源级协作，不依赖 Space 成员身份）。
     *
     * [organizationId] 为空时后端不过滤组织——调用方必须传有效组织 id。
     */
    @GET("tabdoc/shared-with-me")
    public suspend fun listSharedWithMe(
        @Query("organization_id") organizationId: String,
    ): ApiEnvelope<SharedDocsResponse>

    @POST("tabdoc/documents")
    public suspend fun createDocument(
        @Body body: CreateDocRequest,
    ): ApiEnvelope<DocDetailResponse>

    @GET("tabdoc/documents/{id}")
    public suspend fun getDocumentDetail(
        @Path("id") documentId: String,
    ): ApiEnvelope<DocDetailResponse>

    @PATCH("tabdoc/documents/{id}")
    public suspend fun updateDocument(
        @Path("id") documentId: String,
        @Body body: UpdateDocRequest,
    ): ApiEnvelope<DocSingleResponse>

    @POST("tabdoc/documents/{id}/content")
    public suspend fun saveContent(
        @Path("id") documentId: String,
        @Body body: SaveContentRequest,
    ): ApiEnvelope<SaveContentResponse>

    @DELETE("tabdoc/documents/{id}")
    public suspend fun archiveDocument(
        @Path("id") documentId: String,
    ): ApiEnvelope<Map<String, @JvmSuppressWildcards Any>>

    @GET("collab/v1/docs/{id}/versions")
    public suspend fun listHistories(
        @Path("id") documentId: String,
        @Query("limit") limit: Int = 50,
    ): CollabApiEnvelope<List<DocHistoryEntry>>

    @POST("collab/v1/docs/{id}/restore")
    public suspend fun restoreHistory(
        @Path("id") documentId: String,
        @Body body: RestoreHistoryRequest,
    ): CollabApiEnvelope<Map<String, String>>

    /** 文档公开分享：GET 不带 share_type，取当前生效那条。 */
    @GET("tabdoc/documents/{id}/share")
    public suspend fun getDocumentShare(
        @Path("id") documentId: String,
    ): ApiEnvelope<CloudDocShareFetchResponse>

    @POST("tabdoc/documents/{id}/share")
    public suspend fun upsertDocumentShare(
        @Path("id") documentId: String,
        @Body body: JsonObject,
    ): ApiEnvelope<CloudDocShareMutationResponse>

    /**
     * 关闭分享。必须显式传 [shareType]——与 table 侧对称，避免默认值漏关。
     */
    @DELETE("tabdoc/documents/{id}/share")
    public suspend fun disableDocumentShare(
        @Path("id") documentId: String,
        @Query("share_type") shareType: String,
    ): ApiEnvelope<CloudDocShareDisableResponse>

    /** 轮换 share_id；旧链接立即失效。 */
    @POST("tabdoc/documents/{id}/share/refresh")
    public suspend fun refreshDocumentShare(
        @Path("id") documentId: String,
        @Body body: JsonObject,
    ): ApiEnvelope<CloudDocShareMutationResponse>

    @GET("tabdoc/documents/{id}/collaborators")
    public suspend fun getCollaborators(@Path("id") documentId: String): ApiEnvelope<CloudDocsCollaboratorsResponse>

    @POST("tabdoc/documents/{id}/collaborators")
    public suspend fun inviteCollaborators(@Path("id") documentId: String, @Body body: CloudDocsInviteRequest): ApiEnvelope<Map<String, @JvmSuppressWildcards Any>>

    @PATCH("tabdoc/documents/{id}/collaborators/{userId}")
    public suspend fun updateCollaborator(@Path("id") documentId: String, @Path("userId") userId: String, @Body body: CloudDocsUpdateCollaboratorRequest): ApiEnvelope<Map<String, @JvmSuppressWildcards Any>>

    @DELETE("tabdoc/documents/{id}/collaborators/{userId}")
    public suspend fun removeCollaborator(@Path("id") documentId: String, @Path("userId") userId: String): ApiEnvelope<Map<String, @JvmSuppressWildcards Any>>

    @GET("tabdoc/documents/{id}/comment-threads")
    public suspend fun listCommentThreads(
        @Path("id") documentId: String,
    ): ApiEnvelope<CommentThreadListResponse>

    @POST("tabdoc/documents/{id}/comment-threads")
    public suspend fun createCommentThread(
        @Path("id") documentId: String,
        @Body body: CreateCommentThreadRequest,
    ): ApiEnvelope<CommentThreadCreateResponse>
}
