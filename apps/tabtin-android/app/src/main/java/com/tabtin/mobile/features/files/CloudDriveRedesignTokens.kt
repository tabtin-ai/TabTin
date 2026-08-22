package com.tabtin.mobile.features.files

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import com.tabtin.mobile.ui.theme.LocalTTDarkTheme

internal data class CloudDriveRedesignPalette(
    val canvas: Color,
    val surface: Color,
    val surfaceSoft: Color,
    val surfacePressed: Color,
    val line: Color,
    val lineStrong: Color,
    val accent: Color,
    val accentSoft: Color,
    val textPrimary: Color,
    val textSecondary: Color,
    val textTertiary: Color,
)

@Composable
internal fun cloudDriveRedesignPalette(): CloudDriveRedesignPalette =
    if (LocalTTDarkTheme.current) {
        CloudDriveRedesignPalette(
            canvas = Color(0xFF131416),
            surface = Color(0xFF201F1D),
            surfaceSoft = Color(0xFF222427),
            surfacePressed = Color(0xFF2A2C2F),
            line = Color(0xFF303236),
            lineStrong = Color(0xFF45484D),
            accent = Color(0xFF63B8F4),
            accentSoft = Color(0x2463B8F4),
            textPrimary = Color(0xFFE3E5E8),
            textSecondary = Color(0xFF94989E),
            textTertiary = Color(0xFF686D73),
        )
    } else {
        CloudDriveRedesignPalette(
            canvas = Color(0xFFF6F7F8),
            surface = Color(0xFFFDFDFC),
            surfaceSoft = Color(0xFFF1F2F4),
            surfacePressed = Color(0xFFEBEEF1),
            line = Color(0xFFE1E3E5),
            lineStrong = Color(0xFFCFD3D7),
            accent = Color(0xFF168FEA),
            accentSoft = Color(0x1B168FEA),
            textPrimary = Color(0xFF22262A),
            textSecondary = Color(0xFF6B6F76),
            textTertiary = Color(0xFF9A9EA6),
        )
    }

internal data class CloudDriveCategoryColors(
    val foreground: Color,
    val background: Color,
)

@Composable
internal fun cloudDriveCategoryColors(category: CloudDriveFileCategory): CloudDriveCategoryColors {
    val dark = LocalTTDarkTheme.current
    val foreground = when (category) {
        CloudDriveFileCategory.CLOUD_DOCUMENT,
        CloudDriveFileCategory.DOCUMENT,
        -> if (dark) Color(0xFF79A8FF) else Color(0xFF3577F0)
        CloudDriveFileCategory.CLOUD_TABLE,
        CloudDriveFileCategory.SPREADSHEET,
        -> if (dark) Color(0xFF6BC491) else Color(0xFF2F9461)
        CloudDriveFileCategory.IMAGE -> if (dark) Color(0xFFC393EF) else Color(0xFF9A63DC)
        CloudDriveFileCategory.PDF -> if (dark) Color(0xFFED7F79) else Color(0xFFD65751)
        CloudDriveFileCategory.PRESENTATION -> if (dark) Color(0xFFF1B65E) else Color(0xFFD4870A)
        CloudDriveFileCategory.AUDIO -> if (dark) Color(0xFFC393EF) else Color(0xFF8255C4)
        CloudDriveFileCategory.VIDEO -> if (dark) Color(0xFF63B8F4) else Color(0xFF168FEA)
        CloudDriveFileCategory.ARCHIVE -> if (dark) Color(0xFFDDA548) else Color(0xFFB87515)
        CloudDriveFileCategory.TEXT,
        CloudDriveFileCategory.GENERIC,
        -> if (dark) Color(0xFFAEB4BD) else Color(0xFF606876)
    }
    return CloudDriveCategoryColors(
        foreground = foreground,
        background = foreground.copy(alpha = if (dark) 0.15f else 0.11f),
    )
}
