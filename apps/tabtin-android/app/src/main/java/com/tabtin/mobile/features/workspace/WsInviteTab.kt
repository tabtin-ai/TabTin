package com.tabtin.mobile.features.workspace

import android.content.ClipData
import android.util.Patterns
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SecondaryTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import kotlinx.coroutines.launch
import com.tabtin.mobile.data.model.OrganizationInvitation
import com.tabtin.mobile.data.model.OrganizationRole
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun InviteTab(
    invitations: List<OrganizationInvitation>,
    canManage: Boolean,
    isPersonal: Boolean,
    isMutating: Boolean,
    generatedLink: String?,
    onEmailInvite: (String, String) -> Unit,
    onPhoneInvite: (String) -> Unit,
    onLinkInvite: (String) -> Unit,
    onDirectInvite: (String, String) -> Unit,
    onCancelInvitation: (String) -> Unit,
    onClearLink: () -> Unit,
    onShowSnackbar: (String) -> Unit = {},
) {
    val effectiveCanManage = canManage && !isPersonal
    var selectedTab by remember { mutableIntStateOf(0) }
    val tabs = listOf(
        stringResource(R.string.ws_invite_phone),
        stringResource(R.string.ws_invite_link),
        stringResource(R.string.invite_by_user_id),
    )

    Column(modifier = Modifier.fillMaxSize()) {
        if (effectiveCanManage) {
            SecondaryTabRow(selectedTabIndex = selectedTab) {
                tabs.forEachIndexed { index, title ->
                    Tab(
                        selected = selectedTab == index,
                        onClick = { selectedTab = index },
                        text = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    )
                }
            }
        }

        Column(
            modifier = Modifier
                .fillMaxSize()
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(TTSpacing.xl),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.lg),
        ) {
            if (effectiveCanManage) {
                when (selectedTab) {
                    0 -> PhoneInviteSection(isMutating = isMutating, onPhoneInvite = onPhoneInvite)
                    1 -> LinkInviteSection(
                        isMutating = isMutating,
                        generatedLink = generatedLink,
                        onLinkInvite = onLinkInvite,
                        onShowSnackbar = onShowSnackbar,
                    )
                    2 -> UserIdInviteSection(isMutating = isMutating, onDirectInvite = onDirectInvite)
                }
            } else {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = TTSpacing.xxl),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = stringResource(R.string.ws_invite_no_permission),
                        style = TTFonts.body,
                        color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                    )
                }
            }

            Spacer(Modifier.height(TTSpacing.xl))

            if (invitations.isNotEmpty()) {
                Text(
                    text = stringResource(R.string.ws_invite_pending),
                    style = TTFonts.bodySemibold,
                )

                invitations.forEach { inv ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = TTSpacing.sm),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = when (inv.inviteType) {
                                    // Kotlin stable smart-cast（data class val 属性 + when 主语稳定调用，
                                    // Kotlin 1.x/2.x 均支持）：`inv.inviteType == "direct"` 让 `inv.inviteType`
                                    // 在此分支被 smart-cast 为 String 非空。第二段 `?: ""` 因左操作数已
                                    // 非空成为死代码（编译器 Elvis-redundant warning 字面证明）。
                                    "direct" -> inv.invitedUserId ?: inv.inviteType
                                    "email" -> inv.email ?: ""
                                    else -> stringResource(R.string.ws_invite_type_link)
                                },
                                style = TTFonts.body,
                            )
                            val roleLabel = localizedRoleName(inv.role ?: "editor")
                            val statusLabel = localizedInviteStatus(inv.status)
                            Text(
                                text = "$roleLabel · $statusLabel",
                                style = TTFonts.caption,
                                color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                            )
                        }
                        if (effectiveCanManage) {
                            IconButton(onClick = { onCancelInvitation(inv.id) }) {
                                Icon(
                                    Icons.Default.Close,
                                    contentDescription = stringResource(R.string.ws_invite_cancel),
                                    modifier = Modifier.size(18.dp),
                                    tint = ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical),
                                )
                            }
                        }
                    }
                    HorizontalDivider(color = ttColor(TTColors.Divider, TTColors.Dark.Divider).copy(alpha = 0.3f))
                }
            }
        }
    }
}

@Composable
private fun PhoneInviteSection(
    isMutating: Boolean,
    onPhoneInvite: (String) -> Unit,
) {
    var phone by remember { mutableStateOf("") }
    val normalizedPhone = phone.trim()

    Text(
        text = stringResource(R.string.ws_invite_phone_hint),
        style = TTFonts.caption,
        color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
    )
    OutlinedTextField(
        value = phone,
        onValueChange = { phone = it },
        label = { Text(stringResource(R.string.ws_invite_phone)) },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
    )
    Text(
        text = stringResource(R.string.ws_invite_phone_role_hint),
        style = TTFonts.caption,
        color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
    )
    Button(
        onClick = { onPhoneInvite(normalizedPhone); phone = "" },
        enabled = normalizedPhone.isNotEmpty() && !isMutating,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(stringResource(R.string.ws_invite_phone_send))
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun EmailInviteSection(
    isMutating: Boolean,
    onEmailInvite: (String, String) -> Unit,
) {
    var inviteEmail by remember { mutableStateOf("") }
    var inviteRole by remember { mutableStateOf(OrganizationRole.EDITOR) }
    var showRoleMenu by remember { mutableStateOf(false) }

    val assignableRoles = listOf(OrganizationRole.VIEWER, OrganizationRole.EDITOR, OrganizationRole.ADMIN)

    RoleSelector(
        selectedRole = inviteRole,
        assignableRoles = assignableRoles,
        showMenu = showRoleMenu,
        onExpandedChange = { showRoleMenu = it },
        onRoleSelected = { inviteRole = it; showRoleMenu = false },
    )

    Spacer(Modifier.height(TTSpacing.sm))

    OutlinedTextField(
        value = inviteEmail,
        onValueChange = { inviteEmail = it },
        label = { Text(stringResource(R.string.ws_invite_email_hint)) },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
    )

    Button(
        onClick = { onEmailInvite(inviteEmail, inviteRole.displayKey); inviteEmail = "" },
        enabled = Patterns.EMAIL_ADDRESS.matcher(inviteEmail).matches() && !isMutating,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(stringResource(R.string.ws_invite_send))
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun LinkInviteSection(
    isMutating: Boolean,
    generatedLink: String?,
    onLinkInvite: (String) -> Unit,
    onShowSnackbar: (String) -> Unit,
) {
    var inviteRole by remember { mutableStateOf(OrganizationRole.EDITOR) }
    var showRoleMenu by remember { mutableStateOf(false) }
    val clipboard = LocalClipboard.current
    val coroutineScope = rememberCoroutineScope()
    val context = LocalContext.current

    val assignableRoles = listOf(OrganizationRole.VIEWER, OrganizationRole.EDITOR, OrganizationRole.ADMIN)

    RoleSelector(
        selectedRole = inviteRole,
        assignableRoles = assignableRoles,
        showMenu = showRoleMenu,
        onExpandedChange = { showRoleMenu = it },
        onRoleSelected = { inviteRole = it; showRoleMenu = false },
    )

    Button(
        onClick = { onLinkInvite(inviteRole.displayKey) },
        enabled = !isMutating,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(stringResource(R.string.ws_invite_generate_link))
    }

    generatedLink?.let { link ->
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(ttColor(TTColors.SurfaceVariant, TTColors.Dark.SurfaceVariant), TTRadius.Shapes.sm)
                .padding(TTSpacing.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = link,
                style = TTFonts.caption,
                modifier = Modifier.weight(1f),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            IconButton(onClick = {
                // Compose 1.7+ Clipboard API 是 suspend：用 LocalClipboard + setClipEntry 替代旧
                // LocalClipboardManager.setText(AnnotatedString)。snackbar 仍同步触发——剪贴板写入
                // 极快（Android Clipboard 系统服务本地 IPC），用户感知零差异。
                coroutineScope.launch {
                    clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("invite_link", link)))
                }
                onShowSnackbar(context.getString(R.string.ws_invite_link_copied))
            }) {
                Icon(Icons.Default.ContentCopy, contentDescription = stringResource(R.string.ws_invite_link_copied), modifier = Modifier.size(18.dp))
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun UserIdInviteSection(
    isMutating: Boolean,
    onDirectInvite: (String, String) -> Unit,
) {
    var userId by remember { mutableStateOf("") }
    var inviteRole by remember { mutableStateOf(OrganizationRole.EDITOR) }
    var showRoleMenu by remember { mutableStateOf(false) }

    val assignableRoles = listOf(OrganizationRole.VIEWER, OrganizationRole.EDITOR, OrganizationRole.ADMIN)

    RoleSelector(
        selectedRole = inviteRole,
        assignableRoles = assignableRoles,
        showMenu = showRoleMenu,
        onExpandedChange = { showRoleMenu = it },
        onRoleSelected = { inviteRole = it; showRoleMenu = false },
    )

    Spacer(Modifier.height(TTSpacing.sm))

    OutlinedTextField(
        value = userId,
        onValueChange = { userId = it.trim() },
        label = { Text(stringResource(R.string.invite_by_user_id)) },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
        textStyle = TTFonts.body.copy(fontFamily = FontFamily.Monospace),
    )

    Text(
        text = stringResource(R.string.user_id_hint),
        style = TTFonts.caption,
        color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
    )

    Button(
        onClick = { onDirectInvite(userId, inviteRole.displayKey); userId = "" },
        enabled = userId.isNotBlank() && !isMutating,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(stringResource(R.string.send_invitation))
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RoleSelector(
    selectedRole: OrganizationRole,
    assignableRoles: List<OrganizationRole>,
    showMenu: Boolean,
    onExpandedChange: (Boolean) -> Unit,
    onRoleSelected: (OrganizationRole) -> Unit,
) {
    ExposedDropdownMenuBox(
        expanded = showMenu,
        onExpandedChange = onExpandedChange,
    ) {
        OutlinedTextField(
            value = roleDisplayString(selectedRole),
            onValueChange = {},
            label = { Text(stringResource(R.string.ws_invite_role)) },
            modifier = Modifier.menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable).fillMaxWidth(),
            readOnly = true,
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = showMenu) },
        )
        ExposedDropdownMenu(expanded = showMenu, onDismissRequest = { onExpandedChange(false) }) {
            assignableRoles.forEach { r ->
                DropdownMenuItem(
                    text = { Text(roleDisplayString(r)) },
                    onClick = { onRoleSelected(r) },
                )
            }
        }
    }
}
