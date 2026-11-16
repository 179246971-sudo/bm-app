/* 报名工具 · 管理后台 */

const $ = (s) => document.querySelector(s);
const esc = Grid.esc;
const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const S = {
  key: (() => { try { return sessionStorage.getItem('bm_admin_key') || ''; } catch (e) { return ''; } })(),
  cfg: null,
  board: null,
  editing: null
};

function setKey(k) {
  S.key = k;
  try { sessionStorage.setItem('bm_admin_key', k); } catch (e) { /* 忽略 */ }
}

async function api(path, body) {
  const opt = {
    method: body ? 'POST' : 'GET',
    headers: { 'x-admin-key': S.key }
  };
  if (body) {
    opt.headers['content-type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const r = await fetch('/api' + path, opt);
  let j = {};
  try { j = await r.json(); } catch (e) { /* ignore */ }
  if (!r.ok || j.error) {
    const err = new Error(j.error || ('HTTP ' + r.status));
    err.status = r.status;
    throw err;
  }
  return j;
}

function hhmm(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/* ---------------- 登录 ---------------- */

async function login() {
  const pwd = $('#pwd').value;
  if (!pwd) { $('#loginHint').textContent = '请输入密码'; return; }

  $('#loginHint').textContent = '正在验证…';
  try {
    const r = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: pwd })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || '登录失败');
    setKey(pwd);
    enterApp();
  } catch (e) {
    $('#loginHint').textContent = e.message;
  }
}

function enterApp() {
  $('#loginPanel').hidden = true;
  $('#appPanel').hidden = false;
  resetPwd();
  loadConfig();
  loadBoard();
  loadRoster();
}

/* ---------------- 课表设置 ---------------- */

async function loadConfig() {
  try {
    const r = await api('/admin/config');
    S.cfg = r.config;
    fillForm();
  } catch (e) {
    if (e.status === 401) { backToLogin(); return; }
    $('#saveHint').textContent = '读取设置失败：' + e.message;
  }
}

function fillForm() {
  const c = S.cfg;
  $('#cfgTitle').value = c.title || '';
  $('#cfgSub').value = c.subtitle || '';
  $('#cfgCancel').value = c.cancelMin || 3;
  $('#cfgMaxDay').value = c.maxPerDay || 2;
  $('#cfgSlotMin').value = c.slotMinutes || 60;
  $('#cfgShowStats').checked = c.showStats !== false;

  S.days = JSON.parse(JSON.stringify(c.days || {}));
  for (let d = 0; d < 7; d++) if (!Array.isArray(S.days[d])) S.days[d] = [];
  renderDays();
}

function toMin(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return -1;
  return (+m[1]) * 60 + (+m[2]);
}

function fromMin(n) {
  n = ((n % 1440) + 1440) % 1440;
  return String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
}

function renderDays() {
  const box = $('#dayEditor');
  box.innerHTML = '';

  for (let i = 0; i < 7; i++) {
    const dow = (i + 1) % 7;              // 周一到周日
    const arr = S.days[dow];
    const blk = document.createElement('div');
    blk.className = 'day-blk';

    const hd = document.createElement('div');
    hd.className = 'day-hd';
    hd.innerHTML = '<b>' + WEEK_CN[dow] + '</b><span>' +
      (arr.length ? arr.length + ' 节' : '不上课') + '</span>';
    blk.appendChild(hd);

    arr.forEach((slot, idx) => {
      const row = document.createElement('div');
      row.className = 'slot-row';
      row.innerHTML =
        '<input type="time" class="s-start" value="' + (slot.start || '09:00') + '">' +
        '<span class="s-capwrap"><input type="number" class="s-cap" min="1" max="999" value="' +
          (slot.cap || 8) + '"><i>人</i></span>' +
        '<label class="s-on"><input type="checkbox" class="s-open"' +
          (slot.off ? '' : ' checked') + '>开放</label>' +
        '<button class="btn tiny s-del" type="button">×</button>';

      row.querySelector('.s-start').addEventListener('input', (e) => {
        if (e.target.value) slot.start = e.target.value;
      });
      row.querySelector('.s-cap').addEventListener('input', (e) => {
        const v = parseInt(e.target.value, 10);
        slot.cap = Number.isFinite(v) ? Math.max(1, Math.min(999, v)) : 8;
      });
      row.querySelector('.s-open').addEventListener('change', (e) => {
        if (e.target.checked) delete slot.off;
        else slot.off = true;
      });
      row.querySelector('.s-del').addEventListener('click', () => {
        arr.splice(idx, 1);
        renderDays();
      });

      blk.appendChild(row);
    });

    const add = document.createElement('button');
    add.className = 'btn tiny add-slot';
    add.type = 'button';
    add.textContent = '＋ 加一节';
    add.addEventListener('click', () => {
      const step = parseInt($('#cfgSlotMin').value, 10) || 60;
      const last = arr[arr.length - 1];
      const start = last && toMin(last.start) >= 0 ? fromMin(toMin(last.start) + step) : '14:30';
      arr.push({ id: '', start, cap: last ? last.cap : 8 });
      renderDays();
    });
    blk.appendChild(add);

    box.appendChild(blk);
  }
}

function copyMonToOthers() {
  const src = S.days[1] || [];
  if (!src.length) { $('#saveHint').textContent = '周一还没有课，先给周一加几节'; return; }
  const names = [2, 3, 4, 5, 6, 0].map((d) => WEEK_CN[d]).join('、');
  if (!confirm('把周一的 ' + src.length + ' 节课复制到 ' + names + '？\n\n这些天原来的设置会被覆盖。')) return;
  [2, 3, 4, 5, 6, 0].forEach((d) => {
    S.days[d] = JSON.parse(JSON.stringify(src)).map((x) => ({ id: '', start: x.start, cap: x.cap }));
  });
  renderDays();
  $('#saveHint').textContent = '已复制，记得点下面的「保存设置」';
}

function collectConfig() {
  return {
    title: $('#cfgTitle').value.trim() || 'Hihi Studio',
    subtitle: $('#cfgSub').value,
    cancelMin: parseInt($('#cfgCancel').value, 10) || 3,
    maxPerDay: parseInt($('#cfgMaxDay').value, 10) || 2,
    slotMinutes: parseInt($('#cfgSlotMin').value, 10) || 60,
    showStats: !!$('#cfgShowStats').checked,
    days: S.days
  };
}

function validateConfig(cfg) {
  const step = cfg.slotMinutes;
  let total = 0;

  for (let d = 0; d < 7; d++) {
    const arr = cfg.days[d] || [];
    const open = [];

    for (const slot of arr) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(slot.start || ''))) {
        return WEEK_CN[d] + ' 有个时间没填对';
      }
      const m = toMin(slot.start);
      if (m + step > 1440) {
        return WEEK_CN[d] + ' ' + slot.start + ' 开始的话，下课会到第二天凌晨';
      }
      if (!slot.off) { open.push(m); total++; }
    }

    open.sort((a, b) => a - b);
    for (let i = 1; i < open.length; i++) {
      if (open[i] - open[i - 1] < step) {
        return WEEK_CN[d] + ' ' + fromMin(open[i - 1]) + ' 和 ' + fromMin(open[i]) +
               ' 时间重叠了（每节 ' + step + ' 分钟）';
      }
    }
  }

  if (!total) return '整周都没课，至少给某一天加一节';
  return '';
}

async function saveConfig() {
  const next = collectConfig();
  const bad = validateConfig(next);
  if (bad) { $('#saveHint').textContent = bad; return; }

  $('#saveBtn').disabled = true;
  $('#saveHint').textContent = '保存中…';
  try {
    const r = await api('/admin/config', { config: next });
    S.cfg = r.config;
    fillForm();
    $('#saveHint').textContent = '已保存 ✓ 会员页刷新就能看到新表';
    loadBoard();
  } catch (e) {
    if (e.status === 401) { backToLogin(); return; }
    $('#saveHint').textContent = '保存失败：' + e.message;
  } finally {
    $('#saveBtn').disabled = false;
  }
}

$('#copyMon').addEventListener('click', copyMonToOthers);

/* ---------------- 报名管理 ---------------- */

async function loadBoard() {
  try {
    const r = await api('/admin/board');
    S.board = r;
    const el = $('#adminBoard');
    Grid.renderGrid(el, r, { onCell: openCell });
    el.appendChild(Grid.buildLegend());
  } catch (e) {
    if (e.status === 401) { backToLogin(); return; }
    $('#adminBoard').innerHTML = '<div class="err">加载失败：' + esc(e.message) + '</div>';
  }
}

async function openCell(day, cell) {
  const box = $('#dialog');
  box.innerHTML = '<div class="loading">加载中…</div>';
  $('#mask').hidden = false;

  let d;
  try {
    d = await api('/admin/cell?date=' + encodeURIComponent(day.date) + '&slotId=' + encodeURIComponent(cell.periodId));
  } catch (e) {
    box.innerHTML = '<div class="dlg-h">打不开</div><div class="dlg-meta">' + esc(e.message) + '</div>' +
      '<div class="dlg-btns"><button class="btn" data-act="close">关闭</button></div>';
    bindClose();
    return;
  }

  S.editing = d;
  renderCellDialog(d);
}

function renderCellDialog(d) {
  const box = $('#dialog');
  const where = d.weekday + ' ' + d.md + ' · ' + d.time;

  let html =
    '<div class="dlg-h">' + esc(where) + '</div>' +
    '<div class="dlg-meta">已报 ' + d.count + '/' + d.cap + ' 人' +
      (d.editable ? '' : ' · <span class="lock">只读</span>') + '</div>';

  if (!d.people.length) {
    html += '<div class="dlg-people"><i>还没有人报名</i></div>';
  } else {
    html += '<div class="people-list">';
    d.people.forEach((p) => {
      html += '<div class="prow">' +
        '<span class="pname">' + esc(p.nickname) + '</span>' +
        (p.byAdmin ? '<i class="pbadge">代报</i>' : '') +
        '<span class="ptime">' + hhmm(p.at) + '</span>' +
        '<button class="btn tiny" data-rn="' + esc(p.clientId) +
        '" data-name="' + esc(p.nickname) + '">改名</button>' +
        '<button class="btn tiny" data-rs="' + esc(p.clientId) + '">重置</button>' +
        (d.editable
          ? '<button class="btn tiny del" data-rm="' + esc(p.clientId) + '">移除</button>'
          : '') +
        '</div>';
    });
    html += '</div>';
  }

  if (!d.editable) {
    html += '<div class="dlg-note mute">' +
      (d.past ? '这一天已经过去' : (d.off ? '这个时段不开课' : '这个时段已经开课')) +
      '，只能查看，不能改动。</div>';
  } else if (d.count >= d.cap) {
    html += '<div class="dlg-note">名额已满（上限 ' + d.cap + ' 人），删掉一个才能再加。</div>';
  } else {
    html += '<div class="addrow">' +
      '<input id="addName" class="inp" placeholder="给谁代报？填昵称" maxlength="12">' +
      '<button class="btn primary" data-act="add">加进去</button>' +
      '</div>' +
      '<div class="hint" id="cellHint"></div>';
  }

  html += '<div class="dlg-btns"><button class="btn" data-act="close">关闭</button></div>';

  box.innerHTML = html;

  box.querySelectorAll('[data-rm]').forEach((b) => {
    b.addEventListener('click', () => removePerson(b.dataset.rm));
  });
  box.querySelectorAll('[data-rn]').forEach((b) => {
    b.addEventListener('click', () => renamePerson(b.dataset.rn, b.dataset.name));
  });
  box.querySelectorAll('[data-rs]').forEach((b) => {
    b.addEventListener('click', () => resetRenames(b.dataset.rs));
  });
  box.querySelectorAll('[data-act]').forEach((b) => {
    b.addEventListener('click', () => {
      const act = b.dataset.act;
      if (act === 'close') closeDialog();
      if (act === 'add') addPerson();
    });
  });
}

function bindClose() {
  $('#dialog').querySelectorAll('[data-act]').forEach((b) => {
    b.addEventListener('click', closeDialog);
  });
}

function closeDialog() {
  $('#mask').hidden = true;
  $('#dialog').innerHTML = '';
  S.editing = null;
}

async function removePerson(clientId) {
  const d = S.editing;
  if (!d) return;
  if (!confirm('确定把这个人从「' + d.weekday + ' ' + d.time + '」里移除？')) return;

  try {
    await api('/admin/remove', { date: d.date, slotId: d.slotId, clientId });
    await refreshCell();
  } catch (e) {
    alert('移除失败：' + e.message);
  }
}

async function renamePerson(clientId, oldName) {
  const v = prompt(
    '把「' + oldName + '」改成什么名字？\n\n' +
    '· 他名下所有报名记录会一起改名\n' +
    '· 改完会锁死他「自己改名」的机会（要放开就点「重置」）',
    oldName
  );
  if (v == null) return;
  const name = v.trim().slice(0, 12);
  if (!name || name === oldName) return;

  try {
    await api('/admin/rename', { clientId, nickname: name });
    await refreshCell();
    loadBoard();
    alert('已改成「' + name + '」。\n他那边打开会自动变过来，并且不能再自己改名。');
  } catch (e) {
    alert('改名失败：' + e.message);
  }
}

async function resetRenames(clientId) {
  if (!confirm('把这个人的「自己改名」次数恢复成 2 次？')) return;
  try {
    await api('/admin/resetrenames', { clientId });
    alert('已恢复，他可以自己再改 2 次了');
  } catch (e) {
    alert('重置失败：' + e.message);
  }
}

async function addPerson() {  const d = S.editing;
  if (!d) return;
  const input = $('#addName');
  const name = (input.value || '').trim();
  if (!name) { $('#cellHint').textContent = '先填个昵称'; return; }

  try {
    await api('/admin/sign', { date: d.date, slotId: d.slotId, nickname: name });
    await refreshCell();
  } catch (e) {
    const h = $('#cellHint');
    if (h) h.textContent = e.message;
    else alert('代报名失败：' + e.message);
  }
}

async function refreshCell() {
  const d = S.editing;
  if (!d) return;
  try {
    const fresh = await api('/admin/cell?date=' + encodeURIComponent(d.date) + '&slotId=' + encodeURIComponent(d.slotId));
    S.editing = fresh;
    renderCellDialog(fresh);
    loadBoard();
  } catch (e) {
    alert('刷新失败：' + e.message);
  }
}

/* ---------------- 切页 ---------------- */

function backToLogin() {
  $('#appPanel').hidden = true;
  $('#loginPanel').hidden = false;
  $('#loginHint').textContent = '登录已失效，请重新输入密码';
  resetPwd();
  try { sessionStorage.removeItem('bm_admin_key'); } catch (e) { /* 忽略 */ }
}

$('#pwdEye').addEventListener('click', () => {
  const el = $('#pwd');
  const show = el.type === 'password';
  el.type = show ? 'text' : 'password';
  $('#pwdEye').classList.toggle('is-on', show);
  $('#pwdEye').title = show ? '隐藏密码' : '显示密码';
  $('#pwdEye').setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
  el.focus();
  try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) { /* 忽略 */ }
});

function resetPwd() {
  const el = $('#pwd');
  if (!el) return;
  el.value = '';
  el.type = 'password';
  $('#pwdEye').classList.remove('is-on');
  $('#pwdEye').title = '显示密码';
  $('#pwdEye').setAttribute('aria-label', '显示密码');
}

$('#loginBtn').addEventListener('click', login);
$('#pwd').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });

$('#saveBtn').addEventListener('click', saveConfig);

const TABS = ['manage', 'schedule', 'roster'];
document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('on'));
    t.classList.add('on');
    TABS.forEach((id) => { $('#tab-' + id).hidden = t.dataset.tab !== id; });
    if (t.dataset.tab === 'roster') loadRoster();
  });
});

$('#mask').addEventListener('click', (e) => {
  if (e.target === $('#mask')) closeDialog();
});

// 有会话里的密码就直接进
if (S.key) {
  api('/admin/config')
    .then(() => enterApp())
    .catch(() => backToLogin());
}

/* ==================== 名单 ==================== */

function linkOf(code) {
  return 'https://bm-enroll.pages.dev/?k=' + code;
}

function fmtTime(ts) {
  if (!ts) return '还没进过';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

async function loadRoster() {
  const box = $('#rosterList');
  if (!box) return;
  try {
    const r = await api('/admin/roster');
    renderRoster(r.people || []);
  } catch (e) {
    if (e.status === 401) { backToLogin(); return; }
    box.innerHTML = '<div class="err">读取失败：' + esc(e.message) + '</div>';
  }
}

function renderRoster(people) {
  const box = $('#rosterList');
  const active = people.filter((p) => !p.disabled);
  const entered = active.filter((p) => p.devices > 0);

  $('#rosterCount').textContent = active.length;
  $('#rosterIn').textContent = entered.length;

  if (!people.length) {
    box.innerHTML = '<div class="none" style="padding:16px;color:#8b9099">名单还是空的，先在上面加人</div>';
    return;
  }

  box.innerHTML = '';
  people.forEach((p) => {
    const el = document.createElement('div');
    el.className = 'rrow' + (p.disabled ? ' is-off' : '');

    const devTag = (!p.disabled && p.devices > 1)
      ? '<i class="badge-warn">' + p.devices + ' 台设备</i>'
      : (p.devices ? p.devices + ' 台设备' : '未入场');

    el.innerHTML =
      '<span class="rname">' + esc(p.nick) + '</span>' +
      '<span class="rcode">' + esc(p.code) + '</span>' +
      '<span class="rmeta">' + devTag + ' · 报名 ' + p.signups + ' 次 · ' + fmtTime(p.lastSeen) + '</span>' +
      '<span class="racts">' +
        '<button class="btn tiny" data-copy="' + esc(p.code) + '">复制链接</button>' +
        '<button class="btn tiny" data-rotate="' + esc(p.nick) + '">换码</button>' +
        (p.disabled
          ? '<button class="btn tiny" data-restore="' + esc(p.nick) + '">恢复</button>'
          : '<button class="btn tiny warn" data-drop="' + esc(p.nick) + '">移出</button>') +
      '</span>';

    el.querySelectorAll('[data-copy]').forEach((b) => {
      b.addEventListener('click', () => copyLink(b.dataset.copy));
    });
    el.querySelectorAll('[data-rotate]').forEach((b) => {
      b.addEventListener('click', () => rotateCode(b.dataset.rotate));
    });
    el.querySelectorAll('[data-restore]').forEach((b) => {
      b.addEventListener('click', () => restorePerson(b.dataset.restore));
    });
    el.querySelectorAll('[data-drop]').forEach((b) => {
      b.addEventListener('click', () => dropPerson(b.dataset.drop));
    });

    box.appendChild(el);
  });
}

async function copyLink(code) {
  const text = linkOf(code);
  try {
    await navigator.clipboard.writeText(text);
    const hint = $('#rosterHint');
    hint.textContent = '已复制：' + text;
  } catch (e) {
    prompt('复制这条链接发给他：', text);
  }
}

async function addNames() {
  const raw = ($('#rosterInput').value || '').trim();
  if (!raw) { $('#rosterHint').textContent = '先输入名字'; return; }

  $('#rosterAdd').disabled = true;
  $('#rosterHint').textContent = '正在生成…';
  try {
    const r = await api('/admin/roster/add', { names: raw });
    $('#rosterInput').value = '';
    let msg = '已加入 ' + (r.added || []).length + ' 人';
    if (r.skipped && r.skipped.length) msg += '；已在名单里跳过：' + r.skipped.join('、');
    $('#rosterHint').textContent = msg;
    loadRoster();
  } catch (e) {
    $('#rosterHint').textContent = '失败：' + e.message;
  } finally {
    $('#rosterAdd').disabled = false;
  }
}

async function rotateCode(nick) {
  if (!confirm('给「' + nick + '」换一个新入场码？\n\n旧的链接会立刻失效，他的报名记录不受影响。')) return;
  try {
    const r = await api('/admin/roster/rotate', { nick });
    $('#rosterHint').textContent = nick + ' 的新码：' + r.code;
    loadRoster();
  } catch (e) {
    alert('换码失败：' + e.message);
  }
}

async function dropPerson(nick) {
  const clear = confirm(
    '把「' + nick + '」移出名单？\n\n' +
    '点『确定』= 同时删掉她名下的报名（释放名额）\n' +
    '点『取消』= 再问一次要不要保留报名'
  );
  let clearSignups = clear;
  if (!clear) {
    clearSignups = !confirm('保留她名下的报名吗？\n\n点『确定』= 保留报名，只断登录\n点『取消』= 一起删掉');
  }
  try {
    const r = await api('/admin/roster/remove', { nick, clearSignups });
    $('#rosterHint').textContent = '已移出 ' + nick +
      (r.removedSignups ? '，同时删除 ' + r.removedSignups + ' 条报名' : '');
    loadRoster();
    loadBoard();
  } catch (e) {
    alert('操作失败：' + e.message);
  }
}

async function restorePerson(nick) {
  try {
    await api('/admin/roster/restore', { nick });
    $('#rosterHint').textContent = '已恢复 ' + nick;
    loadRoster();
  } catch (e) {
    alert('恢复失败：' + e.message);
  }
}

async function exportCsv(week) {
  try {
    const r = await fetch('/api/admin/export?week=' + week, { headers: { 'x-admin-key': S.key } });
    if (!r.ok) { alert('导出失败，请重新登录'); return; }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '报名_' + (week ? '下周' : '本周') + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  } catch (e) {
    alert('导出失败：' + e.message);
  }
}

$('#rosterAdd').addEventListener('click', addNames);
$('#exportThis').addEventListener('click', () => exportCsv(0));
$('#exportNext').addEventListener('click', () => exportCsv(1));
