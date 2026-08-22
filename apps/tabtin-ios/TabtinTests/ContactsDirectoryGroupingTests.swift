import XCTest
@testable import Tabtin

final class ContactsDirectoryGroupingTests: XCTestCase {
    func testSeparatesFriendsAndBlockedContacts() {
        let groups = groupExternalContacts([
            contact(id: "friend", relationship: "friend"),
            contact(id: "blocked", relationship: "blocked"),
            contact(id: "removed", relationship: "removed"),
        ])

        XCTAssertEqual(groups.friends.map(\.contactId), ["friend"])
        XCTAssertEqual(groups.blocked.map(\.contactId), ["blocked"])
    }

    func testSwitchingOrganizationClearsExternalDirectoryState() {
        var state = ContactsDirectoryState()
        state.activate(organizationId: "org-a")
        state.contacts = [contact(id: "contact-a", relationship: "friend", organizationId: "org-a")]
        state.incomingInvitations = [invitation(id: "incoming-a", direction: "incoming")]
        state.outgoingInvitations = [invitation(id: "outgoing-a", direction: "outgoing")]
        state.contactsLoadError = "contacts failed"
        state.incomingInvitationsLoadError = "incoming failed"
        state.outgoingInvitationsLoadError = "outgoing failed"

        state.activate(organizationId: "org-b")

        XCTAssertEqual(state.organizationId, "org-b")
        XCTAssertTrue(state.contacts.isEmpty)
        XCTAssertTrue(state.incomingInvitations.isEmpty)
        XCTAssertTrue(state.outgoingInvitations.isEmpty)
        XCTAssertNil(state.contactsLoadError)
        XCTAssertNil(state.incomingInvitationsLoadError)
        XCTAssertNil(state.outgoingInvitationsLoadError)
    }

    func testExternalDirectoryActionsFailClosedForRowsFromPreviousOrganization() {
        var state = ContactsDirectoryState()
        let oldContact = contact(id: "contact-a", relationship: "friend", organizationId: "org-a")
        let oldIncoming = invitation(id: "incoming-a", direction: "incoming")
        let oldOutgoing = invitation(id: "outgoing-a", direction: "outgoing")
        state.activate(organizationId: "org-a")
        state.contacts = [oldContact]
        state.incomingInvitations = [oldIncoming]
        state.outgoingInvitations = [oldOutgoing]

        XCTAssertTrue(state.owns(oldContact, selectedOrganizationId: "org-a"))
        XCTAssertTrue(state.owns(oldIncoming, direction: .incoming, selectedOrganizationId: "org-a"))
        XCTAssertTrue(state.owns(oldOutgoing, direction: .outgoing, selectedOrganizationId: "org-a"))

        state.activate(organizationId: "org-b")

        XCTAssertFalse(state.owns(oldContact, selectedOrganizationId: "org-b"))
        XCTAssertFalse(state.owns(oldIncoming, direction: .incoming, selectedOrganizationId: "org-b"))
        XCTAssertFalse(state.owns(oldOutgoing, direction: .outgoing, selectedOrganizationId: "org-b"))
    }

    func testReloadGenerationRejectsResponsesFromAnOlderOrganizationScope() throws {
        var state = ContactsDirectoryState()
        state.activate(organizationId: "org-a")
        let oldGeneration = try XCTUnwrap(state.beginLoad(for: "org-a"))

        state.activate(organizationId: "org-b")
        let currentGeneration = try XCTUnwrap(state.beginLoad(for: "org-b"))

        XCTAssertFalse(state.isActive(for: "org-a", generation: oldGeneration))
        XCTAssertFalse(state.isActive(for: "org-b", generation: oldGeneration))
        XCTAssertTrue(state.isActive(for: "org-b", generation: currentGeneration))
    }

    func testAddMemberPermissionFailsClosed() {
        XCTAssertFalse(canShowOrganizationMemberAddAction(canManage: false, isPersonalOrganization: false))
        XCTAssertFalse(canShowOrganizationMemberAddAction(canManage: true, isPersonalOrganization: nil))
        XCTAssertFalse(canShowOrganizationMemberAddAction(canManage: true, isPersonalOrganization: true))
        XCTAssertTrue(canShowOrganizationMemberAddAction(canManage: true, isPersonalOrganization: false))
    }

    private func contact(
        id: String,
        relationship: String,
        organizationId: String = "org"
    ) -> ExternalContact {
        ExternalContact(
            contactId: id,
            organizationId: organizationId,
            peerOrganizationId: "peer-org",
            peerUserId: "peer-\(id)",
            displayName: id,
            avatarURL: "",
            relationship: relationship,
            suspendedReason: nil,
            isRestorable: false,
            updatedAt: "",
            peerOrganizationName: "Peer"
        )
    }

    private func invitation(id: String, direction: String) -> ExternalContactInvitation {
        ExternalContactInvitation(
            invitationId: id,
            direction: direction,
            status: "pending",
            peerUserId: "peer-\(id)",
            peerOrganizationId: "peer-org",
            displayName: id,
            avatarURL: "",
            createdAt: "",
            expiresAt: "",
            resolvedAt: nil,
            note: nil,
            peerOrganizationName: "Peer"
        )
    }
}
