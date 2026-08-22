package com.tabtin.mobile.features.main

import android.content.Context
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * "对话" tab drawer 的共享状态（与 iOS 端 `ChatDrawerController.swift` 等价）。
 *
 * **设计动机**：push drawer 视觉上要把底部 tab bar 一起推走——意味着 sidebar
 * 必须挂在 MainScreen 外层（[MainTabHost]），让整个 MainScreen 作为 HStack 的
 * 右侧 child 跟着 offset。而 hamburger 按钮在 chat tab 内的 toolbar 上，它和
 * MainTabHost 不在同一 Composable 层级，传 lambda 不方便——用 Hilt @Singleton
 * 承载 drawer 开关，hamburger / sidebar / MainTabHost 共享访问。
 *
 * 状态：
 * - [isOpen]：drawer 开关（手机 push offset 驱动；平板 [PermanentNavigationDrawer]
 *   不使用）。
 * - [selection]：当前选中项。用 SharedPreferences 做等价 iOS @SceneStorage 的
 *   持久化——杀进程重启后仍保留上次选项。
 */
@Singleton
public class ChatDrawerController @Inject constructor(
    @ApplicationContext context: Context,
) {
    private companion object {
        const val PREFS_NAME = "tabtin_chat_drawer"
        const val KEY_SELECTION = "selection"
    }

    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private val _isOpen = MutableStateFlow(false)
    public val isOpen: StateFlow<Boolean> = _isOpen.asStateFlow()

    private val _selection = MutableStateFlow<DrawerSelection>(restoreSelection())
    public val selection: StateFlow<DrawerSelection> = _selection.asStateFlow()

    public fun open() {
        _isOpen.value = true
    }

    public fun close() {
        _isOpen.value = false
    }

    public fun toggle() {
        _isOpen.value = !_isOpen.value
    }

    /**
     * drawer sidebar 选项点击后：换 selection + 关 drawer。
     * 平板上 isOpen 不参与渲染但赋 false 无副作用。
     */
    public fun selectAndClose(next: DrawerSelection) {
        _selection.value = next
        persistSelection(next)
        _isOpen.value = false
    }

    /**
     * organization 切换时清状态：selection 回到"全部对话"，drawer 关闭。
     * 由 [OrganizationRepository.selectOrganization] 触发。
     */
    public fun resetForOrganizationSwitch() {
        _selection.value = DrawerSelection.AllConversations
        persistSelection(DrawerSelection.AllConversations)
        _isOpen.value = false
    }

    /**
     * 选中的 agent 已被归档 / 删除时兜底回"全部对话"——MainTabHost 监听
     * spaces 列表变化时调用。
     */
    public fun fallbackToAllIfMissing(currentAgentIds: Set<String>) {
        val sel = _selection.value
        if (sel is DrawerSelection.Agent && sel.spaceId !in currentAgentIds) {
            _selection.value = DrawerSelection.AllConversations
            persistSelection(DrawerSelection.AllConversations)
        }
    }

    private fun restoreSelection(): DrawerSelection {
        return DrawerSelection.fromRawValue(prefs.getString(KEY_SELECTION, null))
    }

    private fun persistSelection(sel: DrawerSelection) {
        prefs.edit().putString(KEY_SELECTION, sel.rawValue).apply()
    }
}
