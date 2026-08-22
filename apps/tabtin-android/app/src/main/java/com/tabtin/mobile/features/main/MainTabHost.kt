package com.tabtin.mobile.features.main

import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.ui.theme.rememberReduceMotion

/**
 * push-drawer 容器（与 iOS `MainTabHost.swift` 等价）。
 *
 * drawer 打开时把整个 [content]（含底部 NavigationBar）一起横向 offset 走，
 * 露出的 content 区域叠 22% 黑色 dim 强调 sidebar 是焦点。
 *
 * 关闭态：Row offset = -drawerWidth，sidebar 完全推出屏幕左侧，content 占满屏。
 * 打开态：Row offset = 0，sidebar 在 [0, drawerWidth]，content 在
 *         [drawerWidth, drawerWidth + screenWidth]——超出屏幕右侧的部分被
 *         父容器隐式裁切。
 *
 * 平板（windowSizeClass = expanded）后续可加 PermanentNavigationDrawer 双栏
 * 分支；本期先做手机 compact 模式，平板 fallback 走同一 push 行为不破坏体验。
 */
@Composable
public fun MainTabHost(
    drawer: ChatDrawerController,
    content: @Composable () -> Unit,
) {
    val isOpen by drawer.isOpen.collectAsState()
    val drawerWidth = 300.dp
    val reduceMotion = rememberReduceMotion()

    val offsetX by animateDpAsState(
        targetValue = if (isOpen) 0.dp else -drawerWidth,
        animationSpec = if (reduceMotion) snap() else spring(dampingRatio = 0.85f, stiffness = 380f),
        label = "drawer_offset",
    )

    BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
        val screenWidth = maxWidth
        Row(
            modifier = Modifier
                .width(screenWidth + drawerWidth)
                .fillMaxHeight()
                .offset(x = offsetX),
        ) {
            Box(
                modifier = Modifier
                    .width(drawerWidth)
                    .fillMaxHeight(),
            ) {
                DrawerSidebar(drawer = drawer)
            }

            Box(
                modifier = Modifier
                    .width(screenWidth)
                    .fillMaxHeight(),
            ) {
                content()
                // drawer 打开时叠 dim + 拦截 tap 关 drawer
                if (isOpen) {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .background(Color.Black.copy(alpha = 0.22f))
                            .pointerInput(Unit) {
                                detectTapGestures { drawer.close() }
                            },
                    )
                }
            }
        }
    }
}
