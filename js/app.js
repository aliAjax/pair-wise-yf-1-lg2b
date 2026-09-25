'use strict';
/*
 * app.js —— 页面操作层
 * 职责：表单收集、时间轴/清单/详情渲染、调用 Archive 持久化与 Scheduler 判断。
 * 本文件不实现任何排期规则。
 */
(function () {
  const S = window.Scheduler;
  const Arc = window.Archive;

  const HOUR_W = 120; // 与 CSS 中 --hour-w 对应（像素/小时）
  const DAY_MS = 86400000;

  const state = {
    bookings: [],
    viewDay: dayStart(Date.now()),
    selectedId: null,
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    summary: $('resourceSummary'),
    form: $('bookingForm'),
    sampleCode: $('f_sampleCode'), owner: $('f_owner'),
    tubes: $('f_tubes'), duration: $('f_duration'),
    start: $('f_start'), deadline: $('f_deadline'),
    priority: $('f_priority'), note: $('f_note'),
    capacityHint: $('capacityHint'),
    banner: $('banner'),
    datePicker: $('datePicker'),
    btnPrev: $('btnPrevDay'), btnNext: $('btnNextDay'), btnToday: $('btnToday'),
    timeline: $('timeline'),
    dayList: $('dayList'), dayCount: $('dayCount'),
    detailBody: $('detailBody'),
    btnReset: $('btnResetDemo'),
  };

  /* ---------------- 时间工具 ---------------- */

  function dayStart(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function toLocalInput(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function parseLocalInput(v) {
    return v ? new Date(v).getTime() : NaN;
  }
  function roundUpSlot(ts) {
    const step = Arc.SLOT_MINUTES * 60000;
    return Math.ceil(ts / step) * step;
  }
  function dateInputValue(dayTs) {
    const d = new Date(dayTs);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function dayLabel(dayTs) {
    const d = new Date(dayTs);
    const today = dayStart(Date.now());
    const suffix = dayTs === today ? '（今天）'
      : dayTs === today - DAY_MS ? '（昨天）'
      : dayTs === today + DAY_MS ? '（明天）' : '';
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日${suffix} 星期${'日一二三四五六'[d.getDay()]}`;
  }

  /* ---------------- 初始化 ---------------- */

  function init() {
    if (Arc.isEmpty()) Arc.seedDemo();
    state.bookings = Arc.getAll();

    renderSummary();
    setFormDefaults();
    updateCapacityHint();
    wireEvents();
    render();
  }

  function renderSummary() {
    const rotorCap = {};
    Arc.ROTORS.forEach((r) => { rotorCap[r.id] = r.capacity; });
    els.summary.innerHTML =
      Arc.MACHINES.map((m) =>
        `<span class="res-chip"><b>${m.name}</b> · ${nameOfRotor(m.rotorId)} ${rotorCap[m.rotorId]}孔</span>`
      ).join('') +
      Arc.ROTORS.map((r) =>
        `<span class="res-chip">${r.name}：${r.machineIds.map((id) => nameOfMachine(id)).join('、')}共用</span>`
      ).join('');
  }
  function nameOfMachine(id) { const m = S.machineById(id); return m ? m.name : id; }
  function nameOfRotor(id) { const r = S.rotorById(id); return r ? r.name : id; }

  function setFormDefaults() {
    const start = roundUpSlot(Date.now() + 5 * 60000);
    els.start.value = toLocalInput(start);
    els.deadline.value = toLocalInput(start + 2 * 3600000);
    els.datePicker.value = dateInputValue(state.viewDay);
  }

  function wireEvents() {
    els.form.addEventListener('submit', onSubmit);
    els.tubes.addEventListener('input', updateCapacityHint);

    els.start.addEventListener('change', () => {
      const st = parseLocalInput(els.start.value);
      const dl = parseLocalInput(els.deadline.value);
      if (Number.isFinite(st) && (!Number.isFinite(dl) || dl < st + 3600000)) {
        els.deadline.value = toLocalInput(st + 2 * 3600000);
      }
    });

    els.btnPrev.addEventListener('click', () => shiftDay(-1));
    els.btnNext.addEventListener('click', () => shiftDay(1));
    els.btnToday.addEventListener('click', () => { state.viewDay = dayStart(Date.now()); render(); });
    els.datePicker.addEventListener('change', () => {
      const t = parseLocalInput(els.datePicker.value + 'T00:00');
      if (Number.isFinite(t)) { state.viewDay = dayStart(t); render(); }
    });

    els.btnReset.addEventListener('click', () => {
      if (window.confirm('确定清空当前全部预约并恢复为演示数据吗？')) {
        Arc.seedDemo();
        state.bookings = Arc.getAll();
        state.selectedId = null;
        render();
        showBanner('ok', '已恢复为演示数据。');
      }
    });
  }

  function shiftDay(delta) {
    state.viewDay = dayStart(state.viewDay + delta * DAY_MS);
    render();
  }

  function updateCapacityHint() {
    const t = parseInt(els.tubes.value, 10);
    const hint = els.capacityHint;
    if (!(t > 0)) { hint.textContent = ''; hint.className = 'hint'; return; }
    if (t > 48) {
      hint.textContent = `超过最大转子容量 48 孔：没有可匹配的转子，提交将被拒绝。`;
      hint.className = 'hint warn';
    } else if (t > 24) {
      hint.textContent = `需用 A转子（48孔），只能安排 1、2 号机。`;
      hint.className = 'hint';
    } else {
      hint.textContent = `A/B 转子均可用：A转子→1、2号机，B转子→3、4号机。`;
      hint.className = 'hint';
    }
  }

  /* ---------------- 提交预约 ---------------- */

  function onSubmit(ev) {
    ev.preventDefault();
    const draft = {
      sampleCode: els.sampleCode.value.trim(),
      owner: els.owner.value.trim(),
      tubes: parseInt(els.tubes.value, 10),
      duration: parseInt(els.duration.value, 10),
      start: parseLocalInput(els.start.value),
      deadline: parseLocalInput(els.deadline.value),
      priority: els.priority.value,
      note: els.note.value.trim(),
    };
    if (!draft.sampleCode || !draft.owner) {
      showBanner('err', '请填写样本编号与登记人。');
      return;
    }

    const result = S.planBooking(draft, state.bookings);

    if (result.ok) {
      const base = result.sim ? result.sim.slice() : state.bookings.slice();
      base.push(result.booking);
      Arc.replaceAll(base);
      state.bookings = Arc.getAll();
      state.selectedId = result.booking.id;
      state.viewDay = dayStart(result.booking.start);
      renderSuccess(result);
    } else {
      renderFailure(result);
    }
    render();
  }

  function renderSuccess(result) {
    const b = result.booking;
    const head = b.priority === 'urgent' ? '急样已排入并完成顶换：' : '预约成功：';
    let html = `${head}<code>${b.sampleCode}</code>（${b.owner}，${b.tubes}管）` +
      `安排在 <b>${S.placeName(b.machineId, b.rotorId)}</b>，${S.fmtFull(b.start)}–${S.fmt(b.end)}。`;
    if (result.relocated.length) {
      html += '<ul>' + result.relocated.map((r) => {
        const toName = S.placeName(r.to.machineId, r.to.rotorId);
        const sameStart = r.to.start === r.from.start
          ? '开始时刻不变，'
          : `开始时刻调整为 ${S.fmt(r.to.start)}，`;
        return `<li><code>${r.sampleCode}</code>（${r.owner}）由 ${S.placeName(r.from.machineId, r.from.rotorId)} ${S.fmt(r.from.start)}–${S.fmt(r.from.end)} ` +
          `改排至 <b>${toName}</b> ${S.fmt(r.to.start)}–${S.fmt(r.to.end)}，${sameStart}` +
          `仍早于其完成期限 ${S.fmtFull(r.deadline)}。</li>`;
      }).join('') + '</ul>';
    }
    showBanner(result.relocated.length ? 'warn' : 'ok', html);
  }

  function renderFailure(result) {
    let html = result.message;
    if (result.conflicts.length) {
      html += '<ul>' +
        result.conflicts.map((c) => `<li>${S.describeConflict(c)}</li>`).join('') +
        '</ul>';
    }
    showBanner('err', html);
  }

  function showBanner(kind, html) {
    els.banner.innerHTML =
      `<div class="banner ${kind}"><button type="button" class="btn btn-danger-ghost" style="float:right" onclick="this.parentElement.remove()">×</button>${html}</div>`;
  }

  /* ---------------- 总渲染 ---------------- */

  function render() {
    els.datePicker.value = dateInputValue(state.viewDay);
    renderTimeline();
    renderDayList();
    renderDetail();
  }

  function dayBookings() {
    const d0 = state.viewDay;
    const d1 = d0 + DAY_MS;
    return state.bookings
      .filter((b) => b.start >= d0 && b.start < d1)
      .sort((a, b) => a.start - b.start || a.machineId.localeCompare(b.machineId));
  }

  /* ---------------- 时间轴 ---------------- */

  function renderTimeline() {
    const lanes = [
      { kind: 'machine', id: 'M1', label: nameOfMachine('M1'), sub: `${nameOfRotor('RA')} · 48孔` },
      { kind: 'machine', id: 'M2', label: nameOfMachine('M2'), sub: `${nameOfRotor('RA')} · 48孔` },
      { kind: 'machine', id: 'M3', label: nameOfMachine('M3'), sub: `${nameOfRotor('RB')} · 24孔` },
      { kind: 'machine', id: 'M4', label: nameOfMachine('M4'), sub: `${nameOfRotor('RB')} · 24孔` },
      { kind: 'rotor', id: 'RA', label: nameOfRotor('RA'), sub: '1、2号机共用 · 48孔' },
      { kind: 'rotor', id: 'RB', label: nameOfRotor('RB'), sub: '3、4号机共用 · 24孔' },
    ];

    const dayBs = dayBookings();
    const hours = [];
    for (let h = S.OPEN / 60; h < S.CLOSE / 60; h++) hours.push(pad(h) + ':00');

    let html = `<div class="timeline-scroll"><div class="timeline">`;
    html += `<div class="tl-row"><div class="tl-label"><b>${dayLabel(state.viewDay)}</b><span>营业 ${pad(S.OPEN / 60)}:00–${pad(S.CLOSE / 60)}:00</span></div>` +
      `<div class="tl-track-wrap"><div class="tl-hours">${hours.map((h) => `<span>${h}</span>`).join('')}</div></div></div>`;

    lanes.forEach((lane) => {
      const sep = lane.kind === 'rotor' ? ' resource-sep' : '';
      html += `<div class="tl-row${sep}">` +
        `<div class="tl-label lane-${lane.kind}"><b>${lane.label}</b><span>${lane.sub}</span></div>` +
        `<div class="tl-track-wrap"><div class="tl-lane lane-${lane.kind}">`;
      html += blocksForLane(lane, dayBs);
      html += `</div></div></div>`;
    });

    if (dayBs.length === 0) {
      html += `<div class="tl-empty">当天暂无预约。可在左侧登记，或切换日期查看。</div>`;
    }
    html += `</div></div>`;
    els.timeline.innerHTML = html;

    els.timeline.querySelectorAll('.tl-block').forEach((node) => {
      node.addEventListener('click', () => selectBooking(node.dataset.id));
    });
  }

  function blocksForLane(lane, list) {
    return list
      .filter((b) => lane.kind === 'machine' ? b.machineId === lane.id : b.rotorId === lane.id)
      .map((b) => {
        const sMin = new Date(b.start).getHours() * 60 + new Date(b.start).getMinutes();
        const eMin = new Date(b.end).getHours() * 60 + new Date(b.end).getMinutes();
        const left = (sMin - S.OPEN) * (HOUR_W / 60);
        const width = Math.max(34, (eMin - sMin) * (HOUR_W / 60));
        const cls = b.moved ? 'moved' : b.priority;
        const sel = b.id === state.selectedId ? ' selected' : '';
        return `<div class="tl-block ${cls}${sel}" data-id="${b.id}" style="left:${left}px;width:${width}px" ` +
          `title="${b.sampleCode}｜${b.owner}｜${b.tubes}管｜${S.fmt(b.start)}-${S.fmt(b.end)}">` +
          `<div class="b-title">${escapeHtml(b.sampleCode)} · ${escapeHtml(b.owner)}</div>` +
          `<div class="b-sub">${b.tubes}管 ${S.fmt(b.start)}–${S.fmt(b.end)}${b.moved ? ' · 改排' : ''}</div>` +
          `</div>`;
      })
      .join('');
  }

  /* ---------------- 当日清单 ---------------- */

  function renderDayList() {
    const list = dayBookings();
    els.dayCount.textContent = `共 ${list.length} 笔`;
    if (!list.length) {
      els.dayList.innerHTML = `<p class="muted">当天暂无预约。</p>`;
      return;
    }
    els.dayList.innerHTML = list.map((b) => {
      const tagCls = b.moved ? 'moved' : b.priority;
      const tagText = b.moved ? '改排' : (b.priority === 'urgent' ? '急样' : '普通');
      return `<div class="day-item${b.id === state.selectedId ? ' selected' : ''}" data-id="${b.id}">` +
        `<div class="day-time">${S.fmt(b.start)}–${S.fmt(b.end)}</div>` +
        `<span class="day-tag ${tagCls}">${tagText}</span>` +
        `<div class="day-main">` +
        `<div class="m1">${escapeHtml(b.sampleCode)} · ${escapeHtml(b.owner)} · ${b.tubes}管 · ${b.duration}分钟</div>` +
        `<div class="m2">${S.placeName(b.machineId, b.rotorId)} · 期限 ${S.fmt(b.deadline)}${b.note ? ' · ' + escapeHtml(b.note) : ''}</div>` +
        `</div></div>`;
    }).join('');

    els.dayList.querySelectorAll('.day-item').forEach((node) => {
      node.addEventListener('click', () => selectBooking(node.dataset.id));
    });
  }

  /* ---------------- 详情 / 删除 ---------------- */

  function selectBooking(id) {
    state.selectedId = id;
    render();
  }

  function renderDetail() {
    const b = state.bookings.find((x) => x.id === state.selectedId);
    if (!b) {
      els.detailBody.className = 'muted';
      els.detailBody.textContent = '点击时间轴或列表中的预约查看';
      return;
    }
    els.detailBody.className = '';
    const tagCls = b.moved ? 'moved' : b.priority;
    const tagText = b.moved ? '被顶后改排' : (b.priority === 'urgent' ? '急样' : '普通');
    let html = `<div class="day-tag ${tagCls}" style="display:inline-block;margin-bottom:8px">${tagText}</div>` +
      `<dl class="detail-grid">` +
      row('样本编号', escapeHtml(b.sampleCode)) +
      row('登记人', escapeHtml(b.owner)) +
      row('管数', `${b.tubes} 管（${b.duration} 分钟）`) +
      row('机位', S.placeName(b.machineId, b.rotorId)) +
      row('开始/结束', `${S.fmtFull(b.start)} – ${S.fmt(b.end)}`) +
      row('完成期限', S.fmtFull(b.deadline)) +
      row('备注', b.note ? escapeHtml(b.note) : '—') +
      `</dl>`;
    if (b.moved && b.movedFrom) {
      html += `<div class="moved-note">因急样顶换，由 ${S.placeName(b.movedFrom.machineId, b.movedFrom.rotorId)} ` +
        `${S.fmt(b.movedFrom.start)}–${S.fmt(b.movedFrom.end)} 改排至此。</div>`;
    }
    html += `<div class="detail-actions">` +
      `<button type="button" class="btn btn-danger" id="btnDelete">取消该预约</button>` +
      `</div>`;
    els.detailBody.innerHTML = html;
    $('btnDelete').addEventListener('click', () => {
      if (window.confirm(`确定取消预约 ${b.sampleCode}（${S.fmt(b.start)}–${S.fmt(b.end)}）吗？`)) {
        Arc.remove(b.id);
        state.bookings = Arc.getAll();
        state.selectedId = null;
        render();
        showBanner('ok', `已取消预约 <code>${b.sampleCode}</code>。`);
      }
    });
  }

  function row(k, v) { return `<dt>${k}</dt><dd>${v}</dd>`; }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  document.addEventListener('DOMContentLoaded', init);
})();
