'use strict';
/*
 * scheduler.js —— 排期判断层（纯逻辑）
 * 职责：
 *   1. 管数 / 容量 / 营业时段 / 期限 校验
 *   2. 机器与转子的时段重叠判断（同一人也不得同时占两台机）
 *   3. 急样顶换：只可顶普通预约；被顶预约必须能换到兼容机器（含所需转子），
 *      且新时段在完成期限内、不与其他预约冲突——任一不满足则整体回滚，
 *      原预约原样保留，并返回全部冲突说明。
 * 不读写 localStorage、不操作页面。
 */
(function (global) {
  const A = global.Archive;
  const SLOT = A.SLOT_MINUTES;
  const OPEN = A.OPEN_MINUTE;
  const CLOSE = A.CLOSE_MINUTE;

  const DAY_MS = 86400000;

  /* ---------------- 基础工具 ---------------- */

  function overlaps(s1, e1, s2, e2) {
    return s1 < e2 && s2 < e1;
  }

  function dayStart(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function minuteOfDay(ts) {
    const d = new Date(ts);
    return d.getHours() * 60 + d.getMinutes();
  }

  function machineById(id) {
    return A.MACHINES.find((m) => m.id === id) || null;
  }
  function rotorById(id) {
    return A.ROTORS.find((r) => r.id === id) || null;
  }
  function placeName(machineId, rotorId) {
    const m = machineById(machineId);
    const r = rotorById(rotorId);
    return `${m ? m.name : machineId} / ${r ? r.name : rotorId}`;
  }

  /** 管数允许使用的转子：容量够即可（管数 25–48 仅 RA；≤24 两只均可） */
  function eligibleRotors(tubes) {
    return A.ROTORS.filter((r) => tubes <= r.capacity);
  }

  /** 全部可行“机器+转子”组合（每种转子只能装在指定机器上） */
  function placementsFor(tubes) {
    const out = [];
    eligibleRotors(tubes).forEach((rotor) => {
      rotor.machineIds.forEach((machineId) => {
        out.push({ machineId, rotorId: rotor.id });
      });
    });
    return out;
  }

  /** 该时段同一人是否已占任意机器 */
  function ownerBusy(owner, start, end, bookings, ignoreId) {
    return bookings.find(
      (b) => b.id !== ignoreId && b.owner === owner && overlaps(start, end, b.start, b.end)
    ) || null;
  }

  /** 指定机器与转子是否均空闲，返回冲突预约（机器或转子任一占用即冲突） */
  function resourceBusy(machineId, rotorId, start, end, bookings, ignoreId) {
    return bookings.find((b) =>
      b.id !== ignoreId &&
      overlaps(start, end, b.start, b.end) &&
      (b.machineId === machineId || b.rotorId === rotorId)
    ) || null;
  }

  /* ---------------- 登记前置校验 ---------------- */

  function validateDraft(d) {
    if (!(d.tubes > 0)) return { code: 'BAD_TUBES', message: '管数必须为正整数。' };
    if (!(d.duration >= SLOT)) return { code: 'BAD_DURATION', message: `时长至少为 ${SLOT} 分钟。` };

    const maxCap = Math.max.apply(null, A.ROTORS.map((r) => r.capacity));
    if (d.tubes > maxCap) {
      return {
        code: 'TUBE_OVER_MAX',
        message: `共 ${d.tubes} 管，超过最大转子容量 ${maxCap} 孔，无可匹配转子，预约被拒绝。`,
      };
    }

    if (!Number.isFinite(d.start) || !Number.isFinite(d.deadline)) {
      return { code: 'BAD_TIME', message: '开始时间或完成期限无效。' };
    }

    const end = d.start + d.duration * 60000;
    if (end > d.deadline) {
      return {
        code: 'DEADLINE_TOO_EARLY',
        message: `按登记时长需到 ${fmt(end)} 才能完成，已晚于完成期限 ${fmt(d.deadline)}，请调整时长或期限。`,
      };
    }

    const openAt = dayStart(d.start) + OPEN * 60000;
    const closeAt = dayStart(d.start) + CLOSE * 60000;
    if (d.start < openAt || end > closeAt) {
      return {
        code: 'OUTSIDE_HOURS',
        message: `预约必须落在营业时段 ${pad(OPEN / 60)}:00–${pad(CLOSE / 60)}:00 内（且跨天暂不支持）。`,
      };
    }
    if (minuteOfDay(d.start) % SLOT !== 0) {
      return { code: 'NOT_ALIGNED', message: `开始时间须对齐 ${SLOT} 分钟刻度。` };
    }
    return null;
  }

  /* ---------------- 被顶预约的改排搜索 ----------------
   * 规则：必须换到【另一台】兼容机器（该机可装所需转子）；
   * 优先保留原开始时刻；不行则在原时刻【之后】的 15 分钟刻度上
   * 寻找最早可行、且结束时间不晚于完成期限与营业结束时间的时段
   * （顶换只顺延、不会把预约提前）。
   * others 为当前“模拟中”的全部预约（已含此前被改排者）。
   */
  function findRelocation(booking, others) {
    const duration = booking.end - booking.start;
    const placements = placementsFor(booking.tubes)
      .filter((p) => p.machineId !== booking.machineId); // 必须换机

    const closeAt = dayStart(booking.start) + CLOSE * 60000;
    const latestStart = Math.min(closeAt, booking.deadline) - duration;
    if (latestStart < booking.start) return null;

    const candidates = [booking.start]; // 原时刻优先（仅换机）
    for (let t = booking.start + SLOT * 60000; t <= latestStart; t += SLOT * 60000) {
      candidates.push(t);
    }

    for (const start of candidates) {
      const end = start + duration;
      if (end > booking.deadline || end > closeAt) continue;
      for (const p of placements) {
        if (resourceBusy(p.machineId, p.rotorId, start, end, others, booking.id)) continue;
        if (ownerBusy(booking.owner, start, end, others, booking.id)) continue;
        return { machineId: p.machineId, rotorId: p.rotorId, start, end };
      }
    }
    return null;
  }

  /**
   * 枚举某笔被顶预约的全部可行改排点（给定当前模拟排期）。
   * 必须换机；原时刻优先，其后按 15 分钟顺延；受完成期限与营业结束约束。
   */
  function relocationOptions(booking, sim) {
    const duration = booking.end - booking.start;
    const placements = placementsFor(booking.tubes)
      .filter((p) => p.machineId !== booking.machineId);

    const closeAt = dayStart(booking.start) + CLOSE * 60000;
    const latestStart = Math.min(closeAt, booking.deadline) - duration;
    const out = [];
    if (latestStart >= booking.start) {
      for (let t = booking.start; t <= latestStart; t += SLOT * 60000) {
        for (const p of placements) {
          const end = t + duration;
          if (end > booking.deadline || end > closeAt) continue;
          if (resourceBusy(p.machineId, p.rotorId, t, end, sim, booking.id)) continue;
          if (ownerBusy(booking.owner, t, end, sim, booking.id)) continue;
          out.push(Object.assign({ start: t, end }, p));
        }
      }
    }
    return out;
  }

  /**
   * 带回溯的连锁改排：逐笔为被顶预约选择改排点，
   * 全部安置后再验证急样机位确实空闲（机器与转子都不能再被占用）。
   * 返回 {sim, relocated} 或 null。
   */
  function tryRelocateAll(blockers, place, start, end, bookings) {
    const sim = bookings.slice();
    const relocated = [];
    const MAX_OPTIONS = 24; // 仅取最靠前（最接近原时刻）的候选，保证搜索可控

    function applyMove(blocker, target) {
      const idx = sim.findIndex((b) => b.id === blocker.booking.id);
      const current = sim[idx];
      const movedBooking = Object.assign({}, current, target, {
        moved: true,
        movedFrom: {
          machineId: blocker.booking.machineId,
          rotorId: blocker.booking.rotorId,
          start: blocker.booking.start,
          end: blocker.booking.end,
        },
      });
      sim[idx] = movedBooking;
      relocated.push({
        id: blocker.booking.id,
        sampleCode: blocker.booking.sampleCode,
        owner: blocker.booking.owner,
        tubes: blocker.booking.tubes,
        deadline: blocker.booking.deadline,
        from: movedBooking.movedFrom,
        to: target,
      });
    }
    function undo(blocker) {
      const idx = sim.findIndex((b) => b.id === blocker.booking.id);
      sim[idx] = blocker.booking;
      relocated.pop();
    }

    function dfs(i) {
      if (i === blockers.length) {
        // 关键：全部改排完成后，急样所需机器与转子必须确实空闲
        return !resourceBusy(place.machineId, place.rotorId, start, end, sim, null);
      }
      const blocker = blockers[i];
      const options = relocationOptions(sim.find((b) => b.id === blocker.booking.id), sim)
        .slice(0, MAX_OPTIONS);
      for (const target of options) {
        applyMove(blocker, target);
        if (dfs(i + 1)) return true;
        undo(blocker);
      }
      return false;
    }

    return dfs(0) ? { sim, relocated } : null;
  }

  /* ---------------- 主入口：登记一笔预约 ---------------- */

  /**
   * @returns 成功 { ok:true, booking, relocated:[...] }
   *          失败 { ok:false, code, message, conflicts:[...] }
   */
  function planBooking(draft, existing) {
    const bookings = existing.slice();

    const invalid = validateDraft(draft);
    if (invalid) return Object.assign({ ok: false, conflicts: [] }, invalid);

    const start = draft.start;
    const end = start + draft.duration * 60000;
    const urgent = draft.priority === 'urgent';
    const placements = placementsFor(draft.tubes);

    // 同一人不得同时占两台机（急样也不能顶掉本人的预约）
    const ownerClash = ownerBusy(draft.owner, start, end, bookings, null);
    if (ownerClash) {
      return fail('OWNER_CLASH',
        `登记人「${draft.owner}」在 ${fmt(start)}–${fmt(end)} 已占用 ${placeName(ownerClash.machineId, ownerClash.rotorId)}（${ownerClash.sampleCode}），同一人不能同时占两台机。`,
        [{ reason: 'OWNER_CLASH', booking: ownerClash }]);
    }

    // 评估每个可行机位
    const evaluated = placements.map((p) => {
      const blockers = bookings
        .filter((b) => overlaps(start, end, b.start, b.end))
        .map((b) => {
          let reason = null;
          if (b.machineId === p.machineId || b.rotorId === p.rotorId) {
            reason = b.priority === 'urgent' ? 'URGENT_EXISTING' : 'NORMAL_EXISTING';
          } else if (b.owner === draft.owner) {
            reason = 'OWNER_CLASH';
          }
          return reason ? { reason, booking: b, place: p } : null;
        })
        .filter(Boolean);
      return { place: p, blockers };
    });

    // 有空位：直接登记
    const free = evaluated.find((e) => e.blockers.length === 0);
    if (free) {
      return ok(createBooking(draft, free.place, start, end));
    }

    // 普通预约：不允许顶换，直接拒绝并报冲突
    if (!urgent) {
      const conflicts = collectConflicts(evaluated);
      return fail('OCCUPIED',
        `所需时段 ${fmt(start)}–${fmt(end)} 没有可用的兼容机位，普通预约不能顶换他人，请改约时间。`,
        conflicts);
    }

    /* ---- 急样：逐机位尝试顶换普通预约 ---- */
    const hardReasons = ['OWNER_CLASH', 'URGENT_EXISTING'];
    const attempts = evaluated
      .filter((e) => !e.blockers.some((x) => hardReasons.indexOf(x.reason) !== -1));

    if (attempts.length === 0) {
      return fail('URGENT_BLOCKED',
        `急样无法顶入：所需时段的兼容机位均被急样或本人预约占用，原预约全部原样保留。`,
        collectConflicts(evaluated));
    }

    for (const attempt of attempts) {
      const solved = tryRelocateAll(attempt.blockers, attempt.place, start, end, bookings);
      if (solved) {
        const booking = createBooking(draft, attempt.place, start, end);
        return { ok: true, booking, relocated: solved.relocated, sim: solved.sim };
      }
    }

    // 所有机位都无法完整改排 → 整体回滚
    const conflicts = collectConflicts(evaluated).map((c) =>
      c.reason === 'NORMAL_EXISTING' ? Object.assign({}, c, { reason: 'RELOCATE_FAILED' }) : c
    );
    return fail('RELOCATE_FAILED',
      `急样顶换失败：存在被顶预约无法在完成期限内换到其他兼容机器，所有原预约原样保留。`,
      conflicts);
  }

  /* ---------------- 结果组装 ---------------- */

  function createBooking(draft, place, start, end) {
    return {
      id: A.genId(),
      sampleCode: draft.sampleCode,
      owner: draft.owner,
      note: draft.note || '',
      tubes: draft.tubes,
      duration: draft.duration,
      priority: draft.priority,
      machineId: place.machineId,
      rotorId: place.rotorId,
      start, end,
      deadline: draft.deadline,
      moved: false,
      createdAt: Date.now(),
    };
  }

  /** 汇总各机位冲突，同一预约只保留最强理由 */
  function collectConflicts(evaluated) {
    const rank = { NORMAL_EXISTING: 1, RELOCATE_FAILED: 2, URGENT_EXISTING: 3, OWNER_CLASH: 4 };
    const map = new Map();
    evaluated.forEach((e) => {
      e.blockers.forEach((x) => {
        const prev = map.get(x.booking.id);
        if (!prev || rank[x.reason] > rank[prev.reason]) {
          map.set(x.booking.id, { reason: x.reason, booking: x.booking });
        }
      });
    });
    return Array.from(map.values());
  }

  function ok(booking, relocated) {
    return { ok: true, booking, relocated: relocated || [] };
  }
  function fail(code, message, conflicts) {
    return { ok: false, code, message, conflicts: conflicts || [] };
  }

  /* ---------------- 时间格式化（供 UI 复用） ---------------- */

  function pad(n) { return String(n).padStart(2, '0'); }
  function fmt(ts) {
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fmtFull(ts) {
    const d = new Date(ts);
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function describeConflict(c) {
    const b = c.booking;
    const base = `${b.sampleCode}（${b.owner}，${b.tubes}管）${fmt(b.start)}–${fmt(b.end)} @${placeName(b.machineId, b.rotorId)}`;
    switch (c.reason) {
      case 'URGENT_EXISTING':
        return `${base} —— 急样不可被顶`;
      case 'OWNER_CLASH':
        return `${base} —— 与登记人本人的另一预约时间冲突`;
      case 'RELOCATE_FAILED':
        return `${base} —— 无法在其期限 ${fmtFull(b.deadline)} 前换到兼容机器`;
      case 'NORMAL_EXISTING':
      default:
        return `${base} —— 时段被占用`;
    }
  }

  global.Scheduler = {
    SLOT, OPEN, CLOSE,
    overlaps, eligibleRotors, placementsFor, ownerBusy, resourceBusy,
    validateDraft, findRelocation, relocationOptions, tryRelocateAll, planBooking,
    placeName, machineById, rotorById, fmt, fmtFull, pad, describeConflict,
  };

})(window);
