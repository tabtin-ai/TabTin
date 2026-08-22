package com.tabtin.mobile.features.tabsite

import androidx.lifecycle.SavedStateHandle
import org.junit.Assert.*
import org.junit.Test

/**
 * D-004 回归测试：Android 端 TabSite 预览最小闭环。
 *
 * 验证 ViewModel 正确从 SavedStateHandle 提取站点参数，
 * 且 UI 状态正确反映站点发布状态。
 */
class TabSitePreviewViewModelTest {

    private fun createViewModel(
        siteId: String = "site-123",
        siteName: String = "测试站点",
        siteUrl: String = "https://site.example.com/s/test/",
        siteStatus: String = "published",
    ): TabSitePreviewViewModel {
        val handle = SavedStateHandle(mapOf(
            "siteId" to siteId,
            "siteName" to siteName,
            "siteUrl" to siteUrl,
            "siteStatus" to siteStatus,
        ))
        return TabSitePreviewViewModel(handle)
    }

    @Test
    fun `published site has valid URL and correct status`() {
        val vm = createViewModel()
        val state = vm.uiState.value

        assertEquals("site-123", state.siteId)
        assertEquals("测试站点", state.siteName)
        assertEquals("https://site.example.com/s/test/", state.siteUrl)
        assertEquals("published", state.status)
        assertTrue(state.hasPublishedUrl)
        assertTrue(state.isPublished)
        assertFalse(state.isDraft)
        assertFalse(state.isArchived)
    }

    @Test
    fun `draft site without URL shows empty state`() {
        val vm = createViewModel(siteUrl = "", siteStatus = "draft")
        val state = vm.uiState.value

        assertFalse(state.hasPublishedUrl)
        assertTrue(state.isDraft)
        assertFalse(state.isPublished)
    }

    @Test
    fun `archived site reports correct status`() {
        val vm = createViewModel(siteStatus = "archived")
        val state = vm.uiState.value

        assertTrue(state.isArchived)
        assertFalse(state.isDraft)
        assertFalse(state.isPublished)
    }

    @Test
    fun `onPageStarted sets loading true`() {
        val vm = createViewModel()
        vm.onPageStarted()
        assertTrue(vm.uiState.value.isLoading)
        assertNull(vm.uiState.value.errorMessage)
    }

    @Test
    fun `onPageFinished clears loading`() {
        val vm = createViewModel()
        vm.onPageStarted()
        vm.onPageFinished()
        assertFalse(vm.uiState.value.isLoading)
    }

    @Test
    fun `onPageError sets error message and clears loading`() {
        val vm = createViewModel()
        vm.onPageStarted()
        vm.onPageError("net::ERR_INTERNET_DISCONNECTED")
        assertFalse(vm.uiState.value.isLoading)
        assertEquals("net::ERR_INTERNET_DISCONNECTED", vm.uiState.value.errorMessage)
    }

    @Test
    fun `missing nav args default gracefully`() {
        val handle = SavedStateHandle()
        val vm = TabSitePreviewViewModel(handle)
        val state = vm.uiState.value

        assertEquals("", state.siteId)
        assertEquals("", state.siteName)
        assertEquals("", state.siteUrl)
        assertEquals("draft", state.status)
        assertFalse(state.hasPublishedUrl)
    }
}
