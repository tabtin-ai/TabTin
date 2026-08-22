package com.tabtin.mobile.data.im

import android.app.Application
import com.tabtin.mobile.R
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import java.net.UnknownHostException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.launch
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class)
class ImConversationStoreSearchTest {

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun `blank query clears results without searching remote history`() = runTest {
        val dataPlane = mockk<ImConversationDataPlane>(relaxed = true)
        val store = ImConversationStore(dataPlane)
        store.prepareOrganizationForTesting("org-a")

        store.searchMessages("org-a", "   ")

        coVerify(exactly = 0) { dataPlane.searchMessages(any(), any()) }
        assertEquals(emptyList<ImMessageSearchResult>(), store.searchResults.value)
        assertFalse(store.isSearching.value)
    }

    @Test
    fun `message body search exposes the matched preview`() = runTest {
        val dataPlane = mockk<ImConversationDataPlane>(relaxed = true)
        coEvery { dataPlane.searchMessages("org-a", "66") } returns listOf(
            searchResult("dm-a", "org-a", "历史正文 66"),
        )
        val store = ImConversationStore(dataPlane)

        store.searchMessages("org-a", "66")

        assertEquals("dm-a", store.searchResults.value.single().conversation.id)
        assertEquals("历史正文 66", store.searchResults.value.single().matchedMessagePreview)
    }

    @Test
    fun `new query clears the previous result while debounce is pending`() = runTest {
        val dataPlane = mockk<ImConversationDataPlane>(relaxed = true)
        coEvery { dataPlane.searchMessages("org-a", "old") } returns listOf(
            searchResult("dm-old", "org-a", "old body"),
        )
        val store = ImConversationStore(dataPlane)
        store.searchMessages("org-a", "old")

        val pendingSearch = launch { store.searchMessages("org-a", "new") }
        runCurrent()

        assertEquals(emptyList<ImMessageSearchResult>(), store.searchResults.value)
        assertTrue(store.isSearching.value)
        coVerify(exactly = 0) { dataPlane.searchMessages("org-a", "new") }
        pendingSearch.cancel()
    }

    @Test
    fun `message search drops results outside the active organization`() = runTest {
        val dataPlane = mockk<ImConversationDataPlane>(relaxed = true)
        coEvery { dataPlane.searchMessages("org-a", "66") } returns listOf(
            searchResult("dm-a", "org-a", "组织 A 的 66"),
            searchResult("dm-b", "org-b", "组织 B 的 66"),
        )
        val store = ImConversationStore(dataPlane)

        store.searchMessages("org-a", "66")

        assertEquals(listOf("dm-a"), store.searchResults.value.map { it.conversation.id })
    }

    @Test
    fun `late search from the previous organization cannot refill results`() = runTest {
        val dataPlane = mockk<ImConversationDataPlane>(relaxed = true)
        val oldResult = CompletableDeferred<List<ImMessageSearchResult>>()
        coEvery { dataPlane.searchMessages("org-a", "old") } coAnswers { oldResult.await() }
        coEvery { dataPlane.searchMessages("org-b", "new") } returns listOf(
            searchResult("dm-b", "org-b", "new body"),
        )
        val store = ImConversationStore(dataPlane)

        val oldSearch = launch { store.searchMessages("org-a", "old") }
        runCurrent()
        advanceTimeBy(250)
        runCurrent()
        store.searchMessages("org-b", "new")
        oldResult.complete(listOf(searchResult("dm-a", "org-a", "old body")))
        oldSearch.join()

        assertEquals(listOf("dm-b"), store.searchResults.value.map { it.conversation.id })
    }

    @Test
    fun `late previous query in the same organization cannot replace current results`() = runTest {
        val dataPlane = mockk<ImConversationDataPlane>(relaxed = true)
        val oldResult = CompletableDeferred<List<ImMessageSearchResult>>()
        coEvery { dataPlane.searchMessages("org-a", "old") } coAnswers { oldResult.await() }
        coEvery { dataPlane.searchMessages("org-a", "new") } returns listOf(
            searchResult("dm-new", "org-a", "new body"),
        )
        val store = ImConversationStore(dataPlane)

        val oldSearch = launch { store.searchMessages("org-a", "old") }
        runCurrent()
        advanceTimeBy(250)
        runCurrent()
        store.searchMessages("org-a", "new")
        oldResult.complete(listOf(searchResult("dm-old", "org-a", "old body")))
        oldSearch.join()

        assertEquals(listOf("dm-new"), store.searchResults.value.map { it.conversation.id })
    }

    @Test
    fun `offline conversation load maps host failure to a localized resource`() = runTest {
        val dataPlane = mockk<ImConversationDataPlane>(relaxed = true)
        coEvery { dataPlane.listConversations("org-a") } throws
            UnknownHostException("Unable to resolve host api-test.example.com")
        val store = ImConversationStore(dataPlane)

        store.reload("org-a")

        assertEquals(R.string.error_network, store.loadErrorRes.value)
    }

    private fun searchResult(
        conversationId: String,
        organizationId: String,
        preview: String,
    ): ImMessageSearchResult = ImMessageSearchResult(
        conversation = ImConversation(
            id = conversationId,
            organizationId = organizationId,
            type = ImConversationType.DM,
            name = "会话 $conversationId",
        ),
        matchedMessagePreview = preview,
        matchCount = 1,
    )
}
