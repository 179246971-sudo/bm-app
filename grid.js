/* 报名工具 · 网格渲染（会员页和管理页共用） */

(function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function cellClass(cell, past) {
    const cls = ['c'];
    if (past) cls.push('is-past');
    else if (cell.off) cls.push('is-off');
    else if (cell.full) cls.push('is-full');
    else if (cell.count > 0) cls.push('is-some');
    else cls.push('is-empty');
    if (cell.mine) cls.push('is-mine');
    if (!cell.open && !past && !cell.off && !cell.full) cls.push('is-closed');
    return cls.join(' ');
  }

  // 空格子留白（白底=空位可报），「—」只表示这个时段不开课
  function cellText(cell, past) {
    if (cell.off) return '—';
    if (cell.count > 0) return cell.count + '/' + cell.cap;
    return '';
  }

  function weekTable(w, onCell) {
    const table = document.createElement('table');
    table.className = 'grid';

    const thead = document.createElement('thead');
    const hr = document.createElement('tr');

    const corner = document.createElement('th');
    corner.className = 'corner';
    corner.innerHTML = '<b>' + esc(w.label) + '</b><span>' + esc(w.range) + '</span>';
    hr.appendChild(corner);

    w.days.forEach((day) => {
      const th = document.createElement('th');
      th.className = 'dh' + (day.past ? ' is-past' : '') + (day.isToday ? ' is-today' : '');
      th.innerHTML = '<b>' + esc(day.weekday) + '</b><span>' + esc(day.md) + '</span>';
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const periodCount = (w.days[0] && w.days[0].cells.length) || 0;

    for (let pi = 0; pi < periodCount; pi++) {
      const tr = document.createElement('tr');
      const ref = w.days[0].cells[pi];

      const tc = document.createElement('th');
      tc.className = 'tc';
      const parts = String(ref.time || '').split('-');
      tc.innerHTML = '<b>' + esc(parts[0] || '') + '</b><span>' + esc(parts[1] || '') + '</span>';
      tr.appendChild(tc);

      w.days.forEach((day) => {
        const cell = day.cells[pi];
        const td = document.createElement('td');
        td.className = cellClass(cell, day.past);
        td.textContent = cellText(cell, day.past);
        td.addEventListener('click', () => { if (onCell) onCell(day, cell); });
        tr.appendChild(td);
      });

      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    return table;
  }

  function renderGrid(container, data, opts) {
    opts = opts || {};
    const wrap = document.createElement('div');
    wrap.className = 'grids';
    data.weeks.forEach((w) => wrap.appendChild(weekTable(w, opts.onCell)));
    container.innerHTML = '';
    container.appendChild(wrap);
    return wrap;
  }

  function buildLegend() {
    const el = document.createElement('div');
    el.className = 'legend';
    el.innerHTML =
      '<span><i class="lg lg-full"></i>已满</span>' +
      '<span><i class="lg lg-some"></i>有人报</span>' +
      '<span><i class="lg lg-empty"></i>空着</span>' +
      '<span><i class="lg lg-past"></i>已过期</span>' +
      '<span><i class="lg lg-mine"></i>我报了</span>';
    return el;
  }

  globalThis.Grid = { renderGrid, buildLegend, esc };
})();
