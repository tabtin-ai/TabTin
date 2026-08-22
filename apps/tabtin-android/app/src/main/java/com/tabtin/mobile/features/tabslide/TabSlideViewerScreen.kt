package com.tabtin.mobile.features.tabslide

import android.annotation.SuppressLint
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Fullscreen
import androidx.compose.material.icons.filled.FullscreenExit
import androidx.compose.material.icons.automirrored.outlined.StickyNote2
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.R
import com.tabtin.mobile.data.api.TabSlideApi
import com.tabtin.mobile.data.model.slide.TabSlidePage
import com.tabtin.mobile.data.model.slide.TabSlideDetailResponse
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.web.WebViewRenderProcessGuard
import com.tabtin.mobile.ui.web.releaseSafely
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

// region ViewModel

public data class TabSlideViewerUiState(
    val isLoading: Boolean = true,
    val errorMessage: String? = null,
    val detail: TabSlideDetailResponse? = null,
    val slideName: String = "",
) {
    val pages: List<TabSlidePage> get() = detail?.pages ?: emptyList()
}

@HiltViewModel
public class TabSlideViewerViewModel @Inject constructor(
    private val tabSlideApi: TabSlideApi,
    savedStateHandle: SavedStateHandle,
) : ViewModel() {

    private val slideId: String = savedStateHandle["slideId"] ?: ""

    private val _uiState = MutableStateFlow(
        TabSlideViewerUiState(
            slideName = savedStateHandle["slideName"] ?: "",
        )
    )
    public val uiState: StateFlow<TabSlideViewerUiState> = _uiState.asStateFlow()

    init {
        loadSlide()
    }

    public fun loadSlide() {
        if (slideId.isBlank()) return
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, errorMessage = null)
            try {
                val detail = tabSlideApi.getSlideDetail(slideId).unwrap()
                _uiState.value = _uiState.value.copy(
                    isLoading = false,
                    detail = detail,
                    slideName = detail.displayName,
                )
            } catch (e: Exception) {
                _uiState.value = _uiState.value.copy(
                    isLoading = false,
                    errorMessage = e.localizedMessage ?: "Unknown error",
                )
            }
        }
    }
}

// endregion

// region Screen

private val SlideDarkBg = Color(0xFF1A1A1A)
private val SlideBarBg = Color(0xFF222222)
private val SlideTextPrimary = Color(0xFFE0E0E0)
private val SlideTextSecondary = Color(0xFF999999)

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
public fun TabSlideViewerScreen(
    viewModel: TabSlideViewerViewModel,
    onBack: () -> Unit,
) {
    val state by viewModel.uiState.collectAsState()
    val pages = state.pages
    var isPresenting by remember { mutableStateOf(false) }

    if (isPresenting && pages.isNotEmpty()) {
        PresentationMode(
            pages = pages,
            canvasWidth = state.detail!!.canvasWidth,
            canvasHeight = state.detail!!.canvasHeight,
            onExit = { isPresenting = false },
        )
        return
    }

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.common_back),
                            tint = SlideTextPrimary,
                        )
                    }
                },
                title = {
                    Column {
                        Text(
                            text = state.slideName.ifEmpty { "TabSlide" },
                            style = MaterialTheme.typography.titleMedium,
                            color = SlideTextPrimary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        if (pages.isNotEmpty()) {
                            Text(
                                text = "${pages.size} 页",
                                style = MaterialTheme.typography.labelMedium,
                                color = SlideTextSecondary,
                            )
                        }
                    }
                },
                actions = {
                    if (pages.isNotEmpty()) {
                        IconButton(onClick = { isPresenting = true }) {
                            Icon(
                                Icons.Default.Fullscreen,
                                contentDescription = stringResource(R.string.tabslide_present),
                                tint = SlideTextPrimary,
                            )
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = SlideBarBg,
                ),
            )
        },
        containerColor = SlideDarkBg,
    ) { padding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            when {
                state.isLoading -> SlideLoadingState()
                state.errorMessage != null -> SlideErrorState(
                    message = state.errorMessage!!,
                    onRetry = viewModel::loadSlide,
                )
                pages.isEmpty() -> SlideEmptyState()
                pages.size == 1 -> SingleSlideView(
                    page = pages[0],
                    canvasWidth = state.detail!!.canvasWidth,
                    canvasHeight = state.detail!!.canvasHeight,
                )
                else -> SlidePager(
                    pages = pages,
                    canvasWidth = state.detail!!.canvasWidth,
                    canvasHeight = state.detail!!.canvasHeight,
                )
            }
        }
    }
}

@Composable
private fun SingleSlideView(
    page: TabSlidePage,
    canvasWidth: Int,
    canvasHeight: Int,
) {
    var showRemark by remember { mutableStateOf(false) }
    val hasRemark = !page.remark.isNullOrBlank()

    Column(modifier = Modifier.fillMaxSize()) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f),
        ) {
            if (!page.html.isNullOrBlank()) {
                SlideHtmlView(
                    html = page.html,
                    canvasWidth = canvasWidth,
                    canvasHeight = canvasHeight,
                )
            } else {
                SlidePlaceholder()
            }
        }

        if (hasRemark) {
            SlideRemarkBar(
                showRemark = showRemark,
                onToggle = { showRemark = !showRemark },
                remark = page.remark,
            )
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SlidePager(
    pages: List<TabSlidePage>,
    canvasWidth: Int,
    canvasHeight: Int,
) {
    val pagerState = rememberPagerState(pageCount = { pages.size })
    val scope = rememberCoroutineScope()
    val currentPage = pages.getOrNull(pagerState.currentPage)
    var showRemark by remember { mutableStateOf(false) }
    val hasRemark = !currentPage?.remark.isNullOrBlank()

    Column(modifier = Modifier.fillMaxSize()) {
        HorizontalPager(
            state = pagerState,
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f),
        ) { index ->
            val page = pages[index]
            if (!page.html.isNullOrBlank()) {
                SlideHtmlView(
                    html = page.html,
                    canvasWidth = canvasWidth,
                    canvasHeight = canvasHeight,
                )
            } else {
                SlidePlaceholder()
            }
        }

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(SlideBarBg)
                .padding(vertical = TTSpacing.xs),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(
                onClick = {
                    scope.launch {
                        pagerState.animateScrollToPage(
                            (pagerState.currentPage - 1).coerceAtLeast(0)
                        )
                    }
                },
                enabled = pagerState.currentPage > 0,
            ) {
                Icon(
                    Icons.Default.ChevronLeft,
                    contentDescription = null,
                    tint = if (pagerState.currentPage > 0) SlideTextPrimary
                    else SlideTextPrimary.copy(alpha = 0.3f),
                )
            }

            Text(
                text = "${pagerState.currentPage + 1} / ${pages.size}",
                style = MaterialTheme.typography.labelLarge,
                color = SlideTextPrimary,
            )

            IconButton(
                onClick = {
                    scope.launch {
                        pagerState.animateScrollToPage(
                            (pagerState.currentPage + 1).coerceAtMost(pages.size - 1)
                        )
                    }
                },
                enabled = pagerState.currentPage < pages.size - 1,
            ) {
                Icon(
                    Icons.Default.ChevronRight,
                    contentDescription = null,
                    tint = if (pagerState.currentPage < pages.size - 1) SlideTextPrimary
                    else SlideTextPrimary.copy(alpha = 0.3f),
                )
            }

            if (hasRemark) {
                IconButton(
                    onClick = { showRemark = !showRemark },
                    colors = IconButtonDefaults.iconButtonColors(
                        contentColor = if (showRemark) MaterialTheme.colorScheme.primary
                        else SlideTextSecondary,
                    ),
                ) {
                    Icon(
                        Icons.AutoMirrored.Outlined.StickyNote2,
                        contentDescription = "备注",
                    )
                }
            }
        }

        AnimatedVisibility(
            visible = showRemark && hasRemark,
            enter = expandVertically(),
            exit = shrinkVertically(),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(SlideBarBg)
            ) {
                HorizontalDivider(color = SlideTextSecondary.copy(alpha = 0.2f))
                Text(
                    text = currentPage?.remark ?: "",
                    style = MaterialTheme.typography.bodySmall,
                    color = SlideTextSecondary,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md)
                        .verticalScroll(rememberScrollState()),
                    maxLines = 6,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun SlideRemarkBar(
    showRemark: Boolean,
    onToggle: () -> Unit,
    remark: String,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(SlideBarBg),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = TTSpacing.md, vertical = TTSpacing.xs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(
                onClick = onToggle,
                colors = IconButtonDefaults.iconButtonColors(
                    contentColor = if (showRemark) MaterialTheme.colorScheme.primary
                    else SlideTextSecondary,
                ),
            ) {
                Icon(Icons.AutoMirrored.Outlined.StickyNote2, contentDescription = "备注")
            }
            Text(
                text = "备注",
                style = MaterialTheme.typography.labelMedium,
                color = SlideTextSecondary,
            )
        }

        AnimatedVisibility(
            visible = showRemark,
            enter = expandVertically(),
            exit = shrinkVertically(),
        ) {
            Column {
                HorizontalDivider(color = SlideTextSecondary.copy(alpha = 0.2f))
                Text(
                    text = remark,
                    style = MaterialTheme.typography.bodySmall,
                    color = SlideTextSecondary,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md)
                        .verticalScroll(rememberScrollState()),
                    maxLines = 6,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun SlideHtmlView(
    html: String,
    canvasWidth: Int,
    canvasHeight: Int,
) {
    val wrappedHtml = wrapSlideHtml(html, canvasWidth, canvasHeight)

    // 渲染进程被系统回收后，崩掉的 WebView 实例不能复用（reload 会抛 IllegalStateException），
    // 只能整个换一个新的——reloadToken 就是用来强制 key 重建的。降级 UI 复用 SlideErrorState，
    // 这样单页 / 翻页器 / 演示模式三个调用点都不用改，各自那一页独立降级独立重试。
    var reloadToken by remember { mutableIntStateOf(0) }
    var renderGone by remember { mutableStateOf(false) }

    if (renderGone) {
        SlideErrorState(
            message = stringResource(R.string.error_webview_render_gone),
            onRetry = {
                renderGone = false
                reloadToken += 1
            },
        )
        return
    }

    key(reloadToken) {
        var lastLoadedHtml by remember { mutableStateOf("") }

        AndroidView(
            factory = { ctx ->
                WebView(ctx).apply {
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    settings.loadWithOverviewMode = true
                    settings.useWideViewPort = true
                    settings.builtInZoomControls = true
                    settings.displayZoomControls = false
                    setBackgroundColor(android.graphics.Color.parseColor("#1A1A1A"))
                    webViewClient = object : WebViewClient() {
                        override fun onRenderProcessGone(
                            view: WebView?,
                            detail: RenderProcessGoneDetail?,
                        ): Boolean = WebViewRenderProcessGuard.handle(
                            host = "tabslide_viewer",
                            view = view,
                            detail = detail,
                            onGone = { renderGone = true },
                        )
                    }
                    loadDataWithBaseURL(null, wrappedHtml, "text/html", "utf-8", null)
                    lastLoadedHtml = wrappedHtml
                }
            },
            update = { webView ->
                if (wrappedHtml != lastLoadedHtml) {
                    webView.loadDataWithBaseURL(null, wrappedHtml, "text/html", "utf-8", null)
                    lastLoadedHtml = wrappedHtml
                }
            },
            // 翻页器滑出屏幕的页会离开组合树：不释放的话每页一个 WebView 全都留着，
            // 长演示文稿本身就会把内存顶到触发渲染进程回收。
            onRelease = { it.releaseSafely() },
            modifier = Modifier.fillMaxSize(),
        )
    }
}

private fun wrapSlideHtml(html: String, width: Int, height: Int): String = """
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=3.0, user-scalable=yes">
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
        width: 100%;
        min-height: 100vh;
        background: #1A1A1A;
        display: flex;
        justify-content: center;
        align-items: center;
        padding: 12px;
        -webkit-text-size-adjust: 100%;
    }
    .slide-container {
        width: 100%;
        max-width: ${width}px;
        aspect-ratio: $width / $height;
        background: white;
        border-radius: 4px;
        overflow: hidden;
        box-shadow: 0 4px 24px rgba(0,0,0,0.4);
    }
    .slide-container > * { width: 100%; height: 100%; }
    img { max-width: 100%; height: auto; }
</style>
</head>
<body>
    <div class="slide-container">
        $html
    </div>
</body>
</html>
""".trimIndent()

@Composable
private fun SlidePlaceholder() {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(SlideDarkBg),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = "📑",
            style = MaterialTheme.typography.displayLarge,
        )
    }
}

// endregion

// region States

@Composable
private fun SlideLoadingState() {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
        ) {
            CircularProgressIndicator(color = SlideTextPrimary)
            Text(
                text = stringResource(R.string.common_loading),
                style = MaterialTheme.typography.bodyMedium,
                color = SlideTextSecondary,
            )
        }
    }
}

@Composable
private fun SlideErrorState(message: String, onRetry: () -> Unit) {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
            modifier = Modifier.padding(horizontal = TTSpacing.xl),
        ) {
            Text("⚠️", style = MaterialTheme.typography.displaySmall)
            Text(
                text = message,
                style = MaterialTheme.typography.bodyMedium,
                color = SlideTextSecondary,
                textAlign = TextAlign.Center,
            )
            TextButton(onClick = onRetry) {
                Text(stringResource(R.string.common_retry))
            }
        }
    }
}

@Composable
private fun SlideEmptyState() {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
            modifier = Modifier.padding(horizontal = TTSpacing.xl),
        ) {
            Text("📑", style = MaterialTheme.typography.displaySmall)
            Text(
                text = "暂无幻灯片",
                style = MaterialTheme.typography.titleMedium,
                color = SlideTextSecondary,
            )
        }
    }
}

// endregion

// region Presentation Mode

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun PresentationMode(
    pages: List<TabSlidePage>,
    canvasWidth: Int,
    canvasHeight: Int,
    onExit: () -> Unit,
) {
    val pagerState = rememberPagerState(pageCount = { pages.size })
    var showControls by remember { mutableStateOf(true) }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black)
            .clickable(
                indication = null,
                interactionSource = remember { MutableInteractionSource() },
            ) {
                showControls = !showControls
            },
    ) {
        HorizontalPager(
            state = pagerState,
            modifier = Modifier.fillMaxSize(),
        ) { index ->
            val page = pages[index]
            if (!page.html.isNullOrBlank()) {
                SlideHtmlView(
                    html = page.html,
                    canvasWidth = canvasWidth,
                    canvasHeight = canvasHeight,
                )
            } else {
                SlidePlaceholder()
            }
        }

        AnimatedVisibility(
            visible = showControls,
            enter = fadeIn(),
            exit = fadeOut(),
            modifier = Modifier.align(Alignment.TopEnd),
        ) {
            IconButton(
                onClick = onExit,
                modifier = Modifier.padding(TTSpacing.md),
            ) {
                Icon(
                    Icons.Default.FullscreenExit,
                    contentDescription = stringResource(R.string.common_back),
                    tint = Color.White,
                )
            }
        }

        AnimatedVisibility(
            visible = showControls,
            enter = fadeIn(),
            exit = fadeOut(),
            modifier = Modifier.align(Alignment.BottomCenter),
        ) {
            Text(
                text = "${pagerState.currentPage + 1} / ${pages.size}",
                style = MaterialTheme.typography.labelLarge,
                color = Color.White.copy(alpha = 0.8f),
                modifier = Modifier
                    .background(
                        Color.Black.copy(alpha = 0.5f),
                        shape = RoundedCornerShape(16.dp),
                    )
                    .padding(horizontal = 16.dp, vertical = 8.dp),
            )
        }
    }
}

// endregion
