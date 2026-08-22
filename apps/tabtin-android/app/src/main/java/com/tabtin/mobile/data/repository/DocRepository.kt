package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.api.DocApi
import com.tabtin.mobile.data.api.json
import com.tabtin.mobile.data.model.AppError
import com.tabtin.mobile.data.model.doc.*
import com.tabtin.mobile.util.TokenManager
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import retrofit2.HttpException
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
public class DocRepository @Inject constructor(
    private val docApi: DocApi,
    private val tokenManager: TokenManager,
) {
    private fun requireOrganizationId(): String =
        tokenManager.organizationId ?: throw AppError.NoOrganization

    public suspend fun listDocuments(
        parentId: String? = null,
        includeArchived: Boolean = false,
    ): List<Doc> {
        val wsId = requireOrganizationId()
        return docApi.listDocuments(
            organizationId = wsId,
            parentId = parentId,
            includeArchived = if (includeArchived) true else null,
        ).unwrap().documents.sortedByDescending { it.sortTimestamp }
    }

    public suspend fun createDocument(
        title: String,
        parentId: String? = null,
        collectionId: String? = null,
        organizationId: String? = null,
    ): DocDetailResponse {
        val wsId = organizationId?.takeIf { it.isNotBlank() } ?: requireOrganizationId()
        try {
            return docApi.createDocument(
                CreateDocRequest(
                    organizationId = wsId,
                    title = title,
                    parentId = parentId,
                    collectionId = collectionId?.takeIf { it.isNotBlank() && it != "root" },
                )
            ).unwrap()
        } catch (error: HttpException) {
            throw documentQuotaExceededFromHttpException(error) ?: error
        } catch (error: AppError.RequestFailed) {
            throw documentQuotaExceededFromApiError(
                errorCode = error.errorCode,
                serverMessage = error.serverMessage,
            ) ?: error
        }
    }

    public suspend fun getDocumentDetail(documentId: String): DocDetailResponse =
        docApi.getDocumentDetail(documentId).unwrap()

    public suspend fun saveContent(
        documentId: String,
        contentPmJson: JsonObject,
        contentMarkdown: String,
        contentPlaintext: String = "",
        baseVersion: Int? = null,
        baseUpdatedAt: String? = null,
        title: String? = null,
    ): SaveContentResponse {
        val envelope = try {
            docApi.saveContent(
                documentId,
                SaveContentRequest(
                    contentPmJson = contentPmJson,
                    contentMarkdown = contentMarkdown,
                    contentPlaintext = contentPlaintext,
                    baseVersion = baseVersion,
                    baseUpdatedAt = baseUpdatedAt,
                    title = title,
                )
            )
        } catch (e: HttpException) {
            if (e.code() == 409) throw AppError.VersionConflict
            throw e
        }
        if (!envelope.success || envelope.data == null) {
            if (envelope.code == "VERSION_CONFLICT") throw AppError.VersionConflict
            throw AppError.RequestFailed(envelope.message, envelope.errorCode ?: envelope.code)
        }
        return envelope.data
    }

    public suspend fun archiveDocument(documentId: String) {
        docApi.archiveDocument(documentId).unwrap()
    }

    public suspend fun listHistories(documentId: String, limit: Int = 50): List<DocHistoryEntry> =
        docApi.listHistories(documentId, limit).unwrap()

    public suspend fun restoreHistory(
        documentId: String,
        historyId: String,
        baseVersion: Int? = null,
        baseUpdatedAt: String? = null,
    ): Map<String, String> =
        docApi.restoreHistory(
            documentId,
            RestoreHistoryRequest(
                versionId = historyId,
            )
        ).unwrap()

    public suspend fun listCommentThreads(documentId: String): CommentThreadListResponse =
        docApi.listCommentThreads(documentId).unwrap()

    public suspend fun createCommentThread(
        documentId: String,
        body: String,
        scope: String,
        anchor: CommentAnchor,
        selectedText: String? = null,
    ): CommentThread =
        docApi.createCommentThread(
            documentId,
            CreateCommentThreadRequest(
                body = body,
                scope = scope,
                anchor = anchor,
                selectedText = selectedText,
            ),
        ).unwrap().thread
}

internal const val DOCUMENT_LIMIT_EXCEEDED_CODE: String = "ENTITLEMENT_DOCUMENT_LIMIT_EXCEEDED"

/**
 * 额度接口使用 403，Retrofit 会抛出 [HttpException] 而不是反序列化成功体；在仓库边界解析它，
 * 让三个新建入口共享同一种、可展示用量的领域错误。
 */
internal fun documentQuotaExceededFromApiError(
    errorCode: String?,
    data: JsonElement? = null,
    serverMessage: String? = null,
): AppError.DocumentQuotaExceeded? {
    if (errorCode != DOCUMENT_LIMIT_EXCEEDED_CODE) return null
    val quota = data as? JsonObject
    return AppError.DocumentQuotaExceeded(
        used = quota?.get("used")?.jsonPrimitive?.intOrNull,
        limit = quota?.get("limit")?.jsonPrimitive?.intOrNull,
        serverMessage = serverMessage,
    )
}

internal fun documentQuotaExceededFromHttpException(error: HttpException): AppError.DocumentQuotaExceeded? {
    val rawBody = error.response()?.errorBody()?.string() ?: return null
    return runCatching {
        val payload = json.parseToJsonElement(rawBody).jsonObject
        documentQuotaExceededFromApiError(
            errorCode = payload["error_code"]?.jsonPrimitive?.contentOrNull
                ?: payload["code"]?.jsonPrimitive?.contentOrNull,
            data = payload["data"],
            serverMessage = payload["message"]?.jsonPrimitive?.contentOrNull,
        )
    }.getOrNull()
}
