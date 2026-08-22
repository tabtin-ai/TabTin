package com.tabtin.mobile.data.api

import com.tabtin.mobile.data.model.ApiEnvelope
import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.data.model.files.CloudDriveFileMountRequest
import com.tabtin.mobile.data.model.files.CloudFileDownloadUrlResponse
import com.tabtin.mobile.data.model.files.TabFilesCollaboratorsResponse
import com.tabtin.mobile.data.model.files.TabFilesInviteCollaboratorsRequest
import com.tabtin.mobile.data.model.files.TabFilesUpdateCollaboratorRequest
import kotlinx.serialization.json.JsonObject
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.PATCH
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query

/**
 * TabFiles / 云盘文件签名下载与预览、Organization mount、回收站与协作者。
 *
 * 身份规则：
 * - [contextItemId]：列表 / 移动 / 访问上报 / 签名下载
 * - [fileRecordId]：分享 / 回收站 / 恢复 / 永久删除 / 协作者
 */
public interface TabFilesApi {

    /**
     * 获取签名 URL。
     * - 不传 [previewMaxBytes] → 附件下载
     * - 传入正整数 → 内联预览（后端再按 MIME / 大小护栏）
     */
    @GET("context/organizations/{organizationId}/files/{contextItemId}/download-url")
    public suspend fun getDownloadUrl(
        @Path("organizationId") organizationId: String,
        @Path("contextItemId") contextItemId: String,
        @Query("preview_max_bytes") previewMaxBytes: Int? = null,
    ): ApiEnvelope<CloudFileDownloadUrlResponse>

    /**
     * 将已 confirm 的 FileRecord 挂载到 Organization 云盘。
     * OSS confirm 与 mount 非同一事务；mount 失败应持久化 pendingMount 后重试。
     */
    @POST("context/organizations/{organizationId}/files/upload")
    public suspend fun mountFileToOrganization(
        @Path("organizationId") organizationId: String,
        @Body body: CloudDriveFileMountRequest,
    ): ApiEnvelope<SpaceResource>

    /** 移入回收站。路径参数必须是 FileRecordID。 */
    @POST("context/organizations/{organizationId}/files/{fileRecordId}/trash")
    public suspend fun trashOrganizationFile(
        @Path("organizationId") organizationId: String,
        @Path("fileRecordId") fileRecordId: String,
    ): ApiEnvelope<JsonObject>

    /** 从回收站恢复。路径参数必须是 FileRecordID。 */
    @POST("context/organizations/{organizationId}/files/{fileRecordId}/restore")
    public suspend fun restoreOrganizationFile(
        @Path("organizationId") organizationId: String,
        @Path("fileRecordId") fileRecordId: String,
    ): ApiEnvelope<SpaceResource>

    /** 永久删除回收站中的文件。路径参数必须是 FileRecordID。 */
    @DELETE("context/organizations/{organizationId}/files/{fileRecordId}/permanent")
    public suspend fun permanentDeleteOrganizationFile(
        @Path("organizationId") organizationId: String,
        @Path("fileRecordId") fileRecordId: String,
    ): ApiEnvelope<JsonObject>

    @GET("context/files/{fileRecordId}/collaborators")
    public suspend fun listFileCollaborators(
        @Path("fileRecordId") fileRecordId: String,
    ): ApiEnvelope<TabFilesCollaboratorsResponse>

    @POST("context/files/{fileRecordId}/collaborators")
    public suspend fun inviteFileCollaborators(
        @Path("fileRecordId") fileRecordId: String,
        @Body body: TabFilesInviteCollaboratorsRequest,
    ): ApiEnvelope<TabFilesCollaboratorsResponse>

    @PATCH("context/files/{fileRecordId}/collaborators/{userId}")
    public suspend fun updateFileCollaborator(
        @Path("fileRecordId") fileRecordId: String,
        @Path("userId") userId: String,
        @Body body: TabFilesUpdateCollaboratorRequest,
    ): ApiEnvelope<TabFilesCollaboratorsResponse>

    @DELETE("context/files/{fileRecordId}/collaborators/{userId}")
    public suspend fun revokeFileCollaborator(
        @Path("fileRecordId") fileRecordId: String,
        @Path("userId") userId: String,
    ): ApiEnvelope<JsonObject>
}
