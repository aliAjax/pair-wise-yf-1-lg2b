/* Node 逻辑测试：stub window/localStorage 后加载 archive.js 与 scheduler.js */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const store = {};
const sandbox = {
  console,
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  },
};
sandbox.window = sandbox;
vm.createContext(sandbox);

vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js/archive.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js/scheduler.js'), 'utf8'), sandbox);

const S = sandbox.Scheduler;
const Arc = sandbox.Archive;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra !== undefined ? '=> ' + JSON.stringify(extra) : ''); }
}
function at(h, m = 0, day = 0) {
  const d = new Date(2026, 8, 25 + day, h, m, 0, 0);
  return d.getTime();
}
const mk = (o) => Object.assign({
  id: Arc.genId(), sampleCode: 'X', owner: 'u', note: '',
  tubes: 10, duration: 30, priority: 'normal',
  machineId: 'M1', rotorId: 'RA',
  start: at(9), end: at(9, 30), deadline: at(12),
  moved: false, createdAt: 0,
}, o);
const draft = (o) => Object.assign({
  sampleCode: 'S999', owner: '测试员', note: '',
  tubes: 10, duration: 30, priority: 'normal',
  start: at(9), deadline: at(12),
}, o);

/* 成单后不变量：重叠时段内，机器、转子、登记人均不得重复 */
function findClash(list) {
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (S.overlaps(a.start, a.end, b.start, b.end) &&
        (a.machineId === b.machineId || a.rotorId === b.rotorId || a.owner === b.owner)) {
        return { a: a.sampleCode, b: b.sampleCode };
      }
    }
  }
  return null;
}
function finalList(r) { return r.sim.concat(r.booking); }

/* 1. 空机位直接排入，10管可选四机位，取第一个 M1/RA */
let r = S.planBooking(draft({ start: at(8), deadline: at(12) }), []);
ok('空闲机位：直接成功', r.ok);
ok('空闲机位：落在 M1/RA', r.ok && r.booking.machineId === 'M1' && r.booking.rotorId === 'RA');

/* 2. 管数校验 */
r = S.planBooking(draft({ tubes: 49 }), []);
ok('49管：超过最大容量拒绝', !r.ok && r.code === 'TUBE_OVER_MAX', r);
r = S.planBooking(draft({ tubes: 30, start: at(8) }), []);
ok('30管：只用 RA，候选为1、2号机', r.ok && r.booking.rotorId === 'RA' && ['M1', 'M2'].includes(r.booking.machineId));

/* 3. 期限与营业时段 */
r = S.planBooking(draft({ start: at(11, 30), duration: 60, deadline: at(12) }), []);
ok('完成时刻晚于期限：拒绝', !r.ok && r.code === 'DEADLINE_TOO_EARLY', r.code);
r = S.planBooking(draft({ start: at(21, 45), duration: 30, deadline: at(23) }), []);
ok('超出22:00营业结束：拒绝', !r.ok && r.code === 'OUTSIDE_HOURS', r.code);
r = S.planBooking(draft({ start: at(7, 30), deadline: at(12) }), []);
ok('早于08:00营业开始：拒绝', !r.ok && r.code === 'OUTSIDE_HOURS', r.code);

/* 4. 普通预约遇到占用：
   4a. 小管量可改用另一只转子的机器；4b. 大管量共享转子被占则无兼容机位 */
r = S.planBooking(draft({ tubes: 10, start: at(9), duration: 60, deadline: at(13) }),
  [mk({ owner: '甲', machineId: 'M1', start: at(9), end: at(10, 30) })]);
ok('4a 普通预约：M1的A转子占用，10管自动落到 B转子机位（3或4号机）',
  r.ok && r.booking.rotorId === 'RB' && ['M3', 'M4'].includes(r.booking.machineId),
  r.booking && `${r.booking.machineId}/${r.booking.rotorId}`);
r = S.planBooking(draft({ tubes: 30, start: at(9), duration: 60, deadline: at(13) }),
  [mk({ owner: '甲', machineId: 'M1', start: at(9), end: at(10, 30) })]);
ok('4b 普通预约：30管只能用A转子，M1正在用→2号机同刻也不能串用该转子：拒绝',
  !r.ok && r.code === 'OCCUPIED', r.code);

/* 5. 同转子不同机也算冲突（共享转子不可同时用） */
r = S.planBooking(draft({ tubes: 30, start: at(9), duration: 60, deadline: at(13) }), [
  mk({ owner: '甲', machineId: 'M1', start: at(9), end: at(10) }),
  mk({ id: Arc.genId(), owner: '丙', machineId: 'M2', start: at(9), end: at(10) }),
]);
ok('两只A转子机位（1、2号机）同刻都被占：普通预约拒绝', !r.ok && r.code === 'OCCUPIED', r.code);
ok('冲突清单含两笔预约', !r.ok && r.conflicts.length === 2, r.conflicts.map(c => c.booking.machineId));

/* 6. 同一人不能同时占两台机（即使机位完全不同） */
r = S.planBooking(draft({ owner: '张三', tubes: 5, start: at(9), duration: 30, deadline: at(12) }),
  [mk({ owner: '张三', machineId: 'M3', rotorId: 'RB', start: at(9, 15), end: at(9, 45) })]);
ok('同一人时间重叠：OWNER_CLASH 拒绝', !r.ok && r.code === 'OWNER_CLASH', r.code);

/* 7. 急样顶普通预约成功：同刻换到另一台兼容机 */
const victim = mk({ sampleCode: 'V1', owner: '甲', tubes: 30, duration: 30,
  machineId: 'M1', start: at(14), end: at(14, 30), deadline: at(15) });
r = S.planBooking(draft({ sampleCode: 'URG1', owner: '乙', tubes: 30, duration: 30,
  priority: 'urgent', start: at(14), deadline: at(14, 30) }), [victim]);
ok('急样顶换：成功', r.ok, r.message);
ok('急样落入被顶机位 M1/RA', r.ok && r.booking.machineId === 'M1');
ok('被顶预约顺延到 M2/RA 14:30–15:00（同刻换机腾不出共享转子），仍早于15:00期限',
  r.ok && r.relocated[0].to.machineId === 'M2' &&
  r.relocated[0].to.start === at(14, 30) && r.relocated[0].to.end === at(15),
  r.ok ? r.relocated[0].to : r.message);
ok('sim 中被顶预约带 moved 与 movedFrom', r.ok && r.sim.find(b => b.id === victim.id).moved === true);
ok('成单后全表无机器/转子/人员重叠', r.ok && findClash(finalList(r)) === null);

/* 8. 急样顶换：被顶者可换用小转子到3、4号机 */
const victim2 = mk({ sampleCode: 'V2', owner: '甲', tubes: 20, duration: 30,
  machineId: 'M1', start: at(14), end: at(14, 30), deadline: at(16) });
const raBusy = mk({ sampleCode: 'O2', owner: '丙', tubes: 30, duration: 60,
  machineId: 'M2', start: at(14), end: at(15), deadline: at(16) });
r = S.planBooking(draft({ sampleCode: 'URG2', owner: '乙', tubes: 30,
  priority: 'urgent', start: at(14), duration: 30, deadline: at(14, 30) }), [victim2, raBusy]);
ok('顶换：RA另一台被占时，20管被顶者可带 B转子换到3、4号机',
  r.ok && r.relocated[0].to.rotorId === 'RB' &&
  ['M3', 'M4'].includes(r.relocated[0].to.machineId) && r.relocated[0].to.start === at(14),
  r.ok ? r.relocated : r.message);
ok('成单后全表无机器/转子/人员重叠（含被连锁顺延的大管量预约）',
  r.ok && findClash(finalList(r)) === null, r.ok ? findClash(finalList(r)) : r.message);
ok('所有被顶预约结束时刻仍早于各自期限',
  r.ok && r.sim.filter(b => b.moved).every(b => b.end <= b.deadline));

/* 9. 顶换失败：两笔大管量预约占死1、2号机，且改排会错过期限 → 原样保留 */
const b1 = mk({ sampleCode: 'B1', owner: '甲', tubes: 30, duration: 30,
  machineId: 'M1', start: at(14), end: at(14, 30), deadline: at(14, 45) });
const b2 = mk({ sampleCode: 'B2', owner: '丙', tubes: 40, duration: 60,
  machineId: 'M2', start: at(14), end: at(15), deadline: at(16) });
const before = JSON.stringify([b1, b2]);
r = S.planBooking(draft({ sampleCode: 'URG3', owner: '乙', tubes: 30,
  priority: 'urgent', start: at(14), duration: 30, deadline: at(14, 30) }), [b1, b2]);
ok('无法在期限内换机：RELOCATE_FAILED', !r.ok && r.code === 'RELOCATE_FAILED', r.code);
ok('失败时输入数据原样未动（事务回滚）', JSON.stringify([b1, b2]) === before);
ok('冲突说明标记 RELOCATE_FAILED', !r.ok && r.conflicts.every(c => c.reason === 'RELOCATE_FAILED'),
  r.conflicts.map(c => c.reason));

/* 10. 急样不能顶急样 */
const exUrg = mk({ sampleCode: 'EU', priority: 'urgent', tubes: 30,
  machineId: 'M1', start: at(14), end: at(14, 30), deadline: at(15) });
const exUrg2 = mk({ sampleCode: 'EU2', priority: 'urgent', tubes: 40,
  machineId: 'M2', start: at(14, 30), end: at(15), deadline: at(16) });
r = S.planBooking(draft({ sampleCode: 'URG4', owner: '乙', tubes: 30,
  priority: 'urgent', start: at(14), duration: 30, deadline: at(14, 30) }), [exUrg]);
ok('被急样占据：URGENT_BLOCKED', !r.ok && r.code === 'URGENT_BLOCKED', r.code);
// M1 整段急样，M2 尾部被急样占：被顶普通无位 → 仍拒绝且不改单
const norm = mk({ sampleCode: 'N1', owner: '丁', tubes: 30, machineId: 'M2',
  start: at(14), end: at(14, 30), deadline: at(14, 30) });
r = S.planBooking(draft({ sampleCode: 'URG5', owner: '乙', tubes: 30,
  priority: 'urgent', start: at(14), duration: 30, deadline: at(14, 30) }), [exUrg, norm, exUrg2]);
ok('一个机位被急样占死、另一机位改排会与急样撞：整体拒绝',
  !r.ok && (r.code === 'URGENT_BLOCKED' || r.code === 'RELOCATE_FAILED'), r.code);

/* 11. 改排可以顺延：原刻另一台机器被占 → 按15分钟刻度找期限内最早空档 */
const holder2 = mk({ sampleCode: 'H2', owner: '己', tubes: 30, duration: 60,
  machineId: 'M2', start: at(14), end: at(15), deadline: at(16) });
const loose2 = mk({ sampleCode: 'L2', owner: '庚', tubes: 30, duration: 30,
  machineId: 'M1', start: at(14), end: at(14, 30), deadline: at(16) });
let rel = S.findRelocation(loose2, [loose2, holder2]);
ok('findRelocation：M2 14点被占 → 顺延到 15:00–15:30，且在期限内',
  rel && rel.machineId === 'M2' && rel.start === at(15) && rel.end === at(15, 30), rel);
const tight = mk({ sampleCode: 'T1', owner: '辛', tubes: 30, duration: 30,
  machineId: 'M1', start: at(14), end: at(14, 30), deadline: at(14, 45) });
rel = S.findRelocation(tight, [tight, holder2]);
ok('findRelocation：顺延会错过期限 → 返回 null', rel === null, rel);

/* 11b. 连锁顶换：同刻两笔挡单共用一只转子，需连锁顺延才能腾出 */
const chain = [
  mk({ sampleCode: 'H3', owner: '己', tubes: 30, machineId: 'M2', start: at(14), end: at(15), deadline: at(17) }),
  mk({ sampleCode: 'L3', owner: '庚', tubes: 30, machineId: 'M1', start: at(14), end: at(14, 30), deadline: at(17) }),
  mk({ sampleCode: 'X3', owner: '壬', tubes: 10, machineId: 'M3', rotorId: 'RB', start: at(14, 30), end: at(15, 30), deadline: at(17) }),
];
r = S.planBooking(draft({ sampleCode: 'URG7', owner: '乙', tubes: 30,
  priority: 'urgent', start: at(14), duration: 30, deadline: at(14, 30) }), chain);
ok('连锁顶换：成功且成单后全表机器/转子/人员均无重叠',
  r.ok && findClash(finalList(r)) === null, r.ok ? findClash(finalList(r)) : r.message);
if (r.ok) {
  ok('连锁顶换：被顶各单结束时刻仍早于各自期限',
    r.sim.filter(b => b.moved).every(b => b.end <= b.deadline));
  const movedIds = r.relocated.map(x => x.id);
  ok('连锁顶换：两笔挡单都被改排（说明确实做了连锁调整）', movedIds.length === 2, movedIds);
}

/* 12. 边界：结束时刻 == 期限 允许；首尾相接不重叠 */
const touch = mk({ machineId: 'M1', start: at(9), end: at(9, 30), tubes: 10, rotorId: 'RA' });
r = S.planBooking(draft({ start: at(9, 30), duration: 30, deadline: at(10) }), [touch]);
ok('首尾相接（9:30）不算重叠；结束恰等于期限允许',
  r.ok && r.booking.start === at(9, 30), r.message);

/* 13. 存档层往返 */
Arc.clearAll();
Arc.add(mk({ sampleCode: 'PERSIST-1' }));
ok('档案持久化往返：localStorage 可读出', Arc.getById(Arc.getAll()[0].id).sampleCode === 'PERSIST-1');
ok('演示数据为 5 笔', Arc.seedDemo().length === 5 && Arc.getAll().length === 5);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
