package com.tabtin.mobile.features.memo

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.hilt.navigation.compose.hiltViewModel
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.rememberTTSheetState
import com.tabtin.mobile.ui.theme.TTSpacing

/**
 * Workbench 内嵌的 Organization Memo App 首页壳。
 * 固定空 [spaceId]，与 iOS MemoAppHome 同口径。
 *
 * [wrapInModalSheet]=false 时直接画内容（宽屏 EMBEDDED / 已由宿主提供 Modal 时），
 * 避免再套一层 Modal 挡住宿主顶层胶囊。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun MemoAppHomeScreen(
    organizationId: String,
    organizationName: String = "",
    appTitle: String = "",
    initialMemoId: String? = null,
    backHandlingEnabled: Boolean = true,
    onBack: () -> Unit,
    onDismiss: () -> Unit,
    wrapInModalSheet: Boolean = true,
    viewModel: TabMemoViewModel = hiltViewModel(),
) {
    BackHandler(enabled = backHandlingEnabled, onBack = onBack)
    val content: @Composable () -> Unit = {
        MemoAppHomeContent(
            viewModel = viewModel,
            organizationId = organizationId,
            organizationName = organizationName,
            appTitle = appTitle,
            spaceId = "",
            onBack = onBack,
            initialMemoId = initialMemoId,
            backHandlingEnabled = backHandlingEnabled,
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxSize()
                .padding(bottom = TTSpacing.xxxl),
        )
    }
    if (wrapInModalSheet) {
        val sheetState = rememberTTSheetState()
        TTBottomSheet(
            onDismissRequest = onDismiss,
            sheetState = sheetState,
        ) {
            content()
        }
    } else {
        content()
    }
}
