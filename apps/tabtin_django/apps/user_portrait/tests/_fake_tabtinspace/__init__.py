"""测试专用：模拟 ``tabtinspace`` app 的最小 Organization / OrganizationMember 模型。

为什么需要：
  - ``UserPortraitService._check_organization_membership`` 通过
    ``apps.get_model("tabtinspace", "Organization"/"OrganizationMember")`` 取模型；
  - 真 ``apps.tabtinspace`` 在 SQLite 测试环境下无法 syncdb（链式依赖
    tabdata 的 ArrayField 在 SQLite 上 ``CREATE TABLE`` 报 syntax error）；
  - 单测又必须覆盖成员校验的全部分支（owner / member / outsider / 退出）。

策略：注册一个 ``label="tabtinspace"`` 的 micro app，定义跟真 Organization /
OrganizationMember **足够兼容**的最小模型——只暴露 _check_organization_membership
真实需要的字段（``id`` / ``owner_id`` / ``organization_id`` / ``user_id``）。

Django 在 settings 里注册这个 fake 而不装真 tabtinspace，
``apps.get_model`` 就会拿到这里的模型。生产环境从未加载 fake，因为它在
test settings 才 INSTALLED_APPS 里。
"""
