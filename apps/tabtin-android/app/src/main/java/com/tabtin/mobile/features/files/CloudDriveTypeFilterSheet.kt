package com.tabtin.mobile.features.files

import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Icon
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.files.CloudDriveTypeFilter
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.rememberTTSheetState
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun CloudDriveTypeFilterSheet(
    selected: CloudDriveTypeFilter,
    onSelect: (CloudDriveTypeFilter) -> Unit,
    onDismiss: () -> Unit,
) {
    val palette = cloudDriveRedesignPalette()
    TTBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberTTSheetState(),
        containerColor = palette.surface,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = TTSpacing.lg)
                .padding(bottom = TTSpacing.xxl),
        ) {
            Text(
                text = stringResource(R.string.cloud_drive_redesign_type_filter_title),
                style = TTFonts.subtitleSemibold,
                color = palette.textPrimary,
                modifier = Modifier.padding(bottom = TTSpacing.sm),
            )
            CloudDriveTypeFilter.entries.forEach { filter ->
                val label = when (filter) {
                    CloudDriveTypeFilter.ALL -> stringResource(R.string.cloud_drive_type_all)
                    CloudDriveTypeFilter.TABDOC -> stringResource(R.string.cloud_drive_type_doc)
                    CloudDriveTypeFilter.TABDATA -> stringResource(R.string.cloud_drive_type_table)
                    CloudDriveTypeFilter.TABFILES -> stringResource(R.string.cloud_drive_type_file)
                }
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .selectable(
                            selected = filter == selected,
                            role = Role.RadioButton,
                        ) {
                            onSelect(filter)
                            onDismiss()
                        }
                        .padding(vertical = TTSpacing.md),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(text = label, style = TTFonts.body, color = palette.textPrimary)
                    if (filter == selected) {
                        Icon(
                            imageVector = Icons.Filled.Check,
                            contentDescription = null,
                            tint = palette.accent,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                }
            }
        }
    }
}
