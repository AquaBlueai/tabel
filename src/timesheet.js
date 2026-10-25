const ExcelJS = require('exceljs');
const { db, getSettings } = require('./db');

const TZ = process.env.TZ_NAME || 'Asia/Tashkent';

// HR қўлда қўядиган белгилар
const MARK_CODES = {
  'Т': 'Таътил',
  'КВ': 'Касаллик варақаси',
  'ХС': 'Хизмат сафари',
  'Р': 'Рухсат билан',
  'С': 'Сабабсиз келмаган',
};
// Автоматик белгилар
const AUTO_CODES = {
  'Д': 'Дам олиш / байрам',
  'Й': 'Келмаган (белгиланмаган)',
};

const WEEKDAYS = ['Як', 'Ду', 'Се', 'Чо', 'Па', 'Жу', 'Ша'];

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function localParts(d = new Date()) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(d)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm || '0:0').split(':').map(Number);
  return h * 60 + (m || 0);
};

// "YYYY-MM-DD" + "HH:MM" маҳаллий вақтни UTC ISO га ўгиради
function localToIso(date, time) {
  const guess = new Date(`${date}T${time}:00Z`);
  const shown = localParts(guess);
  const diffMin = (new Date(`${shown.date}T${shown.time}:00Z`) - guess) / 60000;
  return new Date(guess.getTime() - diffMin * 60000).toISOString();
}

function isLate(checkInIso, s = getSettings()) {
  if (!checkInIso) return false;
  return localParts(checkInIso).minutes > toMinutes(s.work_start) + Number(s.late_grace_min || 0);
}

function workedHours(rec) {
  if (!rec?.check_in || !rec?.check_out) return 0;
  return Math.max(0, (new Date(rec.check_out) - new Date(rec.check_in)) / 3600000);
}

function isDayOff(dateStr, s) {
  const weekend = String(s.weekend_days || '').split(',').filter(Boolean).map(Number);
  const holidays = String(s.holidays || '').split(',').map((x) => x.trim());
  const wd = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return weekend.includes(wd) || holidays.includes(dateStr);
}

function monthDays(month) {
  const [y, m] = month.split('-').map(Number);
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => {
    const date = `${month}-${String(i + 1).padStart(2, '0')}`;
    return { d: i + 1, date, weekday: WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()] };
  });
}

function buildCell(date, rec, mark, s, today, since) {
  const off = isDayOff(date, s);
  if (mark) return { code: mark, kind: 'mark' };
  if (rec?.check_in) {
    const hours = workedHours(rec);
    return {
      kind: 'work',
      in: localParts(rec.check_in).time,
      out: rec.check_out ? localParts(rec.check_out).time : null,
      hours: Math.round(hours * 10) / 10,
      late: !off && isLate(rec.check_in, s),
      open: !rec.check_out, // кетганини белгиламаган
      edited: !!rec.edited_by_hr,
    };
  }
  if (off) return { code: 'Д', kind: 'off' };
  if (date < today && date >= since) return { code: 'Й', kind: 'absent' };
  return { kind: 'empty' };
}

function buildTimesheet(month, { includeInactive = false } = {}) {
  const s = getSettings();
  const days = monthDays(month);
  days.forEach((d) => { d.off = isDayOff(d.date, s); });
  const today = localParts().date;

  const employees = db.prepare(
    `SELECT * FROM employees WHERE status ${includeInactive ? "!= 'pending'" : "= 'active'"} ORDER BY department, full_name`
  ).all();
  const att = db.prepare('SELECT * FROM attendance WHERE date LIKE ?').all(`${month}-%`);
  const marks = db.prepare('SELECT * FROM day_marks WHERE date LIKE ?').all(`${month}-%`);
  const attMap = new Map(att.map((r) => [`${r.employee_id}|${r.date}`, r]));
  const markMap = new Map(marks.map((r) => [`${r.employee_id}|${r.date}`, r.code]));

  const rows = employees.map((e) => {
    const totals = { worked: 0, hours: 0, late: 0, absent: 0, marks: {} };
    const since = localParts(`${e.created_at.replace(' ', 'T')}Z`).date; // қўшилгунча «келмаган» ҳисобланмайди
    const cells = days.map(({ date }) => {
      const cell = buildCell(date, attMap.get(`${e.id}|${date}`), markMap.get(`${e.id}|${date}`), s, today, since);
      if (cell.kind === 'work') {
        totals.worked++;
        totals.hours += cell.hours;
        if (cell.late) totals.late++;
      } else if (cell.kind === 'absent') totals.absent++;
      else if (cell.kind === 'mark') totals.marks[cell.code] = (totals.marks[cell.code] || 0) + 1;
      return cell;
    });
    totals.hours = Math.round(totals.hours * 10) / 10;
    const workDays = days.filter((d) => !d.off && d.date >= since).length;
    return { employee: e, cells, totals: { ...totals, norm_days: workDays } };
  });

  return { month, company: s.company_name, days, rows, codes: { ...MARK_CODES, ...AUTO_CODES } };
}

async function timesheetXlsx(month) {
  const ts = buildTimesheet(month, { includeInactive: true });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(`Табель ${month}`, { views: [{ state: 'frozen', xSplit: 3, ySplit: 3 }] });

  const markKeys = Object.keys(MARK_CODES);
  const header = ['№', 'Ф.И.Ш.', 'Лавозими', ...ts.days.map((d) => d.d), 'Иш куни', 'Соат', 'Кечикиш', 'Келмаган', ...markKeys];
  ws.addRow([`${ts.company} — ${month} ойи учун иш вақтини ҳисобга олиш табели`]);
  ws.mergeCells(1, 1, 1, header.length);
  ws.getRow(1).font = { bold: true, size: 14 };
  const h = ws.addRow(header);
  const wdRow = ws.addRow(['', '', '', ...ts.days.map((d) => d.weekday)]);
  [h, wdRow].forEach((r) => { r.font = { bold: true }; r.alignment = { horizontal: 'center' }; });

  const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
  ts.rows.forEach((r, i) => {
    const vals = r.cells.map((c) => (c.kind === 'work' ? c.hours || (c.open ? '?' : 0) : c.code || ''));
    const row = ws.addRow([
      i + 1, r.employee.full_name, r.employee.position, ...vals,
      r.totals.worked, r.totals.hours, r.totals.late, r.totals.absent,
      ...markKeys.map((k) => r.totals.marks[k] || 0),
    ]);
    r.cells.forEach((c, j) => {
      const cell = row.getCell(4 + j);
      cell.alignment = { horizontal: 'center' };
      if (c.kind === 'off') cell.fill = fill('FFEEEEEE');
      else if (c.kind === 'absent') cell.fill = fill('FFFFD6D6');
      else if (c.kind === 'mark') cell.fill = fill('FFDCE8FF');
      else if (c.late) cell.fill = fill('FFFFF1C2');
    });
  });

  ws.getColumn(1).width = 4;
  ws.getColumn(2).width = 30;
  ws.getColumn(3).width = 18;
  ts.days.forEach((_, j) => { ws.getColumn(4 + j).width = 5; });
  ws.addRow([]);
  ws.addRow(['', 'Белгилар: рақам — ишланган соат; ' + Object.entries(ts.codes).map(([k, v]) => `${k} — ${v}`).join('; ')]);
  ws.addRow(['', 'Сариқ — кечикиш, қизил — келмаган, кулранг — дам олиш куни']);
  return wb.xlsx.writeBuffer();
}

module.exports = {
  TZ, MARK_CODES, localParts, localToIso, isLate, workedHours, isDayOff, buildTimesheet, timesheetXlsx,
};
