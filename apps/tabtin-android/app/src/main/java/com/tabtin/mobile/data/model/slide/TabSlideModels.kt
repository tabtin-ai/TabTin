package com.tabtin.mobile.data.model.slide

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
public data class TabSlideDetailResponse(
    val id: String,
    val name: String = "",
    val preset: String = "ppt",
    @SerialName("canvas_width") val canvasWidth: Int = 1920,
    @SerialName("canvas_height") val canvasHeight: Int = 1080,
    @SerialName("page_count") val pageCount: Int = 0,
    val thumbnail: String? = null,
    val pages: List<TabSlidePage> = emptyList(),
) {
    val displayName: String get() = name.trim().ifEmpty { "未命名演示" }
}

@Serializable
public data class TabSlidePage(
    val id: String,
    val html: String? = null,
    val remark: String? = null,
    @SerialName("contentFormat") val contentFormat: String? = null,
)
