package com.tabtin.mobile.data.adb

import android.content.Context
import android.os.Build
import com.tabtin.mobile.R
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
public class OemDetector @Inject constructor(
    @ApplicationContext private val context: Context,
) {

    public enum class Brand { XIAOMI, OPPO, VIVO, HUAWEI, HONOR, SAMSUNG, ONEPLUS, REALME, MOTOROLA, OTHER }

    public val brand: Brand by lazy {
        when (Build.MANUFACTURER.lowercase()) {
            "xiaomi", "redmi", "poco" -> Brand.XIAOMI
            "oppo" -> Brand.OPPO
            "vivo", "iqoo" -> Brand.VIVO
            "huawei" -> Brand.HUAWEI
            "honor" -> Brand.HONOR
            "samsung" -> Brand.SAMSUNG
            "oneplus" -> Brand.ONEPLUS
            "realme" -> Brand.REALME
            "motorola" -> Brand.MOTOROLA
            else -> Brand.OTHER
        }
    }

    public val isHarmonyOsNext: Boolean by lazy {
        try {
            val clazz = Class.forName("com.huawei.system.BuildEx")
            val osBrand = clazz.getMethod("getOsBrand").invoke(null) as? String
            osBrand?.lowercase() == "harmonyos" && Build.VERSION.SDK_INT >= 35
        } catch (_: Exception) {
            false
        }
    }

    public val supportsWirelessDebugging: Boolean
        get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && !isHarmonyOsNext

    public val xiaomiDeveloperWaitDays: Int?
        get() = if (brand == Brand.XIAOMI) 7 else null

    public val requiresSpecialBackgroundSettings: Boolean
        get() = brand in setOf(Brand.XIAOMI, Brand.OPPO, Brand.VIVO, Brand.HUAWEI)

    public data class SetupGuide(
        val title: String,
        val steps: List<String>,
        val warnings: List<String> = emptyList(),
    )

    private fun s(resId: Int): String = context.getString(resId)

    private val cachedGuide: SetupGuide by lazy { buildSetupGuide() }

    public fun getSetupGuide(): SetupGuide = cachedGuide

    private fun buildSetupGuide(): SetupGuide = when (brand) {
        Brand.XIAOMI -> SetupGuide(
            title = s(R.string.oem_guide_title_xiaomi),
            steps = listOf(
                s(R.string.oem_guide_xiaomi_step1),
                s(R.string.oem_guide_xiaomi_step2),
                s(R.string.oem_guide_xiaomi_step3),
            ),
            warnings = listOf(
                s(R.string.oem_guide_xiaomi_warning1),
                s(R.string.oem_guide_xiaomi_warning2),
            ),
        )
        Brand.OPPO -> SetupGuide(
            title = s(R.string.oem_guide_title_oppo),
            steps = listOf(
                s(R.string.oem_guide_oppo_step1),
                s(R.string.oem_guide_oppo_step2),
                s(R.string.oem_guide_oppo_step3),
            ),
            warnings = listOf(s(R.string.oem_guide_oppo_warning1)),
        )
        Brand.VIVO -> SetupGuide(
            title = s(R.string.oem_guide_title_vivo),
            steps = listOf(
                s(R.string.oem_guide_vivo_step1),
                s(R.string.oem_guide_vivo_step2),
                s(R.string.oem_guide_vivo_step3),
            ),
            warnings = listOf(s(R.string.oem_guide_vivo_warning1)),
        )
        Brand.HUAWEI -> SetupGuide(
            title = s(R.string.oem_guide_title_huawei),
            steps = listOf(
                s(R.string.oem_guide_huawei_step1),
                s(R.string.oem_guide_huawei_step2),
                s(R.string.oem_guide_huawei_step3),
            ),
            warnings = listOf(
                s(R.string.oem_guide_huawei_warning1),
                s(R.string.oem_guide_huawei_warning2),
            ),
        )
        Brand.HONOR -> SetupGuide(
            title = s(R.string.oem_guide_title_honor),
            steps = listOf(
                s(R.string.oem_guide_honor_step1),
                s(R.string.oem_guide_honor_step2),
                s(R.string.oem_guide_honor_step3),
            ),
            warnings = listOf(s(R.string.oem_guide_honor_warning1)),
        )
        Brand.SAMSUNG -> SetupGuide(
            title = s(R.string.oem_guide_title_samsung),
            steps = listOf(
                s(R.string.oem_guide_samsung_step1),
                s(R.string.oem_guide_samsung_step2),
                s(R.string.oem_guide_samsung_step3),
            ),
            warnings = listOf(
                s(R.string.oem_guide_samsung_warning1),
                s(R.string.oem_guide_samsung_warning2),
            ),
        )
        Brand.ONEPLUS -> SetupGuide(
            title = s(R.string.oem_guide_title_oneplus),
            steps = listOf(
                s(R.string.oem_guide_oneplus_step1),
                s(R.string.oem_guide_oneplus_step2),
                s(R.string.oem_guide_oneplus_step3),
            ),
            warnings = listOf(s(R.string.oem_guide_oneplus_warning1)),
        )
        Brand.REALME -> SetupGuide(
            title = s(R.string.oem_guide_title_realme),
            steps = listOf(
                s(R.string.oem_guide_realme_step1),
                s(R.string.oem_guide_realme_step2),
                s(R.string.oem_guide_realme_step3),
            ),
            warnings = listOf(s(R.string.oem_guide_realme_warning1)),
        )
        Brand.MOTOROLA -> SetupGuide(
            title = s(R.string.oem_guide_title_motorola),
            steps = listOf(
                s(R.string.oem_guide_generic_step1),
                s(R.string.oem_guide_generic_step2),
                s(R.string.oem_guide_generic_step3),
            ),
        )
        else -> SetupGuide(
            title = s(R.string.oem_guide_title_generic),
            steps = listOf(
                s(R.string.oem_guide_generic_step1),
                s(R.string.oem_guide_generic_step2),
                s(R.string.oem_guide_generic_step3),
            ),
        )
    }
}
