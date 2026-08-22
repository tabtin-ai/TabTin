import Foundation

private func l(_ key: String, table: String) -> String {
    NSLocalizedString(key, tableName: table, bundle: LanguageManager.shared.bundle, comment: "")
}

private func l(_ key: String, table: String, _ args: CVarArg...) -> String {
    String(format: NSLocalizedString(key, tableName: table, bundle: LanguageManager.shared.bundle, comment: ""), arguments: args)
}

enum L10n {
    enum CapabilityMarket {
        static var connectorSources: String { l("capabilityMarket.connector.sources", table: "CapabilityMarket") }
        static var sourceRecommended: String { l("capabilityMarket.connector.source.recommended", table: "CapabilityMarket") }
        static var sourceOrganization: String { l("capabilityMarket.connector.source.organization", table: "CapabilityMarket") }
        static var sourceMine: String { l("capabilityMarket.connector.source.mine", table: "CapabilityMarket") }
        static var connectorSearch: String { l("capabilityMarket.connector.search", table: "CapabilityMarket") }
        static var connectorLoading: String { l("capabilityMarket.connector.loading", table: "CapabilityMarket") }
        static var skillLoadFailed: String { l("capabilityMarket.skill.loadFailed", table: "CapabilityMarket") }
        static var connectorLoadFailed: String { l("capabilityMarket.connector.loadFailed", table: "CapabilityMarket") }
        static var noMatches: String { l("capabilityMarket.connector.noMatches", table: "CapabilityMarket") }
        static var tryAnotherSearch: String { l("capabilityMarket.connector.tryAnotherSearch", table: "CapabilityMarket") }
        static var recommendedEmpty: String { l("capabilityMarket.connector.recommended.empty", table: "CapabilityMarket") }
        static var recommendedEmptyDescription: String { l("capabilityMarket.connector.recommended.emptyDescription", table: "CapabilityMarket") }
        static var organizationEmpty: String { l("capabilityMarket.connector.organization.empty", table: "CapabilityMarket") }
        static var organizationEmptyDescription: String { l("capabilityMarket.connector.organization.emptyDescription", table: "CapabilityMarket") }
        static var mineEmpty: String { l("capabilityMarket.connector.mine.empty", table: "CapabilityMarket") }
        static var mineEmptyDescription: String { l("capabilityMarket.connector.mine.emptyDescription", table: "CapabilityMarket") }
        static var minePartialFailure: String { l("capabilityMarket.connector.mine.partialFailure", table: "CapabilityMarket") }
        static var mineAllDevicesFailed: String { l("capabilityMarket.connector.mine.allDevicesFailed", table: "CapabilityMarket") }
        static func recommendedDescription(_ key: String) -> String {
            l("capabilityMarket.connector.recommended.\(key)", table: "CapabilityMarket")
        }
    }

    enum Common {
        static var appName: String { l("common.appName", table: "Common") }
        static var cancel: String { l("common.cancel", table: "Common") }
        static var close: String { l("common.close", table: "Common") }
        static var confirm: String { l("common.confirm", table: "Common") }
        static var create: String { l("common.create", table: "Common") }
        static var retry: String { l("common.retry", table: "Common") }
        static var save: String { l("common.save", table: "Common") }
        static var settings: String { l("common.settings", table: "Common") }
        static var tabRecent: String { l("common.tab.recent", table: "Common") }
        static var tabHome: String { l("common.tab.home", table: "Common") }
        static var tabAutomation: String { l("common.tab.automation", table: "Common") }
        static var tabAgent: String { l("common.tab.agent", table: "Common") }
        static var tabMessages: String { l("common.tab.messages", table: "Common") }
        static var tabAgents: String { l("common.tab.agents", table: "Common") }
        static var tabProjects: String { l("common.tab.projects", table: "Common") }
        static var tabCloudDocs: String { l("common.tab.cloudDocs", table: "Common") }
        static var tabSpace: String { l("common.tab.space", table: "Common") }
        static var tabMemo: String { l("common.tab.memo", table: "Common") }
        static var tabCloud: String { l("common.tab.cloud", table: "Common") }
        static var composeNew: String { l("common.compose.new", table: "Common") }
        static var userMenu: String { l("common.userMenu", table: "Common") }
        static var loading: String { l("common.loading", table: "Common") }
        static var more: String { l("common.more", table: "Common") }
        static var justNow: String { l("common.justNow", table: "Common") }
        static var today: String { l("common.today", table: "Common") }
        static var yesterday: String { l("common.yesterday", table: "Common") }
        static var resourceLinkNoticeTitle: String { l("common.resourceLink.noticeTitle", table: "Common") }
        static var resourceLinkMissingContext: String { l("common.resourceLink.missingContext", table: "Common") }
        static var resourceLinkOrganizationUnavailable: String { l("common.resourceLink.organizationUnavailable", table: "Common") }
        static var resourceLinkOrganizationLoadFailed: String { l("common.resourceLink.organizationLoadFailed", table: "Common") }
        static var resourceLinkWrongCurrentOrganization: String { l("common.resourceLink.wrongCurrentOrganization", table: "Common") }

        static func minutesAgo(_ n: Int) -> String { l("common.minutesAgo", table: "Common", n) }
        static func hoursAgo(_ n: Int) -> String { l("common.hoursAgo", table: "Common", n) }
        static func daysAgo(_ n: Int) -> String { l("common.daysAgo", table: "Common", n) }
    }

    enum ErrorRecovery {
        static var switchModel: String { l("errorRecovery.switchModel", table: "Common") }
        static var topUp: String { l("errorRecovery.topUp", table: "Common") }
        static var relogin: String { l("errorRecovery.relogin", table: "Common") }
        static var newTask: String { l("errorRecovery.newTask", table: "Common") }
        static var selectModel: String { l("errorRecovery.selectModel", table: "Common") }
        static var noModels: String { l("errorRecovery.noModels", table: "Common") }
        static var retrySourceMissing: String { l("errorRecovery.retrySourceMissing", table: "Common") }
        static var retryFailed: String { l("errorRecovery.retryFailed", table: "Common") }
        static var reloginConfirmTitle: String { l("errorRecovery.reloginConfirmTitle", table: "Common") }
        static var reloginConfirmMessage: String { l("errorRecovery.reloginConfirmMessage", table: "Common") }
        static var freshConversationCreated: String { l("errorRecovery.freshConversationCreated", table: "Common") }
        static var freshConversationFailed: String { l("errorRecovery.freshConversationFailed", table: "Common") }
        /// WKWebView 宿主的加载失败标题（见 `WebHostLoadErrorView`）。
        static var webHostLoadFailed: String { l("errorRecovery.webHostLoadFailed", table: "Common") }
        /// Web 内容进程被系统回收后的降级文案（见 `WebContentProcessGuard`）。
        static var webContentProcessTerminated: String {
            l("errorRecovery.webContentProcessTerminated", table: "Common")
        }

        static func modelSwitched(_ name: String) -> String {
            l("errorRecovery.modelSwitched.named", table: "Common", name)
        }
    }

    enum Camera {
        static var permissionTitle: String { l("camera.permission.title", table: "Common") }
        static var permissionMessage: String { l("camera.permission.message", table: "Common") }
        static var restrictedMessage: String { l("camera.restricted.message", table: "Common") }
        static var openSettings: String { l("camera.openSettings", table: "Common") }
        static var unavailableTitle: String { l("camera.unavailable.title", table: "Common") }
        static var unavailableMessage: String { l("camera.unavailable.message", table: "Common") }
    }

    enum Auth {
        static var slogan: String { l("auth.slogan", table: "Auth") }
        static var heroTitle: String { l("auth.hero.title", table: "Auth") }
        static var heroSubtitle: String { l("auth.hero.subtitle", table: "Auth") }
        static var title: String { l("auth.title", table: "Auth") }
        static var switchToEnglish: String { l("auth.language.switchToEnglish", table: "Auth") }
        static var switchToChinese: String { l("auth.language.switchToChinese", table: "Auth") }
        static var phone: String { l("auth.phone", table: "Auth") }
        static var phonePlaceholder: String { l("auth.phonePlaceholder", table: "Auth") }
        static var emailOrPhone: String { l("auth.emailOrPhone", table: "Auth") }
        static var emailOrPhonePlaceholder: String { l("auth.emailOrPhonePlaceholder", table: "Auth") }
        static var verificationCode: String { l("auth.verificationCode", table: "Auth") }
        static var codePlaceholder: String { l("auth.codePlaceholder", table: "Auth") }
        static var password: String { l("auth.password", table: "Auth") }
        static var passwordPlaceholder: String { l("auth.passwordPlaceholder", table: "Auth") }
        static var showPassword: String { l("auth.showPassword", table: "Auth") }
        static var hidePassword: String { l("auth.hidePassword", table: "Auth") }
        static var login: String { l("auth.login", table: "Auth") }
        static var loginFailed: String { l("auth.loginFailed", table: "Auth") }
        static var invalidPassword: String { l("auth.error.invalidPassword", table: "Auth") }
        static var invalidVerificationCode: String { l("auth.error.invalidVerificationCode", table: "Auth") }
        static var sendCodeFailed: String { l("auth.error.sendCode", table: "Auth") }
        static var networkError: String { l("auth.error.network", table: "Auth") }
        static var loginError: String { l("auth.error.login", table: "Auth") }
        static var loginWithPassword: String { l("auth.loginWithPassword", table: "Auth") }
        static var loginWithCode: String { l("auth.loginWithCode", table: "Auth") }
        static var getCode: String { l("auth.getCode", table: "Auth") }
        static func codeResend(_ seconds: Int) -> String { l("auth.codeResend", table: "Auth", seconds) }
        static var privacyAgreementPrefix: String { l("auth.privacyAgreementPrefix", table: "Auth") }
        static var privacyPolicy: String { l("auth.privacyPolicy", table: "Auth") }
        static var privacyCheckboxLabel: String { l("auth.privacyCheckboxLabel", table: "Auth") }
        static var privacyConsentTitle: String { l("auth.privacyConsentTitle", table: "Auth") }
        static var privacyConsentMessage: String { l("auth.privacyConsentMessage", table: "Auth") }
        static var privacyConsentAgree: String { l("auth.privacyConsentAgree", table: "Auth") }
        static var privacyConsentDisagree: String { l("auth.privacyConsentDisagree", table: "Auth") }
        static var inviteCodeTitle: String { l("auth.inviteCodeTitle", table: "Auth") }
        static var inviteCodeDescription: String { l("auth.inviteCodeDescription", table: "Auth") }
        static var inviteCodePlaceholder: String { l("auth.inviteCodePlaceholder", table: "Auth") }
        static var inviteCodeContinue: String { l("auth.inviteCodeContinue", table: "Auth") }
        static var inviteCodeChangeAccount: String { l("auth.inviteCodeChangeAccount", table: "Auth") }
        static var inviteCodeRequired: String { l("auth.inviteCodeRequired", table: "Auth") }
        static var inviteCodeRateLimited: String { l("auth.inviteCodeRateLimited", table: "Auth") }
    }

    enum Privacy {
        static var settingsTitle: String { l("privacy.settingsTitle", table: "Privacy") }
        static var aiConsentTitle: String { l("privacy.aiConsentTitle", table: "Privacy") }
        static var aiConsentSubtitle: String { l("privacy.aiConsentSubtitle", table: "Privacy") }
        static var aiDataSharedTitle: String { l("privacy.aiDataSharedTitle", table: "Privacy") }
        static var aiDataChatMessages: String { l("privacy.aiDataChatMessages", table: "Privacy") }
        static var aiDataAttachments: String { l("privacy.aiDataAttachments", table: "Privacy") }
        static var aiDataContextRefs: String { l("privacy.aiDataContextRefs", table: "Privacy") }
        static var aiDataVoiceTranscripts: String { l("privacy.aiDataVoiceTranscripts", table: "Privacy") }
        static var aiVoiceConsentHoldAgain: String { l("privacy.aiVoiceConsentHoldAgain", table: "Privacy") }
        static var aiDataProfileBasic: String { l("privacy.aiDataProfileBasic", table: "Privacy") }
        static var aiRecipientsTitle: String { l("privacy.aiRecipientsTitle", table: "Privacy") }
        static var aiRecipientTabTin: String { l("privacy.aiRecipientTabTin", table: "Privacy") }
        static func aiRecipientProvider(_ provider: String, model: String) -> String {
            l("privacy.aiRecipientProvider", table: "Privacy", provider, model)
        }
        static var aiRecipientProviders: String { l("privacy.aiRecipientProviders", table: "Privacy") }
        static var aiPurposeNote: String { l("privacy.aiPurposeNote", table: "Privacy") }
        static var viewPrivacyPolicy: String { l("privacy.viewPrivacyPolicy", table: "Privacy") }
        static var aiConsentAgree: String { l("privacy.aiConsentAgree", table: "Privacy") }
        static var aiConsentDecline: String { l("privacy.aiConsentDecline", table: "Privacy") }
        static var aiSharingStatus: String { l("privacy.aiSharingStatus", table: "Privacy") }
        static var aiSharingEnabled: String { l("privacy.aiSharingEnabled", table: "Privacy") }
        static var aiSharingDisabled: String { l("privacy.aiSharingDisabled", table: "Privacy") }
        static var aiSharingStatusFooter: String { l("privacy.aiSharingStatusFooter", table: "Privacy") }
        static var reviewAiConsent: String { l("privacy.reviewAiConsent", table: "Privacy") }
        static var revokeAiConsent: String { l("privacy.revokeAiConsent", table: "Privacy") }
        static var revokeAiConsentTitle: String { l("privacy.revokeAiConsentTitle", table: "Privacy") }
        static var revokeAiConsentMessage: String { l("privacy.revokeAiConsentMessage", table: "Privacy") }
        static var consentRequiredTitle: String { l("privacy.consentRequiredTitle", table: "Privacy") }
        static var consentRequiredMessage: String { l("privacy.consentRequiredMessage", table: "Privacy") }
    }

    enum Main {
        static var restoringSession: String { l("main.restoringSession", table: "Common") }
        static var loadingWorkspace: String { l("main.loadingWorkspace", table: "Common") }
        static var memoEmptyDescription: String { l("main.memo.emptyDescription", table: "Common") }
    }

    enum Compose {
        static var title: String { l("compose.title", table: "Common") }
        static var placeholder: String { l("compose.placeholder", table: "Common") }
        static var sendAsChat: String { l("compose.sendAsChat", table: "Common") }
        static var saveAsMemo: String { l("compose.saveAsMemo", table: "Common") }
        static var taskSetup: String { l("compose.taskSetup", table: "Common") }
        static var pickAgentLabel: String { l("compose.pickAgentLabel", table: "Common") }
        static var pickWorkspaceLabel: String { l("compose.pickWorkspaceLabel", table: "Common") }
        static var pickAgentTitle: String { l("compose.pickAgentTitle", table: "Common") }
        static var pickWorkspaceTitle: String { l("compose.pickWorkspaceTitle", table: "Common") }
        static var noAgent: String { l("compose.noAgent", table: "Common") }
        static var noWorkspace: String { l("compose.noWorkspace", table: "Common") }
        static var memoSaved: String { l("compose.memoSaved", table: "Common") }
        static var sendTo: String { l("compose.sendTo", table: "Common") }
        static var noticeTitle: String { l("compose.noticeTitle", table: "Common") }
        static var memoComingSoon: String { l("compose.memoComingSoon", table: "Common") }
    }

    enum Automation {
        static var tomorrow: String { l("automation.tomorrow", table: "Home") }
        static var upcomingTitle: String { l("automation.upcoming.title", table: "Home") }
        static var upcomingTruncated: String { l("automation.upcoming.truncated", table: "Home") }
        static var upcomingMoreInDay: String { l("automation.upcoming.moreInDay", table: "Home") }
    }

    enum Agent {
        static var userPortraitDisabled: String { l("agent.userPortrait.disabled", table: "Agent") }
        static var userPortraitNoOrganization: String { l("agent.userPortrait.noOrganization", table: "Agent") }
        static var userPortraitLastDistilled: String { l("agent.userPortrait.lastDistilled", table: "Agent") }
        static var userPortraitNeverDistilled: String { l("agent.userPortrait.neverDistilled", table: "Agent") }
        static var userPortraitJustNow: String { l("agent.userPortrait.justNow", table: "Agent") }
        static func userPortraitMinAgo(_ count: Int) -> String { l("agent.userPortrait.minAgo", table: "Agent", count) }
        static func userPortraitHourAgo(_ count: Int) -> String { l("agent.userPortrait.hourAgo", table: "Agent", count) }
        static func userPortraitDayAgo(_ count: Int) -> String { l("agent.userPortrait.dayAgo", table: "Agent", count) }
        static var userPortraitEmptyTitle: String { l("agent.userPortrait.empty.title", table: "Agent") }
        static var userPortraitHintSubmit: String { l("agent.userPortrait.hint.submit", table: "Agent") }
        static var userPortraitHintSubmitFailed: String { l("agent.userPortrait.hint.submitFailed", table: "Agent") }
        static func userPortraitHintSoftLimit(_ count: Int) -> String { l("agent.userPortrait.hint.softLimit", table: "Agent", count) }
        static func userPortraitHintHardLimit(_ count: Int) -> String { l("agent.userPortrait.hint.hardLimit", table: "Agent", count) }
        static var userPortraitDistillScheduled: String { l("agent.userPortrait.distillScheduled", table: "Agent") }
        static var userPortraitLoadFailedTitle: String { l("agent.userPortrait.loadFailed.title", table: "Agent") }
        static var userPortraitLoadFailedRetry: String { l("agent.userPortrait.loadFailed.retry", table: "Agent") }
        static var userPortraitStillDistillingHint: String { l("agent.userPortrait.stillDistilling.hint", table: "Agent") }
        static var userPortraitStillDistillingRefresh: String { l("agent.userPortrait.stillDistilling.refresh", table: "Agent") }
        static var noAgents: String { l("agent.noAgents", table: "Agent") }
        static var noAgentsDescription: String { l("agent.noAgentsDescription", table: "Agent") }
        static var create: String { l("agent.create", table: "Agent") }
        static var createTitle: String { l("agent.createTitle", table: "Agent") }
        static var createNamePlaceholder: String { l("agent.createNamePlaceholder", table: "Agent") }
        static var loadingSessions: String { l("agent.loadingSessions", table: "Agent") }
        static var noConversations: String { l("agent.noConversations", table: "Agent") }
        static var createConversation: String { l("agent.createConversation", table: "Agent") }
        static var operationFailed: String { l("agent.operationFailed", table: "Agent") }
        static var searchPlaceholder: String { l("agent.searchPlaceholder", table: "Agent") }
        static var notFound: String { l("agent.notFound", table: "Agent") }
        static var viewAllSessions: String { l("agent.viewAllSessions", table: "Agent") }
        static var resourcesSection: String { l("agent.resourcesSection", table: "Agent") }
        static var conversationsSection: String { l("agent.conversationsSection", table: "Agent") }
        static var resourceNotOpenable: String { l("agent.resourceNotOpenable", table: "Agent") }
        static func noResourcesOfType(_ type: String) -> String { l("agent.noResourcesOfType.named", table: "Agent", type) }
        static var unnamedSession: String { l("agent.unnamedSession", table: "Agent") }
        static var edit: String { l("agent.edit", table: "Agent") }
        static var editTitle: String { l("agent.editTitle", table: "Agent") }
        static var editNamePlaceholder: String { l("agent.editNamePlaceholder", table: "Agent") }
        static var editDescriptionPlaceholder: String { l("agent.editDescriptionPlaceholder", table: "Agent") }
        static var archive: String { l("agent.archive", table: "Agent") }
        static var archiveSession: String { l("agent.session.archive", table: "Agent") }
        static var delete: String { l("agent.delete", table: "Agent") }
        static var sessionPendingPill: String { l("agent.sessionPendingPill", table: "Agent") }
        static var outgoingAwaitingDevice: String { l("agent.outgoingAwaitingDevice", table: "Agent") }
        static var thinkingInProgress: String { l("agent.runtime.thinking.inProgress", table: "Agent") }
        /// 工具已 settle、等待下一轮思考正文（对齐 Electron `planningNext`）。
        static var thinkingPlanningNext: String { l("agent.runtime.thinking.planningNext", table: "Agent") }
        static var thinkingCompleted: String { l("agent.runtime.thinking.completed", table: "Agent") }
        static var thinkingDetailHint: String { l("agent.runtime.thinking.detailHint", table: "Agent") }
        static var executionDetail: String { l("agent.runtime.execution.detail", table: "Agent") }
        static var executionDetailHint: String { l("agent.runtime.execution.detailHint", table: "Agent") }
        static var executionSuspicious: String { l("agent.runtime.execution.suspicious", table: "Agent") }
        static var executionStepFailed: String { l("agent.runtime.execution.stepFailed", table: "Agent") }
        static var mediaImageGenerating: String { l("agent.runtime.mediaImage.generating", table: "Agent") }
        static var mediaImageFailed: String { l("agent.runtime.mediaImage.failed", table: "Agent") }
        static var mediaImageViewDetails: String { l("agent.runtime.mediaImage.viewDetails", table: "Agent") }
        static var mediaImageHideDetails: String { l("agent.runtime.mediaImage.hideDetails", table: "Agent") }
        /// 对齐 Electron `chat:agentSteps.compactionInProgress`。
        static var compactionInProgress: String { l("agent.runtime.compaction.inProgress", table: "Agent") }
        /// 对齐 Electron `chat:agentSteps.compactionCheckpoint`。
        static var compactionCheckpoint: String { l("agent.runtime.compaction.checkpoint", table: "Agent") }

        static var toolExecuteCommand: String { l("agent.runtime.tool.executeCommand", table: "Agent") }
        static var toolSSH: String { l("agent.runtime.tool.ssh", table: "Agent") }
        static var toolReadFile: String { l("agent.runtime.tool.readFile", table: "Agent") }
        static var toolWriteFile: String { l("agent.runtime.tool.writeFile", table: "Agent") }
        static var toolEditFile: String { l("agent.runtime.tool.editFile", table: "Agent") }
        static var toolDeleteFile: String { l("agent.runtime.tool.deleteFile", table: "Agent") }
        static var toolQuery: String { l("agent.runtime.tool.query", table: "Agent") }
        static var toolWebSearch: String { l("agent.runtime.tool.webSearch", table: "Agent") }
        static var toolFetchWeb: String { l("agent.runtime.tool.fetchWeb", table: "Agent") }
        static var toolCodeSearch: String { l("agent.runtime.tool.codeSearch", table: "Agent") }
        static var toolGitStatus: String { l("agent.runtime.tool.gitStatus", table: "Agent") }
        static var toolGitDiff: String { l("agent.runtime.tool.gitDiff", table: "Agent") }
        static var toolUpdateTodo: String { l("agent.runtime.tool.updateTodo", table: "Agent") }
        static var toolDispatchTask: String { l("agent.runtime.tool.dispatchTask", table: "Agent") }
        static var toolAskUser: String { l("agent.runtime.tool.askUser", table: "Agent") }
        static var toolWriteMemory: String { l("agent.runtime.tool.writeMemory", table: "Agent") }
        static var toolDeleteMemory: String { l("agent.runtime.tool.deleteMemory", table: "Agent") }
        static var toolShowWidget: String { l("agent.runtime.tool.showWidget", table: "Agent") }
        static var toolPresentResult: String { l("agent.runtime.tool.presentResult", table: "Agent") }
        static var toolGeneric: String { l("agent.runtime.tool.generic", table: "Agent") }
        static var toolDeviceInfo: String { l("agent.runtime.tool.deviceInfo", table: "Agent") }
        static var toolBatteryInfo: String { l("agent.runtime.tool.batteryInfo", table: "Agent") }
        static var toolNetworkInfo: String { l("agent.runtime.tool.networkInfo", table: "Agent") }
        static var toolReadContacts: String { l("agent.runtime.tool.readContacts", table: "Agent") }
        static var toolReadSms: String { l("agent.runtime.tool.readSms", table: "Agent") }
        static var toolSendSms: String { l("agent.runtime.tool.sendSms", table: "Agent") }
        static var toolReadCallLog: String { l("agent.runtime.tool.readCallLog", table: "Agent") }
        static var toolMakeCall: String { l("agent.runtime.tool.makeCall", table: "Agent") }
        static var toolReadCalendar: String { l("agent.runtime.tool.readCalendar", table: "Agent") }
        static var toolReadNotifications: String { l("agent.runtime.tool.readNotifications", table: "Agent") }
        static var toolListApps: String { l("agent.runtime.tool.listApps", table: "Agent") }
        static var toolReadMedia: String { l("agent.runtime.tool.readMedia", table: "Agent") }
        static var toolGetLocation: String { l("agent.runtime.tool.getLocation", table: "Agent") }
        static var toolScreenCapture: String { l("agent.runtime.tool.screenCapture", table: "Agent") }
        static var toolScreenSnapshot: String { l("agent.runtime.tool.screenSnapshot", table: "Agent") }
        static var toolScreenUiTree: String { l("agent.runtime.tool.screenUiTree", table: "Agent") }
        static var toolScreenTap: String { l("agent.runtime.tool.screenTap", table: "Agent") }
        static var toolScreenSwipe: String { l("agent.runtime.tool.screenSwipe", table: "Agent") }
        static var toolScreenLongPress: String { l("agent.runtime.tool.screenLongPress", table: "Agent") }
        static var toolFindElement: String { l("agent.runtime.tool.findElement", table: "Agent") }
        static var toolTypeText: String { l("agent.runtime.tool.typeText", table: "Agent") }
        static var toolTypeSecret: String { l("agent.runtime.tool.typeSecret", table: "Agent") }
        static var toolKeyEvent: String { l("agent.runtime.tool.keyEvent", table: "Agent") }
        static var toolWaitIdle: String { l("agent.runtime.tool.waitIdle", table: "Agent") }
        static var toolOpenApp: String { l("agent.runtime.tool.openApp", table: "Agent") }
        static var toolStopApp: String { l("agent.runtime.tool.stopApp", table: "Agent") }
        static var toolSystemSetting: String { l("agent.runtime.tool.systemSetting", table: "Agent") }
        static var toolStealthMode: String { l("agent.runtime.tool.stealthMode", table: "Agent") }
        static var toolLaunchIntent: String { l("agent.runtime.tool.launchIntent", table: "Agent") }
        static var toolSaveToDevice: String { l("agent.runtime.tool.saveToDevice", table: "Agent") }
        static var toolAutomationStatus: String { l("agent.runtime.tool.automationStatus", table: "Agent") }
        static var toolFindContent: String { l("agent.runtime.tool.findContent", table: "Agent") }
        static var toolRemoveContent: String { l("agent.runtime.tool.removeContent", table: "Agent") }
        static var toolRestoreContent: String { l("agent.runtime.tool.restoreContent", table: "Agent") }
        static var toolCreateContent: String { l("agent.runtime.tool.createContent", table: "Agent") }
        static var toolUpdateContent: String { l("agent.runtime.tool.updateContent", table: "Agent") }
        static var toolPublishContent: String { l("agent.runtime.tool.publishContent", table: "Agent") }
        static var toolHandleDoc: String { l("agent.runtime.tool.handleDoc", table: "Agent") }
        static var toolHandleMemo: String { l("agent.runtime.tool.handleMemo", table: "Agent") }
        static var toolHandleSite: String { l("agent.runtime.tool.handleSite", table: "Agent") }
        static var toolHandleTable: String { l("agent.runtime.tool.handleTable", table: "Agent") }
        static var toolDrawerInput: String { l("agent.runtime.tool.drawer.input", table: "Agent") }
        static var toolDrawerResult: String { l("agent.runtime.tool.drawer.result", table: "Agent") }
        static var toolDrawerError: String { l("agent.runtime.tool.drawer.error", table: "Agent") }
        static var toolDrawerViewRaw: String { l("agent.runtime.tool.drawer.viewRaw", table: "Agent") }
        static var toolDrawerRunning: String { l("agent.runtime.tool.drawer.running", table: "Agent") }
        static var toolKeyFile: String { l("agent.runtime.tool.key.file", table: "Agent") }
        static var toolKeyCommand: String { l("agent.runtime.tool.key.command", table: "Agent") }
        static var toolKeyQuery: String { l("agent.runtime.tool.key.query", table: "Agent") }
        static var toolKeyURL: String { l("agent.runtime.tool.key.url", table: "Agent") }
        static var toolKeySQL: String { l("agent.runtime.tool.key.sql", table: "Agent") }

        static func noConversationsHint(_ name: String) -> String { l("agent.noConversationsHint.named", table: "Agent", name) }
        static func archiveConfirm(_ name: String) -> String { l("agent.archiveConfirm.named", table: "Agent", name) }
        static func archiveSessionConfirm(_ name: String?) -> String {
            l("agent.session.archiveConfirm.named", table: "Agent", name ?? unnamedSession)
        }
        static func deleteConfirm(_ name: String) -> String { l("agent.deleteConfirm.named", table: "Agent", name) }
        static func thinkingCompletedIn(_ seconds: Int) -> String {
            l("agent.runtime.thinking.completedIn.seconds", table: "Agent", seconds)
        }
        static func executionStepCount(_ count: Int) -> String {
            l("agent.runtime.execution.stepCount.count", table: "Agent", count)
        }
        static func executionFailedCount(_ count: Int) -> String {
            l("agent.runtime.execution.failedCount.count", table: "Agent", count)
        }

        static var capsuleMenuText: String { l("agent.capsule.menu.text", table: "Agent") }
        static var capsuleMenuVoice: String { l("agent.capsule.menu.voice", table: "Agent") }
        static var capsuleMenuTextA11y: String { l("agent.capsule.menu.textA11y", table: "Agent") }
        static var capsuleMenuVoiceA11y: String { l("agent.capsule.menu.voiceA11y", table: "Agent") }
        static var capsuleOnboardingTapTitle: String { l("agent.capsule.onboarding.tap.title", table: "Agent") }
        static var capsuleOnboardingTapDetail: String { l("agent.capsule.onboarding.tap.detail", table: "Agent") }
        static var capsuleOnboardingDragTitle: String { l("agent.capsule.onboarding.drag.title", table: "Agent") }
        static var capsuleOnboardingDragDetail: String { l("agent.capsule.onboarding.drag.detail", table: "Agent") }
        static var capsuleOnboardingHoldTitle: String { l("agent.capsule.onboarding.hold.title", table: "Agent") }
        static var capsuleOnboardingHoldDetail: String { l("agent.capsule.onboarding.hold.detail", table: "Agent") }
        static var capsuleOnboardingSkip: String { l("agent.capsule.onboarding.skip", table: "Agent") }
        static var capsuleOnboardingSettingsSection: String { l("agent.capsule.onboarding.settings.section", table: "Agent") }
        static var capsuleOnboardingReplayTitle: String { l("agent.capsule.onboarding.replay.title", table: "Agent") }
        static var capsuleOnboardingReplayDetail: String { l("agent.capsule.onboarding.replay.detail", table: "Agent") }
        static var capsuleOnboardingReplayDone: String { l("agent.capsule.onboarding.replay.done", table: "Agent") }
        static var conversationLayerGrabber: String {
            l("agent.conversationLayer.grabber", table: "Agent")
        }
        static var conversationLayerExpand: String {
            l("agent.conversationLayer.expand", table: "Agent")
        }
        static var conversationLayerCollapse: String {
            l("agent.conversationLayer.collapse", table: "Agent")
        }
        static var capsuleTextComposerPlaceholder: String {
            l("agent.capsule.textComposer.placeholder", table: "Agent")
        }
        static var capsuleTextComposerSendA11y: String {
            l("agent.capsule.textComposer.sendA11y", table: "Agent")
        }
        static var capsuleA11yReturnChat: String { l("agent.capsule.a11y.returnChat", table: "Agent") }
        static var capsuleA11yStartVoice: String { l("agent.capsule.a11y.startVoice", table: "Agent") }
        static var capsuleA11yEndAndSend: String { l("agent.capsule.a11y.endAndSend", table: "Agent") }
        static var capsuleA11yCancelVoice: String { l("agent.capsule.a11y.cancelVoice", table: "Agent") }
        static var capsuleVoiceCancel: String { l("agent.capsule.voice.cancel", table: "Agent") }
        static var capsuleVoiceSend: String { l("agent.capsule.voice.send", table: "Agent") }
        static var capsuleVoiceListeningHint: String { l("agent.capsule.voice.listeningHint", table: "Agent") }
        static var capsuleHITLApprove: String { l("agent.capsule.hitl.approve", table: "Agent") }
        static var capsuleHITLDeny: String { l("agent.capsule.hitl.deny", table: "Agent") }
        static var capsuleHITLViewDetails: String { l("agent.capsule.hitl.viewDetails", table: "Agent") }
        static var capsuleHITLAnswerInConversation: String {
            l("agent.capsule.hitl.answerInConversation", table: "Agent")
        }
        static var capsuleHITLApprovalKind: String { l("agent.capsule.hitl.approvalKind", table: "Agent") }
        static var capsuleHITLChoiceKind: String { l("agent.capsule.hitl.choiceKind", table: "Agent") }
        static var capsuleHITLWaitingOwnerApproval: String {
            l("agent.capsule.hitl.waitingOwnerApproval", table: "Agent")
        }
        static var capsuleHITLWaitingOwnerAnswer: String {
            l("agent.capsule.hitl.waitingOwnerAnswer", table: "Agent")
        }
        static var capsuleHITLChoiceFallback: String {
            l("agent.capsule.hitl.choiceFallback", table: "Agent")
        }
        static var capsuleHITLSubmitting: String { l("agent.capsule.hitl.submitting", table: "Agent") }
        static var capsuleHITLErrorRetryHint: String {
            l("agent.capsule.hitl.errorRetryHint", table: "Agent")
        }
        static var capsuleHITLApprovalHint: String {
            l("agent.capsule.hitl.approvalHint", table: "Agent")
        }
        static var capsuleHITLChoiceHint: String {
            l("agent.capsule.hitl.choiceHint", table: "Agent")
        }
        static func capsuleHITLApprovalBatch(_ count: Int) -> String {
            l("agent.capsule.hitl.approvalBatch.count", table: "Agent", count)
        }
        static func capsuleHITLApprovalToolRequest(_ action: String) -> String {
            l("agent.capsule.hitl.approvalToolRequest.named", table: "Agent", action)
        }
    }

    /// Space 列表专属文案。与 Agent 设置 / 子 Agent 文案分开，避免再次把身份和容器混为一谈。
    enum SpaceList {
        static var emptyTitle: String { l("spaceList.emptyTitle", table: "Agent") }
        static var emptyDescription: String { l("spaceList.emptyDescription", table: "Agent") }
        static var creationBoundary: String { l("spaceList.creationBoundary", table: "Agent") }
        static var searchPlaceholder: String { l("spaceList.searchPlaceholder", table: "Agent") }
        static var notFound: String { l("spaceList.notFound", table: "Agent") }
        static var editTitle: String { l("spaceList.editTitle", table: "Agent") }
        static var editNamePlaceholder: String { l("spaceList.editNamePlaceholder", table: "Agent") }
        static var editDescriptionPlaceholder: String { l("spaceList.editDescriptionPlaceholder", table: "Agent") }
        static var primaryAgentUnassigned: String { l("spaceList.primaryAgent.unassigned", table: "Agent") }
        static var primaryAgentLoading: String { l("spaceList.primaryAgent.loading", table: "Agent") }
        static var primaryAgentUnavailable: String { l("spaceList.primaryAgent.unavailable", table: "Agent") }
        static var executionDeviceUnbound: String { l("spaceList.executionDevice.unbound", table: "Agent") }
        static var executionDeviceLoading: String { l("spaceList.executionDevice.loading", table: "Agent") }
        static var executionDeviceUnavailable: String { l("spaceList.executionDevice.unavailable", table: "Agent") }
        static var unnamedDevice: String { l("spaceList.executionDevice.unnamed", table: "Agent") }
        static var deviceOnline: String { l("spaceList.deviceStatus.online", table: "Agent") }
        static var deviceBusy: String { l("spaceList.deviceStatus.busy", table: "Agent") }
        static var deviceOffline: String { l("spaceList.deviceStatus.offline", table: "Agent") }
        static var deviceUnknown: String { l("spaceList.deviceStatus.unknown", table: "Agent") }
        static var formalAgents: String { l("spaceList.formalAgents", table: "Agent") }

        static func primaryAgent(_ name: String) -> String {
            l("spaceList.primaryAgent.named", table: "Agent", name)
        }

        static func executionDevice(_ name: String, _ status: String) -> String {
            l("spaceList.executionDevice.namedStatus", table: "Agent", name, status)
        }
    }

    enum Project {
        static var headerLabel: String { l("project.header.label", table: "Project") }
        static var sectionPickerLabel: String { l("project.sectionPicker.label", table: "Project") }
        static var segmentAiAvatar: String { l("project.segment.aiAvatar", table: "Project") }
        static var segmentSpace: String { l("project.segment.space", table: "Project") }
        static var segmentProject: String { l("project.segment.project", table: "Project") }
        static var searchPlaceholder: String { l("project.searchPlaceholder", table: "Project") }
        static var myAgentsSearchPlaceholder: String { l("project.myAgents.searchPlaceholder", table: "Project") }
        static var myAgentsEmptyTitle: String { l("project.myAgents.emptyTitle", table: "Project") }
        static var myAgentsEmptyDescription: String { l("project.myAgents.emptyDescription", table: "Project") }
        static var myAgentsLoadFailed: String { l("project.myAgents.loadFailed", table: "Project") }
        static var myAgentsCreate: String { l("project.myAgents.create", table: "Project") }
        static var myAgentsCreateAction: String { l("project.myAgents.createAction", table: "Project") }
        static var myAgentsEdit: String { l("project.myAgents.edit", table: "Project") }
        static var myAgentsName: String { l("project.myAgents.name", table: "Project") }
        static var myAgentsTemplate: String { l("project.myAgents.template", table: "Project") }
        static var myAgentsBlank: String { l("project.myAgents.blank", table: "Project") }
        static var myAgentsBlankHint: String { l("project.myAgents.blankHint", table: "Project") }
        static var myAgentsPersonaRules: String { l("project.myAgents.personaRules", table: "Project") }
        static var myAgentsPersonaPlaceholder: String { l("project.myAgents.personaPlaceholder", table: "Project") }
        static var myAgentsPersonaScopeHint: String { l("project.myAgents.personaScopeHint", table: "Project") }
        static var myAgentsDeactivate: String { l("project.myAgents.deactivate", table: "Project") }
        static var myAgentsDeactivateTitle: String { l("project.myAgents.deactivateTitle", table: "Project") }
        static var myAgentsActionFailed: String { l("project.myAgents.actionFailed", table: "Project") }
        static var myAgentsDeactivatedTitle: String { l("project.myAgents.deactivatedTitle", table: "Project") }
        static var myAgentsDeactivatedStatus: String { l("project.myAgents.deactivatedStatus", table: "Project") }
        static var myAgentsReactivate: String { l("project.myAgents.reactivate", table: "Project") }
        static var myAgentsPermanentDelete: String { l("project.myAgents.permanentDelete", table: "Project") }
        static var myAgentsPermanentDeleteTitle: String { l("project.myAgents.permanentDeleteTitle", table: "Project") }
        static func myAgentsPermanentDeleteBody(_ name: String) -> String {
            l("project.myAgents.permanentDeleteBody", table: "Project", name)
        }
        static var myAgentsAlreadyReactivating: String { l("project.myAgents.alreadyReactivating", table: "Project") }
        static func myAgentsDeactivatedAt(_ time: String) -> String {
            l("project.myAgents.deactivatedAt", table: "Project", time)
        }
        static var myAgentsSourceCustom: String { l("project.myAgents.sourceCustom", table: "Project") }
        static var myAgentsSourceTemplate: String { l("project.myAgents.sourceTemplate", table: "Project") }
        static func myAgentsUpdatedAt(_ time: String) -> String {
            l("project.myAgents.updatedAt", table: "Project", time)
        }
        static func myAgentsDeactivateBody(_ name: String) -> String {
            l("project.myAgents.deactivateBody", table: "Project", name)
        }
        static var myAgentsDetailRules: String { l("project.myAgents.detailRules", table: "Project") }
        static var myAgentsDetailRulesEmpty: String { l("project.myAgents.detailRulesEmpty", table: "Project") }
        static var myAgentsDetailDesktopHint: String { l("project.myAgents.detailDesktopHint", table: "Project") }
        static var myAgentsDefault: String { l("project.myAgents.default", table: "Project") }
        static var myAgentsSkills: String { l("project.myAgents.skills", table: "Project") }
        static var myAgentsSkillsHint: String { l("project.myAgents.skillsHint", table: "Project") }
        static var myAgentsSkillsEmpty: String { l("project.myAgents.skillsEmpty", table: "Project") }
        static var myAgentsTools: String { l("project.myAgents.tools", table: "Project") }
        static var myAgentsToolsHint: String { l("project.myAgents.toolsHint", table: "Project") }
        static var myAgentsToolsEmpty: String { l("project.myAgents.toolsEmpty", table: "Project") }
        /// Agent 详情：该分身尚未挂载任何本机 MCP。
        static var myAgentsToolsNotMounted: String { l("project.myAgents.toolsNotMounted", table: "Project") }
        static var myAgentsToolsManageOnDesktop: String { l("project.myAgents.toolsManageOnDesktop", table: "Project") }
        /// 电脑 Electron 离线 / 不可用时，工具携带集顶部提示。
        static var myAgentsToolsDeviceOffline: String { l("project.myAgents.toolsDeviceOffline", table: "Project") }
        static var myAgentsToolsSourceOrg: String { l("project.myAgents.toolsSourceOrg", table: "Project") }
        static var myAgentsToolsSourceLocal: String { l("project.myAgents.toolsSourceLocal", table: "Project") }
        static var myAgentsSkillLocked: String { l("project.myAgents.skillLocked", table: "Project") }
        static var myAgentsRemoveSkill: String { l("project.myAgents.removeSkill", table: "Project") }
        static var myAgentsRemoveSkillTitle: String { l("project.myAgents.removeSkillTitle", table: "Project") }
        static func myAgentsRemoveSkillBody(_ name: String) -> String {
            l("project.myAgents.removeSkillBody", table: "Project", name)
        }
        static var myAgentsAddSkill: String { l("project.myAgents.addSkill", table: "Project") }
        static var myAgentsAddSkillTitle: String { l("project.myAgents.addSkillTitle", table: "Project") }
        static var myAgentsAddSkillEmpty: String { l("project.myAgents.addSkillEmpty", table: "Project") }
        static var myAgentsAddSkillSearch: String { l("project.myAgents.addSkillSearch", table: "Project") }
        static var myAgentsAddSkillAction: String { l("project.myAgents.addSkillAction", table: "Project") }
        static func myAgentsAddSkillActionCount(_ count: Int) -> String {
            l("project.myAgents.addSkillActionCount", table: "Project", count)
        }
        static func myAgentsSkillAdded(_ name: String) -> String {
            l("project.myAgents.skillAdded", table: "Project", name)
        }
        static func myAgentsSkillsAddedBatch(_ name: String, _ count: Int) -> String {
            l("project.myAgents.skillsAddedBatch", table: "Project", name, count)
        }
        static var myAgentsMemory: String { l("project.myAgents.memory", table: "Project") }
        static var myAgentsMemoryHint: String { l("project.myAgents.memoryHint", table: "Project") }
        static var myAgentsMemoryOverview: String { l("project.myAgents.memoryOverview", table: "Project") }
        static var myAgentsMemoryRecords: String { l("project.myAgents.memoryRecords", table: "Project") }
        static var myAgentsMemoryOverviewHint: String { l("project.myAgents.memoryOverviewHint", table: "Project") }
        static var myAgentsMemoryRecordsHint: String { l("project.myAgents.memoryRecordsHint", table: "Project") }
        static var myAgentsMemoryHintLabel: String { l("project.myAgents.memoryHintLabel", table: "Project") }
        static var myAgentsMemoryHintPlaceholder: String { l("project.myAgents.memoryHintPlaceholder", table: "Project") }
        static var myAgentsMemoryEmpty: String { l("project.myAgents.memoryEmpty", table: "Project") }
        static var myAgentsMemoryTypeAboutYou: String { l("project.myAgents.memoryType.aboutYou", table: "Project") }
        static var myAgentsMemoryTypeInsight: String { l("project.myAgents.memoryType.insight", table: "Project") }
        static var myAgentsMemoryTypeTaskSummary: String { l("project.myAgents.memoryType.taskSummary", table: "Project") }
        static var myAgentsMemoryTypeDiary: String { l("project.myAgents.memoryType.diary", table: "Project") }
        static var myAgentsCorrectMemory: String { l("project.myAgents.correctMemory", table: "Project") }
        static var myAgentsCorrectMemoryTitle: String { l("project.myAgents.correctMemoryTitle", table: "Project") }
        static var myAgentsCorrectMemoryHint: String { l("project.myAgents.correctMemoryHint", table: "Project") }
        static var myAgentsForgetMemory: String { l("project.myAgents.forgetMemory", table: "Project") }
        static var myAgentsForgetMemoryTitle: String { l("project.myAgents.forgetMemoryTitle", table: "Project") }
        static var myAgentsForgetMemoryBody: String { l("project.myAgents.forgetMemoryBody", table: "Project") }
        static var myAgentsRecentTasks: String { l("project.myAgents.recentTasks", table: "Project") }
        static var myAgentsRecentTasksHint: String { l("project.myAgents.recentTasksHint", table: "Project") }
        static var myAgentsRecentTasksEmpty: String { l("project.myAgents.recentTasksEmpty", table: "Project") }
        static var myAgentsChat: String { l("project.myAgents.chat", table: "Project") }
        static var myAgentsProjectTask: String { l("project.myAgents.projectTask", table: "Project") }
        static var invitations: String { l("project.invitations", table: "Project") }
        static var desktopAccept: String { l("project.invitation.desktopAccept", table: "Project") }
        static var desktopAcceptTitle: String { l("project.invitation.desktopAcceptTitle", table: "Project") }
        static var desktopAcceptBody: String { l("project.invitation.desktopAcceptBody", table: "Project") }
        static var emptyTitle: String { l("project.emptyTitle", table: "Project") }
        static var emptyDescription: String { l("project.emptyDescription", table: "Project") }
        static var fallbackDescription: String { l("project.fallbackDescription", table: "Project") }
        static var detailNotFound: String { l("project.detailNotFound", table: "Project") }
        static var executionTitle: String { l("project.execution.title", table: "Project") }
        static var executionUnavailable: String { l("project.execution.unavailable", table: "Project") }
        static var executionReady: String { l("project.execution.ready", table: "Project") }
        static var startTask: String { l("project.task.start", table: "Project") }
        static var taskTitle: String { l("project.task.title", table: "Project") }
        static var taskPrompt: String { l("project.task.prompt", table: "Project") }
        static var taskPromptPlaceholder: String { l("project.task.promptPlaceholder", table: "Project") }
        static var taskExecutionSection: String { l("project.task.executionSection", table: "Project") }
        static var taskExecutionHint: String { l("project.task.executionHint", table: "Project") }
        static var taskNoWorkspace: String { l("project.task.noWorkspace", table: "Project") }
        static var taskLoadFailed: String { l("project.task.loadFailed", table: "Project") }
        static var taskDeviceOffline: String { l("project.task.deviceOffline", table: "Project") }
        static var taskChooseAgent: String { l("project.task.chooseAgent", table: "Project") }
        static var taskNoAgent: String { l("project.task.noAgent", table: "Project") }
        static var taskSend: String { l("project.task.send", table: "Project") }
        static var tabDiscussion: String { l("project.tab.discussion", table: "Project") }
        static var tabAssets: String { l("project.tab.assets", table: "Project") }
        static var tabActivity: String { l("project.tab.activity", table: "Project") }
        static var tabMembers: String { l("project.tab.members", table: "Project") }
        static var discussionIntro: String { l("project.discussion.intro", table: "Project") }
        static var discussionEmpty: String { l("project.discussion.empty", table: "Project") }
        static var discussionGeneral: String { l("project.discussion.general", table: "Project") }
        static var discussionAgentUpdates: String { l("project.discussion.agentUpdates", table: "Project") }
        static var assetsIntro: String { l("project.assets.intro", table: "Project") }
        static var assetsEmpty: String { l("project.assets.empty", table: "Project") }
        static var activityIntro: String { l("project.activity.intro", table: "Project") }
        static var activityEmpty: String { l("project.activity.empty", table: "Project") }
        static var membersIntro: String { l("project.members.intro", table: "Project") }
        static var membersEmpty: String { l("project.members.empty", table: "Project") }
        static var memberKind: String { l("project.memberKind", table: "Project") }
        static var agentKind: String { l("project.agentKind", table: "Project") }
        static var primaryAgentBadge: String { l("project.primaryAgent.badge", table: "Project") }
        static var setPrimaryAgent: String { l("project.primaryAgent.set", table: "Project") }
        static var readOnlyHint: String { l("project.readOnlyHint", table: "Project") }
        static var partialLoadError: String { l("project.partialLoadError", table: "Project") }
        static var invitationLoadError: String { l("project.invitationLoadError", table: "Project") }
        static var sourceSpace: String { l("project.source.space", table: "Project") }
        static var sourceProject: String { l("project.source.project", table: "Project") }
        static var unnamedAsset: String { l("project.asset.unnamed", table: "Project") }
        static var unknownActor: String { l("project.activity.unknownActor", table: "Project") }
        static var unknownTarget: String { l("project.activity.unknownTarget", table: "Project") }
        static var activityGeneric: String { l("project.activity.generic", table: "Project") }

        static func invitedBy(_ name: String, role: String) -> String {
            l("project.invitation.invitedBy", table: "Project", name, role)
        }
        static func memberCount(_ count: Int) -> String {
            l("project.memberCount", table: "Project", count)
        }
        static func discussionMemberCount(_ count: Int) -> String {
            l("project.discussion.memberCount", table: "Project", count)
        }
        static func executionReadyWorkspace(_ name: String) -> String {
            l("project.execution.readyWorkspace", table: "Project", name)
        }
        static func taskWorkspace(_ name: String) -> String {
            l("project.task.workspace", table: "Project", name)
        }
        static func activity(_ key: String, actor: String, target: String) -> String {
            l("project.activity.event.\(key)", table: "Project", actor, target)
        }
    }

    enum Recent {
        static var title: String { l("recent.title", table: "Common") }
        static var loading: String { l("recent.loading", table: "Common") }
        static var emptyTitle: String { l("recent.emptyTitle", table: "Common") }
        static var emptyDescription: String { l("recent.emptyDescription", table: "Common") }
        static var newConversation: String { l("recent.newConversation", table: "Common") }
        static var segmentConversations: String { l("recent.segment.conversations", table: "Common") }
        static var segmentMessages: String { l("recent.segment.messages", table: "Common") }
        static var segmentContacts: String { l("recent.segment.contacts", table: "Common") }
        static var messagesEmptyTitle: String { l("recent.messages.emptyTitle", table: "Common") }
        static var messagesEmptyDescription: String { l("recent.messages.emptyDescription", table: "Common") }
        static var contactsFilter: String { l("recent.contacts.filter", table: "Common") }
        static var contactsEmptyTitle: String { l("recent.contacts.emptyTitle", table: "Common") }
        static var contactsEmptyDescription: String { l("recent.contacts.emptyDescription", table: "Common") }
        static var contactsYou: String { l("recent.contacts.you", table: "Common") }
    }

    enum Home {
        static var title: String { l("home.title", table: "Home") }
        static var newConversation: String { l("home.newConversation", table: "Home") }
        static var newTask: String { l("home.newTask", table: "Home") }
        static var scopeAll: String { l("home.scope.all", table: "Home") }
        static var scopeNeedsYou: String { l("home.scope.needsYou", table: "Home") }
        static var scopeRunning: String { l("home.scope.running", table: "Home") }
        static var scopeArchived: String { l("home.scope.archived", table: "Home") }
        static var scopeSwitcherA11y: String { l("home.scope.switcherA11y", table: "Home") }
        static var skills: String { l("home.skills", table: "Home") }
        static var automation: String { l("home.automation", table: "Home") }
        static var featureAutomationSubtitle: String { l("home.featureAutomation.subtitle", table: "Home") }
        static var featureSkillsSubtitle: String { l("home.featureSkills.subtitle", table: "Home") }
        static var comingSoon: String { l("home.comingSoon", table: "Home") }
        static var filterAll: String { l("home.filterAll", table: "Home") }
        static var workspaceFilter: String { l("home.workspaceFilter", table: "Home") }
        static var segmentMessages: String { l("home.segment.messages", table: "Home") }
        static var segmentPinned: String { l("home.segment.pinned", table: "Home") }
        static var bandNeedsYou: String { l("home.band.needsYou", table: "Home") }
        static var groupLast7Days: String { l("home.group.last7Days", table: "Home") }
        static var groupLast30Days: String { l("home.group.last30Days", table: "Home") }
        static var groupEarlier: String { l("home.group.earlier", table: "Home") }
        static var deviceOffline: String { l("home.device.offline", table: "Home") }
        static var pinConversation: String { l("home.pinConversation", table: "Home") }
        static var unpinConversation: String { l("home.unpinConversation", table: "Home") }
        static var segmentUnread: String { l("home.segment.unread", table: "Home") }
        static func segmentUnreadCount(_ count: Int) -> String {
            l("home.segment.unreadCount", table: "Home", count)
        }
        static var pinnedEmptyTitle: String { l("home.pinnedEmptyTitle", table: "Home") }
        static var pinnedEmptyDescription: String { l("home.pinnedEmptyDescription", table: "Home") }
        static var unreadEmptyTitle: String { l("home.unreadEmptyTitle", table: "Home") }
        static var unreadEmptyDescription: String { l("home.unreadEmptyDescription", table: "Home") }
        static var sessionStatusRunning: String { l("home.sessionStatus.running", table: "Home") }
        static var sessionStatusUnread: String { l("home.sessionStatus.unread", table: "Home") }
        static var rowStatusWaitingForUser: String { l("home.row.status.waitingForUser", table: "Home") }
        static var rowStatusFailed: String { l("home.row.status.failed", table: "Home") }
        static var statusArchived: String { l("home.status.archived", table: "Home") }
        static var unknownAgent: String { l("home.unknownAgent", table: "Home") }
        static var unknownWorkspace: String { l("home.unknownWorkspace", table: "Home") }
        static var conversationsSection: String { l("home.conversationsSection", table: "Home") }
        static var loading: String { l("home.loading", table: "Home") }
        static var emptyTitle: String { l("home.emptyTitle", table: "Home") }
        static var emptyDescription: String { l("home.emptyDescription", table: "Home") }
        static var filteredEmptyTitle: String { l("home.filteredEmptyTitle", table: "Home") }
        static var filteredEmptyDescription: String { l("home.filteredEmptyDescription", table: "Home") }
    }

    enum RunStatus {
        static var idle: String { l("runStatus.idle", table: "Home") }
        static var preparing: String { l("runStatus.preparing", table: "Home") }
        static var planning: String { l("runStatus.planning", table: "Home") }
        static var executing: String { l("runStatus.executing", table: "Home") }
        static var responding: String { l("runStatus.responding", table: "Home") }
        static var paused: String { l("runStatus.paused", table: "Home") }
        static var recoveringConnection: String { l("runStatus.recoveringConnection", table: "Home") }
        static var completed: String { l("runStatus.completed", table: "Home") }
        static var failed: String { l("runStatus.failed", table: "Home") }
        static var canRetry: String { l("runStatus.canRetry", table: "Home") }
        static var checkBilling: String { l("runStatus.checkBilling", table: "Home") }
        static var relogin: String { l("runStatus.relogin", table: "Home") }
        static var newConversation: String { l("runStatus.newConversation", table: "Home") }

        static func waitingForUser(_ count: Int) -> String {
            l("runStatus.waitingForUser", table: "Home", count)
        }

        static func currentAction(_ action: String) -> String {
            l("runStatus.currentAction", table: "Home", action)
        }
    }

    enum Messages {
        static var createGroup: String { l("messages.createGroup", table: "Common") }
        static var groupName: String { l("messages.groupName", table: "Common") }
        static var groupNamePlaceholder: String { l("messages.groupNamePlaceholder", table: "Common") }
        static var groupMembers: String { l("messages.groupMembers", table: "Common") }
        static var groupIncludesYou: String { l("messages.groupIncludesYou", table: "Common") }
        static var groupNameRequired: String { l("messages.groupNameRequired", table: "Common") }
        static var groupMembersRequired: String { l("messages.groupMembersRequired", table: "Common") }
        static var groupCreateFailed: String { l("messages.groupCreateFailed", table: "Common") }
        static var groupLimitExceeded: String { l("messages.groupLimitExceeded", table: "Common") }
        static func groupMembersSelected(_ count: Int) -> String {
            l("messages.groupMembersSelected", table: "Common", count)
        }
        static var searchPlaceholder: String { l("messages.searchPlaceholder", table: "Common") }
        static var recentSection: String { l("messages.recentSection", table: "Common") }
        static var unnamedConversation: String { l("messages.unnamedConversation", table: "Common") }
        static var channel: String { l("messages.channel", table: "Common") }
        static var groupChat: String { l("messages.groupChat", table: "Common") }
        static var directMessage: String { l("messages.directMessage", table: "Common") }
        static var mute: String { l("messages.mute", table: "Common") }
        static var unmute: String { l("messages.unmute", table: "Common") }
        static var muted: String { l("messages.muted", table: "Common") }
        static var muteActionFailed: String { l("messages.muteActionFailed", table: "Common") }
        static var actionNotSaved: String { l("messages.actionNotSaved", table: "Common") }
        static var networkError: String { l("messages.networkError", table: "Common") }
        static var aiSuggestTaskTitle: String { l("messages.aiSuggestTaskTitle", table: "Common") }
        static func aiReplyFailed(_ name: String) -> String {
            l("messages.aiReplyFailed", table: "Common", name)
        }
        static func aiSuggestTaskDescription(_ name: String) -> String {
            l("messages.aiSuggestTaskDescription", table: "Common", name)
        }
        static func historyTransportError(code: Int) -> String {
            l("messages.historyTransportError", table: "Common", code)
        }
        static var historyLoadFailed: String { l("messages.historyLoadFailed", table: "Common") }
    }

    enum Profile {
        static var title: String { l("profile.title", table: "Profile") }
        static var defaultName: String { l("profile.defaultName", table: "Profile") }
        static var deviceId: String { l("profile.deviceId", table: "Profile") }
        static var logout: String { l("profile.logout", table: "Profile") }
        static var appearance: String { l("profile.appearance", table: "Profile") }
        static var themeSystem: String { l("profile.theme.system", table: "Profile") }
        static var themeLight: String { l("profile.theme.light", table: "Profile") }
        static var themeDark: String { l("profile.theme.dark", table: "Profile") }
        static var language: String { l("profile.language", table: "Profile") }
        static var languageSystem: String { l("profile.language.system", table: "Profile") }
        static var editTitle: String { l("profile.editTitle", table: "Profile") }
        static var changeAvatar: String { l("profile.changeAvatar", table: "Profile") }
        static var changePassword: String { l("profile.changePassword", table: "Profile") }
        static var changePasswordSubtitle: String { l("profile.changePasswordSubtitle", table: "Profile") }
        static var changePasswordTitle: String { l("profile.changePassword.title", table: "Profile") }
        static var changePasswordDescChange: String { l("profile.changePassword.descChange", table: "Profile") }
        static func changePasswordDescReset(_ identifier: String) -> String {
            l("profile.changePassword.descReset", table: "Profile", identifier)
        }
        static var changePasswordDescResetNoContact: String { l("profile.changePassword.descResetNoContact", table: "Profile") }
        static var changePasswordCurrent: String { l("profile.changePassword.current", table: "Profile") }
        static var changePasswordVerificationCode: String { l("profile.changePassword.verificationCode", table: "Profile") }
        static var changePasswordNew: String { l("profile.changePassword.new", table: "Profile") }
        static var changePasswordConfirm: String { l("profile.changePassword.confirm", table: "Profile") }
        static var changePasswordPlaceholderOld: String { l("profile.changePassword.placeholderOld", table: "Profile") }
        static var changePasswordPlaceholderCode: String { l("profile.changePassword.placeholderCode", table: "Profile") }
        static var changePasswordPlaceholderNew: String { l("profile.changePassword.placeholderNew", table: "Profile") }
        static var changePasswordPlaceholderConfirm: String { l("profile.changePassword.placeholderConfirm", table: "Profile") }
        static var changePasswordSendCode: String { l("profile.changePassword.sendCode", table: "Profile") }
        static var changePasswordSubmit: String { l("profile.changePassword.submit", table: "Profile") }
        static var changePasswordForgotOld: String { l("profile.changePassword.forgotOld", table: "Profile") }
        static var changePasswordUseOld: String { l("profile.changePassword.useOld", table: "Profile") }
        static var changePasswordCodeSent: String { l("profile.changePassword.codeSent", table: "Profile") }
        static var changePasswordSuccess: String { l("profile.changePassword.success", table: "Profile") }
        static var changePasswordSuccessRelogin: String { l("profile.changePassword.successRelogin", table: "Profile") }
        static var changePasswordErrorOldRequired: String { l("profile.changePassword.errorOldRequired", table: "Profile") }
        static var changePasswordErrorCodeInvalid: String { l("profile.changePassword.errorCodeInvalid", table: "Profile") }
        static var changePasswordErrorNewRequired: String { l("profile.changePassword.errorNewRequired", table: "Profile") }
        static var changePasswordErrorNewNoWhitespace: String { l("profile.changePassword.errorNewNoWhitespace", table: "Profile") }
        static var changePasswordErrorNewNoCJK: String { l("profile.changePassword.errorNewNoCJK", table: "Profile") }
        static var changePasswordErrorNewTooShort: String { l("profile.changePassword.errorNewTooShort", table: "Profile") }
        static var changePasswordErrorNewNotComplex: String { l("profile.changePassword.errorNewNotComplex", table: "Profile") }
        static var changePasswordErrorMismatch: String { l("profile.changePassword.errorMismatch", table: "Profile") }
        static var changePasswordErrorSendCode: String { l("profile.changePassword.errorSendCode", table: "Profile") }
        static var changePasswordErrorFailed: String { l("profile.changePassword.errorFailed", table: "Profile") }
        static var nicknameLabel: String { l("profile.nicknameLabel", table: "Profile") }
        static var nicknameRequired: String { l("profile.nicknameRequired", table: "Profile") }
        static var usernameLabel: String { l("profile.usernameLabel", table: "Profile") }
        static var usernameLength: String { l("profile.usernameLength", table: "Profile") }
        static var usernameFormat: String { l("profile.usernameFormat", table: "Profile") }
        static var bioLabel: String { l("profile.bioLabel", table: "Profile") }
        static var bioPlaceholder: String { l("profile.bioPlaceholder", table: "Profile") }
        static var bioEmpty: String { l("profile.bioEmpty", table: "Profile") }
        static var basicInfoHeader: String { l("profile.basicInfoHeader", table: "Profile") }
        static var verified: String { l("profile.verified", table: "Profile") }
        static var verify: String { l("profile.verify", table: "Profile") }
        static var registeredAt: String { l("profile.registeredAt", table: "Profile") }
        static var loginCount: String { l("profile.loginCount", table: "Profile") }
        static var lastLogin: String { l("profile.lastLogin", table: "Profile") }
        static var logoutConfirmTitle: String { l("profile.logoutConfirmTitle", table: "Profile") }
        static var logoutConfirmMessage: String { l("profile.logoutConfirmMessage", table: "Profile") }
        static var privacyAndData: String { l("profile.privacyAndData", table: "Profile") }
        static var deleteAccountTitle: String { l("profile.deleteAccountTitle", table: "Profile") }
        static var deleteAccountAction: String { l("profile.deleteAccountAction", table: "Profile") }
        static var deleteAccountIntroTitle: String { l("profile.deleteAccountIntroTitle", table: "Profile") }
        static var deleteAccountIntroBody: String { l("profile.deleteAccountIntroBody", table: "Profile") }
        static var deleteAccountWarningTitle: String { l("profile.deleteAccountWarningTitle", table: "Profile") }
        static var deleteAccountWarningBody: String { l("profile.deleteAccountWarningBody", table: "Profile") }
        static var deleteAccountGraceTitle: String { l("profile.deleteAccountGraceTitle", table: "Profile") }
        static func deleteAccountGraceBody(_ days: Int) -> String { l("profile.deleteAccountGraceBody", table: "Profile", days) }
        static var deleteAccountConfirmTitle: String { l("profile.deleteAccountConfirmTitle", table: "Profile") }
        static var deleteAccountConfirmMessage: String { l("profile.deleteAccountConfirmMessage", table: "Profile") }
        static var deleteAccountConfirmAction: String { l("profile.deleteAccountConfirmAction", table: "Profile") }
        static var deleteAccountSubmittedTitle: String { l("profile.deleteAccountSubmittedTitle", table: "Profile") }
        static func deleteAccountSubmittedMessage(_ date: String) -> String { l("profile.deleteAccountSubmittedMessage", table: "Profile", date) }
        static var deleteAccountPendingTitle: String { l("profile.deleteAccountPendingTitle", table: "Profile") }
        static func deleteAccountPendingBody(_ date: String) -> String { l("profile.deleteAccountPendingBody", table: "Profile", date) }
        static var deleteAccountPendingNote: String { l("profile.deleteAccountPendingNote", table: "Profile") }
        static var deleteAccountCancelRequest: String { l("profile.deleteAccountCancelRequest", table: "Profile") }
        static var aboutTitle: String { l("profile.about.title", table: "Profile") }
        static var aboutWebsite: String { l("profile.about.website", table: "Profile") }
        static var aboutHelp: String { l("profile.about.help", table: "Profile") }
        static var aboutPrivacy: String { l("profile.about.privacy", table: "Profile") }
        static var aboutTerms: String { l("profile.about.terms", table: "Profile") }
        static var notificationsTitle: String { l("profile.notifications.title", table: "Profile") }
        static var notificationsPermission: String { l("profile.notifications.permission", table: "Profile") }
        static var notificationsEnabled: String { l("profile.notifications.enabled", table: "Profile") }
        static var notificationsDenied: String { l("profile.notifications.denied", table: "Profile") }
        static var notificationsOpenSettings: String { l("profile.notifications.openSettings", table: "Profile") }
        static var notificationsNotDetermined: String { l("profile.notifications.notDetermined", table: "Profile") }
        static var notificationsEnable: String { l("profile.notifications.enable", table: "Profile") }
        static var notificationsCategories: String { l("profile.notifications.categories", table: "Profile") }
        static var notificationsApprovalTitle: String { l("profile.notifications.approval.title", table: "Profile") }
        static var notificationsChatTitle: String { l("profile.notifications.chat.title", table: "Profile") }
        static var notificationsMentionsTitle: String { l("profile.notifications.mentions.title", table: "Profile") }
        static var notificationsTaskTitle: String { l("profile.notifications.task.title", table: "Profile") }
        static var notificationsSystemTitle: String { l("profile.notifications.system.title", table: "Profile") }
        static var voiceTitle: String { l("profile.voice.title", table: "Profile") }
        static var voiceAutoEnabled: String { l("profile.voice.autoEnabled", table: "Profile") }
        static var voicePlatformTitle: String { l("profile.voice.platform.title", table: "Profile") }
        static var voicePlatformDesc: String { l("profile.voice.platform.desc", table: "Profile") }
        static var voiceCategoryProduct: String { l("profile.voice.category.product", table: "Profile") }
        static var voiceCategoryAgent: String { l("profile.voice.category.agent", table: "Profile") }
        static var voiceCategoryFeature: String { l("profile.voice.category.feature", table: "Profile") }
        static var voiceAppContextTitle: String { l("profile.voice.appContext.title", table: "Profile") }
        static var voiceAppContextDesc: String { l("profile.voice.appContext.desc", table: "Profile") }
        static var voiceDialogContextTitle: String { l("profile.voice.dialogContext.title", table: "Profile") }
        static var voiceDialogContextDesc: String { l("profile.voice.dialogContext.desc", table: "Profile") }
        static var voiceHotwordHeader: String { l("profile.voice.hotword.header", table: "Profile") }
        static var voiceHotwordEmpty: String { l("profile.voice.hotword.empty", table: "Profile") }
        static var voiceHotwordPlaceholder: String { l("profile.voice.hotword.placeholder", table: "Profile") }
        static var voiceHotwordAdd: String { l("profile.voice.hotword.add", table: "Profile") }
        static var voiceReplacementHeader: String { l("profile.voice.replacement.header", table: "Profile") }
        static var voiceReplacementEmpty: String { l("profile.voice.replacement.empty", table: "Profile") }
        static var voiceReplacementFromPlaceholder: String { l("profile.voice.replacement.fromPlaceholder", table: "Profile") }
        static var voiceReplacementToPlaceholder: String { l("profile.voice.replacement.toPlaceholder", table: "Profile") }
        static var voiceReplacementAdd: String { l("profile.voice.replacement.add", table: "Profile") }
        static var usernameUnavailable: String { l("profile.usernameUnavailable", table: "Profile") }
        static var pending: String { l("profile.pending", table: "Profile") }
        static var editProfileAccessibility: String { l("profile.editProfileAccessibility", table: "Profile") }
        static var imageReadFailed: String { l("profile.imageReadFailed", table: "Profile") }
        static var imageProcessFailed: String { l("profile.imageProcessFailed", table: "Profile") }
        static var avatarUploadFailed: String { l("profile.avatarUploadFailed", table: "Profile") }

        static func nicknameTooLong(_ n: Int) -> String { l("profile.nicknameTooLong.format", table: "Profile", n) }
        static func bioTooLong(_ n: Int) -> String { l("profile.bioTooLong.format", table: "Profile", n) }
        static func aboutVersionFormat(_ version: String, _ build: String) -> String {
            l("profile.about.versionFormat", table: "Profile", version, build)
        }
    }

    enum Notifications {
        static var title: String { l("notifications.title", table: "Notifications") }
        static var loading: String { l("notifications.loading", table: "Notifications") }
        static var empty: String { l("notifications.empty", table: "Notifications") }
        static var emptyDescription: String { l("notifications.emptyDescription", table: "Notifications") }
        static var filteredEmpty: String { l("notifications.filteredEmpty", table: "Notifications") }
        static var filteredEmptyDescription: String { l("notifications.filteredEmptyDescription", table: "Notifications") }
        static var markAllRead: String { l("notifications.markAllRead", table: "Notifications") }
        static var noUnread: String { l("notifications.noUnread", table: "Notifications") }
        static var unknown: String { l("notifications.unknown", table: "Notifications") }
        static var openUnavailableTitle: String { l("notifications.openUnavailableTitle", table: "Notifications") }
        static var organizationUnavailable: String { l("notifications.organizationUnavailable", table: "Notifications") }
        static var chatScopeMissing: String { l("notifications.chatScopeMissing", table: "Notifications") }
        static var trackerScopeMissing: String { l("notifications.trackerScopeMissing", table: "Notifications") }
        static var artifactScopeMissing: String { l("notifications.artifactScopeMissing", table: "Notifications") }
        static var desktopOnlyArtifact: String { l("notifications.desktopOnlyArtifact", table: "Notifications") }
        static var sharedResourceUnavailable: String { l("notifications.sharedResourceUnavailable", table: "Notifications") }
        static var informationalNotice: String { l("notifications.informationalNotice", table: "Notifications") }
        static var messageUnavailableFallback: String { l("notifications.messageUnavailableFallback", table: "Notifications") }
        static var filterAll: String { l("notifications.filter.all", table: "Notifications") }
        static var filterPending: String { l("notifications.filter.pending", table: "Notifications") }
        static var filterTask: String { l("notifications.filter.task", table: "Notifications") }
        static var filterCollaboration: String { l("notifications.filter.collaboration", table: "Notifications") }
        static var filterOrganization: String { l("notifications.filter.organization", table: "Notifications") }
        static var filterSystem: String { l("notifications.filter.system", table: "Notifications") }
        static var sourceTabAgent: String { l("notifications.source.tabAgent", table: "Notifications") }
        static var sourceTabTracker: String { l("notifications.source.tabTracker", table: "Notifications") }
        static var sourceTabChat: String { l("notifications.source.tabChat", table: "Notifications") }
        static var sourceTabDoc: String { l("notifications.source.tabDoc", table: "Notifications") }
        static var sourceTabData: String { l("notifications.source.tabData", table: "Notifications") }
        static var sourceTabMail: String { l("notifications.source.tabMail", table: "Notifications") }
        static var sourceTabInbox: String { l("notifications.source.tabInbox", table: "Notifications") }
        static var sourceSharedResource: String { l("notifications.source.sharedResource", table: "Notifications") }
        static var sourceOrganization: String { l("notifications.source.organization", table: "Notifications") }
        static var sourceExtension: String { l("notifications.source.extension", table: "Notifications") }
        static var sourceSystem: String { l("notifications.source.system", table: "Notifications") }
        static var readStatusRead: String { l("notifications.readStatus.read", table: "Notifications") }
        static var readStatusUnread: String { l("notifications.readStatus.unread", table: "Notifications") }

        static func unreadCount(_ count: Int) -> String {
            l("notifications.unreadCount", table: "Notifications", count)
        }

        static func typeLabel(_ type: String) -> String {
            let keys: [String: String] = [
                "invite_received": "inviteReceived",
                "invite_accepted": "inviteAccepted",
                "member_added": "memberAdded",
                "member_removed": "memberRemoved",
                "role_changed": "roleChanged",
                "ownership_transfer": "ownershipTransfer",
                "resource_shared": "resourceShared",
                "resource_access_request": "resourceAccessRequest",
                "quota_warning": "quotaWarning",
                "balance_low": "balanceLow",
                "trash_expiry_warning": "trashExpiryWarning",
                "system": "system",
                "extension_event": "extensionEvent",
                "organization.invitation": "organizationInvitation",
                "organization.invitation.cancelled": "invitationCancelled",
                "organization.invitation.responded": "invitationResponded",
                "organization.invitation.sync": "invitationSync",
                "agent.hitl.waiting": "agentWaiting",
                "agent.task.completed": "agentCompleted",
                "agent.task.error": "agentError",
                "agent.task.interrupted": "agentInterrupted",
                "tabdoc.comment.mention": "commentMention",
                "tracker.run.started": "trackerStarted",
                "tracker.run.completed": "trackerCompleted",
                "tracker.run.failed": "trackerFailed",
                "tracker.health_alert": "trackerHealthAlert",
                "tracker.trigger.filtered": "trackerFiltered",
            ]
            guard let key = keys[type] else { return unknown }
            return l("notifications.type.\(key)", table: "Notifications")
        }
    }

    enum Debug {
        static var title: String { l("debug.title", table: "Profile") }
        static var entry: String { l("debug.entry", table: "Profile") }
        static var networkSection: String { l("debug.network.section", table: "Profile") }
        static var currentSection: String { l("debug.current.section", table: "Profile") }
        static var apiBaseURL: String { l("debug.apiBaseURL", table: "Profile") }
        static var wsBaseURL: String { l("debug.wsBaseURL", table: "Profile") }
        static var customAPIBaseURL: String { l("debug.customAPIBaseURL", table: "Profile") }
        static var customWSBaseURL: String { l("debug.customWSBaseURL", table: "Profile") }
        static var presetProduction: String { l("debug.preset.production", table: "Profile") }
        static var presetTest: String { l("debug.preset.test", table: "Profile") }
        static var presetCustom: String { l("debug.preset.custom", table: "Profile") }
        static var debugSwiftSection: String { l("debug.debugSwift.section", table: "Profile") }
        static var debugSwiftFloatingWindow: String { l("debug.debugSwift.floatingWindow", table: "Profile") }
        static var apply: String { l("debug.apply", table: "Profile") }
        static var reset: String { l("debug.reset", table: "Profile") }
        static var applied: String { l("debug.applied", table: "Profile") }
        static var invalidAPIURL: String { l("debug.invalidAPIURL", table: "Profile") }
        static var invalidWSURL: String { l("debug.invalidWSURL", table: "Profile") }
        static var sentrySection: String { l("debug.sentry.section", table: "Profile") }
        static var sentryDSN: String { l("debug.sentryDSN", table: "Profile") }
        static var sentryDSNHint: String { l("debug.sentryDSN.hint", table: "Profile") }
        static var invalidSentryDSN: String { l("debug.invalidSentryDSN", table: "Profile") }
        static var sentryApplied: String { l("debug.sentryApplied", table: "Profile") }
        static var scanQRCode: String { l("debug.scanQRCode", table: "Profile") }
        static var scanQRCodeHint: String { l("debug.scanQRCode.hint", table: "Profile") }
        static var scanTitle: String { l("debug.scan.title", table: "Profile") }
        static var scanPrompt: String { l("debug.scan.prompt", table: "Profile") }
        static var scanSucceeded: String { l("debug.scan.succeeded", table: "Profile") }
        static var invalidQRCode: String { l("debug.scan.invalid", table: "Profile") }
        static func projectDefault(_ url: String) -> String { l("debug.projectDefault.format", table: "Profile", url) }
    }

    enum Workspace {
        static var create: String { l("workspace.create", table: "Workspace") }
        static var createTitle: String { l("workspace.createTitle", table: "Workspace") }
        static var createAction: String { l("workspace.createAction", table: "Workspace") }
        static var namePlaceholder: String { l("workspace.namePlaceholder", table: "Workspace") }
        static var descriptionPlaceholder: String { l("workspace.descriptionPlaceholder", table: "Workspace") }
        static var team: String { l("workspace.team", table: "Workspace") }
        static var teamInfo: String { l("workspace.teamInfo", table: "Workspace") }
        static var teamName: String { l("workspace.teamName", table: "Workspace") }
        static var teamDescription: String { l("workspace.teamDescription", table: "Workspace") }
        static var teamIconPlaceholder: String { l("workspace.teamIconPlaceholder", table: "Workspace") }
        static var createTeam: String { l("workspace.createTeam", table: "Workspace") }
        static var teamInvitation: String { l("workspace.teamInvitation", table: "Workspace") }
        static var invitationManagement: String { l("workspace.invitationManagement", table: "Workspace") }
        static var inviteMembers: String { l("workspace.inviteMembers", table: "Workspace") }
        static var email: String { l("workspace.email", table: "Workspace") }
        static var role: String { l("workspace.role", table: "Workspace") }
        static var sendEmailInvitation: String { l("workspace.sendEmailInvitation", table: "Workspace") }
        static var pendingInvitations: String { l("workspace.pendingInvitations", table: "Workspace") }
        static var noPendingInvitations: String { l("workspace.noPendingInvitations", table: "Workspace") }
        static var acceptInvitation: String { l("workspace.acceptInvitation", table: "Workspace") }
        static var rejectInvitation: String { l("workspace.rejectInvitation", table: "Workspace") }
        static var invitationExpired: String { l("workspace.invitationExpired", table: "Workspace") }
        static var invitationInvalid: String { l("workspace.invitationInvalid", table: "Workspace") }
        static var joinWorkspace: String { l("workspace.joinWorkspace", table: "Workspace") }
        static var invitedToWorkspace: String { l("workspace.invitedToWorkspace", table: "Workspace") }
        static var teamSettings: String { l("workspace.teamSettings", table: "Workspace") }
        static var basicInfo: String { l("workspace.basicInfoTitle", table: "Workspace") }
        static var members: String { l("workspace.membersLabel", table: "Workspace") }
        static var spacesLabel: String { l("workspace.spacesLabel", table: "Workspace") }
        static var capabilitiesTitle: String { l("workspace.capabilitiesTitle", table: "Workspace") }
        static var usageTitle: String { l("workspace.usageTitle", table: "Workspace") }
        static var walletTitle: String { l("workspace.walletTitle", table: "Workspace") }
        static var usageCurrentMonth: String { l("workspace.usageCurrentMonth", table: "Workspace") }
        static var usageLastMonth: String { l("workspace.usageLastMonth", table: "Workspace") }
        static var usageMonthOverMonth: String { l("workspace.usageMonthOverMonth", table: "Workspace") }
        static var usageMeterDistribution: String { l("workspace.usageMeterDistribution", table: "Workspace") }
        static var usageModelTop: String { l("workspace.usageModelTop", table: "Workspace") }
        static var usageModelEmpty: String { l("workspace.usageModelEmpty", table: "Workspace") }
        static var usageEmpty: String { l("workspace.usageEmpty", table: "Workspace") }
        static func usageCredits(_ value: String) -> String {
            l("workspace.usageCredits", table: "Workspace", value)
        }
        static func usageCallCount(_ count: Int) -> String {
            l("workspace.usageCallCount", table: "Workspace", count)
        }
        static var dataRecoveryTitle: String { l("workspace.dataRecoveryTitle", table: "Workspace") }
        static var dataRecoveryDescription: String { l("workspace.dataRecoveryDescription", table: "Workspace") }
        static var transferOwnership: String { l("workspace.transferOwnership", table: "Workspace") }
        static var transferOwnershipDescription: String { l("workspace.transferOwnershipDescription", table: "Workspace") }
        static var defaultTeam: String { l("workspace.defaultTeam", table: "Workspace") }
        static var cannotDelete: String { l("workspace.cannotDelete", table: "Workspace") }
        static var deleteTeam: String { l("workspace.deleteTeam", table: "Workspace") }
        static var deleteTeamDesc: String { l("workspace.deleteTeamDesc", table: "Workspace") }
        static var leaveTeam: String { l("workspace.leaveTeam", table: "Workspace") }
        static var leaveTeamDesc: String { l("workspace.leaveTeamDesc", table: "Workspace") }
        static var deleteTeamConfirm: String { l("workspace.deleteTeamConfirm", table: "Workspace") }
        static var leaveTeamConfirm: String { l("workspace.leaveTeamConfirm", table: "Workspace") }
        static var selectSpace: String { l("workspace.selectSpace", table: "Workspace") }
        static var loadingSpace: String { l("workspace.loadingSpace", table: "Workspace") }
        static var noSpaces: String { l("workspace.noSpaces", table: "Workspace") }
        static var noSpacesDesc: String { l("workspace.noSpacesDesc", table: "Workspace") }
        static var refresh: String { l("workspace.refresh", table: "Workspace") }
        static var personalIdentity: String { l("workspace.personalIdentity", table: "Workspace") }
        static var switchOrganization: String { l("workspace.switchOrganization", table: "Workspace") }
        static var owner: String { l("workspace.role.owner", table: "Workspace") }
        static var admin: String { l("workspace.role.admin", table: "Workspace") }
        static var editor: String { l("workspace.role.editor", table: "Workspace") }
        static var viewer: String { l("workspace.role.viewer", table: "Workspace") }
        static var unknown: String { l("workspace.role.unknown", table: "Workspace") }

        static func invitedAs(_ role: String) -> String { l("workspace.invitedAs", table: "Workspace", role) }
        static func invitedByAs(_ name: String, _ role: String) -> String { l("workspace.invitedByAs", table: "Workspace", name, role) }
    }

    enum MemoAppHome {
        static var statusActive: String { l("memoAppHome.statusActive", table: "Common") }
        static var statusArchived: String { l("memoAppHome.statusArchived", table: "Common") }
        static var personalMemo: String { l("memoAppHome.personalMemo", table: "Common") }
        static var agentPenLabel: String { l("memoAppHome.agentPenLabel", table: "Common") }
        static var emptyMemoTitle: String { l("memoAppHome.emptyMemoTitle", table: "Common") }
        static var pinned: String { l("memoAppHome.pinned", table: "Common") }
        static var pin: String { l("memoAppHome.pin", table: "Common") }
        static var unpin: String { l("memoAppHome.unpin", table: "Common") }
        static var moveToTrash: String { l("memoAppHome.moveToTrash", table: "Common") }
        static var archive: String { l("memoAppHome.archive", table: "Common") }
        static var restore: String { l("memoAppHome.restore", table: "Common") }
        static var openHint: String { l("memoAppHome.openHint", table: "Common") }
        static var searchPlaceholder: String { l("memoAppHome.searchPlaceholder", table: "Common") }
        static var viewAll: String { l("memoAppHome.viewAll", table: "Common") }
        static var viewToday: String { l("memoAppHome.viewToday", table: "Common") }
        static var viewAgentDiary: String { l("memoAppHome.viewAgentDiary", table: "Common") }
        static var sectionPinned: String { l("memoAppHome.sectionPinned", table: "Common") }
        static var sectionToday: String { l("memoAppHome.sectionToday", table: "Common") }
        static var sectionYesterday: String { l("memoAppHome.sectionYesterday", table: "Common") }
        static var sectionThisWeek: String { l("memoAppHome.sectionThisWeek", table: "Common") }
        static var sectionOlder: String { l("memoAppHome.sectionOlder", table: "Common") }
        static var emptyTitle: String { l("memoAppHome.emptyTitle", table: "Common") }
        static var emptySubtitle: String { l("memoAppHome.emptySubtitle", table: "Common") }
        static var emptyTodayTitle: String { l("memoAppHome.emptyTodayTitle", table: "Common") }
        static var emptyTodaySubtitle: String { l("memoAppHome.emptyTodaySubtitle", table: "Common") }
        static var emptyDiaryTitle: String { l("memoAppHome.emptyDiaryTitle", table: "Common") }
        static var emptyDiarySubtitle: String { l("memoAppHome.emptyDiarySubtitle", table: "Common") }
        static var searchEmptyTitle: String { l("memoAppHome.searchEmptyTitle", table: "Common") }
        static var searchEmptySubtitle: String { l("memoAppHome.searchEmptySubtitle", table: "Common") }
        static var loadFailed: String { l("memoAppHome.loadFailed", table: "Common") }
        static var loadingDetail: String { l("memoAppHome.loadingDetail", table: "Common") }
        static var detailTitle: String { l("memoAppHome.detailTitle", table: "Common") }
        static var operationFailed: String { l("memoAppHome.operationFailed", table: "Common") }
        static var hintTitle: String { l("memoAppHome.hintTitle", table: "Common") }
        static var tagsSection: String { l("memoAppHome.tagsSection", table: "Common") }
        static var aiTagsSection: String { l("memoAppHome.aiTagsSection", table: "Common") }
        static var retag: String { l("memoAppHome.retag", table: "Common") }
        static var retagUpdated: String { l("memoAppHome.retagUpdated", table: "Common") }
        static var retagPending: String { l("memoAppHome.retagPending", table: "Common") }
        static var quickComposerTitle: String { l("memoAppHome.quickComposerTitle", table: "Common") }
        static var quickComposerPlaceholder: String { l("memoAppHome.quickComposerPlaceholder", table: "Common") }
        static var tagsPlaceholder: String { l("memoAppHome.tagsPlaceholder", table: "Common") }
        static var save: String { l("memoAppHome.save", table: "Common") }
        static var saveBusy: String { l("memoAppHome.saveBusy", table: "Common") }
        static var attachFile: String { l("memoAppHome.attachFile", table: "Common") }
        static var attachmentRetry: String { l("memoAppHome.attachmentRetry", table: "Common") }
        static var attachmentFailedKeepBody: String { l("memoAppHome.attachmentFailedKeepBody", table: "Common") }
        static var clearAttachment: String { l("memoAppHome.clearAttachment", table: "Common") }
        static var colorPicker: String { l("memoAppHome.colorPicker", table: "Common") }
        static var colorNone: String { l("memoAppHome.colorNone", table: "Common") }
        static var colorYellow: String { l("memoAppHome.colorYellow", table: "Common") }
        static var colorBlue: String { l("memoAppHome.colorBlue", table: "Common") }
        static var colorGreen: String { l("memoAppHome.colorGreen", table: "Common") }
        static var colorPink: String { l("memoAppHome.colorPink", table: "Common") }
        static var colorPurple: String { l("memoAppHome.colorPurple", table: "Common") }
        static var colorOrange: String { l("memoAppHome.colorOrange", table: "Common") }
        static var colorGray: String { l("memoAppHome.colorGray", table: "Common") }
        static var clearDayFilter: String { l("memoAppHome.clearDayFilter", table: "Common") }

        static func monthCount(_ count: Int) -> String {
            l("memoAppHome.monthCount", table: "Common", count)
        }

        static func heatmapDay(_ date: String, _ count: Int) -> String {
            l("memoAppHome.heatmapDay", table: "Common", date, count)
        }

        static func heatmapEmptyDay(_ date: String) -> String {
            l("memoAppHome.heatmapEmptyDay", table: "Common", date)
        }
    }

    enum WorkbenchAppHome {
        static var backToWorkbench: String { l("workbenchAppHome.backToWorkbench", table: "Common") }
        static var docTitle: String { l("workbenchAppHome.docTitle", table: "Common") }
        static var tableTitle: String { l("workbenchAppHome.tableTitle", table: "Common") }
        static var continueWrite: String { l("workbenchAppHome.continueWrite", table: "Common") }
        static var continueHandle: String { l("workbenchAppHome.continueHandle", table: "Common") }
        static var agentDraft: String { l("workbenchAppHome.agentDraft", table: "Common") }
        static var agentBuild: String { l("workbenchAppHome.agentBuild", table: "Common") }
        static var agentDraftSubtitle: String { l("workbenchAppHome.agentDraftSubtitle", table: "Common") }
        static var agentBuildSubtitle: String { l("workbenchAppHome.agentBuildSubtitle", table: "Common") }
        static var blankDoc: String { l("workbenchAppHome.blankDoc", table: "Common") }
        static var blankTable: String { l("workbenchAppHome.blankTable", table: "Common") }
        static var blankDocSubtitle: String { l("workbenchAppHome.blankDocSubtitle", table: "Common") }
        static var blankTableSubtitle: String { l("workbenchAppHome.blankTableSubtitle", table: "Common") }
        static var blankCreateHint: String { l("workbenchAppHome.blankCreateHint", table: "Common") }
        static var blankCreateSessionMissing: String { l("workbenchAppHome.blankCreateSessionMissing", table: "Common") }
        static var blankCreateFailed: String { l("workbenchAppHome.blankCreateFailed", table: "Common") }
        static var agentHint: String { l("workbenchAppHome.agentHint", table: "Common") }
        static var sectionTaskContent: String { l("workbenchAppHome.sectionTaskContent", table: "Common") }
        static var searchPlaceholder: String { l("workbenchAppHome.searchPlaceholder", table: "Common") }
        static var searchDocPlaceholder: String { l("workbenchAppHome.searchDocPlaceholder", table: "Common") }
        static var searchTablePlaceholder: String { l("workbenchAppHome.searchTablePlaceholder", table: "Common") }
        static var resumeRecent: String { l("workbenchAppHome.resumeRecent", table: "Common") }
        static var resumeTask: String { l("workbenchAppHome.resumeTask", table: "Common") }
        static var collaborationLoading: String { l("workbenchAppHome.collaboration.loading", table: "Common") }
        static var collaboratorFallbackName: String { l("workbenchAppHome.collaboration.fallbackName", table: "Common") }
        static var searchEmptyTitle: String { l("workbenchAppHome.searchEmptyTitle", table: "Common") }
        static var searchEmptySubtitle: String { l("workbenchAppHome.searchEmptySubtitle", table: "Common") }
        static var emptySubtitle: String { l("workbenchAppHome.emptySubtitle", table: "Common") }
        static var syncing: String { l("workbenchAppHome.syncing", table: "Common") }
        static var syncingA11y: String { l("workbenchAppHome.syncingA11y", table: "Common") }
        static var openHint: String { l("workbenchAppHome.openHint", table: "Common") }
        static var libraryDocs: String { l("workbenchAppHome.library.docs", table: "Common") }
        static var libraryTables: String { l("workbenchAppHome.library.tables", table: "Common") }
        static var knowledgeBase: String { l("workbenchAppHome.library.knowledgeBase", table: "Common") }
        static var viewAll: String { l("workbenchAppHome.library.viewAll", table: "Common") }
        static var openLibraryHubHint: String { l("workbenchAppHome.library.openHubHint", table: "Common") }
        static var libraryScope: String { l("workbenchAppHome.library.scope", table: "Common") }
        static var clearSearch: String { l("workbenchAppHome.clearSearch", table: "Common") }
        static var loadingTaskContent: String { l("workbenchAppHome.loadingTaskContent", table: "Common") }
        static var pinned: String { l("workbenchAppHome.pinned", table: "Common") }
        static var noViewPermission: String { l("workbenchAppHome.noViewPermission", table: "Common") }
        static var librarySearchEmptySubtitle: String { l("workbenchAppHome.library.empty.search.subtitle", table: "Common") }
        static var libraryRecentEmptySubtitle: String { l("workbenchAppHome.library.empty.recent.subtitle", table: "Common") }
        static var libraryAllEmptySubtitle: String { l("workbenchAppHome.library.empty.all.subtitle", table: "Common") }
        static var librarySharedEmptySubtitle: String { l("workbenchAppHome.library.empty.shared.subtitle", table: "Common") }
        static var continuePreviewHint: String { l("workbenchAppHome.continuePreviewHint", table: "Common") }
        static var documentPreviewUnavailable: String { l("workbenchAppHome.preview.document.unavailable", table: "Common") }
        static var documentPreviewType: String { l("workbenchAppHome.preview.document.type", table: "Common") }
        static var tablePreviewUnavailable: String { l("workbenchAppHome.preview.table.unavailable", table: "Common") }
        static var tablePreviewType: String { l("workbenchAppHome.preview.table.type", table: "Common") }
        static var tableRowsUnavailable: String { l("workbenchAppHome.preview.table.rowsUnavailable", table: "Common") }
        static var previewLater: String { l("workbenchAppHome.preview.later", table: "Common") }

        static func itemCount(_ count: Int) -> String {
            l("workbenchAppHome.itemCount", table: "Common", count)
        }

        static func collaborationPeople(_ count: Int) -> String {
            l("workbenchAppHome.collaboration.count", table: "Common", count)
        }

        static func maintainedBy(_ name: String) -> String {
            l("workbenchAppHome.collaboration.maintainedBy", table: "Common", name)
        }

        static func emptyTitle(_ appName: String) -> String {
            l("workbenchAppHome.emptyTitle", table: "Common", appName)
        }

        static func loadingLibrary(_ libraryName: String) -> String {
            l("workbenchAppHome.library.loading.named", table: "Common", libraryName)
        }

        static func openNamed(_ title: String) -> String {
            l("workbenchAppHome.open.named", table: "Common", title)
        }

        static func continuePreviewNamed(_ action: String, title: String) -> String {
            l("workbenchAppHome.continuePreview.named", table: "Common", action, title)
        }

        static func librarySearchEmpty(_ appName: String) -> String {
            l("workbenchAppHome.library.empty.search.named", table: "Common", appName)
        }

        static func libraryRecentEmpty(_ appName: String) -> String {
            l("workbenchAppHome.library.empty.recent.named", table: "Common", appName)
        }

        static func libraryAllEmpty(_ appName: String) -> String {
            l("workbenchAppHome.library.empty.all.named", table: "Common", appName)
        }

        static func librarySharedEmpty(_ appName: String) -> String {
            l("workbenchAppHome.library.empty.shared.named", table: "Common", appName)
        }

        static func recordCount(_ count: Int) -> String {
            let key = count == 1
                ? "workbenchAppHome.preview.recordCount.one"
                : "workbenchAppHome.preview.recordCount.other"
            return l(key, table: "Common", count)
        }

        static func fieldCount(_ count: Int) -> String {
            let key = count == 1
                ? "workbenchAppHome.preview.fieldCount.one"
                : "workbenchAppHome.preview.fieldCount.other"
            return l(key, table: "Common", count)
        }
    }

    enum CloudDocs {
        static var untitled: String { l("cloudDocs.untitled", table: "Common") }
        static var sharedLoadFailed: String { l("cloudDocs.sharedLoadFailed", table: "Common") }
        static var browseAll: String { l("cloudDocs.browse.all", table: "Common") }
        static var browseRecent: String { l("cloudDocs.browse.recent", table: "Common") }
        static var browseShared: String { l("cloudDocs.browse.shared", table: "Common") }
        static var expand: String { l("cloudDocs.expand", table: "Common") }
        static var collapse: String { l("cloudDocs.collapse", table: "Common") }
        static var searchPlaceholder: String { l("cloudDocs.searchPlaceholder", table: "Common") }
        static var emptyAll: String { l("cloudDocs.empty.all", table: "Common") }
        static var emptyRecent: String { l("cloudDocs.empty.recent", table: "Common") }
        static var emptyShared: String { l("cloudDocs.empty.shared", table: "Common") }
        static var emptySearch: String { l("cloudDocs.empty.search", table: "Common") }
        static var actionPin: String { l("cloudDocs.action.pin", table: "Common") }
        static var actionUnpin: String { l("cloudDocs.action.unpin", table: "Common") }
        static var actionDelete: String { l("cloudDocs.action.delete", table: "Common") }
        static var actionNewDoc: String { l("cloudDocs.action.newDoc", table: "Common") }
        static var actionNewTable: String { l("cloudDocs.action.newTable", table: "Common") }
        static func recentlyAccessedAt(_ time: String) -> String {
            l("cloudDocs.recentlyAccessedAt", table: "Common", time)
        }
        static func recentlyModifiedAt(_ time: String) -> String {
            l("cloudDocs.recentlyModifiedAt", table: "Common", time)
        }

        // MARK: 发送到私信

        static var directMessageAction: String { l("cloudDocs.directMessage.action", table: "Common") }
        static var directMessageTitle: String { l("cloudDocs.directMessage.title", table: "Common") }
        static var directMessageSection: String { l("cloudDocs.directMessage.section", table: "Common") }
        static var directMessageFooter: String { l("cloudDocs.directMessage.footer", table: "Common") }
        static var directMessageSearchPlaceholder: String { l("cloudDocs.directMessage.searchPlaceholder", table: "Common") }
        static var directMessageSendAction: String { l("cloudDocs.directMessage.sendAction", table: "Common") }
        static var directMessageLoadingMembers: String { l("cloudDocs.directMessage.loadingMembers", table: "Common") }
        static var directMessageSearching: String { l("cloudDocs.directMessage.searching", table: "Common") }
        static var directMessageNoMembers: String { l("cloudDocs.directMessage.noMembers", table: "Common") }
        static var directMessageNoSearchResults: String { l("cloudDocs.directMessage.noSearchResults", table: "Common") }
        static var directMessageLoadFailed: String { l("cloudDocs.directMessage.loadFailed", table: "Common") }
        static var directMessageSearchFailed: String { l("cloudDocs.directMessage.searchFailed", table: "Common") }
        static var directMessageCannotIdentifyUser: String { l("cloudDocs.directMessage.cannotIdentifyUser", table: "Common") }
        static var directMessageMemberFallback: String { l("cloudDocs.directMessage.memberFallback", table: "Common") }
        static var directMessageSelected: String { l("cloudDocs.directMessage.selected", table: "Common") }
        static var directMessageUnselected: String { l("cloudDocs.directMessage.unselected", table: "Common") }
        static var directMessageConversationUnavailable: String { l("cloudDocs.directMessage.conversationUnavailable", table: "Common") }
        static var directMessageAccessGrantFailed: String { l("cloudDocs.directMessage.accessGrantFailed", table: "Common") }
        static var directMessageMessagingUnavailable: String { l("cloudDocs.directMessage.messagingUnavailable", table: "Common") }
        static var directMessageSendFailed: String { l("cloudDocs.directMessage.sendFailed", table: "Common") }
        static var directMessageSendUnconfirmed: String { l("cloudDocs.directMessage.sendUnconfirmed", table: "Common") }
        static var directMessageSendInFlight: String { l("cloudDocs.directMessage.sendInFlight", table: "Common") }
        static var directMessageTitleTooLong: String { l("cloudDocs.directMessage.titleTooLong", table: "Common") }
        static var directMessageReadOnly: String { l("cloudDocs.directMessage.readOnly", table: "Common") }

        static func sharedBy(_ name: String) -> String { l("cloudDocs.sharedBy", table: "Common", name) }
        static var sharedByPrefix: String { l("cloudDocs.sharedBy.prefix", table: "Common") }
        static var sharedBySuffix: String { l("cloudDocs.sharedBy.suffix", table: "Common") }

        // MARK: 分享设置

        static var shareTitle: String { l("cloudDocs.share.title", table: "Common") }
        static var shareAction: String { l("cloudDocs.share.action", table: "Common") }
        static var shareLinkToggle: String { l("cloudDocs.share.linkToggle", table: "Common") }
        static var shareLinkOffHint: String { l("cloudDocs.share.linkOffHint", table: "Common") }
        static var shareScopeSection: String { l("cloudDocs.share.scopeSection", table: "Common") }
        static var shareScopeOrganization: String { l("cloudDocs.share.scope.organization", table: "Common") }
        static var shareScopeAnyone: String { l("cloudDocs.share.scope.anyone", table: "Common") }
        static var shareScopeOrganizationHint: String { l("cloudDocs.share.scope.organizationHint", table: "Common") }
        static var shareScopeAnyoneHint: String { l("cloudDocs.share.scope.anyoneHint", table: "Common") }
        static var sharePermissionSection: String { l("cloudDocs.share.permissionSection", table: "Common") }
        static var sharePermissionView: String { l("cloudDocs.share.permission.view", table: "Common") }
        static var sharePermissionComment: String { l("cloudDocs.share.permission.comment", table: "Common") }
        static var sharePermissionEdit: String { l("cloudDocs.share.permission.edit", table: "Common") }
        static var sharePasswordSection: String { l("cloudDocs.share.passwordSection", table: "Common") }
        static var sharePasswordPlaceholder: String { l("cloudDocs.share.passwordPlaceholder", table: "Common") }
        static var sharePasswordSet: String { l("cloudDocs.share.passwordSet", table: "Common") }
        static var sharePasswordApply: String { l("cloudDocs.share.passwordApply", table: "Common") }
        static var sharePasswordClear: String { l("cloudDocs.share.passwordClear", table: "Common") }
        static var shareLinkSection: String { l("cloudDocs.share.linkSection", table: "Common") }
        static var shareCopyLink: String { l("cloudDocs.share.copyLink", table: "Common") }
        static var shareLinkCopied: String { l("cloudDocs.share.linkCopied", table: "Common") }
        static var shareRefreshLink: String { l("cloudDocs.share.refreshLink", table: "Common") }
        static var shareRefreshConfirmTitle: String { l("cloudDocs.share.refreshConfirmTitle", table: "Common") }
        static var shareRefreshConfirmMessage: String { l("cloudDocs.share.refreshConfirmMessage", table: "Common") }
        static var shareAnyoneConfirmTitle: String { l("cloudDocs.share.anyoneConfirmTitle", table: "Common") }
        static var shareAnyoneConfirmMessage: String { l("cloudDocs.share.anyoneConfirmMessage", table: "Common") }
        static var shareAnyoneConfirmAction: String { l("cloudDocs.share.anyoneConfirmAction", table: "Common") }
        static var shareLoadFailed: String { l("cloudDocs.share.loadFailed", table: "Common") }
        static var shareUpdateFailed: String { l("cloudDocs.share.updateFailed", table: "Common") }
        static var shareForbidden: String { l("cloudDocs.share.forbidden", table: "Common") }
        static func shareVisitCount(_ count: Int) -> String {
            l("cloudDocs.share.visitCount", table: "Common", count)
        }
    }

    enum TabDoc {
        static var loading: String { l("tabDoc.loading", table: "TabDoc") }
        static var titlePlaceholder: String { l("tabDoc.titlePlaceholder", table: "TabDoc") }
        static var readOnly: String { l("tabDoc.readOnly", table: "TabDoc") }
        static var complexContentTitle: String { l("tabDoc.complexContent.title", table: "TabDoc") }
        static var complexContentMessage: String { l("tabDoc.complexContent.message", table: "TabDoc") }
        static var partialReadOnlyContentTitle: String {
            l("tabDoc.partialReadOnlyContent.title", table: "TabDoc")
        }
        static var partialReadOnlyContentMessage: String {
            l("tabDoc.partialReadOnlyContent.message", table: "TabDoc")
        }
        static var complexTableContentTitle: String { l("tabDoc.complexTableContent.title", table: "TabDoc") }
        static var complexTableContentMessage: String { l("tabDoc.complexTableContent.message", table: "TabDoc") }
        static var openFullEditor: String { l("tabDoc.openFullEditor", table: "TabDoc") }
        static var undo: String { l("tabDoc.undo", table: "TabDoc") }
        static var redo: String { l("tabDoc.redo", table: "TabDoc") }
        static var emptyEditable: String { l("tabDoc.empty.editable", table: "TabDoc") }
        static var emptyReadOnly: String { l("tabDoc.empty.readOnly", table: "TabDoc") }
        static var addBlock: String { l("tabDoc.addBlock", table: "TabDoc") }
        static var saveNow: String { l("tabDoc.saveNow", table: "TabDoc") }
        static var blockParagraph: String { l("tabDoc.block.paragraph", table: "TabDoc") }
        static var blockHeading: String { l("tabDoc.block.heading", table: "TabDoc") }
        static var blockBullet: String { l("tabDoc.block.bullet", table: "TabDoc") }
        static var blockOrdered: String { l("tabDoc.block.ordered", table: "TabDoc") }
        static var blockTask: String { l("tabDoc.block.task", table: "TabDoc") }
        static var blockQuote: String { l("tabDoc.block.quote", table: "TabDoc") }
        static var blockCode: String { l("tabDoc.block.code", table: "TabDoc") }
        static var blockImage: String { l("tabDoc.block.image", table: "TabDoc") }
        static var blockTable: String { l("tabDoc.block.table", table: "TabDoc") }
        static var blockDivider: String { l("tabDoc.block.divider", table: "TabDoc") }
        static var blockPlaceholder: String { l("tabDoc.block.placeholder", table: "TabDoc") }
        static var listItemPlaceholder: String { l("tabDoc.listItem.placeholder", table: "TabDoc") }
        static var tableCellPlaceholder: String { l("tabDoc.tableCell.placeholder", table: "TabDoc") }
        static var unsupportedBlock: String { l("tabDoc.block.unsupported", table: "TabDoc") }
        static var unsupportedWhiteboard: String { l("tabDoc.block.unsupported.whiteboard", table: "TabDoc") }
        static var unsupportedEmbeddedTable: String { l("tabDoc.block.unsupported.embeddedTable", table: "TabDoc") }
        static var unsupportedEmbeddedHTML: String { l("tabDoc.block.unsupported.embeddedHTML", table: "TabDoc") }
        static var unsupportedVideo: String { l("tabDoc.block.unsupported.video", table: "TabDoc") }
        static var addBelow: String { l("tabDoc.addBelow", table: "TabDoc") }
        static var duplicateBlock: String { l("tabDoc.blockAction.duplicate", table: "TabDoc") }
        static var copyText: String { l("tabDoc.blockAction.copyText", table: "TabDoc") }
        static var convertBlock: String { l("tabDoc.blockAction.convert", table: "TabDoc") }
        static var moveBlockUp: String { l("tabDoc.blockAction.moveUp", table: "TabDoc") }
        static var moveBlockDown: String { l("tabDoc.blockAction.moveDown", table: "TabDoc") }
        static func headingLevel(_ level: Int) -> String {
            l("tabDoc.block.headingLevel", table: "TabDoc", level)
        }
        static var addListItem: String { l("tabDoc.listItem.add", table: "TabDoc") }
        static var listItemIndent: String { l("tabDoc.listItem.indent", table: "TabDoc") }
        static var listItemOutdent: String { l("tabDoc.listItem.outdent", table: "TabDoc") }
        static var taskChecked: String { l("tabDoc.task.checked", table: "TabDoc") }
        static var taskUnchecked: String { l("tabDoc.task.unchecked", table: "TabDoc") }
        static var addTableRow: String { l("tabDoc.table.addRow", table: "TabDoc") }
        static var addTableColumn: String { l("tabDoc.table.addColumn", table: "TabDoc") }
        static func tableSummary(_ rows: Int, _ columns: Int) -> String {
            l("tabDoc.table.summary", table: "TabDoc", rows, columns)
        }
        static var tableReadOnlyPreview: String { l("tabDoc.table.readOnlyPreview", table: "TabDoc") }
        static func tableProjectedCellsReadOnly(_ count: Int) -> String {
            l("tabDoc.table.projectedCellsReadOnly", table: "TabDoc", count)
        }
        static var tableSwipeHint: String { l("tabDoc.table.swipeHint", table: "TabDoc") }
        static var tableActions: String { l("tabDoc.table.actions", table: "TabDoc") }
        static var copyTable: String { l("tabDoc.table.copy", table: "TabDoc") }
        static var insertTableRowBelow: String {
            l("tabDoc.table.insertRowBelow", table: "TabDoc")
        }
        static var insertTableColumnRight: String {
            l("tabDoc.table.insertColumnRight", table: "TabDoc")
        }
        static var copyTableCell: String { l("tabDoc.tableCell.copy", table: "TabDoc") }
        static var copyTableRow: String { l("tabDoc.tableCell.copyRow", table: "TabDoc") }
        static var copyTableColumn: String { l("tabDoc.tableCell.copyColumn", table: "TabDoc") }
        static var tableCellEditable: String { l("tabDoc.tableCell.editable", table: "TabDoc") }
        static var tableCellComplexReadOnly: String {
            l("tabDoc.tableCell.complexReadOnly", table: "TabDoc")
        }
        static var tableCellEmpty: String { l("tabDoc.tableCell.empty", table: "TabDoc") }
        static var tableCellEditHint: String { l("tabDoc.tableCell.editHint", table: "TabDoc") }
        static var tableCellOpenHint: String { l("tabDoc.tableCell.openHint", table: "TabDoc") }
        static func tableCellPosition(_ row: Int, _ column: Int) -> String {
            l("tabDoc.tableCell.position", table: "TabDoc", row, column)
        }
        static var imageLoadFailed: String { l("tabDoc.image.loadFailed", table: "TabDoc") }
        static var imageDefaultAlt: String { l("tabDoc.image.defaultAlt", table: "TabDoc") }
        static var saveIdle: String { l("tabDoc.save.idle", table: "TabDoc") }
        static var saveDirty: String { l("tabDoc.save.dirty", table: "TabDoc") }
        static var saving: String { l("tabDoc.save.saving", table: "TabDoc") }
        static var saved: String { l("tabDoc.save.saved", table: "TabDoc") }
        static var saveConflict: String { l("tabDoc.save.conflict", table: "TabDoc") }
        static var saveFailed: String { l("tabDoc.save.failed", table: "TabDoc") }
        static var saveFailedTitle: String { l("tabDoc.save.failedTitle", table: "TabDoc") }
        static var conflictMessage: String { l("tabDoc.save.conflictMessage", table: "TabDoc") }
        static var discardDraftAndReload: String { l("tabDoc.save.discardDraftAndReload", table: "TabDoc") }
        static var permissionMessage: String { l("tabDoc.save.permissionMessage", table: "TabDoc") }
        static var fullEditorDraftWarningTitle: String { l("tabDoc.fullEditorDraftWarning.title", table: "TabDoc") }
        static var fullEditorDraftWarningMessage: String { l("tabDoc.fullEditorDraftWarning.message", table: "TabDoc") }
        static var fullEditorDiscardAndOpen: String { l("tabDoc.fullEditorDraftWarning.discardAndOpen", table: "TabDoc") }
        static var fullEditorSaveRequired: String { l("tabDoc.fullEditorSaveRequired", table: "TabDoc") }
        static var localDraftTitle: String { l("tabDoc.localDraft.title", table: "TabDoc") }
        static var localDraftMessage: String { l("tabDoc.localDraft.message", table: "TabDoc") }
        static var localDraftEmpty: String { l("tabDoc.localDraft.empty", table: "TabDoc") }
        static var localDraftCopy: String { l("tabDoc.localDraft.copy", table: "TabDoc") }
        static var localDraftCopied: String { l("tabDoc.localDraft.copied", table: "TabDoc") }
        static var versionHistory: String { l("tabDoc.versionHistory", table: "TabDoc") }
        static var versionLoadFailed: String { l("tabDoc.versionLoadFailed", table: "TabDoc") }
        static var versionRestored: String { l("tabDoc.versionRestored", table: "TabDoc") }
        static var versionRestoreFailed: String { l("tabDoc.versionRestoreFailed", table: "TabDoc") }
        static var versionRestore: String { l("tabDoc.versionRestore", table: "TabDoc") }
        static var versionEmpty: String { l("tabDoc.versionEmpty", table: "TabDoc") }
        static var versionSnapshot: String { l("tabDoc.versionSnapshot", table: "TabDoc") }
        static var versionUnnamed: String { l("tabDoc.versionUnnamed", table: "TabDoc") }
        static var commentsTitle: String { l("tabDoc.comments.title", table: "TabDoc") }
        static var commentPlaceholder: String { l("tabDoc.comment.placeholder", table: "TabDoc") }
        static var commentAdd: String { l("tabDoc.comment.add", table: "TabDoc") }
        static var commentBlock: String { l("tabDoc.comment.block", table: "TabDoc") }
        static var commentDocument: String { l("tabDoc.comment.document", table: "TabDoc") }
        static var commentOrphaned: String { l("tabDoc.comment.orphaned", table: "TabDoc") }
        static var commentAnonymous: String { l("tabDoc.comment.anonymous", table: "TabDoc") }
        static var commentEmpty: String { l("tabDoc.comment.empty", table: "TabDoc") }
        static var commentSend: String { l("tabDoc.comment.send", table: "TabDoc") }
        static var commentSendFailed: String { l("tabDoc.comment.sendFailed", table: "TabDoc") }
        static var commentLoadFailed: String { l("tabDoc.comment.loadFailed", table: "TabDoc") }
        static var commentMissingAnchor: String { l("tabDoc.comment.missingAnchor", table: "TabDoc") }
    }

    enum TabData {
        static var loading: String { l("tabData.loading", table: "TabData") }
        static var searchPlaceholder: String { l("tabData.search.placeholder", table: "TabData") }
        static var emptyTitle: String { l("tabData.empty.title", table: "TabData") }
        static var emptyMessage: String { l("tabData.empty.message", table: "TabData") }
        static var emptyNoViews: String { l("tabData.empty.noViews", table: "TabData") }
        static var emptyNoViewsHint: String { l("tabData.empty.noViewsHint", table: "TabData") }
        static var emptyNoMatches: String { l("tabData.empty.noMatches", table: "TabData") }
        static var emptyNoMatchesHint: String { l("tabData.empty.noMatchesHint", table: "TabData") }
        static var emptyNoRecords: String { l("tabData.empty.noRecords", table: "TabData") }
        static var emptyNoRecordsHint: String { l("tabData.empty.noRecordsHint", table: "TabData") }
        static var emptyKanbanHint: String { l("tabData.empty.kanbanHint", table: "TabData") }
        static var addRecord: String { l("tabData.record.add", table: "TabData") }
        static var previousRecord: String { l("tabData.record.previous", table: "TabData") }
        static var nextRecord: String { l("tabData.record.next", table: "TabData") }
        static var discardAndContinue: String { l("tabData.record.discardAndContinue", table: "TabData") }
        static var recordTitle: String { l("tabData.record.title", table: "TabData") }
        static var untitledRecord: String { l("tabData.record.untitled", table: "TabData") }
        static var untitledTable: String { l("tabData.table.untitled", table: "TabData") }
        static var deleteRecord: String { l("tabData.record.delete", table: "TabData") }
        static var deleteTitle: String { l("tabData.record.deleteTitle", table: "TabData") }
        static var deleteMessage: String { l("tabData.record.deleteMessage", table: "TabData") }
        static var fieldsSection: String { l("tabData.fields.section", table: "TabData") }
        static var addField: String { l("tabData.field.add", table: "TabData") }
        static var fieldCreateTitle: String { l("tabData.field.createTitle", table: "TabData") }
        static var fieldCreate: String { l("tabData.field.create", table: "TabData") }
        static var fieldCreating: String { l("tabData.field.creating", table: "TabData") }
        static var fieldName: String { l("tabData.field.name", table: "TabData") }
        static var fieldNamePlaceholder: String { l("tabData.field.namePlaceholder", table: "TabData") }
        static var fieldType: String { l("tabData.field.type", table: "TabData") }
        static var fieldChoices: String { l("tabData.field.choices", table: "TabData") }
        static var fieldChoicesHint: String { l("tabData.field.choicesHint", table: "TabData") }
        static var fieldNameRequired: String { l("tabData.field.nameRequired", table: "TabData") }
        static var fieldNameTooLong: String { l("tabData.field.nameTooLong", table: "TabData") }
        static var fieldNameDuplicate: String { l("tabData.field.nameDuplicate", table: "TabData") }
        static var fieldChoicesRequired: String { l("tabData.field.choicesRequired", table: "TabData") }
        static var fieldCreateFailed: String { l("tabData.field.createFailed", table: "TabData") }
        static var fieldCreateRefreshFailed: String { l("tabData.field.createRefreshFailed", table: "TabData") }
        static var fieldTypeText: String { l("tabData.field.type.text", table: "TabData") }
        static var fieldTypeLongText: String { l("tabData.field.type.longText", table: "TabData") }
        static var fieldTypeNumber: String { l("tabData.field.type.number", table: "TabData") }
        static var fieldTypeSelect: String { l("tabData.field.type.select", table: "TabData") }
        static var fieldTypeMultiSelect: String { l("tabData.field.type.multiSelect", table: "TabData") }
        static var fieldTypeCheckbox: String { l("tabData.field.type.checkbox", table: "TabData") }
        static var readOnlyField: String { l("tabData.field.readOnly", table: "TabData") }
        static var noValue: String { l("tabData.field.noValue", table: "TabData") }
        static var unknownMember: String { l("tabData.member.unknown", table: "TabData") }
        static var unnamedMember: String { l("tabData.member.unnamed", table: "TabData") }
        static var departedMemberFormat: String { l("tabData.member.departed", table: "TabData") }
        static func departedMember(_ name: String) -> String { l("tabData.member.departed", table: "TabData", name) }
        static var memberSearchPlaceholder: String { l("tabData.member.searchPlaceholder", table: "TabData") }
        static var memberEmpty: String { l("tabData.member.empty", table: "TabData") }
        static var memberNoMatch: String { l("tabData.member.noMatch", table: "TabData") }
        static var memberLoadFailed: String { l("tabData.member.loadFailed", table: "TabData") }
        static var memberLoadingMore: String { l("tabData.member.loadingMore", table: "TabData") }
        static var memberRemove: String { l("tabData.member.remove", table: "TabData") }
        static var filter: String { l("tabData.filter", table: "TabData") }
        static func filterCount(_ count: Int) -> String { l("tabData.filter.count", table: "TabData", count) }
        static var filterRecords: String { l("tabData.filter.records", table: "TabData") }
        static var filterAll: String { l("tabData.filter.all", table: "TabData") }
        static var filterAny: String { l("tabData.filter.any", table: "TabData") }
        static var filterAdd: String { l("tabData.filter.add", table: "TabData") }
        static var filterChooseField: String { l("tabData.filter.chooseField", table: "TabData") }
        static var filterChecked: String { l("tabData.filter.checked", table: "TabData") }
        static var filterApply: String { l("tabData.filter.apply", table: "TabData") }
        static var filterRemove: String { l("tabData.filter.remove", table: "TabData") }
        static var filterValue: String { l("tabData.filter.value", table: "TabData") }
        static var contains: String { l("tabData.filter.contains", table: "TabData") }
        static var equals: String { l("tabData.filter.equals", table: "TabData") }
        static var filterNotEquals: String { l("tabData.filter.notEquals", table: "TabData") }
        static var filterGreater: String { l("tabData.filter.greater", table: "TabData") }
        static var filterLess: String { l("tabData.filter.less", table: "TabData") }
        static var clearFilter: String { l("tabData.filter.clear", table: "TabData") }
        static var sort: String { l("tabData.sort", table: "TabData") }
        static var ascending: String { l("tabData.sort.ascending", table: "TabData") }
        static var descending: String { l("tabData.sort.descending", table: "TabData") }
        static var clearSort: String { l("tabData.sort.clear", table: "TabData") }
        static var apply: String { l("tabData.apply", table: "TabData") }
        static var loadMore: String { l("tabData.loadMore", table: "TabData") }
        static var loadingMore: String { l("tabData.loadingMore", table: "TabData") }
        static var recordsCount: String { l("tabData.recordsCount", table: "TabData") }
        static var groupedCount: String { l("tabData.groupedCount", table: "TabData") }
        static func complexViewTitle(_ viewName: String) -> String {
            l("tabData.complexView.title", table: "TabData", viewName)
        }
        static func complexViewMessage(_ viewTypeLabel: String) -> String {
            l("tabData.complexView.message", table: "TabData", viewTypeLabel)
        }
        static var viewTypeCalendar: String { l("tabData.viewType.calendar", table: "TabData") }
        static var viewTypeGallery: String { l("tabData.viewType.gallery", table: "TabData") }
        static var viewTypeForm: String { l("tabData.viewType.form", table: "TabData") }
        static var viewTypeFlashcard: String { l("tabData.viewType.flashcard", table: "TabData") }
        static var viewTypePivot: String { l("tabData.viewType.pivot", table: "TabData") }
        static var openFullEditor: String { l("tabData.openFullEditor", table: "TabData") }
        static var fullEditorBlockedTitle: String { l("tabData.fullEditor.blockedTitle", table: "TabData") }
        static var fullEditorBlockedMessage: String { l("tabData.fullEditor.blockedMessage", table: "TabData") }
        static var fullEditorSaveAndOpen: String { l("tabData.fullEditor.saveAndOpen", table: "TabData") }
        static var fullEditorDiscardAndOpen: String { l("tabData.fullEditor.discardAndOpen", table: "TabData") }
        static var fullEditorSavingTitle: String { l("tabData.fullEditor.savingTitle", table: "TabData") }
        static var fullEditorSavingMessage: String { l("tabData.fullEditor.savingMessage", table: "TabData") }
        static var saveConflictShort: String { l("tabData.save.conflictShort", table: "TabData") }
        static var conflictMessage: String { l("tabData.save.conflictMessage", table: "TabData") }
        static var saveConflictRetry: String { l("tabData.save.conflictRetry", table: "TabData") }
        static var advisoryConflictTitle: String { l("tabData.save.advisoryConflictTitle", table: "TabData") }
        static var advisoryConflictUnknown: String { l("tabData.save.advisoryConflictUnknown", table: "TabData") }
        static func advisoryConflict(_ fieldName: String) -> String {
            l("tabData.save.advisoryConflict", table: "TabData", fieldName)
        }
        static func advisoryConflictList(_ names: String) -> String {
            l("tabData.save.advisoryConflictList", table: "TabData", names)
        }
        static func advisoryConflictOverflow(_ names: String, _ count: Int) -> String {
            l("tabData.save.advisoryConflictOverflow", table: "TabData", names, count)
        }
        static func fieldNameQuoted(_ fieldName: String) -> String {
            l("tabData.save.fieldNameQuoted", table: "TabData", fieldName)
        }
        static var fieldNameSeparator: String { l("tabData.save.fieldNameSeparator", table: "TabData") }
        static var deleteModifiedMessage: String { l("tabData.save.deleteModified", table: "TabData") }
        static var permissionMessage: String { l("tabData.save.permissionMessage", table: "TabData") }
        static var saveFailedTitle: String { l("tabData.save.failedTitle", table: "TabData") }
        static var invalidNumber: String { l("tabData.save.invalidNumber", table: "TabData") }
        static var save: String { l("tabData.save", table: "TabData") }
        static var percentSuffix: String { l("tabData.percent.suffix", table: "TabData") }
        static func ratingValue(_ value: Int, _ max: Int) -> String {
            l("tabData.rating.value", table: "TabData", value, max)
        }
        static var selectNone: String { l("tabData.select.none", table: "TabData") }
        static func selectMore(_ count: Int) -> String { l("tabData.select.more", table: "TabData", count) }
        static var selectedCount: String { l("tabData.select.count", table: "TabData") }
        static var readOnly: String { l("tabData.readOnly", table: "TabData") }
        static var localDraftTitle: String { l("tabData.localDraft.title", table: "TabData") }
        static var localDraftMessage: String { l("tabData.localDraft.message", table: "TabData") }
        static var localDraftReadOnly: String { l("tabData.localDraft.readOnly", table: "TabData") }
        static var localDraftNewRecord: String { l("tabData.localDraft.newRecord", table: "TabData") }
        static var localDraftRecord: String { l("tabData.localDraft.record", table: "TabData") }
        static var localDraftView: String { l("tabData.localDraft.view", table: "TabData") }
        static var localDraftCopy: String { l("tabData.localDraft.copy", table: "TabData") }
        static var localDraftCopied: String { l("tabData.localDraft.copied", table: "TabData") }
        static var remoteRecordDeleted: String { l("tabData.realtime.recordDeleted", table: "TabData") }
        static var remoteSchemaUpdated: String { l("tabData.realtime.schemaUpdated", table: "TabData") }
        static func droppedField(_ fieldName: String) -> String {
            l("tabData.realtime.droppedField", table: "TabData", fieldName)
        }
        static func droppedFields(_ fieldName: String, _ count: Int) -> String {
            l("tabData.realtime.droppedFields", table: "TabData", fieldName, Int64(count))
        }
    }

    enum CloudDrive {
        static var searchPlaceholder: String { l("cloudDrive.searchPlaceholder", table: "Common") }
        static var filterAll: String { l("cloudDrive.filter.all", table: "Common") }
        static var filterDocs: String { l("cloudDrive.filter.docs", table: "Common") }
        static var filterTables: String { l("cloudDrive.filter.tables", table: "Common") }
        static var filterFiles: String { l("cloudDrive.filter.files", table: "Common") }
        static var rootFolder: String { l("cloudDrive.rootFolder", table: "Common") }
        static var breadcrumb: String { l("cloudDrive.breadcrumb", table: "Common") }
        static var folderLabel: String { l("cloudDrive.folderLabel", table: "Common") }
        static var untitledFolder: String { l("cloudDrive.untitledFolder", table: "Common") }
        static var actionsTitle: String { l("cloudDrive.actionsTitle", table: "Common") }
        static var uploadComingSoon: String { l("cloudDrive.uploadComingSoon", table: "Common") }
        static var newFolderComingSoon: String { l("cloudDrive.newFolderComingSoon", table: "Common") }
        static var writeComingSoonFooter: String { l("cloudDrive.writeComingSoonFooter", table: "Common") }
        static var uploadFile: String { l("cloudDrive.uploadFile", table: "Common") }
        static var newFolder: String { l("cloudDrive.newFolder", table: "Common") }
        static var newFolderMessage: String { l("cloudDrive.newFolderMessage", table: "Common") }
        static var folderNamePlaceholder: String { l("cloudDrive.folderNamePlaceholder", table: "Common") }
        static var folderNameRequired: String { l("cloudDrive.folderNameRequired", table: "Common") }
        static var writeActionsFooter: String { l("cloudDrive.writeActionsFooter", table: "Common") }
        static var writeUnavailable: String { l("cloudDrive.writeUnavailable", table: "Common") }
        static var writeUnavailableFooter: String { l("cloudDrive.writeUnavailableFooter", table: "Common") }
        static var mountPendingHint: String { l("cloudDrive.mountPendingHint", table: "Common") }
        static var uploadPhaseSelected: String { l("cloudDrive.uploadPhase.selected", table: "Common") }
        static var uploadPhaseUploading: String { l("cloudDrive.uploadPhase.uploading", table: "Common") }
        static var uploadPhaseConfirmed: String { l("cloudDrive.uploadPhase.confirmed", table: "Common") }
        static var uploadPhaseMounting: String { l("cloudDrive.uploadPhase.mounting", table: "Common") }
        static var uploadPhaseReady: String { l("cloudDrive.uploadPhase.ready", table: "Common") }
        static var uploadPhasePendingMount: String { l("cloudDrive.uploadPhase.pendingMount", table: "Common") }
        static var availableActions: String { l("cloudDrive.availableActions", table: "Common") }
        static var loadingPreview: String { l("cloudDrive.loadingPreview", table: "Common") }
        static var preview: String { l("cloudDrive.preview", table: "Common") }
        static var openExternally: String { l("cloudDrive.openExternally", table: "Common") }
        static var previewUnavailable: String { l("cloudDrive.previewUnavailable", table: "Common") }
        static var download: String { l("cloudDrive.download", table: "Common") }
        static var copyLink: String { l("cloudDrive.copyLink", table: "Common") }
        static var systemShare: String { l("cloudDrive.systemShare", table: "Common") }
        static var fileInfo: String { l("cloudDrive.fileInfo", table: "Common") }
        static var mimeType: String { l("cloudDrive.mimeType", table: "Common") }
        static var fileSize: String { l("cloudDrive.fileSize", table: "Common") }
        static var contextItemId: String { l("cloudDrive.contextItemId", table: "Common") }
        static var fileRecordId: String { l("cloudDrive.fileRecordId", table: "Common") }
        static var location: String { l("cloudDrive.location", table: "Common") }
        static var organizationCloud: String { l("cloudDrive.organizationCloud", table: "Common") }
        static var linkCopied: String { l("cloudDrive.linkCopied", table: "Common") }
        static var operationFailed: String { l("cloudDrive.operationFailed", table: "Common") }
        static var missingOrganization: String { l("cloudDrive.missingOrganization", table: "Common") }
        static var previewPrepareFailed: String { l("cloudDrive.previewPrepareFailed", table: "Common") }
        static var sharedSearchCappedNote: String { l("cloudDrive.sharedSearchCappedNote", table: "Common") }

        static var renameFolder: String { l("cloudDrive.renameFolder", table: "Common") }
        static var renameFolderMessage: String { l("cloudDrive.renameFolderMessage", table: "Common") }
        static var moveFolder: String { l("cloudDrive.moveFolder", table: "Common") }
        static var moveFolderConfirm: String { l("cloudDrive.moveFolderConfirm", table: "Common") }
        static var moveItem: String { l("cloudDrive.moveItem", table: "Common") }
        static var moveToFolder: String { l("cloudDrive.moveToFolder", table: "Common") }
        static var moveFolderIntoSelf: String { l("cloudDrive.moveFolderIntoSelf", table: "Common") }
        static var moveOwnerOnly: String { l("cloudDrive.moveOwnerOnly", table: "Common") }

        static func moveFolderConfirmMessage(_ sourceName: String, _ targetName: String) -> String {
            l("cloudDrive.moveFolderConfirmMessage", table: "Common", sourceName, targetName)
        }
        static var deleteFolder: String { l("cloudDrive.deleteFolder", table: "Common") }
        static var deleteFolderTitle: String { l("cloudDrive.deleteFolderTitle", table: "Common") }
        static var deleteFolderConfirm: String { l("cloudDrive.deleteFolderConfirm", table: "Common") }
        static var deleteFolderMessage: String { l("cloudDrive.deleteFolderMessage", table: "Common") }
        static var moveToTrash: String { l("cloudDrive.moveToTrash", table: "Common") }
        static var trashFileMessage: String { l("cloudDrive.trashFileMessage", table: "Common") }
        static var restore: String { l("cloudDrive.restore", table: "Common") }
        static var permanentDelete: String { l("cloudDrive.permanentDelete", table: "Common") }
        static var permanentDeleteTitle: String { l("cloudDrive.permanentDeleteTitle", table: "Common") }
        static var permanentDeleteConfirm: String { l("cloudDrive.permanentDeleteConfirm", table: "Common") }
        static var missingFileRecordId: String { l("cloudDrive.missingFileRecordId", table: "Common") }
        static var sendToConversation: String { l("cloudDrive.sendToConversation", table: "Common") }
        static var sentToConversation: String { l("cloudDrive.sentToConversation", table: "Common") }
        static var manageCollaborators: String { l("cloudDrive.manageCollaborators", table: "Common") }
        static var collaborators: String { l("cloudDrive.collaborators", table: "Common") }
        static var owner: String { l("cloudDrive.owner", table: "Common") }
        static var noCollaborators: String { l("cloudDrive.noCollaborators", table: "Common") }
        static var inviteCollaborator: String { l("cloudDrive.inviteCollaborator", table: "Common") }
        static var invite: String { l("cloudDrive.invite", table: "Common") }
        static var searchMembers: String { l("cloudDrive.searchMembers", table: "Common") }
        static var permissionViewer: String { l("cloudDrive.permissionViewer", table: "Common") }
        static var permissionEditor: String { l("cloudDrive.permissionEditor", table: "Common") }
        static var removeCollaborator: String { l("cloudDrive.removeCollaborator", table: "Common") }
        static var removeCollaboratorTitle: String { l("cloudDrive.removeCollaboratorTitle", table: "Common") }
        static var collaboratorsNoPublicLink: String { l("cloudDrive.collaboratorsNoPublicLink", table: "Common") }
        static var collaboratorsUnavailable: String { l("cloudDrive.collaboratorsUnavailable", table: "Common") }
        static var collaboratorsGap: String { l("cloudDrive.collaboratorsGap", table: "Common") }

        static func itemCount(_ count: Int) -> String {
            l("cloudDrive.itemCount", table: "Common", count)
        }

        static func retryPendingMount(_ count: Int) -> String {
            l("cloudDrive.retryPendingMount", table: "Common", count)
        }

        static func trashedBanner(_ title: String) -> String {
            l("cloudDrive.trashedBanner", table: "Common", title)
        }

        static func permanentDeleteMessage(_ title: String) -> String {
            l("cloudDrive.permanentDeleteMessage", table: "Common", title)
        }
    }

    enum AccountDrawer {
        static var title: String { l("accountDrawer.title", table: "Common") }
        static var currentOrganization: String { l("accountDrawer.currentOrganization", table: "Common") }
        static var switchOrganization: String { l("accountDrawer.switchOrganization", table: "Common") }
        static var organizationInvitations: String { l("accountDrawer.organizationInvitations", table: "Common") }
        static var openMe: String { l("accountDrawer.openMe", table: "Common") }
        static var openMenu: String { l("accountDrawer.openMenu", table: "Common") }
        static var noOrganizationInvitations: String { l("accountDrawer.noOrganizationInvitations", table: "Common") }
        static var organizationSwitchFailed: String { l("accountDrawer.organizationSwitchFailed", table: "Common") }
        static var organizationScopeUnavailable: String { l("accountDrawer.organizationScopeUnavailable", table: "Common") }
        static var organizationRoleUnavailable: String { l("accountDrawer.organizationRoleUnavailable", table: "Common") }
        static var organizationSwitchInProgress: String { l("accountDrawer.organizationSwitchInProgress", table: "Common") }
        static var organizationAccessRevokedTitle: String { l("accountDrawer.organizationAccessRevokedTitle", table: "Common") }
        static func organizationAccessRevokedMessage(_ name: String) -> String {
            l("accountDrawer.organizationAccessRevokedMessage", table: "Common", name)
        }
        static var organizationAccessRevokedMessageGeneric: String {
            l("accountDrawer.organizationAccessRevokedMessageGeneric", table: "Common")
        }
        static var switchToDefaultOrganization: String {
            l("accountDrawer.switchToDefaultOrganization", table: "Common")
        }
    }

    enum Settings {
        static var sectionAccountSecurity: String { l("settings.sectionAccountSecurity", table: "Common") }
        static var sectionPreferences: String { l("settings.sectionPreferences", table: "Common") }
        static var sectionPersonal: String { l("settings.sectionPersonal", table: "Common") }
        static var sectionOrganization: String { l("settings.sectionOrganization", table: "Common") }
        static var sectionDevice: String { l("settings.sectionDevice", table: "Common") }
        static var sectionAboutSupport: String { l("settings.sectionAboutSupport", table: "Common") }
        static var accountInfo: String { l("settings.accountInfo", table: "Common") }
        static var accountAndVerification: String { l("settings.accountAndVerification", table: "Common") }
        static var appearanceAndLanguage: String { l("settings.appearanceAndLanguage", table: "Common") }
        static var thisDevice: String { l("settings.thisDevice", table: "Common") }
        static var organizationSummary: String { l("settings.organizationSummary", table: "Common") }
        static var organizationSettings: String { l("settings.organizationSettings", table: "Common") }
        static var organizationName: String { l("settings.organizationName", table: "Common") }
        static var organizationRole: String { l("settings.organizationRole", table: "Common") }
        static var organizationUnavailable: String { l("settings.organizationUnavailable", table: "Common") }
        static var unavailable: String { l("settings.unavailable", table: "Common") }
        static var accountInfoPhone: String { l("settings.accountInfoPhone", table: "Common") }
        static var accountInfoEmail: String { l("settings.accountInfoEmail", table: "Common") }
        static var accountInfoUserId: String { l("settings.accountInfoUserId", table: "Common") }
        static var accountInfoUserIdFooter: String { l("settings.accountInfoUserIdFooter", table: "Common") }
        static var userIdCopied: String { l("settings.userIdCopied", table: "Common") }
        static var colorScheme: String { l("settings.colorScheme", table: "Common") }
        static var colorSchemeBlue: String { l("settings.colorScheme.blue", table: "Common") }
        static var colorSchemeTeal: String { l("settings.colorScheme.teal", table: "Common") }
        static var colorSchemeOrange: String { l("settings.colorScheme.orange", table: "Common") }
        static var colorSchemeRose: String { l("settings.colorScheme.rose", table: "Common") }
        static var colorSchemeSlate: String { l("settings.colorScheme.slate", table: "Common") }
        static var colorSchemeViolet: String { l("settings.colorScheme.violet", table: "Common") }
        static var colorSchemeSky: String { l("settings.colorScheme.sky", table: "Common") }
        static var accountInfoSubtitle: String { l("settings.accountInfoSubtitle", table: "Common") }
        static var privacyAndDataSubtitle: String { l("settings.privacyAndDataSubtitle", table: "Common") }
        static var appearanceAndLanguageSubtitle: String { l("settings.appearanceAndLanguageSubtitle", table: "Common") }
        static var notificationsSubtitle: String { l("settings.notificationsSubtitle", table: "Common") }
        static var notificationsEnabled: String { l("settings.notifications.enabled", table: "Common") }
        static var notificationsDisabled: String { l("settings.notifications.disabled", table: "Common") }
        static var notificationsNotSet: String { l("settings.notifications.notSet", table: "Common") }
        static var voiceHabitsSubtitle: String { l("settings.voiceHabitsSubtitle", table: "Common") }
        static var organizationSummarySubtitle: String { l("settings.organizationSummarySubtitle", table: "Common") }
        static var organizationSettingsSubtitle: String { l("settings.organizationSettingsSubtitle", table: "Common") }
        static var deviceInfoSubtitle: String { l("settings.deviceInfoSubtitle", table: "Common") }
        static var aboutSubtitle: String { l("settings.aboutSubtitle", table: "Common") }
        static var debugEnvironmentSubtitle: String { l("settings.debugEnvironmentSubtitle", table: "Common") }
        static var diagnosticsTitle: String { l("settings.diagnostics.title", table: "Common") }
        static var diagnosticsSubtitle: String { l("settings.diagnostics.subtitle", table: "Common") }
        static var diagnosticsDescription: String { l("settings.diagnostics.description", table: "Common") }
        static var diagnosticsPrivacy: String { l("settings.diagnostics.privacy", table: "Common") }
        static var diagnosticsExport: String { l("settings.diagnostics.export", table: "Common") }
        static var diagnosticsExporting: String { l("settings.diagnostics.exporting", table: "Common") }
        static var diagnosticsFailed: String { l("settings.diagnostics.failed", table: "Common") }
        static var debugEnvironmentProduction: String { l("settings.debugEnvironment.production", table: "Common") }
        static var debugEnvironmentDevelopment: String { l("settings.debugEnvironment.development", table: "Common") }
        static var debugEnvironmentCustom: String { l("settings.debugEnvironment.custom", table: "Common") }

        static func verifiedCount(_ count: Int) -> String {
            l("settings.verifiedCount", table: "Common", count)
        }
    }
}
