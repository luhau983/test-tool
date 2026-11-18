'use strict';
// Decodes raw drive data from smart.ps1 (NVMe identify + health log, ATA identify + Device
// Statistics + SMART table) and grades each drive Tốt / Cẩn thận / Xấu with the reasons.
// Thresholds are this app's own rules, documented next to each check; vendors may differ.

const STATUS = {good:'Tốt', caution:'Cẩn thận', bad:'Xấu', unknown:'Chưa rõ'};
const RANK = {unknown:0, good:1, caution:2, bad:3};
const worse = (a, b) => RANK[b] > RANK[a] ? b : a;
const HOURS_PER_DAY = 8; // Assumed daily use for the lifetime estimate; stated in the UI.

// Common names; SMART attribute meaning is vendor specific beyond the classic HDD set.
const ATA_NAMES = {
  0x01:'Read Error Rate',0x02:'Throughput Performance',0x03:'Spin-Up Time',0x04:'Start/Stop Count',0x05:'Reallocated Sectors Count',
  0x07:'Seek Error Rate',0x08:'Seek Time Performance',0x09:'Power-On Hours',0x0A:'Spin Retry Count',0x0B:'Recalibration Retries',
  0x0C:'Power Cycle Count',0xA9:'Remaining Life',0xAA:'Available Reserved Space',0xAB:'Program Fail Count',0xAC:'Erase Fail Count',
  0xAD:'Wear Leveling Count',0xAE:'Unexpected Power Loss Count',0xAF:'Program Fail Count (Chip)',0xB1:'Wear Leveling Count',
  0xB3:'Used Reserved Block Count',0xB4:'Unused Reserved Block Count',0xB5:'Program Fail Count (Total)',0xB6:'Erase Fail Count (Total)',
  0xB7:'SATA Downshift Error Count',0xB8:'End-to-End Error',0xBB:'Reported Uncorrectable Errors',0xBC:'Command Timeout',
  0xBD:'High Fly Writes',0xBE:'Airflow Temperature',0xBF:'G-Sense Error Rate',0xC0:'Power-off Retract Count',
  0xC1:'Load/Unload Cycle Count',0xC2:'Temperature',0xC3:'Hardware ECC Recovered',0xC4:'Reallocation Event Count',
  0xC5:'Current Pending Sector Count',0xC6:'Uncorrectable Sector Count',0xC7:'UltraDMA CRC Error Count',0xC8:'Write Error Rate',
  0xE7:'SSD Life Left',0xE8:'Available Reserved Space',0xE9:'Media Wearout Indicator',0xF1:'Total LBAs Written',0xF2:'Total LBAs Read'
};
// Raw count > 0 on these means sectors were remapped or are failing: "Cẩn thận".
const ATA_CAUTION_RAW = new Set([0x05, 0xC5, 0xC6]);
// Attributes whose normalized value is commonly the remaining SSD life in percent.
const ATA_LIFE = [0xE7, 0xA9, 0xB1, 0xAD, 0xE9];
const NVME_NAMES = ['Critical Warning','Composite Temperature','Available Spare','Available Spare Threshold','Percentage Used',
  'Data Units Read','Data Units Written','Host Read Commands','Host Write Commands','Controller Busy Time','Power Cycles',
  'Power On Hours','Unsafe Shutdowns','Media and Data Integrity Errors','Number of Error Information Log Entries'];

const bytes = b64 => b64 ? Buffer.from(String(b64), 'base64') : null;
const hex = (value, width) => value.toString(16).toUpperCase().padStart(width, '0');
// Little-endian unsigned integer of `len` bytes; exact up to 2^53, approximated above (counters never get there).
function uint(buf, offset, len) {
  let value = 0n;
  for (let i = len - 1; i >= 0; i--) value = (value << 8n) | BigInt(buf[offset + i] ?? 0);
  return Number(value);
}
const ascii = (buf, start, end) => buf.subarray(start, end).toString('latin1').replace(/\0/g, '').trim();
// ATA strings store two characters per word with the bytes swapped.
function ataString(buf, startWord, endWord) {
  let out = '';
  for (let w = startWord; w <= endWord; w++) out += String.fromCharCode(buf[w * 2 + 1], buf[w * 2]);
  return out.replace(/\0/g, '').trim();
}

function parseAtaIdentify(buf) {
  if (!buf || buf.length < 512) return null;
  const word = n => buf.readUInt16LE(n * 2), valid = n => word(n) !== 0 && word(n) !== 0xFFFF;
  const sectors = uint(buf, 200, 8) || (word(61) << 16 | word(60)) >>> 0;
  const sectorSize = valid(106) && (word(106) & 0xC000) === 0x4000 && word(106) & 0x1000 ? (word(117) | word(118) << 16) * 2 : 512;
  const gens = [null, 'SATA/150', 'SATA/300', 'SATA/600'];
  const maxGen = valid(76) ? [3, 2, 1].find(g => word(76) & (1 << g)) : null;
  const curGen = valid(77) ? (word(77) >> 1) & 7 : 0;
  const acs = valid(80) ? [[11,'ACS-4'],[10,'ACS-3'],[9,'ACS-2'],[8,'ATA8-ACS'],[7,'ATA/ATAPI-7']].find(([bit]) => word(80) & (1 << bit))?.[1] : null;
  const sataRev = valid(222) && (word(222) >> 12) === 1 ? [[10,'SATA 3.5'],[9,'SATA 3.4'],[8,'SATA 3.3'],[7,'SATA 3.2'],[6,'SATA 3.1'],[5,'SATA 3.0'],[4,'SATA 2.6'],[3,'SATA 2.5']].find(([bit]) => word(222) & (1 << bit))?.[1] : null;
  const features = [
    [word(82) & 1, 'S.M.A.R.T.'], [word(83) & 0x400, '48bit LBA'], [valid(76) && word(76) & 0x100, 'NCQ'],
    [word(169) & 1, 'TRIM'], [valid(78) && word(78) & 0x100, 'DevSleep'], [word(83) & 8, 'APM'], [word(82) & 0x20, 'Write Cache']
  ].filter(([on]) => on).map(([, name]) => name);
  const rotation = word(217);
  return {
    model: ataString(buf, 27, 46), serial: ataString(buf, 10, 19), firmware: ataString(buf, 23, 26),
    capacity: sectors ? sectors * sectorSize : null, sectorSize,
    rotation: rotation === 1 ? 'SSD' : rotation >= 0x401 && rotation < 0xFFFF ? `${rotation} RPM` : null,
    transferMode: maxGen ? `${gens[curGen] || '----'} | ${gens[maxGen]}` : null,
    standard: [acs, sataRev].filter(Boolean).join(' | ') || null, features
  };
}

// ATA Device Statistics log (0x04): each statistic is a qword, bit 63 = supported, bit 62 = valid.
function parseDevStats(pages) {
  const stat = (page, offset, len = 6) => {
    const buf = bytes(pages?.[page]);
    if (!buf || buf.length < offset + 8) return null;
    const flags = buf[offset + 7];
    return (flags & 0xC0) === 0xC0 ? uint(buf, offset, len) : null;
  };
  const signed = value => value === null ? null : value > 127 ? value - 256 : value;
  return {
    powerCycles: stat(1, 0x08, 4), powerOnHours: stat(1, 0x10, 4), sectorsWritten: stat(1, 0x18), sectorsRead: stat(1, 0x28),
    uncorrectable: stat(4, 0x08, 4), temperature: signed(stat(5, 0x08, 1)), maxTemperature: signed(stat(5, 0x20, 1)),
    specMaxTemperature: signed(stat(5, 0x58, 1)), crcErrors: stat(6, 0x18, 4), percentUsed: stat(7, 0x08, 1)
  };
}

function parseAtaSmart(data, thresholds) {
  if (!data || data.length < 362) return [];
  const limits = new Map();
  if (thresholds && thresholds.length >= 362) for (let i = 0; i < 30; i++) { const o = 2 + i * 12; if (thresholds[o]) limits.set(thresholds[o], thresholds[o + 1]); }
  const rows = [];
  for (let i = 0; i < 30; i++) {
    const o = 2 + i * 12, id = data[o];
    if (!id) continue;
    const current = data[o + 3], worst = data[o + 4], threshold = limits.has(id) ? limits.get(id) : null;
    const raw = uint(data, o + 5, 6);
    // ATA: an attribute fails when its normalized value drops to or below a non-zero threshold.
    const status = threshold && current <= threshold ? 'bad' : ATA_CAUTION_RAW.has(id) && raw > 0 ? 'caution' : 'good';
    rows.push({id: hex(id, 2), name: ATA_NAMES[id] || 'Vendor Specific', current, worst, threshold, raw: hex(raw, 12), rawValue: raw, status});
  }
  return rows;
}

function parseNvmeIdentify(buf) {
  if (!buf || buf.length < 1024) return null;
  const ver = buf.readUInt32LE(80), wctemp = buf.readUInt16LE(266), cctemp = buf.readUInt16LE(268);
  const features = ['S.M.A.R.T.'];
  if (buf.readUInt16LE(520) & 4) features.push('TRIM');
  if (buf[525] & 1) features.push('VolatileWriteCache');
  return {
    model: ascii(buf, 24, 64), serial: ascii(buf, 4, 24), firmware: ascii(buf, 64, 72),
    capacity: uint(buf, 280, 8) || null, rotation: 'SSD', transferMode: null,
    standard: ver ? `NVM Express ${ver >>> 16}.${(ver >> 8) & 0xFF}` : 'NVM Express', features,
    warnTemperature: wctemp > 273 ? wctemp - 273 : null, critTemperature: cctemp > 273 ? cctemp - 273 : null
  };
}

function parseNvmeHealth(buf) {
  if (!buf || buf.length < 512) return null;
  const values = [buf[0], buf.readUInt16LE(1), buf[3], buf[4], buf[5], ...[32,48,64,80,96,112,128,144,160,176].map(o => uint(buf, o, 16))];
  const kelvin = values[1];
  return {
    criticalWarning: values[0], temperature: kelvin > 0 ? kelvin - 273 : null, availableSpare: values[2], spareThreshold: values[3],
    percentUsed: values[4], dataUnitsRead: values[5], dataUnitsWritten: values[6], powerCycles: values[10], powerOnHours: values[11],
    unsafeShutdowns: values[12], mediaErrors: values[13], errorLogEntries: values[14],
    attributes: values.map((value, i) => ({id: hex(i + 1, 2), name: NVME_NAMES[i], raw: hex(value, i < 5 ? 4 : 12), rawValue: value,
      status: i === 0 && value ? 'bad' : i === 13 && value ? 'caution' : 'good'}))
  };
}

function temperatureStatus(celsius, warn) {
  if (celsius === null || celsius === undefined) return 'unknown';
  return celsius >= warn ? 'bad' : celsius >= warn - 10 ? 'caution' : 'good';
}

// SSD wear-out projection: if `used` % took `hours` of power-on time, the rest wears at the same rate.
function lifeEstimate({percentUsed, powerOnHours, writtenBytes}) {
  if (percentUsed === null || percentUsed === undefined) return null;
  const used = Math.min(percentUsed, 100), remainingPercent = 100 - used;
  const base = {percentUsed: used, remainingPercent, writtenBytes, hoursPerDay: HOURS_PER_DAY,
    writtenPerHour: writtenBytes && powerOnHours ? writtenBytes / powerOnHours : null};
  if (!used || !powerOnHours) return {...base, remainingHours: null, years: null};
  const remainingHours = powerOnHours * remainingPercent / used;
  return {...base, remainingHours, years: remainingHours / HOURS_PER_DAY / 365};
}

function evaluateNvme(info, health) {
  const reasons = [];
  let status = 'good';
  const flag = (level, text) => { status = worse(status, level); reasons.push(text); };
  const cw = health.criticalWarning;
  if (cw & 1) flag('bad', 'Dung lượng dự phòng dưới ngưỡng (Critical Warning bit 0).');
  if (cw & 4) flag('bad', 'Độ tin cậy suy giảm do lỗi phương tiện (Critical Warning bit 2).');
  if (cw & 8) flag('bad', 'Ổ đã chuyển sang chỉ đọc (Critical Warning bit 3).');
  if (cw & 2) flag('caution', 'Nhiệt độ vượt ngưỡng (Critical Warning bit 1).');
  if (cw & 16) flag('caution', 'Bộ nhớ dự phòng khi mất điện lỗi (Critical Warning bit 4).');
  if (health.spareThreshold && health.availableSpare < health.spareThreshold) flag('bad', `Dự phòng còn ${health.availableSpare}% < ngưỡng ${health.spareThreshold}%.`);
  if (health.percentUsed >= 100) flag('bad', `Đã dùng ${health.percentUsed}% độ bền ghi danh định.`);
  else if (health.percentUsed >= 90) flag('caution', `Đã dùng ${health.percentUsed}% độ bền ghi danh định.`);
  if (health.mediaErrors > 0) flag('caution', `${health.mediaErrors} lỗi toàn vẹn dữ liệu (Media Errors).`);
  return {status, reasons, percent: Math.max(0, 100 - health.percentUsed)};
}

function evaluateAta(attributes, stats, hddLike) {
  const reasons = [];
  let status = attributes.length || stats.percentUsed !== null || stats.uncorrectable !== null ? 'good' : 'unknown';
  const flag = (level, text) => { status = worse(status, level); reasons.push(text); };
  attributes.filter(a => a.status === 'bad').forEach(a => flag('bad', `${a.id} ${a.name}: giá trị ${a.current} ≤ ngưỡng ${a.threshold}.`));
  attributes.filter(a => a.status === 'caution').forEach(a => flag('caution', `${a.id} ${a.name}: thô ${a.rawValue}.`));
  if (stats.uncorrectable > 0) flag('caution', `${stats.uncorrectable} lỗi đọc không sửa được (Device Statistics).`);
  let percent = null;
  if (stats.percentUsed !== null) percent = Math.max(0, 100 - stats.percentUsed);
  else if (!hddLike) {
    const life = attributes.find(a => ATA_LIFE.includes(parseInt(a.id, 16)) && a.current <= 100);
    if (life) percent = life.current;
  }
  if (percent !== null && percent <= 0) flag('bad', 'Đã dùng hết độ bền ghi danh định.');
  else if (percent !== null && percent <= 10) flag('caution', `Độ bền còn ${percent}%.`);
  return {status, reasons, percent};
}

function decodeDisk(raw) {
  const errors = Array.isArray(raw.Errors) ? raw.Errors.map(String) : [];
  const base = {
    index: Number(raw.Index), name: String(raw.FriendlyName || `Ổ ${raw.Index}`), bus: String(raw.BusType || ''), media: String(raw.MediaType || ''),
    driveLetters: String(raw.DriveLetters || ''), sizeBytes: Number(raw.Size) || null, windowsHealth: String(raw.HealthStatus || ''),
    protocol: raw.Protocol || null, admin: raw.Admin === true, needsAdmin: raw.NeedsAdmin === true, errors
  };
  let info = null, attributes = [], counters = {}, temperature = null, warn = 60, evaluation = {status:'unknown', reasons:[], percent:null}, percentUsed = null;
  if (raw.Protocol === 'nvme') {
    info = parseNvmeIdentify(bytes(raw.Identify));
    const health = parseNvmeHealth(bytes(raw.HealthLog));
    if (health) {
      attributes = health.attributes; temperature = health.temperature; percentUsed = health.percentUsed;
      warn = info?.warnTemperature || 70;
      evaluation = evaluateNvme(info, health);
      // NVMe data units are 1000 × 512 bytes.
      counters = {powerOnHours: health.powerOnHours, powerCycles: health.powerCycles, unsafeShutdowns: health.unsafeShutdowns,
        mediaErrors: health.mediaErrors, errorLogEntries: health.errorLogEntries, readBytes: health.dataUnitsRead * 512000, writtenBytes: health.dataUnitsWritten * 512000};
    }
  } else if (raw.Protocol === 'ata') {
    info = parseAtaIdentify(bytes(raw.Identify));
    const stats = parseDevStats(raw.DevStats || {});
    attributes = parseAtaSmart(bytes(raw.SmartData), bytes(raw.SmartThresholds));
    const attr = id => attributes.find(a => a.id === hex(id, 2));
    const sector = info?.sectorSize || 512;
    const hddLike = Boolean(info?.rotation && info.rotation !== 'SSD');
    const tempAttr = attr(0xC2) || attr(0xBE);
    temperature = stats.temperature ?? (tempAttr ? tempAttr.rawValue & 0xFF : null);
    warn = stats.specMaxTemperature > 30 && stats.specMaxTemperature < 100 ? stats.specMaxTemperature : hddLike ? 55 : 60;
    evaluation = evaluateAta(attributes, stats, hddLike);
    percentUsed = evaluation.percent === null ? null : 100 - evaluation.percent;
    counters = {
      powerOnHours: stats.powerOnHours ?? (attr(0x09) ? attr(0x09).rawValue % 2 ** 32 : null),
      powerCycles: stats.powerCycles ?? attr(0x0C)?.rawValue ?? null,
      unsafeShutdowns: attr(0xAE)?.rawValue ?? null, uncorrectable: stats.uncorrectable, crcErrors: stats.crcErrors ?? attr(0xC7)?.rawValue ?? null,
      writtenBytes: stats.sectorsWritten !== null ? stats.sectorsWritten * sector : null,
      readBytes: stats.sectorsRead !== null ? stats.sectorsRead * sector : null
    };
  }
  // Fall back to Windows' own verdict only when the drive itself told us nothing.
  if (evaluation.status === 'unknown' && /unhealthy/i.test(base.windowsHealth)) evaluation = {status:'bad', reasons:['Windows báo Unhealthy.'], percent:null};
  else if (evaluation.status === 'unknown' && /warning/i.test(base.windowsHealth)) evaluation = {status:'caution', reasons:['Windows báo Warning.'], percent:null};
  const isSSD = info?.rotation === 'SSD' || /ssd/i.test(base.media) || raw.Protocol === 'nvme';
  const tempStatus = temperatureStatus(temperature, warn);
  return {
    ...base, model: info?.model || base.name, serial: info?.serial || String(raw.SerialNumber || '').trim(), firmware: info?.firmware || null,
    capacity: info?.capacity || base.sizeBytes, rotation: info?.rotation || null, transferMode: info?.transferMode || null,
    standard: info?.standard || null, features: info?.features || [], isSSD,
    health: {status: evaluation.status, label: STATUS[evaluation.status], percent: evaluation.percent, reasons: evaluation.reasons},
    temperature: {celsius: temperature ?? null, warn, status: tempStatus, label: STATUS[tempStatus]},
    counters, attributes, attributeKind: raw.Protocol === 'nvme' ? 'nvme' : 'ata',
    life: isSSD ? lifeEstimate({percentUsed, powerOnHours: counters.powerOnHours ?? null, writtenBytes: counters.writtenBytes ?? null}) : null
  };
}

function decodeDisks(rows) {
  return (Array.isArray(rows) ? rows : []).map(row => {
    try { return decodeDisk(row); }
    catch (error) { return {index: Number(row?.Index), name: String(row?.FriendlyName || 'Ổ'), errors: [`Không giải mã được: ${error.message}`], attributes: [], counters: {}, features: [],
      health: {status:'unknown', label: STATUS.unknown, percent: null, reasons: []}, temperature: {celsius: null, status: 'unknown', label: STATUS.unknown}, life: null}; }
  });
}

const gb = value => value === null || value === undefined ? '' : `${(value / 1e9).toFixed(0)} GB`;
// Adds decoded drives (scan.diskDetails, for the Ổ cứng page) plus flat tables used by the generic views and the report.
function enrichDisks(report, rawRows = report?.sections?.smartRaw?.data) {
  const section = report?.sections?.smartRaw;
  if (rawRows === undefined || (section && section.status !== 'ok' && !rawRows?.length)) {
    if (section) report.sections.diskHealth = {status:'unknown', data:[], error:section.error};
    return report;
  }
  const disks = decodeDisks(rawRows);
  report.diskDetails = disks;
  report.sections.diskHealth = {status:'ok', error:null, data: disks.map(d => ({
    'Ổ': `${d.model}${d.driveLetters ? ` (${d.driveLetters})` : ''}`, 'Sức khỏe': `${d.health.label}${d.health.percent !== null ? ` ${d.health.percent}%` : ''}`,
    'Nhiệt độ': d.temperature.celsius !== null ? `${d.temperature.celsius} °C` : '', 'Giờ chạy': d.counters.powerOnHours ?? '', 'Số lần bật': d.counters.powerCycles ?? '',
    'Tổng ghi': gb(d.counters.writtenBytes), 'Tổng đọc': gb(d.counters.readBytes), 'Serial': d.serial, 'Firmware': d.firmware || '',
    'Lý do': [...d.health.reasons, ...(d.needsAdmin ? ['Bảng SMART cần quyền Admin.'] : []), ...d.errors].join(' ')
  }))};
  report.sections.diskSmart = {status:'ok', error:null, data: disks.flatMap(d => d.attributes.map(a => ({
    'Ổ': d.model, ID: a.id, 'Thuộc tính': a.name, 'Hiện tại': a.current ?? '', 'Tệ nhất': a.worst ?? '', 'Ngưỡng': a.threshold ?? '', 'Giá trị thô': a.raw
  })))};
  return report;
}

module.exports = {decodeDisk, decodeDisks, enrichDisks, lifeEstimate, temperatureStatus, parseAtaIdentify, parseDevStats, parseAtaSmart, parseNvmeIdentify, parseNvmeHealth, STATUS, HOURS_PER_DAY};
