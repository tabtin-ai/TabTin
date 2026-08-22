package com.tabtin.mobile.features.tabsite

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import javax.inject.Inject

public data class TabSitePreviewUiState(
    val siteId: String = "",
    val siteName: String = "",
    val siteUrl: String = "",
    val status: String = "draft",
    val isLoading: Boolean = false,
    val errorMessage: String? = null,
    /** WebView 渲染进程被系统回收（区别于页面加载失败：错误文案由 UI 层取本地化资源，
     *  而 [errorMessage] 是 WebView 给的英文原始描述）。 */
    val renderProcessGone: Boolean = false,
    val reloadKey: Int = 0,
) {
    val hasPublishedUrl: Boolean get() = siteUrl.isNotBlank()
    val isDraft: Boolean get() = status == "draft"
    val isPublished: Boolean get() = status == "published"
    val isArchived: Boolean get() = status == "archived"
}

@HiltViewModel
public class TabSitePreviewViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
) : ViewModel() {

    private val _uiState = MutableStateFlow(
        TabSitePreviewUiState(
            siteId = savedStateHandle["siteId"] ?: "",
            siteName = savedStateHandle["siteName"] ?: "",
            siteUrl = savedStateHandle["siteUrl"] ?: "",
            status = savedStateHandle["siteStatus"] ?: "draft",
        )
    )
    public val uiState: StateFlow<TabSitePreviewUiState> = _uiState.asStateFlow()

    public fun onPageStarted() {
        _uiState.value = _uiState.value.copy(isLoading = true, errorMessage = null)
    }

    public fun onPageFinished() {
        _uiState.value = _uiState.value.copy(isLoading = false)
    }

    public fun onPageError(description: String?) {
        _uiState.value = _uiState.value.copy(
            isLoading = false,
            errorMessage = description ?: "Unknown error",
        )
    }

    /**
     * WebView 渲染进程终止（`onRenderProcessGone`）。与 [onPageError] 分开：这不是页面本身
     * 加载失败，而是承载页面的 WebView 实例已经不可用——[retry] 必须靠 [reloadKey] 重建实例，
     * 不能对旧实例 reload。
     */
    public fun onRenderProcessGone() {
        _uiState.value = _uiState.value.copy(
            isLoading = false,
            errorMessage = null,
            renderProcessGone = true,
        )
    }

    public fun retry() {
        _uiState.value = _uiState.value.copy(
            errorMessage = null,
            renderProcessGone = false,
            isLoading = true,
            reloadKey = _uiState.value.reloadKey + 1,
        )
    }
}
