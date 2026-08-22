package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.api.OrchestrationApi
import com.tabtin.mobile.data.model.SubAgentTemplate
import com.tabtin.mobile.data.model.SubAgentTemplateCreate
import com.tabtin.mobile.data.model.SubAgentTemplateUpdate
import com.tabtin.mobile.data.model.SubAgentToggleRequest
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
public class SubAgentRepository @Inject constructor(
    private val api: OrchestrationApi,
) {
    public suspend fun getTemplates(spaceId: String): List<SubAgentTemplate> =
        api.getSubAgentTemplates(spaceId).items

    public suspend fun createTemplate(spaceId: String, create: SubAgentTemplateCreate): SubAgentTemplate =
        api.createSubAgentTemplate(spaceId, create)

    public suspend fun updateTemplate(spaceId: String, templateId: String, update: SubAgentTemplateUpdate): SubAgentTemplate =
        api.updateSubAgentTemplate(spaceId, templateId, update)

    public suspend fun toggleTemplate(spaceId: String, templateId: String, enabled: Boolean): SubAgentTemplate =
        api.toggleSubAgentTemplate(spaceId, templateId, SubAgentToggleRequest(enabled))

    public suspend fun deleteTemplate(spaceId: String, templateId: String) {
        api.deleteSubAgentTemplate(spaceId, templateId)
    }
}
