package com.tabtin.mobile.features.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccessTime
import androidx.compose.material.icons.outlined.AccountBalanceWallet
import androidx.compose.material.icons.outlined.DoNotDisturb
import androidx.compose.material.icons.outlined.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

private val cardShape = RoundedCornerShape(12.dp)

private data class BillingErrorConfig(
    val icon: ImageVector,
    val bgLight: Color,
    val bgDark: Color,
    val borderLight: Color,
    val borderDark: Color,
    val ctaLabelRes: Int,
)

private fun resolveConfig(errorCategory: String): BillingErrorConfig = when (errorCategory) {
    "insufficient_credits", "organization_insufficient_credits" -> BillingErrorConfig(
        icon = Icons.Outlined.AccountBalanceWallet,
        bgLight = Color(0xFFFEF2F2),
        bgDark = Color(0xFF3A2020),
        borderLight = Color(0xFFFECACA),
        borderDark = Color(0xFF5C3030),
        ctaLabelRes = if (errorCategory == "organization_insufficient_credits")
            R.string.chat_billing_go_team_recharge
        else
            R.string.chat_billing_go_recharge,
    )
    "budget_exceeded" -> BillingErrorConfig(
        icon = Icons.Outlined.Warning,
        bgLight = Color(0xFFFFFBEB),
        bgDark = Color(0xFF3A3420),
        borderLight = Color(0xFFFDE68A),
        borderDark = Color(0xFF5C5030),
        ctaLabelRes = R.string.chat_billing_adjust_budget,
    )
    "rate_limited" -> BillingErrorConfig(
        icon = Icons.Outlined.AccessTime,
        bgLight = Color(0xFFFFFBEB),
        bgDark = Color(0xFF3A3420),
        borderLight = Color(0xFFFDE68A),
        borderDark = Color(0xFF5C5030),
        ctaLabelRes = R.string.chat_billing_retry_later,
    )
    "conversation_quota_exceeded" -> BillingErrorConfig(
        icon = Icons.Outlined.DoNotDisturb,
        bgLight = Color(0xFFFEF2F2),
        bgDark = Color(0xFF3A2020),
        borderLight = Color(0xFFFECACA),
        borderDark = Color(0xFF5C3030),
        ctaLabelRes = R.string.chat_billing_view_quota,
    )
    "member_monthly_limit", "member_daily_limit", "member_model_restricted", "member_budget" -> BillingErrorConfig(
        icon = Icons.Outlined.DoNotDisturb,
        bgLight = Color(0xFFFFFBEB),
        bgDark = Color(0xFF3A3420),
        borderLight = Color(0xFFFDE68A),
        borderDark = Color(0xFF5C5030),
        ctaLabelRes = R.string.chat_billing_contact_admin,
    )
    else -> BillingErrorConfig(
        icon = Icons.Outlined.Warning,
        bgLight = Color(0xFFFEF2F2),
        bgDark = Color(0xFF3A2020),
        borderLight = Color(0xFFFECACA),
        borderDark = Color(0xFF5C3030),
        ctaLabelRes = R.string.chat_billing_go_recharge,
    )
}

@Composable
internal fun BillingErrorCard(
    errorCategory: String,
    message: String,
    onNavigateToWallet: () -> Unit,
) {
    val config = resolveConfig(errorCategory)
    val bg = ttColor(config.bgLight, config.bgDark)
    val borderColor = ttColor(config.borderLight, config.borderDark)
    val iconTint = ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical)

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, borderColor, cardShape)
            .background(bg, cardShape)
            .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm + 2.dp),
    ) {
        Row(
            verticalAlignment = Alignment.Top,
        ) {
            Icon(
                imageVector = config.icon,
                contentDescription = null,
                modifier = Modifier.size(18.dp),
                tint = iconTint,
            )
            Spacer(Modifier.width(TTSpacing.sm))
            Text(
                text = message,
                style = TTFonts.body,
                color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
            )
        }

        Spacer(Modifier.height(TTSpacing.sm))

        Row(horizontalArrangement = Arrangement.Start) {
            Button(
                onClick = onNavigateToWallet,
                shape = RoundedCornerShape(8.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = ttColor(TTColors.Primary, TTColors.Dark.Primary),
                    contentColor = ttColor(TTColors.TextOnPrimary, TTColors.Dark.TextOnPrimary),
                ),
                contentPadding = ButtonDefaults.ContentPadding,
            ) {
                Text(
                    text = stringResource(config.ctaLabelRes),
                    style = TTFonts.caption,
                )
            }
        }
    }
}
