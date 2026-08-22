package com.tabtin.mobile.features.conversation

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.media.MediaPlayer
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.MediaController
import android.widget.VideoView
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import coil.compose.AsyncImage
import com.tabtin.mobile.R
import com.tabtin.mobile.data.oss.UploadConfig
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import com.tabtin.mobile.ui.web.WebViewRenderProcessGuard
import com.tabtin.mobile.ui.web.releaseSafely
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import com.tabtin.mobile.diagnostics.DiagnosticRecorder
import com.tabtin.mobile.diagnostics.diagnosticRecorder
import java.net.URLEncoder
import java.net.URL
import java.security.MessageDigest
import java.util.Locale
import kotlin.math.sqrt

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ChatFilePreviewDialog(
    fileUrl: String,
    filename: String?,
    mimeType: String?,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    val previewType = remember(fileUrl, filename, mimeType) {
        ChatPreviewType.from(mimeType, filename)
    }
    val displayName = filename?.takeIf { it.isNotBlank() } ?: stringResource(R.string.common_file)

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(
            usePlatformDefaultWidth = false,
            decorFitsSystemWindows = false,
        ),
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .background(ttColor(TTColors.Background, TTColors.Dark.Background))
                .statusBarsPadding(),
        ) {
            TopAppBar(
                title = {
                    Column {
                        Text(
                            text = displayName,
                            style = TTFonts.bodySemibold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            text = previewType.label(context),
                            style = TTFonts.caption,
                            color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                            maxLines = 1,
                        )
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onDismiss) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.common_close),
                        )
                    }
                },
                actions = {
                    IconButton(onClick = { shareFileLink(context, fileUrl) }) {
                        Icon(
                            Icons.Default.Share,
                            contentDescription = stringResource(R.string.common_share),
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = ttColor(TTColors.Background, TTColors.Dark.Background),
                ),
            )

            Box(modifier = Modifier.fillMaxSize()) {
                when (previewType) {
                    ChatPreviewType.PDF -> PdfPreviewBody(fileUrl = fileUrl, filename = filename)
                    ChatPreviewType.WORD,
                    ChatPreviewType.EXCEL,
                    ChatPreviewType.PPT,
                    -> OfficePreviewBody(fileUrl = fileUrl, previewType = previewType)
                    ChatPreviewType.AUDIO -> AudioPreviewBody(fileUrl = fileUrl, title = displayName)
                    ChatPreviewType.VIDEO -> VideoPreviewBody(fileUrl = fileUrl)
                    ChatPreviewType.IMAGE -> ImagePreviewBody(fileUrl = fileUrl, filename = displayName)
                    ChatPreviewType.FALLBACK -> UnsupportedPreviewBody(
                        title = displayName,
                        description = stringResource(R.string.chat_file_preview_unsupported_desc),
                        actionUrl = fileUrl,
                    )
                }
            }
        }
    }
}

private enum class ChatPreviewType {
    PDF, WORD, EXCEL, PPT, AUDIO, VIDEO, IMAGE, FALLBACK;

    fun label(context: Context): String = when (this) {
        PDF -> context.getString(R.string.chat_file_preview_pdf)
        WORD -> context.getString(R.string.chat_file_preview_word)
        EXCEL -> context.getString(R.string.chat_file_preview_excel)
        PPT -> context.getString(R.string.chat_file_preview_ppt)
        AUDIO -> context.getString(R.string.chat_file_preview_audio)
        VIDEO -> context.getString(R.string.chat_file_preview_video)
        IMAGE -> context.getString(R.string.cloud_file_preview)
        FALLBACK -> context.getString(R.string.chat_file_preview_file)
    }

    companion object {
        fun from(mimeType: String?, filename: String?): ChatPreviewType {
            val ext = filename?.substringAfterLast('.', "")?.lowercase(Locale.ROOT)
            return when (UploadConfig.fileCategory(mimeType, ext)) {
                UploadConfig.FileCategory.PDF -> PDF
                UploadConfig.FileCategory.WORD -> WORD
                UploadConfig.FileCategory.EXCEL -> EXCEL
                UploadConfig.FileCategory.PPT -> PPT
                UploadConfig.FileCategory.AUDIO -> AUDIO
                UploadConfig.FileCategory.VIDEO -> VIDEO
                UploadConfig.FileCategory.IMAGE -> IMAGE
                else -> FALLBACK
            }
        }
    }
}

@Composable
private fun ImagePreviewBody(fileUrl: String, filename: String) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(TTColors.Background),
        contentAlignment = Alignment.Center,
    ) {
        AsyncImage(
            model = fileUrl,
            contentDescription = filename,
            contentScale = ContentScale.Fit,
            modifier = Modifier
                .fillMaxSize()
                .padding(TTSpacing.lg),
        )
    }
}

@Composable
private fun PdfPreviewBody(fileUrl: String, filename: String?) {
    val context = LocalContext.current
    // Wave 5 review FIX：retryKey 驱动 LaunchedEffect 重跑，与 Audio 的 retry 模式对齐。
    // 失败状态下用户可点"重试"而不用关闭 Dialog 再重开；对弱网抖动尤其有用。
    var retryKey by remember(fileUrl) { mutableIntStateOf(0) }
    var state by remember(fileUrl, retryKey) { mutableStateOf<PdfPreviewState?>(null) }
    var error by remember(fileUrl, retryKey) { mutableStateOf<String?>(null) }

    LaunchedEffect(fileUrl, retryKey) {
        state = null
        error = null
        // Wave 5 技术优雅度 Review D1：runCatching 会捕获 CancellationException，
        // LaunchedEffect key 变化时协程 cancel → onFailure 触发 → error 态被写入旧 state，
        // 再 recompose 时能看到"加载失败"闪现一帧。这里改 try/catch 并显式重抛 Cancel。
        try {
            val loaded = withContext(Dispatchers.IO) {
                val file = cacheRemoteFile(context, fileUrl, filename, "pdf")
                val pageCount = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { pfd ->
                    PdfRenderer(pfd).use { it.pageCount }
                }
                PdfPreviewState(file, pageCount)
            }
            state = loaded
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            error = context.getString(R.string.chat_file_preview_pdf_failed_desc)
        }
    }

    when {
        error != null -> UnsupportedPreviewBody(
            title = stringResource(R.string.chat_file_preview_pdf_failed),
            description = error ?: "",
            actionUrl = fileUrl,
            // Wave 5 协议 Review P-1 修正：retry 前先删缓存文件——否则 cacheRemoteFile 命中
            // SHA-256 cache 直接返回同一个坏文件（比如"HTTP 200 但 body 是 HTML 错误页"），
            // 造成"点重试 = 再次报错"的假无效 retry 循环。tmp 半下载文件不会被 rename 到
            // final 路径所以网络失败场景已自然走重下；此修复覆盖"下了但内容坏"窗口。
            onRetry = {
                cacheFileFor(context, fileUrl, filename, "pdf").runCatching { delete() }
                retryKey += 1
            },
        )
        state == null -> LoadingPreviewBody(stringResource(R.string.chat_file_preview_loading_pdf))
        else -> PdfPager(state = state!!)
    }
}

@Composable
private fun PdfPager(state: PdfPreviewState) {
    var pageIndex by remember(state.file.absolutePath) { mutableIntStateOf(0) }
    val pageCount = state.pageCount.coerceAtLeast(1)

    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = TTSpacing.md, vertical = TTSpacing.xs),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            TextButton(
                enabled = pageIndex > 0,
                onClick = { pageIndex = (pageIndex - 1).coerceAtLeast(0) },
            ) {
                Text(stringResource(R.string.chat_file_preview_previous_page))
            }
            Text(
                text = stringResource(R.string.chat_file_preview_page_count, pageIndex + 1, pageCount),
                style = TTFonts.caption,
                color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            )
            TextButton(
                enabled = pageIndex < pageCount - 1,
                onClick = { pageIndex = (pageIndex + 1).coerceAtMost(pageCount - 1) },
            ) {
                Text(stringResource(R.string.chat_file_preview_next_page))
            }
        }
        PdfPageImage(
            file = state.file,
            pageIndex = pageIndex,
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState()),
        )
    }
}

@Composable
private fun PdfPageImage(
    file: File,
    pageIndex: Int,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    var bitmap by remember(file.absolutePath, pageIndex) { mutableStateOf<Bitmap?>(null) }
    var error by remember(file.absolutePath, pageIndex) { mutableStateOf<String?>(null) }

    LaunchedEffect(file.absolutePath, pageIndex) {
        bitmap = null
        error = null
        // Wave 5 技术优雅度 Review D1：快速翻页时 LaunchedEffect cancel 会被 runCatching 吞成
        // onFailure → 闪现"加载失败"。改 try/catch 并显式重抛 Cancel。
        try {
            bitmap = withContext(Dispatchers.IO) { renderPdfPage(file, pageIndex) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.localizedMessage ?: context.getString(R.string.common_loading_failed)
        }
    }

    val bitmapToRecycle = bitmap
    DisposableEffect(bitmapToRecycle) {
        onDispose {
            bitmapToRecycle?.recycle()
        }
    }

    Box(modifier = modifier.padding(TTSpacing.md), contentAlignment = Alignment.TopCenter) {
        when {
            error != null -> PreviewErrorText(error ?: "")
            bitmap == null -> CircularProgressIndicator(modifier = Modifier.padding(top = TTSpacing.xl))
            else -> Image(
                bitmap = bitmap!!.asImageBitmap(),
                contentDescription = stringResource(R.string.chat_file_preview_pdf_page),
                modifier = Modifier.fillMaxWidth(),
                contentScale = ContentScale.FillWidth,
            )
        }
    }
}

/**
 * Wave 5 独立验证 🟡-1：Office viewer 是第三方公网服务（Microsoft Office Online /
 * Google Docs），会把 OSS signed URL 发给它们让它们 fetch 原文——合同/内部表格/岗位
 * 信息会整包进这两家服务的日志/缓存。iOS 用 QuickLook 完全本地没这个合规问题；
 * Android 必须在加载前先征得用户知情同意。
 *
 * 状态选择：进程级（process-scoped）@Volatile 而非 SharedPreferences。
 *   - 理由：「session 同意」理解为 app 进程生命周期；cold start 重新问一次更保守
 *     （对企业合规场景尤为合适）
 *   - 实现上也简化：不需要注入 Context / 不需要 coroutine 读写 DataStore
 *   - 如果产品决策改为"跨进程永久记住"，把这里换成 SharedPreferences / DataStore
 *     即可，其余 UI 层代码不变
 */
private object OfficeViewerConsent {
    @Volatile
    var granted: Boolean = false
}

@Composable
private fun OfficePreviewBody(fileUrl: String, previewType: ChatPreviewType) {
    val context = LocalContext.current

    // Wave 5 独立验证 🟡-1：知情同意 gate。未同意时不进 WebView，也不跑 30s 超时
    // LaunchedEffect，确保"用户没点同意前 OSS URL 绝不发给第三方"。
    // 每次进入新 fileUrl 的 OfficePreviewBody 时，初始值取 process 级 granted 状态；
    // 用户在当前 Composable 内点击"继续预览"会同时把两侧都置 true。
    var consented by remember(fileUrl) { mutableStateOf(OfficeViewerConsent.granted) }

    // retryKey：点击"重试"时把 viewerIndex 归零 + failed 重置，重新尝试 office.live.com
    // → docs.google.com 两路 viewer。对弱网 / 公司网关短暂抽风尤其有用。
    var retryKey by remember(fileUrl) { mutableIntStateOf(0) }
    val viewerUrls = remember(fileUrl) { officeViewerUrls(fileUrl) }
    var viewerIndex by remember(fileUrl, retryKey, consented) { mutableIntStateOf(0) }
    var failed by remember(fileUrl, retryKey, consented) { mutableStateOf(false) }
    var loading by remember(fileUrl, retryKey, viewerIndex, consented) { mutableStateOf(true) }
    // 渲染进程被系统回收：与 failed 分开记，因为降级文案不一样（不是"这个文档预览不了"，
    // 而是"WebView 实例没了，重试会重建"），但都走 UnsupportedPreviewBody + 重试。
    var renderGone by remember(fileUrl, retryKey, consented) { mutableStateOf(false) }
    val viewerUrl = viewerUrls.getOrNull(viewerIndex)

    // viewerUrls 为空意味着 fileUrl scheme 非 http/https，viewer 路径根本走不了——
    // 直接走 UnsupportedPreviewBody（与原行为一致，下方 `if (viewerUrl == null ...)` 分支覆盖），
    // 无需征求同意（因为根本没有对外请求）。
    if (!consented && viewerUrls.isNotEmpty()) {
        OfficeConsentBody(
            previewType = previewType,
            fileUrl = fileUrl,
            onContinue = {
                OfficeViewerConsent.granted = true
                consented = true
            },
        )
        return
    }

    // Wave 5 用户视角 Review F10：Office viewer 走 HTTP 200 但页面空白时 WebView 的
    // onReceivedError 永远不触发，用户看到菊花转圈直到天荒地老。30s 超时兜底：第一路 viewer
    // 超时则 auto 切第二路；第二路超时则 failed 态。与 iOS ChatFilePreviewSheet.swift:506-523
    // 的 ready 超时行为对齐。
    LaunchedEffect(fileUrl, retryKey, viewerIndex) {
        if (viewerUrls.isEmpty() || failed) return@LaunchedEffect
        delay(30_000L)
        if (loading) {
            if (viewerIndex < viewerUrls.lastIndex) {
                viewerIndex += 1
            } else {
                failed = true
            }
        }
    }

    if (viewerUrl == null || failed || renderGone) {
        UnsupportedPreviewBody(
            title = previewType.label(context),
            description = if (renderGone) {
                stringResource(R.string.error_webview_render_gone)
            } else {
                stringResource(R.string.chat_file_preview_office_fallback)
            },
            actionUrl = fileUrl,
            // viewerUrls 为空（scheme 非 http/https）时没有重试意义；两路 viewer 都失败时可以重试。
            onRetry = if (viewerUrls.isNotEmpty()) { { retryKey += 1 } } else null,
        )
        return
    }

    Box(modifier = Modifier.fillMaxSize()) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { ctx ->
                WebView(ctx).apply {
                    layoutParams = ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT,
                    )
                    setBackgroundColor(Color.TRANSPARENT)
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    // Wave 5 技术优雅度 Review I4：显式关闭文件/内容访问（SDK 29+ 默认 false，
                    // 但显式声明比依赖默认更安全；Office Viewer 只需要 https）。
                    settings.allowFileAccess = false
                    settings.allowContentAccess = false
                    settings.setJavaScriptCanOpenWindowsAutomatically(false)
                    webViewClient = object : WebViewClient() {
                        override fun onReceivedError(
                            view: WebView?,
                            request: WebResourceRequest?,
                            error: WebResourceError?,
                        ) {
                            if (request?.isForMainFrame != false) {
                                if (viewerIndex < viewerUrls.lastIndex) {
                                    loading = true
                                    viewerIndex += 1
                                } else {
                                    loading = false
                                    failed = true
                                }
                            }
                        }

                        override fun onPageFinished(view: WebView?, url: String?) {
                            loading = false
                        }

                        // Wave 5 技术优雅度 Review T3：内部 URL 只允许 viewer 域名，其他
                        // 外链走系统 Intent 打开，避免 WebView 变成不受控的浏览器。
                        override fun shouldOverrideUrlLoading(
                            view: WebView?,
                            request: WebResourceRequest?,
                        ): Boolean {
                            val host = request?.url?.host.orEmpty()
                            if (host.endsWith("officeapps.live.com") ||
                                host.endsWith("docs.google.com") ||
                                host.endsWith("office.com") ||
                                host.endsWith("google.com")
                            ) {
                                return false
                            }
                            return true
                        }

                        override fun onRenderProcessGone(
                            view: WebView?,
                            detail: RenderProcessGoneDetail?,
                        ): Boolean = WebViewRenderProcessGuard.handle(
                            host = "chat_file_preview_office",
                            view = view,
                            detail = detail,
                            onGone = {
                                // loading 一并落下，否则上面那个 30s 超时兜底还会去翻 viewerIndex。
                                loading = false
                                renderGone = true
                            },
                        )
                    }
                    loadUrl(viewerUrl)
                }
            },
            update = { view ->
                if (view.url != viewerUrl) {
                    loading = true
                    view.loadUrl(viewerUrl)
                }
            },
            // 渲染进程终止的实例已在 onRenderProcessGone 里 destroy 过，再 stopLoading /
            // destroy 会抛 IllegalStateException——releaseSafely 认标记直接跳过。
            onRelease = { view -> view.releaseSafely() },
        )
        if (loading) {
            Column(
                modifier = Modifier
                    .align(Alignment.Center)
                    .background(
                        color = ttColor(TTColors.Background, TTColors.Dark.Background).copy(alpha = 0.92f),
                        shape = TTRadius.Shapes.md,
                    )
                    .padding(TTSpacing.md),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                CircularProgressIndicator()
                Spacer(Modifier.height(TTSpacing.sm))
                Text(
                    text = stringResource(R.string.chat_file_preview_loading_office),
                    style = TTFonts.caption,
                    color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                )
            }
        }
    }
}

/**
 * Wave 5 独立验证 🟡-1：Office viewer 同意界面。
 *
 * 布局（与 UnsupportedPreviewBody 视觉风格一致，都是"失败/占位"类大居中 Icon + 标题 + 描述 +
 * 双按钮）：
 *   [!icon]
 *   此预览由第三方服务加载
 *   文件内容会离开设备进入第三方服务的日志与缓存...
 *   (小字) 同意后当前会话内再次打开 Office 文件不会重复提示。
 *   [仅下载]  [继续预览]
 *
 * 按钮语义：
 *   - "仅下载"（主按钮/左）：走 ACTION_VIEW 外部 Intent 打开 fileUrl，让系统选装了的本地应用
 *     （WPS / MS Office / Files / 浏览器下载）处理。这和 Wave 5 北极星"不跳出"并不冲突——
 *     用户明确选择把文件交给外部应用；比默默把 URL 送第三方 viewer 更合规。
 *     若系统没有 handler，兜底 Toast 提示安装本地阅读器。
 *   - "继续预览"（次按钮/右）：onContinue 把 consent 置 true，OfficePreviewBody 下一帧进 WebView。
 *
 * 产品决策：主按钮放"仅下载"而非"继续预览"——默认引导用户走更保守的路径，需要第三方 viewer
 * 的才显式选择。Electron 桌面端用本地 buffer 渲染没这个问题，iOS 用 QuickLook 也没这个问题，
 * Android 因为 runtime 只有 WebView 方案所以必须让用户知情。
 */
@Composable
private fun OfficeConsentBody(
    previewType: ChatPreviewType,
    fileUrl: String,
    onContinue: () -> Unit,
) {
    val context = LocalContext.current
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(TTSpacing.lg),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(
            Icons.Default.ErrorOutline,
            contentDescription = null,
            modifier = Modifier.size(40.dp),
            tint = ttColor(TTColors.BgWarning, TTColors.Dark.BgWarning),
        )
        Spacer(Modifier.height(TTSpacing.md))
        Text(
            text = stringResource(R.string.chat_file_preview_office_consent_title),
            style = ConversationTypography.bodySemibold.copy(fontWeight = FontWeight.SemiBold),
            color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
        )
        Spacer(Modifier.height(TTSpacing.sm))
        Text(
            text = stringResource(R.string.chat_file_preview_office_consent_message),
            style = TTFonts.caption,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
        )
        Spacer(Modifier.height(TTSpacing.sm))
        Text(
            text = stringResource(R.string.chat_file_preview_office_consent_hint),
            style = TTFonts.caption,
            color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
        )
        Spacer(Modifier.height(TTSpacing.lg))
        Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
            // "仅下载" 主按钮（左）—— 保守路径
            Button(onClick = { openOfficeFileExternally(context, fileUrl) }) {
                Text(stringResource(R.string.chat_file_preview_office_consent_download))
            }
            // "继续预览" 次按钮（右）—— 用户明确接受把 URL 送第三方
            TextButton(onClick = onContinue) {
                Text(stringResource(R.string.chat_file_preview_office_consent_continue))
            }
        }
    }
}

/**
 * "仅下载" 按钮的外部 Intent 派发。ACTION_VIEW + fileUrl，让系统选装了的本地阅读器
 * （WPS / MS Office / Files / 浏览器下载）处理。找不到 handler 时 Toast 引导安装。
 *
 * 为什么用 ACTION_VIEW 而不是 ACTION_SEND：ACTION_VIEW 让系统匹配能处理 Office 文件的应用
 * （或浏览器走下载），语义更贴合用户预期；ACTION_SEND 是"分享链接文本"，对于"我想打开这个
 * 文件"的意图是绕弯。这个选择与 UnsupportedPreviewBody 的 shareFileLink 路径互补：
 *   - 同意界面的"仅下载"：ACTION_VIEW（让系统打开文件）
 *   - Unsupported 兜底的"分享链接"：ACTION_SEND（让用户发给电脑/同事）
 */
private fun openOfficeFileExternally(context: Context, fileUrl: String) {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(fileUrl)).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    try {
        context.startActivity(intent)
    } catch (_: ActivityNotFoundException) {
        android.widget.Toast.makeText(
            context,
            context.getString(R.string.chat_file_preview_office_consent_no_handler),
            android.widget.Toast.LENGTH_LONG,
        ).show()
    }
}

@Composable
private fun AudioPreviewBody(fileUrl: String, title: String) {
    val context = LocalContext.current
    // Wave 5 用户视角 Review FIX-3：retryKey 变化驱动 LaunchedEffect 重跑，
    // 让 error 态的"重试"按钮能重新触发 setDataSource + prepareAsync，
    // 对齐 iOS `PreviewFailureView.onRetry`。不需要销毁/重建整个 Dialog。
    var retryKey by remember(fileUrl) { mutableIntStateOf(0) }
    val player = remember(fileUrl) { MediaPlayer() }
    var prepared by remember(fileUrl, retryKey) { mutableStateOf(false) }
    var error by remember(fileUrl, retryKey) { mutableStateOf<String?>(null) }
    var isPlaying by remember(fileUrl, retryKey) { mutableStateOf(false) }
    var durationMs by remember(fileUrl, retryKey) { mutableIntStateOf(0) }
    var positionMs by remember(fileUrl, retryKey) { mutableIntStateOf(0) }
    var sliderPosition by remember(fileUrl, retryKey) { mutableFloatStateOf(0f) }
    // Wave 5 用户视角 Review B6：用户拖动 slider 时每 500ms 的 position 回写会把滑块"弹回"
    // 真实播放位置，长距离拖动闪烁。isUserDragging 在 onValueChange 触发期间置 true，
    // onValueChangeFinished 置回 false；while 循环仅在非拖动时回写。与标准音乐 app 行为对齐。
    var isUserDragging by remember(fileUrl, retryKey) { mutableStateOf(false) }

    DisposableEffect(fileUrl) {
        onDispose {
            runCatching { player.release() }
        }
    }

    LaunchedEffect(fileUrl, retryKey) {
        // Wave 5 技术优雅度 Review D1：setDataSource + prepareAsync 如果抛协程 Cancel 会被
        // runCatching 吞 → 进入 error 态。这里改 try/catch 显式重抛 Cancel。
        try {
            player.reset()
            player.setDataSource(context, Uri.parse(fileUrl))
            player.setOnPreparedListener {
                durationMs = it.duration.coerceAtLeast(0)
                prepared = true
            }
            player.setOnErrorListener { _, _, _ ->
                error = context.getString(R.string.chat_file_preview_audio_failed)
                isPlaying = false
                prepared = false
                true
            }
            player.setOnCompletionListener {
                // 播完 seek 回 0，对齐 iOS `AVPlayerItemDidPlayToEndTime` —— 不 seek 用户再点
                // 播放时 MediaPlayer 仍在 duration 位置，不响应。
                isPlaying = false
                runCatching { player.seekTo(0) }
                positionMs = 0
                sliderPosition = 0f
            }
            player.prepareAsync()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.localizedMessage ?: context.getString(R.string.chat_file_preview_audio_failed)
        }
    }

    LaunchedEffect(isPlaying, prepared) {
        while (isPlaying && prepared) {
            // 拖动期间不回写 sliderPosition，避免把用户拖到一半的滑块"弹回"真实播放位置
            if (!isUserDragging) {
                positionMs = runCatching { player.currentPosition }.getOrDefault(positionMs)
                sliderPosition = positionMs.toFloat()
            }
            delay(500)
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(TTSpacing.lg),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = title,
            style = ConversationTypography.bodySemibold,
            color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        Spacer(Modifier.height(TTSpacing.lg))
        if (error != null) {
            PreviewErrorText(error ?: "")
            Spacer(Modifier.height(TTSpacing.sm))
            TextButton(onClick = { retryKey += 1 }) {
                Text(stringResource(R.string.common_retry))
            }
            return@Column
        }
        if (!prepared) {
            CircularProgressIndicator()
            Spacer(Modifier.height(TTSpacing.sm))
            Text(
                text = stringResource(R.string.chat_file_preview_loading_audio),
                style = TTFonts.caption,
                color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            )
            return@Column
        }

        IconButton(
            onClick = {
                if (player.isPlaying) {
                    player.pause()
                    isPlaying = false
                } else {
                    player.start()
                    isPlaying = true
                }
            },
            modifier = Modifier.size(64.dp),
        ) {
            Icon(
                imageVector = if (isPlaying) Icons.Default.Pause else Icons.Default.PlayArrow,
                contentDescription = if (isPlaying) {
                    stringResource(R.string.chat_file_preview_pause)
                } else {
                    stringResource(R.string.chat_file_preview_play)
                },
                modifier = Modifier.size(48.dp),
                tint = ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent),
            )
        }
        Slider(
            value = sliderPosition.coerceIn(0f, durationMs.toFloat().coerceAtLeast(1f)),
            onValueChange = {
                isUserDragging = true
                sliderPosition = it
                positionMs = it.toInt()
            },
            onValueChangeFinished = {
                val target = sliderPosition.toInt().coerceIn(0, durationMs)
                runCatching { player.seekTo(target) }
                positionMs = target
                isUserDragging = false
            },
            valueRange = 0f..durationMs.toFloat().coerceAtLeast(1f),
            modifier = Modifier.fillMaxWidth(),
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(formatDuration(positionMs), style = TTFonts.caption)
            Text(formatDuration(durationMs), style = TTFonts.caption)
        }
    }
}

@Composable
private fun VideoPreviewBody(fileUrl: String) {
    // retryKey：点击"重试"时重建 VideoView（key 作为 AndroidView key 让 factory 重跑），
    // 对网络抖动导致的 MediaPlayer errorListener 回调有用。与 PDF/Audio 同模式。
    var retryKey by remember(fileUrl) { mutableIntStateOf(0) }
    var loading by remember(fileUrl, retryKey) { mutableStateOf(true) }
    var error by remember(fileUrl, retryKey) { mutableStateOf(false) }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(TTColors.FullscreenBackground),
        contentAlignment = Alignment.Center,
    ) {
        if (!error) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                // retryKey 作为 key 强制 factory 重建 VideoView，确保重试时清空旧 MediaPlayer 状态
                factory = { ctx ->
                    VideoView(ctx).apply {
                        setTag(retryKey)
                        setVideoURI(Uri.parse(fileUrl))
                        val controller = MediaController(ctx)
                        controller.setAnchorView(this)
                        setMediaController(controller)
                        setOnPreparedListener {
                            loading = false
                            start()
                        }
                        setOnErrorListener { _, _, _ ->
                            loading = false
                            error = true
                            true
                        }
                    }
                },
                update = { view ->
                    val currentKey = view.tag as? Int
                    if (currentKey != retryKey) {
                        // retryKey 变化 → 重置 VideoView
                        view.setTag(retryKey)
                        view.stopPlayback()
                        view.setVideoURI(Uri.parse(fileUrl))
                    }
                },
                onRelease = { view ->
                    // Wave 5 技术优雅度 Review T9：只调 stopPlayback()。suspend() 是给
                    // Activity.onPause 用的（暂停播放但保留 surface），stopPlayback 已经释放
                    // MediaPlayer 资源；再调 suspend 对 stopped VideoView 在部分 ROM 上可能
                    // 抛 IllegalStateException（官方无承诺该组合行为）。
                    view.stopPlayback()
                },
            )
        }
        if (loading && !error) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                CircularProgressIndicator(color = TTColors.FullscreenForeground)
                Spacer(Modifier.height(TTSpacing.sm))
                Text(
                    text = stringResource(R.string.chat_file_preview_loading_video),
                    style = TTFonts.caption,
                    color = TTColors.FullscreenForeground,
                )
            }
        }
        if (error) {
            UnsupportedPreviewBody(
                title = stringResource(R.string.chat_file_preview_video_failed),
                description = stringResource(R.string.chat_file_preview_video_failed_desc),
                actionUrl = fileUrl,
                onRetry = { retryKey += 1 },
            )
        }
    }
}

@Composable
private fun LoadingPreviewBody(message: String) {
    Column(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        CircularProgressIndicator()
        Spacer(Modifier.height(TTSpacing.sm))
        Text(
            text = message,
            style = TTFonts.caption,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
        )
    }
}

@Composable
private fun UnsupportedPreviewBody(
    title: String,
    description: String,
    actionUrl: String,
    onRetry: (() -> Unit)? = null,
) {
    val context = LocalContext.current
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(TTSpacing.lg),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(
            Icons.Default.ErrorOutline,
            contentDescription = null,
            modifier = Modifier.size(40.dp),
            tint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
        )
        Spacer(Modifier.height(TTSpacing.md))
        Text(
            text = title,
            style = ConversationTypography.bodySemibold.copy(fontWeight = FontWeight.SemiBold),
            color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
        )
        Spacer(Modifier.height(TTSpacing.xs))
        Text(
            text = description,
            style = TTFonts.caption,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
        )
        Spacer(Modifier.height(TTSpacing.lg))
        Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
            if (onRetry != null) {
                // 重试按钮放主 CTA 位置（左），分享降为 secondary（右）—— 失败场景里重试是优先选择
                Button(onClick = onRetry) {
                    Text(stringResource(R.string.common_retry))
                }
                TextButton(onClick = { shareFileLink(context, actionUrl) }) {
                    Text(stringResource(R.string.chat_file_preview_share_link))
                }
            } else {
                Button(onClick = { shareFileLink(context, actionUrl) }) {
                    Text(stringResource(R.string.chat_file_preview_share_link))
                }
            }
        }
    }
}

@Composable
private fun PreviewErrorText(message: String) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(TTSpacing.xs),
        modifier = Modifier
            .fillMaxWidth()
            .background(
                color = ttColor(TTColors.SurfaceVariant, TTColors.Dark.SurfaceVariant),
                shape = TTRadius.Shapes.md,
            )
            .padding(TTSpacing.md),
    ) {
        Icon(
            Icons.Default.ErrorOutline,
            contentDescription = null,
            tint = ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical),
        )
        Text(
            text = message,
            style = TTFonts.caption,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
        )
    }
}

private data class PdfPreviewState(
    val file: File,
    val pageCount: Int,
)

private fun renderPdfPage(file: File, pageIndex: Int): Bitmap {
    return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { pfd ->
        PdfRenderer(pfd).use { renderer ->
            renderer.openPage(pageIndex).use { page ->
                val maxWidth = 1080
                // Wave 5 技术优雅度 Review FIX-6：4M 像素 → 16MB ARGB_8888 Bitmap；
                // 原 8M（32MB）在默认 heap 128-256MB 的设备上快速翻页会 OOM。
                // 1080×3700 够 A4 300DPI 移动端可读。
                val maxPixels = 4_000_000.0
                val widthScale = maxWidth.toDouble() / page.width.coerceAtLeast(1).toDouble()
                val pixelScale = sqrt(maxPixels / (page.width.toDouble() * page.height.toDouble()).coerceAtLeast(1.0))
                val scale = minOf(1.0, widthScale, pixelScale).toFloat()
                val targetWidth = (page.width * scale).toInt().coerceAtLeast(1)
                val targetHeight = (page.height * scale).toInt().coerceAtLeast(1)
                Bitmap.createBitmap(targetWidth, targetHeight, Bitmap.Config.ARGB_8888).also { bitmap ->
                    bitmap.eraseColor(Color.WHITE)
                    page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                }
            }
        }
    }
}

private fun officeViewerUrls(fileUrl: String): List<String> {
    val uri = Uri.parse(fileUrl)
    if (uri.scheme != "http" && uri.scheme != "https") return emptyList()
    val encoded = URLEncoder.encode(fileUrl, Charsets.UTF_8.name())
    return listOf(
        "https://view.officeapps.live.com/op/embed.aspx?src=$encoded",
        "https://docs.google.com/gview?embedded=1&url=$encoded",
    )
}

/**
 * 计算与 `cacheRemoteFile` 完全一致的目标缓存文件路径。
 *
 * Wave 5 review 补丁：PDF retry 路径需要先删旧缓存再触发重拉，调用方复用此函数就能保证
 * key 一致（SHA-256(fileUrl) + 扩展名推断）。**不要在这里改变 key 规则**——一旦改了这里
 * 和 cacheRemoteFile 就不再对齐，会出现"retry 删了不该删的缓存"或"删了但没命中真正的坏文件"。
 */
private fun cacheFileFor(
    context: Context,
    fileUrl: String,
    filename: String?,
    fallbackExt: String,
): File {
    val ext = filename
        ?.substringAfterLast('.', "")
        ?.takeIf { it.isNotBlank() && it.length <= 8 }
        ?: fallbackExt
    return File(context.cacheDir, "chat-preview/${sha256(fileUrl)}.$ext")
}

private suspend fun cacheRemoteFile(
    context: Context,
    fileUrl: String,
    filename: String?,
    fallbackExt: String,
): File {
    val file = cacheFileFor(context, fileUrl, filename, fallbackExt)
    if (file.exists() && file.length() > 0L) return file

    file.parentFile?.mkdirs()
    val tmp = File(file.parentFile, "${file.name}.tmp")
    // Wave 5 技术优雅度 Review D2 / 用户视角 B5 部分修复：
    // - 拿 HttpURLConnection 而非抽象 URLConnection，拿到 responseCode
    //   （OSS 签名过期常返回 403 + XML 错误 body；ContentType 也会是 application/xml 而非 pdf）
    // - 拒绝非 2xx 响应 → 上层 error 态能分辨"真坏文件" vs "临时网络错"
    // - 拒绝明显错误的 Content-Type（text/html / application/xml 基本都是错误页）
    // 注：完整的 OkHttp 迁移 + 进度条 + cancellation 轮询留给 Wave 6 D2/D1 一起做。
    val connection = (URL(fileUrl).openConnection() as HttpURLConnection).apply {
        connectTimeout = 15_000
        readTimeout = 30_000
        instanceFollowRedirects = true
        useCaches = false
    }
    val recorder = diagnosticRecorder(context)
    val requestId = DiagnosticRecorder.newRequestId()
    val started = System.nanoTime()
    var status: Int? = null
    try {
        val responseStatus = connection.responseCode
        status = responseStatus
        if (responseStatus !in 200..299) {
            throw IOException("HTTP $responseStatus while downloading preview")
        }
        val contentType = connection.contentType.orEmpty().lowercase()
        if (contentType.startsWith("text/html") || contentType.startsWith("application/xml")) {
            throw IOException("Unexpected content type $contentType (likely signed URL expired or error page)")
        }
        connection.inputStream.use { input ->
            tmp.outputStream().use { output -> input.copyTo(output) }
        }
        recorder.recordHttp(
            requestId = requestId,
            method = "GET",
            url = fileUrl,
            statusCode = status,
            durationMs = (System.nanoTime() - started).coerceAtLeast(0) / 1_000_000,
            requestBytes = null,
            responseBytes = tmp.length(),
            retry = false,
            error = null,
        )
    } catch (throwable: Throwable) {
        recorder.recordHttp(
            requestId = requestId,
            method = "GET",
            url = fileUrl,
            statusCode = status,
            durationMs = (System.nanoTime() - started).coerceAtLeast(0) / 1_000_000,
            requestBytes = null,
            responseBytes = null,
            retry = false,
            error = throwable,
        )
        throw throwable
    } finally {
        connection.disconnect()
    }
    if (file.exists()) file.delete()
    tmp.renameTo(file)
    return file
}

private fun shareFileLink(context: Context, url: String) {
    val intent = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, url)
    }
    context.startActivity(Intent.createChooser(intent, context.getString(R.string.chat_share_file)))
}

private fun sha256(value: String): String {
    val bytes = MessageDigest.getInstance("SHA-256").digest(value.toByteArray())
    return bytes.joinToString("") { "%02x".format(it) }
}

private fun formatDuration(ms: Int): String {
    val totalSeconds = (ms / 1000).coerceAtLeast(0)
    val minutes = totalSeconds / 60
    val seconds = totalSeconds % 60
    // Wave 5 技术优雅度 Review T6：强制 Locale.US，否则在阿拉伯语/泰语 locale 下 "%d" 会渲染
    // 为本地数字字符（٠:٠٣ / ๐:๐๓），音视频时间轴按惯例使用 ASCII 数字。
    return String.format(Locale.US, "%d:%02d", minutes, seconds)
}
