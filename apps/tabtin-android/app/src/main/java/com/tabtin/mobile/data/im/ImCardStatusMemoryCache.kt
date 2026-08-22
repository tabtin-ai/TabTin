package com.tabtin.mobile.data.im

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * IM 富卡的轻量内存状态缓存。
 *
 * 消息快照只保存发送时的卡片结构；权限 / 共享状态需要打开会话后向后端刷新。
 * 缓存的目标不是替代后端，而是避免用户进出会话时先看到默认态、再跳到真实态。
 */
public object ImCardStatusMemoryCache {
    private const val MAX_RESOURCE_PREVIEWS = 200
    private const val MAX_SESSION_SHARES = 200
    private const val MAX_CARD_DETAILS = 200

    private val _resourcePreviews = MutableStateFlow<Map<String, ImResourceCardPreviewResult>>(emptyMap())
    public val resourcePreviews: StateFlow<Map<String, ImResourceCardPreviewResult>> =
        _resourcePreviews.asStateFlow()

    private val _resourceRefreshRevisions = MutableStateFlow<Map<String, Long>>(emptyMap())
    public val resourceRefreshRevisions: StateFlow<Map<String, Long>> =
        _resourceRefreshRevisions.asStateFlow()

    private val _requestedResourceAccess = MutableStateFlow<Set<String>>(emptySet())
    public val requestedResourceAccess: StateFlow<Set<String>> =
        _requestedResourceAccess.asStateFlow()

    private val _sessionShares = MutableStateFlow<Map<String, ImSessionShareCard>>(emptyMap())
    public val sessionShares: StateFlow<Map<String, ImSessionShareCard>> =
        _sessionShares.asStateFlow()

    private val authoritativeSessionShares = MutableStateFlow<Map<String, ImSessionShareCard>>(emptyMap())
    private val sessionShareV2Details = MutableStateFlow<Map<String, ImSessionShareV2Detail>>(emptyMap())
    private val sessionContinuationDetails =
        MutableStateFlow<Map<String, ImSessionContinuationDetail>>(emptyMap())

    public fun resourceKey(card: ImResourceCard): String? {
        val resourceId = card.resourceId?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        return "${card.type}:$resourceId"
    }

    public fun cachedResourcePreview(card: ImResourceCard): ImResourceCardPreviewResult? =
        resourceKey(card)?.let { _resourcePreviews.value[it] }

    public fun resourceRefreshRevision(card: ImResourceCard): Long =
        resourceKey(card)?.let { _resourceRefreshRevisions.value[it] } ?: 0L

    public fun putResourcePreview(card: ImResourceCard, result: ImResourceCardPreviewResult) {
        val key = resourceKey(card) ?: return
        _resourcePreviews.update { previews ->
            previews.putCapped(
                key = key,
                value = result,
                maxSize = MAX_RESOURCE_PREVIEWS,
            )
        }
    }

    public fun markResourceAccessRequested(card: ImResourceCard) {
        val key = resourceKey(card) ?: return
        _requestedResourceAccess.value = _requestedResourceAccess.value + key
    }

    public fun hasRequestedResourceAccess(card: ImResourceCard): Boolean =
        resourceKey(card)?.let { it in _requestedResourceAccess.value } == true

    public fun handleResourceAccessEvent(
        eventType: String,
        resourceType: String?,
        resourceId: String?,
    ) {
        val cardType = cardTypeForBackendResourceType(resourceType) ?: return
        val id = resourceId?.trim()?.takeIf { it.isNotEmpty() } ?: return
        val key = "$cardType:$id"
        when (eventType) {
            "resource_access_revoked" -> {
                _resourcePreviews.value = _resourcePreviews.value.putCapped(
                    key = key,
                    value = ImResourceCardPreviewResult(ImResourceCardPreviewStatus.FORBIDDEN),
                    maxSize = MAX_RESOURCE_PREVIEWS,
                )
            }
            "resource_access_granted",
            "resource_access_changed",
            -> {
                if (key in _resourcePreviews.value) {
                    _resourcePreviews.value = _resourcePreviews.value - key
                }
                if (key in _requestedResourceAccess.value) {
                    _requestedResourceAccess.value = _requestedResourceAccess.value - key
                }
            }
            else -> return
        }
        bumpRefreshRevision(key)
    }

    public fun cachedSessionShare(shareId: String): ImSessionShareCard? =
        shareId.trim().takeIf { it.isNotEmpty() }?.let { _sessionShares.value[it] }

    public fun putSessionShare(card: ImSessionShareCard) {
        val key = card.shareId.trim().takeIf { it.isNotEmpty() } ?: return
        _sessionShares.update { shares ->
            val merged = shares[key]?.let { existing ->
                card.copy(
                    sessionId = card.sessionId?.takeIf { it.isNotBlank() } ?: existing.sessionId,
                    sessionTitle = card.sessionTitle?.takeIf { it.isNotBlank() } ?: existing.sessionTitle,
                    ownerUserId = card.ownerUserId?.takeIf { it.isNotBlank() } ?: existing.ownerUserId,
                    granteeUserId = card.granteeUserId?.takeIf { it.isNotBlank() } ?: existing.granteeUserId,
                    ownerDisplayName = card.ownerDisplayName?.takeIf { it.isNotBlank() }
                        ?: existing.ownerDisplayName,
                    granteeDisplayName = card.granteeDisplayName?.takeIf { it.isNotBlank() }
                        ?: existing.granteeDisplayName,
                )
            } ?: card
            shares.putCapped(
                key = key,
                value = merged,
                maxSize = MAX_SESSION_SHARES,
            )
        }
    }

    public fun cachedAuthoritativeSessionShare(shareId: String): ImSessionShareCard? =
        shareId.trim().takeIf { it.isNotEmpty() }?.let { authoritativeSessionShares.value[it] }

    public fun putAuthoritativeSessionShare(card: ImSessionShareCard) {
        val key = card.shareId.trim().takeIf { it.isNotEmpty() } ?: return
        putSessionShare(card)
        authoritativeSessionShares.update { shares ->
            shares.putCapped(
                key = key,
                value = cachedSessionShare(key) ?: card,
                maxSize = MAX_CARD_DETAILS,
            )
        }
    }

    public fun cachedSessionShareV2Detail(
        objectId: String,
        minimumVersion: Int,
    ): ImSessionShareV2Detail? = sessionShareV2Details.value[objectId.trim()]
        ?.takeIf { it.version >= minimumVersion }

    public fun putSessionShareV2Detail(detail: ImSessionShareV2Detail) {
        val key = detail.id.trim().takeIf { it.isNotEmpty() } ?: return
        sessionShareV2Details.update { details ->
            val existing = details[key]
            if (existing != null && existing.version > detail.version) details else details.putCapped(
                key = key,
                value = detail,
                maxSize = MAX_CARD_DETAILS,
            )
        }
        if (sessionShareV2Details.value[key] === detail) putSessionShare(detail.toCardSnapshot())
    }

    public fun invalidateSessionShare(shareId: String) {
        val key = shareId.trim().takeIf { it.isNotEmpty() } ?: return
        _sessionShares.update { it - key }
        authoritativeSessionShares.update { it - key }
        sessionShareV2Details.update { it - key }
    }

    public fun cachedSessionContinuationDetail(
        objectId: String,
        minimumVersion: Int,
    ): ImSessionContinuationDetail? = sessionContinuationDetails.value[objectId.trim()]
        ?.takeIf { it.version >= minimumVersion }

    public fun putSessionContinuationDetail(detail: ImSessionContinuationDetail) {
        val key = detail.objectId.trim().takeIf { it.isNotEmpty() } ?: return
        sessionContinuationDetails.update { details ->
            val existing = details[key]
            if (existing != null && existing.version > detail.version) details else details.putCapped(
                key = key,
                value = detail,
                maxSize = MAX_CARD_DETAILS,
            )
        }
    }

    private fun <T> Map<String, T>.putCapped(key: String, value: T, maxSize: Int): Map<String, T> {
        if (this[key] == value) return this
        val next = LinkedHashMap<String, T>(this.size + 1)
        for ((existingKey, existingValue) in this) {
            if (existingKey != key) next[existingKey] = existingValue
        }
        next[key] = value
        while (next.size > maxSize) {
            val eldest = next.keys.firstOrNull() ?: break
            next.remove(eldest)
        }
        return next
    }

    private fun cardTypeForBackendResourceType(resourceType: String?): String? =
        when (resourceType?.trim()?.lowercase()) {
            "tabdoc", "document" -> ImResourceCardType.DOCUMENT
            "tabdata", "table" -> ImResourceCardType.TABLE
            else -> null
        }

    private fun bumpRefreshRevision(key: String) {
        val current = _resourceRefreshRevisions.value[key] ?: 0L
        _resourceRefreshRevisions.value = _resourceRefreshRevisions.value.putCapped(
            key = key,
            value = current + 1L,
            maxSize = MAX_RESOURCE_PREVIEWS,
        )
    }
}
