'use strict';
// Turns Windows power events (boot / shutdown / sleep / wake / crash) into usage sessions, and the
// Software Protection licensing checks into an "activated since" estimate. Pure functions; times are ISO strings.
// Both depend on how far back the event logs reach: logs are size-capped and can be cleared, so nothing here
// is a machine age.

const HOUR = 3600000, DAY = 24 * HOUR;
const RESTART_GAP = 3 * 60000; // A boot within 3 minutes of a clean shutdown is a restart.
const START = {boot:'Bật máy', restart:'Khởi động lại', wake:'Thức dậy'};
const END = {shutdown:'Tắt máy', sleep:'Ngủ / màn hình tắt', crash:'Mất điện / treo', running:'Đang chạy'};
// [provider suffix, event id] → event kind.
const KINDS = {'Kernel-General:12':'boot', 'Kernel-General:13':'shutdown', 'Kernel-Power:41':'crash', 'Kernel-Power:42':'sleep',
  'Kernel-Power:506':'sleep', 'Kernel-Power:507':'wake', 'Kernel-Power:107':'wake', 'Power-Troubleshooter:1':'wake'};

function kindOf(event) {
  const provider = String(event.Provider || '').replace(/^Microsoft-Windows-/, '');
  return KINDS[`${provider}:${Number(event.Id)}`] || null;
}

// Walks events oldest → newest. A session opens on boot / wake and closes on shutdown / sleep;
// a boot while a session is still open means the previous one ended without a clean shutdown.
function buildSessions(rawEvents, now = Date.now()) {
  const events = (Array.isArray(rawEvents) ? rawEvents : [])
    .map(e => ({t: Date.parse(e.Time), kind: kindOf(e)}))
    .filter(e => e.kind && Number.isFinite(e.t))
    .sort((a, b) => a.t - b.t);
  const sessions = [];
  let open = null, lastEnd = null;
  const close = (end, endKind) => { sessions.push({...open, end, endKind}); lastEnd = {t: end ?? open.start, kind: endKind}; open = null; };
  for (const e of events) {
    if (e.kind === 'boot') {
      if (open) close(null, 'crash');
      const restart = lastEnd?.kind === 'shutdown' && e.t - lastEnd.t <= RESTART_GAP;
      open = {start: e.t, startKind: restart ? 'restart' : 'boot'};
    } else if (e.kind === 'wake') {
      if (!open) open = {start: e.t, startKind: 'wake'};
    } else if (e.kind === 'sleep' || e.kind === 'shutdown') {
      if (open) close(e.t, e.kind);
    } else if (e.kind === 'crash' && open) {
      close(null, 'crash');
    }
  }
  if (open) close(now, 'running');
  return sessions.map(s => ({
    start: new Date(s.start).toISOString(), end: s.end === null ? null : new Date(s.end).toISOString(),
    durationMs: s.end === null ? null : Math.max(0, s.end - s.start),
    startKind: s.startKind, startLabel: START[s.startKind], endKind: s.endKind, endLabel: END[s.endKind]
  }));
}

const localDay = t => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
// Hours used per local calendar day for the last `days` days, splitting sessions that cross midnight.
function dailyHours(sessions, now = Date.now(), days = 30) {
  const today = localDay(now), first = today - (days - 1) * DAY;
  const buckets = Array.from({length: days}, (_, i) => ({day: new Date(first + i * DAY).toISOString(), hours: 0}));
  for (const s of sessions) {
    if (s.durationMs === null) continue;
    let from = Date.parse(s.start);
    const to = from + s.durationMs;
    while (from < to) {
      const dayStart = localDay(from), next = Math.min(to, dayStart + DAY);
      const index = Math.round((dayStart - first) / DAY);
      if (index >= 0 && index < days) buckets[index].hours += (next - from) / HOUR;
      from = next;
    }
  }
  buckets.forEach(b => { b.hours = Math.round(b.hours * 10) / 10; });
  return buckets;
}

function summarize(sessions, logStart, now = Date.now()) {
  const timed = sessions.filter(s => s.durationMs !== null);
  const totalMs = timed.reduce((sum, s) => sum + s.durationMs, 0);
  const from = Date.parse(logStart) || (sessions[0] ? Date.parse(sessions[0].start) : null);
  const spanDays = from ? Math.max(1, Math.ceil((now - from) / DAY)) : null;
  const usedDays = new Set(sessions.map(s => localDay(Date.parse(s.start)))).size;
  return {
    sessions: sessions.length, boots: sessions.filter(s => s.startKind !== 'wake').length,
    unexpected: sessions.filter(s => s.endKind === 'crash').length, totalHours: Math.round(totalMs / HOUR * 10) / 10,
    longestHours: timed.length ? Math.round(Math.max(...timed.map(s => s.durationMs)) / HOUR * 10) / 10 : null,
    since: from ? new Date(from).toISOString() : null, spanDays, usedDays,
    hoursPerDay: spanDays ? Math.round(totalMs / HOUR / spanDays * 10) / 10 : null
  };
}

// The SPP service logs licensing checks (event 1003) but never the activation moment itself.
function activationAge(row, now = Date.now()) {
  if (!row) return null;
  const first = Date.parse(row.FirstActivatedSeen), before = Date.parse(row.LastNotActivatedBefore), logStart = Date.parse(row.LogStartsAt);
  if (!Number.isFinite(first)) return {known: false, label: 'Chưa thấy lần kiểm tra nào báo đã kích hoạt trong nhật ký', since: null, days: null};
  const days = Math.max(0, Math.floor((now - first) / DAY));
  const date = t => new Date(t).toLocaleDateString('vi-VN');
  if (Number.isFinite(before)) return {known: true, exact: true, since: new Date(first).toISOString(), days,
    label: `Kích hoạt trong khoảng ${date(before)} – ${date(first)}`};
  return {known: true, exact: false, since: new Date(first).toISOString(), days,
    label: `Đã kích hoạt ít nhất từ ${date(first)}`, note: Number.isFinite(logStart) ? `Nhật ký chỉ còn từ ${date(logStart)}; có thể đã kích hoạt sớm hơn.` : 'Có thể đã kích hoạt sớm hơn thời điểm nhật ký còn lưu.'};
}

const fmtHours = ms => ms === null ? '' : `${Math.floor(ms / HOUR)} giờ ${Math.round(ms % HOUR / 60000)} phút`;
// Adds report.usage (for the Sử dụng page) and flat tables for the generic views and the exported report.
function enrichUsage(report, now = Date.now()) {
  const power = report?.sections?.powerEvents;
  const activation = activationAge(report?.sections?.activationHistory?.data?.[0], now);
  if (!power || power.status !== 'ok') { report.usage = {available: false, error: power?.error || null, activation}; return report; }
  const meta = power.data.find(e => e.LogStartsAt) || {};
  const sessions = buildSessions(power.data, now);
  const summary = summarize(sessions, meta.LogStartsAt, now);
  report.usage = {available: true, sessions: sessions.slice().reverse(), summary, daily: dailyHours(sessions, now), activation, logStartsAt: meta.LogStartsAt || null};
  report.sections.usageSessions = {status: 'ok', error: null, data: report.usage.sessions.slice(0, 200).map(s => ({
    'Bắt đầu': new Date(s.start).toLocaleString('vi-VN'), 'Kết thúc': s.end ? new Date(s.end).toLocaleString('vi-VN') : 'Không rõ',
    'Thời lượng': fmtHours(s.durationMs) || 'Không rõ', 'Mở bằng': s.startLabel, 'Kết thúc bằng': s.endLabel}))};
  return report;
}

module.exports = {buildSessions, dailyHours, summarize, activationAge, enrichUsage, kindOf, START, END};
