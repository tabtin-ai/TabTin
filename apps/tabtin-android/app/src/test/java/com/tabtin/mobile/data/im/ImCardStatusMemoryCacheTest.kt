package com.tabtin.mobile.data.im

import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

class ImCardStatusMemoryCacheTest {
    @Test
    fun `authoritative v2 share detail survives card disposal and rejects stale versions`() {
        val objectId = "share-v2-${UUID.randomUUID()}"
        val detail = ImSessionShareV2Detail(
            id = objectId,
            sessionTitle = "协作任务",
            ownerUserId = "owner-1",
            granteeUserId = "grantee-1",
            version = 2,
        )

        ImCardStatusMemoryCache.putSessionShareV2Detail(detail)

        assertSame(detail, ImCardStatusMemoryCache.cachedSessionShareV2Detail(objectId, minimumVersion = 2))
        assertNull(ImCardStatusMemoryCache.cachedSessionShareV2Detail(objectId, minimumVersion = 3))
    }

    @Test
    fun `authoritative continuation detail survives card disposal and rejects stale versions`() {
        val objectId = "continuation-${UUID.randomUUID()}"
        val detail = ImSessionContinuationDetail(
            objectId = objectId,
            version = 4,
            titleSnapshot = "冻结任务",
        )

        ImCardStatusMemoryCache.putSessionContinuationDetail(detail)

        assertSame(detail, ImCardStatusMemoryCache.cachedSessionContinuationDetail(objectId, minimumVersion = 4))
        assertNull(ImCardStatusMemoryCache.cachedSessionContinuationDetail(objectId, minimumVersion = 5))
    }

    @Test
    fun `late stale card detail cannot overwrite a newer cached version`() {
        val shareId = "share-v2-${UUID.randomUUID()}"
        val newerShare = ImSessionShareV2Detail(
            id = shareId,
            ownerUserId = "owner-1",
            granteeUserId = "grantee-1",
            version = 6,
            phase = "joined",
        )
        ImCardStatusMemoryCache.putSessionShareV2Detail(newerShare)
        ImCardStatusMemoryCache.putSessionShareV2Detail(newerShare.copy(version = 5, phase = "awaitingJoin"))

        val continuationId = "continuation-${UUID.randomUUID()}"
        val newerContinuation = ImSessionContinuationDetail(
            objectId = continuationId,
            version = 4,
            creationStatus = "created",
        )
        ImCardStatusMemoryCache.putSessionContinuationDetail(newerContinuation)
        ImCardStatusMemoryCache.putSessionContinuationDetail(
            newerContinuation.copy(version = 3, creationStatus = "available"),
        )

        assertSame(newerShare, ImCardStatusMemoryCache.cachedSessionShareV2Detail(shareId, 6))
        assertSame(
            newerContinuation,
            ImCardStatusMemoryCache.cachedSessionContinuationDetail(continuationId, 4),
        )
    }

    @Test
    fun `partial session share refresh keeps authoritative owner identity`() {
        val shareId = "share-${UUID.randomUUID()}"
        ImCardStatusMemoryCache.putSessionShare(
            ImSessionShareCard(
                shareId = shareId,
                sessionId = "session-1",
                sessionTitle = "示例任务",
                ownerUserId = "owner-1",
                granteeUserId = "grantee-1",
                status = "revoked",
            ),
        )

        ImCardStatusMemoryCache.putSessionShare(
            ImSessionShareCard(
                shareId = shareId,
                sessionId = "session-1",
                sessionTitle = "示例任务",
                status = "revoked",
            ),
        )

        val cached = ImCardStatusMemoryCache.cachedSessionShare(shareId)
        assertEquals("owner-1", cached?.ownerUserId)
        assertEquals("grantee-1", cached?.granteeUserId)
        assertEquals("revoked", cached?.normalizedStatus)
    }

    @Test
    fun `resource access events refresh matching resource card status`() {
        val resourceId = "doc-${UUID.randomUUID()}"
        val card = ImResourceCard(
            type = ImResourceCardType.DOCUMENT,
            name = "权限文档",
            resourceId = resourceId,
        )

        ImCardStatusMemoryCache.putResourcePreview(
            card,
            ImResourceCardPreviewResult(
                status = ImResourceCardPreviewStatus.OK,
                data = ImResourceCardPreview(
                    name = "旧标题",
                    spaceId = "space-1",
                    organizationId = "org-1",
                    currentUserRole = "viewer",
                ),
            ),
        )
        ImCardStatusMemoryCache.markResourceAccessRequested(card)
        val initialRevision = ImCardStatusMemoryCache.resourceRefreshRevision(card)

        ImCardStatusMemoryCache.handleResourceAccessEvent(
            eventType = "resource_access_changed",
            resourceType = "tabdoc",
            resourceId = resourceId,
        )

        assertNull(ImCardStatusMemoryCache.cachedResourcePreview(card))
        assertFalse(ImCardStatusMemoryCache.hasRequestedResourceAccess(card))
        assertEquals(initialRevision + 1L, ImCardStatusMemoryCache.resourceRefreshRevision(card))

        ImCardStatusMemoryCache.handleResourceAccessEvent(
            eventType = "resource_access_revoked",
            resourceType = "tabdoc",
            resourceId = resourceId,
        )

        assertEquals(
            ImResourceCardPreviewStatus.FORBIDDEN,
            ImCardStatusMemoryCache.cachedResourcePreview(card)?.status,
        )
        assertEquals(initialRevision + 2L, ImCardStatusMemoryCache.resourceRefreshRevision(card))
    }
}
