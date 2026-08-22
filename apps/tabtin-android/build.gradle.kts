plugins {
    alias(libs.plugins.android.application) apply false
    // AGP 9.0+ ships built-in Kotlin support; org.jetbrains.kotlin.android is no longer required.
    // 见 https://developer.android.com/build/migrate-to-built-in-kotlin
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.hilt) apply false
    alias(libs.plugins.ksp) apply false
}
