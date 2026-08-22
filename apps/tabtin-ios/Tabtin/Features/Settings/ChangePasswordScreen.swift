import SwiftUI

/// 修改密码与“忘记当前密码”共用的移动端流程。
struct ChangePasswordScreen: View {
    @State private var auth = AuthService.shared
    @State private var useResetFlow = AuthService.shared.currentUser?.prefersVerificationPasswordSetup == true
    @State private var oldPassword = ""
    @State private var verificationCode = ""
    @State private var newPassword = ""
    @State private var confirmPassword = ""
    @State private var isSendingCode = false
    @State private var isSubmitting = false
    @State private var cooldownSeconds = 0
    @State private var errorMessage: String?
    @State private var showSuccess = false

    private var resetContact: String? {
        guard let user = auth.currentUser else { return nil }
        if let phone = user.phone, !phone.isEmpty { return maskContact(phone) }
        if let email = user.email, !email.isEmpty { return maskContact(email) }
        return nil
    }

    var body: some View {
        Form {
            Section {
                Text(useResetFlow
                    ? (resetContact.map(L10n.Profile.changePasswordDescReset) ?? L10n.Profile.changePasswordDescResetNoContact)
                    : L10n.Profile.changePasswordDescChange)
                    .font(.tt.body)
                    .foregroundStyle(.tt.textSecondary)

                if useResetFlow {
                    HStack(spacing: TTSpacing.sm) {
                        SecureField(L10n.Profile.changePasswordVerificationCode, text: $verificationCode)
                            .keyboardType(.numberPad)
                            .textContentType(.oneTimeCode)
                            .onChange(of: verificationCode) { _, value in
                                verificationCode = String(value.filter(\.isNumber).prefix(6))
                            }
                        Button(cooldownSeconds > 0 ? "\(cooldownSeconds)s" : L10n.Profile.changePasswordSendCode) {
                            sendResetCode()
                        }
                        .buttonStyle(.bordered)
                        .disabled(isSendingCode || cooldownSeconds > 0 || resetContact == nil)
                    }
                    if resetContact == nil {
                        Text(L10n.Profile.changePasswordDescResetNoContact)
                            .font(.tt.caption)
                            .foregroundStyle(.tt.textCritical)
                    }
                } else {
                    SecureField(L10n.Profile.changePasswordCurrent, text: $oldPassword,
                                prompt: Text(L10n.Profile.changePasswordPlaceholderOld))
                        .textContentType(.password)
                }
            } header: {
                Text(L10n.Profile.changePasswordTitle)
            }

            Section {
                SecureField(L10n.Profile.changePasswordNew, text: $newPassword,
                            prompt: Text(L10n.Profile.changePasswordPlaceholderNew))
                    .textContentType(.newPassword)
                    .onChange(of: newPassword) { _, value in
                        let sanitized = PasswordPolicy.sanitize(value)
                        if sanitized.value != value { newPassword = sanitized.value }
                        if sanitized.hadCJK {
                            errorMessage = L10n.Profile.changePasswordErrorNewNoCJK
                        } else if sanitized.hadWhitespace {
                            errorMessage = L10n.Profile.changePasswordErrorNewNoWhitespace
                        } else {
                            errorMessage = nil
                        }
                    }
                SecureField(L10n.Profile.changePasswordConfirm, text: $confirmPassword,
                            prompt: Text(L10n.Profile.changePasswordPlaceholderConfirm))
                    .textContentType(.newPassword)
                    .onChange(of: confirmPassword) { _, value in
                        let sanitized = PasswordPolicy.sanitize(value)
                        if sanitized.value != value { confirmPassword = sanitized.value }
                        if sanitized.hadCJK {
                            errorMessage = L10n.Profile.changePasswordErrorNewNoCJK
                        } else if sanitized.hadWhitespace {
                            errorMessage = L10n.Profile.changePasswordErrorNewNoWhitespace
                        } else if !sanitized.value.isEmpty && sanitized.value != newPassword {
                            errorMessage = L10n.Profile.changePasswordErrorMismatch
                        } else {
                            errorMessage = nil
                        }
                    }
                Text(L10n.Profile.changePasswordErrorNewNotComplex)
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textSecondary)
            }

            if let errorMessage {
                Section { Text(errorMessage).foregroundStyle(.tt.textCritical) }
            }

            Section {
                Button {
                    submit()
                } label: {
                    HStack {
                        Spacer()
                        if isSubmitting { ProgressView().controlSize(.small) }
                        Text(L10n.Profile.changePasswordSubmit)
                        Spacer()
                    }
                }
                .disabled(isSubmitting || isSendingCode)

                Button(useResetFlow ? L10n.Profile.changePasswordUseOld : L10n.Profile.changePasswordForgotOld) {
                    useResetFlow.toggle()
                    oldPassword = ""
                    verificationCode = ""
                    errorMessage = nil
                }
                .buttonStyle(.plain)
                .frame(maxWidth: .infinity)
                .foregroundStyle(.tt.iconAccent)
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle(L10n.Profile.changePasswordTitle)
        .navigationBarTitleDisplayMode(.inline)
        .alert(L10n.Profile.changePasswordSuccess, isPresented: $showSuccess) {
            Button(L10n.Common.confirm) { auth.logout() }
        } message: {
            Text(L10n.Profile.changePasswordSuccessRelogin)
        }
    }

    private func sendResetCode() {
        guard !isSendingCode, cooldownSeconds == 0, resetContact != nil else { return }
        isSendingCode = true
        errorMessage = nil
        Task {
            do {
                try await auth.sendCurrentPasswordResetCode()
                isSendingCode = false
                cooldownSeconds = 60
                while cooldownSeconds > 0 {
                    try await Task.sleep(for: .seconds(1))
                    cooldownSeconds -= 1
                }
            } catch {
                isSendingCode = false
                errorMessage = error.localizedDescription
            }
        }
    }

    private func submit() {
        guard !isSubmitting else { return }
        if let validationError = PasswordPolicy.validate(newPassword: newPassword, confirmation: confirmPassword) {
            errorMessage = validationMessage(validationError)
            return
        }
        if !useResetFlow && oldPassword.isEmpty {
            errorMessage = L10n.Profile.changePasswordErrorOldRequired
            return
        }
        if useResetFlow && verificationCode.wholeMatch(of: /\d{6}/) == nil {
            errorMessage = L10n.Profile.changePasswordErrorCodeInvalid
            return
        }

        isSubmitting = true
        errorMessage = nil
        Task {
            do {
                if useResetFlow {
                    try await auth.resetCurrentPassword(verificationCode: verificationCode, newPassword: newPassword)
                } else {
                    try await auth.changePassword(oldPassword: oldPassword, newPassword: newPassword)
                }
                isSubmitting = false
                showSuccess = true
            } catch {
                isSubmitting = false
                errorMessage = error.localizedDescription
            }
        }
    }

    private func validationMessage(_ error: PasswordPolicy.ValidationError) -> String {
        switch error {
        case .required: return L10n.Profile.changePasswordErrorNewRequired
        case .containsCJK: return L10n.Profile.changePasswordErrorNewNoCJK
        case .containsWhitespace: return L10n.Profile.changePasswordErrorNewNoWhitespace
        case .tooShort: return L10n.Profile.changePasswordErrorNewTooShort
        case .notComplex: return L10n.Profile.changePasswordErrorNewNotComplex
        case .mismatch: return L10n.Profile.changePasswordErrorMismatch
        }
    }

    private func maskContact(_ contact: String) -> String {
        if contact.contains("@") {
            let pieces = contact.split(separator: "@", maxSplits: 1).map(String.init)
            guard let local = pieces.first, let domain = pieces.last, local.count > 2 else { return contact }
            return "\(local.prefix(2))***@\(domain)"
        }
        guard contact.count > 4 else { return contact }
        return String(contact.prefix(3)) + "****" + String(contact.suffix(2))
    }
}
