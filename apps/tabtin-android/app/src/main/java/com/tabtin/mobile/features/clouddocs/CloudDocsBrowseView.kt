package com.tabtin.mobile.features.clouddocs

/**
 * 云文档三个浏览分段，与 Electron 侧栏 `browseView` / iOS `CloudDocsBrowseView` 一一对应。
 */
public enum class CloudDocsBrowseView {
    /** 组织知识树（全部）。 */
    ALL,

    /** 本人访问过的 tabdoc / tabdata，按 lastVisitedAt 倒序。 */
    RECENT,

    /** 别人分享给我的文档与表格聚合。 */
    SHARED,
}
