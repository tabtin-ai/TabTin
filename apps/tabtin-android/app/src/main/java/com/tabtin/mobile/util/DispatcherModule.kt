package com.tabtin.mobile.util

import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Qualifier
import javax.inject.Singleton
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers

/**
 * Hilt qualifier for [Dispatchers.Default]，CPU 密集型工作（JSON 解析 / 序列化 / 算法计算）。
 *
 * W A0.3.续7：DocEditorViewModel 通过 `@DefaultDispatcher CoroutineDispatcher` 注入序列化/解析所用
 * dispatcher。生产用 [Dispatchers.Default]，单元测试可在直接构造 ViewModel 时显式传入 testDispatcher，
 * 让 `withContext(coroutineDispatcher)` 内的逻辑可被 `advanceTimeBy / advanceUntilIdle` 调度。
 */
@Qualifier
@Retention(AnnotationRetention.BINARY)
public annotation class DefaultDispatcher

/**
 * Hilt qualifier for [Dispatchers.IO]，blocking I/O 工作（文件读写 / 网络 / 数据库 / OSS 上传）。
 *
 * W D：作为 [@DefaultDispatcher] 的姐妹 qualifier，在 ViewModel 内 hot path 走 IO（如
 * `DocEditorViewModel.uploadFileToOSS` 把 `bytes` 读出来）时使用，让单元测试可注入 testDispatcher
 * 控制时序。详见 `docs/Android-coroutines-conventions.md` §3 dispatcher 约定。
 */
@Qualifier
@Retention(AnnotationRetention.BINARY)
public annotation class IoDispatcher

/**
 * Hilt qualifier for [Dispatchers.Main]，UI thread。
 *
 * W D：预备 qualifier。当前 main set 没有 ViewModel 显式 `withContext(Dispatchers.Main)` 调用
 * （viewModelScope 默认 [Dispatchers.Main.immediate] 已覆盖），保留此 qualifier 给未来需要显式
 * Main dispatcher 注入的场景（如 ImagePreviewDialog 内 Toast 显示路径如果搬到 ViewModel 时）。
 * 详见 `docs/Android-coroutines-conventions.md` §3 dispatcher 约定。
 */
@Qualifier
@Retention(AnnotationRetention.BINARY)
public annotation class MainDispatcher

@Module
@InstallIn(SingletonComponent::class)
public object DispatcherModule {

    @Provides
    @Singleton
    @DefaultDispatcher
    public fun provideDefaultDispatcher(): CoroutineDispatcher = Dispatchers.Default

    @Provides
    @Singleton
    @IoDispatcher
    public fun provideIoDispatcher(): CoroutineDispatcher = Dispatchers.IO

    @Provides
    @Singleton
    @MainDispatcher
    public fun provideMainDispatcher(): CoroutineDispatcher = Dispatchers.Main
}
