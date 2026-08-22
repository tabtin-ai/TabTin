package com.tabtin.mobile.features.clouddocs

/**
 * 云文件打开身份：ContextItemID 走云盘签名；对话产物只有 FileRecordID，必须改走 OSS。
 * FileRecordID 不能顶替 ContextItemID。
 */
public enum class CloudFileAccessRoute {
    CONTEXT_ITEM,
    FILE_RECORD,
    MISSING,
}

public object CloudFileAccessIdentity {
    public fun route(
        organizationId: String,
        contextItemId: String,
        fileRecordId: String,
    ): CloudFileAccessRoute {
        val organization = organizationId.trim()
        val contextItem = contextItemId.trim()
        val fileRecord = fileRecordId.trim()
        if (organization.isNotEmpty() && contextItem.isNotEmpty()) {
            return CloudFileAccessRoute.CONTEXT_ITEM
        }
        if (fileRecord.isNotEmpty()) {
            return CloudFileAccessRoute.FILE_RECORD
        }
        return CloudFileAccessRoute.MISSING
    }

    public fun cacheKey(
        route: CloudFileAccessRoute,
        contextItemId: String,
        fileRecordId: String,
    ): String? = when (route) {
        CloudFileAccessRoute.CONTEXT_ITEM -> "ctx:${contextItemId.trim()}"
        CloudFileAccessRoute.FILE_RECORD -> "file:${fileRecordId.trim()}"
        CloudFileAccessRoute.MISSING -> null
    }
}
