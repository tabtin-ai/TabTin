package com.tabtin.mobile.features.conversation

/**
 * 胶囊菜单「语音」handoff：一次菜单选择只触发一轮开录。
 *
 * 窄屏切回话会卸载胶囊，再回工作台会重新组合。若用「粘性 tick + LaunchedEffect」
 * 且不记录已消费代数，重挂载会带着同一个 tick>0 再次 [beginHold]，表现为
 * 取消后仍反复出现聆听条。
 */
internal object CapsuleMenuVoiceHandoff {
    fun shouldBegin(requestGeneration: Int, consumedGeneration: Int): Boolean =
        requestGeneration > 0 && requestGeneration > consumedGeneration
}
