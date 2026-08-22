package com.tabtin.mobile.features.profile

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Help
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.Security
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.BuildConfig
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import java.util.Calendar

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun AboutScreen(onBack: () -> Unit) {
    val context = LocalContext.current

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.profile_about)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.common_back),
                        )
                    }
                },
            )
        },
    ) { innerPadding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(TTSpacing.lg),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.lg),
        ) {
            item {
                Surface(
                    color = MaterialTheme.colorScheme.surface,
                    shape = TTRadius.Shapes.md,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = TTSpacing.xxl, horizontal = TTSpacing.lg),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
                    ) {
                        Icon(
                            imageVector = Icons.Default.AutoAwesome,
                            contentDescription = null,
                            modifier = Modifier.size(48.dp),
                            tint = MaterialTheme.colorScheme.primary,
                        )
                        Column(
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(TTSpacing.xs),
                        ) {
                            Text(
                                text = "TabTin",
                                style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.SemiBold),
                                color = MaterialTheme.colorScheme.onSurface,
                            )
                            Text(
                                text = stringResource(
                                    R.string.profile_about_version_build,
                                    BuildConfig.VERSION_NAME,
                                    BuildConfig.VERSION_CODE,
                                ),
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }

            item {
                SettingsHomeSection(title = stringResource(R.string.settings_section_about_support)) {
                    AboutExternalLinkRow(
                        icon = Icons.Default.Language,
                        title = stringResource(R.string.about_website),
                        url = "https://www.example.com",
                        onOpen = { openAboutLink(context, it) },
                    )
                    SettingsHomeDivider()
                    AboutExternalLinkRow(
                        icon = Icons.AutoMirrored.Filled.Help,
                        title = stringResource(R.string.about_help),
                        url = "https://www.example.com/help/",
                        onOpen = { openAboutLink(context, it) },
                    )
                }
            }

            item {
                SettingsHomeSection(title = stringResource(R.string.settings_privacy_actions)) {
                    AboutExternalLinkRow(
                        icon = Icons.Default.Security,
                        title = stringResource(R.string.about_privacy_policy),
                        url = "https://assets.example.com/tabtin-agreement/TabTin%E6%A1%8C%E9%9D%A2%E7%AB%AF%E9%9A%90%E7%A7%81%E6%94%BF%E7%AD%96-V1.0%E4%B8%AD%E8%8B%B1%E5%8F%8C%E8%AF%AD%E7%89%88.pdf",
                        onOpen = { openAboutLink(context, it) },
                    )
                    SettingsHomeDivider()
                    AboutExternalLinkRow(
                        icon = Icons.Default.Description,
                        title = stringResource(R.string.about_terms_of_service),
                        url = "https://assets.example.com/tabtin-agreement/TabTin%E6%A1%8C%E9%9D%A2%E7%AB%AF%E7%94%A8%E6%88%B7%E5%8D%8F%E8%AE%AE-V1.0%E4%B8%AD%E8%8B%B1%E5%8F%8C%E8%AF%AD%E7%89%88.pdf",
                        onOpen = { openAboutLink(context, it) },
                    )
                }
            }

            item {
                Text(
                    text = stringResource(
                        R.string.about_copyright,
                        Calendar.getInstance().get(Calendar.YEAR),
                    ),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = TTSpacing.sm),
                )
            }
        }
    }
}

@Composable
private fun AboutExternalLinkRow(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    title: String,
    url: String,
    onOpen: (String) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clickable { onOpen(url) }
            .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(32.dp)
                .background(SettingsHomeIconTone.Neutral.backgroundColor(), shape = TTRadius.Shapes.sm),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = SettingsHomeIconTone.Neutral.foregroundColor(),
                modifier = Modifier.size(18.dp),
            )
        }

        Spacer(Modifier.width(TTSpacing.md))

        Text(
            text = title,
            style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold),
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )

        Spacer(Modifier.width(TTSpacing.sm))

        Icon(
            imageVector = Icons.AutoMirrored.Filled.OpenInNew,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(18.dp),
        )
    }
}

private fun openAboutLink(context: android.content.Context, url: String) {
    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
}
