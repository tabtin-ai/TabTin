import { executableStep, scenario } from '../runner/scenario';
import { prepareTabdataEmbeddedCollabParentPermission } from '../fixtures/prepare-tabdata-embedded-collab-parent-permission';
import { runTabdataEmbeddedCollabParentPermissionCase } from '../actions/tabdata-embedded-collab-parent-permission';

export default scenario({
  id: 'tabdata.embedded-collab-parent-permission',
  title: '内嵌表格继承父文档权限',
  intent:
    '拥有者和父文档协作者从 Electron 可见界面打开同一文档，协作者无需独立表格 ACL 即可编辑内嵌表格，同时无关父文档不能被伪造成授权来源。',
  priority: 'P0',
  profiles: ['regression', 'data-seeding', 'p0-plus'],
  tags: ['electron', 'tabdata', 'tabdoc', 'permission', 'tier:l2-team'],
  sourceCapability: 'TabDoc / 内嵌表格 / 父文档权限继承',
  testLayer: 'ui',
  dataContract: {
    selfContained: true,
    setup: [
      '创建 run-scoped 组织、拥有者、协作者、私有资源空间和团队导航空间。',
      '拥有者预置父文档、内嵌表格和一条记录；只给协作者父文档 editor 权限，不创建 TablePermission。',
      '另建一个协作者可编辑但不引用目标表格的无关父文档，用于伪造上下文拒绝断言。',
    ],
  },
  interactionContract: {
    requiredUserActions: [
      '拥有者通过 Electron 云盘可见列表点击并打开父文档。',
      '切换到协作者后，通过 Electron 云盘的分享给我列表点击并打开同一父文档。',
      '协作者用真实 CDP 双击、键盘输入和提交事件编辑内嵌表格单元格。',
    ],
    allowedAutomationHelpers: [
      '允许后端准备 run-scoped fixture、登录态 bootstrap、只读 DOM 定位和持久化断言。',
      '无关父文档伪造没有合法产品 UI，允许在 UI 编辑完成后用网关权限检查作安全补充断言。',
    ],
    forbiddenShortcuts: [
      '不得用 service/store/DB/localStorage 直写替代打开文档或编辑表格。',
      '不得用 DOM dispatchEvent 伪造 click/input；用户动作必须由 CDP Input 事件触发。',
      '不得为协作者创建显式 TablePermission。',
    ],
  },
  automationContract: [
    'UI 证据：两个账号都能在 Electron 打开父文档，协作者提交后界面显示新单元格内容。',
    '持久化证据：记录值等于 UI 输入值，协作者直接表格访问为 false、带真实父文档为 true、带无关父文档为 false，显式 TablePermission 数量为 0。',
  ],
  automationStatus: 'ready',
  fixtures: [
    'run-marker',
    'two-account-auth',
    'embedded-table',
    'document-permission',
  ],
  prepare: prepareTabdataEmbeddedCollabParentPermission,
  steps: [
    executableStep(
      'tabdata.embedded-collab-parent-permission.main',
      '双账号通过 Electron 打开父文档并由协作者真实编辑内嵌表格',
      runTabdataEmbeddedCollabParentPermissionCase,
    ),
  ],
});
