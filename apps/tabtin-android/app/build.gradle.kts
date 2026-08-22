plugins {
    alias(libs.plugins.android.application)
    // AGP 9.0+ ships built-in Kotlin support; org.jetbrains.kotlin.android is no longer required.
    // 见 https://developer.android.com/build/migrate-to-built-in-kotlin
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.hilt)
    alias(libs.plugins.ksp)
}

android {
    namespace = "com.tabtin.mobile"
    compileSdk = 36
    val releaseStoreFile = providers.gradleProperty("RELEASE_STORE_FILE").orNull
        ?: System.getenv("ANDROID_RELEASE_STORE_FILE")
    val releaseStorePassword = providers.gradleProperty("RELEASE_STORE_PASSWORD").orNull
        ?: System.getenv("ANDROID_RELEASE_STORE_PASSWORD")
    val releaseKeyAlias = providers.gradleProperty("RELEASE_KEY_ALIAS").orNull
        ?: System.getenv("ANDROID_RELEASE_KEY_ALIAS")
    val releaseKeyPassword = providers.gradleProperty("RELEASE_KEY_PASSWORD").orNull
        ?: System.getenv("ANDROID_RELEASE_KEY_PASSWORD")

    // 打包机出包时用时间戳覆盖，避免内部分发无法区分版本（见 scripts/android-build-release-apk.sh）。
    val overrideVersionCode = (providers.gradleProperty("ANDROID_VERSION_CODE").orNull
        ?: System.getenv("ANDROID_VERSION_CODE"))?.toIntOrNull()
    val overrideVersionName = providers.gradleProperty("ANDROID_VERSION_NAME").orNull
        ?: System.getenv("ANDROID_VERSION_NAME")

    // Release 包默认使用正式环境；打包机可通过单一选择器显式切换整套网络地址，
    // 避免 API、WebSocket、WebView 和 Centrifugo 分别配置后出现跨环境混用。
    val releaseEnvironment = (
        providers.gradleProperty("RELEASE_ENVIRONMENT").orNull
            ?: System.getenv("ANDROID_RELEASE_ENVIRONMENT")
            ?: "production"
        ).trim().lowercase()
    val releaseUsesProduction = when (releaseEnvironment) {
        "production", "prod" -> true
        "test" -> false
        else -> throw GradleException(
            "不支持的 Android release 环境: $releaseEnvironment（仅支持 production/prod/test）",
        )
    }
    val observabilityEnvironment = if (releaseUsesProduction) "production" else "test"
    val gitSha = (providers.gradleProperty("TABTIN_GIT_SHA").orNull
        ?: System.getenv("TABTIN_GIT_SHA")
        ?: "").trim().lowercase()
    if (gitSha.isNotEmpty() && !gitSha.matches(Regex("[0-9a-f]{7,40}"))) {
        throw GradleException("TABTIN_GIT_SHA 必须是 7～40 位小写十六进制 Git SHA")
    }
    val releaseApiBaseUrl = if (releaseUsesProduction) {
        "https://api.example.com/api"
    } else {
        "https://api-test.example.com/api"
    }
    val releaseWsBaseUrl = if (releaseUsesProduction) {
        "wss://api.example.com/ws/v1/gateway"
    } else {
        "wss://api-test.example.com/ws/v1/gateway"
    }
    val releaseWebBaseUrl = if (releaseUsesProduction) {
        "https://web.example.com"
    } else {
        "https://web-test.example.com"
    }
    val releaseCentrifugoWsUrl = if (releaseUsesProduction) {
        "wss://centrifugo.example.com/connection/websocket"
    } else {
        "wss://centrifugo-test.example.com/connection/websocket"
    }
    val releaseImApiBaseUrl = releaseApiBaseUrl

    defaultConfig {
        applicationId = "com.example.tabtin"
        minSdk = 26
        targetSdk = 36
        versionCode = overrideVersionCode ?: 1
        versionName = overrideVersionName ?: "1.0.0"

        // Debug 默认连 api-test，避免 Native API 与 WebView Web 环境错配。
        // 本地后端可用局域网 IP 覆盖：-PDEV_HOST=192.168.x.x -PDEV_PORT=6060。
        // 测试服/预发/本地也可用完整 URL 覆盖：
        //   -PDEV_API_BASE_URL=https://api-test.example.com/api
        //   -PDEV_WS_BASE_URL=wss://api-test.example.com/ws/v1/gateway
        //   -PDEV_WEB_BASE_URL=https://web-test.example.com
        val devHost = project.findProperty("DEV_HOST")?.toString() ?: "10.0.2.2"
        val devPort = project.findProperty("DEV_PORT")?.toString() ?: "6060"
        val useLocalDevHost = project.hasProperty("DEV_HOST") || project.hasProperty("DEV_PORT")
        val devApiBaseUrl = project.findProperty("DEV_API_BASE_URL")?.toString()
            ?: if (useLocalDevHost) "http://$devHost:$devPort/api" else "https://api-test.example.com/api"
        val devWsBaseUrl = project.findProperty("DEV_WS_BASE_URL")?.toString()
            ?: if (useLocalDevHost) "ws://$devHost:$devPort/ws" else "wss://api-test.example.com/ws/v1/gateway"
        val devWebBaseUrl = project.findProperty("DEV_WEB_BASE_URL")?.toString() ?: "https://web-test.example.com"
        // TabChat IM 走独立的 Centrifugo 网关（/connection/websocket），与 Agent 对话的
        // WS_BASE_URL（/ws/v1/gateway）分属两套系统。debug 默认连 test，本地起后端时
        // 用局域网 8100 端口；可用 -PDEV_CENTRIFUGO_WS_URL=... 显式覆盖。
        val devCentrifugoWsUrl = project.findProperty("DEV_CENTRIFUGO_WS_URL")?.toString()
            ?: if (useLocalDevHost) "ws://$devHost:8100/connection/websocket"
            else "wss://centrifugo-test.example.com/connection/websocket"
        // TabChat REST 与主 API 共用网关；保留独立字段供诊断页展示当前 IM 环境。
        val devImApiBaseUrl = devApiBaseUrl
        buildConfigField("String", "API_BASE_URL", "\"$devApiBaseUrl\"")
        buildConfigField("String", "WS_BASE_URL", "\"$devWsBaseUrl\"")
        buildConfigField("String", "WEB_BASE_URL", "\"$devWebBaseUrl\"")
        buildConfigField("String", "CENTRIFUGO_WS_URL", "\"$devCentrifugoWsUrl\"")
        buildConfigField("String", "IM_API_BASE_URL", "\"$devImApiBaseUrl\"")
        // prod 域名常量，供按 apiBaseUrl 推导 Centrifugo 环境。
        buildConfigField("String", "CENTRIFUGO_WS_URL_PROD", "\"wss://centrifugo.example.com/connection/websocket\"")
        buildConfigField("String", "OBSERVABILITY_ENVIRONMENT", "\"test\"")
        buildConfigField("String", "TABTIN_GIT_SHA", "\"$gitSha\"")

        externalNativeBuild {
            cmake {
                arguments("-DANDROID_STL=none")
            }
        }
    }

    signingConfigs {
        if (!releaseStoreFile.isNullOrBlank()) {
            create("release") {
                storeFile = file(releaseStoreFile)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            signingConfig = if (!releaseStoreFile.isNullOrBlank()) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            buildConfigField("String", "API_BASE_URL", "\"$releaseApiBaseUrl\"")
            buildConfigField("String", "WS_BASE_URL", "\"$releaseWsBaseUrl\"")
            buildConfigField("String", "WEB_BASE_URL", "\"$releaseWebBaseUrl\"")
            buildConfigField("String", "CENTRIFUGO_WS_URL", "\"$releaseCentrifugoWsUrl\"")
            buildConfigField("String", "IM_API_BASE_URL", "\"$releaseImApiBaseUrl\"")
            buildConfigField("String", "CENTRIFUGO_WS_URL_PROD", "\"wss://centrifugo.example.com/connection/websocket\"")
            buildConfigField("String", "OBSERVABILITY_ENVIRONMENT", "\"$observabilityEnvironment\"")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // AGP 9: kotlinOptions {} DSL 已被移除；built-in Kotlin 默认让 jvmTarget 跟随
    // android.compileOptions.targetCompatibility（=17），无需显式声明。
    // freeCompilerArgs 在文件底部 `kotlin { compilerOptions {} }` 块中声明
    // （W C 启用 -Xjsr305=strict — Java 互操作 nullness 严化）。

    buildFeatures {
        compose = true
        buildConfig = true
        prefab = true
        viewBinding = true
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/jni/CMakeLists.txt")
            version = "3.22.1+"
        }
    }

    testOptions {
        // Wave A0.3（2026-05-04）：testOptions DSL 升级为现代写法（W A0 反思 #L28
        // 升级；deprecated `testOptions.unitTests.all { it.X }` 是 AGP 8 起的旧 DSL，
        // AGP 10+ 可能移除——趁本期改 OOM 治理一并升级）。
        unitTests {
            isIncludeAndroidResources = true
            all {
                // Wave A0.3 OOM 治理：**部分修复 + stop-and-report**。详见
                //
                // -- (b) `forkEvery = 1` 治本（主线，本 Wave 落地）--
                //
                // 让每个 test class fork 新 JVM 进程，测试间 ClassLoader 内存隔离 +
                // 自动随 JVM 退出回收。这是 Compose BOM 2026.03 + Hilt 2.59 + Room
                // 2.8.4 + KSP2 + Robolectric 4.14 同时加载场景下的工业标准做法。
                // 代价是 JVM 启动开销（每个 test class 加约 1-3s 启动时间）。
                it.forkEvery = 1L
                // -- maxHeapSize 维持 6g（不升 8g）的根因 --
                //
                // W A0.3 实测：6g + forkEvery=1 跑 12 测试类后挂死；8g + forkEvery=1
                // 跑同样 12 测试类后挂死。**升 heap 不解决问题**。jstack 抓栈显示
                // worker 实际 hang 在 `DocEditorViewModelPermissionTest.RV-002 500
                // error does not trigger permission revoked` 测试中，mockk 通过
                // `JvmMockFactoryHelper.toDescription` → `KClassImpl.getMembers` →
                // `kotlin.reflect.jvm.internal.impl.serialization.deserialization.*`
                // 解析 `DocRepository` 的 KClass 元数据；CPU 仅 37s 但壁钟 14 min，
                // 是 mockk + kotlin-reflect 反射性能 bug（参考 mockk #1077 类问题）。
                //
                // hang 后单 worker 持续吃内存 → 看起来像 OOM，**实际是反射递归在累积内存**。
                // 这超出 W A0.3 「testOptions 配置」范围；根因修复路径：
                //   (a) DocEditorViewModelPermissionTest 改不依赖 mockk DocRepository
                //       元数据反射的方案（fake 实现 / kotlin-test-runner / 显式 stub all）
                //   (b) 或在 W A0.4「DocEditorViewModel 测试串改造」一并处理
                // 已 stop-and-report 给 harness 决策。
                //
                // 维持 6g 的诚实理由：8g 也没解决问题，留 8g 是误导后人「治本配置」。
                // 6g + forkEvery=1 是「部分缓解 + 不退步」最小可行配置；harness 决策
                // 修完 PermissionTest 反射 hang 后，再讨论是否还需调 heap。
                it.maxHeapSize = "6g"
                it.jvmArgs("-XX:+HeapDumpOnOutOfMemoryError")
            }
        }
    }

    packaging {
        resources {
            excludes += "META-INF/versions/9/OSGI-INF/MANIFEST.MF"
        }
    }

}

// Wave B.1 + B.2 + B.3 已完工（2026-05-04）：
//   W B.1: data/ 目录 1259 errors → 0（106 个文件全 public 加好）
//   W B.2: features/ 目录 1158 errors → 0（136 个文件）
//   W B.3: ui/ + nav/ + util/ + daemon/ + 顶层 + privileged 489 errors → 0
//          （prompt §关键事实写 488 误差 1 = privileged/Server.kt 归属差异；详 W B.3 反思 §2.2）
// 整仓累计消化 2906 errors / ~290 文件。
//
// W B.3 完工后**永久启用 explicitApi()**——这是 Android 战线"严肃化"的核心承诺：
// 未来所有 future code 强制写 visibility 修饰符（不再注释回退）。
//
// 详细统计 + 决策路径：
//   `docs/Android-explicit-api-conventions.md`（例外清单 + 项目实例）
kotlin {
    explicitApi()

    // Wave C（2026-05-04）启用 strict null：Java 互操作 nullness 信息从 platform type
    // 变成强制检查。OkHttp 5 / Retrofit 2.11 / Room 2.8.4 等 Java 库的 @Nullable /
    // @NonNull JSR-305 注解会被 Kotlin 编译器视为 nullable / non-null 类型契约，未匹配
    // 的调用方会编译报错（platform type 时仅是 warning 或 silently NPE）。
    //
    //
    // Wave D batch 9（2026-05-04）：消 76 处 KT-73255 deprecated warning（"This annotation
    // is currently applied to the value parameter only, but in the future it will also be
    // applied to field"）。Kotlin 2.1.20 引入 experimental flag `-Xannotation-default-target`
    // 配合 KEEP-402 提案（`https://github.com/Kotlin/KEEP/issues/402`）；Kotlin 2.2.0 起对
    // ctor `@Inject` / `@ApplicationContext` / 自定义 dispatcher qualifier 等注解的 default
    // target 行为变化正式打 deprecated warning —— 当前默认仅 value parameter，未来将同时
    // apply 到 property/field。本 batch 9 一行编译选项让 default target 对齐到 `param-property`
    // （双 target，与 KEEP-402 提议的未来默认行为提前对齐），76 处 warning 全部消除；对本项目
    // KSP 处理器（Hilt @Inject / Room / kotlinx-serialization KSP）场景而言 runtime 行为零
    // 变化（这些 KSP 处理器编译期生成代码，不依赖 reflection 读 field 注解；ctor param 与
    // backing field 双面可见的注解 metadata 不影响生成的 Provider/Dao/Serializer 字节码）。
    //
    // 注：`-X` prefix 为 Kotlin experimental flag 约定；当未来 Kotlin（2.4+）将默认行为
    // 对齐到 `param-property` 后，此 flag 可主动删除（KEEP-402 跟踪）。删除时应同步移除本注释段。
    //
    compilerOptions {
        freeCompilerArgs.add("-Xjsr305=strict")                            // W C：strict null
        freeCompilerArgs.add("-Xannotation-default-target=param-property") // W D batch 9：消 76 处 KT-73255
    }
}

// 修复 "task 'testClasses' not found" 错误
tasks.register("testClasses") {
    dependsOn("compileDebugUnitTestSources")
}

// Wave A0（2026-05-03）退役 schema-bridge-test 旁路：
// 该旁路最初是为了在 main set 76 个编译错误存在期间，让 RichContentSchemaBridge
// 单测仍可跑通（用 K2JVMCompiler 单独编译 + 手动跑 JUnit 绕开 main set）。
// 2026-05-02 基线快照实测 main set 已 0 错 + test set 也能 compile（RichTextUtilsTest
// 已删除、DocBlockAdapterIdTest 已修），所以旁路存在意义消失，整文件删除。
// RichTablePreviewSchemaTest 现在走标准 :app:testDebugUnitTest 流程即可。

dependencies {
    implementation(libs.core.ktx)
    implementation(libs.androidx.webkit)
    implementation(libs.activity.compose)
    implementation(libs.appcompat)
    implementation(libs.recyclerview)
    implementation(libs.splashscreen)

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons)
    implementation(libs.compose.foundation)
    implementation(libs.compose.navigation)
    debugImplementation(libs.compose.ui.tooling)

    implementation(libs.lifecycle.runtime)
    implementation(libs.lifecycle.viewmodel)
    implementation(libs.lifecycle.process)
    implementation(libs.work.runtime)

    implementation(libs.hilt.android)
    ksp(libs.hilt.compiler)
    implementation(libs.hilt.navigation.compose)

    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    ksp(libs.room.compiler)

    implementation(libs.retrofit)
    implementation(libs.okhttp)
    implementation(libs.okhttp.logging)
    debugImplementation(libs.chucker)
    releaseImplementation(libs.chucker.no.op)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.retrofit.serialization)
    implementation(libs.sentry.android)
    implementation(libs.centrifuge)
    implementation(libs.zxing.android.embedded)

    implementation(libs.coil)
    implementation(libs.coil.compose)
    implementation(libs.datastore)
    implementation(libs.security.crypto)
    implementation(libs.markdown.renderer)
    implementation(libs.markdown.renderer.m3)

    // ADB pairing (BoringSSL for SPAKE2+)
    implementation("io.github.vvb2060.ndk:boringssl:20250114")
    implementation("org.lsposed.libcxx:libcxx:27.0.12077973")
    // BouncyCastle for X.509 certificate generation
    implementation("org.bouncycastle:bcprov-jdk18on:1.79")
    implementation("org.bouncycastle:bcpkix-jdk18on:1.79")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.14.1")
    testImplementation("androidx.test:core:1.6.1")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
    testImplementation("io.mockk:mockk:1.13.13")
}
