package com.tabtin.mobile.data.im

import javax.inject.Inject
import javax.inject.Singleton

/** 外部联系人领域服务；仅封装控制面契约，不把联系人状态塞进会话 Store。 */
@Singleton
public class ExternalContactRepository @Inject constructor(
    private val domainApi: ImApi,
) {
    public suspend fun list(organizationId: String): List<ExternalContact> =
        domainApi.listExternalContacts(organizationId).unwrap().items

    public suspend fun discover(organizationId: String, phone: String): ExternalContactCandidate =
        domainApi.discoverExternalContact(
            DiscoverExternalContactBody(organizationId = organizationId, phone = phone),
        ).unwrap()

    public suspend fun invite(
        organizationId: String,
        targetUserId: String,
        note: String? = null,
    ): ContactInvitationCreateResult = domainApi.issueContactInvitation(
        IssueContactInvitationBody(
            organizationId = organizationId,
            targetUserId = targetUserId,
            note = note,
        ),
    ).unwrap()

    public suspend fun pendingInvitations(organizationId: String): List<ContactInvitation> =
        listInvitations(organizationId = organizationId, direction = "incoming")

    public suspend fun listInvitations(
        organizationId: String,
        direction: String,
        status: String = "pending",
    ): List<ContactInvitation> =
        domainApi.listContactInvitations(
            organizationId = organizationId,
            direction = direction,
            status = status,
        ).unwrap().items

    public suspend fun accept(organizationId: String, invitationId: String): ExternalContact =
        domainApi.acceptExternalContact(
            AcceptExternalContactBody(organizationId = organizationId, invitationId = invitationId),
        ).unwrap()

    public suspend fun resolveInvitation(
        organizationId: String,
        invitationId: String,
        action: String,
    ) {
        domainApi.updateContactInvitation(
            invitationId,
            UpdateContactInvitationBody(organizationId = organizationId, action = action),
        ).requireSuccess()
    }

    public suspend fun updateContact(
        organizationId: String,
        contactId: String,
        action: String,
    ) {
        domainApi.updateExternalContact(
            contactId,
            UpdateExternalContactBody(organizationId = organizationId, action = action),
        ).requireSuccess()
    }
}
