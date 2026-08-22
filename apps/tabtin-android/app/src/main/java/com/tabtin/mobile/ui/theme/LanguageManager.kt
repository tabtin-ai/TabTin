package com.tabtin.mobile.ui.theme

import android.content.Context
import androidx.annotation.StringRes
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.os.LocaleListCompat
import com.tabtin.mobile.R
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

public enum class AppLanguage(
    public val tag: String?,
    @StringRes public val labelRes: Int,
) {
    SYSTEM(null, R.string.profile_language_system),
    ZH_CN("zh-CN", R.string.profile_language_zh),
    EN("en", R.string.profile_language_en),
    ;

    public companion object {
        public fun fromLocales(locales: LocaleListCompat): AppLanguage {
            if (locales.isEmpty) return SYSTEM
            val tag = locales[0]?.toLanguageTag() ?: return SYSTEM
            return entries.find { it.tag != null && tag.startsWith(it.tag.substringBefore("-")) } ?: SYSTEM
        }
    }
}

@Singleton
public class LanguageManager @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    public val currentLanguage: AppLanguage
        get() = AppLanguage.fromLocales(AppCompatDelegate.getApplicationLocales())

    public fun setLanguage(language: AppLanguage) {
        val locales = if (language.tag != null) {
            LocaleListCompat.forLanguageTags(language.tag)
        } else {
            LocaleListCompat.getEmptyLocaleList()
        }
        AppCompatDelegate.setApplicationLocales(locales)
    }
}
