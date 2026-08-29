package com.tabtin.mobile.data.im

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** 跨 Organization 的联系人关系；真源为 Django IM 控制面。 */
@Serializable
public data class ExternalContact(
    @SerialName("contact_id") val contactId: String = "",
    @SerialName("organization_id") val organizationId: String = "",
    @SerialName("peer_organization_id") val peerOrganizationId: String = "",
    @SerialName("peer_user_id") val peerUserId: String = "",
    @SerialName("display_name") val displayName: String = "",
    @SerialName("avatar_url") val avatarUrl: String = "",
    val relationship: String = "friend",
    @SerialName("suspended_reason") val suspendedReason: String? = null,
    @SerialName("is_restorable") val isRestorable: Boolean = false,
    @SerialName("updated_at") val updatedAt: String = "",
    @SerialName("peer_organization_name") val peerOrganizationName: String = "",
)

/**
 * 外部私信的发送资格只由当前联系人关系决定；已解除、拉黑、暂停以及没有对应关系
 * 均不能继续向对方发送。调用方应在真正发送前重新读取联系人目录，不能依赖会话的旧快照。
 */
public fun canSendExternalDirectMessage(
    contacts: List<ExternalContact>,
    peerUserId: String,
): Boolean {
    val normalizedPeerUserId = peerUserId.trim()
    if (normalizedPeerUserId.isEmpty()) return false
    return contacts.any { contact ->
        contact.peerUserId.trim() == normalizedPeerUserId &&
            contact.relationship.equals("friend", ignoreCase = true)
    }
}

@Serializable
public data class ExternalContactCandidate(
    @SerialName("user_id") val userId: String = "",
    @SerialName("display_name") val displayName: String = "",
    @SerialName("avatar_url") val avatarUrl: String = "",
    val relationship: String = "none",
    @SerialName("external_contact_id") val externalContactId: String? = null,
    @SerialName("pending_invitation_id") val pendingInvitationId: String? = null,
)

@Serializable
public data class ContactInvitation(
    @SerialName("invitation_id") val invitationId: String = "",
    val direction: String = "incoming",
    val status: String = "pending",
    @SerialName("peer_user_id") val peerUserId: String = "",
    @SerialName("peer_organization_id") val peerOrganizationId: String? = null,
    @SerialName("display_name") val displayName: String = "",
    @SerialName("avatar_url") val avatarUrl: String = "",
    @SerialName("created_at") val createdAt: String = "",
    @SerialName("expires_at") val expiresAt: String = "",
    @SerialName("resolved_at") val resolvedAt: String? = null,
    val note: String? = null,
    @SerialName("peer_organization_name") val peerOrganizationName: String? = null,
)

@Serializable
public data class ExternalContactListResponse(
    val items: List<ExternalContact> = emptyList(),
)

@Serializable
public data class ContactInvitationListResponse(
    val items: List<ContactInvitation> = emptyList(),
)

@Serializable
public data class ContactInvitationCreateResult(
    val invitation: ContactInvitation? = null,
    @SerialName("invitation_id") val invitationId: String? = null,
)
