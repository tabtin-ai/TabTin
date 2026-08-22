package com.tabtin.mobile.features.files

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CloudDriveFilePresentationTest {
    @Test
    fun `native resources always keep their branded category`() {
        assertCategory(CloudDriveFileCategory.CLOUD_DOCUMENT, "tabdoc", "brief.pdf", "application/pdf")
        assertCategory(CloudDriveFileCategory.CLOUD_TABLE, "TABDATA", "brief.pdf", "application/pdf")
    }

    @Test
    fun `mime type wins over a conflicting extension`() {
        assertCategory(CloudDriveFileCategory.IMAGE, "tabfiles", "photo.pdf", "image/png")
        assertCategory(CloudDriveFileCategory.PDF, "tabfiles", "photo.png", "application/pdf; charset=binary")
        assertCategory(CloudDriveFileCategory.PDF, "TABFILES", "photo.png", " APPLICATION/PDF ")
        assertCategory(CloudDriveFileCategory.AUDIO, "tabfiles", "clip.mp4", "audio/mpeg")
        assertCategory(CloudDriveFileCategory.VIDEO, "tabfiles", "clip.mp3", "video/mp4")
    }

    @Test
    fun `office text and archive mime types resolve to semantic categories`() {
        assertCategory(
            CloudDriveFileCategory.DOCUMENT,
            mimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )
        assertCategory(CloudDriveFileCategory.SPREADSHEET, mimeType = "text/csv")
        assertCategory(CloudDriveFileCategory.PRESENTATION, mimeType = "application/vnd.apple.keynote")
        assertCategory(CloudDriveFileCategory.TEXT, mimeType = "application/json")
        assertCategory(CloudDriveFileCategory.ARCHIVE, mimeType = "application/x-7z-compressed")
    }

    @Test
    fun `ios parity mime and extension aliases keep the same icon categories`() {
        mapOf(
            "application/vnd.apple.pages" to CloudDriveFileCategory.DOCUMENT,
            "application/vnd.apple.numbers" to CloudDriveFileCategory.SPREADSHEET,
            "application/sql" to CloudDriveFileCategory.TEXT,
            "application/x-zip-compressed" to CloudDriveFileCategory.ARCHIVE,
            "application/x-xz" to CloudDriveFileCategory.ARCHIVE,
        ).forEach { (mimeType, expected) ->
            assertCategory(expected, mimeType = mimeType)
        }

        mapOf(
            "proposal.pages" to CloudDriveFileCategory.DOCUMENT,
            "native.cc" to CloudDriveFileCategory.TEXT,
        ).forEach { (fileName, expected) ->
            assertCategory(expected, fileName = fileName)
        }
    }

    @Test
    fun `extension fallback covers common local files case insensitively`() {
        mapOf(
            "photo.HEIC" to CloudDriveFileCategory.IMAGE,
            "roadmap.PDF" to CloudDriveFileCategory.PDF,
            "brief.DOCX" to CloudDriveFileCategory.DOCUMENT,
            "budget.XLSX" to CloudDriveFileCategory.SPREADSHEET,
            "launch.KEY" to CloudDriveFileCategory.PRESENTATION,
            "notes.MD" to CloudDriveFileCategory.TEXT,
            "voice.M4A" to CloudDriveFileCategory.AUDIO,
            "demo.MOV" to CloudDriveFileCategory.VIDEO,
            "assets.TAR" to CloudDriveFileCategory.ARCHIVE,
        ).forEach { (fileName, expected) ->
            assertCategory(expected, fileName = fileName)
        }
    }

    @Test
    fun `extension fallback covers every accepted office text media and archive family`() {
        mapOf(
            CloudDriveFileCategory.DOCUMENT to listOf("doc", "docx"),
            CloudDriveFileCategory.SPREADSHEET to listOf("xls", "xlsx", "csv"),
            CloudDriveFileCategory.PRESENTATION to listOf("ppt", "pptx", "key"),
            CloudDriveFileCategory.TEXT to listOf("txt", "md", "json", "code", "kt", "py", "tsx"),
            CloudDriveFileCategory.AUDIO to listOf("mp3", "wav"),
            CloudDriveFileCategory.VIDEO to listOf("mp4", "mkv"),
            CloudDriveFileCategory.ARCHIVE to listOf("zip", "rar", "7z", "tar", "gz"),
        ).forEach { (expected, extensions) ->
            extensions.forEach { extension ->
                assertCategory(expected, itemType = "TABFILES", fileName = "asset.$extension")
            }
        }
    }

    @Test
    fun `blank and unknown inputs use the generic file category`() {
        assertCategory(CloudDriveFileCategory.GENERIC)
        assertCategory(CloudDriveFileCategory.GENERIC, itemType = null, fileName = null, mimeType = null)
        assertCategory(CloudDriveFileCategory.GENERIC, itemType = " ", fileName = " ", mimeType = " ")
        assertCategory(CloudDriveFileCategory.GENERIC, fileName = "README")
        assertCategory(CloudDriveFileCategory.GENERIC, fileName = "model.bin", mimeType = "application/octet-stream")
    }

    @Test
    fun `lightweight preview keeps text but rejects resource urls`() {
        assertEquals("项目正文", cloudDriveSafePreviewText("  项目正文  "))
        assertNull(cloudDriveSafePreviewText("https://cdn.example.test/signed/file?token=secret"))
        assertNull(cloudDriveSafePreviewText("DATA:image/png;base64,abc"))
        assertNull(cloudDriveSafePreviewText(null))
    }

    @Test
    fun `pipe separated table schema is promoted to headers`() {
        val content = cloudDriveTablePreviewContent(
            preview = "Bug 描述 | GitHub Issue 链接 | 操作录屏 /...",
        )

        assertEquals(listOf("Bug 描述", "GitHub Issue 链接", "操作录屏"), content.fieldNames)
        assertNull(content.previewText)
    }

    private fun assertCategory(
        expected: CloudDriveFileCategory,
        itemType: String? = "tabfiles",
        fileName: String? = null,
        mimeType: String? = null,
    ) {
        assertEquals(
            expected,
            CloudDriveFilePresentation.classify(
                itemType = itemType,
                fileName = fileName,
                mimeType = mimeType,
            ),
        )
    }
}
