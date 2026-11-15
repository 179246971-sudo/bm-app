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
  $('#cfgShowStats').checked = c.showStats !== false;

  const body = $('#pbody');
  body.innerHTML = '';
  (c.periods || []).forEach((p) => addPeriodRow(p.start, p.end, p.cap, p.id));

  const box = $('#dayOffBox');
  box.innerHTML = '';
  for (let d = 1; d <= 7; d++) {
    const dow = d % 7; // 1..6,0
    const label = document.createElement('label');
    label.className = 'chip' + ((c.dayOff || []).indexOf(dow) >= 0 ? ' on' : '');
    label.innerHTML = '<input type="checkbox" value="' + dow + '"' +
      ((c.dayOff || []).indexOf(dow) >= 0 ? ' checked' : '') + '><span>' + WEEK_CN[dow] + '</span>';
    box.appendChild(label);
  }
}

function addPeriodRow(start, end, cap, id) {
  const tr = document.createElement('tr');
  tr.dataset.id = id || '';
  tr.innerHTML =
    '<td><input type="time" class="p-start" value="' + (start || '09:00') + '"></td>' +
    '<td><input type="time" class="p-end" value="' + (end || '10:00') + '"></td>' +
    '<td><input type="number" class="p-cap" min="1" max="999" value="' + (cap || 8) + '"></td>' +
    '<td><button class="btn tiny del" type="button">删</button></td>';
  tr.querySelector('.del').addEventListener('click', () => tr.remove());
  $('#pbody').appendChild(tr);
}

function collectConfig() {
  const periods = [];
  const rows = $('#pbody').querySelectorAll('tr');
  let i = 0;
  rows.forEach((tr) => {
    const start = tr.querySelector('.p-start').value;
    const end = tr.querySelector('.p-end').value;
    const cap = parseInt(tr.querySelector('.p-cap').value, 10);
    if (!start || !end) return;
    // 老时段保留原 id，新时段生成新 id，历史报名才不会串格
    const id = tr.dataset.id || ('p' + Date.now().toString(36) + (i++));
    periods.push({ id, start, end, cap: Number.isFinite(cap) ? cap : 8 });
  });

  const dayOff = [];
  $('#dayOffBox').querySelectorAll('input:checked').forEach((x) => {
    dayOff.push(parseInt(x.value, 10));
  });

  return {
    title: $('#cfgTitle').value.trim() || 'Hihi Studio',
    subtitle: $('#cfgSub').value,
    cancelMin: parseInt($('#cfgCancel').value, 10) || 3,
    showStats: !!$('#cfgShowStats').checked,
    periods,
    dayOff,
    override: (S.cfg && S.cfg.override) || {}
  };
}

async function saveConfig() {
  const next = collectConfig();
  if (!next.periods.length) { $('#saveHint').textContent = '至少留一个时间段'; return; }

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
  try { sessionStorage.removeItem('bm_admin_key'); } catch (e) { /* 忽略 */ }
}

$('#loginBtn').addEventListener('click', login);
$('#pwd').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });

$('#addPeriod').addEventListener('click', () => addPeriodRow('09:00', '10:00', 8, ''));
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
