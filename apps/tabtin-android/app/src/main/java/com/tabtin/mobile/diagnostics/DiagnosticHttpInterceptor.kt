package com.tabtin.mobile.diagnostics

import okhttp3.Interceptor
import okhttp3.Response

/** 只记录 HTTP 元数据；从接口层面禁止读取 headers/body/query。 */
public class DiagnosticHttpInterceptor(
    private val recorder: DiagnosticRecorder,
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val requestId = DiagnosticRecorder.newRequestId()
        val started = System.nanoTime()
        return try {
            val response = chain.proceed(request)
            recorder.recordHttp(
                requestId = requestId,
                method = request.method,
                url = request.url.newBuilder().query(null).build().toString(),
                statusCode = response.code,
                durationMs = elapsedMilliseconds(started),
                requestBytes = runCatching { request.body?.contentLength() }.getOrNull()?.takeIf { it >= 0 },
                responseBytes = runCatching { response.body.contentLength() }.getOrNull()?.takeIf { it >= 0 },
                retry = request.header(RETRY_HEADER) == "1",
                error = null,
            )
            response
        } catch (throwable: Throwable) {
            recorder.recordHttp(
                requestId = requestId,
                method = request.method,
                url = request.url.newBuilder().query(null).build().toString(),
                statusCode = null,
                durationMs = elapsedMilliseconds(started),
                requestBytes = runCatching { request.body?.contentLength() }.getOrNull()?.takeIf { it >= 0 },
                responseBytes = null,
                retry = request.header(RETRY_HEADER) == "1",
                error = throwable,
            )
            throw throwable
        }
    }

    private companion object {
        private const val RETRY_HEADER = "X-TabTin-Diagnostic-Retry"

        private fun elapsedMilliseconds(started: Long): Long =
            (System.nanoTime() - started).coerceAtLeast(0) / 1_000_000
    }
}
