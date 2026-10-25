const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MARKS = { 'Т': 'Таътил', 'КВ': 'Касаллик варақаси', 'ХС': 'Хизмат сафари', 'Р': 'Рухсат билан', 'С': 'Сабабсиз келмаган' };
const STATUS = { pending: ['Кутмоқда', 'b-warn'], active: ['Фаол', 'b-ok'], inactive: ['Бўшаган', 'b-muted'] };

let token = localStorage.getItem('tabel_token');
let tsData = null;
let currentTab = 'today';

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  if (res.status === 401 && !path.endsWith('/login')) { logout(); throw new Error('Сессия тугади'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Хатолик');
  return data;
}

/* ── Кириш ── */
function showLogin() { $('#login').classList.remove('hidden'); $('#appShell').classList.add('hidden'); }
function logout() { token = null; localStorage.removeItem('tabel_token'); showLogin(); }
$('#logout').onclick = logout;
$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const r = await api('/api/admin/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(f)) });
    token = r.token;
    localStorage.setItem('tabel_token', token);
    start();
  } catch (err) {
    $('#loginErr').innerHTML = `<div class="err">${esc(err.message)}</div>`;
  }
};

/* ── Табларни алмаштириш ── */
document.querySelectorAll('nav button').forEach((b) => {
  b.onclick = () => switchTab(b.dataset.tab);
});
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
  document.querySelectorAll('main > section').forEach((s) => s.classList.toggle('hidden', s.id !== `tab-${tab}`));
  ({ today: loadToday, timesheet: loadTimesheet, employees: loadEmployees, settings: loadSettings })[tab]();
}

/* ── Бугун ── */
async function loadToday() {
  const d = await api('/api/admin/today');
  updatePending(d.pending);
  const came = d.list.filter((r) => r.check_in);
  const left = d.list.filter((r) => r.check_out);
  const late = d.list.filter((r) => r.late);
  const marked = d.list.filter((r) => r.mark && !r.check_in);
  const absent = d.list.filter((r) => !r.check_in && !r.mark);
  const statusOf = (r) => {
    if (r.mark && !r.check_in) return `<span class="badge b-mark">${esc(MARKS[r.mark] || r.mark)}</span>`;
    if (!r.check_in) return d.day_off ? '<span class="badge b-muted">Дам олиш</span>' : '<span class="badge b-bad">Келмаган</span>';
    if (r.check_out) return '<span class="badge b-muted">Кетди</span>';
    return r.late ? '<span class="badge b-warn">Ишда · кечикди</span>' : '<span class="badge b-ok">Ишда</span>';
  };
  $('#tab-today').innerHTML = `
    <h2>Бугун, ${esc(d.date)} ${d.day_off ? '<span class="badge b-muted">дам олиш куни</span>' : ''}</h2>
    <div class="stats">
      <div class="stat"><b>${d.list.length}</b><span>Жами ходим</span></div>
      <div class="stat"><b style="color:var(--ok)">${came.length}</b><span>Келди</span></div>
      <div class="stat"><b style="color:var(--warn)">${late.length}</b><span>Кечикди</span></div>
      <div class="stat"><b>${left.length}</b><span>Кетди</span></div>
      <div class="stat"><b style="color:var(--mark)">${marked.length}</b><span>Таътил / касал / сафар</span></div>
      <div class="stat"><b style="color:var(--bad)">${d.day_off ? 0 : absent.length}</b><span>Келмаган</span></div>
    </div>
    <div class="tablewrap"><table class="list">
      <tr><th>Ф.И.Ш.</th><th>Лавозим</th><th>Келди</th><th>Кетди</th><th>Ҳолат</th><th></th></tr>
      ${d.list.map((r) => `<tr>
        <td>${esc(r.full_name)}</td><td class="hint">${esc(r.position)}</td>
        <td>${r.check_in || '—'}</td><td>${r.check_out || '—'}</td><td>${statusOf(r)}</td>
        <td><button class="sm" data-edit="${r.id}">Таҳрир</button></td></tr>`).join('')
        || '<tr><td colspan="6" class="hint">Фаол ходимлар йўқ</td></tr>'}
    </table></div>`;
  $('#tab-today').querySelectorAll('[data-edit]').forEach((b) => {
    const r = d.list.find((x) => x.id === +b.dataset.edit);
    b.onclick = () => editDay({ employee: r, date: d.date, check_in: r.check_in, check_out: r.check_out, code: r.mark }, loadToday);
  });
}

function updatePending(n) {
  const el = $('#pendingBadge');
  el.textContent = n;
  el.classList.toggle('hidden', !n);
}

/* ── Табель ── */
const monthInput = $('#month');
monthInput.value = new Date().toISOString().slice(0, 7);
monthInput.onchange = loadTimesheet;
$('#tsAll').onchange = loadTimesheet;
$('#tsFilter').oninput = renderTimesheet;
$('#prevM').onclick = () => shiftMonth(-1);
$('#nextM').onclick = () => shiftMonth(1);
function shiftMonth(delta) {
  const [y, m] = monthInput.value.split('-').map(Number);
  monthInput.value = new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
  loadTimesheet();
}
$('#exportXlsx').onclick = async () => {
  const res = await fetch(`/api/admin/timesheet.xlsx?month=${monthInput.value}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return alert('Юклаб бўлмади');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await res.blob());
  a.download = `tabel-${monthInput.value}.xlsx`;
  a.click();
  URL.revokeObjectURL(a.href);
};

async function loadTimesheet() {
  tsData = await api(`/api/admin/timesheet?month=${monthInput.value}${$('#tsAll').checked ? '&all=1' : ''}`);
  renderTimesheet();
}

function renderTimesheet() {
  if (!tsData) return;
  const q = $('#tsFilter').value.trim().toLowerCase();
  const rows = tsData.rows.filter((r) => !q || r.employee.full_name.toLowerCase().includes(q));
  const head = `<tr><th class="name">Ходим</th>${tsData.days.map((d) =>
    `<th class="${d.off ? 'off' : ''}">${d.d}<small>${d.weekday}</small></th>`).join('')}
    <th class="tot">Кун</th><th class="tot">Соат</th><th class="tot">Кечик.</th><th class="tot">Йўқ</th></tr>`;
  const body = rows.map((r) => `<tr>
    <td class="name">${esc(r.employee.full_name)}<small>${esc(r.employee.position)}</small></td>
    ${r.cells.map((c, i) => {
      let cls = 'c ' + (c.kind || ''), txt = '';
      if (c.kind === 'work') {
        cls = 'c work' + (c.late ? ' late' : '') + (c.open ? ' open' : '');
        txt = c.open ? `${c.in}<small>—</small>` : `${c.hours}<small>${c.in}</small>`;
      } else if (c.code) txt = c.code;
      const title = c.kind === 'work' ? `${c.in} – ${c.out || '?'}${c.late ? ' (кечикди)' : ''}${c.edited ? ' · HR таҳрири' : ''}` : (tsData.codes[c.code] || '');
      return `<td class="${cls}" data-r="${r.employee.id}" data-i="${i}" title="${esc(title)}">${txt}</td>`;
    }).join('')}
    <td class="tot">${r.totals.worked}/${r.totals.norm_days}</td><td class="tot">${r.totals.hours}</td>
    <td class="tot">${r.totals.late}</td><td class="tot">${r.totals.absent}</td></tr>`).join('');
  $('#tsTable').innerHTML = head + (body || `<tr><td class="name hint" colspan="${tsData.days.length + 5}">Ходимлар топилмади</td></tr>`);
  $('#tsTable').querySelectorAll('td.c').forEach((td) => {
    td.onclick = () => {
      const row = tsData.rows.find((r) => r.employee.id === +td.dataset.r);
      const c = row.cells[+td.dataset.i];
      editDay({ employee: row.employee, date: tsData.days[+td.dataset.i].date, check_in: c.in, check_out: c.out,
        code: c.kind === 'mark' ? c.code : '' }, loadTimesheet);
    };
  });
  $('#legend').innerHTML = `<span><b class="work" style="color:var(--ok)">8.5</b> ишланган соат</span>
    <span><b style="background:var(--warn-bg);color:var(--warn)">&nbsp;</b> кечикди</span>
    ${Object.entries(tsData.codes).map(([k, v]) => `<span><b class="badge b-mark">${esc(k)}</b> ${esc(v)}</span>`).join('')}`;
}

/* ── Кунни таҳрирлаш ойнаси ── */
function editDay({ employee, date, check_in, check_out, code }, onSaved) {
  openDialog(`
    <h2>${esc(employee.full_name)}</h2>
    <p class="hint">${esc(date)}</p>
    <div class="grid2">
      <label>Келди<input type="time" name="check_in" value="${check_in || ''}"></label>
      <label>Кетди<input type="time" name="check_out" value="${check_out || ''}"></label>
    </div>
    <label>Белги
      <select name="code"><option value="">— йўқ —</option>
        ${Object.entries(MARKS).map(([k, v]) => `<option value="${k}" ${code === k ? 'selected' : ''}>${k} — ${v}</option>`).join('')}
      </select></label>
    <label>…гача (оралиққа белги қўйиш учун, ихтиёрий)<input type="date" name="date_to" min="${date}"></label>
    <p class="hint" style="font-size:12px">Вақтларни ўчирсангиз — келди-кетди ёзуви ўчирилади. Оралиқ танланса фақат белги қўйилади.</p>`,
    async (f) => {
      await api('/api/admin/day', { method: 'PUT', body: JSON.stringify({ employee_id: employee.id, date, ...f }) });
      onSaved();
    });
}

/* ── Ходимлар ── */
let employees = [];
$('#empFilter').oninput = renderEmployees;
$('#addEmp').onclick = () => editEmployee(null);

async function loadEmployees() {
  employees = await api('/api/admin/employees');
  updatePending(employees.filter((e) => e.status === 'pending').length);
  renderEmployees();
}

function renderEmployees() {
  const q = $('#empFilter').value.trim().toLowerCase();
  const list = employees.filter((e) => !q || `${e.full_name} ${e.position} ${e.department} ${e.phone}`.toLowerCase().includes(q));
  $('#empTable').innerHTML = `<tr><th>Ф.И.Ш.</th><th>Лавозим</th><th>Бўлим</th><th>Телефон</th><th>Telegram</th><th>Ҳолат</th><th></th></tr>
    ${list.map((e) => `<tr>
      <td>${esc(e.full_name)}</td><td>${esc(e.position)}</td><td>${esc(e.department)}</td><td>${esc(e.phone)}</td>
      <td class="hint">${e.telegram_username ? '@' + esc(e.telegram_username) : esc(e.telegram_id || '—')}</td>
      <td><span class="badge ${STATUS[e.status][1]}">${STATUS[e.status][0]}</span></td>
      <td>${e.status === 'pending' ? `<button class="sm primary" data-approve="${e.id}">Тасдиқлаш</button> ` : ''}
        <button class="sm" data-edit="${e.id}">Таҳрир</button></td></tr>`).join('')
      || '<tr><td colspan="7" class="hint">Ходимлар йўқ</td></tr>'}`;
  $('#empTable').querySelectorAll('[data-approve]').forEach((b) => {
    b.onclick = async () => {
      await api(`/api/admin/employees/${b.dataset.approve}`, { method: 'PUT', body: JSON.stringify({ status: 'active' }) });
      loadEmployees();
    };
  });
  $('#empTable').querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => editEmployee(employees.find((e) => e.id === +b.dataset.edit));
  });
}

function editEmployee(e) {
  const v = e || { status: 'active' };
  openDialog(`
    <h2>${e ? 'Ходимни таҳрирлаш' : 'Янги ходим'}</h2>
    <label>Ф.И.Ш.<input name="full_name" required value="${esc(v.full_name)}"></label>
    <div class="grid2">
      <label>Лавозим<input name="position" value="${esc(v.position)}"></label>
      <label>Бўлим<input name="department" value="${esc(v.department)}"></label>
      <label>Телефон<input name="phone" value="${esc(v.phone)}"></label>
      <label>Telegram ID<input name="telegram_id" inputmode="numeric" value="${esc(v.telegram_id)}"></label>
    </div>
    ${e ? `<label>Ҳолат<select name="status">${Object.entries(STATUS).map(([k, [t]]) =>
      `<option value="${k}" ${v.status === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>` : ''}`,
    async (f) => {
      if (e) await api(`/api/admin/employees/${e.id}`, { method: 'PUT', body: JSON.stringify(f) });
      else await api('/api/admin/employees', { method: 'POST', body: JSON.stringify(f) });
      loadEmployees();
    },
    e && (async () => {
      if (!confirm(`${e.full_name} ва унинг барча табель ёзувлари ўчирилсинми? (Ишдан бўшаганлар учун «Бўшаган» ҳолатини қўйиш тавсия этилади)`)) return false;
      await api(`/api/admin/employees/${e.id}`, { method: 'DELETE' });
      loadEmployees();
      return true;
    }));
}

/* ── Созламалар ── */
async function loadSettings() {
  const { settings: s, tz } = await api('/api/admin/settings');
  const wd = ['Якшанба', 'Душанба', 'Сешанба', 'Чоршанба', 'Пайшанба', 'Жума', 'Шанба'];
  const weekend = s.weekend_days.split(',');
  $('#tab-settings').innerHTML = `<form class="settings card" id="setForm">
    <h2>Созламалар</h2>
    <div id="setMsg"></div>
    <fieldset><legend>Умумий</legend>
      <label>Ташкилот номи<input name="company_name" value="${esc(s.company_name)}"></label>
      <div class="grid2">
        <label>Иш бошланиши<input type="time" name="work_start" value="${esc(s.work_start)}"></label>
        <label>Иш тугаши<input type="time" name="work_end" value="${esc(s.work_end)}"></label>
      </div>
      <label>Кечикишга рухсат (дақиқа)<input type="number" min="0" name="late_grace_min" value="${esc(s.late_grace_min)}"></label>
      <p class="hint">Вақт зонаси: ${esc(tz)}</p>
    </fieldset>
    <fieldset><legend>Дам олиш кунлари</legend>
      ${wd.map((n, i) => `<label class="chk" style="margin-right:12px"><input type="checkbox" name="wd" value="${i}" ${weekend.includes(String(i)) ? 'checked' : ''}> ${n}</label>`).join('')}
      <label style="margin-top:12px">Байрам кунлари (вергул билан, YYYY-MM-DD)
        <input name="holidays" value="${esc(s.holidays)}" placeholder="2026-01-01, 2026-03-08, 2026-03-21"></label>
    </fieldset>
    <fieldset><legend>Офис геолокацияси</legend>
      <p class="hint">Тўлдирилса, ходим фақат офис радиуси ичида белгилай олади. Координаталарни Google/Yandex картадан олинг.</p>
      <div class="grid2">
        <label>Кенглик (lat)<input name="office_lat" value="${esc(s.office_lat)}" placeholder="41.311081"></label>
        <label>Узунлик (lng)<input name="office_lng" value="${esc(s.office_lng)}" placeholder="69.240562"></label>
      </div>
      <label>Радиус (метр)<input type="number" min="20" name="office_radius_m" value="${esc(s.office_radius_m)}"></label>
      <label class="chk"><input type="checkbox" name="require_location" ${s.require_location === '1' ? 'checked' : ''}> Геолокация мажбурий (рухсат бермаса белгилай олмайди)</label>
    </fieldset>
    <button class="primary" type="submit">Сақлаш</button>
  </form>`;
  $('#setForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const body = Object.fromEntries([...f].filter(([k]) => k !== 'wd'));
    body.weekend_days = f.getAll('wd').join(',');
    body.require_location = f.get('require_location') ? '1' : '0';
    body.holidays = String(body.holidays).split(',').map((x) => x.trim()).filter(Boolean).join(',');
    try {
      await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(body) });
      $('#company').textContent = body.company_name;
      $('#setMsg').innerHTML = '<p class="badge b-ok">Сақланди</p>';
    } catch (err) {
      $('#setMsg').innerHTML = `<div class="err">${esc(err.message)}</div>`;
    }
  };
}

/* ── Умумий диалог ── */
function openDialog(html, onSave, onDelete) {
  const dlg = $('#dlg');
  const form = $('#dlgForm');
  form.innerHTML = `<div id="dlgErr"></div>${html}
    <div class="dlg-actions">
      ${onDelete ? '<button type="button" class="danger" id="dlgDel" style="margin-right:auto">Ўчириш</button>' : ''}
      <button type="button" id="dlgCancel">Бекор қилиш</button>
      <button type="submit" class="primary">Сақлаш</button>
    </div>`;
  $('#dlgCancel').onclick = () => dlg.close();
  if (onDelete) $('#dlgDel').onclick = async () => { if (await onDelete()) dlg.close(); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await onSave(Object.fromEntries(new FormData(form)));
      dlg.close();
    } catch (err) {
      $('#dlgErr').innerHTML = `<div class="err">${esc(err.message)}</div>`;
    }
  };
  dlg.showModal();
}

/* ── Старт ── */
async function start() {
  $('#login').classList.add('hidden');
  $('#appShell').classList.remove('hidden');
  try {
    const { settings } = await api('/api/admin/settings');
    $('#company').textContent = settings.company_name;
    switchTab(currentTab);
  } catch { /* 401 бўлса logout() ўзи чақирилади */ }
}
setInterval(() => { if (token && currentTab === 'today') loadToday().catch(() => {}); }, 60000);
token ? start() : showLogin();
