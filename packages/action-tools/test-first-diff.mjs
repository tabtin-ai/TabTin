/**
 * 测试：第一次 execute_act 是否返回 diff
 */

import { AriaTreeDiffer } from './dist/utils/AriaTreeDiffer.js';

console.log('\n🔍 测试：第一次 execute_act 返回 diff\n');

// 模拟操作前快照（页面初始状态）
const preActionSnapshot = {
  ariaTree: `[1-1] RootWebArea: 测试页面
  [1-2] main
    [1-3] heading: 标题
    [1-4] button: 阅读全文 [展开]`,
  xpathMap: {
    '1-1': '/',
    '1-2': '/html[1]/body[1]/main[1]',
    '1-3': '/html[1]/body[1]/main[1]/h1[1]',
    '1-4': '/html[1]/body[1]/main[1]/button[1]'
  }
};

// 模拟操作后快照（点击"阅读全文"按钮后）
const postActionSnapshot = {
  ariaTree: `[1-1] RootWebArea: 测试页面
  [1-2] main
    [1-3] heading: 标题
    [1-5] paragraph: 这是展开的第一段文本
    [1-6] paragraph: 这是展开的第二段文本
    [1-7] button: 收起 [收起]`,
  xpathMap: {
    '1-1': '/',
    '1-2': '/html[1]/body[1]/main[1]',
    '1-3': '/html[1]/body[1]/main[1]/h1[1]',
    '1-5': '/html[1]/body[1]/main[1]/p[1]',
    '1-6': '/html[1]/body[1]/main[1]/p[2]',
    '1-7': '/html[1]/body[1]/main[1]/button[1]'
  }
};

// 计算 diff（使用操作前快照作为基准）
const diff = AriaTreeDiffer.computeLocalDiff(
  preActionSnapshot,
  postActionSnapshot,
  'xpath=/html[1]/body[1]/main[1]/button[1]', // 目标元素
  5 // 上下文半径
);

// 输出结果
console.log('✅ Diff 计算成功！');
console.log('\n📊 变化统计：');
console.log('  hasChanges:', diff.hasChanges);
console.log('  addedCount:', diff.addedCount);
console.log('  removedCount:', diff.removedCount);

console.log('\n🔴 消失的元素：');
console.log('  removed 数组长度:', diff.removed?.length || 0);
if (diff.removed && diff.removed.length > 0) {
  diff.removed.forEach((el, i) => {
    console.log(`  [${i}] ${el.role}: ${el.name}`);
  });
}

console.log('\n🟢 新增的元素：');
console.log('  added 数组长度:', diff.added?.length || 0);
if (diff.added && diff.added.length > 0) {
  diff.added.forEach((el, i) => {
    console.log(`  [${i}] ${el.role}: ${el.name}`);
  });
}

console.log('\n📝 摘要：');
console.log(diff.summary);

// 验证序列化
console.log('\n🔒 序列化测试：');
const serialized = JSON.parse(JSON.stringify(diff));
console.log('  序列化后 added:', serialized.added?.length);
console.log('  序列化后 removed:', serialized.removed?.length);

// 断言
const passed =
  diff.hasChanges === true &&
  diff.addedCount > 0 &&
  diff.removedCount > 0 &&
  Array.isArray(diff.added) &&
  Array.isArray(diff.removed) &&
  diff.removed.some(el => el.name.includes('阅读全文')) &&
  diff.added.some(el => el.role === 'paragraph') &&
  serialized.added?.length === diff.added?.length &&
  serialized.removed?.length === diff.removed?.length;

if (passed) {
  console.log('\n✅ 所有断言通过！第一次 execute_act 可以正确返回 diff');
  process.exit(0);
} else {
  console.error('\n❌ 测试失败！');
  process.exit(1);
}
