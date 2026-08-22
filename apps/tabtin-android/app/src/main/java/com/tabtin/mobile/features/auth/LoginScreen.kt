package com.tabtin.mobile.features.auth

import android.app.Activity
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.BugReport
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.core.view.WindowCompat
import com.tabtin.mobile.R
import com.tabtin.mobile.features.profile.DebugEnvironmentDialog
import com.tabtin.mobile.features.profile.ProfileViewModel
import com.tabtin.mobile.ui.theme.AppLanguage
import java.util.Locale

private const val PRIVACY_POLICY_URL = "https://preview-a9f4c2d8e1.example.com/privacy/"
private const val TABLET_MIN_WIDTH_DP = 600
private const val LANDSCAPE_AUTH_MIN_WIDTH_DP = 360
private const val TABLET_LANDSCAPE_STAGE_WEIGHT = 0.62f

private val LoginPaper = Color(0xFFF1EEE5)
private val LoginInk = Color(0xFF20201C)
private val LoginBlue = Color(0xFF086BE4)
private val LoginMutedInk = Color(0xFF6E6961)
private val LoginDisabled = Color(0xFFDEDAD0)
private val LoginError = Color(0xFFB42318)

private val LoginHeaderHeight = 54.dp
private val LoginAuthHeight = 264.dp
private val LoginTabletFormMaxWidth = 520.dp

private enum class LoginPrivacyPendingAction {
    SendCode,
    Login,
}

/** 登录页是固定浅纸视觉；离开时把宿主主题的系统栏状态原样交还。 */
@Composable
@Suppress("DEPRECATION")
private fun LoginPaperSystemBars() {
    val view = LocalView.current
    val window = (view.context as? Activity)?.window

    DisposableEffect(window, view) {
        if (window == null) {
            onDispose { }
        } else {
            val insetsController = WindowCompat.getInsetsController(window, view)
            val originalStatusBarColor = window.statusBarColor
            val originalNavigationBarColor = window.navigationBarColor
            val originalLightStatusBars = insetsController.isAppearanceLightStatusBars
            val originalLightNavigationBars = insetsController.isAppearanceLightNavigationBars

            window.statusBarColor = LoginPaper.toArgb()
            window.navigationBarColor = LoginPaper.toArgb()
            insetsController.isAppearanceLightStatusBars = true
            insetsController.isAppearanceLightNavigationBars = true

            onDispose {
                window.statusBarColor = originalStatusBarColor
                window.navigationBarColor = originalNavigationBarColor
                insetsController.isAppearanceLightStatusBars = originalLightStatusBars
                insetsController.isAppearanceLightNavigationBars = originalLightNavigationBars
            }
        }
    }

    // 全局主题也会维护系统栏；登录页的 SideEffect 后执行，确保暗色主题下仍是深色图标。
    SideEffect {
        if (window != null) {
            val insetsController = WindowCompat.getInsetsController(window, view)
            window.statusBarColor = LoginPaper.toArgb()
            window.navigationBarColor = LoginPaper.toArgb()
            insetsController.isAppearanceLightStatusBars = true
            insetsController.isAppearanceLightNavigationBars = true
        }
    }
}

/** Demo 的固定纸张页眉；右侧直接提供 Debug 环境与语言切换。 */
@Composable
private fun LoginTopBar(
    horizontalPadding: Dp,
    language: AppLanguage,
    onDebugEnvironmentClick: () -> Unit,
    onLanguageToggle: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(LoginHeaderHeight)
            .background(LoginPaper)
            .drawBottomRule(LoginInk, 1.dp)
            .padding(horizontal = horizontalPadding),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = stringResource(R.string.app_name),
            modifier = Modifier.weight(1f),
            color = LoginInk,
            fontSize = 14.sp,
            fontWeight = FontWeight.ExtraBold,
            letterSpacing = (-0.55).sp,
        )
        Box(
            modifier = Modifier
                .size(48.dp)
                .clickable(
                    role = Role.Button,
                    onClick = onDebugEnvironmentClick,
                )
                .semantics {
                    contentDescription = "Debug Environment"
                },
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = Icons.Default.BugReport,
                contentDescription = null,
                tint = LoginInk,
                modifier = Modifier.size(18.dp),
            )
        }
        Box(
            modifier = Modifier
                .size(48.dp)
                .clickable(
                    role = Role.Button,
                    onClick = onLanguageToggle,
                )
                .semantics {
                    contentDescription = if (language.isEnglishForLogin()) {
                        "切换至中文"
                    } else {
                        "Switch to English"
                    }
                },
            contentAlignment = Alignment.CenterEnd,
        ) {
            Text(
                text = if (language.isEnglishForLogin()) "中" else "EN",
                color = LoginInk,
                fontSize = 10.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 0.3.sp,
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun LoginErrorHint(
    message: String,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(Color.White)
            .border(2.dp, LoginInk, RectangleShape)
            .padding(horizontal = 12.dp, vertical = 10.dp)
            .semantics { liveRegion = LiveRegionMode.Assertive },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = "!",
            color = LoginError,
            fontSize = 13.sp,
            fontWeight = FontWeight.ExtraBold,
        )
        Spacer(Modifier.width(8.dp))
        Text(
            text = message,
            modifier = Modifier.weight(1f),
            color = LoginError,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

/** 动画占满舞台，宿主只负责 Demo 中的下边线或横屏分隔线。 */
@Composable
private fun LoginStage(
    language: AppLanguage,
    isActive: Boolean,
    dividerOnEnd: Boolean,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .background(LoginPaper)
            .then(
                if (dividerOnEnd) {
                    Modifier.drawEndRule(LoginInk, 1.dp)
                } else {
                    Modifier.drawBottomRule(LoginInk, 1.dp)
                },
            )
            .clearAndSetSemantics { },
    ) {
        LoginMotionView(
            language = language,
            isActive = isActive,
            modifier = Modifier.fillMaxSize(),
        )
    }
}

@Composable
private fun LoginModeTabs(
    language: AppLanguage,
    isCodeMode: Boolean,
    onModeSelected: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier.height(44.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        LoginModeTab(
            text = if (language.isEnglishForLogin()) "Verification code" else "验证码登录",
            selected = isCodeMode,
            onClick = { onModeSelected(true) },
        )
        Spacer(Modifier.width(2.dp))
        LoginModeTab(
            text = if (language.isEnglishForLogin()) "Password" else "密码登录",
            selected = !isCodeMode,
            onClick = { onModeSelected(false) },
        )
    }
}

@Composable
private fun LoginModeTab(
    text: String,
    selected: Boolean,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .height(44.dp)
            .drawBehind {
                if (selected) {
                    val strokeWidth = 2.dp.toPx()
                    drawLine(
                        color = LoginBlue,
                        start = Offset(0f, size.height - strokeWidth / 2f),
                        end = Offset(size.width, size.height - strokeWidth / 2f),
                        strokeWidth = strokeWidth,
                    )
                }
            }
            .selectable(
                selected = selected,
                role = Role.Tab,
                onClick = onClick,
            )
            .padding(horizontal = 6.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = text,
            color = if (selected) LoginInk else Color(0xFF777168),
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
        )
    }
}

@Composable
private fun EditorialLoginField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    actionWidth: Dp = 0.dp,
    action: (@Composable () -> Unit)? = null,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
) {
    var isFocused by remember { mutableStateOf(false) }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(44.dp)
            .background(Color.White)
            .border(2.dp, LoginInk, RectangleShape)
            .drawBehind {
                val borderWidth = 2.dp.toPx()
                if (isFocused) {
                    val focusWidth = 4.dp.toPx()
                    drawRect(
                        color = LoginBlue,
                        topLeft = Offset(borderWidth, size.height - borderWidth - focusWidth),
                        size = Size(size.width - borderWidth * 2f, focusWidth),
                    )
                }
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .width(64.dp)
                .fillMaxHeight()
                .drawEndRule(LoginInk.copy(alpha = 0.20f), 1.dp)
                .padding(start = 10.dp, end = 6.dp),
            contentAlignment = Alignment.CenterStart,
        ) {
            Text(
                text = label,
                color = LoginMutedInk,
                fontSize = 10.sp,
                lineHeight = 10.sp,
                fontWeight = FontWeight.Bold,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }

        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier
                .weight(1f)
                .fillMaxHeight()
                .onFocusChanged { isFocused = it.isFocused }
                .semantics { contentDescription = label },
            singleLine = true,
            textStyle = TextStyle(
                color = LoginInk,
                fontSize = 13.sp,
                fontWeight = FontWeight.Normal,
            ),
            cursorBrush = SolidColor(LoginBlue),
            visualTransformation = visualTransformation,
            keyboardOptions = keyboardOptions,
            keyboardActions = keyboardActions,
            decorationBox = { innerTextField ->
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(horizontal = 11.dp),
                    contentAlignment = Alignment.CenterStart,
                ) {
                    if (value.isEmpty()) {
                        Text(
                            text = placeholder,
                            color = Color(0xFF8A857D),
                            fontSize = 13.sp,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    innerTextField()
                }
            },
        )

        if (action != null) {
            Box(
                modifier = Modifier
                    .width(actionWidth)
                    .fillMaxHeight()
                    .drawStartRule(LoginInk, 2.dp),
            ) {
                action()
            }
        }
    }
}

@Composable
private fun LoginCodeAction(
    isSending: Boolean,
    countdownSeconds: Int,
    onClick: () -> Unit,
) {
    val enabled = countdownSeconds == 0 && !isSending
    val label = if (countdownSeconds > 0) {
        stringResource(R.string.auth_code_resend, countdownSeconds)
    } else {
        stringResource(R.string.auth_get_code)
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(if (enabled) LoginPaper else LoginDisabled)
            .clickable(
                enabled = enabled,
                role = Role.Button,
                onClick = onClick,
            )
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        if (isSending) {
            CircularProgressIndicator(
                modifier = Modifier.size(16.dp),
                color = LoginInk,
                strokeWidth = 2.dp,
            )
        } else {
            Text(
                text = label,
                color = if (enabled) LoginInk else Color(0xFF777168),
                fontSize = 10.sp,
                lineHeight = 11.sp,
                fontWeight = FontWeight.Bold,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun LoginPasswordAction(
    language: AppLanguage,
    isPasswordVisible: Boolean,
    onClick: () -> Unit,
) {
    val accessibilityLabel = stringResource(
        if (isPasswordVisible) R.string.auth_hide_password else R.string.auth_show_password,
    )
    val compactLabel = when {
        language.isEnglishForLogin() && isPasswordVisible -> "Hide"
        language.isEnglishForLogin() -> "Show"
        isPasswordVisible -> "隐藏"
        else -> "显示"
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(LoginPaper)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics { contentDescription = accessibilityLabel },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = compactLabel,
            color = LoginInk,
            fontSize = 10.sp,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
        )
    }
}

@Composable
private fun LoginSubmitButton(
    loading: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    val label = stringResource(R.string.auth_login)
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(44.dp)
            .background(LoginBlue)
            .border(2.dp, LoginInk, RectangleShape)
            .clickable(
                enabled = enabled && !loading,
                role = Role.Button,
                onClick = onClick,
            )
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        if (loading) {
            CircularProgressIndicator(
                modifier = Modifier.size(18.dp),
                color = Color.White,
                strokeWidth = 2.dp,
            )
        } else {
            Text(
                text = label,
                color = Color.White.copy(alpha = if (enabled) 1f else 0.64f),
                fontSize = 12.sp,
                fontWeight = FontWeight.ExtraBold,
            )
        }
    }
}

@Composable
private fun LoginFooter(
    state: LoginUiState,
    language: AppLanguage,
    onForgotPassword: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(20.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = loginStatusText(state, language),
            modifier = Modifier.weight(1f),
            color = LoginMutedInk,
            fontSize = 10.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (!state.isCodeMode) {
            Text(
                text = if (language.isEnglishForLogin()) "Forgot password" else "忘记密码",
                modifier = Modifier.clickable(
                    role = Role.Button,
                    onClick = onForgotPassword,
                ),
                color = LoginInk,
                fontSize = 10.sp,
                fontWeight = FontWeight.SemiBold,
                textDecoration = TextDecoration.Underline,
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun loginStatusText(
    state: LoginUiState,
    language: AppLanguage,
): String = when {
    state.isCodeMode && state.isSendingCode -> {
        if (language.isEnglishForLogin()) "Sending verification code…" else "正在发送验证码…"
    }
    state.isCodeMode && state.cooldownSeconds > 0 -> {
        if (language.isEnglishForLogin()) {
            "Code sent. Enter it within 60 seconds"
        } else {
            "验证码已发送，请在 60 秒内输入"
        }
    }
    state.isCodeMode && state.codeSent -> {
        if (language.isEnglishForLogin()) "Didn't receive it? You can resend now" else "未收到验证码？现在可以重新发送"
    }
    state.isCodeMode -> {
        if (language.isEnglishForLogin()) "We'll send a code to your email or phone" else "验证码会发送到你的邮箱或手机"
    }
    else -> {
        if (language.isEnglishForLogin()) "Return to your work after signing in" else "登录后恢复你的工作现场"
    }
}

@Composable
private fun LoginPrivacyLine(
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    onOpenPrivacyPolicy: () -> Unit,
) {
    val checkboxDescription = "${stringResource(R.string.auth_privacy_agreement_prefix)} " +
        stringResource(R.string.auth_privacy_policy)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(48.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                // 可见方框保持 14dp；48dp 行高与 Compose 的横向 touch slop
                // 共同构成至少 48×48dp 的复选框点击区，不额外挤高固定表单。
                .width(14.dp)
                .fillMaxHeight()
                .toggleable(
                    value = checked,
                    role = Role.Checkbox,
                    onValueChange = onCheckedChange,
                )
                .semantics { contentDescription = checkboxDescription },
            contentAlignment = Alignment.Center,
        ) {
            Box(
                modifier = Modifier
                    .size(14.dp)
                    .background(if (checked) LoginBlue else Color.Transparent)
                    .border(1.dp, LoginInk, RectangleShape),
                contentAlignment = Alignment.Center,
            ) {
                if (checked) {
                    Text(
                        text = "✓",
                        color = Color.White,
                        fontSize = 9.sp,
                        lineHeight = 9.sp,
                        fontWeight = FontWeight.Bold,
                    )
                }
            }
        }
        Spacer(Modifier.width(6.dp))
        Text(
            text = stringResource(R.string.auth_privacy_agreement_prefix),
            color = LoginMutedInk,
            fontSize = 9.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Spacer(Modifier.width(3.dp))
        Text(
            text = stringResource(R.string.auth_privacy_policy),
            modifier = Modifier.clickable(
                role = Role.Button,
                onClick = onOpenPrivacyPolicy,
            ),
            color = LoginInk,
            fontSize = 9.sp,
            fontWeight = FontWeight.SemiBold,
            textDecoration = TextDecoration.Underline,
            maxLines = 1,
        )
    }
}

/**
 * 与 Demo 一致的原生表单：纸张底、方角黑框、固定标签列和动作格。
 * 面板自身不再承担卡片、渐变、圆角或阴影语义。
 */
@Composable
private fun LoginAuthPanel(
    modifier: Modifier,
    state: LoginUiState,
    language: AppLanguage,
    horizontalPadding: Dp,
    verticallyCentered: Boolean,
    hasAcceptedPrivacyPolicy: Boolean,
    isPasswordVisible: Boolean,
    onModeSelected: (Boolean) -> Unit,
    onPhoneChange: (String) -> Unit,
    onCodeChange: (String) -> Unit,
    onPasswordChange: (String) -> Unit,
    onPasswordVisibilityToggle: () -> Unit,
    onSendCode: () -> Unit,
    onLogin: () -> Unit,
    onPrivacyPolicyAcceptedChange: (Boolean) -> Unit,
    onOpenPrivacyPolicy: () -> Unit,
    onDismissKeyboard: () -> Unit,
) {
    val focusManager = LocalFocusManager.current
    val scrollState = rememberScrollState()

    Box(
        modifier = modifier
            .background(LoginPaper)
            .pointerInput(Unit) {
                detectTapGestures(onTap = { onDismissKeyboard() })
            },
    ) {
        Column(
            modifier = Modifier
                .align(if (verticallyCentered) Alignment.Center else Alignment.TopCenter)
                .widthIn(max = LoginTabletFormMaxWidth)
                .fillMaxWidth()
                .verticalScroll(scrollState)
                .padding(
                    start = horizontalPadding,
                    end = horizontalPadding,
                ),
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(44.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = if (language.isEnglishForLogin()) "Welcome back" else "欢迎回来",
                    modifier = Modifier.weight(1f),
                    color = LoginInk,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.ExtraBold,
                    letterSpacing = (-0.25).sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                LoginModeTabs(
                    language = language,
                    isCodeMode = state.isCodeMode,
                    onModeSelected = onModeSelected,
                )
            }
            Spacer(Modifier.height(6.dp))

            EditorialLoginField(
                label = if (language.isEnglishForLogin()) {
                    "Account"
                } else {
                    stringResource(R.string.auth_phone_label)
                },
                value = state.phone,
                onValueChange = onPhoneChange,
                placeholder = stringResource(R.string.auth_phone_placeholder),
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Email,
                    imeAction = ImeAction.Next,
                ),
                keyboardActions = KeyboardActions(
                    onNext = { focusManager.moveFocus(FocusDirection.Down) },
                ),
            )
            Spacer(Modifier.height(6.dp))

            if (state.isCodeMode) {
                EditorialLoginField(
                    label = if (language.isEnglishForLogin()) {
                        "Code"
                    } else {
                        stringResource(R.string.auth_code_label)
                    },
                    value = state.verificationCode,
                    onValueChange = onCodeChange,
                    placeholder = stringResource(R.string.auth_code_placeholder),
                    actionWidth = 104.dp,
                    action = {
                        LoginCodeAction(
                            isSending = state.isSendingCode,
                            countdownSeconds = state.cooldownSeconds,
                            onClick = onSendCode,
                        )
                    },
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Number,
                        imeAction = ImeAction.Done,
                    ),
                    keyboardActions = KeyboardActions(onDone = { onDismissKeyboard() }),
                )
            } else {
                EditorialLoginField(
                    label = if (language.isEnglishForLogin()) {
                        "Password"
                    } else {
                        stringResource(R.string.auth_password_label)
                    },
                    value = state.password,
                    onValueChange = onPasswordChange,
                    placeholder = stringResource(R.string.auth_password_placeholder),
                    actionWidth = 52.dp,
                    action = {
                        LoginPasswordAction(
                            language = language,
                            isPasswordVisible = isPasswordVisible,
                            onClick = onPasswordVisibilityToggle,
                        )
                    },
                    visualTransformation = if (isPasswordVisible) {
                        VisualTransformation.None
                    } else {
                        PasswordVisualTransformation()
                    },
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Password,
                        imeAction = ImeAction.Done,
                    ),
                    keyboardActions = KeyboardActions(onDone = { onDismissKeyboard() }),
                )
            }

            Spacer(Modifier.height(4.dp))
            LoginSubmitButton(
                loading = state.isLoggingIn,
                enabled = state.phone.isNotBlank() &&
                    (if (state.isCodeMode) state.verificationCode.isNotBlank() else state.password.isNotBlank()),
                onClick = onLogin,
            )
            Spacer(Modifier.height(4.dp))
            LoginFooter(
                state = state,
                language = language,
                onForgotPassword = {
                    if (!state.isCodeMode) onModeSelected(true)
                },
            )
            LoginPrivacyLine(
                checked = hasAcceptedPrivacyPolicy,
                onCheckedChange = onPrivacyPolicyAcceptedChange,
                onOpenPrivacyPolicy = onOpenPrivacyPolicy,
            )
        }
    }
}

@Composable
@OptIn(ExperimentalLayoutApi::class)
public fun LoginScreen(
    viewModel: LoginViewModel,
    onLoginSuccess: (requiresInviteCode: Boolean) -> Unit,
) {
    val state by viewModel.uiState.collectAsState()
    val context = LocalContext.current
    val focusManager = LocalFocusManager.current
    val keyboardController = LocalSoftwareKeyboardController.current
    val debugViewModel: ProfileViewModel = hiltViewModel()
    var hasAcceptedPrivacyPolicy by rememberSaveable { mutableStateOf(false) }
    var showPrivacyConsentDialog by rememberSaveable { mutableStateOf(false) }
    var isPasswordVisible by rememberSaveable { mutableStateOf(false) }
    var pendingPrivacyAction by rememberSaveable { mutableStateOf<LoginPrivacyPendingAction?>(null) }

    LoginPaperSystemBars()

    if (state.showDebugEnvironment) {
        DebugEnvironmentDialog(
            state = debugViewModel.debugEnvironment,
            onDismiss = viewModel::dismissDebugEnvironment,
            onApply = { draft ->
                if (debugViewModel.applyDebugEnvironment(draft)) {
                    viewModel.dismissDebugEnvironment()
                }
            },
            onReset = {
                viewModel.dismissDebugEnvironment()
                debugViewModel.resetDebugEnvironment()
            },
        )
    }

    fun openPrivacyPolicy() {
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(PRIVACY_POLICY_URL)))
    }

    fun dismissKeyboard() {
        focusManager.clearFocus()
        keyboardController?.hide()
    }

    fun requestPrivacy(action: LoginPrivacyPendingAction, proceed: () -> Unit) {
        if (hasAcceptedPrivacyPolicy) {
            proceed()
            return
        }
        pendingPrivacyAction = action
        showPrivacyConsentDialog = true
    }

    if (showPrivacyConsentDialog) {
        AlertDialog(
            onDismissRequest = {
                showPrivacyConsentDialog = false
                pendingPrivacyAction = null
            },
            shape = RectangleShape,
            containerColor = LoginPaper,
            titleContentColor = LoginInk,
            textContentColor = LoginMutedInk,
            title = { Text(stringResource(R.string.auth_privacy_consent_title)) },
            text = { Text(stringResource(R.string.auth_privacy_consent_message)) },
            confirmButton = {
                Button(
                    onClick = {
                        hasAcceptedPrivacyPolicy = true
                        showPrivacyConsentDialog = false
                        when (pendingPrivacyAction) {
                            LoginPrivacyPendingAction.SendCode -> viewModel.sendCode()
                            LoginPrivacyPendingAction.Login -> viewModel.login(onLoginSuccess)
                            null -> Unit
                        }
                        pendingPrivacyAction = null
                    },
                    shape = RectangleShape,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = LoginBlue,
                        contentColor = Color.White,
                    ),
                ) {
                    Text(stringResource(R.string.auth_privacy_consent_agree))
                }
            },
            dismissButton = {
                TextButton(
                    onClick = {
                        showPrivacyConsentDialog = false
                        pendingPrivacyAction = null
                    },
                    colors = ButtonDefaults.textButtonColors(contentColor = LoginInk),
                ) {
                    Text(stringResource(R.string.auth_privacy_consent_disagree))
                }
            },
        )
    }

    Scaffold(
        containerColor = LoginPaper,
    ) { padding ->
        BoxWithConstraints(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .background(LoginPaper),
        ) {
            val isTablet = maxWidth >= TABLET_MIN_WIDTH_DP.dp
            val landscapeAuthWidth = maxWidth * (1f - TABLET_LANDSCAPE_STAGE_WEIGHT)
            val usesLandscapeSplit = isTablet &&
                maxWidth > maxHeight &&
                landscapeAuthWidth >= LANDSCAPE_AUTH_MIN_WIDTH_DP.dp
            val horizontalHeaderPadding = if (isTablet) 32.dp else 20.dp
            val language = debugViewModel.currentLanguage
            val imeVisible = WindowInsets.isImeVisible

            Column(modifier = Modifier.fillMaxSize()) {
                LoginTopBar(
                    horizontalPadding = horizontalHeaderPadding,
                    language = language,
                    onDebugEnvironmentClick = {
                        dismissKeyboard()
                        viewModel.openDebugEnvironment()
                    },
                    onLanguageToggle = {
                        debugViewModel.setLanguage(
                            if (language.isEnglishForLogin()) AppLanguage.ZH_CN else AppLanguage.EN,
                        )
                    },
                )

                BoxWithConstraints(
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f),
                ) {
                    val visibleAuthHeight = minOf(LoginAuthHeight, maxHeight)

                    val stageModifier = when {
                        imeVisible -> Modifier
                            .fillMaxSize()
                            .align(Alignment.TopCenter)
                        usesLandscapeSplit -> Modifier
                            .fillMaxHeight()
                            .fillMaxWidth(TABLET_LANDSCAPE_STAGE_WEIGHT)
                            .align(Alignment.CenterStart)
                        else -> Modifier
                            .fillMaxWidth()
                            .height((maxHeight - visibleAuthHeight).coerceAtLeast(0.dp))
                            .align(Alignment.TopCenter)
                    }
                    LoginStage(
                        language = language,
                        isActive = !imeVisible,
                        dividerOnEnd = usesLandscapeSplit,
                        modifier = stageModifier.alpha(if (imeVisible) 0f else 1f),
                    )

                    val panelModifier = when {
                        imeVisible -> Modifier.fillMaxSize()
                        usesLandscapeSplit -> Modifier
                            .fillMaxHeight()
                            .fillMaxWidth(1f - TABLET_LANDSCAPE_STAGE_WEIGHT)
                            .align(Alignment.CenterEnd)
                        isTablet -> Modifier
                            .widthIn(max = LoginTabletFormMaxWidth)
                            .fillMaxWidth()
                            .height(visibleAuthHeight)
                            .align(Alignment.BottomCenter)
                        else -> Modifier
                            .fillMaxWidth()
                            .height(visibleAuthHeight)
                            .align(Alignment.BottomCenter)
                    }

                    // 表单与舞台都始终从同一组合位置发出；IME 只隐藏并暂停舞台，
                    // WebView 时间轴、TextField 焦点与滚动位置都不会因此重建。
                    LoginAuthPanel(
                        modifier = panelModifier,
                        state = state,
                        language = language,
                        horizontalPadding = when {
                            imeVisible -> if (isTablet) 32.dp else 20.dp
                            usesLandscapeSplit -> 24.dp
                            isTablet -> 0.dp
                            else -> 20.dp
                        },
                        verticallyCentered = usesLandscapeSplit && !imeVisible,
                        hasAcceptedPrivacyPolicy = hasAcceptedPrivacyPolicy,
                        isPasswordVisible = isPasswordVisible,
                        onModeSelected = { codeMode ->
                            if (state.isCodeMode != codeMode) {
                                viewModel.toggleMode()
                                isPasswordVisible = false
                            }
                        },
                        onPhoneChange = viewModel::updatePhone,
                        onCodeChange = viewModel::updateCode,
                        onPasswordChange = viewModel::updatePassword,
                        onPasswordVisibilityToggle = { isPasswordVisible = !isPasswordVisible },
                        onSendCode = {
                            requestPrivacy(LoginPrivacyPendingAction.SendCode) {
                                viewModel.sendCode()
                            }
                        },
                        onLogin = {
                            requestPrivacy(LoginPrivacyPendingAction.Login) {
                                viewModel.login(onLoginSuccess)
                            }
                        },
                        onPrivacyPolicyAcceptedChange = { hasAcceptedPrivacyPolicy = it },
                        onOpenPrivacyPolicy = ::openPrivacyPolicy,
                        onDismissKeyboard = ::dismissKeyboard,
                    )
                }
            }

            state.error?.let { message ->
                LoginErrorHint(
                    message = message,
                    modifier = Modifier
                        .align(Alignment.TopCenter)
                        .padding(
                            top = LoginHeaderHeight + 8.dp,
                            start = horizontalHeaderPadding,
                            end = horizontalHeaderPadding,
                        ),
                )
            }
        }
    }
}

private fun Modifier.drawBottomRule(color: Color, width: Dp): Modifier = drawBehind {
    val strokeWidth = width.toPx()
    drawLine(
        color = color,
        start = Offset(0f, size.height - strokeWidth / 2f),
        end = Offset(size.width, size.height - strokeWidth / 2f),
        strokeWidth = strokeWidth,
    )
}

private fun Modifier.drawStartRule(color: Color, width: Dp): Modifier = drawBehind {
    val strokeWidth = width.toPx()
    drawLine(
        color = color,
        start = Offset(strokeWidth / 2f, 0f),
        end = Offset(strokeWidth / 2f, size.height),
        strokeWidth = strokeWidth,
    )
}

private fun Modifier.drawEndRule(color: Color, width: Dp): Modifier = drawBehind {
    val strokeWidth = width.toPx()
    drawLine(
        color = color,
        start = Offset(size.width - strokeWidth / 2f, 0f),
        end = Offset(size.width - strokeWidth / 2f, size.height),
        strokeWidth = strokeWidth,
    )
}

/** SYSTEM 跟随系统语言；产品只提供中英文，因此非中文系统回落英文。 */
private fun AppLanguage.isEnglishForLogin(): Boolean = when (this) {
    AppLanguage.EN -> true
    AppLanguage.ZH_CN -> false
    AppLanguage.SYSTEM -> !Locale.getDefault()
        .language
        .lowercase(Locale.ROOT)
        .startsWith("zh")
}
