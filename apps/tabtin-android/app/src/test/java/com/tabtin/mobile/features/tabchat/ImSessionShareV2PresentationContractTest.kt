package com.tabtin.mobile.features.tabchat

import com.tabtin.mobile.data.im.ImSessionShareV2Card
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ImSessionShareV2PresentationContractTest {
    @Test
    fun `session share v2 routes to an actionable card before unsupported fallback`() {
        val source = File(
            "src/main/java/com/tabtin/mobile/features/tabchat/ImConversationScreen.kt",
        ).readText()
        val bubbleBody = source.substringAfter("private fun ImBubbleBody(")
            .substringBefore("private fun ImSessionShareCardContent(")

        val v2Route = bubbleBody.indexOf("sessionShareV2Card != null ->")
        val unsupportedFallback = bubbleBody.indexOf("message.hasStructuredCard ->")

        assertTrue(v2Route >= 0)
        assertTrue(unsupportedFallback >= 0)
        assertTrue(v2Route < unsupportedFallback)
        assertTrue(bubbleBody.contains("ImSessionShareV2CardContent"))

        val v2Card = source.substringAfter("private fun ImSessionShareV2CardContent(")
            .substringBefore("private fun ImSessionShareCardContent(")
        assertTrue(v2Card.contains("snapshot.version"))
        assertTrue(v2Card.contains("sessionShareV2Relation"))
        assertTrue(v2Card.contains("loadDetail"))
        assertTrue(v2Card.contains("onAccept"))
        assertTrue(v2Card.contains("onOpen"))
        assertTrue(v2Card.contains("canJoin"))
        assertTrue(v2Card.contains("canOpen"))
        assertFalse(v2Card.contains("onRevoke"))
        assertFalse(v2Card.contains("onResume"))
    }

    @Test
    fun `session share v2 describes each viewers collaboration relation`() {
        val snapshot = ImSessionShareV2Card(
            schemaVersion = 1,
            version = 3,
            objectId = "share-24",
            title = "创建表格和文档",
            senderId = "user-1",
            recipientId = "user-2",
        )

        assertEquals(
            ImSessionShareV2Relation(ImSessionShareV2RelationKind.SENT),
            sessionShareV2Relation(snapshot, "沈庾涛", "user-1", emptyList()),
        )
        assertEquals(
            ImSessionShareV2Relation(ImSessionShareV2RelationKind.RECEIVED, "沈庾涛"),
            sessionShareV2Relation(snapshot, "沈庾涛", "user-2", emptyList()),
        )
        assertEquals(
            ImSessionShareV2Relation(ImSessionShareV2RelationKind.OTHER),
            sessionShareV2Relation(snapshot, "沈庾涛", "observer", emptyList()),
        )
    }
}
