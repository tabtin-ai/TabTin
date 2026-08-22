# TabTin Android

## 从源码运行

### 1. 准备工作

- 安装 Android Studio，并安装项目要求的 Android SDK、Build Tools 和 Emulator。
- 安装并配置 Android Studio 使用的 JDK；打开工程后等待 Gradle sync 完成。
- 复制 `local.properties.example` 为 `local.properties`，填写本机 Android SDK 路径；
  `local.properties` 不要提交到 Git。

### 2. 让开发助手运行项目

可以把下面的 prompt 直接交给 Codex、Cursor 或其他代码助手：

```text
请在当前仓库运行 TabTin 的 Android 项目：完成 Gradle sync，启动 Android Emulator
或连接已授权的真机，构建并安装 Debug APK，然后启动 TabTin；如果发现构建错误，
请先修复或说明具体阻塞原因。
```

也可以在 Android Studio 中打开 `apps/tabtin-android`，选择 `app` 配置运行 Debug。

### 3. 选择 API 环境

启动后从右上角的 Debug 入口打开环境设置，选择或填写 API 地址。要连接本机开发
环境时，先在 PC 端启动 TabTin，再使用 PC 端生成的二维码；Android 扫码后会自动
填充 API、WebSocket 和实时通道地址。真机必须能访问运行服务的电脑（例如处于同一
局域网），不要填写 `localhost`；Android Emulator 访问宿主机通常使用
`10.0.2.2`。

## 构建命令

```bash
cd apps/tabtin-android
./gradlew :app:assembleDebug
```
