package com.tabtin.mobile.data.api

import com.tabtin.mobile.data.model.ApiEnvelope
import com.tabtin.mobile.data.model.CloudDocShareDisableResponse
import com.tabtin.mobile.data.model.CloudDocShareFetchResponse
import com.tabtin.mobile.data.model.CloudDocShareMutationResponse
import com.tabtin.mobile.data.model.CloudDocsCollaboratorsResponse
import com.tabtin.mobile.data.model.CloudDocsInviteRequest
import com.tabtin.mobile.data.model.CloudDocsUpdateCollaboratorRequest
import com.tabtin.mobile.data.model.SharedTablesResponse
import com.tabtin.mobile.data.model.files.CreateTableRequest
import com.tabtin.mobile.data.model.files.CreateTableResponse
import com.tabtin.mobile.data.model.tabdata.TabDataBulkUpdateRequest
import com.tabtin.mobile.data.model.tabdata.TabDataBulkUpdateResponse
import com.tabtin.mobile.data.model.tabdata.TabDataCreateRecordRequest
import com.tabtin.mobile.data.model.tabdata.TabDataCreateFieldRequest
import com.tabtin.mobile.data.model.tabdata.TabDataField
import com.tabtin.mobile.data.model.tabdata.TabDataFieldsResponse
import com.tabtin.mobile.data.model.tabdata.TabDataRecord
import com.tabtin.mobile.data.model.tabdata.TabDataTable
import com.tabtin.mobile.data.model.tabdata.TabDataUpdateRecordRequest
import com.tabtin.mobile.data.model.tabdata.TabDataViewRecordsResponse
import com.tabtin.mobile.data.model.tabdata.TabDataViewsResponse
import kotlinx.serialization.json.JsonObject
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.PATCH
import retrofit2.http.Query
import retrofit2.http.PUT

/**
 * TabData（表格）相关 HTTP 接口。
 *
 * 公开链接的 share_type 公网值为 `data`（不是 doc 的 `public`），且没有 `/share/refresh`。
 */
public interface TabDataApi {
    /**
     * 列出分享给我的表格（资源级协作，不依赖 Space 成员身份）。
     *
     * [organizationId] 为空时后端不过滤组织——调用方必须传有效组织 id。
     */
    @GET("tabdata/shared-with-me")
    public suspend fun listSharedWithMe(
        @Query("organization_id") organizationId: String,
    ): ApiEnvelope<SharedTablesResponse>

    /** 在 Organization 下创建多维表；可直接带 [CreateTableRequest.collectionId]。 */
    @POST("tabdata/tables")
    public suspend fun createTable(
        @Body body: CreateTableRequest,
    ): ApiEnvelope<CreateTableResponse>

    @GET("tabdata/tables/{id}")
    public suspend fun getTable(
        @Path("id") tableId: String,
    ): ApiEnvelope<TabDataTable>

    @GET("tabdata/tables/{id}/views")
    public suspend fun listViews(
        @Path("id") tableId: String,
    ): ApiEnvelope<TabDataViewsResponse>

    @GET("tabdata/tables/{id}/fields")
    public suspend fun listFields(
        @Path("id") tableId: String,
    ): ApiEnvelope<TabDataFieldsResponse>

    @POST("tabdata/fields")
    public suspend fun createField(
        @Body body: TabDataCreateFieldRequest,
    ): ApiEnvelope<TabDataField>

    /** grid/list 使用顶层 records；kanban 使用 metadata.groups 内的独立分页记录。 */
    @GET("tabdata/views/{id}/records")
    public suspend fun getViewRecords(
        @Path("id") viewId: String,
        @Query("page") page: Int = 1,
        @Query("page_size") pageSize: Int = 50,
        @Query("field_key_type") fieldKeyType: String = "name",
        @Query("search") search: String? = null,
        @Query("search_hide_not_match_rows") searchHideNotMatchRows: Boolean = true,
        @Query("filters") filtersJson: String? = null,
        @Query("filter_logic") filterLogic: String? = null,
        @Query("groups") groupsJson: String? = null,
        @Query("sorts") sortsJson: String? = null,
        @Query("per_group_limit") perGroupLimit: Int? = null,
        @Query("group_offsets") groupOffsetsJson: String? = null,
    ): ApiEnvelope<TabDataViewRecordsResponse>

    @GET("tabdata/records/{id}")
    public suspend fun getRecord(
        @Path("id") recordId: String,
        @Query("field_key_type") fieldKeyType: String = "name",
    ): ApiEnvelope<TabDataRecord>

    @POST("tabdata/records")
    public suspend fun createRecord(
        @Body body: TabDataCreateRecordRequest,
    ): ApiEnvelope<TabDataRecord>

    @PUT("tabdata/records/{id}")
    public suspend fun updateRecord(
        @Path("id") recordId: String,
        @Body body: TabDataUpdateRecordRequest,
    ): ApiEnvelope<TabDataRecord>

    @POST("tabdata/records/bulk-update")
    public suspend fun bulkUpdateRecords(
        @Body body: TabDataBulkUpdateRequest,
        @Query("field_key_type") fieldKeyType: String = "id",
    ): ApiEnvelope<TabDataBulkUpdateResponse>

    @DELETE("tabdata/records/{id}")
    public suspend fun deleteRecord(
        @Path("id") recordId: String,
        @Query("expected_version") expectedVersion: Long? = null,
    ): ApiEnvelope<JsonObject>

    @GET("tabdata/tables/{id}/share")
    public suspend fun getTableShare(
        @Path("id") tableId: String,
    ): ApiEnvelope<CloudDocShareFetchResponse>

    @POST("tabdata/tables/{id}/share")
    public suspend fun upsertTableShare(
        @Path("id") tableId: String,
        @Body body: JsonObject,
    ): ApiEnvelope<CloudDocShareMutationResponse>

    /**
     * 关闭分享。
     *
     * TabData DELETE 省略 [shareType] 时默认 `data`，组织内分享会被静默漏关——必须显式传。
     */
    @DELETE("tabdata/tables/{id}/share")
    public suspend fun disableTableShare(
        @Path("id") tableId: String,
        @Query("share_type") shareType: String,
    ): ApiEnvelope<CloudDocShareDisableResponse>

    @GET("tabdata/tables/{id}/collaborators")
    public suspend fun getCollaborators(@Path("id") tableId: String): ApiEnvelope<CloudDocsCollaboratorsResponse>

    @POST("tabdata/tables/{id}/collaborators")
    public suspend fun inviteCollaborators(@Path("id") tableId: String, @Body body: CloudDocsInviteRequest): ApiEnvelope<Map<String, @JvmSuppressWildcards Any>>

    @PATCH("tabdata/tables/{id}/collaborators/{userId}")
    public suspend fun updateCollaborator(@Path("id") tableId: String, @Path("userId") userId: String, @Body body: CloudDocsUpdateCollaboratorRequest): ApiEnvelope<Map<String, @JvmSuppressWildcards Any>>

    @DELETE("tabdata/tables/{id}/collaborators/{userId}")
    public suspend fun removeCollaborator(@Path("id") tableId: String, @Path("userId") userId: String): ApiEnvelope<Map<String, @JvmSuppressWildcards Any>>
}
