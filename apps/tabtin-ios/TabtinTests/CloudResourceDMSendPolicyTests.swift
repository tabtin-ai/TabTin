import XCTest
@testable import Tabtin

final class CloudResourceDMSendPolicyTests: XCTestCase {
    func testResourceTargetsBuildDocumentAndTableCards() {
        let document = CloudResourceDMSendTarget(
            resourceType: .document,
            resourceId: "doc-1",
            title: "项目方案",
            organizationId: "org-1",
            spaceId: "space-1",
            currentUserRole: "viewer"
        ).outgoingCard
        let table = CloudResourceDMSendTarget(
            resourceType: .table,
            resourceId: "table-1",
            title: "任务清单",
            organizationId: "org-1",
            spaceId: "space-2",
            currentUserRole: "owner"
        ).outgoingCard

        XCTAssertEqual(document.kind, .document)
        XCTAssertEqual(document.resourceId, "doc-1")
        XCTAssertEqual(document.name, "项目方案")
        XCTAssertEqual(document.organizationId, "org-1")
        XCTAssertEqual(document.spaceId, "space-1")
        XCTAssertEqual(document.fallbackContent, "[文档] 项目方案")
        XCTAssertEqual(table.kind, .table)
        XCTAssertEqual(table.resourceId, "table-1")
        XCTAssertEqual(table.fallbackContent, "[表格] 任务清单")
    }

    func testUntitledResourceCardUsesResourceSpecificFallback() {
        let document = CloudResourceDMSendTarget(
            resourceType: .document,
            resourceId: "doc-1",
            title: "  ",
            organizationId: "org-1",
            spaceId: nil,
            currentUserRole: "viewer"
        ).outgoingCard
        let table = CloudResourceDMSendTarget(
            resourceType: .table,
            resourceId: "table-1",
            title: "\n",
            organizationId: "org-1",
            spaceId: nil,
            currentUserRole: "viewer"
        ).outgoingCard

        XCTAssertEqual(document.name, L10n.CloudDocs.untitled)
        XCTAssertEqual(table.name, L10n.TabData.untitledTable)
        XCTAssertEqual(table.fallbackContent, "[表格] \(L10n.TabData.untitledTable)")
    }

    func testOnlyOwnerAndAdminCanGrantViewer() {
        XCTAssertTrue(CloudResourceDMSendPolicy.canGrantViewer(currentUserRole: "owner"))
        XCTAssertTrue(CloudResourceDMSendPolicy.canGrantViewer(currentUserRole: " ADMIN "))
        XCTAssertFalse(CloudResourceDMSendPolicy.canGrantViewer(currentUserRole: "editor"))
        XCTAssertFalse(CloudResourceDMSendPolicy.canGrantViewer(currentUserRole: "viewer"))
        XCTAssertFalse(CloudResourceDMSendPolicy.canGrantViewer(currentUserRole: nil))
    }

    func testOwnerAndAnyExistingCollaboratorAlreadyHaveAccess() {
        let owner = CloudDocsResourceOwner(
            userId: "owner-user",
            nickname: "所有者",
            avatar: nil,
            email: ""
        )
        let collaborators = ["viewer", "editor", "admin"].enumerated().map { index, role in
            CloudDocsCollaborator(
                userId: "member-\(index)",
                nickname: role,
                avatar: nil,
                email: "",
                permission: role
            )
        }
        let snapshot = CloudDocsCollaboratorList(
            owner: owner,
            collaborators: collaborators
        )

        XCTAssertTrue(
            CloudResourceDMSendPolicy.recipientHasAccess("owner-user", snapshot: snapshot)
        )
        for collaborator in collaborators {
            XCTAssertTrue(
                CloudResourceDMSendPolicy.recipientHasAccess(
                    collaborator.userId,
                    snapshot: snapshot
                ),
                "已有 \(collaborator.permission) 权限时不能再邀请为 viewer"
            )
        }
        XCTAssertFalse(
            CloudResourceDMSendPolicy.recipientHasAccess("new-user", snapshot: snapshot)
        )
    }

    func testRetryReusesClientRequestId() {
        XCTAssertEqual(
            CloudResourceDMSendPolicy.clientRequestId(
                reusing: "request-1",
                generate: { "request-2" }
            ),
            "request-1"
        )
        XCTAssertEqual(
            CloudResourceDMSendPolicy.clientRequestId(
                reusing: nil,
                generate: { "request-2" }
            ),
            "request-2"
        )
    }

    func testRecipientReselectionRetainsRequestIdOnlyForSameMember() {
        XCTAssertEqual(
            CloudResourceDMSendPolicy.retainedClientRequestId(
                "request-1",
                previousRecipientUserId: "user-1",
                selectedRecipientUserId: "user-1"
            ),
            "request-1"
        )
        XCTAssertNil(
            CloudResourceDMSendPolicy.retainedClientRequestId(
                "request-1",
                previousRecipientUserId: "user-1",
                selectedRecipientUserId: "user-2"
            )
        )
    }

    func testAcceptedSendDismissesSheet() {
        XCTAssertTrue(CloudResourceDMSendPolicy.shouldDismiss(after: .enqueued))
        XCTAssertTrue(CloudResourceDMSendPolicy.shouldDismiss(after: .succeeded))
        XCTAssertFalse(CloudResourceDMSendPolicy.shouldDismiss(after: .failedPending))
        XCTAssertFalse(CloudResourceDMSendPolicy.shouldDismiss(after: .discardedAfterClear))
        XCTAssertFalse(CloudResourceDMSendPolicy.shouldDismiss(after: .rejectedReadOnly))
        XCTAssertNil(CloudResourceDMSendPolicy.errorMessage(for: .enqueued))
        XCTAssertNotNil(CloudResourceDMSendPolicy.errorMessage(for: .failedPending))
    }
}
