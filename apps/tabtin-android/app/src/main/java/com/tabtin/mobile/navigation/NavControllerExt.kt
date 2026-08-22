package com.tabtin.mobile.navigation

import androidx.lifecycle.Lifecycle
import androidx.navigation.NavController
import androidx.navigation.NavOptionsBuilder

/**
 * 安全返回：栈里已经没有上一层时就不再 pop。
 *
 * 裸 [NavController.popBackStack] 在栈只剩根 destination 时会把根一起弹掉，NavHost 随即
 * 没有任何 destination 可渲染。后果不是「回到上一页」而是整屏纯白：ComposeView 被 measure
 * 成 0x0（父容器仍是满屏），进程、窗口、surface 全部健康，主线程也能响应输入，但画面只剩
 * 窗口白底；且切后台、重进 Activity 都不恢复，用户只能杀进程重开。
 *
 * 触发路径：在「进入详情」和「返回」之间快速连点。通知中心最容易踩到 —— 入口铃铛与详情页
 * 的返回箭头位于同一坐标，连点等于让 navigate 与 pop 交替竞态。实测同一坐标连点 6 次必现，
 * 而每次间隔 2 秒的慢速点击 18 次都不会出问题。
 *
 * @return 真正执行了 pop 返回 true；已在根层、未执行则返回 false。
 */
public fun NavController.popBackStackSafely(): Boolean {
    if (previousBackStackEntry == null) return false
    return popBackStack()
}

/**
 * 当前是否处于可以接受「用户主动导航」的稳定状态。
 *
 * 导航过渡期间，当前 entry 会短暂离开 RESUMED。用它作为闸门，可以把用户在过渡期间的
 * 重复点击挡掉，避免同一个 destination 被连续压栈多次（表现为返回时要多按几下），
 * 也减少 navigate 与 pop 交替时的竞态。这是 Navigation 官方推荐的去抖判定。
 *
 * 栈为空时放行：那已经是异常态，此时更需要让导航把界面救回来，而不是把它也挡住。
 */
private fun NavController.isReadyForUserNavigation(): Boolean {
    val entry = currentBackStackEntry ?: return true
    return entry.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
}

/**
 * 防重复导航，用于**用户点击触发**的跳转。
 *
 * 注意：不要用在 LaunchedEffect / 协程里的导航上。那类跳转由一次性事件驱动（登出跳登录、
 * 深链、新建文档后跳编辑），触发时机可能正好处在过渡期，被闸门挡掉会直接导致功能失效。
 * 那些地方继续用原生 [NavController.navigate]。
 */
public fun NavController.navigateOnce(route: Any) {
    if (!isReadyForUserNavigation()) return
    navigate(route)
}

/** 带 NavOptions 的重载，语义同上。 */
public fun NavController.navigateOnce(route: Any, builder: NavOptionsBuilder.() -> Unit) {
    if (!isReadyForUserNavigation()) return
    navigate(route, builder)
}

/**
 * String 路由的重载，语义同上。
 *
 * 必须单独提供：字符串路由若落到 [navigateOnce] 的 Any 重载上，会被当成 type-safe 路由
 * 对象去解析，运行时直接失败。会话设置 Sheet 内嵌的 NavHost 用的就是字符串路由。
 */
public fun NavController.navigateOnce(route: String) {
    if (!isReadyForUserNavigation()) return
    navigate(route)
}
