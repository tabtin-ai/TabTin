/**
 * 基础测试：验证 HTTP 引擎核心能力
 *
 * 这个测试将：
 * 1. 初始化 HTTPEngine
 * 2. 抓取一个简单网页
 * 3. 输出 AccessResult 摘要
 */

import { HTTPEngine } from '../src/index.js';

async function basicTest() {
  console.log('🚀 开始 HTTP 引擎基础测试...\n');

  const engine = new HTTPEngine();

  try {
    // 1. 初始化引擎
    console.log('📦 初始化 HTTPEngine...');
    await engine.initialize({ timeout: 30000 });
    console.log('✅ 引擎初始化完成\n');

    // 2. 抓取网页
    console.log('🌐 抓取测试网页...');
    const result = await engine.scrape('https://example.com');
    console.log('✅ 抓取完成\n');

    // 3. 输出摘要
    const primaryPayload = result.payloads.find(payload => payload.primary);

    console.log('📊 抓取结果摘要');
    console.log(`- 状态码: ${result.response.statusCode}`);
    console.log(`- 最终 URL: ${result.response.finalUrl}`);
    console.log(`- 载荷数量: ${result.payloads.length}`);
    console.log(`- 主载荷类型: ${primaryPayload?.type ?? 'unknown'}`);
    console.log(`- 耗时: ${result.response.loadTime}ms`);

    return true;
  } catch (error) {
    console.error('❌ 测试失败:', error);
    throw error;
  } finally {
    // 4. 清理
    try {
      await engine.shutdown();
      console.log('\n🧹 引擎已关闭');
    } catch (error) {
      console.warn('⚠️ 关闭引擎失败（可忽略）:', error);
    }
  }
}

basicTest()
  .then(() => {
    console.log('\n✅ 所有测试完成');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ 测试失败:', error);
    process.exit(1);
  });
