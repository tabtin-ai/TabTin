import XCTest
@testable import Tabtin

final class OrganizationSettingsVisibilityTests: XCTestCase {
    func testCanManageIsOwnerOnly() {
        XCTAssertTrue(OrganizationRole.owner.canManage)
        XCTAssertFalse(OrganizationRole.admin.canManage)
        XCTAssertFalse(OrganizationRole.editor.canManage)
        XCTAssertFalse(OrganizationRole.viewer.canManage)
        XCTAssertFalse(OrganizationRole.unknown.canManage)
    }

    func testCanEditRemainsEditorPlus() {
        XCTAssertTrue(OrganizationRole.owner.canEdit)
        XCTAssertTrue(OrganizationRole.admin.canEdit)
        XCTAssertTrue(OrganizationRole.editor.canEdit)
        XCTAssertFalse(OrganizationRole.viewer.canEdit)
    }

    func testVisibilityMatrix() {
        for role in [OrganizationRole.owner, .admin, .editor, .viewer] {
            XCTAssertTrue(OrganizationSettingsAccessMatrix.canViewOrganizationSummary(role: role))
            XCTAssertTrue(OrganizationSettingsAccessMatrix.canOpenOrganizationSettings(role: role))
        }
        XCTAssertFalse(OrganizationSettingsAccessMatrix.canViewOrganizationSummary(role: .unknown))
    }

    func testManageMatrixMatchesElectronOwnerOnlyGate() {
        XCTAssertTrue(OrganizationSettingsAccessMatrix.canManageOrganization(role: .owner))
        XCTAssertFalse(OrganizationSettingsAccessMatrix.canManageOrganization(role: .admin))
        XCTAssertFalse(OrganizationSettingsAccessMatrix.canManageOrganization(role: .editor))
        XCTAssertFalse(OrganizationSettingsAccessMatrix.canManageOrganization(role: .viewer))
    }

    func testInviteMembersRequiresOwnerAndNonPersonalOrg() {
        XCTAssertTrue(OrganizationSettingsAccessMatrix.canInviteMembers(role: .owner, isPersonalOrganization: false))
        XCTAssertFalse(OrganizationSettingsAccessMatrix.canInviteMembers(role: .admin, isPersonalOrganization: false))
        XCTAssertFalse(OrganizationSettingsAccessMatrix.canInviteMembers(role: .owner, isPersonalOrganization: true))
    }
}
