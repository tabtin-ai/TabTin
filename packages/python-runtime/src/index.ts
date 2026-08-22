/**
 * @tabtin/python-runtime —— L0 纯基础设施：TabTin 自管 Python 运行时的解析 / provision。
 *
 * 自管 Python 运行时布局：<cacheDir>/tabtin-runtimes/.../dependencies/python。
 * 纯 tabtin 命名、零业务耦合（不认识 Space/Agent/Organization/app.json）。全部外部信息由 L1 宿主适配层注入。
 */

export {
  ensurePythonRuntime,
  entrypointRelPath,
  osCacheDir,
  pythonRuntimeRoot,
  PRIMARY_RUNTIME_NAME,
  PYTHON_RUNTIME_ENV_VAR,
  RUNTIME_NAMESPACE,
} from './resolver.js'
export { parseManifest, expectedPlatform, isSafeRelativePath } from './manifest.js'
export {
  PythonRuntimeError,
  type Logger,
  type PythonRuntimeConfig,
  type PythonRuntimeErrorCode,
  type PythonRuntimeManifest,
  type ResolvedPythonRuntime,
} from './types.js'
