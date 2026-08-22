import Foundation

/// 与 Electron / 后端 SSOT 对齐的新密码输入策略。
enum PasswordPolicy {
    static let minimumLength = 8
    static let minimumCharacterClasses = 3

    enum ValidationError: Equatable {
        case required
        case containsCJK
        case containsWhitespace
        case tooShort
        case notComplex
        case mismatch
    }

    struct SanitizedInput: Equatable {
        let value: String
        let hadWhitespace: Bool
        let hadCJK: Bool
    }

    static func sanitize(_ raw: String) -> SanitizedInput {
        let hadWhitespace = raw.contains(where: { $0.isWhitespace })
        let withoutWhitespace = raw.filter { !$0.isWhitespace }
        let hadCJK = withoutWhitespace.contains(where: isCJK)
        return SanitizedInput(value: hadCJK ? "" : withoutWhitespace, hadWhitespace: hadWhitespace, hadCJK: hadCJK)
    }

    static func validate(newPassword: String, confirmation: String) -> ValidationError? {
        if newPassword.isEmpty { return .required }
        if newPassword.contains(where: isCJK) { return .containsCJK }
        if newPassword.contains(where: { $0.isWhitespace }) { return .containsWhitespace }
        if newPassword.count < minimumLength { return .tooShort }
        if characterClassCount(newPassword) < minimumCharacterClasses { return .notComplex }
        if newPassword != confirmation { return .mismatch }
        return nil
    }

    private static func characterClassCount(_ password: String) -> Int {
        var count = 0
        if password.contains(where: { $0.isUppercase }) { count += 1 }
        if password.contains(where: { $0.isLowercase }) { count += 1 }
        if password.contains(where: { $0.isNumber }) { count += 1 }
        if password.contains(where: { !$0.isLetter && !$0.isNumber && !$0.isWhitespace }) { count += 1 }
        return count
    }

    private static func isCJK(_ character: Character) -> Bool {
        character.unicodeScalars.contains { scalar in
            (0x3400...0x4DBF).contains(Int(scalar.value)) ||
                (0x4E00...0x9FFF).contains(Int(scalar.value)) ||
                (0xF900...0xFAFF).contains(Int(scalar.value))
        }
    }
}
