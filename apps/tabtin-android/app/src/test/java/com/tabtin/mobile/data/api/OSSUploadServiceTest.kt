package com.tabtin.mobile.data.api

import io.mockk.mockk
import com.tabtin.mobile.data.model.AppError
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Retrofit
import java.security.MessageDigest

/**
 * L4 (W3 收尾)：OSSUploadService 持久通道单测
 *
 * **历史背景**：iOS / Android / HarmonyOS 三端 OSSUploadService 在调研 C
 * 时被发现"零单测"，登记为 L4。W3 临时通道虽与持久通道物理分离，但 L4 同期
 * 收敛——这是 W3 任务的硬性要求。
 *
 * **覆盖策略**（不引入 MockWebServer 等重依赖）：
 *   1. `computeFileHash` 采样算法回归（与 Electron `packages/oss-client` /
 *      iOS `OSSUploadService.computeFileHash(data:)` 算法一致钉死，跨端
 *      秒传的判等签名永远对得上）
 *   2. PresignUploadRequest / ConfirmUploadRequest @SerialName 序列化为
 *      snake_case，与后端 Pydantic schema 字段一致（防止某次重构 IDE
 *      auto-rename 把 SerialName 也改了）
 *   3. PresignUploadResponse / ConfirmUploadResponse 字段反序列化
 *
 * 完整 directUpload 链路（presign + PUT + confirm 串接 + 失败重试 +
 * pending confirm 队列）需要 MockWebServer，登记到 L4 后续，本期不补。
 */
class OSSUploadServiceTest {

    // ── computeFileHash 算法回归 ────────────────────────────────────
    //
    // **W3 Review 2 H3 / Review 3 H2 修复（2026-05-13）**：原版本 13 个 case
    // 全部调测试自己复刻的 `computeFileHashReference`，根本不调生产代码——
    // 等于"自检测试"，生产算法静默退化测试不会报警。修复：所有断言改用
    // `productionHash(data)` 调真实 `OSSUploadService.computeFileHash`
    // （已暴露为 internal），让 reference 真正起到"双源对账"作用——任一改
    // 动让两边输出不一致即测试失败。

    @Test
    fun `computeFileHash full mode (at most 8MB) returns SHA-256 over entire bytes`() {
        val data = ByteArray(1024) { (it % 256).toByte() }
        val expected = sha256Hex(data)
        assertEquals("生产代码 1KB 全量 hash = SHA-256(全数据)", expected, productionHash(data))
        assertEquals("生产 vs reference 双源对账", productionHash(data), computeFileHashReference(data))
    }

    @Test
    fun `computeFileHash sampled mode (over 8MB) uses head + tail + size`() {
        val size = 10 * 1024 * 1024
        val data = ByteArray(size) { (it % 256).toByte() }
        val chunkSize = 2 * 1024 * 1024

        val digest = MessageDigest.getInstance("SHA-256")
        digest.update(data, 0, chunkSize)
        digest.update(data, size - chunkSize, chunkSize)
        digest.update(size.toLong().toString().toByteArray(Charsets.UTF_8))
        val expected = digest.digest().joinToString("") { "%02x".format(it) }

        assertEquals(
            "生产代码 10MB 采样 hash = SHA-256(首2MB + 尾2MB + size字符串)",
            expected,
            productionHash(data),
        )
        assertEquals("生产 vs reference 双源对账", productionHash(data), computeFileHashReference(data))
    }

    @Test
    fun `computeFileHash detects content change at boundary (8MB exact)`() {
        val a = ByteArray(8 * 1024 * 1024) { 0x55.toByte() }
        val b = a.copyOf().also { it[0] = 0xAA.toByte() }
        assertNotEquals(productionHash(a), productionHash(b))
    }

    @Test
    fun `computeFileHash sampled mode detects head change`() {
        val a = ByteArray(10 * 1024 * 1024) { 0x55.toByte() }
        val b = a.copyOf().also { it[0] = 0xAA.toByte() }
        assertNotEquals(
            "生产代码采样模式下首字节变化必须改变 hash",
            productionHash(a),
            productionHash(b),
        )
    }

    @Test
    fun `computeFileHash sampled mode detects tail change`() {
        val a = ByteArray(10 * 1024 * 1024) { 0x55.toByte() }
        val b = a.copyOf().also { it[it.size - 1] = 0xAA.toByte() }
        assertNotEquals(
            "生产代码采样模式下尾字节变化必须改变 hash",
            productionHash(a),
            productionHash(b),
        )
    }

    // ── DTO 序列化字段名（snake_case）──────────────────────────────

    private val json = Json { encodeDefaults = false }

    @Test
    fun `PresignUploadRequest serializes to snake_case (与后端 Pydantic 一致)`() {
        val req = PresignUploadRequest(
            filename = "slides.pptx",
            folder = "chat/attachments",
            contentType = "application/pdf",
            fileSize = 12345,
            fileHash = "abc",
            organizationId = "wt-1",
            module = "chat",
            contextType = "message",
            contextId = "ctx-1",
            isPublic = false,
        )
        val out = json.encodeToString(PresignUploadRequest.serializer(), req)
        assertTrue("含 content_type", out.contains("\"content_type\""))
        assertTrue("含 file_size", out.contains("\"file_size\""))
        assertTrue("含 file_hash", out.contains("\"file_hash\""))
        assertTrue("含 organization_id", out.contains("\"organization_id\""))
        assertTrue("含 context_type", out.contains("\"context_type\""))
        assertTrue("含 context_id", out.contains("\"context_id\""))
        // **关键**：filename / module 是后端 schema 用的小写字段，不应被改名
        assertTrue("含 filename（不是 fileName）", out.contains("\"filename\""))
        assertTrue("含 module", out.contains("\"module\""))
    }

    @Test
    fun `ConfirmUploadRequest serializes to snake_case (后端 schema 对齐)`() {
        val req = ConfirmUploadRequest(
            objectKey = "chat/attachments/abc.pptx",
            fileName = "slides.pptx",
            fileSize = 99999,
            contentType = "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            fileHash = "h",
            module = "chat",
            contextType = "message",
            contextId = "ctx-1",
            organizationId = "wt-1",
            isPublic = false,
        )
        val out = json.encodeToString(ConfirmUploadRequest.serializer(), req)
        assertTrue("含 object_key", out.contains("\"object_key\""))
        assertTrue("含 file_name", out.contains("\"file_name\""))
        assertTrue("含 file_size", out.contains("\"file_size\""))
        assertTrue("含 content_type", out.contains("\"content_type\""))
        assertTrue("含 file_hash", out.contains("\"file_hash\""))
        assertTrue("含 module", out.contains("\"module\":\"chat\""))
        assertTrue("含 context_type", out.contains("\"context_type\":\"message\""))
        assertTrue("显式含 is_public=false", out.contains("\"is_public\":false"))
    }

    @Test
    fun `UploadScope pins all server verified fields`() {
        val scope = UploadScope(
            module = "chat",
            contextType = "message",
            contextId = "conversation-1",
            organizationId = "organization-1",
            isPublic = false,
        )

        val out = json.encodeToString(UploadScope.serializer(), scope)

        assertTrue(out.contains("\"module\":\"chat\""))
        assertTrue(out.contains("\"context_type\":\"message\""))
        assertTrue(out.contains("\"context_id\":\"conversation-1\""))
        assertTrue(out.contains("\"organization_id\":\"organization-1\""))
        assertTrue(out.contains("\"is_public\":false"))
    }

    @Test
    fun `OSS file access prefers CDN display URL over direct resolved URL`() {
        val access = OSSFileAccess(
            fileId = "file-1",
            accessUrl = "https://assets.example.com/a.png",
            cdnUrl = "https://assets.example.com/cdn-a.png",
            resolvedUrl = "https://example-assets.oss-cn-shanghai.aliyuncs.com/a.png",
        )

        assertEquals("https://assets.example.com/cdn-a.png", access.displayUrl)
    }

    @Test
    fun `OSS file access falls back to resolved URL when public URLs are absent`() {
        val access = OSSFileAccess(
            fileId = "file-1",
            resolvedUrl = "https://example-assets.oss-cn-shanghai.aliyuncs.com/private.png",
        )

        assertEquals("https://example-assets.oss-cn-shanghai.aliyuncs.com/private.png", access.displayUrl)
    }

    @Test
    fun `OSS file access decodes public URL fields returned by backend`() {
        val raw = """
            {
              "file_id": "file-1",
              "file_name": "image.png",
              "access_url": "https://assets.example.com/image.png",
              "cdn_url": "https://assets.example.com/cdn-image.png",
              "resolved_url": "https://example-assets.oss-cn-shanghai.aliyuncs.com/image.png"
            }
        """.trimIndent()

        val access = json.decodeFromString(OSSFileAccess.serializer(), raw)

        assertEquals("https://assets.example.com/image.png", access.accessUrl)
        assertEquals("https://assets.example.com/cdn-image.png", access.cdnUrl)
        assertEquals("https://assets.example.com/cdn-image.png", access.displayUrl)
    }

    @Test
    fun `confirm scope mismatch error code is preserved for non retry handling`() {
        val envelope = com.tabtin.mobile.data.model.ApiEnvelope<ConfirmUploadResponse>(
            success = false,
            message = "上传确认范围与签名不一致，请重新获取上传签名",
            errorCode = "PRESIGN_SCOPE_MISMATCH",
        )

        val error = try {
            envelope.unwrap()
            throw AssertionError("失败信封必须抛出 RequestFailed")
        } catch (e: AppError.RequestFailed) {
            e
        }

        assertEquals("PRESIGN_SCOPE_MISMATCH", error.errorCode)
    }

    @Test
    fun `PresignUploadResponse deserializes snake_case from backend`() {
        val raw = """
            {"instant":false,"object_key":"x","presigned_url":"https://oss/x",
             "access_url":"https://cdn/x","cdn_url":"https://cdn/x",
             "content_type":"application/pdf","file_id":null,"file_name":"a.pdf"}
        """.trimIndent()
        val resp = json.decodeFromString(PresignUploadResponse.serializer(), raw)
        assertEquals(false, resp.instant)
        assertEquals("x", resp.objectKey)
        assertEquals("https://oss/x", resp.presignedUrl)
        assertEquals("https://cdn/x", resp.accessUrl)
        assertEquals("https://cdn/x", resp.cdnUrl)
        assertEquals("application/pdf", resp.contentType)
        assertNull(resp.fileId)
        assertEquals("a.pdf", resp.fileName)
    }

    @Test
    fun `PresignUploadResponse with instant=true returns file_id only (no presigned_url)`() {
        // 秒传命中场景：后端跳过 PUT + confirm，直接返 instant=true + file_id
        val raw = """
            {"instant":true,"file_id":"file-123","access_url":"https://cdn/instant",
             "file_name":"existing.pdf"}
        """.trimIndent()
        val resp = json.decodeFromString(PresignUploadResponse.serializer(), raw)
        assertEquals(true, resp.instant)
        assertEquals("file-123", resp.fileId)
        assertNull("instant=true 时无需 presigned_url", resp.presignedUrl)
        assertNull("instant=true 时无需 object_key", resp.objectKey)
    }

    @Test
    fun `ConfirmUploadResponse deserializes snake_case`() {
        val raw = """
            {"file_id":"f1","access_url":"https://cdn/f1","cdn_url":"https://cdn/f1",
             "file_name":"a.pdf","mime_type":"application/pdf"}
        """.trimIndent()
        val resp = json.decodeFromString(ConfirmUploadResponse.serializer(), raw)
        assertEquals("f1", resp.fileId)
        assertEquals("https://cdn/f1", resp.accessUrl)
        assertEquals("https://cdn/f1", resp.cdnUrl)
        assertEquals("a.pdf", resp.fileName)
        assertEquals("application/pdf", resp.mimeType)
    }

    @Test
    fun `DeactivateUsageRequest serializes to snake_case`() {
        val req = DeactivateUsageRequest(
            fileId = "f1",
            module = "chat",
            contextType = "message",
            contextId = "c1",
        )
        val out = json.encodeToString(DeactivateUsageRequest.serializer(), req)
        assertTrue(out.contains("\"file_id\":\"f1\""))
        assertTrue(out.contains("\"context_type\":\"message\""))
        assertTrue(out.contains("\"context_id\":\"c1\""))
    }

    // ── 跨端算法一致性（与 iOS / Electron 同款 reference vector）──────

    @Test
    fun `cross-platform reference vector empty buffer hash`() {
        val expected = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        assertEquals("生产代码 SHA-256(empty) 跨端一致", expected, productionHash(ByteArray(0)))
    }

    @Test
    fun `cross-platform reference vector single byte hash`() {
        val expected = "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d"
        assertEquals("生产代码 SHA-256(0x00) 跨端一致", expected, productionHash(byteArrayOf(0x00)))
    }

    // ─────────────────────────────────────────────────────────────────
    // helpers
    // ─────────────────────────────────────────────────────────────────

    /**
     * 直接调生产代码 `OSSUploadService.computeFileHash` (W3 Review 修复后
     * 改为 `internal`)。constructor 走 mockk Context + 真空 OkHttp/Retrofit
     * 让对象能 new 出来——`computeFileHash` 是 pure CPU 函数，不依赖任何
     * 注入字段，纯算法回归无副作用。
     */
    private fun productionHash(data: ByteArray): String {
        val context = mockk<android.content.Context>(relaxed = true)
        val okHttp = OkHttpClient.Builder().build()
        val retrofit = Retrofit.Builder()
            .baseUrl("https://placeholder.test/")
            .client(okHttp)
            .build()
        val service = OSSUploadService(context, okHttp, retrofit)
        return service.computeFileHash(data)
    }

    /**
     * 与 OSSUploadService 内 `computeFileHash(ByteArray)` 算法的 reference
     * 实现 —— 用于"双源对账"：测试主断言用 `productionHash` 调真生产代码，
     * 同时跟 reference 比对，让生产改动 → reference 不改 → 测试失败 → 提示
     * 同步更新（这是 W3 Review 2 H3 / Review 3 H2 修复要求的真覆盖模式）。
     */
    private fun computeFileHashReference(data: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val size = data.size.toLong()
        val chunkSize = 2 * 1024 * 1024
        val fullThreshold = chunkSize.toLong() * 4 // 8MB

        if (size <= fullThreshold) {
            digest.update(data)
        } else {
            digest.update(data, 0, chunkSize)
            digest.update(data, data.size - chunkSize, chunkSize)
            digest.update(size.toString().toByteArray(Charsets.UTF_8))
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun sha256Hex(data: ByteArray): String {
        return MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it) }
    }
}
