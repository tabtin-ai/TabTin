"""外部群对旧客户端可识别的业务错误。"""


class ExternalGroupCapabilityError(ValueError):
    error_code = "EXTERNAL_GROUP_CAPABILITY_NOT_SUPPORTED"


class ExternalContactNotInvitableError(PermissionError):
    error_code = "EXTERNAL_CONTACT_NOT_INVITABLE"
