package com.tabtin.mobile.features.workspace

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

class OrganizationManagementEntrySourceTest {
    @Test
    fun accountDrawerExposesOrganizationCreation() {
        val source = File("src/main/java/com/tabtin/mobile/features/main/AccountDrawerPanel.kt").readText()

        assertTrue(source.contains("CreateOrganizationSheet("))
        assertTrue(source.contains("viewModel.createOrganization(name, description)"))
    }

    @Test
    fun organizationSettingsRoutesToWalletTransactions() {
        val source = File("src/main/java/com/tabtin/mobile/features/workspace/WorkspaceSettingsScreen.kt").readText()
        val navigation = File("src/main/java/com/tabtin/mobile/navigation/AppNavigation.kt").readText()

        assertTrue(source.contains("title = stringResource(R.string.ws_wallet)"))
        assertTrue(source.contains("onClick = onOpenWallet"))
        assertTrue(navigation.contains("navigateOnce(WalletRoute(organizationId = id))"))
    }
}
