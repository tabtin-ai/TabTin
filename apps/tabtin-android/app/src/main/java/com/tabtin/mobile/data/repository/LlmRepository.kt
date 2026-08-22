package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.api.LlmApi
import com.tabtin.mobile.data.model.LlmProvider
import com.tabtin.mobile.data.model.ModelsResponse
import com.tabtin.mobile.data.model.SetDefaultModelRequest
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
public class LlmRepository @Inject constructor(
    private val llmApi: LlmApi,
) {
    public suspend fun getProviders(organizationId: String): List<LlmProvider> {
        return llmApi.getProviders(organizationId).unwrap().providers
    }

    public suspend fun getModels(organizationId: String): ModelsResponse {
        return llmApi.getModels(organizationId).unwrap()
    }

    public suspend fun getChatCatalog(organizationId: String): ModelsResponse {
        return llmApi.getCatalog(organizationId = organizationId, useCase = "chat").unwrap()
    }

    public suspend fun setDefaultModel(organizationId: String, modelId: String) {
        llmApi.setDefaultModel(organizationId, SetDefaultModelRequest(modelId)).unwrap()
    }
}
