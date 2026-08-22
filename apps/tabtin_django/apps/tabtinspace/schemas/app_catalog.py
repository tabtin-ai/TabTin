"""Tabtin Space app_catalog schemas。"""

from .common import *  # noqa: F401,F403

class AppCatalogCategory(BaseModel):
    """应用目录分类"""
    id: str = Field(..., description="分类 ID，如 data / creation / development")
    name: str = Field(..., description="分类显示名")
    count: int = Field(..., description="该分类下的应用数量")

class AppCatalogItem(BaseModel):
    """应用目录条目（Organization 应用市场卡片）"""
    id: str = Field(..., description="应用唯一标识")
    name: str = Field(..., description="显示名")
    icon: str = Field(default="", description="图标标识（lucide icon name）")
    icon_asset: Optional[dict] = Field(
        default=None,
        description="包内 SVG 图标资产描述（default/variants/presentation/aliases）",
    )
    description: str = Field(default="", description="应用简短描述（卡片展示）")
    detail_description: str = Field(default="", description="详细功能描述（详情展开区）")
    screenshots: List[str] = Field(default_factory=list, description="截图/示意图 URL 列表")
    category: str = Field(default="", description="分类 ID")
    source: str = Field(..., description="来源：core")
    surface: Optional[str] = Field(
        default=None,
        description="应用形态（三态分类 SSOT）：builtin/local/collaborative；技能包等未声明为 null",
    )
    installed: bool = Field(default=False, description="是否已安装")
    is_default_enabled: bool = Field(default=True, description="新 Space 中默认是否启用")
    order: int = Field(default=0, description="排序权重")
    version: Optional[str] = Field(default=None, description="版本号")
    mobile_mode: Optional[str] = Field(
        default=None,
        description=(
            "移动端 runtimeSupport.mobile.mode 透传："
            "full=完整支持；unsupported/unavailable=明确不可用；"
            "null=manifest 未声明 mobile（向后兼容）"
        ),
    )

class AppCatalogOut(BaseModel):
    """Organization 应用目录响应"""
    apps: List[AppCatalogItem] = Field(..., description="应用列表")
    categories: List[AppCatalogCategory] = Field(..., description="分类列表（含计数）")
    can_manage: bool = Field(default=False, description="当前用户是否可管理（安装/卸载）")

class AppInstallOut(BaseModel):
    """应用安装响应"""
    app_id: str = Field(..., description="应用 ID")
    installed: bool = Field(..., description="安装状态")
    installed_at: Optional[str] = Field(default=None, description="安装时间 ISO 格式")
    surface: Optional[str] = Field(
        default=None,
        description="应用形态（三态分类 SSOT）：builtin/local/collaborative；未声明为 null",
    )

class AppUninstallOut(BaseModel):
    """应用卸载响应"""
    app_id: str = Field(..., description="应用 ID")
    installed: bool = Field(..., description="安装状态")
    affected_spaces: int = Field(default=0, description="受影响的 Space 数量")

__all__ = [
    'AppCatalogCategory',
    'AppCatalogItem',
    'AppCatalogOut',
    'AppInstallOut',
    'AppUninstallOut',
]
