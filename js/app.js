/**
 * 页面操作层（app.js）
 * 只做 DOM 交互：读取表单、调用 Scheduler、渲染看板与结果消息。
 * 不含排期规则，也不直接碰 localStorage。
 */
document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('booking-form');
  const msg = document.getElementById('message');
  const board = document.getElementById('board');
  const rotorBoard = document.getElementById('rotor-board');

  const { MACHINES, ROTORS } = Scheduler;
  const machineName = (id) => (MACHINES.find((m) => m.id === id) || {}).name || id;
  const rotorName = (id) => {
    const r = ROTORS.find((x) => x.id === id);
    return r ? `${r.name}（${r.capacity} 管）` : id;
  };

  // ---------- 工具 ----------
  const pad = (n) => String(n).padStart(2, '0');

  function toLocalInput(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fmt(ms) {
    const d = new Date(ms);
    return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function showMsg(html, kind) {
    msg.className = 'msg ' + kind;
    msg.innerHTML = html;
  }

  // ---------- 表单 ----------
  function setDefaults() {
    form.elements.start.value = toLocalInput(new Date(Date.now() + 5 * 60000));
    form.elements.deadline.value = toLocalInput(new Date(Date.now() + 4 * 3600000));
  }
  setDefaults();

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = {
      sampleName: form.elements.sampleName.value.trim(),
      owner: form.elements.owner.value.trim(),
      tubes: parseInt(form.elements.tubes.value, 10),
      minutes: parseInt(form.elements.minutes.value, 10),
      priority: form.elements.priority.value,
      startMs: new Date(form.elements.start.value).getTime(),
      deadlineMs: new Date(form.elements.deadline.value).getTime(),
    };

    if (!input.sampleName || !input.owner) {
      return showMsg('请填写样本名称和送样人。', 'error');
    }
    if (!Number.isFinite(input.tubes) || input.tubes < 1) {
      return showMsg('管数需为不小于 1 的整数。', 'error');
    }
    if (!Number.isFinite(input.minutes) || input.minutes <= 0) {
      return showMsg('时长需大于 0 分钟。', 'error');
    }
    if (!Number.isFinite(input.startMs) || !Number.isFinite(input.deadlineMs)) {
      return showMsg('请填写期望开始时间与完成期限。', 'error');
    }
    if (input.deadlineMs <= input.startMs) {
      return showMsg('完成期限必须晚于期望开始时间。', 'error');
    }

    const res = Scheduler.schedule(Store, input);
    showResult(res);
    if (res.ok) {
      form.reset();
      setDefaults();
    }
    render();
  });

  function showResult(res) {
    if (res.ok) {
      const b = res.booking;
      let html = `✅ 已安排：<b>${esc(b.sampleName)}</b>（${b.tubes} 管）→ ` +
        `${machineName(b.machineId)} / ${rotorName(b.rotorId)}，` +
        `${fmt(b.start)} – ${fmt(b.end)}`;
      if (res.moves && res.moves.length) {
        html += '<br>⚠️ 急样顶位，以下普通预约已改期（均可赶上各自期限）：<ul>' +
          res.moves.map((mv) =>
            `<li>${esc(mv.sampleName)}：${fmt(mv.from.start)}（${machineName(mv.from.machineId)}）` +
            ` → 改至 ${fmt(mv.to.start)}（${machineName(mv.to.machineId)} / ${rotorName(mv.to.rotorId)}）</li>`
          ).join('') + '</ul>';
      }
      return showMsg(html, 'ok');
    }

    switch (res.reason) {
      case 'capacity':
        return showMsg(`❌ 已拒绝：管数超过最大转子容量（${res.maxCapacity} 管），请分管后再约。`, 'error');
      case 'invalid-tubes':
        return showMsg('❌ 已拒绝：管数无效。', 'error');
      case 'deadline-too-tight':
        return showMsg('❌ 已拒绝：所需时长在完成期限前排不开，请放宽期限或缩短时长。', 'error');
      case 'no-slot':
        return showMsg('❌ 期限内各机台与转子的时段均已排满，本次未安排。可改期限，或改挂急样。', 'error');
      case 'conflict': {
        const list = (res.blockers || []).map((b) =>
          `<li>${esc(b.sampleName)}（急）${machineName(b.machineId)} / ${rotorName(b.rotorId)} ${fmt(b.start)}–${fmt(b.end)}</li>`
        ).join('');
        return showMsg(
          '❌ 急样无法顶位：被顶的普通预约改期后赶不上期限，或时段被其他急样占住。' +
          '<b>所有原预约保持原样。</b>冲突时段的急样：<ul>' + (list || '<li>（无）</li>') + '</ul>',
          'error'
        );
      }
      default:
        return showMsg('❌ 预约失败。', 'error');
    }
  }

  // ---------- 看板 ----------
  function itemHtml(r, showMachine) {
    const past = r.end < Date.now() ? ' past' : '';
    const urgent = r.priority === 'urgent';
    return `<li class="item ${urgent ? 'urgent' : 'normal'}${past}">
      <span class="badge">${urgent ? '急' : '普'}</span>
      <span class="time">${fmt(r.start)} – ${fmt(r.end)}</span>
      <span class="name">${esc(r.sampleName)}</span>
      <span class="meta">${r.tubes} 管 · ${esc(r.owner)} · 期限 ${fmt(r.deadline)} · ${showMachine ? machineName(r.machineId) : rotorName(r.rotorId)}</span>
      <button class="cancel" data-cancel="${r.id}" title="取消预约">✕</button>
    </li>`;
  }

  function renderGroup(container, resources, filter, showMachine) {
    const list = Store.scheduled().slice().sort((a, b) => a.start - b.start);
    container.innerHTML = resources.map((res) => {
      const items = list.filter((r) => filter(r, res));
      const body = items.length
        ? `<ul>${items.map((r) => itemHtml(r, showMachine)).join('')}</ul>`
        : '<p class="empty">空闲</p>';
      const title = res.capacity ? `${res.name}（${res.capacity} 管）` : res.name;
      return `<div class="card"><h3>${title}</h3>${body}</div>`;
    }).join('');
  }

  function render() {
    renderGroup(board, MACHINES, (r, m) => r.machineId === m.id, false);
    renderGroup(rotorBoard, ROTORS, (r, t) => r.rotorId === t.id, true);
  }

  function onCancel(e) {
    const btn = e.target.closest('button[data-cancel]');
    if (!btn) return;
    Store.cancel(btn.dataset.cancel);
    showMsg('已取消该预约。', 'ok');
    render();
  }
  board.addEventListener('click', onCancel);
  rotorBoard.addEventListener('click', onCancel);

  render();
  // 每分钟刷新一次，让已过期的条目变灰
  setInterval(render, 60000);
});
