package com.tabtin.mobile.features.workbench

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkbenchDashboardLoadingPolicyTest {
    @Test
    fun emptyInitialLoadUsesSkeletonForEitherRequest() {
        assertTrue(
            shouldShowWorkbenchDashboardSkeleton(
                hasOutputs = false,
                hasApps = false,
                isResourceLoading = true,
                isAppCatalogLoading = false,
                hasResourceError = false,
                hasAppCatalogError = false,
            ),
        )
        assertTrue(
            shouldShowWorkbenchDashboardSkeleton(
                hasOutputs = false,
                hasApps = false,
                isResourceLoading = false,
                isAppCatalogLoading = true,
                hasResourceError = false,
                hasAppCatalogError = false,
            ),
        )
    }

    @Test
    fun cachedContentErrorsAndIdleStateDoNotReplaceTheDashboard() {
        assertFalse(
            shouldShowWorkbenchDashboardSkeleton(
                hasOutputs = true,
                hasApps = false,
                isResourceLoading = true,
                isAppCatalogLoading = true,
                hasResourceError = false,
                hasAppCatalogError = false,
            ),
        )
        assertFalse(
            shouldShowWorkbenchDashboardSkeleton(
                hasOutputs = false,
                hasApps = false,
                isResourceLoading = true,
                isAppCatalogLoading = true,
                hasResourceError = true,
                hasAppCatalogError = false,
            ),
        )
        assertFalse(
            shouldShowWorkbenchDashboardSkeleton(
                hasOutputs = false,
                hasApps = false,
                isResourceLoading = false,
                isAppCatalogLoading = false,
                hasResourceError = false,
                hasAppCatalogError = false,
            ),
        )
    }

    @Test
    fun emptyResourceListUsesSkeletonOnlyDuringSuccessfulInitialLoad() {
        assertTrue(
            shouldShowWorkbenchResourceListSkeleton(
                hasResources = false,
                isLoading = true,
                hasError = false,
            ),
        )
        assertFalse(
            shouldShowWorkbenchResourceListSkeleton(
                hasResources = true,
                isLoading = true,
                hasError = false,
            ),
        )
        assertFalse(
            shouldShowWorkbenchResourceListSkeleton(
                hasResources = false,
                isLoading = true,
                hasError = true,
            ),
        )
        assertFalse(
            shouldShowWorkbenchResourceListSkeleton(
                hasResources = false,
                isLoading = false,
                hasError = false,
            ),
        )
    }
}
