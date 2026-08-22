package com.tabtin.mobile.features.skills

import com.tabtin.mobile.data.model.MobileConnectorMarketItem
import com.tabtin.mobile.data.model.MobileConnectorMarketSource
import com.tabtin.mobile.data.repository.MobileConnectorShelfSnapshot
import com.tabtin.mobile.data.repository.MobileSkillLibraryRepository
import com.tabtin.mobile.data.repository.SpaceRepository
import com.tabtin.mobile.util.TokenManager
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class MobileSkillLibraryConnectorOrganizationTest {
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
    fun loadedShelfIsReplacedAfterOrganizationChanges() = runTest(dispatcher) {
        var organizationId = "org-a"
        val repository = mockk<MobileSkillLibraryRepository>()
        coEvery {
            repository.loadConnectorShelf("org-a", MobileConnectorMarketSource.ORGANIZATION)
        } returns shelf("org-a-connector")
        coEvery {
            repository.loadConnectorShelf("org-b", MobileConnectorMarketSource.ORGANIZATION)
        } returns shelf("org-b-connector")
        val viewModel = newViewModel(repository) { organizationId }

        viewModel.ensureConnectorShelf(MobileConnectorMarketSource.ORGANIZATION)
        assertEquals(
            listOf("org-a-connector"),
            connectorNames(viewModel),
        )

        organizationId = "org-b"
        viewModel.ensureConnectorShelf(MobileConnectorMarketSource.ORGANIZATION)

        assertEquals(
            listOf("org-b-connector"),
            connectorNames(viewModel),
        )
        coVerify(exactly = 1) {
            repository.loadConnectorShelf("org-b", MobileConnectorMarketSource.ORGANIZATION)
        }
    }

    @Test
    fun staleOrganizationResponseCannotOverwriteCurrentShelf() = runTest(dispatcher) {
        var organizationId = "org-a"
        val oldResponse = CompletableDeferred<MobileConnectorShelfSnapshot>()
        val repository = mockk<MobileSkillLibraryRepository>()
        coEvery {
            repository.loadConnectorShelf("org-a", MobileConnectorMarketSource.ORGANIZATION)
        } coAnswers { oldResponse.await() }
        coEvery {
            repository.loadConnectorShelf("org-b", MobileConnectorMarketSource.ORGANIZATION)
        } returns shelf("org-b-connector")
        val viewModel = newViewModel(repository) { organizationId }

        viewModel.ensureConnectorShelf(MobileConnectorMarketSource.ORGANIZATION)
        assertTrue(
            viewModel.uiState.value.connectorShelves
                .getValue(MobileConnectorMarketSource.ORGANIZATION)
                .isLoading,
        )

        organizationId = "org-b"
        viewModel.ensureConnectorShelf(MobileConnectorMarketSource.ORGANIZATION)
        assertEquals(listOf("org-b-connector"), connectorNames(viewModel))

        oldResponse.complete(shelf("stale-org-a-connector"))
        runCurrent()

        assertEquals(listOf("org-b-connector"), connectorNames(viewModel))
    }

    private fun newViewModel(
        repository: MobileSkillLibraryRepository,
        organizationId: () -> String,
    ): MobileSkillLibraryViewModel {
        val tokenManager = mockk<TokenManager>()
        every { tokenManager.organizationId } answers { organizationId() }
        return MobileSkillLibraryViewModel(
            tokenManager = tokenManager,
            spaceRepository = mockk<SpaceRepository>(relaxed = true),
            repository = repository,
        )
    }

    private fun shelf(name: String): MobileConnectorShelfSnapshot =
        MobileConnectorShelfSnapshot(
            items = listOf(
                MobileConnectorMarketItem(
                    stableKey = "organization:$name",
                    source = MobileConnectorMarketSource.ORGANIZATION,
                    name = name,
                ),
            ),
        )

    private fun connectorNames(viewModel: MobileSkillLibraryViewModel): List<String> =
        viewModel.uiState.value.connectorShelves
            .getValue(MobileConnectorMarketSource.ORGANIZATION)
            .items
            .map { it.name }
}
