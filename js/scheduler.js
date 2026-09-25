/**
 * 排期判断层（scheduler.js）
 * 纯规则：时段重叠、容量校验、期限检查、急样顶位与被顶预约改期。
 * 不读写 DOM；只通过 Store 的接口读写档案。
 *
 * 资源模型：
 *   4 台离心机 M1–M4；2 只转子 A/B。
 *   一次预约同时占用「一台机 + 一只转子」，两类时段均不得重叠。
 *   转子有容量（管数）与适配机台清单，管数超过任何可选转子容量即拒绝。
 */
const Scheduler = (() => {
  const MACHINES = [
    { id: 'M1', name: '1 号离心机' },
    { id: 'M2', name: '2 号离心机' },
    { id: 'M3', name: '3 号离心机' },
    { id: 'M4', name: '4 号离心机' },
  ];

  const ROTORS = [
    { id: 'RA', name: '转子 A', capacity: 24, machines: ['M1', 'M2'] },
    { id: 'RB', name: '转子 B', capacity: 12, machines: ['M1', 'M2', 'M3', 'M4'] },
  ];

  const PRIORITY = { NORMAL: 'normal', URGENT: 'urgent' };

  const overlaps = (s1, e1, s2, e2) => s1 < e2 && s2 < e1;

  /**
   * 某「机 + 转子」组合上的忙碌时段；同一机台或同一转子在时段内都算占用。
   */
  function busyIntervals(reservations, machineId, rotorId, excludeIds) {
    return reservations
      .filter(
        (r) =>
          !excludeIds.has(r.id) &&
          (r.machineId === machineId || r.rotorId === rotorId)
      )
      .map((r) => ({ start: r.start, end: r.end, ref: r }))
      .sort((a, b) => a.start - b.start);
  }

  /**
   * 在不晚于 deadlineMs 的前提下，求不与忙碌时段冲突的最早开始时刻；
   * 无解返回 null。
   */
  function earliestFit(intervals, notBefore, durationMs, deadlineMs) {
    let t = notBefore;
    while (t + durationMs <= deadlineMs) {
      const hit = intervals.find((iv) =>
        overlaps(t, t + durationMs, iv.start, iv.end)
      );
      if (!hit) return t;
      t = Math.max(t, hit.end);
    }
    return null;
  }

  /** 容量装得下该管数的转子 */
  function compatibleRotors(tubes) {
    return ROTORS.filter((r) => r.capacity >= tubes);
  }

  /**
   * 在所有「兼容转子 × 适配机台」组合里找最早空位。
   * req: { tubes, durationMs, notBefore, deadlineMs }
   */
  function findSlot(reservations, req, excludeIds = new Set()) {
    let best = null;
    for (const rotor of compatibleRotors(req.tubes)) {
      for (const machineId of rotor.machines) {
        const intervals = busyIntervals(reservations, machineId, rotor.id, excludeIds);
        const start = earliestFit(
          intervals,
          req.notBefore,
          req.durationMs,
          req.deadlineMs
        );
        if (start !== null && (!best || start < best.start)) {
          best = {
            machineId,
            rotorId: rotor.id,
            start,
            end: start + req.durationMs,
          };
        }
      }
    }
    return best;
  }

  /**
   * 急样顶位方案：忽略普通预约求空位；被顶的普通预约必须能在各自期限前
   * 改期到其他兼容资源。任一被顶预约无法改期则此组合方案失败，换下一组合。
   * 返回 { machineId, rotorId, start, end, moves } 或 null。
   */
  function planPreemption(reservations, req, now) {
    let best = null;

    for (const rotor of compatibleRotors(req.tubes)) {
      for (const machineId of rotor.machines) {
        // 既有急样视为硬冲突，普通预约可协商
        const hardIntervals = busyIntervals(
          reservations,
          machineId,
          rotor.id,
          new Set()
        ).filter((iv) => iv.ref.priority === PRIORITY.URGENT);

        const start = earliestFit(
          hardIntervals,
          req.notBefore,
          req.durationMs,
          req.deadlineMs
        );
        if (start === null) continue;
        const end = start + req.durationMs;

        const evicted = reservations.filter(
          (r) =>
            r.priority !== PRIORITY.URGENT &&
            (r.machineId === machineId || r.rotorId === rotor.id) &&
            overlaps(start, end, r.start, r.end)
        );

        const newBooking = {
          id: '__pending__',
          machineId,
          rotorId: rotor.id,
          start,
          end,
          priority: PRIORITY.URGENT,
        };
        const tentative = reservations
          .filter((r) => !evicted.includes(r))
          .concat([newBooking]);

        const moves = [];
        let failed = false;

        // 期限紧的被顶预约优先改期，降低连锁失败概率
        for (const ev of evicted.slice().sort((a, b) => a.deadline - b.deadline)) {
          const slot = findSlot(tentative, {
            tubes: ev.tubes,
            durationMs: ev.end - ev.start,
            notBefore: now,
            deadlineMs: ev.deadline,
          });
          if (!slot) {
            failed = true;
            break;
          }
          tentative.push({ ...ev, ...slot });
          moves.push({
            id: ev.id,
            sampleName: ev.sampleName,
            from: {
              machineId: ev.machineId,
              rotorId: ev.rotorId,
              start: ev.start,
              end: ev.end,
            },
            to: slot,
          });
        }

        if (failed) continue;
        if (!best || start < best.start) {
          best = { machineId, rotorId: rotor.id, start, end, moves };
        }
      }
    }
    return best;
  }

  function makeBooking(input, slot, id) {
    return {
      id,
      sampleName: input.sampleName,
      owner: input.owner,
      tubes: input.tubes,
      minutes: input.minutes,
      priority: input.priority,
      deadline: input.deadlineMs,
      machineId: slot.machineId,
      rotorId: slot.rotorId,
      start: slot.start,
      end: slot.end,
      status: 'scheduled',
      createdAt: Date.now(),
    };
  }

  /**
   * 主入口：登记一条预约并尝试排期。
   * input: { sampleName, owner, tubes, minutes, priority, startMs, deadlineMs }
   *
   * 返回：
   *   { ok:true,  booking, moves, preempted? }
   *   { ok:false, reason: 'capacity' | 'deadline-too-tight' | 'no-slot' | 'conflict', ... }
   * 失败时不会改动任何既有预约。
   */
  function schedule(store, input) {
    const now = Date.now();
    const maxCapacity = Math.max(...ROTORS.map((r) => r.capacity));

    if (!Number.isFinite(input.tubes) || input.tubes < 1) {
      return { ok: false, reason: 'invalid-tubes' };
    }
    if (input.tubes > maxCapacity) {
      return { ok: false, reason: 'capacity', maxCapacity };
    }

    const req = {
      tubes: input.tubes,
      durationMs: input.minutes * 60000,
      notBefore: Math.max(input.startMs, now),
      deadlineMs: input.deadlineMs,
    };

    if (req.notBefore + req.durationMs > req.deadlineMs) {
      return { ok: false, reason: 'deadline-too-tight' };
    }

    const scheduled = store.scheduled();

    // 1) 先找不打扰任何人的空位
    const slot = findSlot(scheduled, req);
    if (slot) {
      const booking = makeBooking(input, slot, store.nextId());
      store.add(booking);
      return { ok: true, booking, moves: [] };
    }

    // 2) 普通预约不得顶位，直接拒绝
    if (input.priority !== PRIORITY.URGENT) {
      return { ok: false, reason: 'no-slot' };
    }

    // 3) 急样尝试顶位：被顶者必须能改期且赶得上各自期限
    const plan = planPreemption(scheduled, req, now);
    if (!plan) {
      const blockers = scheduled.filter(
        (r) =>
          r.priority === PRIORITY.URGENT &&
          overlaps(req.notBefore, req.deadlineMs, r.start, r.end)
      );
      return { ok: false, reason: 'conflict', blockers };
    }

    for (const mv of plan.moves) {
      store.update(mv.id, {
        machineId: mv.to.machineId,
        rotorId: mv.to.rotorId,
        start: mv.to.start,
        end: mv.to.end,
      });
    }
    const booking = makeBooking(input, plan, store.nextId());
    store.add(booking);

    return {
      ok: true,
      booking,
      moves: plan.moves,
      preempted: plan.moves.length > 0,
    };
  }

  return { MACHINES, ROTORS, PRIORITY, schedule, overlaps };
})();

if (typeof module !== 'undefined') module.exports = Scheduler;
