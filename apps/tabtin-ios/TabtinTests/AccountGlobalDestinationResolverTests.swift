import XCTest
@testable import Tabtin

final class AccountGlobalDestinationResolverTests: XCTestCase {
    func testLegacyRouteMigrationTable() {
        XCTAssertEqual(
            AccountGlobalDestinationResolver.resolve(legacyRoute: .legacyProfile),
            .me
        )
        XCTAssertEqual(
            AccountGlobalDestinationResolver.resolve(legacyRoute: .profileSettings),
            .settings
        )
        XCTAssertEqual(
            AccountGlobalDestinationResolver.resolve(legacyRoute: .settings),
            .settings
        )
        XCTAssertEqual(
            AccountGlobalDestinationResolver.resolve(legacyRoute: .organizationInvitation),
            .organizationInvitation
        )
        XCTAssertEqual(
            AccountGlobalDestinationResolver.resolve(legacyRoute: .projectInvitation),
            .projectInvitationPassthrough
        )
    }

    func testNotificationTargetMigrationTable() {
        XCTAssertEqual(
            AccountGlobalDestinationResolver.resolve(notificationTarget: .invitation),
            .organizationInvitation
        )
        XCTAssertEqual(
            AccountGlobalDestinationResolver.resolve(notificationTarget: .profileSettings),
            .settings
        )
        XCTAssertNil(
            AccountGlobalDestinationResolver.resolve(
                notificationTarget: .chatSession(
                    id: "s1",
                    messageId: nil,
                    organizationId: nil,
                    workspaceId: nil,
                    projectId: nil
                )
            )
        )
    }

    func testResolverMatchesLegacyProfileMigrationGlobals() {
        for route in AccountGlobalDestinationResolver.LegacyRoute.allCases {
            let expected = SettingsCapabilityRegistry.legacyProfileMigration
                .first { $0.value.globalDestination != nil && legacyRouteMatches(route, $0.key) }?
                .value.globalDestination
            if route == .projectInvitation {
                XCTAssertEqual(
                    AccountGlobalDestinationResolver.resolve(legacyRoute: route),
                    .projectInvitationPassthrough
                )
                continue
            }
            if let expected {
                XCTAssertEqual(AccountGlobalDestinationResolver.resolve(legacyRoute: route), expected)
            }
        }
    }

    private func legacyRouteMatches(
        _ route: AccountGlobalDestinationResolver.LegacyRoute,
        _ capability: LegacyProfileCapability
    ) -> Bool {
        switch (route, capability) {
        case (.legacyProfile, .profileHeader): return true
        case (.profileSettings, .notificationPermission): return true
        case (.settings, .appearance): return true
        case (.organizationInvitation, .organizationInvitationsInbox): return true
        default: return false
        }
    }
}

@MainActor
final class AccountDrawerCoordinatorTests: XCTestCase {
    func testRegularDrawerWaitsForDismissalBeforePresentingGlobalSheet() {
        let coordinator = makeCoordinator()
        coordinator.setPresentationMode(.regular)
        coordinator.openDrawer(animated: false)
        coordinator.regularDrawerDidPresent()

        coordinator.route(to: .settings)

        XCTAssertFalse(coordinator.isOpen)
        XCTAssertNil(coordinator.presentedGlobalSheet)
        XCTAssertEqual(coordinator.pendingGlobalSheetAfterDrawerDismissal, .settings)

        coordinator.route(to: .me)

        XCTAssertNil(coordinator.presentedGlobalSheet)
        XCTAssertEqual(coordinator.pendingGlobalSheetAfterDrawerDismissal, .me)

        coordinator.completeDrawerDismissal()

        XCTAssertFalse(coordinator.isRegularDrawerPresented)
        XCTAssertNil(coordinator.pendingGlobalSheetAfterDrawerDismissal)
        XCTAssertEqual(coordinator.presentedGlobalSheet, .me)
    }

    func testRegisteredLogoutHookClearsAccountPresentationState() throws {
        var registeredHook: (@MainActor () -> Void)?
        let coordinator = AccountDrawerCoordinator { hook in
            registeredHook = hook
        }
        coordinator.presentGlobalSheet(.me)
        coordinator.openDrawer(focusOrganizationPicker: true, animated: false)

        let logout = try XCTUnwrap(registeredHook)
        logout()

        XCTAssertFalse(coordinator.isOpen)
        XCTAssertFalse(coordinator.showsOrganizationPicker)
        XCTAssertNil(coordinator.switchingOrganizationId)
        XCTAssertNil(coordinator.organizationSwitchError)
        XCTAssertNil(coordinator.pendingGlobalDestination)
        XCTAssertNil(coordinator.pendingGlobalSheetAfterDrawerDismissal)
        XCTAssertNil(coordinator.presentedGlobalSheet)

        coordinator.setPresentationMode(.regular)
        coordinator.openDrawer(animated: false)
        coordinator.regularDrawerDidPresent()
        coordinator.route(to: .settings)
        XCTAssertEqual(coordinator.pendingGlobalSheetAfterDrawerDismissal, .settings)

        logout()

        XCTAssertFalse(coordinator.isRegularDrawerPresented)
        XCTAssertNil(coordinator.pendingGlobalSheetAfterDrawerDismissal)
        XCTAssertNil(coordinator.presentedGlobalSheet)
    }

    private func makeCoordinator() -> AccountDrawerCoordinator {
        AccountDrawerCoordinator(registerLogoutHook: { _ in })
    }
}
