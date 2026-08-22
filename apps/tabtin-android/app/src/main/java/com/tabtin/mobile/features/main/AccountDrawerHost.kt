package com.tabtin.mobile.features.main

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.width
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.ttColor
import kotlinx.coroutines.launch

/**
 * 一级账户抽屉的 Android Material 3 主壳。
 *
 * 使用系统 `ModalNavigationDrawer`，由框架处理边缘拖拽、蒙层、返回关闭与动画；
 * `ModalDrawerSheet` 使用安全窗口 inset，因此账户标题和底部设置不会贴住系统栏。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun AccountDrawerHost(
    onNavigateToMe: () -> Unit,
    onNavigateToSettings: () -> Unit,
    onNavigateToNotifications: () -> Unit,
    content: @Composable (openDrawer: () -> Unit) -> Unit,
) {
    val drawerState = rememberDrawerState(initialValue = DrawerValue.Closed)
    val scope = rememberCoroutineScope()

    Box(modifier = Modifier.fillMaxSize()) {
        ModalNavigationDrawer(
            drawerState = drawerState,
            gesturesEnabled = true,
            scrimColor = ttColor(TTColors.OverlayBackgroundLight, TTColors.Dark.OverlayBackgroundLight),
            drawerContent = {
                ModalDrawerSheet(
                    modifier = Modifier
                        .width(320.dp)
                        .fillMaxHeight(),
                    drawerContainerColor = ttColor(TTColors.BgSidebar, TTColors.Dark.BgSidebar),
                    drawerContentColor = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                    windowInsets = WindowInsets.safeDrawing,
                ) {
                    AccountDrawerPanel(
                        onDismiss = { scope.launch { drawerState.close() } },
                        onNavigateToMe = {
                            scope.launch {
                                drawerState.close()
                                onNavigateToMe()
                            }
                        },
                        onNavigateToSettings = {
                            scope.launch {
                                drawerState.close()
                                onNavigateToSettings()
                            }
                        },
                        onNavigateToNotifications = {
                            scope.launch {
                                drawerState.close()
                                onNavigateToNotifications()
                            }
                        },
                        modifier = Modifier.fillMaxSize(),
                    )
                }
            },
        ) {
            content { scope.launch { drawerState.open() } }
        }
    }
}
