/**
 * 跨进程共享的 ImportMetaEnv 类型声明。
 *
 * 由 main / renderer 共用（renderer 的 src/renderer/src/types/global.d.ts 也声明了
 * 同名 interface，TypeScript 会按 declaration merging 规则合并字段，不冲突）。
 *
 * 把这里集中到 src/types/，让 main 进程的 tsconfig.main.json（include
 * "src/types/**\/*.d.ts"）也能拿到精确类型，避免在 main 代码里写
 * `(import.meta as unknown as { env? }).env?.VITE_APP_VERSION` 这种动态访问——
 * 那种写法会让 esbuild 的 import.meta.env 字面量替换降级为 runtime 查表，
 * scripts/build-packaged-app.sh 的 step 1.1 校验也会失去意义。
 */
declare global {
  interface ImportMetaEnv {
    /**
     * 应用版本号 SSOT 注入点（由 scripts/build-packaged-app.sh 顶部按 profile 派生）。
     *
     * 必须**精确**写 `import.meta.env.VITE_APP_VERSION`（不能加 `?.`、`as any`、cast 等）——
     * vite/esbuild 的 env 注入是 AST 模式严格匹配的字面字符串替换，
     * 模式不严格匹配就退化为动态查 `__vite_import_meta_env__` 对象，sourcemap 反混淆链路会失效。
     */
    readonly VITE_APP_VERSION: string

    /**
     * 构建期 git 短 SHA。由 run-electron-vite.mjs 注入；
     * 必须精确写 `import.meta.env.VITE_GIT_COMMIT`。
     */
    readonly VITE_GIT_COMMIT: string

    /**
     * 构建期 git 分支名。detached HEAD 时可能为空；
     * 必须精确写 `import.meta.env.VITE_GIT_BRANCH`。
     */
    readonly VITE_GIT_BRANCH: string

    /**
     * Sentry DSN。空/未配置 = 不启用错误上报。
     * dev 走根 .env（process.env 同名变量），打包版本由构建期注入；
     * 同 VITE_APP_VERSION，必须精确写 `import.meta.env.VITE_SENTRY_DSN`。
     */
    readonly VITE_SENTRY_DSN: string

    /** 开发态 IM 联调时冷启动默认打开「消息」模块；生产构建始终忽略。 */
    readonly VITE_DEV_INITIAL_MODULE?: string

    /** 注册页《用户协议》外链；中英文共用同一链接。 */
    readonly VITE_USER_AGREEMENT_URL?: string

    /** 注册页《隐私政策》外链；中英文共用同一链接。 */
    readonly VITE_PRIVACY_POLICY_URL?: string

    /**
     * 本地 Electron 语言钉（仅 DEV）。支持全部界面语言代码或 system；
     * 未设置则跟随设置页偏好 / 系统语言。生产安装包忽略。
     */
    readonly VITE_DEV_LANGUAGE?: string

    /**
     * 浏览器容器 flag 的构建期烘焙值（， webview 迁移）。
     * 打包 profile（.env.preprod 等）写 `webview|wcv`，缺省 = 不烘焙（wcv）。
     * 运行时 `TABTIN_BROWSER_CONTAINER` 可覆盖；判定单点在
     * src/shared/browser-container-mode.ts，必须精确写
     * `import.meta.env.VITE_TABTIN_BROWSER_CONTAINER`。
     */
    readonly VITE_TABTIN_BROWSER_CONTAINER?: string

    /**
     * ChatGPT Codex 订阅套餐入口（模型配置）。
     * preprod=true / production=true；须精确写
     * `import.meta.env.VITE_ENABLE_OPENAI_CODEX_BYOK_UI`。
     */
    readonly VITE_ENABLE_OPENAI_CODEX_BYOK_UI?: string

  }

  interface ImportMeta {
    readonly env: ImportMetaEnv
  }
}

export {}
