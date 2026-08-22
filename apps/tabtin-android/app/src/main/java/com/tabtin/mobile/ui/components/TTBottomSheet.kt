package com.tabtin.mobile.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SheetState
import androidx.compose.material3.SheetValue
import androidx.compose.material3.contentColorFor
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController

/**
 * 全局唯一的底部抽屉入口。业务侧一律用它，不要直接调 [ModalBottomSheet]
 * （`scripts/android-check-sheet-insets.sh` 会拦）。
 *
 * ## 为什么要包一层
 *
 * Material3 的 `ModalBottomSheet` 把「内容要吃哪些 window inset」交给调用方，而它内部：
 *
 * - 外层 Surface 有 `consumeWindowInsets(WindowInsets(top = sheetState.offset))`
 * - 内层 Column 有 `windowInsetsPadding(contentWindowInsets())`，默认含 **Top**
 * - 锚点是 `Expanded at fullHeight - sheetSize.height`
 *
 * 于是内容顶部 padding = `max(0, 状态栏高 − offset)`，而内容高度又反过来决定 offset。
 * 设内容高 C、屏高 H、状态栏高 S，当 `C ∈ (H − S, H)` 时两个分支都不自洽 —— 没有不动点，
 * 上滑会让抽屉在测高/改 offset/改 padding 之间无限循环，表现为疯狂上下抖动。
 * 窄带宽度就是状态栏高，所以**同一份代码换台机器就可能不发作**，靠肉眼抽查根本拦不住。
 *
 * 这里把契约收成一条：**顶部 inset 一律不参与测高**（`contentWindowInsets` 置零），
 * 底部避让由内容根统一做。调用点因此没有写错的机会，也不用再自己判断「要不要加 imePadding」。
 *
 * 注意：顶部避让**不能**用 `statusBarsPadding()` 补回来 —— 它同样会被上面那句
 * `consumeWindowInsets` 扣减，等于把环路原样装回去。
 *
 * 背景与取证手法见 `support/mobile/PITFALLS.md` 第 23 条。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun TTBottomSheet(
    onDismissRequest: () -> Unit,
    modifier: Modifier = Modifier,
    sheetState: SheetState = rememberTTSheetState(),
    containerColor: Color = BottomSheetDefaults.ContainerColor,
    contentColor: Color = contentColorFor(containerColor),
    scrimColor: Color = BottomSheetDefaults.ScrimColor,
    dragHandle: @Composable (() -> Unit)? = { BottomSheetDefaults.DragHandle() },
    /** 给抽屉内容根加高度约束。记录详情需要一开始就铺满，避免短内容先半屏再弹开。 */
    contentModifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismissRequest,
        modifier = modifier,
        sheetState = sheetState,
        containerColor = containerColor,
        contentColor = contentColor,
        scrimColor = scrimColor,
        dragHandle = dragHandle,
        // 置零是关键：顶部 inset 一旦参与内容测高就会和 sheet offset 形成自激环。
        contentWindowInsets = { WindowInsets(0, 0, 0, 0) },
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .then(contentModifier)
                .navigationBarsPadding()
                .imePadding(),
            content = content,
        )
    }
}

/**
 * 抽屉状态。默认直接全展开，不要中间态。
 *
 * @param confirmValueChange 返回 false 可拦下一次状态切换（例如提交中不许被划走）。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun rememberTTSheetState(
    skipPartiallyExpanded: Boolean = true,
    confirmValueChange: (SheetValue) -> Boolean = { true },
): SheetState = rememberModalBottomSheetState(
    skipPartiallyExpanded = skipPartiallyExpanded,
    confirmValueChange = confirmValueChange,
)

/**
 * 抽屉内容列。系统栏避让已由 [TTBottomSheet] 统一处理，这里只管排版和滚动。
 *
 * @param scrollable 表单类内容传 true，便于聚焦时滚入可视区；内部已有 LazyColumn 时传 false，避免嵌套滚动。
 */
@Composable
public fun TTSheetColumn(
    scrollable: Boolean = true,
    verticalArrangement: Arrangement.Vertical = Arrangement.Top,
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    val scrollModifier = if (scrollable) Modifier.verticalScroll(rememberScrollState()) else Modifier
    Column(
        modifier = modifier
            .fillMaxWidth()
            .then(scrollModifier)
            .dismissKeyboardOnBackgroundTap(),
        verticalArrangement = verticalArrangement,
        content = content,
    )
}

/** 仅空白区域的轻点会触发；已被输入框、按钮或列表消费的点击保持原行为。 */
@Composable
internal fun Modifier.dismissKeyboardOnBackgroundTap(): Modifier {
    val focusManager = LocalFocusManager.current
    val keyboardController = LocalSoftwareKeyboardController.current
    return pointerInput(focusManager, keyboardController) {
        awaitEachGesture {
            // Final pass 能看到子控件是否已经消费这次点击：输入框、按钮和列表项保持原行为，
            // 只有表单空白区域的轻点会移除焦点并收起键盘。
            val down = awaitFirstDown(requireUnconsumed = true, pass = PointerEventPass.Final)
            val up = waitForUpOrCancellation(pass = PointerEventPass.Final)
            if (up != null && !up.isConsumed) {
                focusManager.clearFocus()
                keyboardController?.hide()
            }
        }
    }
}
