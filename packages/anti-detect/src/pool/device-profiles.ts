/**
 * 移动设备配置数据库
 *
 * 🎯 目标：提供完整的设备指纹信息（屏幕、GPU、内存、UA）
 * 📱 来源：真实设备统计数据
 * ✅ 用途：生成一致性极高的移动端反检测配置
 */

export interface DeviceDisplay {
  /** 逻辑宽度（CSS pixels） */
  logicalWidth: number;
  /** 逻辑高度（CSS pixels） */
  logicalHeight: number;
  /** 物理宽度（真实像素） */
  physicalWidth: number;
  /** 物理高度（真实像素） */
  physicalHeight: number;
  /** 设备像素比 */
  dpr: number;
}

export interface DeviceGPU {
  /** GPU 名称 */
  name: string;
  /** GPU 核心数 */
  cores: number;
}

export interface DeviceProfile {
  /** 设备型号 */
  model: string;
  /** 设备类型 */
  type: 'iPhone' | 'iPad' | 'Android';
  /** 芯片型号 */
  soc: string;
  /** GPU 信息 */
  gpu: DeviceGPU;
  /** 屏幕信息 */
  display: DeviceDisplay;
  /** 操作系统 */
  os: 'iOS' | 'iPadOS' | 'Android';
  /** 市场份额权重（百分比） */
  weight?: number;
}

/**
 * iOS 设备配置库
 */
export const IOS_DEVICES: DeviceProfile[] = [
  // ==================== iPhone 12 系列 ====================
  {
    model: 'iPhone 12 mini',
    type: 'iPhone',
    soc: 'A14 Bionic',
    gpu: { name: 'Apple A14 GPU', cores: 4 },
    display: { logicalWidth: 375, logicalHeight: 812, physicalWidth: 1080, physicalHeight: 2340, dpr: 3 },
    os: 'iOS',
    weight: 2.5,
  },
  {
    model: 'iPhone 12',
    type: 'iPhone',
    soc: 'A14 Bionic',
    gpu: { name: 'Apple A14 GPU', cores: 4 },
    display: { logicalWidth: 390, logicalHeight: 844, physicalWidth: 1170, physicalHeight: 2532, dpr: 3 },
    os: 'iOS',
    weight: 5.0,
  },
  {
    model: 'iPhone 12 Pro',
    type: 'iPhone',
    soc: 'A14 Bionic',
    gpu: { name: 'Apple A14 GPU', cores: 4 },
    display: { logicalWidth: 390, logicalHeight: 844, physicalWidth: 1170, physicalHeight: 2532, dpr: 3 },
    os: 'iOS',
    weight: 3.5,
  },
  {
    model: 'iPhone 12 Pro Max',
    type: 'iPhone',
    soc: 'A14 Bionic',
    gpu: { name: 'Apple A14 GPU', cores: 4 },
    display: { logicalWidth: 428, logicalHeight: 926, physicalWidth: 1284, physicalHeight: 2778, dpr: 3 },
    os: 'iOS',
    weight: 3.0,
  },

  // ==================== iPhone 13 系列 ====================
  {
    model: 'iPhone 13 mini',
    type: 'iPhone',
    soc: 'A15 Bionic',
    gpu: { name: 'Apple A15 GPU (4-core)', cores: 4 },
    display: { logicalWidth: 375, logicalHeight: 812, physicalWidth: 1080, physicalHeight: 2340, dpr: 3 },
    os: 'iOS',
    weight: 2.0,
  },
  {
    model: 'iPhone 13',
    type: 'iPhone',
    soc: 'A15 Bionic',
    gpu: { name: 'Apple A15 GPU (4-core)', cores: 4 },
    display: { logicalWidth: 390, logicalHeight: 844, physicalWidth: 1170, physicalHeight: 2532, dpr: 3 },
    os: 'iOS',
    weight: 8.0,
  },
  {
    model: 'iPhone 13 Pro',
    type: 'iPhone',
    soc: 'A15 Bionic',
    gpu: { name: 'Apple A15 GPU (5-core)', cores: 5 },
    display: { logicalWidth: 390, logicalHeight: 844, physicalWidth: 1170, physicalHeight: 2532, dpr: 3 },
    os: 'iOS',
    weight: 6.5,
  },
  {
    model: 'iPhone 13 Pro Max',
    type: 'iPhone',
    soc: 'A15 Bionic',
    gpu: { name: 'Apple A15 GPU (5-core)', cores: 5 },
    display: { logicalWidth: 428, logicalHeight: 926, physicalWidth: 1284, physicalHeight: 2778, dpr: 3 },
    os: 'iOS',
    weight: 7.0,
  },

  // ==================== iPhone 14 系列 ====================
  {
    model: 'iPhone 14',
    type: 'iPhone',
    soc: 'A15 Bionic',
    gpu: { name: 'Apple A15 GPU (5-core)', cores: 5 },
    display: { logicalWidth: 390, logicalHeight: 844, physicalWidth: 1170, physicalHeight: 2532, dpr: 3 },
    os: 'iOS',
    weight: 10.0,
  },
  {
    model: 'iPhone 14 Plus',
    type: 'iPhone',
    soc: 'A15 Bionic',
    gpu: { name: 'Apple A15 GPU (5-core)', cores: 5 },
    display: { logicalWidth: 428, logicalHeight: 926, physicalWidth: 1284, physicalHeight: 2778, dpr: 3 },
    os: 'iOS',
    weight: 6.0,
  },
  {
    model: 'iPhone 14 Pro',
    type: 'iPhone',
    soc: 'A16 Bionic',
    gpu: { name: 'Apple A16 GPU (5-core)', cores: 5 },
    display: { logicalWidth: 393, logicalHeight: 852, physicalWidth: 1179, physicalHeight: 2556, dpr: 3 },
    os: 'iOS',
    weight: 8.5,
  },
  {
    model: 'iPhone 14 Pro Max',
    type: 'iPhone',
    soc: 'A16 Bionic',
    gpu: { name: 'Apple A16 GPU (5-core)', cores: 5 },
    display: { logicalWidth: 430, logicalHeight: 932, physicalWidth: 1290, physicalHeight: 2796, dpr: 3 },
    os: 'iOS',
    weight: 9.0,
  },

  // ==================== iPhone 15 系列 ====================
  {
    model: 'iPhone 15',
    type: 'iPhone',
    soc: 'A16 Bionic',
    gpu: { name: 'Apple A16 GPU (5-core)', cores: 5 },
    display: { logicalWidth: 393, logicalHeight: 852, physicalWidth: 1179, physicalHeight: 2556, dpr: 3 },
    os: 'iOS',
    weight: 12.0,
  },
  {
    model: 'iPhone 15 Plus',
    type: 'iPhone',
    soc: 'A16 Bionic',
    gpu: { name: 'Apple A16 GPU (5-core)', cores: 5 },
    display: { logicalWidth: 430, logicalHeight: 932, physicalWidth: 1290, physicalHeight: 2796, dpr: 3 },
    os: 'iOS',
    weight: 8.0,
  },
  {
    model: 'iPhone 15 Pro',
    type: 'iPhone',
    soc: 'A17 Pro',
    gpu: { name: 'Apple A17 Pro GPU', cores: 6 },
    display: { logicalWidth: 393, logicalHeight: 852, physicalWidth: 1179, physicalHeight: 2556, dpr: 3 },
    os: 'iOS',
    weight: 11.0,
  },
  {
    model: 'iPhone 15 Pro Max',
    type: 'iPhone',
    soc: 'A17 Pro',
    gpu: { name: 'Apple A17 Pro GPU', cores: 6 },
    display: { logicalWidth: 430, logicalHeight: 932, physicalWidth: 1290, physicalHeight: 2796, dpr: 3 },
    os: 'iOS',
    weight: 13.0,
  },

  // ==================== iPhone 16 系列 ====================
  {
    model: 'iPhone 16e',
    type: 'iPhone',
    soc: 'A18',
    gpu: { name: 'Apple A18 GPU (4-core)', cores: 4 },
    display: { logicalWidth: 390, logicalHeight: 844, physicalWidth: 1170, physicalHeight: 2532, dpr: 3 },
    os: 'iOS',
    weight: 5.0,
  },
  {
    model: 'iPhone 16',
    type: 'iPhone',
    soc: 'A18',
    gpu: { name: 'Apple A18 GPU (5-core)', cores: 5 },
    display: { logicalWidth: 393, logicalHeight: 852, physicalWidth: 1179, physicalHeight: 2556, dpr: 3 },
    os: 'iOS',
    weight: 10.0,
  },
  {
    model: 'iPhone 16 Plus',
    type: 'iPhone',
    soc: 'A18',
    gpu: { name: 'Apple A18 GPU (5-core)', cores: 5 },
    display: { logicalWidth: 430, logicalHeight: 932, physicalWidth: 1290, physicalHeight: 2796, dpr: 3 },
    os: 'iOS',
    weight: 6.0,
  },
  {
    model: 'iPhone 16 Pro',
    type: 'iPhone',
    soc: 'A18 Pro',
    gpu: { name: 'Apple A18 Pro GPU', cores: 6 },
    display: { logicalWidth: 402, logicalHeight: 874, physicalWidth: 1206, physicalHeight: 2622, dpr: 3 },
    os: 'iOS',
    weight: 9.0,
  },
  {
    model: 'iPhone 16 Pro Max',
    type: 'iPhone',
    soc: 'A18 Pro',
    gpu: { name: 'Apple A18 Pro GPU', cores: 6 },
    display: { logicalWidth: 440, logicalHeight: 956, physicalWidth: 1320, physicalHeight: 2868, dpr: 3 },
    os: 'iOS',
    weight: 11.0,
  },

  // ==================== iPhone 17 系列（未来设备） ====================
  {
    model: 'iPhone 17',
    type: 'iPhone',
    soc: 'A19',
    gpu: { name: 'Apple A19 GPU (5-core)', cores: 5 },
    display: { logicalWidth: 402, logicalHeight: 874, physicalWidth: 1206, physicalHeight: 2622, dpr: 3 },
    os: 'iOS',
    weight: 1.0, // 未来设备，权重较低
  },
  {
    model: 'iPhone Air (17 series)',
    type: 'iPhone',
    soc: 'A19 Pro',
    gpu: { name: 'Apple A19 Pro GPU (5-core)', cores: 5 },
    display: { logicalWidth: 420, logicalHeight: 912, physicalWidth: 1260, physicalHeight: 2736, dpr: 3 },
    os: 'iOS',
    weight: 0.5,
  },
  {
    model: 'iPhone 17 Pro',
    type: 'iPhone',
    soc: 'A19 Pro',
    gpu: { name: 'Apple A19 Pro GPU (6-core)', cores: 6 },
    display: { logicalWidth: 402, logicalHeight: 874, physicalWidth: 1206, physicalHeight: 2622, dpr: 3 },
    os: 'iOS',
    weight: 1.0,
  },
  {
    model: 'iPhone 17 Pro Max',
    type: 'iPhone',
    soc: 'A19 Pro',
    gpu: { name: 'Apple A19 Pro GPU (6-core)', cores: 6 },
    display: { logicalWidth: 440, logicalHeight: 956, physicalWidth: 1320, physicalHeight: 2868, dpr: 3 },
    os: 'iOS',
    weight: 1.0,
  },
];

/**
 * iPad 设备配置库
 */
export const IPAD_DEVICES: DeviceProfile[] = [
  {
    model: 'iPad (11th generation, A16)',
    type: 'iPad',
    soc: 'A16',
    gpu: { name: 'Apple A16 GPU (4-core)', cores: 4 },
    display: { logicalWidth: 810, logicalHeight: 1080, physicalWidth: 1640, physicalHeight: 2360, dpr: 2 },
    os: 'iPadOS',
    weight: 5.0,
  },
  {
    model: 'iPad Air 11-inch (M2)',
    type: 'iPad',
    soc: 'M2',
    gpu: { name: 'Apple M2 GPU', cores: 10 },
    display: { logicalWidth: 820, logicalHeight: 1180, physicalWidth: 1640, physicalHeight: 2360, dpr: 2 },
    os: 'iPadOS',
    weight: 6.0,
  },
  {
    model: 'iPad mini (7th generation)',
    type: 'iPad',
    soc: 'A17 Pro',
    gpu: { name: 'Apple A17 Pro GPU', cores: 6 },
    display: { logicalWidth: 744, logicalHeight: 1133, physicalWidth: 1488, physicalHeight: 2266, dpr: 2 },
    os: 'iPadOS',
    weight: 4.0,
  },
  {
    model: 'iPad Pro 11-inch (M4)',
    type: 'iPad',
    soc: 'M4',
    gpu: { name: 'Apple M4 GPU', cores: 10 },
    display: { logicalWidth: 834, logicalHeight: 1210, physicalWidth: 1668, physicalHeight: 2420, dpr: 2 },
    os: 'iPadOS',
    weight: 7.0,
  },
  {
    model: 'iPad Pro 13-inch (M4)',
    type: 'iPad',
    soc: 'M4',
    gpu: { name: 'Apple M4 GPU', cores: 10 },
    display: { logicalWidth: 1032, logicalHeight: 1376, physicalWidth: 2064, physicalHeight: 2752, dpr: 2 },
    os: 'iPadOS',
    weight: 8.0,
  },
];

/**
 * Android 设备配置库（高频设备）
 */
export const ANDROID_DEVICES: DeviceProfile[] = [
  // ==================== Google Pixel 系列 ====================
  {
    model: 'Pixel 8',
    type: 'Android',
    soc: 'Google Tensor G3',
    gpu: { name: 'Mali-G715', cores: 7 },
    display: { logicalWidth: 412, logicalHeight: 915, physicalWidth: 1080, physicalHeight: 2400, dpr: 2.625 },
    os: 'Android',
    weight: 5.0,
  },
  {
    model: 'Pixel 8 Pro',
    type: 'Android',
    soc: 'Google Tensor G3',
    gpu: { name: 'Mali-G715', cores: 7 },
    display: { logicalWidth: 448, logicalHeight: 992, physicalWidth: 1344, physicalHeight: 2992, dpr: 3 },
    os: 'Android',
    weight: 6.0,
  },
  {
    model: 'Pixel 7',
    type: 'Android',
    soc: 'Google Tensor G2',
    gpu: { name: 'Mali-G710', cores: 7 },
    display: { logicalWidth: 412, logicalHeight: 915, physicalWidth: 1080, physicalHeight: 2400, dpr: 2.625 },
    os: 'Android',
    weight: 4.0,
  },
  {
    model: 'Pixel 7 Pro',
    type: 'Android',
    soc: 'Google Tensor G2',
    gpu: { name: 'Mali-G710', cores: 7 },
    display: { logicalWidth: 448, logicalHeight: 992, physicalWidth: 1440, physicalHeight: 3120, dpr: 3.214 },
    os: 'Android',
    weight: 5.0,
  },

  // ==================== Samsung Galaxy S 系列 ====================
  {
    model: 'SM-S928B', // Galaxy S24 Ultra
    type: 'Android',
    soc: 'Snapdragon 8 Gen 3',
    gpu: { name: 'Adreno 750', cores: 1 },
    display: { logicalWidth: 480, logicalHeight: 1024, physicalWidth: 1440, physicalHeight: 3088, dpr: 3 },
    os: 'Android',
    weight: 10.0,
  },
  {
    model: 'SM-S918B', // Galaxy S24+
    type: 'Android',
    soc: 'Snapdragon 8 Gen 3',
    gpu: { name: 'Adreno 750', cores: 1 },
    display: { logicalWidth: 448, logicalHeight: 985, physicalWidth: 1440, physicalHeight: 3120, dpr: 3.214 },
    os: 'Android',
    weight: 8.0,
  },
  {
    model: 'SM-S908B', // Galaxy S22 Ultra
    type: 'Android',
    soc: 'Snapdragon 8 Gen 1',
    gpu: { name: 'Adreno 730', cores: 1 },
    display: { logicalWidth: 480, logicalHeight: 1023, physicalWidth: 1440, physicalHeight: 3088, dpr: 3 },
    os: 'Android',
    weight: 7.0,
  },
  {
    model: 'SM-S901B', // Galaxy S22
    type: 'Android',
    soc: 'Snapdragon 8 Gen 1',
    gpu: { name: 'Adreno 730', cores: 1 },
    display: { logicalWidth: 412, logicalHeight: 914, physicalWidth: 1080, physicalHeight: 2340, dpr: 2.625 },
    os: 'Android',
    weight: 6.0,
  },

  // ==================== OnePlus 系列 ====================
  {
    model: 'OnePlus 12',
    type: 'Android',
    soc: 'Snapdragon 8 Gen 3',
    gpu: { name: 'Adreno 750', cores: 1 },
    display: { logicalWidth: 450, logicalHeight: 1008, physicalWidth: 1440, physicalHeight: 3168, dpr: 3.2 },
    os: 'Android',
    weight: 5.0,
  },
  {
    model: 'OnePlus 11',
    type: 'Android',
    soc: 'Snapdragon 8 Gen 2',
    gpu: { name: 'Adreno 740', cores: 1 },
    display: { logicalWidth: 450, logicalHeight: 1008, physicalWidth: 1440, physicalHeight: 3216, dpr: 3.2 },
    os: 'Android',
    weight: 4.0,
  },

  // ==================== Xiaomi 系列 ====================
  {
    model: 'Xiaomi 14 Ultra',
    type: 'Android',
    soc: 'Snapdragon 8 Gen 3',
    gpu: { name: 'Adreno 750', cores: 1 },
    display: { logicalWidth: 480, logicalHeight: 1067, physicalWidth: 1440, physicalHeight: 3200, dpr: 3 },
    os: 'Android',
    weight: 6.0,
  },
  {
    model: 'Xiaomi 13 Pro',
    type: 'Android',
    soc: 'Snapdragon 8 Gen 2',
    gpu: { name: 'Adreno 740', cores: 1 },
    display: { logicalWidth: 480, logicalHeight: 1067, physicalWidth: 1440, physicalHeight: 3200, dpr: 3 },
    os: 'Android',
    weight: 5.0,
  },
];

/**
 * 所有设备配置（用于随机选择）
 */
export const ALL_MOBILE_DEVICES = [...IOS_DEVICES, ...IPAD_DEVICES, ...ANDROID_DEVICES];

/**
 * iOS 版本到 Safari 版本的映射
 */
export const IOS_TO_SAFARI_VERSION: Record<string, string> = {
  '18_2': '18.2',
  '18_1': '18.1',
  '18_0': '18.0',
  '17_7': '17.6',
  '17_6': '17.6',
  '17_5': '17.5',
  '17_4': '17.4',
  '17_3': '17.3',
  '17_2': '17.2',
  '17_1': '17.1',
  '17_0': '17.0',
  '16_7': '16.6',
  '16_6': '16.6',
  '16_5': '16.5',
  '16_4': '16.4',
  '16_3': '16.3',
  '16_2': '16.2',
  '16_1': '16.1',
  '16_0': '16.0',
  '15_8': '15.6',
  '15_7': '15.6',
  '15_6': '15.6',
};

/**
 * Android 版本到 Chrome 版本的映射（高频版本）
 */
export const ANDROID_CHROME_VERSIONS = [
  '131.0.6778.139',
  '131.0.6778.104',
  '130.0.6723.102',
  '130.0.6723.86',
  '129.0.6668.100',
  '129.0.6668.81',
  '128.0.6613.127',
];

