const path = require('node:path');
const express = require('express');
const { db, getSettings, saveSettings } = require('./db');
const { adminLogin, requireAdmin, requireTelegram } = require('./auth');
const ts = require('./timesheet');
const { startBot, notifyAdmins } = require('./bot');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/', (req, res) => res.redirect('/admin/'));

const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const MONTH_RE = /^\d{4}-\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2
    + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function publicRecord(rec, s) {
  if (!rec) return null;
  return {
    date: rec.date,
    check_in: rec.check_in ? ts.localParts(rec.check_in).time : null,
    check_out: rec.check_out ? ts.localParts(rec.check_out).time : null,
    hours: Math.round(ts.workedHours(rec) * 10) / 10,
    late: !ts.isDayOff(rec.date, s) && ts.isLate(rec.check_in, s),
  };
}

/* ───────────── Ходим (Telegram Mini App) ───────────── */

const findByTg = (id) => db.prepare('SELECT * FROM employees WHERE telegram_id = ?').get(id);

app.get('/api/me', requireTelegram, (req, res) => {
  const s = getSettings();
  const emp = findByTg(req.tgUser.id);
  const today = ts.localParts().date;
  const rec = emp && db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND date = ?').get(emp.id, today);
  res.json({
    tg: req.tgUser,
    employee: emp || null,
    today: publicRecord(rec, s),
    now: ts.localParts(),
    tz: ts.TZ,
    settings: {
      company_name: s.company_name,
      work_start: s.work_start,
      work_end: s.work_end,
      geofence: !!(s.office_lat && s.office_lng),
      require_location: s.require_location === '1',
    },
  });
});

app.post('/api/register', requireTelegram, asyncH(async (req, res) => {
  const { full_name, position = '', phone = '' } = req.body || {};
  if (!full_name || full_name.trim().length < 3) return res.status(400).json({ error: 'Ф.И.Ш. ни тўлиқ киритинг' });
  if (findByTg(req.tgUser.id)) return res.status(409).json({ error: 'Сиз аллақачон рўйхатдан ўтгансиз' });
  db.prepare(`INSERT INTO employees (full_name, position, phone, telegram_id, telegram_username, status)
              VALUES (?, ?, ?, ?, ?, 'pending')`)
    .run(full_name.trim(), position.trim(), phone.trim(), req.tgUser.id, req.tgUser.username || '');
  notifyAdmins(`🆕 Янги ходим рўйхатдан ўтди: ${full_name.trim()} (${position || '—'}). Веб-панелда тасдиқланг.`);
  res.json({ ok: true });
}));

app.post('/api/check', requireTelegram, (req, res) => {
  const { type, lat, lng } = req.body || {};
  if (!['in', 'out'].includes(type)) return res.status(400).json({ error: 'Нотўғри сўров' });
  const emp = findByTg(req.tgUser.id);
  if (!emp) return res.status(403).json({ error: 'Аввал рўйхатдан ўтинг' });
  if (emp.status !== 'active') return res.status(403).json({ error: 'Ҳисобингиз HR томонидан ҳали тасдиқланмаган' });

  const s = getSettings();
  const hasLoc = Number.isFinite(lat) && Number.isFinite(lng);
  if (s.office_lat && s.office_lng) {
    if (!hasLoc && s.require_location === '1') {
      return res.status(400).json({ error: 'Геолокацияга рухсат беринг — офисда эканлигингиз текширилади' });
    }
    if (hasLoc) {
      const dist = distanceM(lat, lng, Number(s.office_lat), Number(s.office_lng));
      if (dist > Number(s.office_radius_m || 200)) {
        return res.status(400).json({ error: `Сиз офисдан ${Math.round(dist)} м узоқдасиз. Белгилаш фақат офисда мумкин.` });
      }
    }
  }

  const now = new Date().toISOString();
  const today = ts.localParts().date;
  const rec = db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND date = ?').get(emp.id, today);
  if (type === 'in') {
    if (rec?.check_in) return res.status(409).json({ error: `Бугун келганингиз ${ts.localParts(rec.check_in).time} да белгиланган` });
    db.prepare(`INSERT INTO attendance (employee_id, date, check_in, in_lat, in_lng) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(employee_id, date) DO UPDATE SET check_in = excluded.check_in, in_lat = excluded.in_lat, in_lng = excluded.in_lng`)
      .run(emp.id, today, now, hasLoc ? lat : null, hasLoc ? lng : null);
  } else {
    if (!rec?.check_in) return res.status(409).json({ error: 'Аввал келганингизни белгиланг' });
    // Қайта босилса — охирги кетиш вақти ёзилади
    db.prepare('UPDATE attendance SET check_out = ?, out_lat = ?, out_lng = ? WHERE id = ?')
      .run(now, hasLoc ? lat : null, hasLoc ? lng : null, rec.id);
  }
  const updated = db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND date = ?').get(emp.id, today);
  res.json({ ok: true, today: publicRecord(updated, s) });
});

app.get('/api/my-history', requireTelegram, (req, res) => {
  const month = MONTH_RE.test(req.query.month) ? req.query.month : ts.localParts().date.slice(0, 7);
  const emp = findByTg(req.tgUser.id);
  if (!emp || emp.status !== 'active') return res.status(403).json({ error: 'Рухсат йўқ' });
  const full = ts.buildTimesheet(month);
  const row = full.rows.find((r) => r.employee.id === emp.id);
  res.json({ month, days: full.days, cells: row?.cells || [], totals: row?.totals, codes: full.codes });
});

/* ───────────── HR веб-панели ───────────── */

app.post('/api/admin/login', (req, res) => {
  const token = adminLogin(req.body?.username, req.body?.password);
  if (!token) return res.status(401).json({ error: 'Логин ёки пароль нотўғри' });
  res.json({ token });
});

app.use('/api/admin', requireAdmin);

app.get('/api/admin/today', (req, res) => {
  const s = getSettings();
  const today = ts.localParts().date;
  const rows = db.prepare(`
    SELECT e.id, e.full_name, e.position, e.department, a.check_in, a.check_out, m.code AS mark
    FROM employees e
    LEFT JOIN attendance a ON a.employee_id = e.id AND a.date = ?
    LEFT JOIN day_marks m ON m.employee_id = e.id AND m.date = ?
    WHERE e.status = 'active' ORDER BY e.full_name`).all(today, today);
  const list = rows.map((r) => ({
    id: r.id, full_name: r.full_name, position: r.position, department: r.department, mark: r.mark,
    check_in: r.check_in ? ts.localParts(r.check_in).time : null,
    check_out: r.check_out ? ts.localParts(r.check_out).time : null,
    late: ts.isLate(r.check_in, s),
  }));
  const dayOff = ts.isDayOff(today, s);
  if (dayOff) list.forEach((r) => { r.late = false; });
  const pending = db.prepare("SELECT COUNT(*) AS c FROM employees WHERE status = 'pending'").get().c;
  res.json({ date: today, day_off: dayOff, list, pending });
});

app.get('/api/admin/employees', (req, res) => {
  res.json(db.prepare("SELECT * FROM employees ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, full_name").all());
});

app.post('/api/admin/employees', (req, res) => {
  const { full_name, position = '', department = '', phone = '', telegram_id = null } = req.body || {};
  if (!full_name) return res.status(400).json({ error: 'Ф.И.Ш. мажбурий' });
  try {
    const r = db.prepare(`INSERT INTO employees (full_name, position, department, phone, telegram_id, status)
                          VALUES (?, ?, ?, ?, ?, 'active')`)
      .run(full_name, position, department, phone, telegram_id ? Number(telegram_id) : null);
    res.json({ id: Number(r.lastInsertRowid) });
  } catch (e) {
    res.status(409).json({ error: 'Бу Telegram ID бошқа ходимга бириктирилган' });
  }
});

app.put('/api/admin/employees/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Топилмади' });
  const e = { ...cur, ...req.body };
  if (!['pending', 'active', 'inactive'].includes(e.status)) return res.status(400).json({ error: 'Нотўғри статус' });
  try {
    db.prepare(`UPDATE employees SET full_name = ?, position = ?, department = ?, phone = ?, telegram_id = ?, status = ? WHERE id = ?`)
      .run(e.full_name, e.position, e.department, e.phone, e.telegram_id ? Number(e.telegram_id) : null, e.status, cur.id);
    res.json({ ok: true });
  } catch {
    res.status(409).json({ error: 'Бу Telegram ID бошқа ходимга бириктирилган' });
  }
});

app.delete('/api/admin/employees/:id', (req, res) => {
  db.prepare('DELETE FROM employees WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/timesheet', (req, res) => {
  if (!MONTH_RE.test(req.query.month)) return res.status(400).json({ error: 'month=YYYY-MM' });
  res.json(ts.buildTimesheet(req.query.month, { includeInactive: req.query.all === '1' }));
});

app.get('/api/admin/timesheet.xlsx', asyncH(async (req, res) => {
  if (!MONTH_RE.test(req.query.month)) return res.status(400).json({ error: 'month=YYYY-MM' });
  const buf = await ts.timesheetXlsx(req.query.month);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="tabel-${req.query.month}.xlsx"`);
  res.send(Buffer.from(buf));
}));

// Кун бўйича қўлда таҳрир: вақтлар ва/ёки белги (сана оралиғи учун ҳам)
app.put('/api/admin/day', (req, res) => {
  const { employee_id, date, date_to, check_in, check_out, code } = req.body || {};
  if (!employee_id || !DATE_RE.test(date)) return res.status(400).json({ error: 'employee_id ва date мажбурий' });
  if (code && !ts.MARK_CODES[code]) return res.status(400).json({ error: 'Нотўғри белги' });
  if ((check_in && !TIME_RE.test(check_in)) || (check_out && !TIME_RE.test(check_out))) {
    return res.status(400).json({ error: 'Вақт формати HH:MM' });
  }
  if (check_out && !check_in) return res.status(400).json({ error: 'Кетиш вақти учун келиш вақти керак' });
  if (check_in && check_out && check_out <= check_in) return res.status(400).json({ error: 'Кетиш вақти келишдан кейин бўлиши керак' });

  const dates = [];
  const end = DATE_RE.test(date_to || '') && date_to > date ? date_to : date;
  for (let d = new Date(`${date}T00:00:00Z`); d <= new Date(`${end}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  if (dates.length > 366) return res.status(400).json({ error: 'Оралиқ жуда катта' });

  for (const day of dates) {
    if (code) {
      db.prepare('INSERT INTO day_marks (employee_id, date, code) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET code = excluded.code')
        .run(employee_id, day, code);
    } else {
      db.prepare('DELETE FROM day_marks WHERE employee_id = ? AND date = ?').run(employee_id, day);
    }
    if (dates.length > 1) continue; // оралиқ учун фақат белги қўйилади
    if (check_in) {
      db.prepare(`INSERT INTO attendance (employee_id, date, check_in, check_out, edited_by_hr) VALUES (?, ?, ?, ?, 1)
                  ON CONFLICT(employee_id, date) DO UPDATE SET check_in = excluded.check_in, check_out = excluded.check_out, edited_by_hr = 1`)
        .run(employee_id, day, ts.localToIso(day, check_in), check_out ? ts.localToIso(day, check_out) : null);
    } else {
      db.prepare('DELETE FROM attendance WHERE employee_id = ? AND date = ?').run(employee_id, day);
    }
  }
  res.json({ ok: true });
});

app.get('/api/admin/settings', (req, res) => res.json({ settings: getSettings(), tz: ts.TZ }));
app.put('/api/admin/settings', (req, res) => {
  const b = req.body || {};
  if ((b.work_start && !TIME_RE.test(b.work_start)) || (b.work_end && !TIME_RE.test(b.work_end))) {
    return res.status(400).json({ error: 'Вақт формати HH:MM' });
  }
  saveSettings(b);
  res.json({ ok: true, settings: getSettings() });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Сервер хатоси' });
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`Табель сервери: http://localhost:${PORT}  (HR панел: /admin/, Mini App: /app/)`);
  startBot();
});
