package com.tabtin.mobile.features.skills

import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.MobileConnectorMarketSource
import com.tabtin.mobile.data.model.VisibleSkillEntry
import com.tabtin.mobile.data.repository.MobileSkillLibraryRepository
import com.tabtin.mobile.data.repository.MobileSkillLibrarySnapshot
import com.tabtin.mobile.data.repository.SpaceRepository
import com.tabtin.mobile.util.TokenManager
import io.mockk.coEvery
import io.mockk.every
import io.mockk.mockk
import java.net.UnknownHostException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class MobileSkillLibraryResilienceTest {
    private val dispatcher = UnconfinedTestDispatcher()

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun duplicateCatalogKeysCollapseBeforeReachingTheUi() = runTest(dispatcher) {
        val repository = mockk<MobileSkillLibraryRepository>()
        coEvery { repository.load("org-1", emptyList()) } returns MobileSkillLibrarySnapshot(
            catalog = listOf(
                VisibleSkillEntry(skillKey = "user:owned", name = "我的技能"),
                VisibleSkillEntry(skillKey = "user:owned", name = "我的技能副本"),
            ),
            userGates = mapOf("user:owned" to true),
            linksByAgent = emptyMap(),
            credentials = emptyList(),
        )
        val viewModel = newViewModel(repository)

        viewModel.start()

        assertEquals(listOf("user:owned"), viewModel.uiState.value.skills.map { it.canonicalKey })
    }

    @Test
    fun skillNetworkFailureDoesNotExposeTheTransportMessage() = runTest(dispatcher) {
        val repository = mockk<MobileSkillLibraryRepository>()
        coEvery { repository.load("org-1", emptyList()) } throws
            UnknownHostException("Unable to resolve host api-test.example.com")
        val viewModel = newViewModel(repository)

        viewModel.start()

        assertEquals(R.string.error_network, viewModel.uiState.value.loadErrorRes)
        assertNull(viewModel.uiState.value.errorMessage)
    }

    @Test
    fun connectorNetworkFailureDoesNotExposeTheTransportMessage() = runTest(dispatcher) {
        val repository = mockk<MobileSkillLibraryRepository>()
        coEvery {
            repository.loadConnectorShelf("org-1", MobileConnectorMarketSource.ORGANIZATION)
        } throws UnknownHostException("Unable to resolve host api-test.example.com")
        val viewModel = newViewModel(repository)

        viewModel.ensureConnectorShelf(MobileConnectorMarketSource.ORGANIZATION)

        assertEquals(
            R.string.error_network,
            viewModel.uiState.value.connectorShelves
                .getValue(MobileConnectorMarketSource.ORGANIZATION)
                .errorRes,
        )
        assertNull(
            viewModel.uiState.value.connectorShelves
                .getValue(MobileConnectorMarketSource.ORGANIZATION)
                .errorMessage,
        )
    }

    private fun newViewModel(repository: MobileSkillLibraryRepository): MobileSkillLibraryViewModel {
        val tokenManager = mockk<TokenManager>()
        every { tokenManager.organizationId } returns "org-1"
        every { tokenManager.userId } returns "user-1"
        val spaceRepository = mockk<SpaceRepository>()
        coEvery { spaceRepository.getAgents() } returns emptyList()
        return MobileSkillLibraryViewModel(
            tokenManager = tokenManager,
            spaceRepository = spaceRepository,
            repository = repository,
        )
    }
}
