package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.BlockItem
import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.features.workbench.WorkbenchResourceOpenRequest

/**
 * 把富内容资源卡归一为任务工作台可消费的打开请求。
 *
 * 历史消息把资源字段放在 payload，直播消息可能已经摊平；这里始终先走同一归一化，
 * 避免“能渲染、点击时却拿不到目标”的双口径。
 */
internal fun resolveRichResourceOpenRequest(block: BlockItem): WorkbenchResourceOpenRequest? {
    val normalized = block.normalizedRichContent()
    val resourceType = normalized.resourceType
        ?.takeIf { it.isNotBlank() }
        ?.let(SpaceResource::normalizedType)
        ?: return null
    val resourceId = normalized.resourceId?.takeIf { it.isNotBlank() } ?: return null
    return WorkbenchResourceOpenRequest(
        resourceType = resourceType,
        resourceId = resourceId,
        title = normalized.resourceName
            ?.takeIf { it.isNotBlank() }
            ?: normalized.title?.takeIf { it.isNotBlank() }
            ?: normalized.summary?.takeIf { it.isNotBlank() },
        locationHint = normalized.locationHint?.takeIf { it.isNotBlank() },
    )
}

/**
 * 只有工作台已完整承载的原生资源才走任务内打开；其余类型继续沿用全局深链。
 * 显式跨组织资源也继续走全局深链；同组织跨 Space 的文档和表格可在任务工作台打开。
 */
internal fun canOpenRichResourceInCurrentTask(
    block: BlockItem,
    @Suppress("UNUSED_PARAMETER")
    currentSpaceId: String?,
    currentOrganizationId: String?,
): Boolean {
    val normalized = block.normalizedRichContent()
    when (SpaceResource.normalizedType(normalized.resourceType.orEmpty())) {
        "tabdoc", "tabdata" -> Unit
        else -> return false
    }
    val resourceOrganizationId = normalized.organizationId?.takeIf { it.isNotBlank() }
        ?: normalized.workspaceId?.takeIf { it.isNotBlank() }
    return resourceOrganizationId == null ||
        currentOrganizationId?.takeIf { it.isNotBlank() } == resourceOrganizationId
}

/**
 * 会话内部优先交给任务工作台；只有没有任务宿主的独立预览才回退外部深链。
 */
internal fun dispatchRichResourceOpen(
    request: WorkbenchResourceOpenRequest,
    onOpenInWorkbench: ((WorkbenchResourceOpenRequest) -> Unit)?,
    onOpenWithDeepLink: (WorkbenchResourceOpenRequest) -> Unit,
) {
    if (onOpenInWorkbench != null) {
        onOpenInWorkbench(request)
    } else {
        onOpenWithDeepLink(request)
    }
}
