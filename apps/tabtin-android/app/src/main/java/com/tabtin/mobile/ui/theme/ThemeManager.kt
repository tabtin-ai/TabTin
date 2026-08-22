package com.tabtin.mobile.ui.theme

import android.app.UiModeManager
import android.content.Context
import android.os.Build
import androidx.annotation.StringRes
import androidx.appcompat.app.AppCompatDelegate
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.tabtin.mobile.R
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.runBlocking
import javax.inject.Inject
import javax.inject.Singleton

public enum class ThemeMode(@StringRes public val labelRes: Int) {
    SYSTEM(R.string.profile_theme_system),
    LIGHT(R.string.profile_theme_light),
    DARK(R.string.profile_theme_dark),
}

private val Context.themeDataStore: DataStore<Preferences> by preferencesDataStore(name = "tt_theme")

@Singleton
public class ThemeManager @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    private val themeModeKey = stringPreferencesKey("theme_mode")
    private val colorSchemeKey = stringPreferencesKey("color_scheme")

    // 同步预读取，确保首帧就使用正确的主题，避免 Splash → 错误主题 → 正确主题 的闪烁。
    // DataStore Preferences 是纯本地文件 IO，首次读取通常 < 5ms，runBlocking 在此安全。
    public val initialThemeMode: ThemeMode = runBlocking {
        context.themeDataStore.data.first().let { prefs ->
            prefs[themeModeKey]?.let { raw ->
                try { ThemeMode.valueOf(raw) } catch (_: Exception) { ThemeMode.SYSTEM }
            } ?: ThemeMode.SYSTEM
        }
    }

    public val initialColorSchemeId: TTColorSchemeId = runBlocking {
        context.themeDataStore.data.first().let { prefs ->
            TTColorSchemeId.resolve(prefs[colorSchemeKey])
        }
    }

    public val themeMode: Flow<ThemeMode> = context.themeDataStore.data.map { prefs ->
        prefs[themeModeKey]?.let { raw ->
            try { ThemeMode.valueOf(raw) } catch (_: Exception) { ThemeMode.SYSTEM }
        } ?: ThemeMode.SYSTEM
    }

    public val colorSchemeId: Flow<TTColorSchemeId> = context.themeDataStore.data.map { prefs ->
        TTColorSchemeId.resolve(prefs[colorSchemeKey])
    }

    public suspend fun setThemeMode(mode: ThemeMode) {
        context.themeDataStore.edit { prefs ->
            prefs[themeModeKey] = mode.name
        }
        applyPlatformNightMode(mode)
    }

    /**
     * 把 TabTin 内的主题选择同步给系统启动窗口。
     *
     * Android 12+ 的 SplashScreen 在应用内容创建前由系统绘制；只改变 Compose 主题会让
     * 系统首帧与后续开屏动画使用不同的明暗资源。平台会持久化这个应用级设置，因此
     * 下一次冷启动就能直接选中匹配的 `values-night` 资源。
     */
    public fun syncPlatformNightMode() {
        applyPlatformNightMode(initialThemeMode)
    }

    private fun applyPlatformNightMode(mode: ThemeMode) {
        val appCompatMode = when (mode) {
            ThemeMode.SYSTEM -> AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM
            ThemeMode.LIGHT -> AppCompatDelegate.MODE_NIGHT_NO
            ThemeMode.DARK -> AppCompatDelegate.MODE_NIGHT_YES
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val uiModeManager = context.getSystemService(UiModeManager::class.java)
            val platformMode = when (mode) {
                ThemeMode.SYSTEM -> uiModeManager.nightMode
                ThemeMode.LIGHT -> UiModeManager.MODE_NIGHT_NO
                ThemeMode.DARK -> UiModeManager.MODE_NIGHT_YES
            }
            uiModeManager.setApplicationNightMode(platformMode)
        } else {
            AppCompatDelegate.setDefaultNightMode(appCompatMode)
        }
    }

    public suspend fun setColorSchemeId(schemeId: TTColorSchemeId) {
        context.themeDataStore.edit { prefs ->
            prefs[colorSchemeKey] = schemeId.rawValue
        }
    }
}

@dagger.hilt.EntryPoint
@dagger.hilt.InstallIn(dagger.hilt.components.SingletonComponent::class)
public interface ThemeManagerEntryPoint {
    public fun themeManager(): ThemeManager
}
