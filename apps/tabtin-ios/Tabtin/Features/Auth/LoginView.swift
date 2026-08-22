import SwiftUI

/// 登录/注册入口。品牌动画与真实认证表单共同组成一张固定纸面工作台。
struct LoginView: View {
    @Environment(\.scenePhase) private var scenePhase

    @State private var auth = AuthService.shared
    @State private var privacy = PrivacyConsentStore.shared
    @State private var language = LanguageManager.shared

    @State private var mode: LoginMode = .verificationCode
    @State private var phone = ""
    @State private var code = ""
    @State private var password = ""
    @State private var isPasswordVisible = false
    @State private var countdown = 0
    @State private var countdownTask: Task<Void, Never>?
    @State private var isSendingCode = false
    @State private var isLoggingIn = false
    @State private var errorMessage: String?
    @State private var showPrivacyConsentAlert = false
    @State private var pendingPrivacyAction: PrivacyProtectedAction?
    @State private var showDebugSettings = false
    @State private var restingViewportSize: CGSize = .zero
    @FocusState private var focusedField: FocusField?

    private enum LoginMode {
        case verificationCode
        case password
    }

    private enum FocusField {
        case phone, code, password
    }

    private enum PrivacyProtectedAction {
        case sendCode
        case login
    }

    private var isCounting: Bool { countdown > 0 }

    private var countdownText: String {
        isCounting ? L10n.Auth.codeResend(countdown) : L10n.Auth.getCode
    }

    private var canSendCode: Bool {
        !isCounting && normalizedPhone != nil && !isSendingCode && !isLoggingIn
    }

    private var canSubmit: Bool {
        guard normalizedPhone != nil, !isLoggingIn else { return false }
        switch mode {
        case .verificationCode:
            return code.count >= 4
        case .password:
            return !password.isEmpty
        }
    }

    private var isUsingChinese: Bool {
        language.effectiveLocale.identifier.lowercased().hasPrefix("zh")
    }

    /// 输入框保留本地 11 位展示；系统建议的 `+86` 与分隔空格在进入认证链路前归一。
    private var normalizedPhone: String? {
        LoginPhoneNumber.normalized(phone)
    }

    var body: some View {
        GeometryReader { geo in
            let isEditing = focusedField != nil
            let bottomSafeInset = geo.safeAreaInsets.bottom
            // 键盘会压缩 GeometryReader。设备形态沿用键盘出现前的稳定窗口，
            // 避免 iPad 在输入时误判横竖屏；表单本身始终只有这一处实例。
            let layoutViewport = restingViewportSize == .zero ? geo.size : restingViewportSize
            let isTablet = layoutViewport.width >= 700
            let usesSplitLayout = !isEditing
                && isTablet
                && layoutViewport.width > layoutViewport.height
                && geo.size.width * LoginLayout.authWidthRatio >= LoginLayout.minimumSplitAuthWidth

            let stageWidth = usesSplitLayout
                ? geo.size.width * LoginLayout.stageWidthRatio
                : geo.size.width
            let stageHeight = isEditing
                ? max(geo.size.height - LoginLayout.headerHeight, 0)
                : usesSplitLayout
                    ? max(geo.size.height - LoginLayout.headerHeight, 0)
                    : max(
                        geo.size.height
                            - LoginLayout.headerHeight
                            - LoginLayout.authHeight
                            - bottomSafeInset,
                        0
                    )

            let authWidth = usesSplitLayout
                ? geo.size.width - stageWidth
                : isTablet
                    ? min(LoginLayout.maximumPortraitAuthWidth, geo.size.width)
                    : geo.size.width
            let authHeight = isEditing
                ? max(geo.size.height - LoginLayout.headerHeight, 0)
                : usesSplitLayout
                    ? max(geo.size.height - LoginLayout.headerHeight, 0)
                    : min(
                        LoginLayout.authHeight + bottomSafeInset,
                        max(geo.size.height - LoginLayout.headerHeight, 0)
                    )
            let authX = usesSplitLayout
                ? stageWidth
                : (geo.size.width - authWidth) / 2
            let authY = isEditing || usesSplitLayout
                ? LoginLayout.headerHeight
                : max(LoginLayout.headerHeight, geo.size.height - authHeight)
            let authHorizontalPadding: CGFloat = usesSplitLayout
                ? 24
                : isTablet ? 0 : 20

            ZStack(alignment: .topLeading) {
                LoginPalette.paper
                    .ignoresSafeArea()

                motionStage(
                    isActive: !isEditing && scenePhase == .active,
                    drawsRightRule: usesSplitLayout
                )
                .frame(width: stageWidth, height: stageHeight)
                .offset(x: 0, y: LoginLayout.headerHeight)
                .opacity(isEditing ? 0 : 1)
                .allowsHitTesting(false)

                // 单一表单实例只改变 frame/offset，不随键盘在不同分支间销毁重建。
                authPanel(
                    availableHeight: authHeight,
                    bottomSafeInset: bottomSafeInset,
                    horizontalPadding: authHorizontalPadding,
                    centersVertically: usesSplitLayout
                )
                .frame(width: authWidth, height: authHeight)
                .offset(x: authX, y: authY)

                loginHeader
                    .frame(width: geo.size.width, height: LoginLayout.headerHeight)

                if let errorMessage {
                    loginErrorHint(errorMessage)
                        .frame(width: geo.size.width)
                        .offset(y: LoginLayout.headerHeight)
                }
            }
            .frame(width: geo.size.width, height: geo.size.height, alignment: .topLeading)
            .clipped()
            .onAppear {
                if restingViewportSize == .zero {
                    restingViewportSize = geo.size
                }
            }
            .onChange(of: geo.size) { _, newSize in
                if focusedField == nil {
                    restingViewportSize = newSize
                }
            }
        }
        .ignoresSafeArea(.container, edges: .bottom)
        .background(LoginPalette.paper.ignoresSafeArea())
        .preferredColorScheme(.light)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button(L10n.Common.confirm) {
                    focusedField = nil
                }
            }
        }
        .alert(L10n.Auth.privacyConsentTitle, isPresented: $showPrivacyConsentAlert) {
            Button(L10n.Auth.privacyConsentAgree) {
                acceptPrivacyAndResumePendingAction()
            }
            Button(L10n.Auth.privacyConsentDisagree, role: .cancel) {
                pendingPrivacyAction = nil
            }
        } message: {
            Text(L10n.Auth.privacyConsentMessage)
        }
        .sheet(isPresented: $showDebugSettings) {
            NavigationStack {
                DebugSettingsScreen()
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button(L10n.Common.cancel) { showDebugSettings = false }
                        }
                    }
            }
        }
    }

    private var loginHeader: some View {
        HStack(spacing: 0) {
            Text("TabTin")
                .font(.system(size: 14, weight: .heavy))
                .tracking(-0.55)
                .foregroundStyle(LoginPalette.ink)

            Spacer(minLength: 0)

            Button {
                focusedField = nil
                showDebugSettings = true
            } label: {
                Image(systemName: "ladybug.fill")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(LoginPalette.ink)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(L10n.Debug.entry)

            Button(action: toggleLanguage) {
                Text(isUsingChinese ? "EN" : "中")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(LoginPalette.ink)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(
                isUsingChinese
                    ? L10n.Auth.switchToEnglish
                    : L10n.Auth.switchToChinese
            )
            .accessibilityValue(isUsingChinese ? "English" : "简体中文")
        }
        .padding(.horizontal, 20)
        .background(LoginPalette.paper)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(LoginPalette.ink)
                .frame(height: 1)
        }
        .accessibilityElement(children: .contain)
    }

    private func loginErrorHint(_ message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.circle.fill")
                .font(.system(size: 13, weight: .bold))

            Text(message)
                .font(.system(size: 12, weight: .semibold))
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .foregroundStyle(LoginPalette.error)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(.white)
        .overlay {
            Rectangle()
                .strokeBorder(LoginPalette.ink, lineWidth: 2)
        }
        .padding(.horizontal, 20)
        .padding(.top, 8)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(message)
    }

    private func motionStage(
        isActive: Bool,
        drawsRightRule: Bool
    ) -> some View {
        LoginMotionView(isActive: isActive)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(LoginPalette.paper)
            .clipped()
            .overlay(alignment: .trailing) {
                if drawsRightRule {
                    Rectangle()
                        .fill(LoginPalette.ink)
                        .frame(width: 1)
                }
            }
            .overlay(alignment: .bottom) {
                if !drawsRightRule {
                    Rectangle()
                        .fill(LoginPalette.ink)
                        .frame(height: 1)
                }
            }
    }

    private func authPanel(
        availableHeight: CGFloat,
        bottomSafeInset: CGFloat,
        horizontalPadding: CGFloat,
        centersVertically: Bool
    ) -> some View {
        let contentHeight = max(availableHeight - bottomSafeInset, 0)

        return ScrollView(.vertical, showsIndicators: false) {
            VStack(spacing: 0) {
                if centersVertically {
                    Spacer(minLength: 24)
                }

                authForm
                    .padding(.horizontal, horizontalPadding)

                if centersVertically {
                    Spacer(minLength: 24)
                }
            }
            .frame(minHeight: contentHeight)
            .padding(.bottom, bottomSafeInset)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(LoginPalette.paper)
    }

    private var authForm: some View {
        VStack(spacing: 0) {
            authHead
                .frame(height: 44)
                .padding(.bottom, 6)

            inputArea

            loginButton
                .padding(.top, 8)

            formFoot
                .frame(height: 20)
                .padding(.top, 4)

            privacyAgreement
                .frame(height: 44)
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    private var authHead: some View {
        HStack(spacing: 8) {
            Text(isUsingChinese ? "欢迎回来" : "Welcome back")
                .font(.system(size: 14, weight: .heavy))
                .tracking(-0.3)
                .foregroundStyle(LoginPalette.ink)
                .lineLimit(1)

            Spacer(minLength: 4)

            HStack(spacing: 2) {
                loginModeButton(
                    .verificationCode,
                    title: isUsingChinese ? "验证码登录" : "Verification code"
                )
                loginModeButton(
                    .password,
                    title: isUsingChinese ? "密码登录" : "Password"
                )
            }
            .frame(height: 44)
        }
        .accessibilityElement(children: .contain)
    }

    private func loginModeButton(
        _ targetMode: LoginMode,
        title: String
    ) -> some View {
        let isSelected = mode == targetMode

        return Button {
            selectMode(targetMode)
        } label: {
            Text(title)
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(isSelected ? LoginPalette.ink : LoginPalette.muted)
                .lineLimit(1)
                .padding(.horizontal, 6)
                .frame(height: 44)
                .overlay(alignment: .bottom) {
                    Rectangle()
                        .fill(isSelected ? LoginPalette.blue : .clear)
                        .frame(height: 2)
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityLabel(title)
    }

    private var inputArea: some View {
        VStack(spacing: 6) {
            phoneField

            if mode == .verificationCode {
                codeField
            } else {
                passwordField
            }
        }
    }

    private var phoneField: some View {
        HStack(spacing: 0) {
            fieldLabel(isUsingChinese ? L10n.Auth.emailOrPhone : "Account")

            Rectangle()
                .fill(LoginPalette.ink.opacity(0.20))
                .frame(width: 1)

            TextField(
                "",
                text: $phone,
                prompt: Text(L10n.Auth.emailOrPhonePlaceholder)
                    .foregroundStyle(LoginPalette.muted)
            )
            .font(.system(size: 13))
            .foregroundStyle(LoginPalette.ink)
            .tint(LoginPalette.blue)
            .keyboardType(.emailAddress)
            .textContentType(.username)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .focused($focusedField, equals: .phone)
            .padding(.horizontal, 11)
            .accessibilityLabel(L10n.Auth.emailOrPhone)
            .onChange(of: phone) { oldValue, newValue in
                errorMessage = nil
                let previousEditingValue = LoginPhoneNumber.editingValue(oldValue)
                let editingValue = LoginPhoneNumber.editingValue(newValue)
                if editingValue != previousEditingValue {
                    auth.invalidateLoginVerificationChallenge()
                    resetCountdown()
                }
                if editingValue != newValue {
                    phone = editingValue
                }
            }
        }
        .editorialField(isFocused: focusedField == .phone)
    }

    private var codeField: some View {
        HStack(spacing: 0) {
            fieldLabel(isUsingChinese ? L10n.Auth.verificationCode : "Code")

            Rectangle()
                .fill(LoginPalette.ink.opacity(0.20))
                .frame(width: 1)

            TextField(
                "",
                text: $code,
                prompt: Text(L10n.Auth.codePlaceholder)
                    .foregroundStyle(LoginPalette.muted)
            )
            .font(.system(size: 13))
            .foregroundStyle(LoginPalette.ink)
            .tint(LoginPalette.blue)
            .keyboardType(.numberPad)
            .textContentType(.oneTimeCode)
            .focused($focusedField, equals: .code)
            .padding(.horizontal, 11)
            .accessibilityLabel(L10n.Auth.verificationCode)
            .onChange(of: code) { _, newValue in
                errorMessage = nil
                let editingValue = LoginVerificationCode.editingValue(newValue)
                guard editingValue != newValue else { return }
                code = editingValue
            }

            Button {
                requestSendCode()
            } label: {
                Group {
                    if isSendingCode {
                        ProgressView()
                            .controlSize(.small)
                            .tint(LoginPalette.ink)
                    } else {
                        Text(countdownText)
                            .font(.system(size: 10, weight: .bold))
                            .lineLimit(1)
                            .minimumScaleFactor(0.78)
                    }
                }
                .foregroundStyle(canSendCode ? LoginPalette.ink : LoginPalette.muted)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(canSendCode ? LoginPalette.paper : LoginPalette.disabled)
                .contentShape(Rectangle())
            }
            .frame(width: 104)
            .overlay(alignment: .leading) {
                Rectangle()
                    .fill(LoginPalette.ink)
                    .frame(width: 2)
            }
            .disabled(!canSendCode)
            .buttonStyle(.plain)
        }
        .editorialField(isFocused: focusedField == .code)
    }

    private var passwordField: some View {
        HStack(spacing: 0) {
            fieldLabel(isUsingChinese ? L10n.Auth.password : "Password")

            Rectangle()
                .fill(LoginPalette.ink.opacity(0.20))
                .frame(width: 1)

            Group {
                if isPasswordVisible {
                    TextField(
                        "",
                        text: $password,
                        prompt: Text(L10n.Auth.passwordPlaceholder)
                            .foregroundStyle(LoginPalette.muted)
                    )
                    .accessibilityLabel(L10n.Auth.password)
                } else {
                    SecureField(
                        "",
                        text: $password,
                        prompt: Text(L10n.Auth.passwordPlaceholder)
                            .foregroundStyle(LoginPalette.muted)
                    )
                    .accessibilityLabel(L10n.Auth.password)
                }
            }
            .font(.system(size: 13))
            .foregroundStyle(LoginPalette.ink)
            .tint(LoginPalette.blue)
            .textContentType(.password)
            .focused($focusedField, equals: .password)
            .padding(.horizontal, 11)

            Button {
                isPasswordVisible.toggle()
                focusedField = .password
            } label: {
                Text(passwordVisibilityTitle)
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(LoginPalette.ink)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(LoginPalette.paper)
                    .contentShape(Rectangle())
            }
            .frame(width: 52)
            .overlay(alignment: .leading) {
                Rectangle()
                    .fill(LoginPalette.ink)
                    .frame(width: 2)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(
                isPasswordVisible ? L10n.Auth.hidePassword : L10n.Auth.showPassword
            )
        }
        .editorialField(isFocused: focusedField == .password)
    }

    private func fieldLabel(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(LoginPalette.muted)
            .lineLimit(1)
            .minimumScaleFactor(0.72)
            .padding(.leading, 10)
            .frame(width: 64, alignment: .leading)
            .frame(maxHeight: .infinity, alignment: .leading)
    }

    private var loginButton: some View {
        Button {
            requestLogin()
        } label: {
            Group {
                if isLoggingIn {
                    ProgressView()
                        .tint(.white)
                } else {
                    Text(L10n.Auth.login)
                        .font(.system(size: 12, weight: .heavy))
                        .foregroundStyle(.white)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(LoginPalette.blue)
            .contentShape(Rectangle())
        }
        .frame(height: 44)
        .overlay {
            Rectangle()
                .strokeBorder(LoginPalette.ink, lineWidth: 2)
        }
        .disabled(!canSubmit)
        .buttonStyle(.plain)
    }

    private var formFoot: some View {
        HStack(spacing: 8) {
            Text(formStatus)
                .font(.system(size: 10))
                .foregroundStyle(LoginPalette.muted)
                .lineLimit(1)

            Spacer(minLength: 4)

            if mode == .password {
                Button {
                    selectMode(.verificationCode)
                } label: {
                    Text(isUsingChinese ? "忘记密码" : "Forgot password")
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .padding(.vertical, -12)
                .zIndex(1)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(LoginPalette.ink)
                .buttonStyle(.plain)
            }
        }
    }

    private var privacyAgreement: some View {
        HStack(spacing: 5) {
            Button {
                if privacy.hasAcceptedPrivacyPolicy {
                    privacy.revokePrivacyPolicy()
                } else {
                    privacy.acceptPrivacyPolicy()
                }
            } label: {
                ZStack {
                    Rectangle()
                        .fill(
                            privacy.hasAcceptedPrivacyPolicy
                                ? LoginPalette.blue
                                : LoginPalette.paper
                        )
                    Rectangle()
                        .strokeBorder(LoginPalette.ink, lineWidth: 1.5)
                    if privacy.hasAcceptedPrivacyPolicy {
                        Image(systemName: "checkmark")
                            .font(.system(size: 8, weight: .black))
                            .foregroundStyle(.white)
                    }
                }
                .frame(width: 14, height: 14)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
            }
            .padding(.horizontal, -15)
            .zIndex(1)
            .buttonStyle(.plain)
            .accessibilityLabel(L10n.Auth.privacyCheckboxLabel)
            .accessibilityValue(
                privacy.hasAcceptedPrivacyPolicy
                    ? (isUsingChinese ? "已选中" : "Selected")
                    : (isUsingChinese ? "未选中" : "Not selected")
            )
            .accessibilityAddTraits(
                privacy.hasAcceptedPrivacyPolicy ? .isSelected : []
            )

            HStack(spacing: 0) {
                Text(L10n.Auth.privacyAgreementPrefix)
                    .foregroundStyle(LoginPalette.muted)
                Link(destination: PrivacyConsentStore.privacyPolicyURL) {
                    Text(L10n.Auth.privacyPolicy)
                        .foregroundStyle(LoginPalette.ink)
                        .underline()
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
            }
            .font(.system(size: 9))
            .lineLimit(1)

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var passwordVisibilityTitle: String {
        if isUsingChinese {
            return isPasswordVisible ? "隐藏" : "显示"
        }
        return isPasswordVisible ? "Hide" : "Show"
    }

    private var formStatus: String {
        if mode == .verificationCode {
            return isUsingChinese
                ? "验证码将发送至你的邮箱或手机"
                : "A code will be sent to your email or phone"
        }
        return isUsingChinese
            ? "使用已有账号密码登录"
            : "Use your account password"
    }

    private func selectMode(_ targetMode: LoginMode) {
        guard mode != targetMode else { return }
        mode = targetMode
        errorMessage = nil
        code = ""
        password = ""
        isPasswordVisible = false
        focusedField = nil
    }

    private func toggleLanguage() {
        language.language = isUsingChinese ? .en : .zhHans
    }

    private func requestSendCode() {
        guard canSendCode else { return }
        guard requestPrivacyConsentIfNeeded(for: .sendCode) else { return }
        sendCode()
    }

    private func requestLogin() {
        guard canSubmit else { return }
        guard requestPrivacyConsentIfNeeded(for: .login) else { return }
        login()
    }

    private func requestPrivacyConsentIfNeeded(
        for action: PrivacyProtectedAction
    ) -> Bool {
        if privacy.hasAcceptedPrivacyPolicy { return true }
        pendingPrivacyAction = action
        showPrivacyConsentAlert = true
        return false
    }

    private func acceptPrivacyAndResumePendingAction() {
        let action = pendingPrivacyAction
        pendingPrivacyAction = nil
        privacy.acceptPrivacyPolicy()

        switch action {
        case .sendCode:
            sendCode()
        case .login:
            login()
        case nil:
            break
        }
    }

    private func sendCode() {
        guard canSendCode, let phone = normalizedPhone else { return }
        let requestPhone = phone
        errorMessage = nil
        isSendingCode = true
        Task {
            defer { isSendingCode = false }
            do {
                let challengeIsCurrent = try await auth.sendVerificationCode(phone: requestPhone)
                guard challengeIsCurrent, normalizedPhone == requestPhone else { return }
                startCountdown()
            } catch {
                guard normalizedPhone == requestPhone else { return }
                showError(error, context: .sendCode)
            }
        }
    }

    private func login() {
        guard canSubmit, let phone = normalizedPhone else { return }
        errorMessage = nil
        isLoggingIn = true
        Task {
            defer { isLoggingIn = false }
            do {
                switch mode {
                case .verificationCode:
                    try await auth.loginWithCode(phone: phone, code: code)
                case .password:
                    try await auth.loginWithPassword(phone: phone, password: password)
                }
            } catch {
                showError(
                    error,
                    context: mode == .verificationCode ? .verificationCode : .password
                )
            }
        }
    }

    private func startCountdown() {
        countdownTask?.cancel()
        countdown = 60
        countdownTask = Task { @MainActor in
            while countdown > 0, !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(1))
                } catch {
                    return
                }
                guard countdown > 0, !Task.isCancelled else { return }
                countdown -= 1
            }
        }
    }

    private func resetCountdown() {
        countdownTask?.cancel()
        countdownTask = nil
        countdown = 0
    }

    private func showError(_ error: Error, context: LoginErrorContext) {
        errorMessage = LoginErrorPresentation.message(for: error, context: context)
    }

}

enum LoginErrorContext {
    case sendCode
    case verificationCode
    case password
}

/// 登录页的安全展示边界：不把服务端 message、业务码或底层异常原样暴露给用户。
enum LoginErrorPresentation {
    static func message(for error: Error, context: LoginErrorContext) -> String {
        if isNetworkError(error) {
            return L10n.Auth.networkError
        }
        switch context {
        case .sendCode:
            return L10n.Auth.sendCodeFailed
        case .verificationCode:
            return isCredentialFailure(error)
                ? L10n.Auth.invalidVerificationCode
                : L10n.Auth.loginError
        case .password:
            return isCredentialFailure(error)
                ? L10n.Auth.invalidPassword
                : L10n.Auth.loginError
        }
    }

    private static func isNetworkError(_ error: Error) -> Bool {
        guard let apiError = error as? APIError else {
            return error is URLError
        }
        if case .networkError = apiError { return true }
        return false
    }

    private static func isCredentialFailure(_ error: Error) -> Bool {
        guard let apiError = error as? APIError else { return false }
        let knownCodes = Set([
            "AUTH_INVALID",
            "AUTH_VERIFICATION_CHALLENGE_REQUIRED",
            "AUTH_VERIFICATION_CODE_INVALID",
            "VERIFICATION_CODE_INVALID",
        ])
        if let code = apiError.businessCode?.uppercased(), knownCodes.contains(code) {
            return true
        }
        switch apiError {
        case .unauthorized:
            return true
        case .serverError(let status, _):
            return status == 400 || status == 401 || status == 403
        default:
            return false
        }
    }

}

/// 登录标识符：默认与桌面同一套「邮箱或大陆手机号」口径。
/// 手机号路径仍接受系统电话建议带来的 `+86` 与格式分隔符。
enum LoginPhoneNumber {
    static func parseEmailLoginEnabled(_ raw: String?) -> Bool {
        (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased() != "false"
    }

    static var emailLoginEnabled: Bool { true }

    static func editingValue(
        _ input: String,
        emailLoginEnabled: Bool = LoginPhoneNumber.emailLoginEnabled
    ) -> String {
        if emailLoginEnabled, input.contains(where: { character in
            character == "@" || ("A"..."Z").contains(character) || ("a"..."z").contains(character)
        }) {
            return input
        }
        return sanitizedCnMobilePhone(input)
    }

    static func normalized(
        _ input: String,
        emailLoginEnabled: Bool = LoginPhoneNumber.emailLoginEnabled
    ) -> String? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if emailLoginEnabled, trimmed.contains("@") {
            let email = trimmed.lowercased()
            return isValidEmail(email) ? email : nil
        }
        let value = sanitizedCnMobilePhone(input)
        return isValidCnPhone(value) ? value : nil
    }

    private static func sanitizedCnMobilePhone(_ input: String) -> String {
        let digits = input.compactMap(\.wholeNumberValue).map(String.init).joined()
        let localDigits: Substring
        if digits.count > 11, digits.hasPrefix("861") {
            localDigits = digits.dropFirst(2)
        } else if digits.count > 11, digits.hasPrefix("00861") {
            localDigits = digits.dropFirst(4)
        } else {
            localDigits = digits[...]
        }
        return String(localDigits.prefix(11))
    }

    private static func isValidEmail(_ value: String) -> Bool {
        value.range(of: #"^[^\s@]+@[^\s@]+\.[^\s@]+$"#, options: .regularExpression) != nil
    }

    private static func isValidCnPhone(_ value: String) -> Bool {
        value.range(of: #"^1[3-9]\d{9}$"#, options: .regularExpression) != nil
    }
}

enum LoginVerificationCode {
    static func editingValue(_ input: String) -> String {
        input.compactMap(\.wholeNumberValue).prefix(6).map(String.init).joined()
    }
}

private enum LoginLayout {
    static let headerHeight: CGFloat = 54
    static let authHeight: CGFloat = 264
    static let maximumPortraitAuthWidth: CGFloat = 520
    static let minimumSplitAuthWidth: CGFloat = 360
    static let stageWidthRatio: CGFloat = 0.62
    static let authWidthRatio: CGFloat = 0.38
}

private enum LoginPalette {
    static let paper = Color(hex: 0xF1EEE5)
    static let ink = Color(hex: 0x20201C)
    static let blue = Color(hex: 0x086BE4)
    static let muted = Color(hex: 0x6E6961)
    static let disabled = Color(hex: 0xDEDAD0)
    static let error = Color(hex: 0xB42318)
}

private struct EditorialFieldModifier: ViewModifier {
    let isFocused: Bool

    func body(content: Content) -> some View {
        content
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            .frame(height: 44)
            .background(.white)
            .overlay {
                Rectangle()
                    .strokeBorder(LoginPalette.ink, lineWidth: 2)
            }
            .overlay(alignment: .bottom) {
                if isFocused {
                    Rectangle()
                        .fill(LoginPalette.blue)
                        .frame(height: 4)
                        .padding(.horizontal, 2)
                        .padding(.bottom, 2)
                }
            }
    }
}

private extension View {
    func editorialField(isFocused: Bool) -> some View {
        modifier(EditorialFieldModifier(isFocused: isFocused))
    }
}

#Preview {
    LoginView()
}
