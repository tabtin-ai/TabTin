package com.tabtin.mobile.features.workbench

/**
 * 工作台当前焦点目标。由 [WorkbenchSurface] 上报，宿主冻结进发送队列。
 * 不含正文/选区；revision 仅为可空 hint。
 */
public data class WorkbenchFocusTarget(
    val appType: String?,
    val resourceId: String? = null,
    val title: String? = null,
    val path: String? = null,
    val revisionHint: String? = null,
    /** TabData 当前视图；由 Native Focus Bridge 回传，未知时为 null。 */
    val viewId: String? = null,
    val pane: WorkbenchNavigationPane = WorkbenchNavigationPane.Overview,
) {
    public companion object {
        public fun fromPane(pane: WorkbenchNavigationPane): WorkbenchFocusTarget = when (pane) {
            WorkbenchNavigationPane.Overview -> WorkbenchFocusTarget(
                appType = null,
                pane = pane,
            )
            is WorkbenchNavigationPane.AppHome -> WorkbenchFocusTarget(
                appType = pane.kind.appId,
                path = "appHome/${pane.kind.appId}",
                pane = pane,
            )
            is WorkbenchNavigationPane.Detail -> WorkbenchFocusTarget(
                appType = pane.request.normalizedType.ifBlank { pane.kind?.appId },
                resourceId = pane.request.resourceId.takeIf { it.isNotBlank() },
                title = pane.request.title?.takeIf { it.isNotBlank() },
                path = "detail/${pane.request.normalizedType}/${pane.request.resourceId}",
                revisionHint = pane.request.locationHint?.takeIf { it.isNotBlank() },
                pane = pane,
            )
        }
    }
}
