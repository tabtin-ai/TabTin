# 钱包系统模块
# 注意：不要在这里导入models，会导致Django应用注册错误

__all__ = [
    "CreditsService",
    "OrganizationWalletService",
]


def __getattr__(name):
    """懒加载服务类，避免循环导入"""
    if name == "CreditsService":
        from .services import CreditsService
        return CreditsService
    if name == "OrganizationWalletService":
        from .services import OrganizationWalletService
        return OrganizationWalletService
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
