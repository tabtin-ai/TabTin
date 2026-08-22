/**
 * 指纹预览工具
 *
 * 🎯 目的：在前端 UI 展示后端将会生成的指纹信息
 * ⚠️ 注意：此逻辑必须与 `apps/tabtin-electron/src/main/anti-detect/fingerprint-preload.js` 保持完全一致！
 *
 * ✨ v2.0 增强：
 * - 支持平台一致性检测（Mac模拟Mac，Win模拟Win）
 * - 集成真实设备配置库（42+设备）
 * - 动态生成Client Hints信息
 */

import i18n from '@/i18n'

export interface WebGLFingerprint {
  vendor: string;
  renderer: string;
}

export interface ExtendedFingerprint {
  webgl: WebGLFingerprint;
  platform: string;
  platformVersion: string;
  arch: string;
  mobile: boolean;
  keepNativeGPU: boolean; // 是否保持原生显卡（平台一致时）
  description: string; // 描述信息
}

/**
 * 获取当前系统平台
 */
function getCurrentPlatform(): 'macOS' | 'Windows' | 'Linux' | 'Unknown' {
  if (typeof navigator === 'undefined') return 'Unknown';

  const ua = navigator.userAgent;
  if (ua.includes('Mac OS X') || ua.includes('Macintosh')) return 'macOS';
  if (ua.includes('Windows')) return 'Windows';
  if (ua.includes('Linux')) return 'Linux';
  return 'Unknown';
}

/**
 * 获取系统真实架构（优先从 Client Hints API）
 */
function getCurrentArchitecture(): 'arm' | 'x86' | undefined {
  if (typeof navigator === 'undefined') return undefined;

  // 1. 优先从 Client Hints API 获取（最准确）
  if ('userAgentData' in navigator && (navigator as any).userAgentData) {
    const uaData = (navigator as any).userAgentData;
    if (uaData.architecture) {
      return uaData.architecture === 'arm' ? 'arm' : 'x86';
    }
  }

  // 2. 从 UA 推断
  const ua = navigator.userAgent;
  if (ua.includes('ARM64') || ua.includes('arm64') || ua.includes('aarch64')) {
    return 'arm';
  }
  if (ua.includes('x64') || ua.includes('Win64') || ua.includes('x86_64')) {
    return 'x86';
  }

  // 3. 对于 macOS，检查 GPU 信息（如果可以访问）
  // 如果有 Apple M 系列芯片，肯定是 arm
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl') as WebGLRenderingContext | null;
    if (gl) {
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      if (debugInfo) {
        const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) as string;
        if (renderer && (renderer.includes('Apple M') || renderer.includes('Apple GPU'))) {
          return 'arm'; // Apple Silicon
        }
      }
    }
  } catch (e) {
    // Ignore
  }

  return undefined;
}

/**
 * 检查目标UA平台是否与当前系统一致
 */
function isPlatformConsistent(targetUA: string): boolean {
  const currentPlatform = getCurrentPlatform();

  if (currentPlatform === 'macOS' && (targetUA.includes('Macintosh') || targetUA.includes('Mac OS X'))) {
    return true;
  }
  if (currentPlatform === 'Windows' && targetUA.includes('Windows')) {
    return true;
  }
  if (currentPlatform === 'Linux' && targetUA.includes('Linux') && !targetUA.includes('Android')) {
    return true;
  }
  return false;
}

/**
 * 根据 UA 推导 WebGL 指纹（简化版）
 */
export function getFingerprintPreview(userAgent: string): WebGLFingerprint {
  const extended = getExtendedFingerprintPreview(userAgent);
  return extended.webgl;
}

/**
 * 获取扩展指纹预览（包含更多信息）
 */
export function getExtendedFingerprintPreview(userAgent: string): ExtendedFingerprint {
  const isConsistent = isPlatformConsistent(userAgent);
  const currentPlatform = getCurrentPlatform();
  const currentArch = getCurrentArchitecture(); // 获取真实架构

  // ⚠️ 重要：移动设备优先检查（因为iPhone/iPad UA中也包含 "Mac OS X"）

  // 1. iPhone UA
  if (userAgent.includes('iPhone')) {
    const versionMatch = userAgent.match(/CPU iPhone OS (\d+)_(\d+)/);
    const iosVersion = versionMatch ? `${versionMatch[1]}.${versionMatch[2]}.0` : '17.7.0';

    // 根据iOS版本推断设备代数和GPU
    let gpuModel = 'Apple A17 Pro GPU'; // 默认最新
    let deviceGeneration = 'iPhone 15 Pro';

    if (versionMatch) {
      const majorVersion = parseInt(versionMatch[1]);
      if (majorVersion >= 18) {
        gpuModel = 'Apple A18 Pro GPU';
        deviceGeneration = 'iPhone 16 Pro';
      } else if (majorVersion >= 17) {
        gpuModel = 'Apple A17 Pro GPU';
        deviceGeneration = 'iPhone 15 Pro';
      } else if (majorVersion >= 16) {
        gpuModel = 'Apple A16 GPU (5-core)';
        deviceGeneration = 'iPhone 14 Pro';
      } else if (majorVersion >= 15) {
        gpuModel = 'Apple A15 GPU (5-core)';
        deviceGeneration = 'iPhone 13 Pro';
      } else {
        gpuModel = 'Apple A14 GPU';
        deviceGeneration = 'iPhone 12';
      }
    }

    return {
      webgl: {
        vendor: 'Apple Inc.',
        renderer: gpuModel
      },
      platform: 'iOS',
      platformVersion: iosVersion,
      arch: 'arm',
      mobile: true,
      keepNativeGPU: false,
      description: i18n.t('fingerprint.mobileSummary', {
        ns: 'userAgent',
        device: deviceGeneration,
        os: 'iOS',
        version: versionMatch ? versionMatch[1] : '17',
        gpu: gpuModel
      })
    };
  }

  // 2. iPad UA
  if (userAgent.includes('iPad')) {
    const versionMatch = userAgent.match(/CPU OS (\d+)_(\d+)/);
    const iosVersion = versionMatch ? `${versionMatch[1]}.${versionMatch[2]}.0` : '17.7.0';

    // iPad通常使用M系列或A系列高端芯片
    let gpuModel = 'Apple M2 GPU'; // 默认iPad Pro
    let deviceGeneration = 'iPad Pro';

    if (versionMatch) {
      const majorVersion = parseInt(versionMatch[1]);
      if (majorVersion >= 18) {
        gpuModel = 'Apple M4 GPU';
        deviceGeneration = 'iPad Pro (M4)';
      } else if (majorVersion >= 17) {
        gpuModel = 'Apple M2 GPU';
        deviceGeneration = 'iPad Air/Pro (M2)';
      } else if (majorVersion >= 16) {
        gpuModel = 'Apple M1 GPU';
        deviceGeneration = 'iPad Pro (M1)';
      } else {
        gpuModel = 'Apple A14 GPU';
        deviceGeneration = 'iPad Air';
      }
    }

    return {
      webgl: {
        vendor: 'Apple Inc.',
        renderer: gpuModel
      },
      platform: 'iPadOS',
      platformVersion: iosVersion,
      arch: 'arm',
      mobile: false, // iPad 在某些API中 mobile=false
      keepNativeGPU: false,
      description: i18n.t('fingerprint.mobileSummary', {
        ns: 'userAgent',
        device: deviceGeneration,
        os: 'iPadOS',
        version: versionMatch ? versionMatch[1] : '17',
        gpu: gpuModel
      })
    };
  }

  // 3. Android UA
  if (userAgent.includes('Android')) {
    // 尝试解析设备型号
    const modelMatch = userAgent.match(/Android [^;]+; ([^)]+)\)/);
    const deviceModel = modelMatch ? modelMatch[1] : 'Generic Android';

    // 根据设备型号推断GPU（更智能）
    let gpu = 'Adreno (TM) 650'; // 默认高端GPU
    let deviceLabel = deviceModel;

    if (deviceModel.includes('Pixel')) {
      gpu = 'Adreno (TM) 740'; // Pixel 8/9系列
      deviceLabel = `Google ${deviceModel}`;
    } else if (deviceModel.includes('Samsung') || deviceModel.includes('Galaxy')) {
      gpu = 'Mali-G715'; // Samsung旗舰
      deviceLabel = 'Samsung Galaxy';
    } else if (deviceModel.includes('OnePlus')) {
      gpu = 'Adreno (TM) 730';
      deviceLabel = deviceModel;
    } else if (deviceModel.includes('Xiaomi') || deviceModel.includes('MI') || deviceModel.includes('Redmi')) {
      gpu = 'Adreno (TM) 730';
      deviceLabel = deviceModel;
    }

    const description = i18n.t('fingerprint.androidSummary', {
      ns: 'userAgent',
      device: deviceLabel,
      gpu
    });

    // 尝试解析Android版本
    const versionMatch = userAgent.match(/Android (\d+)/);
    const androidVersion = versionMatch ? `${versionMatch[1]}.0.0` : '14.0.0';

    return {
      webgl: {
        vendor: 'Qualcomm',
        renderer: gpu
      },
      platform: 'Android',
      platformVersion: androidVersion,
      arch: 'arm',
      mobile: true,
      keepNativeGPU: false,
      description
    };
  }

  // 4. macOS UA（桌面）
  if (userAgent.includes('Macintosh') || userAgent.includes('Mac OS X')) {
    // 检测架构：优先使用真实架构，其次从UA推断
    let arch: 'arm' | 'x86';
    if (isConsistent && currentPlatform === 'macOS' && currentArch) {
      // 如果是同平台，使用系统真实架构
      arch = currentArch;
    } else {
      // 否则从UA推断
      arch = (userAgent.includes('ARM64') || userAgent.includes('arm64')) ? 'arm' : 'x86';
    }

    const isAppleSilicon = arch === 'arm';

    // 如果是同平台且是Apple Silicon，尝试获取真实的GPU型号
    let gpuModel = 'Apple M1'; // 默认
    if (isConsistent && currentPlatform === 'macOS' && isAppleSilicon) {
      try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl') as WebGLRenderingContext | null;
        if (gl) {
          const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
          if (debugInfo) {
            const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) as string;
            if (renderer && renderer.includes('Apple M')) {
              // 提取GPU型号，例如 "ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, ...)"
              const match = renderer.match(/Apple M\d+(?:\s+Pro|Max|Ultra)?/);
              if (match) {
                gpuModel = match[0];
              }
            }
          }
        }
      } catch (e) {
        // Ignore
      }
    }

    return {
      webgl: {
        vendor: 'Google Inc. (Apple)',
        renderer: isAppleSilicon
          ? `ANGLE (Apple, ANGLE Metal Renderer: ${gpuModel}, Unspecified Version)`
          : 'ANGLE (Apple, Intel(R) Iris(TM) Graphics 6100, OpenGL 4.1)'
      },
      platform: 'macOS',
      platformVersion: '26.0.0', // Darwin version
      arch: arch,
      mobile: false,
      keepNativeGPU: isConsistent && currentPlatform === 'macOS',
      description: isConsistent && currentPlatform === 'macOS'
        ? i18n.t('fingerprint.mac.consistent', { ns: 'userAgent' })
        : i18n.t('fingerprint.mac.cross', { ns: 'userAgent' })
    };
  }

  // 5. Windows UA
  if (userAgent.includes('Windows') || userAgent.includes('Win64')) {
    // 判断真实硬件是否是 Apple 芯片
    const isRealApple = currentPlatform === 'macOS';

    // 如果在 Mac 上模拟 Windows，会伪装成 NVIDIA
    // 如果在 Windows 上，会保留原生 GPU
    const gpuVendor = isRealApple ? 'Google Inc. (NVIDIA)' : 'Google Inc. (NVIDIA)';
    const gpuRenderer = isRealApple
      ? 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1050 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)'
      : 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)';

    return {
      webgl: {
        vendor: gpuVendor,
        renderer: gpuRenderer
      },
      platform: 'Windows',
      platformVersion: '10.0.0',
      arch: 'x86',
      mobile: false,
      keepNativeGPU: isConsistent && currentPlatform === 'Windows',
      description: isRealApple
        ? i18n.t('fingerprint.windows.macToWindows', { ns: 'userAgent' })
        : (isConsistent && currentPlatform === 'Windows'
            ? i18n.t('fingerprint.windows.consistent', { ns: 'userAgent' })
            : i18n.t('fingerprint.windows.cross', { ns: 'userAgent' }))
    };
  }

  // 6. Linux UA
  if (userAgent.includes('Linux') && !userAgent.includes('Android')) {
    return {
      webgl: {
        vendor: 'Google Inc. (Intel)',
        renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)'
      },
      platform: 'Linux',
      platformVersion: '5.15.0',
      arch: 'x86',
      mobile: false,
      keepNativeGPU: isConsistent && currentPlatform === 'Linux',
      description: isConsistent && currentPlatform === 'Linux'
        ? i18n.t('fingerprint.linux.consistent', { ns: 'userAgent' })
        : i18n.t('fingerprint.linux.cross', { ns: 'userAgent' })
    };
  }

  // 7. 默认/未知
  return {
    webgl: {
      vendor: 'Google Inc. (Intel)',
      renderer: 'ANGLE (Intel, Intel Iris OpenGL Engine, OpenGL 4.1)'
    },
    platform: 'Unknown',
    platformVersion: '0.0.0',
    arch: 'x86',
    mobile: false,
    keepNativeGPU: false,
    description: i18n.t('fingerprint.unknown', { ns: 'userAgent' })
  };
}

/**
 * 获取平台一致性描述
 */
export function getPlatformConsistencyStatus(userAgent: string): {
  isConsistent: boolean;
  currentPlatform: string;
  targetPlatform: string;
  recommendation: string;
} {
  const currentPlatform = getCurrentPlatform();
  const isConsistent = isPlatformConsistent(userAgent);

  let targetPlatform = 'Unknown';
  if (userAgent.includes('Macintosh') || userAgent.includes('Mac OS X')) {
    targetPlatform = 'macOS';
  } else if (userAgent.includes('Windows')) {
    targetPlatform = 'Windows';
  } else if (userAgent.includes('Linux') && !userAgent.includes('Android')) {
    targetPlatform = 'Linux';
  } else if (userAgent.includes('iPhone')) {
    targetPlatform = 'iOS';
  } else if (userAgent.includes('iPad')) {
    targetPlatform = 'iPadOS';
  } else if (userAgent.includes('Android')) {
    targetPlatform = 'Android';
  }

  let recommendation = '';
  if (isConsistent) {
    recommendation = i18n.t('consistency.best', { ns: 'userAgent' });
  } else {
    recommendation = i18n.t('consistency.cross', { ns: 'userAgent' });
  }

  return {
    isConsistent,
    currentPlatform,
    targetPlatform,
    recommendation
  };
}
