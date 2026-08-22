package com.tabtin.mobile.features.main

import androidx.lifecycle.ViewModel
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject

/**
 * Hilt @Singleton bean 通过 hiltViewModel() 注入到 Composable 的轻量
 * wrapper —— ChatDrawerController 是 application-scoped singleton，无法
 * 直接给 Composable 通过 hiltViewModel() 取；用这个 ViewModel hold 一份
 * 引用，确保 MainRoute composable 拿到的 controller 与 OrganizationRepository
 * / WS-切换等位置注入的是同一实例。
 */
@HiltViewModel
public class ChatDrawerHolderViewModel @Inject constructor(
    public val controller: ChatDrawerController,
) : ViewModel()
