package com.tabtin.mobile.sentry

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.tabtin.mobile.BuildConfig
import com.tabtin.mobile.data.api.resolveEffectiveApiBaseUrl
import com.tabtin.mobile.util.TokenManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

public object DiagnosticRuntime {
    private const val MAX_BUNDLES = 5
    private const val WORK_NAME = "tabtin-diagnostic-upload"
    private lateinit var appContext: Context
    private lateinit var tokenManager: TokenManager
    private var organizationId: String = ""

    public fun initialize(context: Context, tokens: TokenManager) {
        appContext = context.applicationContext
        tokenManager = tokens
        val prefs = appContext.getSharedPreferences("diagnostics-v1", Context.MODE_PRIVATE)
        organizationId = tokens.organizationId.orEmpty()
        if (shouldCapturePreviousSession(prefs.getString("status", null))) {
            capture(
                category = "ABNORMAL_TERMINATION",
                code = "PREVIOUS_SESSION_UNCLEAN_EXIT",
                handledBy = "next_start_recovery",
                organizationOverride = prefs.getString("organization_id", "").orEmpty(),
            )
        }
        writeMarker("running")
        enqueueUpload()
    }

    public fun updateOrganization(value: String?) {
        organizationId = value.orEmpty()
        writeMarker("running")
        if (organizationId.isNotBlank()) {
            queueDir().listFiles { file -> file.name.endsWith(".pending.json") }.orEmpty().forEach { sidecar ->
                runCatching {
                    val metadata = JSONObject(sidecar.readText())
                    if (metadata.optString("organization_id").isBlank()) {
                        metadata.put("organization_id", organizationId)
                        sidecar.writeText(metadata.toString())
                    }
                }
            }
            enqueueUpload()
        }
    }

    public fun markClean() { writeMarker("clean") }

    public fun markRunning() { writeMarker("running") }

    internal fun shouldCapturePreviousSession(status: String?): Boolean = status == "running"

    public fun capture(
        category: String,
        code: String,
        handledBy: String,
        organizationOverride: String = organizationId,
    ): String {
        val bundleId = UUID.randomUUID().toString()
        runCatching {
            val dir = queueDir().apply { mkdirs() }
            val meta = JSONObject().apply {
                put("schema_version", 1)
                put("diagnostic_bundle_id", bundleId)
                put("error_category", category)
                put("error_code", code)
                put("handled_by", handledBy)
                put("platform", "android")
                put("runtime", "android-native")
                put("app_version", BuildConfig.VERSION_NAME)
                put("build_number", BuildConfig.VERSION_CODE.toString())
                put("environment", BuildConfig.OBSERVABILITY_ENVIRONMENT)
                BuildConfig.TABTIN_GIT_SHA.takeIf { it.isNotEmpty() }?.let { put("git_sha", it) }
            }
            ZipOutputStream(File(dir, "$bundleId.zip").outputStream()).use { zip ->
                zip.putNextEntry(ZipEntry("meta.json"))
                zip.write(meta.toString().toByteArray())
                zip.closeEntry()
            }
            JSONObject().apply {
                put("bundle_id", bundleId)
                put("organization_id", organizationOverride)
                put("client_install_id", tokenManager.deviceId)
                put("sentry_event_id", "")
            }.let { File(dir, "$bundleId.pending.json").writeText(it.toString()) }
            prune(dir)
        }
        return bundleId
    }

    public fun linkSentryAndEnqueue(bundleId: String, sentryEventId: String?) {
        runCatching {
            val sidecar = File(queueDir(), "$bundleId.pending.json")
            val json = JSONObject(sidecar.readText())
            json.put("sentry_event_id", sentryEventId.orEmpty())
            sidecar.writeText(json.toString())
        }
        enqueueUpload()
    }

    public fun sentryContext(bundleId: String): Map<String, String> = buildMap {
        put("diagnostic_bundle_id", bundleId)
        if (::tokenManager.isInitialized) put("client_install_id", tokenManager.deviceId)
        organizationId.takeIf { it.isNotBlank() }?.let { put("organization_id", it) }
    }

    private fun enqueueUpload() {
        if (!::appContext.isInitialized) return
        val request = OneTimeWorkRequestBuilder<DiagnosticUploadWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(appContext).enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.KEEP, request)
    }

    private fun queueDir(): File = File(appContext.filesDir, "diagnostics-v1/pending")

    private fun prune(dir: File) {
        val bundles = dir.listFiles { file -> file.extension == "zip" }?.sortedBy { it.lastModified() }.orEmpty()
        bundles.dropLast(MAX_BUNDLES).forEach { zip ->
            zip.delete()
            File(dir, "${zip.nameWithoutExtension}.pending.json").delete()
        }
    }

    private fun writeMarker(status: String) {
        if (!::appContext.isInitialized) return
        appContext.getSharedPreferences("diagnostics-v1", Context.MODE_PRIVATE).edit()
            .putString("status", status)
            .putString("organization_id", organizationId)
            .apply()
    }
}

public class DiagnosticUploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val tokens = TokenManager(applicationContext)
        val token = tokens.accessToken ?: return@withContext Result.retry()
        val dir = File(applicationContext.filesDir, "diagnostics-v1/pending")
        val sidecars = dir.listFiles { file -> file.name.endsWith(".pending.json") }.orEmpty()
        var failed = false
        for (sidecar in sidecars) {
            val result = runCatching { upload(sidecar, tokens, token) }
            if (result.isFailure) failed = true
        }
        if (failed) Result.retry() else Result.success()
    }

    private fun upload(sidecar: File, tokens: TokenManager, token: String) {
        val metadata = JSONObject(sidecar.readText())
        val bundleId = metadata.getString("bundle_id")
        val zip = File(sidecar.parentFile, "$bundleId.zip")
        if (!zip.isFile) {
            sidecar.delete()
            return
        }
        if (metadata.optString("organization_id").isBlank()) return
        val sha = MessageDigest.getInstance("SHA-256").digest(zip.readBytes()).joinToString("") { "%02x".format(it) }
        val client = OkHttpClient()
        val base = resolveEffectiveApiBaseUrl(tokens).trimEnd('/')
        var server = metadata.optJSONObject("server")
        var serverBundleId = metadata.optString("server_bundle_id")
        if (server != null) {
            // Older builds persisted the complete create response, including the
            // short-lived signed upload URL. Keep it in memory for this attempt,
            // but immediately migrate the sidecar to the URL-free format.
            serverBundleId = server.optString("bundle_id", serverBundleId)
            metadata.remove("server")
            if (serverBundleId.isNotBlank()) metadata.put("server_bundle_id", serverBundleId)
            sidecar.writeText(metadata.toString())
        }
        if (metadata.optString("phase", "created") == "created" && server == null) {
            val createBody = JSONObject().apply {
                put("organization_id", metadata.getString("organization_id"))
                put("client_install_id", metadata.getString("client_install_id"))
                put("expected_size", zip.length())
                put("expected_sha256", sha)
                put("content_type", "application/zip")
                put("sentry_event_id", metadata.optString("sentry_event_id"))
            }.toString().toRequestBody("application/json".toMediaType())
            val create = client.newCall(Request.Builder().url("$base/diagnostics/bundles").header("Authorization", "Bearer $token").post(createBody).build()).execute()
            create.use {
                if (!it.isSuccessful) error("create failed ${it.code}")
                server = JSONObject(it.body.string())
                serverBundleId = server!!.getString("bundle_id")
            }
        }
        if (metadata.optString("phase", "created") == "created") {
            val uploadSession = checkNotNull(server) { "missing upload session" }
            val uploadRequest = if (uploadSession.optString("upload_method", "PUT") == "POST") {
                val form = MultipartBody.Builder().setType(MultipartBody.FORM)
                uploadSession.optJSONObject("upload_fields")?.let { fields ->
                    fields.keys().forEach { key -> form.addFormDataPart(key, fields.getString(key)) }
                }
                form.addFormDataPart(
                    "file",
                    zip.name,
                    zip.asRequestBody("application/zip".toMediaType()),
                )
                Request.Builder().url(uploadSession.getString("upload_url")).post(form.build()).build()
            } else {
                Request.Builder().url(uploadSession.getString("upload_url"))
                    .put(zip.asRequestBody("application/zip".toMediaType()))
                    .build()
            }
            client.newCall(uploadRequest).execute().use {
                if (!it.isSuccessful) {
                    error("upload failed ${it.code}")
                }
            }
            metadata.put("server_bundle_id", serverBundleId)
            metadata.put("phase", "uploaded")
            sidecar.writeText(metadata.toString())
        }
        val completeBody = JSONObject().put("sha256", sha).put("size", zip.length()).toString().toRequestBody("application/json".toMediaType())
        check(serverBundleId.isNotBlank()) { "missing server bundle id" }
        client.newCall(Request.Builder().url("$base/diagnostics/bundles/$serverBundleId/complete").header("Authorization", "Bearer $token").post(completeBody).build()).execute().use {
            if (!it.isSuccessful) error("complete failed ${it.code}")
        }
        zip.delete(); sidecar.delete()
    }
}
