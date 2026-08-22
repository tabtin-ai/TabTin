import SwiftUI
import os

enum ThemeMode: String, CaseIterable, Identifiable {
    case system
    case light
    case dark

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .system: return L10n.Profile.themeSystem
        case .light: return L10n.Profile.themeLight
        case .dark: return L10n.Profile.themeDark
        }
    }
}

@MainActor @Observable
final class ThemeManager {
    static let shared = ThemeManager()

    private static let storageKey = "tt_theme_mode"

    var mode: ThemeMode {
        didSet { UserDefaults.standard.set(mode.rawValue, forKey: Self.storageKey) }
    }

    var resolvedColorScheme: ColorScheme? {
        switch mode {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }

    private init() {
        if let raw = UserDefaults.standard.string(forKey: Self.storageKey),
           let saved = ThemeMode(rawValue: raw) {
            mode = saved
        } else {
            mode = .system
        }
    }
}

enum AppLanguage: String, CaseIterable, Identifiable {
    case system = "system"
    case zhHans = "zh-Hans"
    case en = "en"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .system: return L10n.Profile.languageSystem
        case .zhHans: return "简体中文"
        case .en: return "English"
        }
    }

    var localeIdentifier: String? {
        switch self {
        case .system: return nil
        case .zhHans: return "zh-Hans"
        case .en: return "en"
        }
    }
}

@Observable
final class LanguageManager: @unchecked Sendable {
    static let shared = LanguageManager()

    private static let storageKey = "tt_app_language"
    private let stateLock = OSAllocatedUnfairLock()

    var language: AppLanguage {
        didSet {
            persist()
            reloadBundle()
        }
    }

    private(set) var bundle: Bundle = .main

    var effectiveLocale: Locale {
        guard let id = language.localeIdentifier else { return .current }
        return Locale(identifier: id)
    }

    private init() {
        if let raw = UserDefaults.standard.string(forKey: Self.storageKey),
           let saved = AppLanguage(rawValue: raw) {
            language = saved
        } else {
            language = .system
        }
        reloadBundle()
    }

    private func persist() {
        UserDefaults.standard.set(language.rawValue, forKey: Self.storageKey)
    }

    private func reloadBundle() {
        stateLock.withLock {
            guard let localeId = language.localeIdentifier else {
                bundle = .main
                return
            }
            if let path = Bundle.main.path(forResource: localeId, ofType: "lproj"),
               let lprojBundle = Bundle(path: path) {
                bundle = lprojBundle
            } else {
                bundle = .main
            }
        }
    }
}
