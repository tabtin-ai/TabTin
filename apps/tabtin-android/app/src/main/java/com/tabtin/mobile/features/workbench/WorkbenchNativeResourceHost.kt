package com.tabtin.mobile.features.workbench

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.ui.Modifier
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.toRoute
import com.tabtin.mobile.features.doc.DocEditorScreen
import com.tabtin.mobile.features.tabdata.NativeTabDataScreen
import kotlinx.serialization.Serializable

/**
 * 工作台自己的原生资源 destination。
 *
 * 独立 child NavHost 的 backStackEntry 同时提供 Hilt SavedStateHandle，确保文档/表格
 * ViewModel 能拿到 resourceId 与 organizationId；它不进入 App 根导航，因此任务对话与胶囊
 * 始终留在同一棵 Compose 树里。
 */
@Serializable
private data class WorkbenchNativeResourceRoute(
    val resourceType: String,
    val resourceId: String,
    val organizationId: String,
    val spaceId: String? = null,
    val title: String? = null,
)

@Composable
internal fun WorkbenchNativeResourceHost(
    request: WorkbenchResourceOpenRequest,
    organizationId: String,
    spaceId: String?,
    backHandlingEnabled: Boolean = true,
    onBack: () -> Unit,
    onOpenFullEditor: (WorkbenchResourceOpenRequest) -> Unit,
    onFocusChanged: (tableId: String, viewId: String?) -> Unit = { _, _ -> },
) {
    val route = WorkbenchNativeResourceRoute(
        resourceType = request.normalizedType,
        resourceId = request.resourceId,
        organizationId = organizationId,
        spaceId = spaceId,
        title = request.title,
    )

    // resource identity 改变时重建 child graph；旧 ViewModel 随旧 owner 一起释放，避免串资源。
    key(route) {
        val navController = rememberNavController()
        // TabData 自身没有 BackHandler；在 child graph 根拦截系统返回，避免误 pop ChatSessionRoute。
        // TabDoc 的未保存门禁在更内层注册，会按 Compose 的后注册优先规则先处理。
        BackHandler(enabled = backHandlingEnabled, onBack = onBack)
        NavHost(
            navController = navController,
            startDestination = route,
            modifier = Modifier.fillMaxSize(),
        ) {
            composable<WorkbenchNativeResourceRoute> { backStackEntry ->
                val target = backStackEntry.toRoute<WorkbenchNativeResourceRoute>()
                val fullEditorRequest = WorkbenchResourceOpenRequest(
                    resourceType = target.resourceType,
                    resourceId = target.resourceId,
                    title = target.title,
                )
                when (target.resourceType) {
                    "tabdoc" -> DocEditorScreen(
                        viewModel = hiltViewModel(backStackEntry),
                        onBack = onBack,
                        backHandlingEnabled = backHandlingEnabled,
                        onOpenFullEditor = { onOpenFullEditor(fullEditorRequest) },
                    )
                    "tabdata" -> NativeTabDataScreen(
                        onBack = onBack,
                        onOpenFullEditor = { onOpenFullEditor(fullEditorRequest) },
                        onFocusChanged = onFocusChanged,
                        viewModel = hiltViewModel(backStackEntry),
                    )
                }
            }
        }
    }
}
