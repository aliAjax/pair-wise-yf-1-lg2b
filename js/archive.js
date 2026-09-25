'use strict';
/*
 * archive.js —— 样本档案层
 * 职责：本机持久化（localStorage）、预约记录的增删查、资源字典。
 * 不包含任何“时段是否冲突 / 急样能否顶换”的判断（那些在 scheduler.js）。
 */
(function (global) {

  const STORE_KEY = 'centrifuge-bookings-v1';

  /* 排期粒度与营业时段（分钟） */
  const SLOT_MINUTES = 15;
  const OPEN_MINUTE = 8 * 60;    // 08:00
  const CLOSE_MINUTE = 22 * 60;  // 22:00

  /*
   * 资源字典：
   * 四台机器；两只转子。
   * R-A（48 孔）只能装 1、2 号机；R-B（24 孔）只能装 3、4 号机。
   * 管数 >24 只能用 R-A；≤24 两只转子均可（由排期层选择）。
   */
  const MACHINES = [
    { id: 'M1', name: '1号机', rotorId: 'RA' },
    { id: 'M2', name: '2号机', rotorId: 'RA' },
    { id: 'M3', name: '3号机', rotorId: 'RB' },
    { id: 'M4', name: '4号机', rotorId: 'RB' },
  ];

  const ROTORS = [
    { id: 'RA', name: 'A转子', capacity: 48, machineIds: ['M1', 'M2'] },
    { id: 'RB', name: 'B转子', capacity: 24, machineIds: ['M3', 'M4'] },
  ];

  function getAll() {
    try {
      const raw = global.localStorage.getItem(STORE_KEY);
      if (!raw) return [];
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data : [];
    } catch (err) {
      console.warn('档案读取失败，按空档案处理：', err);
      return [];
    }
  }

  function saveAll(bookings) {
    global.localStorage.setItem(STORE_KEY, JSON.stringify(bookings));
  }

  function add(booking) {
    const bookings = getAll();
    bookings.push(booking);
    saveAll(bookings);
    return booking;
  }

  /** 整表替换（排期层返回“新建 + 多条改排”的事务结果后使用） */
  function replaceAll(bookings) {
    saveAll(bookings.slice());
  }

  function remove(id) {
    const bookings = getAll().filter((b) => b.id !== id);
    saveAll(bookings);
    return bookings;
  }

  function getById(id) {
    return getAll().find((b) => b.id === id) || null;
  }

  function clearAll() {
    saveAll([]);
  }

  /* ---------------- 演示数据 ---------------- */

  function seedDemo() {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    const at = (h, m) => day.getTime() + h * 3600000 + m * 60000;

    const demo = [
      {
        id: genId(),
        sampleCode: 'S-101', owner: '张磊', note: '日常批次',
        tubes: 40, duration: 60, priority: 'normal',
        machineId: 'M1', rotorId: 'RA',
        start: at(9, 0), end: at(10, 0), deadline: at(12, 0),
        moved: false, createdAt: Date.now(),
      },
      {
        id: genId(),
        sampleCode: 'S-102', owner: '李娜', note: '',
        tubes: 12, duration: 30, priority: 'normal',
        machineId: 'M3', rotorId: 'RB',
        start: at(9, 30), end: at(10, 0), deadline: at(11, 0),
        moved: false, createdAt: Date.now(),
      },
      {
        id: genId(),
        sampleCode: 'S-103', owner: '王敏', note: '',
        tubes: 30, duration: 45, priority: 'normal',
        machineId: 'M2', rotorId: 'RA',
        start: at(10, 0), end: at(10, 45), deadline: at(13, 0),
        moved: false, createdAt: Date.now(),
      },
      {
        id: genId(),
        sampleCode: 'S-104', owner: '陈杰', note: '',
        tubes: 8, duration: 45, priority: 'normal',
        machineId: 'M4', rotorId: 'RB',
        start: at(13, 0), end: at(13, 45), deadline: at(16, 0),
        moved: false, createdAt: Date.now(),
      },
      {
        id: genId(),
        sampleCode: 'S-105', owner: '赵晴', note: '可用于顶换演练：此刻 RA 被占用',
        tubes: 20, duration: 30, priority: 'normal',
        machineId: 'M1', rotorId: 'RA',
        start: at(14, 0), end: at(14, 30), deadline: at(15, 0),
        moved: false, createdAt: Date.now(),
      },
    ];

    saveAll(demo);
    return demo;
  }

  function genId() {
    return 'BK' + Date.now().toString(36).toUpperCase() +
      Math.random().toString(36).slice(2, 6).toUpperCase();
  }

  function isEmpty() {
    return getAll().length === 0;
  }

  global.Archive = {
    STORE_KEY,
    SLOT_MINUTES, OPEN_MINUTE, CLOSE_MINUTE,
    MACHINES, ROTORS,
    getAll, saveAll, add, replaceAll, remove, getById, clearAll,
    seedDemo, genId, isEmpty,
  };

})(window);
