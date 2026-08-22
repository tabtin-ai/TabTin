package com.tabtin.mobile.push

import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
internal object PushModule {
    @Provides
    @Singleton
    public fun providePushSdkClient(): PushSdkClient = NoopPushSdkClient()
}
