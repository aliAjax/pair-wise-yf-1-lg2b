/**
 * 排期规则测试（Node 直接运行：node test/scheduler.test.js）
 * Store 在无 localStorage 时自动退化为内存存储，可直接测。
 */
const Store = require('../js/store.js');
const Scheduler = require('../js/scheduler.js');

const H = 3600000;
const M = 60000;
const now = Date.now();

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.error('  ✗', name, extra || ''); }
}

function book(overrides) {
  return Object.assign({
    sampleName: '样本', owner: '测试员', tubes: 6, minutes: 30,
    priority: 'normal',
    startMs: now + H,
    deadlineMs: now + 8 * H,
  }, overrides);
}

// ---------- 1. 容量拒绝 ----------
console.log('1. 管数超过转子容量');
let r = Scheduler.schedule(Store, book({ tubes: 25 }));
check('25 管被拒绝', !r.ok && r.reason === 'capacity');
check('拒绝后无预约产生', Store.scheduled().length === 0);

// ---------- 2. 基本排期 + 资源不重叠 ----------
console.log('2. 基本排期与资源互斥');
r = Scheduler.schedule(Store, book({ sampleName: 'S1', tubes: 20 }));
check('20 管排上（只能用转子 A）', r.ok && r.booking.rotorId === 'RA');
const s1 = r.booking;

// 同时段再约：转子 A 被占，转子 B 容量 12 可用，但同机 M1 冲突 → 应落到别的机
r = Scheduler.schedule(Store, book({ sampleName: 'S2', tubes: 10 }));
check('10 管同时段排上', r.ok);
check('S2 与 S1 不同机或不同转子',
  r.booking.machineId !== s1.machineId && r.booking.rotorId !== s1.rotorId);
check('S2 用转子 B', r.booking.rotorId === 'RB');

// 第三单同时段：两只转子都被占 → 只能往后排
r = Scheduler.schedule(Store, book({ sampleName: 'S3', tubes: 6 }));
check('S3 排上但不与 S1/S2 同时段', r.ok && r.booking.start >= s1.end);

// ---------- 3. 期限太紧 ----------
console.log('3. 期限约束');
r = Scheduler.schedule(Store, book({
  sampleName: 'S4', startMs: now + H, deadlineMs: now + H + 10 * M, minutes: 30,
}));
check('期限容纳不下时长被拒绝', !r.ok && r.reason === 'deadline-too-tight');

// ---------- 4. 急样顶位 + 被顶者改期 ----------
console.log('4. 急样顶位');
// 构造：T 起一小时内两只转子都被普通预约占满
const T = now + 2 * H;
const n1 = Scheduler.schedule(Store, book({ sampleName: 'N1', tubes: 24, minutes: 60, startMs: T, deadlineMs: T + 6 * H }));
const n2 = Scheduler.schedule(Store, book({ sampleName: 'N2', tubes: 12, minutes: 60, startMs: T, deadlineMs: T + 6 * H }));
check('两个普通预约占满 T 时段', n1.ok && n2.ok && n1.booking.start === T && n2.booking.start === T);

// 普通预约此时插不进 T
const n3 = Scheduler.schedule(Store, book({ sampleName: 'N3', tubes: 6, startMs: T, deadlineMs: T + 30 * M }));
check('普通预约在 T 时段排不进', !n3.ok || n3.booking.start >= T + 30 * M);

// 急样顶位（期限卡死在 T 起一小时，无空位可躲，只能顶）
const u1 = Scheduler.schedule(Store, book({
  sampleName: 'U1', tubes: 6, priority: 'urgent', startMs: T, deadlineMs: T + H,
}));
check('急样顶位成功', u1.ok && u1.booking.start === T);
check('有被顶改期记录', u1.moves.length >= 1);

// 被顶者改期后仍满足各自期限，且与所有人不冲突
const all = Store.scheduled();
const moved = all.filter((b) => u1.moves.some((mv) => mv.id === b.id));
check('被顶者均改期且赶上期限', moved.every((b) => b.end <= b.deadline));
let conflictFree = true;
for (let i = 0; i < all.length; i++) {
  for (let j = i + 1; j < all.length; j++) {
    const a = all[i], b = all[j];
    if ((a.machineId === b.machineId || a.rotorId === b.rotorId) &&
        Scheduler.overlaps(a.start, a.end, b.start, b.end)) {
      conflictFree = false;
    }
  }
}
check('改期后全表无机台/转子时段重叠', conflictFree);

// ---------- 5. 急样撞急样：原样保留并指出冲突 ----------
console.log('5. 急样无法顶位时原样保留');
// 用两只转子在 T' 时段各排一个急样，窗口内无空隙
const T2 = now + 5 * H;
const ua = Scheduler.schedule(Store, book({
  sampleName: 'UA', tubes: 24, priority: 'urgent', minutes: 60,
  startMs: T2, deadlineMs: T2 + 2 * H,
}));
const ub = Scheduler.schedule(Store, book({
  sampleName: 'UB', tubes: 12, priority: 'urgent', minutes: 60,
  startMs: T2, deadlineMs: T2 + 2 * H,
}));
check('两个急样占满 T2 起一小时', ua.ok && ub.ok && ua.booking.start === T2 && ub.booking.start === T2);

const before = JSON.stringify(Store.scheduled());
const uc = Scheduler.schedule(Store, book({
  sampleName: 'UC', tubes: 6, priority: 'urgent', minutes: 30,
  startMs: T2, deadlineMs: T2 + 30 * M, // 期限卡死，只能挤 T2 这一小时
}));
check('新急样被拒绝并报告冲突', !uc.ok && uc.reason === 'conflict' && uc.blockers.length >= 1);
check('所有原预约原样保留', JSON.stringify(Store.scheduled()) === before);

// ---------- 6. 取消 ----------
console.log('6. 取消预约');
const victim = Store.scheduled()[0];
Store.cancel(victim.id);
check('取消后不再出现在生效列表', Store.scheduled().every((b) => b.id !== victim.id));
check('取消记录留在档案', Store.archived().some((b) => b.id === victim.id));

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
