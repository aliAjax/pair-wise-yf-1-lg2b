/**
 * 样本档案层（store.js）
 * 只负责预约记录的存取与持久化（localStorage），不包含任何排期规则与页面逻辑。
 * 浏览器关闭/重开后仍可读取；无 localStorage 的环境（如 Node 测试）退化为内存存储。
 */
const Store = (() => {
  const KEY = 'centrifuge.reservations.v1';
  let seq = 0;

  const memory = (() => {
    let map = {};
    return {
      getItem: (k) => (k in map ? map[k] : null),
      setItem: (k, v) => { map[k] = String(v); },
    };
  })();
  const storage = typeof localStorage !== 'undefined' ? localStorage : memory;

  let reservations = load();

  function load() {
    try {
      const raw = storage.getItem(KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function persist() {
    storage.setItem(KEY, JSON.stringify(reservations));
  }

  return {
    /** 当前生效的预约 */
    scheduled() {
      return reservations.filter((r) => r.status === 'scheduled');
    },

    /** 已取消等历史档案 */
    archived() {
      return reservations.filter((r) => r.status !== 'scheduled');
    },

    add(booking) {
      reservations.push(booking);
      persist();
    },

    update(id, patch) {
      const r = reservations.find((x) => x.id === id);
      if (r) {
        Object.assign(r, patch);
        persist();
      }
    },

    cancel(id) {
      const r = reservations.find((x) => x.id === id);
      if (r) {
        r.status = 'cancelled';
        r.cancelledAt = Date.now();
        persist();
      }
    },

    nextId() {
      seq += 1;
      return 'B' + Date.now().toString(36) + seq.toString(36);
    },
  };
})();

if (typeof module !== 'undefined') module.exports = Store;
