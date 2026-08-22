package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.api.DocApi
import com.tabtin.mobile.data.api.TabDataApi
import com.tabtin.mobile.data.api.apiErrorMessage
import com.tabtin.mobile.data.api.json
import com.tabtin.mobile.data.api.resolveEffectiveWebBaseUrl
import com.tabtin.mobile.data.model.AppError
import com.tabtin.mobile.data.model.CloudDocShare
import com.tabtin.mobile.data.model.CloudDocsCollaborator
import com.tabtin.mobile.data.model.CloudDocsCollaboratorsResponse
import com.tabtin.mobile.data.model.CloudDocsInviteRequest
import com.tabtin.mobile.data.model.CloudDocsUpdateCollaboratorRequest
import com.tabtin.mobile.data.model.CloudDocsShareError
import com.tabtin.mobile.data.model.CloudSharePermission
import com.tabtin.mobile.data.model.CloudShareResourceType
import com.tabtin.mobile.data.model.CloudShareScope
import com.tabtin.mobile.util.TokenManager
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import retrofit2.HttpException
import javax.inject.Inject
import javax.inject.Singleton

/**
 * 云文档 / 表格公开分享链接的管理服务。
 *
 * 协作者邀请不在本服务范围。表格没有 `/share/refresh`，轮换走 disable + upsert。
 */
@Singleton
public class CloudDocsShareService @Inject constructor(
    private val docApi: DocApi,
    private val tabDataApi: TabDataApi,
    private val tokenManager: TokenManager,
) {
    public suspend fun collaborators(type: CloudShareResourceType, resourceId: String): CloudDocsCollaboratorsResponse = wrap {
        val id = requireResourceId(resourceId)
        when (type) {
            CloudShareResourceType.DOCUMENT -> docApi.getCollaborators(id).unwrap()
            CloudShareResourceType.TABLE -> tabDataApi.getCollaborators(id).unwrap()
        }
    }

    public suspend fun inviteCollaborators(type: CloudShareResourceType, resourceId: String, userIds: List<String>, permission: String) {
        val ids = userIds.map(String::trim).filter(String::isNotEmpty).distinct()
        if (ids.isEmpty()) return
        wrap {
            val id = requireResourceId(resourceId)
            val body = CloudDocsInviteRequest(ids, permission)
            when (type) {
                CloudShareResourceType.DOCUMENT -> docApi.inviteCollaborators(id, body).unwrap()
                CloudShareResourceType.TABLE -> tabDataApi.inviteCollaborators(id, body).unwrap()
            }
        }
    }

    public suspend fun updateCollaborator(type: CloudShareResourceType, resourceId: String, userId: String, permission: String) {
        wrap {
            val id = requireResourceId(resourceId)
            val user = requireResourceId(userId)
            val body = CloudDocsUpdateCollaboratorRequest(permission)
            when (type) {
                CloudShareResourceType.DOCUMENT -> docApi.updateCollaborator(id, user, body).unwrap()
                CloudShareResourceType.TABLE -> tabDataApi.updateCollaborator(id, user, body).unwrap()
            }
        }
    }

    public suspend fun removeCollaborator(type: CloudShareResourceType, resourceId: String, userId: String) {
        wrap {
            val id = requireResourceId(resourceId)
            val user = requireResourceId(userId)
            when (type) {
                CloudShareResourceType.DOCUMENT -> docApi.removeCollaborator(id, user).unwrap()
                CloudShareResourceType.TABLE -> tabDataApi.removeCollaborator(id, user).unwrap()
            }
        }
    }
    /**
     * 当前生效的分享。没开过时后端返回 `{ share: null, enabled: false }` → `null`。
     *
     * GET 不带 `share_type`：后端返回当前生效那条。
     */
    public suspend fun fetch(
        type: CloudShareResourceType,
        resourceId: String,
    ): CloudDocShare? = wrap {
        val id = requireResourceId(resourceId)
        val response = when (type) {
            CloudShareResourceType.DOCUMENT -> docApi.getDocumentShare(id).unwrap()
            CloudShareResourceType.TABLE -> tabDataApi.getTableShare(id).unwrap()
        }
        if (response.enabled == false) return@wrap null
        response.share
    }

    /**
     * 开启或更新。
     *
     * [password] 语义：`null` = 不改动（省略键）、`""` = 清除密码、非空 = 设置密码。
     * 扩到公网（anyone）须 [acknowledgePublicExposure] == true，否则后端 409。
     */
    public suspend fun upsert(
        type: CloudShareResourceType,
        resourceId: String,
        scope: CloudShareScope,
        permission: CloudSharePermission,
        password: String?,
        acknowledgePublicExposure: Boolean,
    ): CloudDocShare = wrap {
        val id = requireResourceId(resourceId)
        val body = buildUpsertBody(
            type = type,
            scope = scope,
            permission = permission,
            password = password,
            acknowledgePublicExposure = acknowledgePublicExposure,
        )
        when (type) {
            CloudShareResourceType.DOCUMENT ->
                docApi.upsertDocumentShare(id, body).unwrap().share
            CloudShareResourceType.TABLE ->
                tabDataApi.upsertTableShare(id, body).unwrap().share
        }
    }

    public suspend fun disable(
        type: CloudShareResourceType,
        resourceId: String,
        scope: CloudShareScope,
    ) {
        wrap {
            val id = requireResourceId(resourceId)
            val shareType = scope.wireValue(type)
            when (type) {
                CloudShareResourceType.DOCUMENT ->
                    docApi.disableDocumentShare(id, shareType).requireSuccess()
                CloudShareResourceType.TABLE ->
                    tabDataApi.disableTableShare(id, shareType).requireSuccess()
            }
        }
    }

    /**
     * 轮换链接。
     *
     * - document：`POST .../share/refresh`
     * - table：disable + upsert（与 Electron / iOS 同源）；失败会再尝试一次恢复 upsert，
     *   仍失败则抛第一次 upsert 错误——分享可能已被关掉，调用方应重新 fetch 校准状态。
     */
    public suspend fun refresh(
        type: CloudShareResourceType,
        resourceId: String,
        scope: CloudShareScope,
        permission: CloudSharePermission,
    ): CloudDocShare = when (type) {
        CloudShareResourceType.DOCUMENT -> refreshDocument(resourceId, scope)
        CloudShareResourceType.TABLE -> refreshTableByDisableUpsert(resourceId, scope, permission)
    }

    /** `{webBaseURL}/shared/docs|tables/{shareId}`。路径段用的是 share_id，不是资源 id。 */
    public fun publicUrl(shareId: String, type: CloudShareResourceType): String? =
        publicUrl(shareId, type, resolveEffectiveWebBaseUrl(tokenManager))

    public companion object {
        public const val PUBLIC_EXPOSURE_ACK_REQUIRED: String = "PUBLIC_EXPOSURE_ACK_REQUIRED"
        public const val PERMISSION_DENIED: String = "PERMISSION_DENIED"

        public fun publicUrl(
            shareId: String,
            type: CloudShareResourceType,
            webBaseUrl: String,
        ): String? {
            val trimmed = shareId.trim()
            if (trimmed.isEmpty()) return null
            var base = webBaseUrl.trim()
            while (base.endsWith('/')) {
                base = base.dropLast(1)
            }
            if (base.isEmpty()) return null
            return "$base/shared/${type.publicPathSegment}/$trimmed"
        }

        /**
         * 把 HTTP / 信封错误映射成分享域错误。
         *
         * - 403 → Forbidden
         * - 409 → PublicExposureNotAcknowledged（分享 upsert 上唯一 409 为 ACK）
         * - **401 不并入 Forbidden**（身份问题，应重新登录）
         * - 业务码 `PUBLIC_EXPOSURE_ACK_REQUIRED` / `PERMISSION_DENIED` 同样映射
         */
        public fun mapError(error: Throwable): Throwable {
            if (error is CancellationException) return error
            if (error is CloudDocsShareError) return error

            when (error) {
                is HttpException -> {
                    val status = error.code()
                    val rawBody = runCatching { error.response()?.errorBody()?.string() }.getOrNull()
                    val code = errorCodeFromBody(rawBody)
                    when {
                        status == 403 -> return CloudDocsShareError.Forbidden
                        status == 409 -> return CloudDocsShareError.PublicExposureNotAcknowledged
                        status == 401 -> {
                            // 刻意不并入 Forbidden：401 是身份没通过，报成「无权限分享」会误导用户去查权限。
                            return CloudDocsShareError.Other(
                                apiErrorMessage(rawBody) ?: error.message().orEmpty().ifBlank { "unauthorized" },
                            )
                        }
                        code == PUBLIC_EXPOSURE_ACK_REQUIRED ->
                            return CloudDocsShareError.PublicExposureNotAcknowledged
                        code == PERMISSION_DENIED -> return CloudDocsShareError.Forbidden
                        else -> return CloudDocsShareError.Other(
                            apiErrorMessage(rawBody) ?: error.message().orEmpty().ifBlank { "http_$status" },
                        )
                    }
                }
                is AppError.RequestFailed -> {
                    when (error.errorCode) {
                        PUBLIC_EXPOSURE_ACK_REQUIRED ->
                            return CloudDocsShareError.PublicExposureNotAcknowledged
                        PERMISSION_DENIED -> return CloudDocsShareError.Forbidden
                        else -> return CloudDocsShareError.Other(
                            error.serverMessage ?: error.message ?: "request_failed",
                        )
                    }
                }
                else -> return CloudDocsShareError.Other(error.message ?: "unknown")
            }
        }

        internal fun buildUpsertBody(
            type: CloudShareResourceType,
            scope: CloudShareScope,
            permission: CloudSharePermission,
            password: String?,
            acknowledgePublicExposure: Boolean,
        ): JsonObject = buildJsonObject {
            put("share_type", scope.wireValue(type))
            put("permission", permission.wireValue)
            put("acknowledge_public_exposure", acknowledgePublicExposure)
            // 省略 password 键 = 后端不动；显式 "" / 非空则按 PATCH 语义处理。
            if (password != null) {
                put("password", password)
            }
        }

        private fun errorCodeFromBody(rawBody: String?): String? = try {
            rawBody
                ?.let(json::parseToJsonElement)
                ?.jsonObject
                ?.let { payload ->
                    payload["error_code"]?.jsonPrimitive?.contentOrNull
                        ?: payload["code"]?.jsonPrimitive?.contentOrNull
                }
        } catch (_: Exception) {
            null
        }
    }

    private suspend fun refreshDocument(
        resourceId: String,
        scope: CloudShareScope,
    ): CloudDocShare = wrap {
        val id = requireResourceId(resourceId)
        val body = buildJsonObject {
            put("share_type", scope.wireValue(CloudShareResourceType.DOCUMENT))
        }
        docApi.refreshDocumentShare(id, body).unwrap().share
    }

    private suspend fun refreshTableByDisableUpsert(
        resourceId: String,
        scope: CloudShareScope,
        permission: CloudSharePermission,
    ): CloudDocShare {
        // 先关再开。扩到公网重建仍须 ack（与 Electron recreateBody 一致）。
        val needsAck = scope == CloudShareScope.ANYONE
        disable(type = CloudShareResourceType.TABLE, resourceId = resourceId, scope = scope)
        return try {
            upsert(
                type = CloudShareResourceType.TABLE,
                resourceId = resourceId,
                scope = scope,
                permission = permission,
                password = null,
                acknowledgePublicExposure = needsAck,
            )
        } catch (firstFailure: Throwable) {
            if (firstFailure is CancellationException) throw firstFailure
            // disable 已成功：再试一次恢复 upsert。仍失败则抛第一次错误，
            // 调用方（UI）应 reconcile fetch——分享可能已被关掉。
            try {
                upsert(
                    type = CloudShareResourceType.TABLE,
                    resourceId = resourceId,
                    scope = scope,
                    permission = permission,
                    password = null,
                    acknowledgePublicExposure = needsAck,
                )
            } catch (restoreFailure: Throwable) {
                if (restoreFailure is CancellationException) throw restoreFailure
                throw firstFailure
            }
        }
    }

    private fun requireResourceId(resourceId: String): String {
        val id = resourceId.trim()
        if (id.isEmpty()) throw CloudDocsShareError.Other("missing resource id")
        return id
    }

    private suspend fun <T> wrap(block: suspend () -> T): T =
        try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            throw mapError(e)
        }
}
