(function(){
const array = value => Array.isArray(value) ? value : [];
const data = (report, name) => array(report?.sections?.[name]?.data);
const number = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const CYCLE_WARN = 500; // App heuristic, not a manufacturer specification.
const DAY = 86400000;

function batteryHealth(battery) {
  const design = number(battery.DesignCapacity), full = number(battery.FullChargeCapacity);
  if (!design || design < 0 || full === null || full <= 0) return {state:'unknown', label:'Chưa xác định', remaining:null, wear:null};
  const remaining = full / design * 100;
  if (remaining > 110) return {state:'unknown', label:'Dung lượng bất thường, cần đối chiếu', remaining, wear:null};
  const wear = Math.max(0, 100 - remaining);
  return {state:wear >= 30 ? 'warn' : 'info', label:`Còn ${remaining.toFixed(1)}% thiết kế · chai ${wear.toFixed(1)}%`, remaining, wear};
}

// SoftwareLicensingProduct.LicenseStatus values.
const LICENSE_STATES = {0:'Chưa cấp phép',1:'Đã kích hoạt',2:'Đang gia hạn (OOB)',3:'Đang gia hạn (OOT)',4:'Gia hạn — bản không chính hãng',5:'Chưa kích hoạt (chế độ thông báo)',6:'Gia hạn mở rộng'};
// Genuine vs cracked verdict. Evidence, strongest first: crack-tool leftovers on disk / in services / tasks / registry;
// a KMS grace period far beyond the 180 days real KMS gives (KMS38-style); a KMS host on this machine or a private
// address while not in a company domain (KMS emulator); any KMS (GVLK) activation outside a domain.
// A digital license obtained through an HWID exploit looks identical to a genuine one, so "genuine" is never absolute.
const VERDICTS = {genuine:'Bản quyền hợp lệ', cracked:'Có dấu hiệu crack', suspect:'Nghi crack (KMS)', corporate:'Bản quyền doanh nghiệp', inactive:'Chưa kích hoạt', none:'Không có khóa Windows', unknown:'Chưa xác định'};
const KMS_GRACE_MAX = 260000; // minutes; genuine KMS renews every 180 days (259 200 min).
const PRIVATE_HOST = /^(localhost|127\.|0\.0\.0\.0|::1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i;
// When a license stops working. Retail / OEM / MAK activations carry no remaining grace: they never expire. KMS
// activations expire after up to 180 days unless the host renews them; grace / notification states and evaluation
// editions have a hard end date.
function licenseExpiry(row, now = Date.now()) {
  if (!row) return null;
  const day = d => new Date(d).toLocaleDateString('vi-VN', {day:'2-digit', month:'2-digit', year:'numeric'});
  const left = d => Math.max(0, Math.ceil((d - now) / 86400000));
  const evalEnd = row.EvaluationEndDate ? Date.parse(row.EvaluationEndDate) : NaN;
  if (Number.isFinite(evalEnd)) return {permanent:false, date:new Date(evalEnd).toISOString(), days:left(evalEnd), label: evalEnd > now ? `${day(evalEnd)} (còn ${left(evalEnd)} ngày) · bản dùng thử` : `Bản dùng thử đã hết hạn ${day(evalEnd)}`};
  const status = number(row.LicenseStatus), grace = number(row.GraceMinutes), end = grace ? now + grace * 60000 : null;
  const kms = /kms|gvlk/i.test(`${row.Channel || ''} ${row.Description || ''}`);
  if (status === 1) return end
    ? {permanent:false, date:new Date(end).toISOString(), days:left(end), label:`${day(end)} (còn ${left(end)} ngày)${kms ? ' · KMS tự gia hạn 180 ngày nếu còn liên lạc được máy chủ' : ''}`}
    : {permanent:true, date:null, days:null, label:'Vĩnh viễn (không hết hạn)'};
  if (status === 0 || status === null) return {permanent:false, date:null, days:null, label:'Chưa có bản quyền'};
  return end ? {permanent:false, date:new Date(end).toISOString(), days:left(end), label:`Hết ân hạn ${day(end)} (còn ${left(end)} ngày)`} : {permanent:false, date:null, days:0, label:'Đã hết hạn'};
}
function licenseInfo(report, now = Date.now()) {
  const section = report?.sections?.license;
  const result = (verdict, state, detail, extra = {}) => ({verdict, state, label:VERDICTS[verdict], detail, evidence:[], channel:null, status:null, ...extra});
  if (!section || section.status !== 'ok') return result('unknown', 'unknown', section?.error || 'Chưa đọc được trạng thái bản quyền.');
  const rows = array(section.data), active = rows.find(r => number(r.LicenseStatus) === 1), row = active || rows[0];
  if (!row) return result('none', 'warn', 'Windows chưa được cài khóa sản phẩm.');
  const channel = String(row.Channel || '').trim() || null;
  const base = {channel, status: LICENSE_STATES[number(row.LicenseStatus)] ?? `Mã trạng thái ${row.LicenseStatus}`};
  const oem = row.OemKeyInFirmware === true ? ' Firmware có khóa OEM (máy xuất xưởng kèm Windows bản quyền).' : '';
  if (!active) return result('inactive', 'warn', `Windows chưa kích hoạt (${base.status}). Hỏi người bán về bản quyền.${oem}`, base);
  const act = data(report,'activation')[0] || null;
  const artifacts = String(act?.Artifacts || '').split(' | ').map(s => s.trim()).filter(Boolean);
  if (artifacts.length) return result('cracked', 'warn', `Tìm thấy dấu vết công cụ crack kích hoạt: ${artifacts.join('; ')}.${oem}`, {...base, evidence:artifacts});
  const kind = `${channel || ''} ${row.Description || ''}`;
  if (/kms|gvlk/i.test(kind)) {
    const host = [row.KmsMachine, row.KmsDiscovered, act?.KmsHost].map(v => String(v || '').trim()).find(Boolean) || null;
    const grace = number(row.GraceMinutes), domain = act?.PartOfDomain === true;
    if (grace !== null && grace > KMS_GRACE_MAX) {
      const until = new Date(now + grace * 60000).getFullYear();
      return result('cracked', 'warn', `Kích hoạt KMS có hạn tới năm ${until}; KMS thật chỉ gia hạn 180 ngày. Đây là kiểu kích hoạt giả (KMS38).${oem}`, {...base, evidence:[`Hạn KMS tới ${until}`]});
    }
    if (host && PRIVATE_HOST.test(host) && !domain) return result('cracked', 'warn', `Kích hoạt qua máy chủ KMS ${host} trên chính máy hoặc mạng nội bộ, máy không thuộc domain doanh nghiệp: dấu hiệu giả lập KMS.${oem}`, {...base, evidence:[`Máy chủ KMS: ${host}`]});
    if (!domain) return result('suspect', 'warn', `Kích hoạt bằng khóa KMS (GVLK) dành cho doanh nghiệp nhưng máy không thuộc domain${host ? `; máy chủ KMS: ${host}` : ''}. Máy cá nhân kích hoạt kiểu này thường là crack KMS online.${oem}`, {...base, evidence:host ? [`Máy chủ KMS: ${host}`] : []});
    return result('corporate', 'warn', `Kích hoạt KMS qua domain doanh nghiệp${host ? ` (${host})` : ''}. Bản quyền sẽ mất khi rời domain; hỏi người bán nguồn gốc máy.${oem}`, base);
  }
  if (/mak|volume/i.test(kind)) return result('corporate', 'warn', `Khóa Volume MAK của doanh nghiệp. Hỏi người bán nguồn gốc bản quyền.${oem}`, base);
  return result('genuine', 'info', `Kênh ${channel || 'chưa rõ'}, không thấy dấu vết công cụ crack.${oem} Kích hoạt HWID trái phép trông giống bản quyền số thật nên không loại trừ được hoàn toàn.`, base);
}

// Signals of how long the machine has been in use. None of them is the factory ship date.
function usageInfo(report, now = Date.now()) {
  const installed = data(report,'os')[0]?.InstallDate || null;
  const installedAt = installed ? Date.parse(installed) : NaN;
  const days = Number.isFinite(installedAt) ? Math.max(0, Math.floor((now - installedAt) / DAY)) : null;
  const hours = array(report?.diskDetails).map(d => number(d.counters?.powerOnHours)).filter(h => h !== null);
  return {
    windowsInstalled: installed, windowsDays: days,
    batteryManufactured: data(report,'battery').map(b => b.ManufactureDate).find(Boolean) || null,
    diskPowerOnHours: hours.length ? Math.max(...hours) : null
  };
}
const ago = days => days === null ? '' : days < 60 ? `${days} ngày trước` : days < 730 ? `khoảng ${Math.round(days / 30)} tháng trước` : `khoảng ${(days / 365).toFixed(1)} năm trước`;

function batteryChecks(batteries) {
  if (!batteries.length) return [{state:'unknown',title:'Chưa có số liệu pin',detail:'Không kết luận pin tốt. Thử rút sạc và đối chiếu Battery Health trong BIOS.'}];
  return batteries.map(b => {
    const health = batteryHealth(b), cycles = number(b.CycleCount);
    const cycleText = cycles === null ? 'chưa rõ chu kỳ sạc' : `${cycles} chu kỳ sạc`;
    const state = health.state === 'warn' || (cycles !== null && cycles >= CYCLE_WARN) ? 'warn' : cycles === null && health.state === 'unknown' ? 'unknown' : health.state;
    return {state,title:`Pin ${b.Name || ''}: ${health.label} · ${cycleText}`,detail:`Theo firmware. Ngưỡng chai 30% và ${CYCLE_WARN} chu kỳ là gợi ý của ứng dụng; không thay thế thử thời lượng thực tế.`};
  });
}
// One finding per drive from the decoded S.M.A.R.T. data (disk-health.cjs): Tốt / Cẩn thận / Xấu / Chưa rõ.
const DISK_STATE = {good:'info', caution:'warn', bad:'warn', unknown:'unknown'};
function storageChecks(disks) {
  if (!disks.length) return [{state:'unknown',title:'Chưa có dữ liệu sức khỏe ổ đĩa',detail:'Cần chẩn đoán bổ sung. Liệt kê được tên ổ không chứng minh ổ tốt.'}];
  return disks.map(d => {
    const h = d.health || {}, t = d.temperature || {};
    const title = `Ổ ${d.model || d.name}${d.driveLetters ? ` (${d.driveLetters})` : ''}: ${h.label || 'Chưa rõ'}${h.percent != null ? ` ${h.percent}%` : ''}${t.celsius != null ? ` · ${t.celsius} °C` : ''}`;
    const extra = [d.needsAdmin ? 'Bảng SMART SATA cần quyền quản trị: mở tab Ổ cứng để đọc.' : '', ...(d.errors || [])].filter(Boolean);
    const detail = [...(h.reasons || []), ...extra].join(' ') || 'Theo S.M.A.R.T. do ổ báo tại thời điểm quét; không thay thế quét bề mặt hay thử đọc/ghi.';
    return {state: DISK_STATE[h.status] || 'unknown', title, detail};
  });
}
// Office: same evidence ladder as Windows, plus Office-only signals. A Volume (GVLK) Office on a machine that is not
// in a company domain and that sends KMS requests to an outside host is the classic "KMS online" crack; Ohook leaves a
// fake sppc.dll in Office's vfs folder; Microsoft 365 signed-in licenses carry no product key at all.
const OFFICE_VERDICTS = {genuine:'Office bản quyền', subscription:'Microsoft 365 (thuê bao)', cracked:'Office có dấu hiệu crack', suspect:'Office nghi crack (KMS)', corporate:'Office bản quyền doanh nghiệp', inactive:'Office chưa kích hoạt', notInstalled:'Không cài Office', unknown:'Chưa xác định'};
function officeInfo(report, now = Date.now()) {
  const section = report?.sections?.office;
  const result = (verdict, state, detail, extra = {}) => ({verdict, state, label:OFFICE_VERDICTS[verdict], detail, evidence:[], product:null, channel:null, status:null, requests:[], ...extra});
  if (!section || section.status !== 'ok') return result('unknown', 'unknown', section?.error || 'Chưa đọc được bản quyền Office.');
  const o = data(report,'office')[0];
  if (!o || o.Installed !== true) return result('notInstalled', 'info', 'Không tìm thấy Microsoft Office cài trên máy.');
  const products = array(o.Products), active = products.find(p => number(p.LicenseStatus) === 1), row = active || products[0] || {};
  const requests = String(o.KmsRequests || '').split(' | ').filter(Boolean);
  const hosts = [...new Set(requests.map(r => r.split(' ').at(-1)))];
  const base = {product: row.Name || o.ReleaseIds || 'Microsoft Office', channel: String(row.Channel || '').trim() || null, status: row.LicenseStatus != null ? (LICENSE_STATES[number(row.LicenseStatus)] ?? `Mã ${row.LicenseStatus}`) : null, requests};
  const hooks = String(o.Hooks || '').split(' | ').filter(Boolean);
  const artifacts = String(data(report,'activation')[0]?.Artifacts || '').split(' | ').map(s => s.trim()).filter(Boolean);
  if (hooks.length) return result('cracked', 'warn', 'Có sppc.dll giả trong thư mục Office (công cụ crack Ohook).', {...base, evidence: hooks.map(h => `Tệp: ${h}`)});
  if (artifacts.length) return result('cracked', 'warn', `Máy có dấu vết công cụ crack kích hoạt (thường crack cả Windows và Office): ${artifacts.join('; ')}.`, {...base, evidence: artifacts});
  if (!products.length) return o.M365Licenses === true
    ? result('subscription', 'info', 'Office dùng giấy phép Microsoft 365 theo tài khoản đăng nhập (thuê bao). Khi bán máy, tài khoản này thường bị gỡ.', base)
    : result('inactive', 'warn', 'Office đã cài nhưng chưa có khóa hay tài khoản Microsoft 365 nào.', base);
  const kind = `${base.channel || ''} ${row.Description || ''} ${o.ReleaseIds || ''}`;
  const domain = data(report,'activation')[0]?.PartOfDomain === true;
  if (/kms|gvlk/i.test(kind)) {
    const host = [row.KmsMachine, row.KmsDiscovered, o.KmsHost].map(v => String(v || '').trim()).find(Boolean) || null;
    const grace = number(row.GraceMinutes);
    if (grace !== null && grace > KMS_GRACE_MAX) return result('cracked', 'warn', `Kích hoạt KMS có hạn tới năm ${new Date(now + grace * 60000).getFullYear()}; KMS thật chỉ gia hạn 180 ngày.`, {...base, evidence:[`Hạn KMS tới ${new Date(now + grace * 60000).getFullYear()}`]});
    if (!domain && (hosts.length || host)) return result('cracked', 'warn', `Office bản Volume (khóa KMS dành cho doanh nghiệp) trên máy không thuộc domain, kích hoạt qua máy chủ KMS bên ngoài: ${[...new Set([host, ...hosts].filter(Boolean))].join(', ')}. Đây là kiểu crack KMS online.`, {...base, evidence:[...new Set([host, ...hosts].filter(Boolean))].map(h => `Máy chủ KMS: ${h}`)});
    if (!domain) return result('suspect', 'warn', 'Office bản Volume (khóa KMS doanh nghiệp) trên máy không thuộc domain công ty. Máy cá nhân dùng bản này thường là crack.', base);
    return result('corporate', 'warn', 'Office kích hoạt KMS qua domain doanh nghiệp; sẽ mất bản quyền khi rời domain.', base);
  }
  if (!active) return result('inactive', 'warn', `Office chưa kích hoạt (${base.status}).`, base);
  if (/mak|volume/i.test(kind)) return result('corporate', 'warn', 'Office dùng khóa Volume MAK của doanh nghiệp. Hỏi người bán nguồn gốc.', base);
  return result('genuine', 'info', `Kênh ${base.channel || 'chưa rõ'}, không thấy dấu vết crack.`, base);
}
// Device management: what a buyer must have the seller remove. Autopilot is the worst case: the device is registered
// to a company tenant in Microsoft's cloud, so even a clean reinstall asks for the company account at setup.
const MDM_VERDICTS = {autopilot:'Đăng ký Autopilot của tổ chức', managed:'Đang bị quản lý (MDM)', joined:'Gia nhập tổ chức', agent:'Có phần mềm quản lý từ xa', clean:'Không bị quản lý', unknown:'Chưa xác định'};
function mdmInfo(report) {
  const section = report?.sections?.mdm;
  const make = (verdict, state, detail, evidence = []) => ({verdict, state, label:MDM_VERDICTS[verdict], detail, evidence});
  if (!section || section.status !== 'ok') return make('unknown', 'unknown', section?.error || 'Chưa đọc được trạng thái quản lý thiết bị.');
  const m = data(report,'mdm')[0] || {};
  const split = v => String(v || '').split(' | ').map(s => s.trim()).filter(Boolean);
  const enrollments = split(m.Enrollments), agents = split(m.Agents);
  const evidence = [
    m.AutopilotTenant && `Autopilot: ${m.AutopilotTenant}${m.AutopilotProfile ? ` (hồ sơ ${m.AutopilotProfile})` : ''}`,
    ...enrollments.map(e => `MDM: ${e}`), m.MdmUrl && `Máy chủ MDM: ${m.MdmUrl}`,
    m.AzureAdJoined === true && `Azure AD / Entra ID: ${m.TenantName || 'có'}`, m.DomainJoined === true && `Domain: ${m.Domain || 'có'}`,
    m.WorkplaceJoined === true && 'Tài khoản cơ quan / trường học đã thêm', ...agents.map(a => `Phần mềm: ${a}`),
  ].filter(Boolean);
  if (m.AutopilotTenant) return make('autopilot', 'warn', `Máy đăng ký Windows Autopilot của ${m.AutopilotTenant}: cài lại Windows vẫn bị bắt đăng nhập tài khoản tổ chức. Yêu cầu người bán gỡ máy khỏi Autopilot trước khi mua.`, evidence);
  if (enrollments.length || m.MdmUrl) return make('managed', 'warn', 'Máy đang đăng ký MDM (Intune hoặc tương tự): tổ chức có thể ép chính sách, cài / gỡ phần mềm, khóa hoặc xóa máy từ xa. Cần gỡ ở Cài đặt › Tài khoản › Truy cập cơ quan hoặc trường học.', evidence);
  if (m.AzureAdJoined === true || m.DomainJoined === true) return make('joined', 'warn', 'Máy gia nhập tổ chức (Azure AD / domain) nhưng không thấy MDM. Nên rời tổ chức hoặc cài lại Windows.', evidence);
  if (agents.length) return make('agent', 'warn', 'Có phần mềm quản lý / theo dõi từ xa của doanh nghiệp. Hỏi người bán và gỡ trước khi dùng.', evidence);
  return make('clean', 'info', m.WorkplaceJoined === true ? 'Không có MDM, Autopilot hay domain; chỉ có tài khoản cơ quan / trường học được thêm vào.' : 'Không thấy MDM, Autopilot, domain hay phần mềm quản lý từ xa.', evidence);
}
// Kernel / firmware truth vs what Windows' registry claims (see the hardwareTruth section in collect.ps1).
const SKUS = {0x30:['Professional','Pro'],0x31:['ProfessionalN','Pro N'],0x65:['Core','Home'],0x62:['CoreN','Home N'],0x63:['CoreCountrySpecific','Home China'],
  0x64:['CoreSingleLanguage','Home Single Language'],0x04:['Enterprise','Enterprise'],0x1B:['EnterpriseN','Enterprise N'],0x79:['Education','Education'],0x7A:['EducationN','Education N'],
  0xA1:['ProfessionalWorkstation','Pro for Workstations'],0xA4:['ProfessionalEducation','Pro Education'],0x7D:['EnterpriseS','Enterprise LTSC'],0x48:['EnterpriseEval','Enterprise Evaluation']};
const RELEASES = {26200:'25H2',26100:'24H2',22631:'23H2',22621:'22H2',22000:'21H2',19045:'22H2',19044:'21H2',19043:'21H1',19042:'20H2'};
const PCI_VENDORS = {'8086':['Intel',/intel/i],'10DE':['NVIDIA',/nvidia|geforce|quadro|rtx|gtx/i],'1002':['AMD',/amd|radeon|ati\b/i],'1414':['Microsoft',/microsoft|basic/i],'5143':['Qualcomm',/qualcomm|adreno/i]};
const squash = v => String(v ?? '').replace(/\s+/g, ' ').trim();
function hardwareTruth(report) {
  const t = data(report,'hardwareTruth')[0];
  if (!t) return {available:false, items:[], mismatches:[]};
  const build = number(t.Build), sku = SKUS[number(t.ProductType)] || null;
  const osName = build ? `Windows ${build >= 22000 ? 11 : 10}${sku ? ` ${sku[1]}` : ''}` : null;
  // GPU truth: the signed driver INF's name for the hardware PCI id; without one (basic display driver, edited INF)
  // only the vendor from the PCI id is certain.
  const gpus = array(t.Gpus).map(g => { const v = PCI_VENDORS[String(g.VendorId).toUpperCase()], windowsName = squash(g.WindowsName);
    const model = g.InfSigned === true && g.InfName ? squash(g.InfName) : null, vendor = v ? v[0] : `PCI ${g.VendorId}`;
    const match = model ? model.toLowerCase() === windowsName.toLowerCase() : v ? v[1].test(windowsName) : null;
    return {vendorId:g.VendorId, deviceId:g.DeviceId, subsys:g.Subsys || null, vendor, model, windowsName, infFile:g.InfFile || null, infSigned:g.InfSigned ?? null, match}; });
  const items = [];
  const item = (name, windows, truth, source, match) => items.push({name, windows:windows || null, truth:truth || null, source, match: windows && truth ? match : null});
  item('CPU', squash(t.RegCpuName), squash(t.CpuBrand), 'CPUID (kernel)', squash(t.RegCpuName).toLowerCase() === squash(t.CpuBrand).toLowerCase());
  item('Phiên bản (Edition)', t.RegEditionID, sku && `${sku[0]} (${sku[1]})`, 'Mã SKU bản quyền (kernel)', !!sku && String(t.RegEditionID).toLowerCase() === sku[0].toLowerCase());
  item('Build', t.RegBuild, build && String(build), 'RtlGetVersion (kernel)', String(t.RegBuild) === String(build));
  for (const g of gpus) item('Card đồ họa', g.windowsName, `${g.model || g.vendor} · PCI ${g.vendorId}:${g.deviceId}`, g.model ? `PCI ID + driver đã ký (${g.infFile})` : g.infSigned === false ? 'PCI ID (driver INF bị sửa / không có chữ ký)' : 'PCI ID phần cứng (chỉ biết hãng)', g.match !== false);
  for (const d of array(report?.diskDetails)) item(`Ổ ${d.index}`, squash(d.name), squash(d.model), 'IDENTIFY của ổ', !!d.model && (squash(d.name).toLowerCase().includes(squash(d.model).toLowerCase()) || squash(d.model).toLowerCase().includes(squash(d.name).toLowerCase())));
  return {available:true, cpu:squash(t.CpuBrand) || null, osName, edition:sku?.[1] || null, build, release:RELEASES[build] || null, ubr:number(t.RegUBR),
    oemKeyTail:t.OemKeyTail || null, gpus, items, mismatches:items.filter(i => i.match === false)};
}
// RAM, entirely from SMBIOS (types 16/17) plus the kernel's visible total. Channel layout is read from the slot /
// bank labels the BIOS writes ("ChannelA-DIMM0", "BANK 2", "DIMM B"…); when they say nothing it stays unknown.
const MEM_TYPES = {0x12:'DDR',0x13:'DDR2',0x14:'DDR2 FB-DIMM',0x18:'DDR3',0x1A:'DDR4',0x1B:'LPDDR',0x1C:'LPDDR2',0x1D:'LPDDR3',0x1E:'LPDDR4',0x20:'HBM',0x21:'HBM2',0x22:'DDR5',0x23:'LPDDR5',0x24:'HBM3'};
const FORM_FACTORS = {0x09:'DIMM',0x0B:'Hàn trên bo mạch',0x0D:'SO-DIMM',0x0F:'FB-DIMM',0x10:'Hàn trên bo mạch',0x11:'CAMM'};
const JEDEC = {'1:CE':'Samsung','1:AD':'SK hynix','1:2C':'Micron','2:98':'Kingston'};
const PART_VENDORS = [[/^TEAMGROUP|^TED|^TF[AB]/i,'TeamGroup'],[/^CM[KWTHSN]/i,'Corsair'],[/^F[345]-/i,'G.Skill'],[/^(KF|KVR|HX|KCP|KHX)/i,'Kingston'],[/^(CT|BL)\d/i,'Crucial'],[/^M(471|378|425|391|393|321)/i,'Samsung'],[/^HM[ACT]|^HMCG/i,'SK hynix'],[/^MTA?\d/i,'Micron'],[/^A[DX][45]/i,'ADATA']];
function memoryVendor(raw, part) {
  let s = String(raw || '').trim();
  if (/^(unknown|undefined|not specified|no dimm|manufacturer\d*|0+)$/i.test(s)) s = '';
  if (!s) return PART_VENDORS.find(([re]) => re.test(String(part || '').trim()))?.[1] || null;
  const hex = s.replace(/^0x/i, '').toUpperCase();
  if (!/^[0-9A-F]{4,}$/.test(hex)) return s || null;
  const [a, b] = [hex.slice(0, 2), hex.slice(2, 4)];
  const bank = x => (parseInt(x, 16) & 0x7f) + 1;
  return JEDEC[`${bank(a)}:${b}`] || JEDEC[`${bank(b)}:${a}`] || `JEDEC ${hex.slice(0, 4)}`;
}
function memoryChannel(m) {
  const label = `${m.Bank || ''} ${m.Slot || ''}`;
  const named = label.match(/channel\s*([A-H])\b|\bDIMM[\s_-]*([A-H])\d?\b|\bCH[\s_-]*([A-H])\b/i);
  if (named) return (named[1] || named[2] || named[3]).toUpperCase();
  const bank = label.match(/\bBANK\s*(\d+)/i);
  return bank ? `B${Math.floor(Number(bank[1]) / 2)}` : null;
}
function memoryInfo(report) {
  const slots = data(report,'smbiosMemory'), arrays = data(report,'smbiosMemoryArray').filter(a => number(a.Use) === 3 || a.Use == null);
  if (!slots.length) return {available:false, modules:[], slots:[], notes:[]};
  const all = slots.map((m, i) => {
    const sizeMiB = number(m.SizeMiB), installed = m.Installed === 'Yes' && sizeMiB > 0, ff = number(m.FormFactor);
    return {index:i, slot:m.Slot || `Khe ${i + 1}`, bank:m.Bank || null, installed, sizeMiB, type:MEM_TYPES[number(m.MemoryType)] || null,
      formFactor:FORM_FACTORS[ff] || null, soldered: ff === 0x0B || ff === 0x10, ratedMTs:number(m.SpeedMTs), runningMTs:number(m.ConfiguredMTs),
      vendor:installed ? memoryVendor(m.Manufacturer, m.PartNumber) : null, part:installed ? (String(m.PartNumber || '').trim().replace(/^unknown$/i, '') || null) : null, serial:installed ? (String(m.SerialNumber || '').trim().replace(/^unknown$/i, '') || null) : null,
      rank:number(m.Rank), voltageMV:number(m.ConfiguredVoltageMV) ?? number(m.MinVoltageMV), channel:memoryChannel(m), ecc:number(m.TotalWidth) > number(m.DataWidth)};
  });
  const modules = all.filter(m => m.installed), totalMiB = modules.reduce((s, m) => s + m.sizeMiB, 0);
  const t = data(report,'hardwareTruth')[0] || {}, visible = number(t.VisibleBytes), avail = number(t.AvailableBytes);
  const maxKiB = arrays.reduce((s, a) => s + (number(a.MaxCapacityKiB) || 0), 0), slotCount = arrays.reduce((s, a) => s + (number(a.Slots) || 0), 0) || all.length;
  const channels = new Set(modules.map(m => m.channel).filter(Boolean)), channelKnown = modules.length > 0 && modules.every(m => m.channel);
  const empty = all.filter(m => !m.installed && !m.soldered).length, socketed = all.filter(m => !m.soldered).length;
  const types = [...new Set(modules.map(m => m.type).filter(Boolean))];
  const rated = Math.min(...modules.map(m => m.ratedMTs).filter(Boolean)), running = Math.min(...modules.map(m => m.runningMTs || m.ratedMTs).filter(Boolean));
  const notes = [];
  if (channelKnown && modules.length) notes.push(channels.size >= 2 ? {state:'info', text:`Chạy kênh đôi (${channels.size} kênh có RAM).`} : {state:'warn', text: socketed > 1 && empty ? 'Chạy kênh đơn: chỉ một kênh có RAM. Gắn thêm thanh vào khe trống cùng dung lượng để lên kênh đôi (nhanh hơn rõ, nhất là card đồ họa tích hợp).' : 'Chạy kênh đơn.'});
  if (Number.isFinite(rated) && Number.isFinite(running) && running < rated) notes.push({state:'info', text:`RAM đang chạy ${running} MT/s, thấp hơn định mức ${rated} MT/s (do CPU / mainboard giới hạn hoặc chưa bật XMP / EXPO).`});
  if (new Set(modules.map(m => `${m.sizeMiB}|${m.part}`)).size > 1) notes.push({state:'info', text:'Các thanh RAM khác dung lượng hoặc khác mã: vẫn chạy được nhưng có thể mất kênh đôi một phần.'});
  if (all.some(m => m.soldered) && socketed) notes.push({state:'info', text:`Có ${all.filter(m => m.soldered).length} phần RAM hàn trên bo mạch và ${socketed} khe cắm rời.`});
  else if (all.length && all.every(m => m.soldered)) notes.push({state:'info', text:'RAM hàn chết trên bo mạch: không nâng cấp được.'});
  if (visible && totalMiB && totalMiB * 1048576 - visible > 2 * 1073741824) notes.push({state:'warn', text:`Windows chỉ dùng được ${(visible / 1073741824).toFixed(1)} GiB trên ${(totalMiB / 1024).toFixed(0)} GiB đã gắn. Phần lớn bị giữ lại cho phần cứng (card tích hợp) hoặc một thanh không được nhận đủ.`});
  return {available:true, modules, slots:all, totalMiB, visibleBytes:visible, availableBytes:avail, load:number(t.MemoryLoad),
    maxGiB: maxKiB ? Math.round(maxKiB / 1048576) : null, slotCount, empty, socketed, types,
    ratedMTs:Number.isFinite(rated) ? rated : null, runningMTs:Number.isFinite(running) ? running : null,
    channel: !channelKnown ? null : channels.size >= 2 ? 'dual' : 'single', ecc:modules.some(m => m.ecc), upgradeable: empty > 0, notes};
}
// Crash history from the System log (kept a few months at most).
function stabilityInfo(report) {
  const s = data(report,'stability')[0];
  if (!s) return {available:false};
  const crashes = array(s.Crashes), bsods = array(s.BlueScreens), whea = array(s.Whea);
  const blue = crashes.filter(c => c.Bugcheck), button = crashes.filter(c => !c.Bugcheck && c.PowerButton), power = crashes.filter(c => !c.Bugcheck && !c.PowerButton);
  // A blue screen usually logs both Kernel-Power 41 (with the code) and WER 1001; count WER ones not already matched.
  const extraBlue = bsods.filter(b => !blue.some(c => Math.abs(Date.parse(c.Time) - Date.parse(b.Time)) < 15 * 60000));
  const events = [
    ...crashes.map(c => ({time:c.Time, kind:c.Bugcheck ? 'bsod' : c.PowerButton ? 'button' : 'power', code:c.Bugcheck || null})),
    ...extraBlue.map(b => ({time:b.Time, kind:'bsod', code:b.Code || null})),
  ].sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  const LABELS = {bsod:'Màn hình xanh (BSOD)', button:'Giữ nút nguồn để tắt', power:'Mất điện / treo cứng'};
  return {available:true, since:s.SystemLogStart || null, total:events.length, blueScreens:blue.length + extraBlue.length, powerButton:button.length, powerLoss:power.length,
    hardwareErrors:whea.length, hardwareFatal:whea.filter(w => /error|lỗi/i.test(String(w.Level)) || number(w.Id) === 1 || number(w.Id) === 18).length,
    events:events.map(e => ({...e, label:LABELS[e.kind]})), lastWhea:whea[0]?.Time || null};
}
// Earliest trace of someone setting this machine up. Windows does not keep the activation date itself beyond the
// SPP log, but it activates on the first internet connection after setup, so the setup date bounds it.
function firstUseInfo(report, now = Date.now()) {
  const f = data(report,'firstUse')[0] || {}, disk = array(report?.diskDetails).map(d => d.counters?.powerOnHours).filter(h => h != null);
  const at = v => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };
  const marks = [
    {key:'setup', label:'Thiết lập Windows lần đầu (OOBE)', time:at(f.SetupLogStart), note:'Sự kiện cũ nhất trong nhật ký Setup, ghi lúc cài / thiết lập Windows.'},
    {key:'profile', label:`Tạo tài khoản đầu tiên${f.FirstProfileName ? ` (${f.FirstProfileName})` : ''}`, time:at(f.FirstProfile), note:'Ngày tạo thư mục người dùng đầu tiên.'},
    {key:'original', label:'Bản Windows gốc được cài', time:at(f.OriginalInstall), note:'Giữ lại qua các lần nâng cấp phiên bản Windows.'},
    {key:'install', label:'Bản Windows hiện tại được cài', time:at(f.CurrentInstall), note:'Máy cài sẵn từ nhà máy thường mang ngày đóng gói bản cài, trước ngày bán.'},
    {key:'disk', label:'Ổ cứng bật lần đầu (ước tính)', time:disk.length ? now - Math.max(...disk) * 3600000 : null, note:'Bây giờ trừ số giờ ổ đã chạy: chắc chắn sớm hơn mốc này.', bound:true},
  ].filter(m => m.time);
  const setup = marks.find(m => m.key === 'setup' || m.key === 'profile');
  const firstSetup = [marks.find(m => m.key === 'setup')?.time, marks.find(m => m.key === 'profile')?.time].filter(Boolean);
  return {marks:marks.sort((a, b) => a.time - b.time), firstSetup:firstSetup.length ? Math.min(...firstSetup) : null, hasSetup:!!setup};
}
// Windows Memory Diagnostic result: judged by the message (localized), event id as a fallback.
function memoryDiagnosticInfo(report) {
  const rows = data(report,'memoryDiag').filter(r => r.Time);
  if (!rows.length) return {available:false, last:null};
  const verdict = r => /no errors|không (phát hiện|tìm thấy|có) lỗi/i.test(r.Message || '') ? 'ok' : /error|lỗi/i.test(r.Message || '') ? 'bad' : [1101, 1201].includes(number(r.Id)) ? 'ok' : [1102, 1202].includes(number(r.Id)) ? 'bad' : 'unknown';
  const history = rows.map(r => ({time:r.Time, verdict:verdict(r), message:r.Message || ''})).sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  return {available:true, last:history[0], history};
}
// Grades a write/read test against what the drive type should reach. These are single-queue, 8 MiB sequential
// numbers, so they sit below the box spec: a healthy PCIe 3 NVMe does ~1.5–3 GB/s here, PCIe 4 ~3–6 GB/s, SATA SSD
// ~400–550 MB/s, a 2.5" laptop HDD ~80–150 MB/s.
const DISK_CLASSES = {
  nvme:{label:'SSD NVMe', expect:'thường ghi 1.000–5.000 MB/s, đọc 1.500–7.000 MB/s', good:[1000, 1500], slow:[400, 800], floor:200},
  sata:{label:'SSD SATA', expect:'thường ghi và đọc khoảng 350–550 MB/s', good:[300, 400], slow:[150, 200], floor:60},
  hdd:{label:'ổ cứng HDD', expect:'thường ghi và đọc khoảng 80–200 MB/s', good:[80, 90], slow:[45, 50], floor:20},
};
function diskClass(disk) {
  if (!disk) return null;
  if (/usb|sd|mmc/i.test(disk.bus || '')) return null;
  if (disk.protocol === 'nvme' || /nvme/i.test(disk.bus || '')) return 'nvme';
  if (disk.isSSD || /ssd/i.test(disk.media || '')) return 'sata';
  if (/hdd|unspecified/i.test(disk.media || '') || disk.rotation && disk.rotation !== 'SSD') return 'hdd';
  return null;
}
function diskSpeedVerdict(metrics, disk) {
  if (!metrics || metrics.writeMBps == null) return null;
  const kind = diskClass(disk), c = DISK_CLASSES[kind], points = [];
  const w = metrics.writeMBps, r = metrics.readMBps, min = metrics.minWriteMBps;
  points.push({state:'good', text:`Dữ liệu đọc lại khớp từng byte (SHA-256) trên ${metrics.sizeMiB >= 1024 ? `${metrics.sizeMiB / 1024} GiB` : `${metrics.sizeMiB} MiB`}.`});
  if (!c) return {status:'unknown', label:'Chưa đánh giá', summary:`Không rõ loại ổ${disk?.bus ? ` (${disk.bus})` : ''} nên không so được tốc độ chuẩn.`, expected:null, points};
  const grade = (v, i) => v >= c.good[i] ? 'good' : v >= c.slow[i] ? 'caution' : 'bad';
  const wg = grade(w, 0), rg = metrics.readCached ? 'good' : grade(r, 1);
  const name = {good:'bình thường', caution:'hơi chậm', bad:'chậm bất thường'};
  points.push({state:wg, text:`Ghi ${w} MB/s: ${name[wg]} với ${c.label}.`});
  if (metrics.readCached) points.push({state:'caution', text:`Đọc ${r} MB/s có thể đến từ bộ đệm RAM, không dùng để đánh giá.`});
  else points.push({state:rg, text:`Đọc ${r} MB/s: ${name[rg]} với ${c.label}.`});
  let sustained = 'good';
  if (min != null && min < c.floor) { sustained = 'caution'; points.push({state:'caution', text:`Ghi lâu tụt còn ${min} MB/s: bộ đệm nhanh của ổ đã đầy. Thường gặp ở SSD QLC / không DRAM hoặc ổ gần đầy; chép file lớn sẽ chậm.`}); }
  else if (min != null && kind !== 'hdd' && metrics.maxWriteMBps && min < metrics.maxWriteMBps * 0.4) points.push({state:'good', text:`Tốc độ ghi dao động ${min}–${metrics.maxWriteMBps} MB/s nhưng không tụt dưới ${c.floor} MB/s.`});
  else if (min != null) points.push({state:'good', text:`Ghi ổn định suốt bài (thấp nhất ${min} MB/s).`});
  const worst = [wg, rg, sustained].includes('bad') ? 'bad' : [wg, rg, sustained].includes('caution') ? 'caution' : 'good';
  const label = {good:'Tốt', caution:'Hơi chậm', bad:'Chậm bất thường'}[worst];
  const summary = worst === 'good' ? `Tốc độ đúng mức của ${c.label}, dữ liệu toàn vẹn.`
    : worst === 'caution' ? `Chạy được, dữ liệu toàn vẹn, nhưng có điểm chậm hơn ${c.label} thông thường.`
    : `Chậm hơn nhiều so với ${c.label} khỏe: có thể ổ sắp hỏng, quá nóng, gần đầy hoặc chạy sai chế độ (xem tab Ổ cứng).`;
  return {status:worst, label, summary, expected:`${c.label} ${c.expect}`, kind, points};
}
// Which keyboard to draw. Windows cannot tell which physical keys exist, so this guesses from the chassis (SMBIOS
// type 3) and the built-in panel size (EDID): desktops and laptops of 15" and up usually have a number pad.
const DESKTOP_CHASSIS = new Set([3, 4, 5, 6, 7, 13, 15, 16, 17, 23, 24, 35, 36]);
// Keyboards Windows sees (grouped per physical device by keyboards.ps1). Any of them counts in the key test, so an
// external keyboard must be unplugged to test the laptop's own. Some mice / receivers also expose a keyboard interface.
const KB_KIND = {builtin:'Bàn phím gắn liền (laptop)', usb:'Bàn phím USB', bluetooth:'Bàn phím Bluetooth', other:'Thiết bị bàn phím khác'};
function keyboardDevices(list) {
  const devices = array(list).map(k => ({kind:k.Kind || 'other', label:KB_KIND[k.Kind] || KB_KIND.other, name:k.Name || null, vidPid:k.VidPid || null, ok:(k.Status || 'OK') === 'OK',
    title:k.Name || (k.VidPid ? `${KB_KIND[k.Kind] || 'Thiết bị'} ${k.VidPid}` : KB_KIND[k.Kind] || 'Bàn phím')}));
  const builtin = devices.some(d => d.kind === 'builtin'), external = devices.filter(d => d.kind !== 'builtin');
  // Name hints only: compact boards often say so in their name; "numpad" / "full size" say the opposite.
  const hint = external.map(d => /\b(tkl|tenkeyless|mini|compact|60%|65%|75%)\b/i.test(d.name || '') ? 'compact' : /numpad|full[ -]?size/i.test(d.name || '') ? 'full' : null).find(Boolean) || null;
  const warning = builtin && external.length
    ? `Đang có ${external.length} bàn phím / thiết bị rời kết nối. Phím nhấn từ thiết bị nào cũng được tính: ngắt bàn phím rời trước khi thử bàn phím laptop.`
    : !builtin && devices.length > 1 ? `Windows thấy ${devices.length} thiết bị nhận là bàn phím (chuột gaming hay đầu thu không dây cũng có thể nằm trong đây). Phím nhấn từ thiết bị nào cũng được tính.` : null;
  return {devices, builtin, external:external.length, hint, warning};
}
function keyboardGuess(report) {
  const chassis = number(data(report,'smbiosChassis')[0]?.ChassisType);
  const panels = data(report,'displays').filter(d => number(d.WidthCm) > 0 && number(d.HeightCm) > 0)
    .map(d => ({internal:d.Internal === true, inches:Math.round(Math.hypot(number(d.WidthCm), number(d.HeightCm)) / 2.54 * 10) / 10}));
  const panel = panels.find(p => p.internal) || null;
  const hint = keyboardDevices(data(report,'keyboards')).hint;
  if (chassis !== null && DESKTOP_CHASSIS.has(chassis)) return hint === 'compact' ? {layout:'compact', reason:'Máy để bàn, tên bàn phím rời cho thấy loại không phím số.', panelInches:null} : {layout:'full', reason:'Máy để bàn: bàn phím rời thường đủ phím số.', panelInches:null};
  if (panel) return panel.inches >= 15
    ? {layout:'full', reason:`Màn hình ${panel.inches.toLocaleString('vi-VN')}": laptop cỡ này thường có phím số.`, panelInches:panel.inches}
    : {layout:'compact', reason:`Màn hình ${panel.inches.toLocaleString('vi-VN')}": laptop cỡ này thường không có phím số.`, panelInches:panel.inches};
  if (!panels.length && chassis === null) return {layout:'compact', reason:'Chưa đọc được kiểu máy; mặc định bàn phím laptop.', panelInches:null};
  return panels.length && !panels.some(p => p.internal)
    ? {layout:'full', reason:'Chỉ có màn hình rời: thường dùng bàn phím rời đủ phím số.', panelInches:null}
    : {layout:'compact', reason:'Không đọc được cỡ màn hình laptop; mặc định không có phím số.', panelInches:null};
}
function assess(report) {
  const checks = [];
  for (const [key, section] of Object.entries(report?.sections || {})) {
    if (section.status !== 'ok') checks.push({state:'unknown', title:`Không đọc được: ${key}`, detail:section.error || 'Không có dữ liệu'});
  }
  const license = licenseInfo(report);
  if (report?.sections?.license?.status === 'ok') checks.push({state:license.state,title:`Bản quyền Windows: ${license.label}`,detail:license.detail});
  const usage = usageInfo(report);
  const md = memoryDiagnosticInfo(report);
  if (md.last?.verdict === 'bad') checks.push({state:'warn',title:'Windows Memory Diagnostic phát hiện lỗi RAM',detail:`${md.last.message} (${new Date(md.last.time).toLocaleDateString('vi-VN')}). Thử từng thanh RAM để tìm thanh hỏng.`});
  else if (md.last?.verdict === 'ok') checks.push({state:'info',title:'Windows Memory Diagnostic: không có lỗi RAM',detail:`Lần quét ${new Date(md.last.time).toLocaleDateString('vi-VN')}.`});
  const st = stabilityInfo(report);
  if (st.available && (st.blueScreens || st.hardwareErrors)) checks.push({state:'warn',title:`Máy từng sập: ${st.blueScreens} lần màn hình xanh${st.hardwareErrors ? `, ${st.hardwareErrors} lỗi phần cứng (WHEA)` : ''}`,detail:'Màn hình xanh lặp lại hoặc lỗi WHEA thường do RAM, ổ cứng, driver hoặc nhiệt. Xem tab Sử dụng › Lịch sử sập.'});
  const truth = hardwareTruth(report);
  if (truth.mismatches.length) checks.push({state:'warn',title:`Windows ghi khác phần cứng: ${truth.mismatches.map(m => m.name).join(', ')}`,detail:`${truth.mismatches.map(m => `${m.name}: Windows ghi "${m.windows}", phần cứng là "${m.truth}"`).join('; ')}. Thông tin Windows có thể đã bị sửa để làm đẹp cấu hình — tin theo phần cứng.`});
  else if (truth.available) checks.push({state:'info',title:`Thông tin Windows khớp phần cứng (${truth.items.filter(i => i.match).length} mục đối chiếu)`,detail:'CPU, phiên bản, build, card đồ họa và ổ đĩa đều đọc lại từ kernel / firmware / thiết bị và khớp với Windows.'});
  const mdm = mdmInfo(report);
  if (report?.sections?.mdm) checks.push({state:mdm.state,title:`Quản lý thiết bị: ${mdm.label}`,detail:mdm.detail});
  const office = officeInfo(report);
  if (office.verdict !== 'notInstalled' && report?.sections?.office) checks.push({state:office.state,title:`Microsoft Office: ${office.label}`,detail:office.detail});
  if (usage.windowsInstalled) checks.push({state:'info',title:`Windows cài ngày ${usage.windowsInstalled} (${ago(usage.windowsDays)})`,detail:'Cài lại Windows sẽ đổi ngày này; không phải ngày xuất xưởng. Ngày xuất xưởng xem ở tab Tra bảo hành.'});
  checks.push(...batteryChecks(data(report,'battery')), ...storageChecks(array(report?.diskDetails)));
  data(report,'devices').filter(d=>number(d.ConfigManagerErrorCode)>0).forEach(d=>checks.push({state:'warn',title:`Thiết bị: ${d.Name}`,detail:`Mã lỗi Windows ${d.ConfigManagerErrorCode}. Có thể liên quan driver, thiết bị tắt hoặc phần cứng.`}));
  const events = data(report,'events');
  if(events.length) checks.push({state:'warn',title:`Có ${events.length} sự kiện cần xem trong 7 ngày`,detail:'Nhật ký chỉ là dấu hiệu để điều tra; mất điện/driver cũng có thể gây sự kiện. Không kết luận linh kiện hỏng từ mã log.'});
  return checks;
}
const api={data,number,batteryHealth,licenseInfo,licenseExpiry,keyboardGuess,keyboardDevices,diskSpeedVerdict,memoryDiagnosticInfo,stabilityInfo,firstUseInfo,officeInfo,mdmInfo,hardwareTruth,memoryInfo,memoryVendor,usageInfo,ago,assess,CYCLE_WARN};
if(typeof module!=='undefined') module.exports=api;
else window.assessment=api;
})();
