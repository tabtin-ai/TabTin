"""Scene 化入口标准错误码。

精确实现 12 个异常子类。
"""

from __future__ import annotations


class SceneCallError(Exception):
    """所有 scene 入口抛出的标准错误基类。"""
    error_code: str = ""
    error_category: str = "scene_call"
    http_status: int = 500

    def __init__(self, message: str = "", *, scene_key: str = "", **context):
        super().__init__(message or self.error_code)
        self.scene_key = scene_key
        self.context = context


class SceneBindingUnavailable(SceneCallError):
    error_code = "E14_SCENE_BINDING_UNAVAILABLE"
    http_status = 503


class SceneBindingViolatesByokBoundary(SceneCallError):
    error_code = "E14_SCENE_BINDING_VIOLATES_BYOK_BOUNDARY"
    http_status = 500


class NoProviderHealthy(SceneCallError):
    error_code = "E15_NO_PROVIDER_HEALTHY"
    http_status = 503


class SceneRoutingDisabled(NoProviderHealthy):
    """Scene 的全部可用候选路由都被运营显式关闭。"""

    error_code = "SCENE_ROUTING_DISABLED"


class CapabilityMismatch(SceneCallError):
    error_code = "E16_CAPABILITY_MISMATCH"
    http_status = 500


class SceneOfficialBindingCapabilityMismatch(CapabilityMismatch):
    """Workspace Memory official_default 的当前 Scene Binding 不满足能力。"""

    error_code = "SCENE_OFFICIAL_BINDING_CAPABILITY_MISMATCH"


class BudgetExceeded(SceneCallError):
    error_code = "E17_BUDGET_EXCEEDED"
    http_status = 402


class PromptBundleMissing(SceneCallError):
    error_code = "E18_PROMPT_BUNDLE_MISSING"
    http_status = 500


class SceneNotRegistered(SceneCallError):
    error_code = "E19_SCENE_NOT_REGISTERED"
    http_status = 500


class SceneDisabled(SceneCallError):
    """Scene Policy 已明确关闭，必须在计费与 Provider 之前停止。"""

    error_code = "SCENE_DISABLED"
    http_status = 422


class CapabilityDomainMismatch(SceneCallError):
    error_code = "E20_CAPABILITY_DOMAIN_MISMATCH"
    http_status = 500


class InvalidVariables(SceneCallError):
    error_code = "E21_INVALID_VARIABLES"
    http_status = 500


class EmbeddingDimensionMismatch(SceneCallError):
    error_code = "E22_EMBEDDING_DIMENSION_MISMATCH"
    http_status = 500


class MissingOrganizationId(SceneCallError):
    error_code = "MISSING_ORGANIZATION_ID"
    http_status = 400


class MissingUserId(SceneCallError):
    error_code = "MISSING_USER_ID"
    http_status = 400


class BackgroundModelNotServerExecutable(SceneCallError):
    """所选会话模型的凭据/运行时只存在于客户端设备。"""

    error_code = "BACKGROUND_MODEL_NOT_SERVER_EXECUTABLE"
    error_category = "background_execution"
    http_status = 422


class WorkspaceMemoryModelUnavailable(SceneCallError):
    """Workspace Memory dispatch snapshot 已不存在或不再符合执行资格。"""

    error_code = "WORKSPACE_MEMORY_MODEL_UNAVAILABLE"
    error_category = "background_execution"
    http_status = 422


class BYOKSceneError(SceneCallError):
    """BYOK source-locked execution failures."""

    error_category = "byok"
    http_status = 422


class BYOKModelNotSelected(BYOKSceneError):
    error_code = "BYOK_MODEL_NOT_SELECTED"


class BYOKProviderScopeMismatch(BYOKSceneError):
    error_code = "BYOK_PROVIDER_SCOPE_MISMATCH"
    http_status = 403


class BYOKCredentialMissing(BYOKSceneError):
    error_code = "BYOK_CREDENTIAL_MISSING"


class BYOKCredentialDecryptFailed(BYOKSceneError):
    error_code = "BYOK_CREDENTIAL_DECRYPT_FAILED"


class BYOKCredentialInvalid(BYOKSceneError):
    error_code = "BYOK_CREDENTIAL_INVALID"


class BYOKCapabilityMismatch(BYOKSceneError):
    error_code = "BYOK_CAPABILITY_MISMATCH"


class BYOKEndpointInvalid(BYOKSceneError):
    error_code = "BYOK_ENDPOINT_INVALID"


class BYOKPolicyBlocked(BYOKSceneError):
    error_code = "BYOK_POLICY_BLOCKED"


class BYOKProviderAuthFailed(BYOKSceneError):
    error_code = "BYOK_PROVIDER_AUTH_FAILED"


class BYOKProviderRateLimited(BYOKSceneError):
    error_code = "BYOK_PROVIDER_RATE_LIMITED"


class BYOKProviderUnavailable(BYOKSceneError):
    error_code = "BYOK_PROVIDER_UNAVAILABLE"


class BYOKResultInvalid(BYOKSceneError):
    error_code = "BYOK_RESULT_INVALID"


class FeatureNotImplemented(SceneCallError):
    """v0.1 显式 stub 错误码：capability 入口已经走完治理链路（SceneCallContext + ModelResolver + BillingPrecheck + LLMUsageFact 写入）但 provider dispatch 未接入。

    与 NotImplementedError 的区别：
    - 必带 scene_key，可被前端 / 客户端按 SceneCallError 子类统一处理
    - 422 = 当前不可用（不是 500 内部错误）
    - 调用方拿到此异常前，LLMUsageFact 已经按 status='failed' / cost_status='n_a' 写入，审计完整

    使用场景：v0.1 image_gen / video_gen / audio_gen 三个媒体生成入口（Wave E2）。
    """
    error_code = "FEATURE_NOT_IMPLEMENTED"
    http_status = 422
