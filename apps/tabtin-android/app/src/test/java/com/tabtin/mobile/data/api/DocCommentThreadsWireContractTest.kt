package com.tabtin.mobile.data.api

import com.tabtin.mobile.data.model.ApiEnvelope
import com.tabtin.mobile.data.model.doc.CommentThreadCreateResponse
import com.tabtin.mobile.data.model.doc.CommentThreadListResponse
import com.tabtin.mobile.data.model.doc.CreateCommentThreadRequest
import com.tabtin.mobile.data.model.doc.CommentAnchor
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 钉住 comment-threads 业务信封：`{success, data}`，不是 collab `{status, data}`。
 */
public class DocCommentThreadsWireContractTest {
    private val json = com.tabtin.mobile.data.api.json

    @Test
    public fun `list decodes the business success envelope and thread array`() {
        val envelope = json.decodeFromString<ApiEnvelope<CommentThreadListResponse>>(
            """{
                "success": true,
                "code": "SUCCESS",
                "data": {
                    "threads": [{
                        "id": "thread-1",
                        "document_id": "doc-1",
                        "scope": "block",
                        "status": "open",
                        "anchor": {
                            "version": 1,
                            "block_ids": ["pm-block-1"],
                            "block_type": "paragraph",
                            "selected_text": "第一段"
                        },
                        "anchor_status": "attached",
                        "created_by_user_id": "user-1",
                        "resolved_by_user_id": null,
                        "resolved_at": null,
                        "created_at": "2026-08-18T04:00:00+00:00",
                        "updated_at": "2026-08-18T04:00:00+00:00",
                        "messages": [{
                            "id": "msg-1",
                            "thread_id": "thread-1",
                            "kind": "root",
                            "author_name": "Alice",
                            "author_user_id": "user-1",
                            "author_avatar": null,
                            "author_account_name": "alice",
                            "body": "看一下这段",
                            "mention_user_ids": [],
                            "client_request_id": null,
                            "is_deleted": false,
                            "attachments": [],
                            "created_at": "2026-08-18T04:00:00+00:00",
                            "updated_at": "2026-08-18T04:00:00+00:00"
                        }]
                    }],
                    "capabilities": ["comment_threads_v1"]
                }
            }""".trimIndent(),
        )

        assertTrue(envelope.success)
        val data = envelope.unwrap()
        assertEquals(listOf("comment_threads_v1"), data.capabilities)
        val thread = data.threads.single()
        assertEquals("thread-1", thread.id)
        assertEquals("block", thread.scope)
        assertEquals(listOf("pm-block-1"), thread.anchor.blockIds)
        assertEquals("看一下这段", thread.messages.single().body)
        assertEquals("Alice", thread.messages.single().authorName)
        assertNull(thread.messages.single().authorAvatar)
    }

    @Test
    public fun `create decodes the business success envelope and single thread`() {
        val envelope = json.decodeFromString<ApiEnvelope<CommentThreadCreateResponse>>(
            """{
                "success": true,
                "code": "SUCCESS",
                "data": {
                    "thread": {
                        "id": "thread-new",
                        "document_id": "doc-1",
                        "scope": "document",
                        "status": "open",
                        "anchor": {"version": 1},
                        "anchor_status": "none",
                        "messages": [{
                            "id": "msg-new",
                            "thread_id": "thread-new",
                            "kind": "root",
                            "author_name": "Bob",
                            "author_avatar": "https://cdn.example.com/bob.png",
                            "body": "文末一条",
                            "is_deleted": false
                        }]
                    }
                }
            }""".trimIndent(),
        )

        val thread = envelope.unwrap().thread
        assertEquals("thread-new", thread.id)
        assertEquals("document", thread.scope)
        assertEquals(1, thread.anchor.version)
        assertTrue(thread.anchor.blockIds.isEmpty())
        assertEquals("文末一条", thread.messages.single().body)
        assertEquals("https://cdn.example.com/bob.png", thread.messages.single().authorAvatar)
    }

    @Test
    public fun `create request encodes block scope with top-level block ids`() {
        val payload = json.encodeToString(
            CreateCommentThreadRequest(
                body = "块评",
                scope = "block",
                anchor = CommentAnchor(
                    version = 1,
                    blockIds = listOf("pm-block-1"),
                    blockType = "paragraph",
                    selectedText = "第一段",
                ),
            ),
        )

        assertTrue(payload.contains("\"scope\":\"block\""))
        assertTrue(payload.contains("\"block_ids\""))
        assertTrue(payload.contains("pm-block-1"))
        assertTrue(payload.contains("\"version\":1"))
        assertFalse(payload.contains("commentAnchor"))
        assertFalse(payload.contains("\"status\""))
    }

    @Test
    public fun `create request encodes document scope with version-only anchor`() {
        val payload = json.encodeToString(
            CreateCommentThreadRequest(
                body = "文末一条",
                scope = "document",
                anchor = CommentAnchor(version = 1),
            ),
        )

        assertTrue(payload.contains("\"scope\":\"document\""))
        assertTrue(payload.contains("\"version\":1"))
        assertFalse(payload.contains("block_ids"))
        assertFalse(payload.contains("commentAnchor"))
    }
}
