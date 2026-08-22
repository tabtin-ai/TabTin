# TabTin iOS

## 从源码运行

### 1. 准备工作

- 安装最新版 Xcode，并安装项目所需的 iOS Simulator runtime。
- 使用 Apple Developer 账号登录 Xcode；真机运行需要可用的 Team、签名证书和
  provisioning profile。仅在模拟器编译或运行时不需要真机签名。
- 安装 XcodeGen，并在仓库根目录安装项目依赖。

### 2. 让开发助手运行项目

可以把下面的 prompt 直接交给 Codex、Cursor 或其他代码助手：

```text
请在当前仓库运行 TabTin 的 iOS 项目：生成 Xcode 工程，启动 iOS Simulator，
编译并运行 TabTin Debug；如果发现构建错误，请先修复或说明具体阻塞原因。
```

也可以在 Xcode 中打开 `apps/tabtin-ios/Tabtin.xcodeproj`，选择 `Tabtin` scheme
后运行 Debug。

### 3. 选择 API 环境

启动后从右上角的 Debug 入口打开环境设置，选择或填写 API 地址。要连接本机开发
环境时，先在 PC 端启动 TabTin，再使用 PC 端生成的二维码；iOS 扫码后会自动填充
API、WebSocket 和实时通道地址。真机必须能访问运行服务的电脑（例如处于同一局域网），
不要填写 `localhost`。

TabTin iOS 工程由 `project.yml` 通过 XcodeGen 生成。日常修改工程配置后运行：

```bash
cd apps/tabtin-ios
xcodegen generate --spec project.yml
```

从仓库根目录执行。本仓库的 Agent 本地编译统一使用共享缓存包装脚本，不要直接
运行裸 `xcodebuild`：

```bash
bash /Users/at/.codex/bin/tabtin-xcodebuild.sh \
  -project apps/tabtin-ios/Tabtin.xcodeproj \
  -scheme Tabtin \
  -destination 'generic/platform=iOS Simulator' \
  build
```

## 原生 APNs 推送

iOS 客户端使用系统 `UIApplication.registerForRemoteNotifications()` 获取 APNs
device token，并上传到 Django。服务端使用 Apple `.p8` 推送密钥，通过 APNs
HTTP/2 API 直接投递，不依赖 TIMPush。

Apple Developer 配置要求：

1. App ID `com.example.tabtin` 开启 Push Notifications capability。
2. Development provisioning profile 的 `aps-environment` 为 `development`。
3. App Store、TestFlight 或 Ad Hoc profile 的 `aps-environment` 为 `production`。
4. 在 Apple Developer 后台创建 APNs Authentication Key，安全保存下载的
   `AuthKey_<KEY_ID>.p8`；Apple 只允许下载一次。

Django / Celery 运行环境需要注入：

```env
APNS_TEAM_ID=
APNS_KEY_ID=
APNS_BUNDLE_ID=com.example.tabtin
APNS_PRIVATE_KEY_PATH=/path/to/AuthKey_xxx.p8
```

也可使用 `APNS_PRIVATE_KEY` 注入完整私钥内容。`.p8` 私钥禁止提交到 Git，容器
部署时应通过 Secret 挂载，并确保 Django 与 Celery 都能读取同一配置。任一配置
缺失时，远程推送会静默关闭并退化为实时 WebSocket + 打开 App 后拉取数据。

Debug 包上报 `sandbox` token，Release/TestFlight/App Store 包上报 `production`
token；服务端会分别调用对应 APNs endpoint，二者不能混用。

## 推送验收

推送依赖真实签名、真机和 APNs 凭据，模拟器编译通过不代表推送链路可达。发布前
至少验证一次：

1. 真机登录后，后端出现有效的 `apns` device token。
2. App 在后台或被系统挂起时能收到通知。
3. 点击通知能进入对应会话或待审批任务。
4. App 在前台时不重复展示系统横幅。
5. Debug 与 Release token 分别走 sandbox 与 production 环境。
