import XCTest
@testable import Tabtin

final class SettingsCapabilityRegistryTests: XCTestCase {
    func testAppearanceColorSchemeChoicesExposeEveryDistinctPreview() {
        let choices = SettingsAppearancePresentation.colorSchemeChoices

        XCTAssertEqual(choices.map(\.id), ColorSchemeId.allCases)
        XCTAssertEqual(Set(choices.map(\.lightAccent)).count, ColorSchemeId.allCases.count)
        XCTAssertTrue(choices.allSatisfy { $0.lightAccent != 0 && $0.darkAccent != 0 })
    }

    func testColorSchemeRootRefreshWaitsForGlobalPresentationDismissal() {
        XCTAssertEqual(
            ColorSchemeRootRefreshPolicy.schemeForRoot(
                current: .blue,
                selected: .rose,
                hasActiveGlobalPresentation: true
            ),
            .blue
        )
        XCTAssertEqual(
            ColorSchemeRootRefreshPolicy.schemeForRoot(
                current: .blue,
                selected: .rose,
                hasActiveGlobalPresentation: false
            ),
            .rose
        )
        let replacement = ColorSchemeRootRefreshPolicy.resolveDismissal(
            current: .blue,
            selected: .rose,
            hasReplacementPresentation: true
        )
        XCTAssertEqual(replacement.renderedScheme, .blue)
        XCTAssertTrue(replacement.keepsPresentationActive)

        let completed = ColorSchemeRootRefreshPolicy.resolveDismissal(
            current: .blue,
            selected: .rose,
            hasReplacementPresentation: false
        )
        XCTAssertEqual(completed.renderedScheme, .rose)
        XCTAssertFalse(completed.keepsPresentationActive)
    }

    func testColorSchemeRootRefreshWaitsForPushedDestinationToPop() {
        XCTAssertEqual(
            ColorSchemeRootRefreshPolicy.schemeForRoot(
                current: .blue,
                selected: .rose,
                hasActiveGlobalPresentation: false,
                hasPushedDestination: true
            ),
            .blue
        )
        XCTAssertEqual(
            ColorSchemeRootRefreshPolicy.schemeForRoot(
                current: .blue,
                selected: .rose,
                hasActiveGlobalPresentation: false,
                hasPushedDestination: false
            ),
            .rose
        )
    }

    func testEveryLegacyProfileItemHasMigrationTarget() {
        for legacy in LegacyProfileCapability.allCases {
            XCTAssertNotNil(
                SettingsCapabilityRegistry.legacyProfileMigration[legacy],
                "missing migration for \(legacy.rawValue)"
            )
        }
    }

    func testLegacyMigrationHasDestinationOrExcludedReason() {
        for (legacy, migration) in SettingsCapabilityRegistry.legacyProfileMigration {
            if migration.isExcludedFromSettingsHome {
                XCTAssertNotNil(migration.excludedReason, "\(legacy.rawValue) excluded without reason")
            } else if migration.destination == nil {
                XCTAssertNotNil(
                    migration.globalDestination,
                    "\(legacy.rawValue) account-level route without global destination"
                )
            } else {
                XCTAssertNotNil(migration.destination, "\(legacy.rawValue) visible without destination")
                XCTAssertNotNil(migration.globalDestination, "\(legacy.rawValue) visible without global route")
            }
        }
    }

    func testIOSVisibleSettingsHomeCapabilitiesMatchPhase0Contract() {
        let ids = Set(SettingsCapabilityRegistry.visibleSettingsHome(on: .ios).map(\.id))
        XCTAssertTrue(ids.contains("settings.personal.accountInfo"))
        XCTAssertTrue(ids.contains("settings.personal.appearance.ios"))
        XCTAssertTrue(ids.contains("settings.personal.systemPermissions"))
        XCTAssertTrue(ids.contains("settings.personal.voiceHabits"))
        XCTAssertTrue(ids.contains("settings.personal.privacyAndData"))
        XCTAssertTrue(ids.contains("settings.organization.summary"))
        XCTAssertTrue(ids.contains("settings.organization.settingsEntry"))
        XCTAssertTrue(ids.contains("settings.device.info"))
        XCTAssertTrue(ids.contains("settings.device.diagnostics"))
        XCTAssertTrue(ids.contains("settings.device.about"))
        XCTAssertTrue(ids.contains("settings.device.debugEnvironment"))
        XCTAssertTrue(ids.contains("settings.device.logout"))
        XCTAssertFalse(ids.contains("settings.personal.appearance.android"))
        XCTAssertFalse(ids.contains(where: { $0.hasPrefix("me.") }))
    }

    func testIOSVisibleMeCapabilitiesAreSeparateFromSettingsHome() {
        let meIds = Set(SettingsCapabilityRegistry.visibleMe(on: .ios).map(\.id))
        let settingsIds = Set(SettingsCapabilityRegistry.visibleSettingsHome(on: .ios).map(\.id))
        XCTAssertTrue(meIds.contains("me.profileHeader"))
        XCTAssertTrue(meIds.contains("me.organizationIdentityCard"))
        XCTAssertTrue(meIds.allSatisfy { $0.hasPrefix("me.") })
        XCTAssertTrue(settingsIds.allSatisfy { !$0.hasPrefix("me.") })
    }

    func testAndroidVisibleSettingsHomeExcludesVoiceHabits() {
        let ids = Set(SettingsCapabilityRegistry.visibleSettingsHome(on: .android).map(\.id))
        XCTAssertTrue(ids.contains("settings.personal.appearance.android"))
        XCTAssertFalse(ids.contains("settings.personal.voiceHabits"))
        XCTAssertFalse(ids.contains(where: { $0.hasPrefix("me.") }))
    }

    func testEveryVisibleCapabilityHasImplementationEvidence() {
        for capability in SettingsCapabilityRegistry.visibleHomeCapabilities {
            XCTAssertFalse(
                capability.implementationEvidence.isEmpty,
                "\(capability.id) missing implementationEvidence"
            )
        }
    }

    func testEveryExcludedCapabilityHasReason() {
        for capability in SettingsCapabilityRegistry.excludedCapabilities {
            guard case let .excluded(reason) = capability.visibility else {
                return XCTFail("\(capability.id) not marked excluded")
            }
            XCTAssertFalse(reason.isEmpty, "\(capability.id) empty exclusion reason")
        }
    }

    func testLegacyProfileHeaderRoutesToMe() {
        let migration = SettingsCapabilityRegistry.legacyProfileMigration[.profileHeader]
        XCTAssertEqual(migration?.globalDestination, .me)
        XCTAssertEqual(migration?.destination, .meProfileHeader)
    }

    func testLegacyOrganizationInvitationRoutesToAccountInvitationDestination() {
        let migration = SettingsCapabilityRegistry.legacyProfileMigration[.organizationInvitationsInbox]
        XCTAssertEqual(migration?.globalDestination, .organizationInvitation)
        XCTAssertNil(migration?.destination)
    }

    func testLegacyLanguageMigratesToAppearance() {
        let migration = SettingsCapabilityRegistry.legacyProfileMigration[.language]
        XCTAssertEqual(migration?.destination, .settingsPersonalAppearance)
        XCTAssertEqual(migration?.globalDestination, .settings)
        XCTAssertNil(migration?.excludedReason)
    }

    func testLegacyAccountStatsMigratesToAccountInfo() {
        let migration = SettingsCapabilityRegistry.legacyProfileMigration[.accountStats]
        XCTAssertEqual(migration?.destination, .settingsPersonalAccountInfo)
        XCTAssertEqual(migration?.globalDestination, .settings)
        XCTAssertNil(migration?.excludedReason)
    }

    func testExcludedRegistryDoesNotContainLanguageOrAccountStats() {
        let excludedIds = Set(SettingsCapabilityRegistry.excludedCapabilities.map(\.id))
        XCTAssertFalse(excludedIds.contains("excluded.languagePicker"))
        XCTAssertFalse(excludedIds.contains("excluded.accountStats"))
    }

    func testAppearanceCapabilityEvidenceIncludesLanguageManager() {
        let iosAppearance = SettingsCapabilityRegistry.capability(id: "settings.personal.appearance.ios")
        XCTAssertTrue(iosAppearance?.implementationEvidence.contains("LanguageManager.shared") == true)
        let androidAppearance = SettingsCapabilityRegistry.capability(id: "settings.personal.appearance.android")
        XCTAssertTrue(androidAppearance?.implementationEvidence.contains("AppLanguage preference") == true)
    }

    func testAccountInfoCapabilityEvidenceIncludesAccountStats() {
        let accountInfo = SettingsCapabilityRegistry.capability(id: "settings.personal.accountInfo")
        XCTAssertTrue(accountInfo?.implementationEvidence.contains("ProfileScreen.swift:accountStatsSection") == true)
    }

    func testLegacyOrganizationSwitcherRoutesToAccountDrawer() {
        let migration = SettingsCapabilityRegistry.legacyProfileMigration[.organizationSwitcher]
        XCTAssertEqual(migration?.globalDestination, .accountDrawerOrganizationSwitcher)
        XCTAssertNil(migration?.destination)
    }

    func testVisibleHomeCapabilitiesExcludeMeOwnership() {
        XCTAssertTrue(SettingsCapabilityRegistry.visibleHomeCapabilities.allSatisfy { $0.ownership != .me })
    }

    func testOrganizationCreationAndWalletHaveDeliberateNonHomeEntries() {
        XCTAssertEqual(
            SettingsCapabilityRegistry.legacyProfileMigration[.createOrganization]?.excludedReason,
            "excluded.createOrganization"
        )
        XCTAssertEqual(
            SettingsCapabilityRegistry.legacyProfileMigration[.walletEntry]?.excludedReason,
            "excluded.walletEntry"
        )
        XCTAssertEqual(
            SettingsCapabilityRegistry.capability(id: "excluded.createOrganization")?.visibility,
            .excluded(reason: "新建 Organization 位于账户侧栏，不在设置首页。")
        )
        XCTAssertEqual(
            SettingsCapabilityRegistry.capability(id: "excluded.walletEntry")?.visibility,
            .excluded(reason: "钱包位于组织设置，不在设置首页。")
        )
    }
}
