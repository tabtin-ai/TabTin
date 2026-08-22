package com.tabtin.mobile.features.tabsite

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.OpenInBrowser
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.viewinterop.AndroidView
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.web.WebViewRenderProcessGuard
import com.tabtin.mobile.ui.web.releaseSafely
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun TabSitePreviewScreen(
    viewModel: TabSitePreviewViewModel,
    onBack: () -> Unit,
) {
    val state by viewModel.uiState.collectAsState()
    val context = LocalContext.current
    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    var webViewProgress by remember { mutableIntStateOf(0) }
    val linkCopiedMsg = stringResource(R.string.tabsite_link_copied)

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.common_back),
                        )
                    }
                },
                title = {
                    Column {
                        Text(
                            text = state.siteName.ifEmpty { stringResource(R.string.tabsite_preview_title) },
                            style = MaterialTheme.typography.titleMedium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        StatusBadge(status = state.status)
                    }
                },
                actions = {
                    if (state.hasPublishedUrl) {
                        IconButton(onClick = {
                            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                            clipboard.setPrimaryClip(ClipData.newPlainText("TabSite URL", state.siteUrl))
                            scope.launch { snackbarHostState.showSnackbar(linkCopiedMsg) }
                        }) {
                            Icon(
                                Icons.Default.ContentCopy,
                                contentDescription = stringResource(R.string.tabsite_copy_link),
                            )
                        }
                        IconButton(onClick = {
                            val shareIntent = Intent(Intent.ACTION_SEND).apply {
                                type = "text/plain"
                                putExtra(Intent.EXTRA_SUBJECT, state.siteName)
                                putExtra(Intent.EXTRA_TEXT, state.siteUrl)
                            }
                            context.startActivity(Intent.createChooser(shareIntent, null))
                        }) {
                            Icon(
                                Icons.Default.Share,
                                contentDescription = stringResource(R.string.tabsite_share),
                            )
                        }
                        IconButton(onClick = {
                            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(state.siteUrl)))
                        }) {
                            Icon(
                                Icons.Default.OpenInBrowser,
                                contentDescription = stringResource(R.string.tabsite_open_in_browser),
                            )
                        }
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            if (state.isLoading && webViewProgress in 1..99) {
                LinearProgressIndicator(
                    progress = { webViewProgress / 100f },
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            if (!state.hasPublishedUrl) {
                EmptyStateView()
            } else {
                Box(modifier = Modifier.fillMaxSize()) {
                    androidx.compose.runtime.key(state.reloadKey) {
                    SiteWebView(
                        url = state.siteUrl,
                        onPageStarted = viewModel::onPageStarted,
                        onPageFinished = viewModel::onPageFinished,
                        onPageError = viewModel::onPageError,
                        onRenderGone = viewModel::onRenderProcessGone,
                        onProgressChanged = { webViewProgress = it },
                    )
                    }

                    // 渲染进程被回收时 WebView 已被销毁并摘出容器，这个 overlay 就是用户唯一
                    // 看得见的东西——不能白屏。重试走 reloadKey 重建实例（见 ViewModel 注释）。
                    val overlayMessage = if (state.renderProcessGone) {
                        stringResource(R.string.error_webview_render_gone)
                    } else {
                        state.errorMessage
                    }
                    if (overlayMessage != null) {
                        ErrorOverlay(
                            message = overlayMessage,
                            onRetry = { viewModel.retry() },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun StatusBadge(status: String) {
    val (label, color) = when (status) {
        "published" -> stringResource(R.string.tabsite_status_published) to MaterialTheme.colorScheme.primary
        "archived" -> stringResource(R.string.tabsite_status_archived) to MaterialTheme.colorScheme.error
        else -> stringResource(R.string.tabsite_status_draft) to MaterialTheme.colorScheme.outline
    }
    Text(
        text = label,
        style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold),
        color = color,
    )
}

@Composable
private fun ErrorOverlay(message: String, onRetry: () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(TTSpacing.xxl),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text("⚠️", style = MaterialTheme.typography.displayMedium)
            Spacer(Modifier.height(TTSpacing.md))
            Text(
                text = stringResource(R.string.tabsite_load_error),
                style = MaterialTheme.typography.titleMedium,
            )
            Spacer(Modifier.height(TTSpacing.xs))
            Text(
                text = message,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(TTSpacing.lg))
            Button(onClick = onRetry) {
                Icon(
                    Icons.Default.Refresh,
                    contentDescription = null,
                    modifier = Modifier.padding(end = TTSpacing.xs),
                )
                Text(stringResource(R.string.common_retry))
            }
        }
    }
}

@Composable
private fun EmptyStateView() {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
            modifier = Modifier.padding(horizontal = TTSpacing.xxl),
        ) {
            Text("🌐", style = MaterialTheme.typography.displayMedium)
            Text(
                text = stringResource(R.string.tabsite_not_published),
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                text = stringResource(R.string.tabsite_not_published_hint),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun SiteWebView(
    url: String,
    onPageStarted: () -> Unit,
    onPageFinished: () -> Unit,
    onPageError: (String?) -> Unit,
    onRenderGone: () -> Unit,
    onProgressChanged: (Int) -> Unit,
) {
    AndroidView(
        factory = { ctx ->
            WebView(ctx).apply {
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.loadWithOverviewMode = true
                settings.useWideViewPort = true

                webViewClient = object : WebViewClient() {
                    override fun onPageStarted(view: WebView?, u: String?, favicon: Bitmap?) {
                        onPageStarted()
                    }

                    override fun onPageFinished(view: WebView?, u: String?) {
                        onPageFinished()
                    }

                    override fun onReceivedError(
                        view: WebView?,
                        request: WebResourceRequest?,
                        error: WebResourceError?,
                    ) {
                        if (request?.isForMainFrame == true) {
                            onPageError(error?.description?.toString())
                        }
                    }

                    override fun onRenderProcessGone(
                        view: WebView?,
                        detail: RenderProcessGoneDetail?,
                    ): Boolean = WebViewRenderProcessGuard.handle(
                        host = "tabsite_preview",
                        view = view,
                        detail = detail,
                        onGone = { onRenderGone() },
                    )
                }

                webChromeClient = object : WebChromeClient() {
                    override fun onProgressChanged(view: WebView?, newProgress: Int) {
                        onProgressChanged(newProgress)
                    }
                }

                loadUrl(url)
            }
        },
        // reloadKey 变化 / 离开预览页时释放实例：不释放会让废弃的 WebView 一直占着渲染进程，
        // 反过来加剧触发 onRenderProcessGone 的内存压力。
        onRelease = { it.releaseSafely() },
        modifier = Modifier.fillMaxSize(),
    )
}
