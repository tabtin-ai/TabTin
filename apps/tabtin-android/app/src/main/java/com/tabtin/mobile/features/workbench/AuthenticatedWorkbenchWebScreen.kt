package com.tabtin.mobile.features.workbench

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.graphics.Color
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebSettings
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.ValueCallback
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.tabtin.mobile.BuildConfig
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.device.MobileFormFactor
import com.tabtin.mobile.ui.device.stableMobileFormFactor
import com.tabtin.mobile.ui.theme.LocalTTDarkTheme
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.web.WebViewRenderProcessGuard
import com.tabtin.mobile.ui.web.releaseSafely
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.URI
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Web → Native Focus Bridge 载荷（与 `docs/agent/8971-mobile-tabdata-view-focus-protocol.md` 对齐）。 */
internal data class NativeFocusReport(
    val appType: String?,
    val resourceId: String,
    val viewId: String?,
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AuthenticatedWorkbenchWebScreen(
    target: WorkbenchWebTarget,
    organizationId: String,
    spaceId: String?,
    backHandlingEnabled: Boolean = true,
    webBaseUrl: String,
    authCoordinator: EmbeddedWebAuthCoordinator,
    onBack: () -> Unit,
    onNativeFocusReport: ((NativeFocusReport) -> Unit)? = null,
) {
    val canonicalUrl = remember(target, organizationId, spaceId, webBaseUrl) {
        buildWorkbenchUrl(webBaseUrl, organizationId, spaceId, target)
    }
    val isDarkTheme = LocalTTDarkTheme.current
    val targetUrl = remember(canonicalUrl, isDarkTheme) {
        canonicalUrl?.let { buildEmbeddedWorkbenchUrl(it, isDarkTheme) }
    }
    val origin = remember(targetUrl) { targetUrl?.let(::canonicalWorkbenchOrigin) }
    var isLoading by remember(targetUrl) { mutableStateOf(true) }
    var progress by remember(targetUrl) { mutableIntStateOf(0) }
    var loadError by remember(targetUrl) { mutableStateOf<String?>(null) }
    var authSnapshot by remember(targetUrl) { mutableStateOf<WorkbenchWebAuthSnapshot?>(null) }
    var authLoadError by remember(targetUrl) { mutableStateOf<String?>(null) }
    var showMenu by remember { mutableStateOf(false) }
    val renderGoneMessage = stringResource(R.string.error_webview_render_gone)
    val context = LocalContext.current
    val configuration = LocalConfiguration.current
    val mobileFormFactor = remember(context, configuration) {
        context.stableMobileFormFactor()
    }
    val clipboard = LocalClipboard.current
    val coroutineScope = rememberCoroutineScope()
    val showWebLoadingCover = shouldShowWorkbenchWebLoadingCover(
        hasTarget = targetUrl != null && origin != null,
        hasAuthSnapshot = authSnapshot != null,
        isLoading = isLoading,
        hasError = authLoadError != null || loadError != null,
    )

    LaunchedEffect(targetUrl) {
        if (targetUrl == null) return@LaunchedEffect
        when (val result = withContext(Dispatchers.IO) { authCoordinator.resolve(forceRefresh = false) }) {
            is EmbeddedWebCredentialResult.Ready -> {
                authSnapshot = result.snapshot
                authLoadError = null
            }
            EmbeddedWebCredentialResult.Unauthenticated -> authSnapshot = null
            EmbeddedWebCredentialResult.TemporarilyUnavailable -> {
                authSnapshot = null
                authLoadError = "暂时无法验证登录状态，请检查网络后重试。"
                isLoading = false
            }
        }
    }

    BackHandler(enabled = backHandlingEnabled, onBack = onBack)

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
    ) {
        TopAppBar(
            navigationIcon = {
                IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = null)
                }
            },
            title = {
                Text(
                    text = target.title,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            },
            actions = {
                if (isLoading) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        strokeWidth = 2.dp,
                    )
                }
                Box {
                    IconButton(
                        enabled = targetUrl != null,
                        onClick = { showMenu = true },
                    ) {
                        Icon(Icons.Default.MoreVert, contentDescription = null)
                    }
                    DropdownMenu(expanded = showMenu, onDismissRequest = { showMenu = false }) {
                        DropdownMenuItem(
                            text = { Text("复制链接") },
                            onClick = {
                                showMenu = false
                                val url = canonicalUrl ?: return@DropdownMenuItem
                                coroutineScope.launch {
                                    clipboard.setClipEntry(
                                        ClipEntry(ClipData.newPlainText("url", url)),
                                    )
                                }
                            },
                        )
                        DropdownMenuItem(
                            text = { Text("在浏览器打开") },
                            onClick = {
                                showMenu = false
                                val url = canonicalUrl ?: return@DropdownMenuItem
                                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                            },
                        )
                    }
                }
            },
        )
        if (isLoading && progress in 1..99) {
            LinearProgressIndicator(
                progress = { progress / 100f },
                modifier = Modifier.fillMaxWidth(),
            )
        }

        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(MaterialTheme.colorScheme.background),
        ) {
            when {
                targetUrl == null || origin == null -> UnavailableState(target)
                authLoadError != null || loadError != null -> WebErrorState(
                    message = authLoadError ?: loadError.orEmpty(),
                    onRetry = {
                        loadError = null
                        authLoadError = null
                        isLoading = true
                        progress = 0
                        coroutineScope.launch {
                            when (val result = withContext(Dispatchers.IO) {
                                authCoordinator.resolve(forceRefresh = authSnapshot == null)
                            }) {
                                is EmbeddedWebCredentialResult.Ready -> authSnapshot = result.snapshot
                                EmbeddedWebCredentialResult.Unauthenticated -> authSnapshot = null
                                EmbeddedWebCredentialResult.TemporarilyUnavailable -> {
                                    authLoadError = "暂时无法验证登录状态，请检查网络后重试。"
                                    isLoading = false
                                }
                            }
                        }
                    },
                )
                authSnapshot == null -> WorkbenchLoadingCover(
                    message = stringResource(R.string.workbench_web_authenticating),
                )
                else -> AuthenticatedWorkbenchWebView(
                    url = targetUrl,
                    expectedOrigin = origin,
                    authSnapshot = checkNotNull(authSnapshot),
                    authCoordinator = authCoordinator,
                    mobileFormFactor = mobileFormFactor,
                    onNativeFocusReport = onNativeFocusReport,
                    onLoadingChanged = { isLoading = it },
                    onProgressChanged = { progress = it },
                    onError = { loadError = it },
                    // 渲染进程终止后走同一个 WebErrorState：重试会让整个 else 分支重新进组合树，
                    // 从而 factory 重跑、拿到一个全新的 WebView 实例（旧实例已销毁，不可复用）。
                    onRenderGone = {
                        isLoading = false
                        loadError = renderGoneMessage
                    },
                    modifier = Modifier.fillMaxSize(),
                )
            }
            if (showWebLoadingCover) {
                WorkbenchLoadingCover(
                    message = stringResource(R.string.workbench_web_loading),
                )
            }
        }
    }
}

@Composable
private fun WorkbenchLoadingCover(message: String) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            CircularProgressIndicator()
            Text(
                text = message,
                style = TTFonts.body,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

internal fun shouldShowWorkbenchWebLoadingCover(
    hasTarget: Boolean,
    hasAuthSnapshot: Boolean,
    isLoading: Boolean,
    hasError: Boolean,
): Boolean = hasTarget && hasAuthSnapshot && isLoading && !hasError

@Composable
private fun AuthenticatedWorkbenchWebView(
    url: String,
    expectedOrigin: String,
    authSnapshot: WorkbenchWebAuthSnapshot,
    authCoordinator: EmbeddedWebAuthCoordinator,
    mobileFormFactor: MobileFormFactor,
    onNativeFocusReport: ((NativeFocusReport) -> Unit)?,
    onLoadingChanged: (Boolean) -> Unit,
    onProgressChanged: (Int) -> Unit,
    onError: (String) -> Unit,
    onRenderGone: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val requestedUrl = remember { mutableStateOf<String?>(null) }
    val appliedInputAuthSnapshot = remember { mutableStateOf<WorkbenchWebAuthSnapshot?>(null) }
    val appliedMobileFormFactor = remember { mutableStateOf<MobileFormFactor?>(null) }
    val currentAuthSnapshot = remember { mutableStateOf<WorkbenchWebAuthSnapshot?>(null) }
    val documentStartScriptHandler = remember { mutableStateOf<ScriptHandler?>(null) }
    val focusDocumentStartScriptHandler = remember { mutableStateOf<ScriptHandler?>(null) }
    val hostDocumentStartScriptHandler = remember { mutableStateOf<ScriptHandler?>(null) }
    val latestFocusReport = rememberUpdatedState(onNativeFocusReport)
    val latestMobileFormFactor = rememberUpdatedState(mobileFormFactor)
    var fileChooserCallback by remember { mutableStateOf<ValueCallback<Array<Uri>>?>(null) }
    val fileChooserLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val callback = fileChooserCallback
        fileChooserCallback = null
        callback?.onReceiveValue(
            WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data),
        )
    }
    val cancelPendingFileChooser = {
        fileChooserCallback?.onReceiveValue(null)
        fileChooserCallback = null
    }

    DisposableEffect(Unit) {
        onDispose(cancelPendingFileChooser)
    }

    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            WebView(ctx).apply {
                WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.databaseEnabled = true
                settings.loadWithOverviewMode = false
                settings.useWideViewPort = false
                settings.setSupportZoom(true)
                settings.builtInZoomControls = true
                settings.displayZoomControls = false
                settings.javaScriptCanOpenWindowsAutomatically = true
                addJavascriptInterface(
                    AndroidEmbeddedAuthBridge(authCoordinator) { refreshedSnapshot ->
                        val injected = CountDownLatch(1)
                        val posted = post {
                            currentAuthSnapshot.value = refreshedSnapshot
                            documentStartScriptHandler.value = replaceDocumentStartAuthScript(
                                previous = documentStartScriptHandler.value,
                                snapshot = refreshedSnapshot,
                                expectedOrigin = expectedOrigin,
                            )
                            focusDocumentStartScriptHandler.value = replaceDocumentStartFocusScript(
                                previous = focusDocumentStartScriptHandler.value,
                                expectedOrigin = expectedOrigin,
                            )
                            hostDocumentStartScriptHandler.value = replaceDocumentStartHostScript(
                                previous = hostDocumentStartScriptHandler.value,
                                expectedOrigin = expectedOrigin,
                                mobileFormFactor = latestMobileFormFactor.value,
                            )
                            evaluateJavascript(
                                refreshedSnapshot.injectionScript(expectedOrigin) +
                                    "\n" + nativeFocusInjectionScript(expectedOrigin) +
                                    "\n" + mobileHostInjectionScript(
                                        expectedOrigin,
                                        latestMobileFormFactor.value,
                                    ),
                            ) {
                                injected.countDown()
                            }
                        }
                        posted && injected.await(5, TimeUnit.SECONDS)
                    },
                    AndroidEmbeddedAuthBridge.interfaceName,
                )
                addJavascriptInterface(
                    AndroidNativeFocusBridge { json ->
                        post {
                            parseNativeFocusReport(json)?.let { report ->
                                latestFocusReport.value?.invoke(report)
                            }
                        }
                    },
                    AndroidNativeFocusBridge.interfaceName,
                )
                settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
                settings.userAgentString = settings.userAgentString
                    ?.replace("; wv", "")
                    ?.replace(" Version/4.0", "")
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    settings.isAlgorithmicDarkeningAllowed = false
                } else {
                    @Suppress("DEPRECATION")
                    settings.forceDark = WebSettings.FORCE_DARK_OFF
                }
                setBackgroundColor(Color.TRANSPARENT)
                CookieManager.getInstance().setAcceptCookie(true)
                CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
                webChromeClient = object : WebChromeClient() {
                    override fun onShowFileChooser(
                        webView: WebView?,
                        filePathCallback: ValueCallback<Array<Uri>>?,
                        fileChooserParams: FileChooserParams?,
                    ): Boolean {
                        val callback = filePathCallback ?: return false
                        cancelPendingFileChooser()
                        fileChooserCallback = callback

                        val intent = try {
                            fileChooserParams?.createIntent()
                        } catch (error: Exception) {
                            Log.w("WorkbenchWebView", "file chooser intent creation failed", error)
                            null
                        }
                        if (intent == null) {
                            cancelPendingFileChooser()
                            return false
                        }

                        return try {
                            fileChooserLauncher.launch(intent)
                            true
                        } catch (error: Exception) {
                            cancelPendingFileChooser()
                            Log.w("WorkbenchWebView", "file chooser launch failed", error)
                            false
                        }
                    }

                    override fun onProgressChanged(view: WebView?, newProgress: Int) {
                        onProgressChanged(newProgress)
                    }

                    override fun onConsoleMessage(consoleMessage: ConsoleMessage?): Boolean {
                        val message = consoleMessage ?: return false
                        Log.d(
                            "WorkbenchWebView",
                            "${message.messageLevel()} ${message.sourceId()}:${message.lineNumber()} ${message.message()}",
                        )
                        return true
                    }
                }
                webViewClient = object : WebViewClient() {
                    override fun onPageStarted(view: WebView?, currentUrl: String?, favicon: Bitmap?) {
                        if (
                            documentStartScriptHandler.value == null &&
                            canonicalWorkbenchOrigin(currentUrl.orEmpty()) == expectedOrigin
                        ) {
                            val latestSnapshot = currentAuthSnapshot.value ?: authSnapshot
                            view?.evaluateJavascript(
                                latestSnapshot.injectionScript(expectedOrigin) +
                                    "\n" + nativeFocusInjectionScript(expectedOrigin) +
                                    "\n" + mobileHostInjectionScript(
                                        expectedOrigin,
                                        latestMobileFormFactor.value,
                                    ),
                                null,
                            )
                        } else if (
                            (focusDocumentStartScriptHandler.value == null ||
                                hostDocumentStartScriptHandler.value == null) &&
                            canonicalWorkbenchOrigin(currentUrl.orEmpty()) == expectedOrigin
                        ) {
                            view?.evaluateJavascript(
                                nativeFocusInjectionScript(expectedOrigin) +
                                    "\n" + mobileHostInjectionScript(
                                        expectedOrigin,
                                        latestMobileFormFactor.value,
                                    ),
                                null,
                            )
                        }
                        onLoadingChanged(true)
                    }

                    override fun onPageFinished(view: WebView?, currentUrl: String?) {
                        val webView = view ?: return
                        val loadedUrl = currentUrl ?: return
                        if (canonicalWorkbenchOrigin(loadedUrl) == expectedOrigin) {
                            val latestSnapshot = currentAuthSnapshot.value ?: authSnapshot
                            webView.evaluateJavascript(
                                latestSnapshot.injectionScript(expectedOrigin) +
                                    "\n" + nativeFocusInjectionScript(expectedOrigin) +
                                    "\n" + mobileHostInjectionScript(
                                        expectedOrigin,
                                        latestMobileFormFactor.value,
                                    ) +
                                    "\n" + androidViewportHeightFallbackScript(expectedOrigin),
                            ) {
                                webView.logWorkbenchPageState()
                            }
                        }
                        onLoadingChanged(false)
                    }

                    override fun onReceivedError(
                        view: WebView?,
                        request: WebResourceRequest?,
                        error: android.webkit.WebResourceError?,
                    ) {
                        if (request?.isForMainFrame == true) {
                            onLoadingChanged(false)
                            onError(error?.description?.toString().orEmpty())
                        }
                    }

                    override fun shouldOverrideUrlLoading(
                        view: WebView?,
                        request: WebResourceRequest?,
                    ): Boolean {
                        val nextUri = request?.url ?: return false
                        val next = nextUri.toString()
                        if (!shouldOpenWorkbenchUrlExternally(
                                nextUri.scheme,
                                canonicalWorkbenchOrigin(next),
                                expectedOrigin,
                            )
                        ) {
                            return false
                        }
                        try {
                            context.startActivity(Intent(Intent.ACTION_VIEW, nextUri))
                        } catch (error: ActivityNotFoundException) {
                            Log.w(
                                "WorkbenchWebView",
                                "No activity can open external URL scheme=${nextUri.scheme}",
                                error,
                            )
                        }
                        return true
                    }

                    override fun onRenderProcessGone(
                        view: WebView?,
                        detail: RenderProcessGoneDetail?,
                    ): Boolean = WebViewRenderProcessGuard.handle(
                        host = "workbench_web",
                        view = view,
                        detail = detail,
                        // 这台 WebView 上挂了 JS bridge 和 document-start 脚本，destroy 前
                        // 先拆干净（渲染进程虽死，浏览器侧的 AwContents 还在）。
                        beforeDestroy = { webView ->
                            cancelPendingFileChooser()
                            documentStartScriptHandler.value?.remove()
                            documentStartScriptHandler.value = null
                            focusDocumentStartScriptHandler.value?.remove()
                            focusDocumentStartScriptHandler.value = null
                            hostDocumentStartScriptHandler.value?.remove()
                            hostDocumentStartScriptHandler.value = null
                            webView.removeJavascriptInterface(AndroidEmbeddedAuthBridge.interfaceName)
                            webView.removeJavascriptInterface(AndroidNativeFocusBridge.interfaceName)
                        },
                        onGone = { onRenderGone() },
                    )
                }
                requestedUrl.value = url
                appliedInputAuthSnapshot.value = authSnapshot
                appliedMobileFormFactor.value = mobileFormFactor
                currentAuthSnapshot.value = authSnapshot
                documentStartScriptHandler.value = replaceDocumentStartAuthScript(
                    previous = documentStartScriptHandler.value,
                    snapshot = authSnapshot,
                    expectedOrigin = expectedOrigin,
                )
                focusDocumentStartScriptHandler.value = replaceDocumentStartFocusScript(
                    previous = focusDocumentStartScriptHandler.value,
                    expectedOrigin = expectedOrigin,
                )
                hostDocumentStartScriptHandler.value = replaceDocumentStartHostScript(
                    previous = hostDocumentStartScriptHandler.value,
                    expectedOrigin = expectedOrigin,
                    mobileFormFactor = mobileFormFactor,
                )
                loadAuthenticatedUrl(url, expectedOrigin, authSnapshot, mobileFormFactor)
            }
        },
        update = { webView ->
            if (requestedUrl.value != url) {
                requestedUrl.value = url
                appliedInputAuthSnapshot.value = authSnapshot
                appliedMobileFormFactor.value = mobileFormFactor
                currentAuthSnapshot.value = authSnapshot
                documentStartScriptHandler.value = webView.replaceDocumentStartAuthScript(
                    previous = documentStartScriptHandler.value,
                    snapshot = authSnapshot,
                    expectedOrigin = expectedOrigin,
                )
                focusDocumentStartScriptHandler.value = webView.replaceDocumentStartFocusScript(
                    previous = focusDocumentStartScriptHandler.value,
                    expectedOrigin = expectedOrigin,
                )
                hostDocumentStartScriptHandler.value = webView.replaceDocumentStartHostScript(
                    previous = hostDocumentStartScriptHandler.value,
                    expectedOrigin = expectedOrigin,
                    mobileFormFactor = mobileFormFactor,
                )
                onLoadingChanged(true)
                webView.loadAuthenticatedUrl(url, expectedOrigin, authSnapshot, mobileFormFactor)
            } else if (appliedInputAuthSnapshot.value != authSnapshot) {
                appliedInputAuthSnapshot.value = authSnapshot
                appliedMobileFormFactor.value = mobileFormFactor
                currentAuthSnapshot.value = authSnapshot
                documentStartScriptHandler.value = webView.replaceDocumentStartAuthScript(
                    previous = documentStartScriptHandler.value,
                    snapshot = authSnapshot,
                    expectedOrigin = expectedOrigin,
                )
                focusDocumentStartScriptHandler.value = webView.replaceDocumentStartFocusScript(
                    previous = focusDocumentStartScriptHandler.value,
                    expectedOrigin = expectedOrigin,
                )
                hostDocumentStartScriptHandler.value = webView.replaceDocumentStartHostScript(
                    previous = hostDocumentStartScriptHandler.value,
                    expectedOrigin = expectedOrigin,
                    mobileFormFactor = mobileFormFactor,
                )
                webView.evaluateJavascript(
                    authSnapshot.injectionScript(expectedOrigin) +
                        "\n" + nativeFocusInjectionScript(expectedOrigin) +
                        "\n" + mobileHostInjectionScript(expectedOrigin, mobileFormFactor),
                    null,
                )
            } else if (appliedMobileFormFactor.value != mobileFormFactor) {
                appliedMobileFormFactor.value = mobileFormFactor
                hostDocumentStartScriptHandler.value = webView.replaceDocumentStartHostScript(
                    previous = hostDocumentStartScriptHandler.value,
                    expectedOrigin = expectedOrigin,
                    mobileFormFactor = mobileFormFactor,
                )
                webView.evaluateJavascript(
                    mobileHostInjectionScript(expectedOrigin, mobileFormFactor),
                    null,
                )
            }
        },
        // 渲染进程终止的实例已在 onRenderProcessGone 里拆完并 destroy 过，releaseSafely
        // 会直接跳过——再碰一次（remove 脚本 / stopLoading）会抛 IllegalStateException。
        onRelease = { webView ->
            cancelPendingFileChooser()
            webView.releaseSafely {
                documentStartScriptHandler.value?.remove()
                documentStartScriptHandler.value = null
                focusDocumentStartScriptHandler.value?.remove()
                focusDocumentStartScriptHandler.value = null
                hostDocumentStartScriptHandler.value?.remove()
                hostDocumentStartScriptHandler.value = null
                it.removeJavascriptInterface(AndroidEmbeddedAuthBridge.interfaceName)
                it.removeJavascriptInterface(AndroidNativeFocusBridge.interfaceName)
            }
        },
    )
}

private fun WebView.replaceDocumentStartAuthScript(
    previous: ScriptHandler?,
    snapshot: WorkbenchWebAuthSnapshot,
    expectedOrigin: String,
): ScriptHandler? {
    previous?.remove()
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return null
    return WebViewCompat.addDocumentStartJavaScript(
        this,
        snapshot.injectionScript(expectedOrigin),
        setOf(expectedOrigin),
    )
}

private fun WebView.replaceDocumentStartFocusScript(
    previous: ScriptHandler?,
    expectedOrigin: String,
): ScriptHandler? {
    previous?.remove()
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return null
    return WebViewCompat.addDocumentStartJavaScript(
        this,
        nativeFocusInjectionScript(expectedOrigin),
        setOf(expectedOrigin),
    )
}

private fun WebView.replaceDocumentStartHostScript(
    previous: ScriptHandler?,
    expectedOrigin: String,
    mobileFormFactor: MobileFormFactor,
): ScriptHandler? {
    previous?.remove()
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return null
    return WebViewCompat.addDocumentStartJavaScript(
        this,
        mobileHostInjectionScript(expectedOrigin, mobileFormFactor),
        setOf(expectedOrigin),
    )
}

private fun WebView.loadAuthenticatedUrl(
    url: String,
    expectedOrigin: String,
    authSnapshot: WorkbenchWebAuthSnapshot,
    mobileFormFactor: MobileFormFactor,
) {
    val html = """
        <!doctype html>
        <html>
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1" />
          </head>
          <body>
            <script>
              try {
                ${authSnapshot.bootstrapInjectionScript()}
                ${nativeFocusInjectionScript(expectedOrigin)}
                ${mobileHostInjectionScript(expectedOrigin, mobileFormFactor)}
                ${androidViewportHeightFallbackScript(expectedOrigin)}
              } catch (error) {
                console.error('TabTin auth bootstrap failed', error && (error.stack || error.message || String(error)));
              }
              window.location.replace(${JSONObject.quote(url)});
            </script>
          </body>
        </html>
    """.trimIndent()
    loadDataWithBaseURL(expectedOrigin, html, "text/html", "UTF-8", null)
}

private class AndroidEmbeddedAuthBridge(
    private val authCoordinator: EmbeddedWebAuthCoordinator,
    private val publishCredential: (WorkbenchWebAuthSnapshot) -> Boolean,
) {
    companion object {
        const val interfaceName = "TabTinNativeAuth"
    }

    @JavascriptInterface
    fun refresh(): String = runBlocking(Dispatchers.IO) {
        when (val result = authCoordinator.resolve(forceRefresh = true)) {
            is EmbeddedWebCredentialResult.Ready -> if (publishCredential(result.snapshot)) {
                JSONObject().put("status", "succeeded").toString()
            } else {
                JSONObject()
                    .put("status", "temporarily_unavailable")
                    .put("message", "登录凭据暂时无法同步")
                    .toString()
            }
            EmbeddedWebCredentialResult.Unauthenticated -> JSONObject()
                .put("status", "unauthenticated")
                .toString()
            EmbeddedWebCredentialResult.TemporarilyUnavailable -> JSONObject().apply {
                put("status", "temporarily_unavailable")
                put("message", "登录状态暂时无法刷新")
            }.toString()
        }
    }
}

private class AndroidNativeFocusBridge(
    private val onReport: (String) -> Unit,
) {
    companion object {
        const val interfaceName = "TabTinNativeFocus"
    }

    @JavascriptInterface
    fun report(json: String) {
        onReport(json)
    }
}

internal fun parseNativeFocusReport(json: String): NativeFocusReport? {
    return try {
        val obj = JSONObject(json)
        val resourceId = obj.optString("resourceId").trim().takeIf { it.isNotEmpty() }
            ?: return null
        val viewIdRaw = if (obj.has("viewId") && !obj.isNull("viewId")) {
            obj.optString("viewId")
        } else {
            null
        }
        NativeFocusReport(
            appType = obj.optString("appType").trim().takeIf { it.isNotEmpty() },
            resourceId = resourceId,
            viewId = viewIdRaw?.trim()?.takeIf { it.isNotEmpty() },
        )
    } catch (error: Exception) {
        Log.w("WorkbenchWebView", "native focus report parse failed: ${error.message}")
        null
    }
}

private fun nativeFocusInjectionScript(expectedOrigin: String): String {
    val origin = JSONObject.quote(expectedOrigin)
    return """
        (() => {
          if (window.location.origin !== $origin) return;
          window.__TABTIN_NATIVE_FOCUS__ = {
            report: (p) => TabTinNativeFocus.report(typeof p === 'string' ? p : JSON.stringify(p))
          };
        })();
    """.trimIndent()
}

private fun androidViewportHeightFallbackScript(expectedOrigin: String): String {
    val origin = JSONObject.quote(expectedOrigin)
    return """
        (() => {
          if (window.location.origin !== $origin) return;
          const isInstalled = window.__tabtinAndroidViewportHeightFallbackInstalled;
          const apply = () => {
            const visualHeight = window.visualViewport && window.visualViewport.height
              ? window.visualViewport.height
              : 0;
            const height = visualHeight || window.innerHeight || document.documentElement.clientHeight || 0;
            if (!height) return;
            const px = Math.round(height) + 'px';
            const root = document.getElementById('root');
            const targets = [
              document.documentElement,
              document.body,
              root,
              root && root.firstElementChild
            ].filter(Boolean);
            targets.forEach((el) => {
              el.style.setProperty('height', px, 'important');
              el.style.setProperty('min-height', px, 'important');
            });
          };
          window.__tabtinAndroidApplyViewportHeightFallback = apply;
          apply();
          if (isInstalled) return;
          window.__tabtinAndroidViewportHeightFallbackInstalled = true;
          window.addEventListener('resize', apply, { passive: true });
          if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', apply, { passive: true });
          }
          [50, 250, 1000, 3000, 6000].forEach((delay) => window.setTimeout(apply, delay));
        })();
    """.trimIndent()
}

private fun WebView.logWorkbenchPageState() {
    if (!BuildConfig.DEBUG) return
    evaluateJavascript(
        """
        (() => {
          const root = document.getElementById('root') || document.querySelector('#app') || document.body;
          const app = document.getElementById('root')?.firstElementChild || null;
          const style = window.getComputedStyle(document.body);
          const rootRect = root ? root.getBoundingClientRect() : null;
          const appRect = app ? app.getBoundingClientRect() : null;
          return {
            href: location.href,
            title: document.title,
            readyState: document.readyState,
            bodyTextLength: (document.body && document.body.innerText || '').length,
            htmlLength: (document.documentElement && document.documentElement.outerHTML || '').length,
            rootChildren: root ? root.children.length : -1,
            viewport: { width: window.innerWidth, height: window.innerHeight },
            rootHeight: rootRect ? rootRect.height : -1,
            appHeight: appRect ? appRect.height : -1,
            bodyBackground: style.backgroundColor,
            accessToken: !!localStorage.getItem('tabtin_access_token'),
            user: !!localStorage.getItem('tabtin_user')
          };
        })();
        """.trimIndent(),
    ) { state ->
        Log.d("WorkbenchWebView", "pageState=$state")
    }
}

@Composable
private fun UnavailableState(target: WorkbenchWebTarget) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            modifier = Modifier.padding(TTSpacing.lg),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            Text("${target.title} 暂不可用", style = MaterialTheme.typography.titleMedium)
            Text(
                text = "未能生成资源 Web 地址，请稍后重试。",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun WebErrorState(message: String, onRetry: () -> Unit) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            modifier = Modifier.padding(TTSpacing.lg),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            Text("页面加载失败", style = MaterialTheme.typography.titleMedium)
            Text(
                text = message,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(TTSpacing.sm))
            androidx.compose.material3.Button(onClick = onRetry) {
                Text("重试")
            }
        }
    }
}

internal fun buildWorkbenchUrl(
    webBaseUrl: String,
    organizationId: String,
    spaceId: String?,
    target: WorkbenchWebTarget,
): String? {
    if (!target.isSupported) return null
    val base = webBaseUrl.trimEnd('/').takeIf { it.isNotBlank() } ?: return null
    val normalizedOrganizationId = organizationId.trim().takeIf { it.isNotBlank() }
    val normalizedSpaceId = spaceId?.trim()?.takeIf { it.isNotBlank() }
    return buildString {
        append(base)
        when {
            normalizedOrganizationId != null && normalizedSpaceId != null -> {
                append("/organizations/")
                append(encodePathSegment(normalizedOrganizationId))
                append("/spaces/")
                append(encodePathSegment(normalizedSpaceId))
            }
            normalizedSpaceId != null -> {
                append("/spaces/")
                append(encodePathSegment(normalizedSpaceId))
            }
        }
        append('/')
        append(target.pathName)
        append('/')
        append(encodePathSegment(target.resourceId))
    }
}

private fun encodePathSegment(value: String): String =
    URLEncoder.encode(value, StandardCharsets.UTF_8.name()).replace("+", "%20")

internal fun buildEmbeddedWorkbenchUrl(canonicalUrl: String, isDarkTheme: Boolean): String =
    canonicalUrl.let { url ->
        val fragmentIndex = url.indexOf('#')
        val baseUrl = if (fragmentIndex >= 0) url.substring(0, fragmentIndex) else url
        val fragment = if (fragmentIndex >= 0) url.substring(fragmentIndex) else ""
        val separator = if ('?' in baseUrl) "&" else "?"
        val theme = if (isDarkTheme) "dark" else "light"

        "$baseUrl${separator}shell=embedded&client=android&theme=$theme$fragment"
    }

internal fun canonicalWorkbenchOrigin(url: String): String? {
    val uri = runCatching { URI(url) }.getOrNull() ?: return null
    val scheme = uri.scheme?.lowercase() ?: return null
    val host = uri.host?.lowercase() ?: return null
    val serializedHost = if (':' in host && !host.startsWith('[')) "[$host]" else host
    val port = uri.port.takeIf { candidate ->
        candidate >= 0 && !isDefaultOriginPort(scheme, candidate)
    }
    return buildString {
        append(scheme)
        append("://")
        append(serializedHost)
        if (port != null) {
            append(':')
            append(port)
        }
    }
}

private fun isDefaultOriginPort(scheme: String, port: Int): Boolean =
    (scheme == "http" && port == 80) || (scheme == "https" && port == 443)

internal fun shouldOpenWorkbenchUrlExternally(
    scheme: String?,
    origin: String?,
    expectedOrigin: String,
): Boolean = origin != expectedOrigin && !scheme.equals("blob", ignoreCase = true)
