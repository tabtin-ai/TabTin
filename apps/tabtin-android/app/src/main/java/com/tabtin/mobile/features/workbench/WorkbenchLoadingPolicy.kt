package com.tabtin.mobile.features.workbench

internal fun shouldShowWorkbenchDashboardSkeleton(
    hasOutputs: Boolean,
    hasApps: Boolean,
    isResourceLoading: Boolean,
    isAppCatalogLoading: Boolean,
    hasResourceError: Boolean,
    hasAppCatalogError: Boolean,
): Boolean {
    val hasMeaningfulContent = hasOutputs || hasApps
    val hasBlockingError = hasResourceError || hasAppCatalogError
    return !hasMeaningfulContent &&
        !hasBlockingError &&
        (isResourceLoading || isAppCatalogLoading)
}

internal fun shouldShowWorkbenchResourceListSkeleton(
    hasResources: Boolean,
    isLoading: Boolean,
    hasError: Boolean,
): Boolean = !hasResources && isLoading && !hasError
