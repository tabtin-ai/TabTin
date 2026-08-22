package com.tabtin.mobile.diagnostics

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import com.tabtin.mobile.BuildConfig
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.android.EntryPointAccessors
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import javax.inject.Inject
import javax.inject.Singleton

/**
 * 移动端自有的结构化诊断账本。
 *
 * 这里只接收已经脱敏的元数据：不提供 body/header/query 参数，避免调用方误把业务正文、
 * Token、签名 URL 或聊天内容写进诊断包。每类事件独立轮转，导出不依赖登录或网络。
 */
@Singleton
public class DiagnosticRecorder @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    private val store = DiagnosticFileStore(File(context.filesDir, DIAGNOSTICS_DIRECTORY))

    public fun recordAppEvent(name: String, result: String? = null, error: Throwable? = null) {
        store.append(
            Stream.APP,
            diagnosticJson(
                "category" to "app",
                "name" to safeToken(name),
                "result" to result?.let(::safeToken),
                "error_class" to error?.javaClass?.simpleName?.let(::safeToken),
            ),
        )
    }

    public fun recordHttp(
        requestId: String,
        method: String,
        url: String,
        statusCode: Int?,
        durationMs: Long,
        requestBytes: Long?,
        responseBytes: Long?,
        retry: Boolean,
        error: Throwable?,
    ) {
        val target = DiagnosticTarget.from(url)
        store.append(
            Stream.HTTP,
            diagnosticJson(
                "category" to "http",
                "request_id" to safeToken(requestId),
                "method" to safeToken(method.uppercase()),
                "host_class" to target.hostClass,
                "path" to target.pathTemplate,
                "status_code" to statusCode,
                "duration_ms" to durationMs.coerceAtLeast(0),
                "request_bytes" to requestBytes?.takeIf { it >= 0 },
                "response_bytes" to responseBytes?.takeIf { it >= 0 },
                "retry" to retry,
                "result" to when {
                    error != null -> "failed"
                    statusCode == null -> "unknown"
                    statusCode in 100..399 -> "succeeded"
                    else -> "http_error"
                },
                "error_class" to error?.javaClass?.simpleName?.let(::safeToken),
                "network_type" to currentNetworkType(context),
            ),
        )
    }

    public fun recordWebSocket(
        channel: String,
        phase: String,
        messageType: String? = null,
        payloadBytes: Long? = null,
        result: String? = null,
        closeCode: Int? = null,
        attempt: Int? = null,
        error: Throwable? = null,
    ) {
        store.append(
            Stream.WS,
            diagnosticJson(
                "category" to "websocket",
                "channel" to safeToken(channel),
                "phase" to safeToken(phase),
                "message_type" to messageType?.let(::safeToken),
                "payload_bytes" to payloadBytes?.takeIf { it >= 0 },
                "result" to result?.let(::safeToken),
                "close_code" to closeCode,
                "attempt" to attempt,
                "error_class" to error?.javaClass?.simpleName?.let(::safeToken),
                "network_type" to currentNetworkType(context),
            ),
        )
    }

    public suspend fun exportBundle(): File = withContext(Dispatchers.IO) {
        recordAppEvent("diagnostics_export_started")
        val exportDirectory = File(context.cacheDir, EXPORT_DIRECTORY).apply { mkdirs() }
        cleanupOldExports(exportDirectory)
        val timestamp = FILE_TIMESTAMP_FORMATTER.format(Instant.now())
        val destination = File(exportDirectory, "tabtin-android-diagnostics-$timestamp.zip")
        val meta = JSONObject(
            linkedMapOf(
                "schema_version" to 1,
                "generated_at" to Instant.now().toString(),
                "platform" to "android",
                "app_version" to BuildConfig.VERSION_NAME,
                "app_build" to BuildConfig.VERSION_CODE,
                "build_type" to BuildConfig.BUILD_TYPE,
                "os_version" to Build.VERSION.RELEASE,
                "api_level" to Build.VERSION.SDK_INT,
                "device_model" to "${Build.MANUFACTURER} ${Build.MODEL}".trim(),
                "network_type" to currentNetworkType(context),
            ),
        ).toString(2)

        ZipOutputStream(FileOutputStream(destination)).use { zip ->
            zip.putText("README.txt", README)
            zip.putText("meta.json", meta)
            val snapshots = store.snapshotFiles()
            Stream.entries.forEach { stream ->
                if (snapshots.none { it.name == stream.fileName }) zip.putText(stream.fileName, "")
            }
            snapshots.forEach { snapshot ->
                zip.putNextEntry(ZipEntry(snapshot.name))
                snapshot.inputStream().use { it.copyTo(zip) }
                zip.closeEntry()
            }
        }
        recordAppEvent("diagnostics_export_succeeded")
        destination
    }

    public companion object {
        private const val DIAGNOSTICS_DIRECTORY = "diagnostics"
        private const val EXPORT_DIRECTORY = "diagnostic-exports"
        private const val EXPORT_RETENTION_MS = 24 * 60 * 60 * 1000L
        private val FILE_TIMESTAMP_FORMATTER: DateTimeFormatter =
            DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss").withZone(ZoneOffset.UTC)
        private const val README = """TabTin Android diagnostic bundle

This bundle contains bounded, structured application, HTTP and WebSocket metadata.
It intentionally excludes request/response bodies, header values, URL queries, tokens,
prompts, chat messages, document contents and signed object-storage URLs.

Files may include rotated generations such as http-events.1.jsonl.
Third-party realtime channels (Centrifugo and push providers) contain semantic lifecycle events,
not raw encrypted frames or message bodies.
Embedded WebView subresource traffic is outside the native network ledger.
"""

        public fun newRequestId(): String = UUID.randomUUID().toString()
    }

    private fun cleanupOldExports(directory: File) {
        val cutoff = System.currentTimeMillis() - EXPORT_RETENTION_MS
        directory.listFiles()?.forEach { file ->
            if (file.lastModified() < cutoff) file.delete()
        }
    }
}

@EntryPoint
@InstallIn(SingletonComponent::class)
internal interface DiagnosticRecorderEntryPoint {
    fun diagnosticRecorder(): DiagnosticRecorder
}

internal fun diagnosticRecorder(context: Context): DiagnosticRecorder =
    EntryPointAccessors.fromApplication(
        context.applicationContext,
        DiagnosticRecorderEntryPoint::class.java,
    ).diagnosticRecorder()

internal class DiagnosticFileStore(
    private val directory: File,
    private val maxFileBytes: Long = 1024 * 1024,
    private val retainedGenerations: Int = 2,
) {
    private val lock = Any()

    init {
        require(maxFileBytes > 0)
        require(retainedGenerations >= 0)
        directory.mkdirs()
    }

    fun append(stream: Stream, line: String) {
        val encoded = (line + "\n").toByteArray(Charsets.UTF_8)
        runCatching {
            synchronized(lock) {
                directory.mkdirs()
                val active = File(directory, stream.fileName)
                if (active.exists() && active.length() + encoded.size > maxFileBytes) {
                    rotate(stream)
                }
                active.appendBytes(encoded)
            }
        }
    }

    fun snapshotFiles(): List<File> = synchronized(lock) {
        Stream.entries.flatMap { stream ->
            buildList {
                val active = File(directory, stream.fileName)
                if (active.isFile) add(active)
                for (generation in 1..retainedGenerations) {
                    val rotated = File(directory, stream.rotatedFileName(generation))
                    if (rotated.isFile) add(rotated)
                }
            }
        }
    }

    private fun rotate(stream: Stream) {
        if (retainedGenerations == 0) {
            File(directory, stream.fileName).delete()
            return
        }
        File(directory, stream.rotatedFileName(retainedGenerations)).delete()
        for (generation in retainedGenerations - 1 downTo 1) {
            val source = File(directory, stream.rotatedFileName(generation))
            if (source.exists()) source.renameTo(File(directory, stream.rotatedFileName(generation + 1)))
        }
        val active = File(directory, stream.fileName)
        if (active.exists()) active.renameTo(File(directory, stream.rotatedFileName(1)))
    }
}

internal enum class Stream(public val fileName: String) {
    APP("app-events.jsonl"),
    HTTP("http-events.jsonl"),
    WS("ws-events.jsonl"),
    ;

    public fun rotatedFileName(generation: Int): String =
        fileName.removeSuffix(".jsonl") + ".$generation.jsonl"
}

internal data class DiagnosticTarget(
    val hostClass: String,
    val pathTemplate: String,
) {
    companion object {
        private val UUID_SEGMENT = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}$")
        private val NUMERIC_SEGMENT = Regex("^[0-9]{2,}$")
        private val TOKEN_LIKE_SEGMENT = Regex("^[A-Za-z0-9_-]{24,}$")

        fun from(rawUrl: String): DiagnosticTarget {
            val uri = runCatching { java.net.URI(rawUrl) }.getOrNull()
            val host = uri?.host.orEmpty().lowercase()
            val path = uri?.rawPath.orEmpty().ifBlank { "/" }
            val hostClass = classifyHost(host)
            val templatedPath = path.split('/').joinToString("/") { segment ->
                when {
                    segment.isEmpty() -> ""
                    UUID_SEGMENT.matches(segment) || NUMERIC_SEGMENT.matches(segment) ||
                        TOKEN_LIKE_SEGMENT.matches(segment) -> ":id"
                    else -> segment.take(80)
                }
            }.take(512)
            val safePath = when (hostClass) {
                "object-storage" -> "/:object"
                "tencent-cloud" -> "/:sdk"
                "external" -> "/external"
                else -> templatedPath
            }
            return DiagnosticTarget(hostClass, safePath)
        }

        private fun classifyHost(host: String): String = when {
            host.isBlank() -> "unknown"
            host == "api-test.example.com" || host == "api.example.com" -> "tabtin-api"
            host.endsWith(".example.com") && host.contains("centrifugo") -> "tabtin-realtime"
            host.endsWith(".example.com") -> "tabtin-service"
            host.contains("myqcloud.com") || host.contains("tencent") -> "tencent-cloud"
            host.contains("aliyuncs.com") || host.contains("oss-") -> "object-storage"
            host == "localhost" || host.matches(Regex("^[0-9.]+$")) -> "local-development"
            else -> "external"
        }
    }
}

private fun diagnosticJson(vararg values: Pair<String, Any?>): String {
    val json = JSONObject()
    json.put("timestamp", Instant.now().toString())
    values.forEach { (key, value) -> if (value != null) json.put(key, value) }
    return json.toString()
}

private fun safeToken(value: String): String = value
    .replace(Regex("[^A-Za-z0-9_.:-]"), "_")
    .take(96)

private fun currentNetworkType(context: Context): String {
    val manager = context.getSystemService(ConnectivityManager::class.java) ?: return "unknown"
    val network = manager.activeNetwork ?: return "offline"
    val capabilities = manager.getNetworkCapabilities(network) ?: return "offline"
    return when {
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "vpn"
        else -> "other"
    }
}

private fun ZipOutputStream.putText(name: String, text: String) {
    putNextEntry(ZipEntry(name))
    write(text.toByteArray(Charsets.UTF_8))
    closeEntry()
}
