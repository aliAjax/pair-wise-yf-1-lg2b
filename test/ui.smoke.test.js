/* 页面层冒烟测试：极简 DOM 桩 + 真实 archive/scheduler/app 三个文件 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const store = {};
const elements = {};
function makeEl(id) {
  return {
    id,
    value: '',
    textContent: '',
    className: '',
    innerHTML: '',
    dataset: {},
    style: {},
    _handlers: {},
    addEventListener(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    remove() {},
    fire(ev, arg) { (this._handlers[ev] || []).forEach((fn) => fn(arg || { preventDefault() {} })); },
  };
}
function el(id) { return elements[id] || (elements[id] = makeEl(id)); }

const sandbox = {
  console,
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  },
  confirm: () => true,
  document: {
    getElementById: el,
    addEventListener(ev, fn) { if (ev === 'DOMContentLoaded') fn(); },
  },
};
sandbox.window = sandbox;
vm.createContext(sandbox);

['js/archive.js', 'js/scheduler.js', 'js/app.js'].forEach((f) => {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox);
});

const Arc = sandbox.Archive;
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra !== undefined ? '=> ' + String(extra).slice(0, 300) : ''); }
}

/* 1. 初始化：自动播种演示数据并渲染 */
ok('初始化播种 5 笔演示预约', Arc.getAll().length === 5);
ok('时间轴渲染出机器与转子泳道', /1号机/.test(el('timeline').innerHTML) && /A转子/.test(el('timeline').innerHTML));
ok('时间轴包含演示样本 S-101', el('timeline').innerHTML.includes('S-101'));
ok('当日清单渲染 5 条', (el('dayList').innerHTML.match(/day-item/g) || []).length === 5);
ok('资源摘要渲染四台机器', (el('resourceSummary').innerHTML.match(/号机/g) || []).length >= 4);

/* 2. 表单提交：急样顶换（S-105 今天 14:00–14:30 占 M1/RA，20管） */
function todayAt(h, m) {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
el('f_sampleCode').value = 'S-106';
el('f_owner').value = '孙强';
el('f_tubes').value = '30';
el('f_duration').value = '30';
el('f_start').value = todayAt(14, 0);
el('f_deadline').value = todayAt(14, 30);
el('f_priority').value = 'urgent';
el('bookingForm').fire('submit');

ok('急样提交成功', el('banner').innerHTML.includes('急样已排入'), el('banner').innerHTML);
ok('顶换说明点名被顶的 S-105', el('banner').innerHTML.includes('S-105'), el('banner').innerHTML);
ok('档案变为 6 笔', Arc.getAll().length === 6);
ok('S-105 被标记为改排且换到 B转子机位', (() => {
  const s105 = Arc.getAll().find((b) => b.sampleCode === 'S-105');
  return s105 && s105.moved === true && s105.rotorId === 'RB';
})());
ok('时间轴出现 S-106', el('timeline').innerHTML.includes('S-106'));
ok('详情卡展示选中的新预约', el('detailBody').innerHTML.includes('S-106') && el('detailBody').innerHTML.includes('取消该预约'));

/* 3. 表单提交：超容量拒绝 */
el('f_sampleCode').value = 'S-107';
el('f_tubes').value = '60';
el('f_priority').value = 'normal';
el('bookingForm').fire('submit');
ok('60管被拒绝并提示容量', el('banner').innerHTML.includes('超过最大转子容量'), el('banner').innerHTML);
ok('档案仍是 6 笔（未写入）', Arc.getAll().length === 6);

/* 4. 急样顶换失败：S-101(40管,M1,9-10点,期限12:00) + S-103(30管,M2,10-10:45,期限13:00)
   急样 30管 9:00–10:00：两机位挡单都只能顺延到 10:00 之后，
   S-101 顺延 60 分钟将 11:00 结束（≤12:00 可行）…… 但 S-103 也占 RA 到 10:45，
   实际上这里验证“普通预约同时段被本人占用”更直接： */
el('f_sampleCode').value = 'S-108';
el('f_owner').value = '张磊'; // 与 S-101 同一人
el('f_tubes').value = '10';
el('f_duration').value = '30';
el('f_start').value = todayAt(9, 15);
el('f_deadline').value = todayAt(12, 0);
el('f_priority').value = 'urgent';
el('bookingForm').fire('submit');
ok('急样与本人已有预约重叠：拒绝且提示同一人冲突', el('banner').innerHTML.includes('同一人'), el('banner').innerHTML);
ok('档案仍是 6 笔', Arc.getAll().length === 6);

/* 5. 日期翻页 */
const before = el('datePicker').value;
el('btnNextDay').fire('click');
ok('后一天翻页生效', el('datePicker').value !== before && el('timeline').innerHTML.includes('暂无预约'));

/* 6. 重置演示数据 */
el('btnResetDemo').fire('click');
ok('重置后回到 5 笔演示数据', Arc.getAll().length === 5);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
