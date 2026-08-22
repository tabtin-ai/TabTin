# Retrofit
-keepattributes Signature
-keepattributes *Annotation*
-keep class com.tabtin.mobile.data.model.** { *; }
-keepclassmembers class com.tabtin.mobile.data.model.** { *; }

# Kotlin Serialization
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class kotlinx.serialization.json.** { *** Companion; }
-keepclasseswithmembers class kotlinx.serialization.json.** { kotlinx.serialization.KSerializer serializer(...); }
-keepclassmembers class com.tabtin.mobile.data.model.** { *** Companion; }
-keepclasseswithmembers class com.tabtin.mobile.data.model.** { kotlinx.serialization.KSerializer serializer(...); }

# Privileged process (Server.kt runs via app_process with APK as classpath;
# R8 must preserve the main() entry point and all classes it references.
# The process runs outside Android runtime so standard framework keep
# rules do not apply — we must explicitly keep everything Server uses.)
-keep class com.tabtin.mobile.privileged.** { *; }
-keep class com.tabtin.mobile.data.privileged.FrameProtocol { *; }
-keep class com.tabtin.mobile.data.privileged.FrameProtocol$Frame { *; }

# kotlinx.serialization.json used by Server.kt for JSON parsing/building
-keep class kotlinx.serialization.json.Json { *; }
-keep class kotlinx.serialization.json.Json$Default { *; }
-keep class kotlinx.serialization.json.JsonElement { *; }
-keep class kotlinx.serialization.json.JsonObject { *; }
-keep class kotlinx.serialization.json.JsonPrimitive { *; }
-keep class kotlinx.serialization.json.JsonObjectBuilder { *; }
-keep class kotlinx.serialization.json.JsonObjectKt { *; }
-keep class kotlinx.serialization.json.JsonObjectBuilderKt { *; }
-keep class kotlinx.serialization.json.JsonElementKt { *; }
-keep class kotlinx.serialization.json.JsonPrimitiveKt { *; }

# Mermaid WebView JS bridge
-keepclassmembers class com.tabtin.mobile.features.conversation.MermaidBridge {
    @android.webkit.JavascriptInterface <methods>;
}
