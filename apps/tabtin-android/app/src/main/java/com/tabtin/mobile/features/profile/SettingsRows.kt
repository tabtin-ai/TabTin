package com.tabtin.mobile.features.profile

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

@Composable
internal fun SettingsHomeSection(
    title: String,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
        Text(
            text = title,
            style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = TTSpacing.xs),
        )
        Surface(
            color = MaterialTheme.colorScheme.surface,
            shape = TTRadius.Shapes.md,
            tonalElevation = 0.dp,
            shadowElevation = 0.dp,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(content = content)
        }
    }
}

@Composable
internal fun SettingsHomeRow(
    icon: ImageVector,
    title: String,
    subtitle: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    trailing: String? = null,
    trailingStyle: SettingsHomeTrailingStyle = SettingsHomeTrailingStyle.Text,
    trailingTone: SettingsHomeIconTone = SettingsHomeIconTone.Neutral,
    tone: SettingsHomeIconTone = SettingsHomeIconTone.Accent,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .heightIn(min = 56.dp)
            .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(32.dp)
                .background(tone.backgroundColor(), shape = TTRadius.Shapes.sm),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = tone.foregroundColor(),
                modifier = Modifier.size(18.dp),
            )
        }

        Spacer(Modifier.width(TTSpacing.md))

        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = title,
                style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold),
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(TTSpacing.xxs))
            Text(
                text = subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }

        Spacer(Modifier.width(TTSpacing.sm))

        trailing?.takeIf { it.isNotBlank() }?.let {
            SettingsHomeTrailingView(
                value = it,
                style = trailingStyle,
                tone = trailingTone,
            )
        }

        Icon(
            Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(20.dp),
        )
    }
}

@Composable
internal fun SettingsHomeDivider() {
    HorizontalDivider(
        modifier = Modifier.padding(start = TTSpacing.md + 32.dp + TTSpacing.md),
        color = ttColor(TTColors.Border, TTColors.Dark.Border),
    )
}

@Composable
internal fun SettingsReadOnlyRow(
    icon: ImageVector,
    title: String,
    value: String,
    valueFontFamily: FontFamily? = null,
    iconTone: SettingsHomeIconTone = SettingsHomeIconTone.Neutral,
    valueAsBadge: Boolean = false,
    valueTone: SettingsHomeIconTone = SettingsHomeIconTone.Accent,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = TTSpacing.md, vertical = TTSpacing.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(32.dp)
                .background(iconTone.backgroundColor(), shape = TTRadius.Shapes.sm),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = iconTone.foregroundColor(),
                modifier = Modifier.size(18.dp),
            )
        }
        Spacer(Modifier.width(TTSpacing.md))
        Text(
            title,
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.weight(1f),
        )
        if (valueAsBadge) {
            Text(
                value,
                style = MaterialTheme.typography.labelSmall.copy(
                    fontWeight = FontWeight.SemiBold,
                    fontFamily = valueFontFamily,
                ),
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .widthIn(max = 112.dp)
                    .background(valueTone.backgroundColor(), shape = TTRadius.Shapes.full)
                    .padding(horizontal = 8.dp, vertical = 4.dp),
            )
        } else {
            Text(
                value,
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = valueFontFamily),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.widthIn(max = 148.dp),
            )
        }
    }
}

@Composable
internal fun LogoutSettingsButton(onClick: () -> Unit) {
    val criticalColor = ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical)
    Surface(
        color = criticalColor.copy(alpha = 0.06f),
        shape = TTRadius.Shapes.md,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
    ) {
        Text(
            text = androidx.compose.ui.res.stringResource(com.tabtin.mobile.R.string.profile_logout),
            style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold),
            color = criticalColor,
            modifier = Modifier.padding(vertical = TTSpacing.lg),
            textAlign = TextAlign.Center,
        )
    }
}

internal enum class SettingsHomeIconTone {
    Accent,
    Neutral,
    Success,
    Warning,
    Critical,
}

@Composable
internal fun SettingsHomeIconTone.foregroundColor(): Color = when (this) {
    SettingsHomeIconTone.Accent -> ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent)
    SettingsHomeIconTone.Neutral -> MaterialTheme.colorScheme.onSurfaceVariant
    SettingsHomeIconTone.Success -> ttColor(TTColors.BgSuccess, TTColors.Dark.BgSuccess)
    SettingsHomeIconTone.Warning -> ttColor(TTColors.BgWarning, TTColors.Dark.BgWarning)
    SettingsHomeIconTone.Critical -> ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical)
}

@Composable
internal fun SettingsHomeIconTone.backgroundColor(): Color = when (this) {
    SettingsHomeIconTone.Accent -> ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent).copy(alpha = 0.11f)
    SettingsHomeIconTone.Neutral -> ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle)
    SettingsHomeIconTone.Success -> ttColor(TTColors.BgSuccess, TTColors.Dark.BgSuccess).copy(alpha = 0.11f)
    SettingsHomeIconTone.Warning -> ttColor(TTColors.BgWarning, TTColors.Dark.BgWarning).copy(alpha = 0.16f)
    SettingsHomeIconTone.Critical -> ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical).copy(alpha = 0.09f)
}

internal enum class SettingsHomeTrailingStyle {
    Text,
    Badge,
    ColorSwatch,
}

@Composable
private fun SettingsHomeTrailingView(
    value: String,
    style: SettingsHomeTrailingStyle,
    tone: SettingsHomeIconTone,
) {
    when (style) {
        SettingsHomeTrailingStyle.Text -> {
            Text(
                text = value,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.widthIn(max = 104.dp),
            )
        }
        SettingsHomeTrailingStyle.Badge -> {
            Text(
                text = value,
                style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold),
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .widthIn(max = 104.dp)
                    .background(tone.backgroundColor(), shape = TTRadius.Shapes.full)
                    .padding(horizontal = 7.dp, vertical = 3.dp),
            )
        }
        SettingsHomeTrailingStyle.ColorSwatch -> {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.widthIn(max = 120.dp),
            ) {
                Box(
                    modifier = Modifier
                        .size(12.dp)
                        .background(tone.foregroundColor(), shape = CircleShape)
                        .border(1.dp, MaterialTheme.colorScheme.surface.copy(alpha = 0.72f), CircleShape),
                )
                Spacer(Modifier.width(TTSpacing.xs))
                Text(
                    text = value,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}
