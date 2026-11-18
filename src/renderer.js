/* Local renderer: no Node.js access. All hardware actions go through the narrow preload bridge. */
'use strict';
const $=selector=>document.querySelector(selector);
const $$=selector=>[...document.querySelectorAll(selector)];
const {data,number,batteryHealth,licenseInfo,licenseExpiry,memoryDiagnosticInfo,stabilityInfo,firstUseInfo,officeInfo,mdmInfo,hardwareTruth,memoryInfo,usageInfo,ago,assess,CYCLE_WARN}=window.assessment;
const {mediaError}=window.mediaErrors;
const esc=value=>String(value ?? '—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Markup helpers. card()/note() take already-escaped HTML; finding()/stat() escape their own text.
const icon=name=>`<svg class="icon"><use href="#i-${name}"/></svg>`;
const card=inner=>`<article class="panel">${inner}</article>`;
const note=(html,tone='')=>`<p class="note ${tone}">${icon(tone==='warn'?'warn':'info')}<span>${html}</span></p>`;
const FINDING_STYLE={warn:['tone-warn','warn'],unknown:['tone-unknown','help'],info:['tone-info','info'],done:['tone-done','check']};
function finding(state,title,detail){
  const [tone,name]=FINDING_STYLE[state] || FINDING_STYLE.info;
  return `<div class="finding"><span class="${tone}">${icon(name)}</span><div class="min-w-0"><p class="text-sm font-medium">${esc(title)}</p><p class="text-xs muted break-words mt-0.5">${esc(detail)}</p></div></div>`;
}
// Tile colors are literal class names so Tailwind's scanner keeps them.
const TILE={zap:'bg-amber-50 text-amber-600',arrow:'bg-sky-50 text-sky-600',windows:'bg-blue-50 text-blue-600',monitor:'bg-indigo-50 text-indigo-600',keyboard:'bg-violet-50 text-violet-600',chip:'bg-teal-50 text-teal-600',globe:'bg-sky-50 text-sky-600',video:'bg-violet-50 text-violet-600',mic:'bg-rose-50 text-rose-600',volume:'bg-blue-50 text-blue-600',play:'bg-emerald-50 text-emerald-600',info:'bg-cyan-50 text-cyan-600',check:'bg-emerald-50 text-emerald-600',clock:'bg-indigo-50 text-indigo-600',chart:'bg-cyan-50 text-cyan-600',warn:'bg-red-50 text-red-600',cpu:'bg-blue-50 text-blue-600',memory:'bg-violet-50 text-violet-600',battery:'bg-amber-50 text-amber-600',drive:'bg-emerald-50 text-emerald-600',calendar:'bg-sky-50 text-sky-600',shield:'bg-teal-50 text-teal-600',cycle:'bg-orange-50 text-orange-600'};
const stat=(label,value,detail,iconName,tile=TILE[iconName])=>`<div class="stat-card"><div class="stat-label">${iconName?`<span class="icon-tile ${tile}">${icon(iconName)}</span>`:''}${esc(label)}</div><div class="stat-main">${esc(value)}</div>${detail?`<div class="stat-sub">${esc(detail)}</div>`:''}</div>`;
const GiB=value=>Number.isFinite(Number(value)) && Number(value)>0 ? `${(Number(value)/1073741824).toFixed(1)} GiB`:'—';
let scanReport=null, scanBusy=false,testBusy=false,fullRun=false,fullStep=-1,stopFull=false;
let toastTimer,keyboardActive=false,audioContext,oscillator,cameraStream,micStream,recorder,micTimer,micURL,micFrame;
const manualItems=[
 ['Cấu hình & Service Tag','Đối chiếu tin rao, vỏ máy, firmware và trang Dell.'],
 ['Ngoại hình / bản lề / ốc','Kiểm tra móp, nứt, thiếu ốc, dấu tháo sửa, mùi khét / dấu nước.'],
 ['Màn hình / điểm chết','Xem đủ trắng, đen, đỏ, xanh lá, xanh dương, xám và lưới.'],
 ['Độ sáng / cáp màn / góc nhìn','Tăng giảm độ sáng, mở gập chậm; quan sát chớp và sọc.'],
 ['Bàn phím / đèn phím / Fn','Bấm từng phím, thử giữ, tổ hợp, đèn nền, Fn tăng giảm âm / sáng.'],
 ['Touchpad / nút chuột','Vẽ, kéo thả, click trái/phải, cuộn và cử chỉ nhiều ngón.'],
 ['Loa trái / phải','Thử từng kênh, nghe giọng và nhạc để kiểm tra rè.'],
 ['Micro','Ghi giọng nói rồi phát lại, kiểm tra nhiễu và mức âm.'],
 ['Webcam / màn trập','Xem hình, độ nét, màu, thử màn trập và camera IR nếu có.'],
 ['Wi-Fi','Kết nối mạng / hotspot thật, mở vài trang hoặc truyền tệp.'],
 ['Bluetooth','Ghép tai nghe / chuột thật, thử âm thanh hoặc thao tác.'],
 ['Cổng USB-A (từng cổng)','Cắm USB có dữ liệu, đọc tệp; thử riêng từng cổng.'],
 ['USB-C / Thunderbolt','Thử dữ liệu, xuất hình / sạc nếu model hỗ trợ từng chức năng.'],
 ['HDMI / DisplayPort','Cắm màn ngoài, kiểm tra hình, độ phân giải và âm thanh.'],
 ['Jack tai nghe / micro','Cắm tai nghe có dây, kiểm tra cả 2 kênh và mic nếu hỗ trợ.'],
 ['LAN / khe thẻ / SIM','Cắm thiết bị thật và truyền dữ liệu. Chọn bỏ qua nếu máy không có.'],
 ['Sạc / jack sạc / công suất','F2: AC Adapter nhận đúng công suất; thử cắm/rút, kiểm tra lỏng.'],
 ['Pin / thời lượng / phồng','Rút sạc thử 10–15 phút, ghi % đầu/cuối; quan sát phồng / sập nguồn.'],
 ['Quạt / nhiệt / ổn định','Nghe tiếng quạt, kiểm tra nóng, treo và hiệu năng với tải thực tế.'],
 ['RAM / ổ đĩa / Dell ePSA','F12 → Diagnostics. Ghi mã lỗi / validation code nếu có.'],
 ['GPU / tác vụ đồ họa','Chạy ứng dụng 3D hoặc video thực tế, tìm artifact / mất hình. App không tự stress GPU.'],
 ['Sleep / wake / restart','Lưu công việc, thử ngủ / đánh thức, đóng nắp và khởi động lại.'],
 ['Cảm ứng / bút / vân tay','Thử từng chức năng nếu model có. Không tự kết luận từ tên thiết bị.'],
 ['BIOS / quyền sở hữu / khóa quản lý','Người bán chứng minh truy cập BIOS, không khóa admin; kiểm tra tài khoản tổ chức / nguồn gốc và giấy tờ.'],
 ['Phụ kiện / điều kiện mua','Sạc, bảo hành, đổi trả và lỗi đã thống nhất bằng văn bản.']
].map(([title,hint])=>({title,hint,status:'Chưa thử',note:''}));
// [title, one-line subtitle] per page; the subtitle replaces the long intro paragraphs.
const pages={
  overview:['Tổng quan','Tóm tắt cấu hình và các điểm cần kiểm tra thêm.'],
  hardware:['Phần cứng','Dữ liệu Windows: hệ điều hành, GPU, ổ đĩa, mạng, thiết bị.'],
  windows:['Windows','Phiên bản, bản quyền Windows / Office, quản lý thiết bị (MDM), bảo mật, tài khoản và bản cập nhật.'],
  memory:['RAM','Từng khe RAM, loại, tốc độ, hãng, kênh đôi / đơn và khả năng nâng cấp — đọc từ bảng SMBIOS của BIOS.'],
  usage:['Sử dụng','Các lần bật máy, thời lượng dùng và thời gian Windows đã kích hoạt (theo nhật ký Windows).'],
  disks:['Ổ cứng','Sức khỏe S.M.A.R.T., nhiệt độ, tuổi thọ SSD và thử tốc độ ghi/đọc.'],
  firmware:['BIOS / SMBIOS','Bảng firmware: model, Service Tag, BIOS, mainboard, CPU, khe RAM.'],
  dell:['Tra Dell','Tra Service Tag qua website Dell hoặc TechDirect API.'],
  battery:['Pin & sạc','Độ chai theo firmware và mức tụt pin đo thực tế.'],
  screen:['Màn hình','Xem từng màu toàn màn hình để tìm điểm chết, sọc, hở sáng.'],
  input:['Bàn phím & chuột','Nhấn từng phím; vẽ, click và cuộn để thử touchpad.'],
  media:['Âm thanh & camera','Thử loa hai kênh, ghi âm micro và xem webcam.'],
  diagnostics:['Bài thử nhanh','Bài thử ngắn cho CPU, RAM và ổ đĩa.'],
  checklist:['Biên bản','Ghi kết quả thử thực tế rồi xuất biên bản HTML.'],
  summary:['Kết quả lượt test','Thống kê lần Test toàn bộ gần nhất.']
};
const sectionLabels={windowsInfo:'Phiên bản Windows',antivirus:'Phần mềm diệt virus',accounts:'Tài khoản trên máy',hotfixes:'Bản cập nhật gần đây',activationHistory:'Lịch sử kiểm tra bản quyền',powerEvents:'Nhật ký bật / tắt máy',usageSessions:'Các lần sử dụng',license:'Bản quyền Windows',activation:'Dấu vết công cụ kích hoạt',os:'Hệ điều hành',gpu:'GPU / màn hình',battery:'Pin (powercfg)',batteryNow:'Pin hiện tại',disks:'Ổ đĩa vật lý',volumes:'Phân vùng',smartRaw:'S.M.A.R.T. ổ đĩa',diskHealth:'Sức khỏe ổ cứng (S.M.A.R.T.)',diskSmart:'Thuộc tính S.M.A.R.T.',network:'Card mạng',audio:'Thiết bị âm thanh',devices:'Camera, Bluetooth, màn hình, thiết bị lỗi',usb:'Thiết bị USB',security:'Secure Boot / TPM',events:'Nhật ký hệ thống (7 ngày)',firmwareInfo:'Nguồn bảng firmware',smbiosBIOS:'BIOS (Type 0)',smbiosSystem:'Model / Service Tag (Type 1)',smbiosBoard:'Mainboard (Type 2)',smbiosChassis:'Khung máy (Type 3)',smbiosCPU:'CPU (Type 4)',smbiosMemoryArray:'Số khe RAM (Type 16)',smbiosMemory:'Từng khe RAM (Type 17)',smbiosBattery:'Pin thiết kế (Type 22)',smbiosStructures:'Tất cả cấu trúc SMBIOS',dellBios:'Thiết lập BIOS Dell (WMI)'};
function toast(message){clearTimeout(toastTimer);$('#toastText').textContent=message;$('#toast').classList.remove('hidden');toastTimer=setTimeout(()=>$('#toast').classList.add('hidden'),7000);}
function go(page){
  if(!pages[page])return;
  if(page!=='media')stopMedia();
  if(page!=='input')setKeyboard(false);
  $$('.page').forEach(el=>el.classList.toggle('active',el.id===page));
  $$('.nav').forEach(el=>el.classList.toggle('menu-active',el.dataset.page===page));
  [$('#pageTitle').textContent,$('#pageSubtitle').textContent]=pages[page];window.scrollTo(0,0);
  renderSummary(page);
  if(page==='input')resizeCanvas();
  if(page==='battery')refreshBattery().catch(e=>toast(e.message));
}
$$('[data-page]').forEach(el=>el.addEventListener('click',()=>go(el.dataset.page)));
// Sidebar collapse is a per-viewer convenience; storage may be unavailable, so failures are ignored.
function setSidebar(collapsed){
  document.body.classList.toggle('sidebar-collapsed',collapsed);
  try{localStorage.setItem('sidebarCollapsed',collapsed?'1':'0');}catch{}
}
const toggleSidebar=()=>setSidebar(!document.body.classList.contains('sidebar-collapsed'));
try{setSidebar(localStorage.getItem('sidebarCollapsed')==='1');}catch{}
$('#toggleSidebar').addEventListener('click',toggleSidebar);
// Light / dark: remembered per viewer; first run follows the Windows app theme.
function setTheme(dark){
  document.documentElement.dataset.theme=dark?'inspect-dark':'inspect';
  $('#toggleTheme use').setAttribute('href',dark?'#i-sun':'#i-moon');
  $('#toggleTheme').title=dark?'Chuyển sang giao diện sáng':'Chuyển sang giao diện tối';
  try{localStorage.setItem('theme',dark?'dark':'light');}catch{}
}
{let saved=null;try{saved=localStorage.getItem('theme');}catch{}setTheme(saved?saved==='dark':matchMedia('(prefers-color-scheme: dark)').matches);}
$('#toggleTheme').addEventListener('click',()=>setTheme(document.documentElement.dataset.theme!=='inspect-dark'));
// Delegated: views re-render their buttons after every scan.
document.addEventListener('click',event=>{const el=event.target.closest('[data-goto],[data-tool],[data-test]');if(!el || el.disabled)return;
  if(el.dataset.goto)go(el.dataset.goto);
  else if(el.dataset.tool)window.inspect.openTool(el.dataset.tool).catch(e=>toast(e.message));
  else if(el.dataset.test)runTest(el.dataset.test,el.dataset.test==='disk'?$('#diskTarget').value:undefined).catch(e=>toast(e.message));});
function updateLocks(){
  const busy=scanBusy || testBusy || fullRun;
  [$('#scan'),$('#testAll'),...$$('[data-test]')].forEach(b=>b.disabled=busy);
  const diskRun=$('#diskTestRun');if(diskRun)diskRun.disabled=busy || !diskRun.dataset.drive;$('#stopTest').disabled=!testBusy;
}
// Media and keyboard capture are released whenever the user leaves a guided step.
function releaseDevices(){stopMedia();setKeyboard(false);}
function renderTable(key,section){
  const label=esc(sectionLabels[key] || key);
  if(section.status!=='ok')return card(`<h3 class="panel-title mb-1">${label}</h3>${note('Chưa xác định: '+esc(section.error),'warn')}`);
  if(!section.data?.length)return card(`<h3 class="panel-title mb-1">${label}</h3><p class="text-xs muted">Không có dữ liệu (không có nghĩa là đạt).</p>`);
  const keys=Object.keys(section.data[0]);
  return `<article class="panel p-0 overflow-hidden"><h3 class="panel-title px-5 py-3.5 flex items-center gap-2">${label}<span class="text-xs font-normal muted tabular">${section.data.length}</span></h3><div class="overflow-x-auto border-t border-base-300"><table class="table table-sm data-table"><thead><tr>${keys.map(k=>`<th>${esc(k)}</th>`).join('')}</tr></thead><tbody>${section.data.map(row=>`<tr>${keys.map(k=>`<td>${esc(row[k])}</td>`).join('')}</tr>`).join('')}</tbody></table></div></article>`;
}
// Machine identity, BIOS, CPU and RAM come from firmware: SMBIOS, plus the CPUID brand string cached by the kernel
// (SMBIOS' CPU name is BIOS-written and sometimes generic). Never the registry, which anyone can edit.
function firmwareIdentity(){
  const slots=data(scanReport,'smbiosMemory'),installed=slots.filter(m=>m.Installed==='Yes');
  return {
    sys:data(scanReport,'smbiosSystem')[0] || {},bios:data(scanReport,'smbiosBIOS')[0] || {},
    cpu:(c=>({...c,Version:hardwareTruth(scanReport).cpu || c.Version}))(data(scanReport,'smbiosCPU').find(c=>c.Version) || {}),slots,installed,
    ramMiB:installed.reduce((sum,m)=>sum+(number(m.SizeMiB) ?? 0),0)
  };
}
function renderScan(){
  const {sys,bios,cpu,slots,installed,ramMiB}=firmwareIdentity(),battery=data(scanReport,'battery')[0],drives=data(scanReport,'disks');
  $('#machineName').textContent=sys.Product || 'Không đọc được model từ SMBIOS';
  const chip=(label,value)=>`<span class="badge bg-base-100 border-base-300 gap-1.5"><span class="muted">${label}</span>${esc(value)}</span>`;
  $('#machineDetail').innerHTML=chip('Hãng',sys.Manufacturer || 'chưa xác định')+chip('Service Tag',sys.SerialNumber || 'chưa xác định')+chip('BIOS',`${bios.Version || '—'}${bios.ReleaseDate?` · ${bios.ReleaseDate}`:''}`)+'<span class="badge bg-primary/10 text-primary border-0">nguồn SMBIOS</span>';
  if(!$('#dellTag').value)$('#dellTag').value=currentDellTag() || '';
  updateIdentity();
  $('#scanStamp').textContent='Quét lúc '+new Date(scanReport.collectedAt).toLocaleTimeString('vi-VN');
  const health=battery?batteryHealth(battery):null;
  const metrics=[
    ['CPU',cpu.Version || 'Chưa xác định',cpu.Cores?`${cpu.Cores} nhân · ${cpu.Threads ?? '—'} luồng`:'Không có dữ liệu','cpu'],
    ['RAM',ramMiB?GiB(ramMiB*1048576):'—',`${installed.length}/${slots.length} khe có RAM`,'memory'],
    ['Pin',health?.wear!=null?`Chai ${health.wear.toFixed(1)}%`:'Chưa xác định',health?.remaining!=null?`Còn ${health.remaining.toFixed(1)}% so thiết kế`:'Đối chiếu BIOS, thử rút sạc','battery'],
    ['Lưu trữ',drives.length?`${drives.length} ổ · ${GiB(drives.reduce((s,d)=>s+Number(d.Size||0),0))}`:'Chưa xác định',(scanReport.diskDetails || []).map(d=>`${d.model}: ${d.health.label}${d.health.percent!=null?` ${d.health.percent}%`:''}`).join(' / ') || 'Không có dữ liệu','drive']
  ];
  $('#metrics').innerHTML=metrics.map(m=>stat(...m)).join('');
  renderUsage(battery);
  const findings=assess(scanReport);
  $('#findingCount').textContent=`${findings.filter(f=>f.state==='warn').length} lưu ý · ${findings.filter(f=>f.state==='unknown').length} chưa rõ`;
  $('#findings').innerHTML=findings.length?findings.map(f=>finding(f.state,f.title,f.detail)).join(''):note('Không thấy cảnh báo từ dữ liệu đã đọc. Vẫn cần thử trực tiếp.');
  const isFirmware=key=>key.startsWith('smbios') || ['firmwareInfo','dellBios'].includes(key);
  $('#hardwareSections').innerHTML=Object.entries(scanReport.sections).filter(([key])=>!isFirmware(key) && !['firmwareRaw','smartRaw','diskSmart','powerEvents','usageSessions','office','mdm','hardwareTruth','stability','firstUse','memoryDiag'].includes(key)).map(([key,section])=>renderTable(key,section)).join('');
  $('#firmwareSections').innerHTML=Object.entries(scanReport.sections).filter(([key])=>isFirmware(key)).map(([key,section])=>renderTable(key,section)).join('') || card('Không đọc được bảng firmware.');
  renderBatterySpecs();
  renderDisks();
  renderUsageHistory();
  renderMemory();
  Object.keys(SUMMARIES).forEach(renderSummary);
  renderWindows();
}
// Usage age, Windows license and battery cycles: the checks buyers most often ask about.
const LICENSE_TILE={genuine:TILE.shield,cracked:'bg-red-50 text-red-600',suspect:'bg-amber-50 text-amber-600',corporate:'bg-amber-50 text-amber-600',inactive:'bg-amber-50 text-amber-600',none:'bg-red-50 text-red-600'};
function renderUsage(battery){
  const usage=usageInfo(scanReport),license=licenseInfo(scanReport),cycles=number(battery?.CycleCount);
  const usageDetail=[usage.windowsDays!==null?ago(usage.windowsDays):'',usage.diskPowerOnHours!==null?`ổ chạy ${usage.diskPowerOnHours} giờ`:'',usage.batteryManufactured?`pin SX ${usage.batteryManufactured}`:''].filter(Boolean).join(' · ') || 'Không phải ngày xuất xưởng';
  const rows=[
    ['Windows cài đặt',usage.windowsInstalled || 'Chưa xác định',usageDetail,'calendar'],
    ['Bản quyền Windows',license.label,[license.channel?`Kênh ${license.channel}`:license.detail,license.evidence.length?`${license.evidence.length} dấu hiệu`:'',scanReport.usage?.activation?.known?`kích hoạt ≥ ${scanReport.usage.activation.days} ngày`:''].filter(Boolean).join(' · '),'shield',LICENSE_TILE[license.verdict]],
    ['Chu kỳ sạc pin',cycles ?? (battery?'Chưa xác định':'Không có pin'),cycles===null?'Firmware không báo':cycles>=CYCLE_WARN?`≥ ${CYCLE_WARN} chu kỳ, cân nhắc thay pin`:`Theo ${battery.CycleSource || 'firmware'}`,'cycle']
  ];
  $('#usageMetrics').innerHTML=rows.map(r=>stat(...r)).join('');
}
let dellConfigured=false,dellLast=null;
function currentDellTag(){
  const sys=data(scanReport,'smbiosSystem')[0];
  if(!/dell/i.test(sys?.Manufacturer || ''))return null;
  const tag=String(sys.SerialNumber || '').trim().toUpperCase();
  return /^[A-Z0-9]{5,12}$/.test(tag)?tag:null;
}
function updateIdentity(){
  const tag=currentDellTag(),maker=data(scanReport,'smbiosSystem')[0]?.Manufacturer;
  $('#dellIdentity').textContent=tag?`Đọc từ SMBIOS: ${tag}`:maker && !/dell/i.test(maker)?`Máy này là ${maker}, không phải Dell. Nhập mã trên tem máy.`:'Chưa đọc được Service Tag Dell. Nhập mã trên tem máy.';
  $('#useCurrentTag').disabled=!tag;
}
$('#useCurrentTag').addEventListener('click',()=>{const tag=currentDellTag();if(tag){$('#dellTag').value=tag;toast('Đã điền Service Tag đọc từ BIOS: '+tag);}});
$('#dellConnect').addEventListener('click',async()=>{
  try{const result=await window.inspect.dellConfigure({id:$('#dellClientId').value,secret:$('#dellSecret').value});dellConfigured=result.configured;$('#dellClientId').value='';$('#dellSecret').value='';$('#dellAuthStatus').textContent='Đã nạp khóa cho phiên này · nhấn tra để xác thực với Dell';toast('Khóa chỉ ở RAM của phiên hiện tại.');}catch(e){toast(e.message);}
});
$('#dellClear').addEventListener('click',async()=>{await window.inspect.dellConfigure({clear:true});dellConfigured=false;$('#dellClientId').value='';$('#dellSecret').value='';$('#dellAuthStatus').textContent='Đã xóa khóa và token khỏi phiên.';});
$('#supportFallback').addEventListener('click',()=>window.inspect.support($('#dellTag').value || undefined).catch(e=>toast(e.message)));
async function lookupDell(){
  $('#dellLookup').disabled=true;$('#dellResults').innerHTML='<p class="flex items-center gap-2 text-sm muted"><span class="loading loading-spinner loading-xs"></span>Đang kết nối Dell…</p>';
  try{
    if($('#dellMethod').value==='web'){
      const result=await window.inspect.dellWebLookup($('#dellTag').value);
      const match=result.matchesFirmware===true?'Mã gửi tra khớp firmware máy hiện tại.':result.matchesFirmware===false?'Mã gửi tra khác firmware máy hiện tại.':'Chưa có mã firmware để đối chiếu.';
      dellLast={ok:true,at:result.queriedAt,via:'Dell website'};renderSummary('dell');
      $('#dellResults').innerHTML=note(`${esc(match)} Phản hồi lúc ${esc(new Date(result.queriedAt).toLocaleString('vi-VN'))}. Các trường giữ nguyên như Dell trả; HTTP 200 chưa chắc là tìm thấy máy.`)+renderTable('Phản hồi Dell website',{status:'ok',data:result.fields});
      return result;
    }
    const result=await window.inspect.dellLookup($('#dellTag').value);
    const match=result.matchesFirmware===true?'Khớp Service Tag của máy này.':result.matchesFirmware===false?'Khác Service Tag của máy này — có thể đang tra máy khác.':'Chưa có Service Tag firmware để đối chiếu.';
    dellLast={ok:true,at:result.asset.QueriedAt,via:'TechDirect API',warranty:result.entitlements?.length || 0};renderSummary('dell');
    $('#dellResults').innerHTML=note(`${esc(match)} Tra lúc ${esc(new Date(result.asset.QueriedAt).toLocaleString('vi-VN'))}.`)+renderTable('Model / xuất xưởng',{status:'ok',data:[result.asset]})+renderTable('Dịch vụ bảo hành',{status:'ok',data:result.entitlements})+note('Khoảng ngày dịch vụ chưa xác nhận điều kiện bảo hành tại Việt Nam; hỏi Dell về chuyển quyền sở hữu.','warn');
    $('#dellAuthStatus').textContent='Đã xác thực và nhận dữ liệu Dell trong phiên này.';return result;
  }catch(e){dellLast={ok:false,error:e.message};renderSummary('dell');$('#dellResults').innerHTML=card(`<h3 class="panel-title mb-1">Chưa lấy được thông tin Dell</h3>${note(esc(e.message),'warn')}`);throw e;}
  finally{$('#dellLookup').disabled=false;}
}
$('#dellLookup').addEventListener('click',()=>lookupDell().catch(e=>toast(e.message)));
function updateDellMethod(){
  const web=$('#dellMethod').value==='web',panel=$('#dellClientId').closest('article');panel.classList.toggle('hidden',web);
  $('#dellColumns').classList.toggle('grid-cols-2',!web);$('#dellColumns').classList.toggle('max-w-xl',web);
  $('#dellLookup').textContent=web?'Tra trên website Dell':'Tra model & bảo hành';
}
$('#dellMethod').addEventListener('change',updateDellMethod);updateDellMethod();
$('#openDellBrowser').addEventListener('click',()=>window.inspect.dellWebBrowser($('#dellTag').value || undefined).catch(e=>toast(e.message)));
// ---- Ổ cứng: per-drive S.M.A.R.T. view (decoded in the main process by disk-health.cjs) ----
let diskIndex=0;
const bytesText=value=>value==null?'—':value>=1e12?`${(value/1e12).toFixed(2)} TB`:`${Math.round(value/1e9)} GB`;
const countText=(value,unit='')=>value==null?'—':`${Number(value).toLocaleString('vi-VN')}${unit}`;
const mini=(label,value,sub)=>`<div><p class="text-xs muted">${esc(label)}</p><p class="text-lg font-semibold tabular">${esc(value)}</p>${sub?`<p class="text-xs muted">${esc(sub)}</p>`:''}</div>`;
const diskField=(label,value)=>`<div class="disk-field"><span class="muted">${esc(label)}</span><span class="font-medium tabular">${esc(value || '—')}</span></div>`;
function diskTab(d,i){
  const h=d.health,t=d.temperature;
  return `<button class="disk-tab${i===diskIndex?' active':''}" data-disk="${i}" title="${esc(d.model)}"><span class="disk-dot ${h.status}"></span><span class="text-left"><span class="block text-xs font-semibold">${esc(h.label)}${h.percent!=null?` ${h.percent}%`:''}</span><span class="block text-[11px] muted tabular">${t.celsius!=null?`${t.celsius} °C`:'— °C'} · ${esc(d.driveLetters || `Ổ ${d.index}`)}</span></span></button>`;
}
function lifePanel(d){
  if(!d.isSSD)return '';
  const l=d.life;
  if(!l)return card(`<h3 class="panel-title mb-2">Tuổi thọ SSD</h3>${note('Ổ không báo mức hao mòn (Percentage Used).'+(d.needsAdmin?' Đọc bảng SMART bằng quyền quản trị để tìm chỉ số tuổi thọ của hãng.':''))}`);
  const tone=l.remainingPercent<=10?'progress-error':l.remainingPercent<=30?'progress-warning':'progress-primary';
  const estimate=l.years==null?'—':l.years>=1?`≈ ${l.years.toFixed(1)} năm`:`≈ ${Math.max(1,Math.round(l.years*12))} tháng`;
  const estimateSub=l.years!=null?`còn ~${countText(Math.round(l.remainingHours),' giờ')} chạy · giả định ${l.hoursPerDay} giờ/ngày`:l.percentUsed===0?'Hao mòn 0%: ổ còn rất mới, chưa đủ dữ liệu để ước tính':'Thiếu số giờ chạy';
  return `<article class="panel"><div class="flex items-center gap-2 mb-3"><h3 class="panel-title">Tuổi thọ SSD</h3><span class="text-xs muted">độ bền ghi còn lại</span><span class="ml-auto text-sm font-semibold tabular">${l.remainingPercent}%</span></div><progress class="progress ${tone} w-full" value="${l.remainingPercent}" max="100"></progress>
    <div class="grid sm:grid-cols-3 gap-4 mt-4">${mini('Đã ghi',bytesText(l.writtenBytes),l.writtenPerHour!=null?`${(l.writtenPerHour/1e9).toFixed(1)} GB mỗi giờ chạy`:'')}${mini('Đã dùng độ bền',`${l.percentUsed}%`,'Ổ tự báo (Percentage Used)')}${mini('Ước tính còn',estimate,estimateSub)}</div>
    <div class="mt-3">${note('Ước tính tuyến tính theo tốc độ hao mòn đến nay. Ổ báo % hao mòn là số nguyên nên sai số lớn khi ổ còn mới. Không phải thời hạn bảo hành của hãng.')}</div></article>`;
}
function smartPanel(d){
  const admin=d.needsAdmin?`<div class="flex items-center gap-3 px-5 py-3 border-t border-base-300 bg-amber-50/60">${note('Windows chỉ cho đọc bảng thuộc tính S.M.A.R.T. của ổ SATA khi có quyền quản trị. Số liệu phía trên lấy từ Device Statistics của ổ (không cần quyền).','warn')}<button class="btn btn-sm btn-quiet shrink-0 ml-auto" id="smartAdmin">${icon('shield')}Đọc bằng quyền quản trị</button></div>`:'';
  if(!d.attributes.length)return `<article class="panel p-0 overflow-hidden"><h3 class="panel-title px-5 py-3.5">Thuộc tính S.M.A.R.T.</h3>${admin || '<p class="px-5 pb-4 text-xs muted">Ổ không trả bảng thuộc tính.</p>'}</article>`;
  const nvme=d.attributeKind==='nvme';
  const head=nvme?['','ID','Thuộc tính','Giá trị thô','Thập phân']:['','ID','Thuộc tính','Hiện tại','Tệ nhất','Ngưỡng','Giá trị thô'];
  const rows=d.attributes.map(a=>`<tr><td><span class="disk-dot ${a.status}"></span></td><td class="tabular">${esc(a.id)}</td><td>${esc(a.name)}</td>${nvme?`<td class="mono">${esc(a.raw)}</td><td class="tabular">${esc(Number(a.rawValue).toLocaleString('vi-VN'))}</td>`:`<td class="tabular">${esc(a.current)}</td><td class="tabular">${esc(a.worst)}</td><td class="tabular">${esc(a.threshold)}</td><td class="mono">${esc(a.raw)}</td>`}</tr>`).join('');
  return `<article class="panel p-0 overflow-hidden"><h3 class="panel-title px-5 py-3.5 flex items-center gap-2">Thuộc tính S.M.A.R.T.<span class="text-xs font-normal muted">${nvme?'NVMe SMART / Health Information (log 02h)':'tên thuộc tính tùy hãng'}</span></h3>${admin}<div class="overflow-x-auto border-t border-base-300"><table class="table table-sm smart-table"><thead><tr>${head.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div></article>`;
}
// One drive letter per physical disk (its first volume) is what the speed test writes to.
const firstLetter=d=>String(d.driveLetters || '').split(/\s+/)[0] || '';
const diskDrives=()=>(scanReport?.diskDetails || []).map(firstLetter).filter(Boolean);
const diskTests={};let diskTestDrive=null;
// Write-test sizes; bigger files show sustained speed after an SSD's fast cache fills. Choice is remembered per viewer.
const DISK_SIZES=[[256,'256 MiB · nhanh'],[1024,'1 GiB'],[4096,'4 GiB · tệp nặng'],[8192,'8 GiB'],[16384,'16 GiB · rất nặng']];
let diskTestSize=256;
try{const saved=Number(localStorage.getItem('diskTestSize'));if(DISK_SIZES.some(([v])=>v===saved))diskTestSize=saved;}catch{}
const sizeLabel=mib=>mib>=1024?`${mib/1024} GiB`:`${mib} MiB`;
const sizeOptions=()=>DISK_SIZES.map(([v,l])=>`<option value="${v}"${v===diskTestSize?' selected':''}>${l}</option>`).join('');
function setDiskTestSize(value){
  if(!DISK_SIZES.some(([v])=>v===value))return;diskTestSize=value;
  try{localStorage.setItem('diskTestSize',String(value));}catch{}
  $$('[data-disk-size]').forEach(el=>{el.value=String(value);});
  const hint=$('#diskTestHint');if(hint)hint.textContent=`Ghi tệp tạm ${sizeLabel(value)} thẳng xuống ổ, đo tốc độ theo thời gian, đọc lại so SHA-256 rồi xóa ngay.`;
}
$$('[data-disk-size]').forEach(el=>{el.value=String(diskTestSize);});
function speedSparkline(samples){
  if(!samples || samples.length<3)return '';
  const max=Math.max(...samples),w=600,h=56,step=w/(samples.length-1);
  const points=samples.map((v,i)=>`${(i*step).toFixed(1)},${(h-4-(v/max)*(h-12)).toFixed(1)}`).join(' ');
  return `<div class="mt-3"><p class="text-xs muted mb-1">Tốc độ ghi theo thời gian (đỉnh ${max} MB/s): tụt mạnh giữa chừng là lúc bộ đệm nhanh của SSD đã đầy.</p><svg class="w-full h-14 text-primary" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Tốc độ ghi theo thời gian"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke"/></svg></div>`;
}
function testStrip(d){
  const drive=firstLetter(d),last=drive?diskTests[drive]:null,running=diskTestDrive===drive;
  const result=running?'<span class="text-xs muted" id="diskTestStatus">Đang chuẩn bị…</span>'
    :last?.metrics?`<span class="text-sm tabular"><b>${last.metrics.writeMBps}</b> MB/s ghi${last.metrics.minWriteMBps!=null?` <span class="muted text-xs">(thấp nhất ${last.metrics.minWriteMBps})</span>`:''} · <b>${last.metrics.readMBps}</b> MB/s đọc <span class="muted text-xs">· ${esc(sizeLabel(last.metrics.sizeMiB || 256))}</span></span>`
    :last?`<span class="text-xs tone-warn">${esc(last.detail)}</span>`:'<span class="text-xs muted">Chưa thử</span>';
  const disabled=!drive || testBusy || scanBusy || fullRun;
  return `<article class="panel py-3.5"><div class="flex flex-wrap items-center gap-x-4 gap-y-2"><span class="icon-tile ${TILE.drive}">${icon('zap')}</span><div class="flex-1 min-w-48"><h3 class="panel-title">Thử ghi / đọc ${drive?`ổ ${esc(drive)}`:'ổ'}</h3><p class="text-xs muted mt-0.5" id="diskTestHint">${drive?`Ghi tệp tạm ${sizeLabel(diskTestSize)} thẳng xuống ổ, đo tốc độ theo thời gian, đọc lại so SHA-256 rồi xóa ngay.`:'Ổ không có ký tự ổ đĩa nên không thử ghi được.'}</p></div>${result}<select class="select select-sm w-40" data-disk-size aria-label="Dung lượng tệp thử" ${running?'disabled':''}>${sizeOptions()}</select>${running?`<button class="btn btn-sm btn-quiet shrink-0" id="diskTestStop">${icon('stop')}Dừng</button>`:`<button class="btn btn-sm btn-primary shrink-0" id="diskTestRun" data-drive="${drive}" ${disabled?'disabled':''}>${icon('play')}Thử ngay</button>`}</div>${running?'<progress class="progress progress-primary w-full mt-3" id="diskTestProgress" value="0" max="100"></progress>':speedSparkline(last?.metrics?.samples)}</article>`;
}
function renderDisks(){
  const disks=scanReport?.diskDetails || [];
  if(!disks.length){
    $('#diskTabs').innerHTML='';
    const error=scanReport?.sections?.diskHealth?.error || scanReport?.sections?.smartRaw?.error;
    $('#diskView').innerHTML=card(note(scanReport?`Không đọc được dữ liệu ổ đĩa${error?': '+esc(error):''}.`:'Chưa quét.','warn'));return;
  }
  diskIndex=Math.min(diskIndex,disks.length-1);
  $('#diskTabs').innerHTML=disks.map(diskTab).join('');
  const target=$('#diskTarget'),chosen=target.value;
  target.innerHTML=disks.filter(firstLetter).map(x=>`<option value="${firstLetter(x)}">${esc(firstLetter(x))} · ${esc(x.model)}</option>`).join('');
  if(chosen && diskDrives().includes(chosen))target.value=chosen;
  const d=disks[diskIndex],h=d.health,t=d.temperature,c=d.counters;
  const boxes=`<div class="grid grid-cols-2 lg:grid-cols-1 gap-4"><div class="hbox ${h.status}"><span class="hbox-label">Tình trạng sức khỏe</span><span class="hbox-value">${esc(h.label)}</span>${h.percent!=null?`<span class="hbox-sub tabular">${h.percent} %</span>`:''}</div><div class="hbox ${t.status}"><span class="hbox-label">Nhiệt độ</span><span class="hbox-value tabular">${t.celsius!=null?`${t.celsius} °C`:'—'}</span><span class="hbox-sub">cảnh báo từ ${t.warn ?? '—'} °C</span></div></div>`;
  const left=[['Firmware',d.firmware],['Số serial',d.serial],['Giao tiếp',d.bus],['Chế độ truyền',d.transferMode],['Ký tự ổ',d.driveLetters],['Chuẩn',d.standard]];
  const right=[['Tổng đọc',bytesText(c.readBytes)],['Tổng ghi',bytesText(c.writtenBytes)],['Tốc độ quay',d.rotation],['Số lần bật',countText(c.powerCycles,' lần')],['Giờ chạy',countText(c.powerOnHours,' giờ')],['Tắt máy đột ngột',countText(c.unsafeShutdowns,' lần')],['Bật lần đầu',c.powerOnHours!=null?`trước ${new Date(Date.now()-c.powerOnHours*3600000).toLocaleDateString('vi-VN')}`:null]];
  const info=`<article class="panel"><div class="flex items-baseline gap-2 mb-2"><h3 class="text-base font-semibold">${esc(d.model)}</h3><span class="muted text-sm tabular">${esc(bytesText(d.capacity))}</span></div><div class="grid sm:grid-cols-2 gap-x-8"><div>${left.map(f=>diskField(...f)).join('')}</div><div>${right.map(f=>diskField(...f)).join('')}</div></div>${diskField('Tính năng',d.features.join(', '))}${c.powerOnHours!=null?`<p class="text-xs muted mt-2">Ổ không lưu ngày bật lần đầu. Mốc “trước …” = hôm nay trừ ${countText(c.powerOnHours,' giờ')} ổ đã chạy, nên lần bật đầu tiên thật còn sớm hơn (ổ có lúc tắt).</p>`:''}</article>`;
  const reasons=[...h.reasons,...d.errors];
  const notes=reasons.length?card(`<h3 class="panel-title mb-2">Lý do đánh giá</h3><div class="space-y-1.5">${reasons.map(r=>note(esc(r),'warn')).join('')}</div>`):h.status==='good'?note('Không thấy dấu hiệu bất thường trong dữ liệu S.M.A.R.T. ổ tự báo. Vẫn nên bấm Thử ngay ở trên để thử ghi/đọc.'):'';
  $('#diskView').innerHTML=`<div class="space-y-4">${testStrip(d)}<div class="grid gap-4 lg:grid-cols-[13rem_1fr]">${boxes}${info}</div>${notes}${lifePanel(d)}${smartPanel(d)}</div>`;
}
document.addEventListener('change',event=>{if(event.target.matches('[data-disk-size]'))setDiskTestSize(Number(event.target.value));});
$('#diskTabs').addEventListener('click',event=>{const tab=event.target.closest('[data-disk]');if(tab){diskIndex=Number(tab.dataset.disk);renderDisks();}});
$('#diskView').addEventListener('click',event=>{
  if(event.target.closest('#smartAdmin'))readSmartAdmin();
  const run=event.target.closest('#diskTestRun');
  if(run && !run.disabled)runTest('disk',run.dataset.drive).catch(e=>toast(e.message));
  if(event.target.closest('#diskTestStop'))window.inspect.stop().catch(e=>toast(e.message));
});
// Busy bar under the header: a percentage when progress is known, an animated bar otherwise.
function showBusy(text,percent=null){
  $('#busy').classList.remove('hidden');$('#busyText').textContent=text;
  const bar=$('#busyBar');
  if(percent===null){bar.removeAttribute('value');$('#busyPercent').textContent='';}
  else{bar.value=percent;$('#busyPercent').textContent=`${percent}%`;}
}
const hideBusy=()=>$('#busy').classList.add('hidden');
// SATA SMART tables need admin rights: Windows shows its UAC popup and only the SMART reader runs elevated.
// After a scan the popup opens by itself when a drive needs it; once declined it is not reopened
// automatically this session (the button on the Ổ cứng page asks again).
let smartDeclined=false;
const smartNeedsAdmin=()=>(scanReport?.diskDetails || []).some(d=>d.needsAdmin);
async function elevateSmart(){
  showBusy('Đọc bảng S.M.A.R.T. ổ SATA bằng quyền quản trị (nếu Windows hỏi, bấm Yes)…');
  try{
    const result=await window.inspect.diskSmartAdmin();
    Object.assign(scanReport.sections,{diskHealth:result.diskHealth,diskSmart:result.diskSmart});scanReport.diskDetails=result.diskDetails;
    renderScan();toast('Đã đọc bảng S.M.A.R.T. bằng quyền quản trị.');return true;
  }catch(e){if(/UAC/.test(e.message))smartDeclined=true;toast(e.message);return false;}
}
async function readSmartAdmin(){
  if(scanBusy || testBusy){toast('Đang có tác vụ chạy.');return;}
  smartDeclined=false;scanBusy=true;updateLocks();
  try{await elevateSmart();}
  finally{scanBusy=false;hideBusy();updateLocks();}
}
// ---- Sử dụng: sessions from the Windows power log (decoded in main by usage-history.cjs) ----
const spanText=ms=>ms==null?'Không rõ':ms<3600000?`${Math.max(1,Math.round(ms/60000))} phút`:`${Math.floor(ms/3600000)} giờ ${Math.round(ms%3600000/60000)} phút`;
const when=iso=>iso?new Date(iso).toLocaleString('vi-VN',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}):'Không rõ';
function usageChart(daily){
  const max=Math.max(1,...daily.map(d=>d.hours)),w=600,h=140,step=w/daily.length,bar=Math.max(2,step-4);
  const bars=daily.map((d,i)=>{const bh=d.hours/max*(h-24),x=i*step+2,y=h-18-bh;return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bar.toFixed(1)}" height="${Math.max(bh,d.hours?1.5:0).toFixed(1)}" rx="2" fill="currentColor"><title>${new Date(d.day).toLocaleDateString('vi-VN')}: ${d.hours} giờ</title></rect>`;}).join('');
  const labels=daily.map((d,i)=>i%5===0 || i===daily.length-1?`<text x="${(i*step+step/2).toFixed(1)}" y="${h-4}" text-anchor="middle" font-size="10" fill="currentColor" opacity=".55">${new Date(d.day).toLocaleDateString('vi-VN',{day:'2-digit',month:'2-digit'})}</text>`:'').join('');
  return `<svg class="usage-chart text-primary" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Số giờ dùng mỗi ngày trong 30 ngày">${bars}<g class="text-base-content">${labels}</g><text x="0" y="10" font-size="10" fill="currentColor" opacity=".55" class="text-base-content">${max.toFixed(1)} giờ</text></svg>`;
}
// Each page opens with a strip of the few facts that matter on it. Builders return stat() cards; pages without data
// yet show what is missing instead of being empty.
const lastTests={};let mediaCounts=null;
let memoryShare=(()=>{try{const v=Number(localStorage.getItem('memoryShare'));return [25,50,75].includes(v)?v:50;}catch{return 50;}})();
function setMemoryShare(v){memoryShare=v;try{localStorage.setItem('memoryShare',String(v));}catch{}$$('[data-mem-share]').forEach(el=>{el.value=String(v);});}
document.addEventListener('change',event=>{const el=event.target.closest('[data-mem-share]');if(el)setMemoryShare(Number(el.value));});
const STATUS_RANK={bad:3,caution:2,unknown:1,good:0};
const SUMMARIES={
  hardware:()=>{
    if(!scanReport)return null;
    const {cpu}=firmwareIdentity(),mem=memoryInfo(scanReport),truth=hardwareTruth(scanReport);
    const gpus=truth.gpus?.length?truth.gpus.map(g=>g.model || g.windowsName):data(scanReport,'gpu').map(g=>g.Name);
    const broken=[...data(scanReport,'devices'),...data(scanReport,'usb')].filter(d=>number(d.ConfigManagerErrorCode)>0);
    return [stat('CPU',cpu.Version || '—',cpu.Cores?`${cpu.Cores} nhân · ${cpu.Threads ?? '—'} luồng`:'','cpu'),
      stat('RAM',mem.available?`${+(mem.totalMiB/1024).toFixed(1)} GB ${mem.types.join('/')}`:'—',mem.available?[mem.runningMTs?`${mem.runningMTs} MT/s`:'',mem.channel==='dual'?'kênh đôi':mem.channel==='single'?'kênh đơn':''].filter(Boolean).join(' · '):'','memory'),
      stat('Card đồ họa',gpus[0] || '—',gpus.length>1?gpus.slice(1).join(' · '):truth.gpus?.[0]?`PCI ${truth.gpus[0].vendorId}:${truth.gpus[0].deviceId}`:'','monitor'),
      stat('Thiết bị lỗi',broken.length?`${broken.length} thiết bị`:'Không có',broken.map(d=>d.Name).slice(0,3).join(' · ') || 'Trình quản lý thiết bị không báo lỗi',broken.length?'warn':'check')];
  },
  disks:()=>{
    const ds=scanReport?.diskDetails || [];if(!ds.length)return null;
    const worst=[...ds].sort((a,b)=>STATUS_RANK[b.health.status]-STATUS_RANK[a.health.status] || (a.health.percent ?? 101)-(b.health.percent ?? 101))[0];
    const temps=ds.map(d=>d.temperature.celsius).filter(t=>t!=null),hot=temps.length?Math.max(...temps):null;
    const hours=ds.map(d=>d.counters?.powerOnHours).filter(h=>h!=null),written=ds.reduce((s,d)=>s+(d.counters?.writtenBytes || 0),0);
    return [stat('Số ổ',`${ds.length} ổ`,`Tổng ${GiB(ds.reduce((s,d)=>s+Number(d.capacity || 0),0))}`,'drive'),
      stat('Sức khỏe thấp nhất',`${worst.health.label}${worst.health.percent!=null?` ${worst.health.percent}%`:''}`,worst.model,worst.health.status==='good'?'check':'warn'),
      stat('Nhiệt độ cao nhất',hot!=null?`${hot} °C`:'—',ds.map(d=>d.temperature.celsius!=null?`${d.model}: ${d.temperature.celsius} °C`:'').filter(Boolean).join(' · '),'zap'),
      stat('Đã chạy',hours.length?`${Math.max(...hours).toLocaleString('vi-VN')} giờ`:'—',written?`Tổng đã ghi ${(written/1e12).toFixed(2)} TB`:'','clock')];
  },
  firmware:()=>{
    if(!scanReport)return null;
    const {sys,bios}=firmwareIdentity(),info=data(scanReport,'firmwareInfo')[0] || {},truth=hardwareTruth(scanReport),dell=data(scanReport,'dellBios');
    return [stat('Máy',sys.Product || '—',[sys.Manufacturer,sys.SerialNumber?`Tag ${sys.SerialNumber}`:''].filter(Boolean).join(' · '),'chip'),
      stat('BIOS',bios.Version || '—',bios.ReleaseDate?`Phát hành ${bios.ReleaseDate}`:'','calendar'),
      stat('Bảng SMBIOS',info.Version?`Phiên bản ${info.Version}`:'—',info.Structures?`${info.Structures} cấu trúc · ${info.Bytes} byte`:'','info'),
      stat('Khóa OEM trong BIOS',truth.oemKeyTail?'Có':'Không có',truth.oemKeyTail?`•••••-${truth.oemKeyTail} (bảng ACPI MSDM)`:dell.length?`${dell.length} thiết lập Dell đọc được`:'Máy không kèm Windows bản quyền OEM','shield')];
  },
  dell:()=>{
    const {sys}=scanReport?firmwareIdentity():{sys:{}};
    const last=!dellLast?['Chưa tra','Bấm Tra cứu để hỏi Dell','globe']:dellLast.ok?['Đã tra',`${dellLast.via} · ${new Date(dellLast.at).toLocaleString('vi-VN')}${dellLast.warranty!=null?` · ${dellLast.warranty} dịch vụ bảo hành`:''}`,'check']:['Lỗi',dellLast.error,'warn'];
    return [stat('Service Tag (BIOS)',sys.SerialNumber || '—',/dell/i.test(sys.Manufacturer || '')?'Đọc từ SMBIOS':'Máy không phải Dell?','chip'),
      stat('Model',sys.Product || '—',sys.Family || '','cpu'),
      stat('Cách tra',$('#dellMethod')?.selectedOptions[0]?.textContent || '—',dellConfigured?'Đã nhập khóa TechDirect':'Chưa nhập khóa TechDirect','globe'),
      stat('Kết quả',last[0],last[1],last[2])];
  },
  screen:()=>{
    const g=data(scanReport,'gpu').find(x=>number(x.CurrentRefreshRate)>1) || {},dpr=window.devicePixelRatio || 1;
    const panels=data(scanReport,'devices').filter(d=>d.PNPClass==='Monitor').map(d=>d.Name);
    return [stat('Độ phân giải',`${Math.round(screen.width*dpr)} × ${Math.round(screen.height*dpr)}`,`Đang hiển thị ${screen.width} × ${screen.height} điểm`,'monitor'),
      stat('Tần số quét',g.CurrentRefreshRate?`${g.CurrentRefreshRate} Hz`:'—',g.Name || '','zap'),
      stat('Tỉ lệ hiển thị',`${Math.round(dpr*100)}%`,panels.join(' · ') || 'Màn hình','info'),
      stat('Điểm nghi ngờ',`${pixelMarks.length} vị trí`,pixelMarks.length?'Sẽ ghi vào biên bản':'Chưa đánh dấu',pixelMarks.length?'warn':'check')];
  },
  input:()=>{
    const keys=$$('.key'),seen=$$('.key.seen').length;
    return [stat('Phím đã nhận',`${seen}/${keys.length}`,keys.length?`${Math.round(seen*100/keys.length)}% bàn phím`:'','keyboard'),
      stat('Thử phím',keyboardActive?'Đang bật':'Đang tắt',keyboardActive?'Nhấn lần lượt từng phím':'Bấm “Bắt đầu thử phím”','play'),
      stat('Click',`${clicks[0]+clicks[1]+clicks[2]} lần`,`Trái ${clicks[0]} · Giữa ${clicks[1]} · Phải ${clicks[2]}`,'cpu'),
      stat('Cuộn',`${wheels} lần`,'Touchpad hai ngón hoặc con lăn','arrow')];
  },
  media:()=>{
    const c=mediaCounts;
    return [stat('Camera',c?`${c.camera} thiết bị`:'—',cameraStream?'Đang bật':'Đang tắt','video'),
      stat('Micro',c?`${c.mic} thiết bị`:'—',micStream?'Đang ghi':'Chưa ghi','mic'),
      stat('Loa / tai nghe',c?`${c.speaker} thiết bị`:'—',data(scanReport,'audio').map(a=>a.Name).slice(0,2).join(' · '),'volume'),
      stat('Lỗi âm thanh',data(scanReport,'audio').filter(a=>number(a.ConfigManagerErrorCode)>0).length?'Có':'Không',scanReport?'Theo trình quản lý thiết bị':'Chưa quét','check')];
  },
  diagnostics:()=>{
    const one=(kind,label,iconName)=>{const r=lastTests[kind];return stat(label,!r?'Chưa chạy':r.cancelled?'Đã dừng':r.state==='completed'?'Đạt':'Có lỗi',r?.detail?String(r.detail).slice(0,90):'',r && !r.cancelled && r.state!=='completed'?'warn':iconName);};
    const done=Object.values(lastTests).filter(r=>!r.cancelled).length;
    return [one('cpu','CPU','cpu'),lastTests.memoryDeep?one('memoryDeep','RAM (thử sâu)','memory'):one('memory','RAM','memory'),one('disk','Ổ đĩa','drive'),stat('Đã chạy',`${done} bài`,testBusy?'Đang chạy…':'','chart')];
  },
};
function renderSummary(page){
  const el=document.querySelector(`[data-summary="${page}"]`),build=SUMMARIES[page];
  if(!el || !build)return;
  try{const cards=build();el.innerHTML=cards?cards.join(''):'';el.classList.toggle('hidden',!cards);}
  catch(e){el.innerHTML='';el.classList.add('hidden');console.warn(`Tổng quan trang ${page}: ${e.message}`);}
}
function memoryTestPanel(){
  const deep=lastTests.memoryDeep,md=memoryDiagnosticInfo(scanReport || {sections:{}}),busy=testBusy;
  const deepResult=!deep?'<p class="text-sm muted">Chưa chạy.</p>':`<div class="text-sm ${deep.state==='completed'?'':'tone-warn'} flex gap-2">${icon(deep.state==='completed'?'check':'warn')}<span>${esc(deep.detail)}</span></div>${deep.metrics?.errors?.length?`<div class="overflow-x-auto mt-2"><table class="table table-xs data-table"><thead><tr><th>Bài</th><th>Đoạn</th><th>Byte</th><th>Cần</th><th>Đọc được</th><th>Bit sai</th></tr></thead><tbody>${deep.metrics.errors.slice(0,10).map(e=>`<tr><td>${e.pass}</td><td>${e.chunk}</td><td class="mono">${e.offset}</td><td class="mono">${e.expected}</td><td class="mono">${e.actual}</td><td>${e.bits}</td></tr>`).join('')}</tbody></table></div>`:''}`;
  const mdText=!md.available?'Chưa từng chạy trên máy này (không có kết quả trong nhật ký).':`${md.last.verdict==='ok'?'Không có lỗi':md.last.verdict==='bad'?'Có lỗi RAM':'Chưa rõ'} · ${new Date(md.last.time).toLocaleString('vi-VN')}`;
  return `<div class="grid lg:grid-cols-2 gap-4">
    <article class="panel space-y-3"><div class="flex items-center gap-2"><h3 class="panel-title">Thử RAM sâu trong Windows</h3><span class="badge badge-sm bg-base-200 border-0 ml-auto">5 bài · vài phút</span></div>
      <p class="text-xs muted">Ghi và kiểm lại từng ô nhớ với 5 kiểu mẫu: địa chỉ trong ô nhớ, đảo bit 0/1, bàn cờ, bit chạy, ngẫu nhiên. Luôn chừa 1,5 GiB trống để Windows không đẩy RAM ra ổ cứng.</p>
      <div class="flex flex-wrap items-center gap-2"><select class="select select-sm w-48" data-mem-share aria-label="Lượng RAM thử">${[25,50,75].map(v=>`<option value="${v}" ${v===memoryShare?'selected':''}>${v}% RAM đang trống</option>`).join('')}</select>
        <button class="btn btn-sm btn-primary" data-test="memoryDeep" ${busy?'disabled':''}>${icon('play')}Bắt đầu thử sâu</button><button class="btn btn-sm btn-ghost" data-goto="diagnostics">Xem tiến độ</button></div>
      ${deepResult}</article>
    <article class="panel space-y-3"><div class="flex items-center gap-2"><h3 class="panel-title">Quét toàn bộ RAM (Windows Memory Diagnostic)</h3></div>
      <p class="text-xs muted">Công cụ có sẵn của Windows: khởi động lại máy rồi quét toàn bộ RAM trước khi vào Windows (khoảng 10–30 phút). Cần quyền quản trị. Sau khi máy lên lại, mở app và bấm Quét để đọc kết quả.</p>
      <button class="btn btn-sm btn-quiet" data-tool="memorydiag">${icon('external')}Mở Windows Memory Diagnostic</button>
      <p class="text-sm ${md.last?.verdict==='bad'?'tone-warn':''}"><span class="muted">Kết quả gần nhất:</span> ${esc(mdText)}</p></article>
  </div>`;
}
function renderMemory(){
  const m=scanReport?memoryInfo(scanReport):null;
  if(!m?.available){$('#memoryView').innerHTML=card(note(scanReport?'Không đọc được thông tin RAM từ SMBIOS.':'Chưa quét.','warn'));return;}
  const GB=mib=>mib>=1024?`${+(mib/1024).toFixed(1)} GB`:`${mib} MB`;
  const speed=m.runningMTs?`${m.runningMTs} MT/s`:'—';
  const cards=[
    stat('Dung lượng',GB(m.totalMiB),m.visibleBytes?`Windows dùng được ${(m.visibleBytes/1073741824).toFixed(1)} GiB${m.load!=null?` · đang dùng ${m.load}%`:''}`:'','memory'),
    stat('Loại & tốc độ',[m.types.join(' / '),speed].filter(Boolean).join(' · ') || '—',m.ratedMTs && m.ratedMTs!==m.runningMTs?`Định mức ${m.ratedMTs} MT/s`:m.ecc?'Có ECC':'','zap'),
    stat('Kênh',m.channel==='dual'?'Kênh đôi':m.channel==='single'?'Kênh đơn':'Chưa xác định',`${m.modules.length} thanh / ${m.slotCount} khe`,'chart'),
    stat('Nâng cấp',m.upgradeable?`Còn ${m.empty} khe trống`:m.socketed?'Hết khe trống':'Hàn trên bo mạch',m.maxGiB?`Tối đa ${m.maxGiB} GB theo BIOS`:'','arrow')
  ].join('');
  const rows=m.slots.map(s=>`<tr class="${s.installed?'':'opacity-60'}"><td class="font-medium">${esc(s.slot)}${s.bank?`<div class="text-xs muted">${esc(s.bank)}</div>`:''}</td><td class="tabular">${s.installed?esc(GB(s.sizeMiB)):'Trống'}</td><td>${esc(s.type || '—')}</td><td>${esc(s.formFactor || '—')}</td><td class="tabular">${esc(s.ratedMTs?`${s.ratedMTs} MT/s`:'—')}</td><td class="tabular">${esc(s.runningMTs?`${s.runningMTs} MT/s`:'—')}</td><td>${esc(s.vendor || '—')}</td><td class="mono text-xs">${esc(s.part || '—')}</td><td class="mono text-xs">${esc(s.serial || '—')}</td><td class="tabular">${esc(s.rank?`${s.rank}R`:'—')}</td><td class="tabular">${esc(s.voltageMV?`${(s.voltageMV/1000).toFixed(2)} V`:'—')}</td><td>${esc(s.channel?`Kênh ${s.channel}`:'—')}</td></tr>`).join('');
  const notes=m.notes.map(n=>`<li class="text-sm flex gap-2 ${n.state==='warn'?'tone-warn':''}">${icon(n.state==='warn'?'warn':'info')}<span>${esc(n.text)}</span></li>`).join('');
  $('#memoryView').innerHTML=`<div class="space-y-4"><div class="grid sm:grid-cols-2 xl:grid-cols-4 gap-4">${cards}</div>
    ${notes?`<article class="panel"><h3 class="panel-title mb-2">Nhận xét</h3><ul class="space-y-1.5">${notes}</ul></article>`:''}
    <article class="panel p-0 overflow-hidden"><h3 class="panel-title px-5 py-3.5 flex items-center gap-2">Các khe RAM<span class="text-xs font-normal muted tabular">${m.slots.length}</span><span class="badge bg-primary/10 text-primary border-0 ml-auto">nguồn SMBIOS</span></h3><div class="overflow-x-auto border-t border-base-300"><table class="table table-sm data-table"><thead><tr><th>Khe</th><th>Dung lượng</th><th>Loại</th><th>Dạng</th><th>Định mức</th><th>Đang chạy</th><th>Hãng</th><th>Part number</th><th>Serial</th><th>Rank</th><th>Điện áp</th><th>Kênh</th></tr></thead><tbody>${rows}</tbody></table></div></article>
    ${memoryTestPanel()}</div>`;
}
function renderUsageHistory(){
  const u=scanReport?.usage;
  if(!u){$('#usageView').innerHTML=card(note('Chưa quét.'));return;}
  const a=u.activation;
  const act=a?.known?stat('Windows đã kích hoạt',`≥ ${a.days} ngày`,`${a.label}${a.note?` · ${a.note}`:''}`,'shield'):stat('Windows đã kích hoạt','Chưa xác định',a?.label || 'Không đọc được nhật ký bản quyền','shield');
  if(!u.available){$('#usageView').innerHTML=`<div class="grid sm:grid-cols-2 xl:grid-cols-4 gap-4">${act}</div><div class="mt-4">${card(note('Không đọc được nhật ký hệ thống'+(u.error?': '+esc(u.error):'')+'.','warn'))}</div>`;return;}
  const s=u.summary,since=s.since?new Date(s.since).toLocaleDateString('vi-VN'):'—';
  const st=stabilityInfo(scanReport),first=firstUseInfo(scanReport),day=t=>new Date(t).toLocaleDateString('vi-VN');
  const crashCard=st.available?stat('Số lần sập',`${st.total} lần`,`${st.blueScreens} màn hình xanh · ${st.powerLoss} mất điện / treo · ${st.powerButton} giữ nút nguồn`,st.total?'warn':'check'):stat('Tắt đột ngột',`${s.unexpected} lần`,'Mất điện, treo máy hoặc giữ nút nguồn','warn');
  const crashPanel=st.available?`<article class="panel p-0 overflow-hidden"><h3 class="panel-title px-5 py-3.5 flex flex-wrap items-center gap-2">Lịch sử sập<span class="text-xs font-normal muted">từ ${st.since?day(st.since):'—'}</span>${st.hardwareErrors?`<span class="badge border-0 bg-red-50 text-red-700 gap-1">${icon('warn')}${st.hardwareErrors} lỗi phần cứng (WHEA)</span>`:'<span class="badge border-0 bg-emerald-50 text-emerald-700 gap-1">Không có lỗi phần cứng (WHEA)</span>'}</h3>
    ${st.events.length?`<div class="overflow-x-auto border-t border-base-300 max-h-80"><table class="table table-sm table-pin-rows data-table"><thead><tr><th>Thời điểm</th><th>Loại</th><th>Mã lỗi</th></tr></thead><tbody>${st.events.map(e=>`<tr><td class="tabular">${esc(when(e.time))}</td><td class="${e.kind==='bsod'?'tone-warn':''}">${esc(e.label)}</td><td class="mono">${esc(e.code || '—')}</td></tr>`).join('')}</tbody></table></div>`:`<p class="px-5 pb-4 text-sm">Không có lần sập nào trong nhật ký.</p>`}</article>`:'';
  const firstPanel=first.marks.length?`<article class="panel"><h3 class="panel-title mb-1">Mốc dùng máy lần đầu</h3><p class="text-xs muted mb-3">${first.firstSetup?`Máy được thiết lập lần đầu khoảng <b>${esc(day(first.firstSetup))}</b>. Windows tự kích hoạt ở lần có mạng đầu tiên sau đó; Windows không lưu riêng ngày kích hoạt quá thời hạn nhật ký.`:'Không tìm thấy mốc thiết lập Windows.'}</p>
    <ul class="space-y-2">${first.marks.map(m=>`<li class="flex gap-3 text-sm"><span class="tabular font-medium w-24 shrink-0">${m.bound?'trước ':''}${esc(day(m.time))}</span><span>${esc(m.label)}<span class="block text-xs muted">${esc(m.note)}</span></span></li>`).join('')}</ul></article>`:'';
  const cards=[
    stat('Số lần dùng',`${s.sessions} lần`,`${s.boots} lần bật máy · ${s.sessions-s.boots} lần thức dậy`,'clock'),
    stat('Tổng thời gian dùng',`${s.totalHours} giờ`,`từ ${since} · có dùng ${s.usedDays}/${s.spanDays} ngày`,'calendar'),
    stat('Trung bình mỗi ngày',`${s.hoursPerDay ?? '—'} giờ`,s.longestHours!=null?`Lần dài nhất ${s.longestHours} giờ`:'','chart'),
    crashCard,act
  ].join('');
  const rows=u.sessions.slice(0,300).map(x=>`<tr><td class="tabular">${esc(when(x.start))}</td><td class="tabular">${esc(x.end?when(x.end):x.endKind==='crash'?'Không rõ':'—')}</td><td class="tabular font-medium">${esc(spanText(x.durationMs))}</td><td>${esc(x.startLabel)}</td><td class="${x.endKind==='crash'?'tone-warn':x.endKind==='running'?'tone-done':''}">${esc(x.endLabel)}</td></tr>`).join('');
  $('#usageView').innerHTML=`<div class="space-y-4"><div class="grid sm:grid-cols-2 xl:grid-cols-5 gap-4">${cards}</div>
    ${firstPanel}${crashPanel}<article class="panel"><div class="flex items-center gap-2 mb-2"><h3 class="panel-title">Số giờ dùng mỗi ngày</h3><span class="text-xs muted">30 ngày gần nhất</span></div>${usageChart(u.daily)}</article>
    <article class="panel p-0 overflow-hidden"><h3 class="panel-title px-5 py-3.5 flex items-center gap-2">Các lần sử dụng<span class="text-xs font-normal muted tabular">${u.sessions.length}${u.sessions.length>300?' · hiện 300 lần gần nhất':''}</span></h3><div class="overflow-x-auto border-t border-base-300 max-h-[32rem]"><table class="table table-sm table-pin-rows data-table"><thead><tr><th>Bắt đầu</th><th>Kết thúc</th><th>Thời lượng</th><th>Mở bằng</th><th>Kết thúc bằng</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="muted">Không có sự kiện bật / tắt máy trong nhật ký.</td></tr>'}</tbody></table></div></article>
    ${note(`Tính từ nhật ký System của Windows (còn lưu từ ${since}). Nhật ký có giới hạn dung lượng và có thể bị xóa, nên đây không phải tuổi máy. “Ngủ / màn hình tắt” gồm cả Modern Standby khi gập máy.`)}</div>`;
}
// ---- Windows: version, license verdict with evidence, security, accounts and updates ----
const VERDICT_STYLE={genuine:['bg-emerald-50 text-emerald-700','check'],cracked:['bg-red-50 text-red-700','warn'],suspect:['bg-amber-50 text-amber-700','warn'],corporate:['bg-amber-50 text-amber-700','info'],inactive:['bg-amber-50 text-amber-700','warn'],none:['bg-red-50 text-red-700','warn'],unknown:['bg-base-200 text-base-content/70','help']};
const yesNo=v=>v===true?'Có':v===false?'Không':'Chưa rõ';
function kvTable(rows){return `<div class="grid sm:grid-cols-2 gap-x-8">${rows.map(([k,v])=>diskField(k,v)).join('')}</div>`;}
function renderWindows(){
  if(!scanReport){$('#windowsView').innerHTML=card(note('Chưa quét.'));return;}
  const os=data(scanReport,'os')[0] || {},info=data(scanReport,'windowsInfo')[0] || {},license=licenseInfo(scanReport),act=scanReport.usage?.activation;
  const lic=data(scanReport,'license').find(r=>number(r.LicenseStatus)===1) || data(scanReport,'license')[0] || {},history=data(scanReport,'activation')[0] || {};
  const sec=data(scanReport,'security')[0] || {},usage=usageInfo(scanReport),truth=hardwareTruth(scanReport);
  const truthPanel=truth.available?`<article class="panel p-0 overflow-hidden"><div class="flex flex-wrap items-center gap-3 px-5 py-3.5"><h3 class="panel-title">Đối chiếu Windows ↔ phần cứng</h3><span class="badge border-0 gap-1.5 ${truth.mismatches.length?'bg-red-50 text-red-700':'bg-emerald-50 text-emerald-700'}">${icon(truth.mismatches.length?'warn':'check')}${truth.mismatches.length?`${truth.mismatches.length} mục bị sửa`:'Khớp'}</span><span class="text-xs muted ml-auto">Giá trị Windows lấy từ registry (sửa được); cột phần cứng đọc thẳng từ CPU, kernel, BIOS, thiết bị.</span></div>
    <div class="overflow-x-auto border-t border-base-300"><table class="table table-sm data-table"><thead><tr><th>Mục</th><th>Windows ghi</th><th>Phần cứng / BIOS</th><th>Nguồn</th><th></th></tr></thead><tbody>${truth.items.map(i=>`<tr><td>${esc(i.name)}</td><td>${esc(i.windows ?? '—')}</td><td class="font-medium">${esc(i.truth ?? '—')}</td><td class="muted">${esc(i.source)}</td><td>${i.match===false?`<span class="tone-warn flex gap-1">${icon('warn')}Khác</span>`:i.match?`<span class="tone-ok flex gap-1">${icon('check')}Khớp</span>`:'—'}</td></tr>`).join('')}</tbody></table></div></article>`:'';
  const uptime=os.LastBootUpTime?Date.now()-new Date(os.LastBootUpTime.replace(' ','T')).getTime():null;
  const [vClass,vIcon]=VERDICT_STYLE[license.verdict] || VERDICT_STYLE.unknown;
  const cards=[
    stat('Phiên bản',truth.osName || 'Chưa xác định',[truth.release,truth.build?`build ${truth.build}${truth.ubr!=null?`.${truth.ubr}`:''}`:'',os.OSArchitecture].filter(Boolean).join(' · '),'windows',TILE.cpu),
    stat('Cài đặt',usage.windowsInstalled || 'Chưa xác định',usage.windowsDays!==null?ago(usage.windowsDays):'','calendar'),
    stat('Đã kích hoạt',act?.known?`≥ ${act.days} ngày`:'Chưa xác định',act?.label || '','shield'),
    stat('Khởi động lần cuối',os.LastBootUpTime || '—',uptime!=null && uptime>0?`đã chạy ${spanText(uptime)}`:'','clock')
  ].join('');
  const evidence=license.evidence.length?`<ul class="mt-2 space-y-1">${license.evidence.map(e=>`<li class="text-xs tone-warn flex gap-1.5">${icon('warn')}<span>${esc(e)}</span></li>`).join('')}</ul>`:'';
  const licensePanel=`<article class="panel"><div class="flex items-center gap-3 mb-3"><h3 class="panel-title">Bản quyền Windows</h3><span class="badge border-0 gap-1.5 ${vClass}">${icon(vIcon)}${esc(license.label)}</span></div>
    <p class="text-sm">${esc(license.detail)}</p>${evidence}
    <div class="mt-3">${kvTable([['Trạng thái',license.status],['Hết hạn bản quyền',licenseExpiry(data(scanReport,'license').length?lic:null)?.label || 'Không có khóa'],['Kênh',license.channel],['Khóa sản phẩm',lic.PartialProductKey?`•••••-•••••-•••••-•••••-${lic.PartialProductKey}`:null],['Khóa OEM trong BIOS',truth.oemKeyTail?`Có · •••••-•••••-•••••-•••••-${truth.oemKeyTail}`:yesNo(lic.OemKeyInFirmware)],['Máy chủ KMS',lic.KmsMachine || lic.KmsDiscovered || history.KmsHost || 'Không có'],['Thuộc domain công ty',yesNo(history.PartOfDomain)],['Thời điểm kích hoạt',act?.label],['Dấu vết công cụ crack',number(history.ArtifactCount)?`${history.ArtifactCount} mục`:'Không thấy']])}</div>
    ${act?.note?`<p class="text-xs muted mt-2">${esc(act.note)}</p>`:''}</article>`;
  const office=officeInfo(scanReport),o=data(scanReport,'office')[0] || {},[oClass,oIcon]=VERDICT_STYLE[{subscription:'genuine',notInstalled:'unknown'}[office.verdict] || office.verdict] || VERDICT_STYLE.unknown;
  const officeKey=(array=>array.find(p=>Number(p.LicenseStatus)===1) || array[0] || {})(Array.isArray(o.Products)?o.Products:[]);
  const officePanel=`<article class="panel"><div class="flex items-center gap-3 mb-3"><h3 class="panel-title">Microsoft Office</h3><span class="badge border-0 gap-1.5 ${oClass}">${icon(oIcon)}${esc(office.label)}</span></div>
    <p class="text-sm">${esc(office.detail)}</p>${office.evidence.length?`<ul class="mt-2 space-y-1">${office.evidence.map(e=>`<li class="text-xs tone-warn flex gap-1.5">${icon('warn')}<span>${esc(e)}</span></li>`).join('')}</ul>`:''}
    ${office.verdict==='notInstalled'?'':`<div class="mt-3">${kvTable([['Sản phẩm',office.product],['Hết hạn bản quyền',licenseExpiry(officeKey.LicenseStatus!=null?officeKey:null)?.label || 'Không có khóa'],['Phiên bản',o.Version],['Kênh',office.channel],['Trạng thái',office.status],['Khóa sản phẩm',officeKey.PartialProductKey?`•••••-•••••-•••••-•••••-${officeKey.PartialProductKey}`:'Không có'],['Microsoft 365 đăng nhập',yesNo(o.M365Licenses)],['Máy chủ KMS đã cấu hình',o.KmsHost || 'Không có'],['Yêu cầu KMS gần nhất',office.requests[0] || 'Không có']])}</div>`}</article>`;
  const mdm=mdmInfo(scanReport),md=data(scanReport,'mdm')[0] || {},[mClass,mIcon]=VERDICT_STYLE[{clean:'genuine',autopilot:'cracked',managed:'cracked',joined:'corporate',agent:'suspect'}[mdm.verdict] || 'unknown'];
  const mdmPanel=`<article class="panel"><div class="flex flex-wrap items-center gap-3 mb-3"><h3 class="panel-title">Quản lý thiết bị (MDM)</h3><span class="badge border-0 gap-1.5 ${mClass}">${icon(mIcon)}${esc(mdm.label)}</span><button class="btn btn-xs btn-ghost ml-auto" data-tool="workplace">Truy cập cơ quan / trường học<svg class="icon"><use href="#i-external"/></svg></button></div>
    <p class="text-sm">${esc(mdm.detail)}</p>${mdm.evidence.length?`<ul class="mt-2 space-y-1">${mdm.evidence.map(e=>`<li class="text-xs ${mdm.state==='warn'?'tone-warn':'muted'} flex gap-1.5">${icon(mdm.state==='warn'?'warn':'info')}<span>${esc(e)}</span></li>`).join('')}</ul>`:''}
    ${mdm.verdict==='unknown'?'':`<div class="mt-3">${kvTable([['Azure AD / Entra ID',md.AzureAdJoined?(md.TenantName || 'Có'):'Không'],['Domain',md.DomainJoined?(md.Domain || 'Có'):'Không'],['Đăng ký MDM',md.Enrollments || 'Không'],['Windows Autopilot',md.AutopilotTenant || 'Không đăng ký'],['Phần mềm quản lý',md.Agents || 'Không có']])}</div>`}</article>`;
  const av=data(scanReport,'antivirus');
  const securityPanel=`<article class="panel"><h3 class="panel-title mb-2">Bảo mật</h3>${kvTable([['Secure Boot',/denied|privilege/i.test(String(sec.SecureBoot))?'Chưa xác định (cần quyền quản trị)':sec.SecureBoot],['TPM',sec.TpmPresent==null?'Chưa rõ':`${yesNo(sec.TpmPresent)}${sec.TpmVersion?` · ${sec.TpmVersion}`:''}`],...av.map(a=>[a.Name,`${a.Enabled?'Đang bật':'Đang tắt'}${a.RealTime===false?' · tắt bảo vệ thời gian thực':''}${a.SignatureUpdated?` · mẫu virus ${a.SignatureUpdated}`:''}`])])}${av.length?'':note('Không đọc được trạng thái phần mềm diệt virus.')}</article>`;
  const accounts=data(scanReport,'accounts'),enabled=accounts.filter(a=>a.Enabled);
  const accountsPanel=`<article class="panel p-0 overflow-hidden"><h3 class="panel-title px-5 py-3.5 flex items-center gap-2">Tài khoản trên máy<span class="text-xs font-normal muted">${enabled.length} đang bật / ${accounts.length}</span></h3><div class="overflow-x-auto border-t border-base-300"><table class="table table-sm data-table"><thead><tr><th>Tên</th><th>Trạng thái</th><th>Quản trị</th><th>Đăng nhập gần nhất</th><th>Mật khẩu</th></tr></thead><tbody>${accounts.map(a=>`<tr class="${a.Enabled?'':'opacity-50'}"><td class="font-medium">${esc(a.Name)}</td><td>${a.Enabled?'Đang bật':'Tắt'}</td><td>${a.Admin?'Có':'—'}</td><td class="tabular">${esc(a.LastLogon || 'Chưa đăng nhập')}</td><td>${a.PasswordRequired?'Bắt buộc':'Không bắt buộc'}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Không đọc được danh sách tài khoản.</td></tr>'}</tbody></table></div><p class="text-xs muted px-5 py-3 border-t border-base-300">Mua máy cũ: xóa tài khoản của người bán (Mở nhanh → Tài khoản trên máy) hoặc Reset máy sau khi kiểm tra xong.</p></article>`;
  const fixes=data(scanReport,'hotfixes');
  const updatesPanel=`<article class="panel p-0 overflow-hidden"><h3 class="panel-title px-5 py-3.5 flex items-center gap-2">Bản cập nhật gần đây${fixes[0]?.InstalledOn?`<span class="text-xs font-normal muted">mới nhất ${esc(fixes[0].InstalledOn)}</span>`:''}</h3><div class="overflow-x-auto border-t border-base-300"><table class="table table-sm data-table"><thead><tr><th>Mã</th><th>Loại</th><th>Ngày cài</th></tr></thead><tbody>${fixes.map(f=>`<tr><td class="font-medium">${esc(f.HotFixID)}</td><td>${esc(f.Description)}</td><td class="tabular">${esc(f.InstalledOn)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Không có dữ liệu.</td></tr>'}</tbody></table></div></article>`;
  const ownerPanel=info.RegisteredOwner || info.ComputerName?card(`<h3 class="panel-title mb-2">Máy và chủ sở hữu đăng ký</h3>${kvTable([['Tên máy',info.ComputerName],['Chủ sở hữu đăng ký',info.RegisteredOwner],['Tổ chức đăng ký',info.RegisteredOrganization || 'Không có'],['Phiên bản (Edition)',truth.edition || info.EditionID]])}`):'';
  $('#windowsView').innerHTML=`<div class="space-y-4"><div class="grid sm:grid-cols-2 xl:grid-cols-4 gap-4">${cards}</div>${truthPanel}${licensePanel}${mdmPanel}${officePanel}<div class="grid lg:grid-cols-2 gap-4">${securityPanel}${ownerPanel}</div>${accountsPanel}${updatesPanel}</div>`;
}
async function runScan(){
  if(scanBusy || testBusy)throw Error('Đang có tác vụ chạy.');
  scanBusy=true;updateLocks();showBusy('Đang đọc cấu hình & bảng firmware…',0);
  try{
    scanReport=await window.inspect.scan();renderScan();
    if(smartNeedsAdmin() && !smartDeclined)await elevateSmart();
    return true;
  }
  finally{scanBusy=false;hideBusy();updateLocks();}
}
$('#scan').addEventListener('click',()=>runScan().then(()=>toast('Đã đọc cấu hình. Tiếp tục thử các chức năng thực tế.')).catch(e=>toast(e.message)));
window.inspect.onScanProgress(({key,done,total})=>showBusy('Đang đọc: '+(sectionLabels[key] || key),total?Math.round((done-1)/total*100):null));
window.inspect.onCleanupWarning(toast);
$('#support').addEventListener('click',()=>window.inspect.support().catch(e=>toast(e.message)));
$('#exportFirmware').addEventListener('click',()=>window.inspect.exportFirmware().then(r=>{if(r.path)toast('Đã lưu: '+r.path);}).catch(e=>toast(e.message)));
async function exportReport(){try{const result=await window.inspect.export({manual:manualItems,notes:$('#notes').value,pixelMarks,batteryConditions:$('#batteryConditions').value,fullRun:runLog});if(result.path)toast('Đã lưu báo cáo: '+result.path);}catch(e){toast(e.message);}}
$('#export').addEventListener('click',exportReport);$('#exportBottom').addEventListener('click',exportReport);
// ---- Full run: automatic tests, then guided checks the tester marks Đạt / Có lỗi / Bỏ qua. Ends on the summary page. ----
// runLog is session-local; a new run replaces it. Manual verdicts come only from the tester's own clicks.
let runLog=null;
const evidence={camera:false,mic:false};
const RUN_STATUS={pass:'Đạt',fail:'Có lỗi',skip:'Bỏ qua'};
const diagStatus=result=>result?.cancelled?'skip':result?.state==='completed'?'pass':result?.state==='cancelled'?'skip':'fail';
const fullSteps=[
 {title:'Quét cấu hình / SMBIOS',detail:'Đọc firmware, Windows, bản quyền và ổ đĩa.',page:'overview',run:async()=>{
   await runScan();const f=assess(scanReport);
   return {status:'pass',detail:`${f.filter(c=>c.state==='warn').length} lưu ý · ${f.filter(c=>c.state==='unknown').length} chưa rõ`};
 }},
 {title:'Sức khỏe ổ cứng (S.M.A.R.T.)',detail:'Đánh giá Tốt / Cẩn thận / Xấu từ dữ liệu ổ tự báo.',page:'disks',run:async()=>{
   const disks=scanReport?.diskDetails || [];
   if(!disks.length)return {status:'skip',detail:'Không đọc được dữ liệu ổ đĩa.'};
   const detail=disks.map(d=>`${d.model}: ${d.health.label}${d.health.percent!=null?` ${d.health.percent}%`:''}${d.temperature.celsius!=null?` · ${d.temperature.celsius} °C`:''}`).join(' · ');
   if(disks.some(d=>['bad','caution'].includes(d.health.status)))return {status:'fail',detail};
   return {status:disks.every(d=>d.health.status==='unknown')?'skip':'pass',detail};
 }},
 {title:'Tra Service Tag trên Dell',detail:'Chỉ chạy khi bật “Tra trong lượt Test toàn bộ”.',page:'overview',run:async()=>{
   if(!$('#dellInFull').checked)return {status:'skip',detail:'Không bật tra Dell trong lượt test.'};
   if($('#dellMethod').value==='techdirect' && !dellConfigured)return {status:'skip',detail:'Chưa nạp khóa TechDirect.'};
   try{await lookupDell();return {status:'pass',detail:'Đã nhận phản hồi từ Dell.'};}catch(e){return {status:'fail',detail:e.message};}
 }},
 {title:'CPU · tải 1 luồng 15 giây',detail:'Quan sát quạt, phản hồi và nhiệt.',page:'diagnostics',run:async()=>{const r=await runTest('cpu');return {status:diagStatus(r),detail:r.detail || ''};}},
 {title:'RAM · vùng nhớ 64 MiB',detail:'Ghi và xác minh 4 mẫu dữ liệu.',page:'diagnostics',run:async()=>{const r=await runTest('memory');return {status:diagStatus(r),detail:r.detail || ''};}},
 {title:'Ổ đĩa · ghi/đọc từng ổ, đo tốc độ',detail:'Tự thử lần lượt mọi ổ có ký tự ổ đĩa với dung lượng đã chọn.',page:'diagnostics',run:async()=>{
   const drives=diskDrives();
   if(!drives.length)return {status:'skip',detail:'Không có ổ có ký tự ổ đĩa để thử.'};
   const results=[];
   for(const drive of drives){if(stopFull)break;results.push([drive,await runTest('disk',drive).catch(e=>({state:'error',detail:e.message}))]);}
   const status=results.length && results.every(([,r])=>r.state==='completed')?'pass':results.some(([,r])=>['error','unknown'].includes(r.state))?'fail':'skip';
   return {status,detail:results.map(([drive,r])=>r.metrics?`${drive} ghi ${r.metrics.writeMBps} MB/s · đọc ${r.metrics.readMBps} MB/s`:`${drive}: ${r.detail}`).join(' | ')};
 }},
 {title:'Màn hình',detail:'Bấm “Tự chạy màu test điểm chết”, xem từng màu; click vị trí nghi ngờ.',page:'screen',manual:[2,3],evidence:()=>`${pixelMarks.length} vị trí nghi ngờ được đánh dấu`},
 {title:'Bàn phím',detail:'Bấm “Bắt đầu thử phím” rồi nhấn lần lượt từng phím.',page:'input',manual:[4],evidence:()=>`${$$('.key.seen').length}/${$$('.key').length} phím đã nhận`},
 {title:'Touchpad / chuột',detail:'Vẽ, click trái/phải và cuộn trong vùng thử.',page:'input',manual:[5],evidence:()=>`Trái ${clicks[0]} · Phải ${clicks[2]} · Cuộn ${wheels}`},
 {title:'Loa trái / phải',detail:'Bấm Trái, Phải và nghe từng kênh.',page:'media',manual:[6]},
 {title:'Micro',detail:'Ghi 5 giây rồi phát lại.',page:'media',manual:[7],evidence:()=>evidence.mic?'Đã ghi được âm thanh':'Chưa ghi âm'},
 {title:'Webcam',detail:'Bật camera, kiểm tra hình và màu.',page:'media',manual:[8],evidence:()=>evidence.camera?'Đã mở được camera':'Chưa mở camera'},
 {title:'Pin',detail:'Xem độ chai, chu kỳ; nếu có pin thì rút sạc và chạy test tụt pin.',page:'battery',manual:[17],evidence:batteryEvidence}
];
function batteryEvidence(){
  const b=data(scanReport,'battery')[0];if(!b)return 'Không có số liệu pin';
  const h=batteryHealth(b),cycles=number(b.CycleCount),t=lastBatteryPayload?.summary;
  return [h.wear!=null?`chai ${h.wear.toFixed(1)}%`:'chưa rõ độ chai',cycles!=null?`${cycles} chu kỳ`:'chưa rõ chu kỳ',t?`test: ${t.startPercent ?? '—'}% → ${t.endPercent ?? '—'}% trong ${Math.round(t.elapsedSeconds/60)} phút`:''].filter(Boolean).join(' · ');
}
function setManual(index,status){
  manualItems[index].status=status;const el=$(`[data-manual="${index}"]`);el.value=status;
  el.classList.toggle('select-success',status==='Đạt');el.classList.toggle('select-error',status==='Có lỗi');updateSummary();
}
function showGuideButtons(manual){
  $('#fullPass').classList.toggle('hidden',!manual);$('#fullFail').classList.toggle('hidden',!manual);
  $('#fullNext').classList.toggle('hidden',!manual);
}
async function advanceFull(){
  fullStep++;
  if(fullStep>=fullSteps.length){finishFull();return;}
  const step=fullSteps[fullStep];go(step.page);
  $('#fullTitle').textContent=`${fullStep+1}/${fullSteps.length} · ${step.title}`;$('#fullDetail').textContent=step.detail;$('#fullProgress').value=fullStep;
  showGuideButtons(Boolean(step.manual));
  if(!step.run)return;
  let outcome;
  try{outcome=await step.run();}catch(e){outcome={status:'fail',detail:e.message};}
  if(stopFull){finishFull(true);return;}
  runLog.steps.push({title:step.title,status:outcome.status,detail:outcome.detail});
  await advanceFull();
}
function recordManual(status){
  const step=fullSteps[fullStep];if(!step?.manual)return;
  runLog.steps.push({title:step.title,status,detail:step.evidence?.() || ''});
  if(status!=='skip')step.manual.forEach(i=>setManual(i,RUN_STATUS[status]));
  releaseDevices();advanceFull();
}
function finishFull(stopped=false){
  fullRun=false;$('#fullGuide').classList.add('hidden');updateLocks();
  runLog.endedAt=new Date().toISOString();runLog.stopped=stopped;
  renderRunSummary();go('summary');
  toast(stopped?'Đã dừng lượt test. Các bước đã chạy được thống kê.':'Đã xong lượt test toàn bộ.');
}
$('#testAll').addEventListener('click',async()=>{
  releaseDevices();fullRun=true;stopFull=false;fullStep=-1;evidence.camera=evidence.mic=false;
  runLog={startedAt:new Date().toISOString(),endedAt:null,stopped:false,steps:[]};
  updateLocks();$('#fullProgress').max=fullSteps.length;$('#fullGuide').classList.remove('hidden');await advanceFull();
});
$('#fullPass').addEventListener('click',()=>recordManual('pass'));
$('#fullFail').addEventListener('click',()=>recordManual('fail'));
$('#fullNext').addEventListener('click',()=>recordManual('skip'));
$('#runAgain').addEventListener('click',()=>$('#testAll').click());
$('#runStart').addEventListener('click',()=>$('#testAll').click());
$('#exportRun').addEventListener('click',exportReport);
const duration=ms=>{const s=Math.max(0,Math.round(ms/1000));return s<60?`${s} giây`:`${Math.floor(s/60)} phút ${s%60} giây`;};
// Summary page for the latest full run: verdict, counts, per-step evidence and a machine snapshot.
function renderRunSummary(){
  if(!runLog)return;
  const count=k=>runLog.steps.filter(s=>s.status===k).length,pass=count('pass'),fail=count('fail'),skip=count('skip'),total=runLog.steps.length || 1;
  const verdict=fail?[`Phát hiện ${fail} mục có lỗi`,'tone-warn','warn']:skip?['Chưa thấy lỗi',`tone-info`,'info']:['Mọi mục đã thử đều đạt','tone-done','check'];
  const sub=`${runLog.stopped?'Đã dừng giữa chừng · ':''}${runLog.steps.length}/${fullSteps.length} bước · ${skip} bỏ qua · bắt đầu ${new Date(runLog.startedAt).toLocaleTimeString('vi-VN')}`;
  $('#runVerdict').innerHTML=`<span class="${verdict[1]}">${icon(verdict[2])}</span><div><p class="text-xl font-semibold">${esc(verdict[0])}</p><p class="text-xs muted mt-0.5">${esc(sub)}</p></div>`;
  $('#runStats').innerHTML=[['Đạt',pass,'check','done'],['Có lỗi',fail,'warn','fail'],['Bỏ qua',skip,'help','skip'],['Thời gian',duration(Date.parse(runLog.endedAt)-Date.parse(runLog.startedAt)),'clock','time']].map(([label,value,name,tone])=>stat(label,value,'',name,RUN_TILE[tone])).join('');
  $('#runBar').innerHTML=`<span class="bg-success" style="flex:${pass}"></span><span class="bg-error" style="flex:${fail}"></span><span class="bg-base-300" style="flex:${skip}"></span>`;
  $('#runBar').classList.toggle('hidden',!runLog.steps.length);
  $('#runSteps').innerHTML=runLog.steps.map(s=>`<tr><td class="w-8"><span class="${s.status==='pass'?'tone-done':s.status==='fail'?'tone-warn':'tone-unknown'}">${icon(s.status==='pass'?'check':s.status==='fail'?'warn':'help')}</span></td><td class="font-medium">${esc(s.title)}</td><td class="text-xs muted">${esc(s.detail)}</td><td><span class="badge badge-sm border-0 ${RUN_BADGE[s.status]}">${RUN_STATUS[s.status]}</span></td></tr>`).join('') || '<tr><td class="muted text-sm">Chưa có bước nào hoàn thành.</td></tr>';
  const {sys,bios,cpu,ramMiB,installed,slots}=firmwareIdentity(),license=licenseInfo(scanReport),usage=usageInfo(scanReport),battery=data(scanReport,'battery')[0],findings=assess(scanReport);
  const health=battery?batteryHealth(battery):null,drives=data(scanReport,'disks');
  const rows=[['Model',sys.Product],['Service Tag',sys.SerialNumber],['BIOS',bios.Version?`${bios.Version}${bios.ReleaseDate?` · ${bios.ReleaseDate}`:''}`:null],['CPU',cpu.Version],['RAM',ramMiB?`${GiB(ramMiB*1048576)} · ${installed.length}/${slots.length} khe`:null],['Ổ đĩa',(scanReport.diskDetails || []).map(d=>`${d.model} (${GiB(d.capacity)})`).join(', ') || null],['Bản quyền Windows',`${license.label}${license.channel?` · ${license.channel}`:''}`],['Windows cài đặt',usage.windowsInstalled?`${usage.windowsInstalled} (${ago(usage.windowsDays)})`:null],['Pin',battery?`${health.wear!=null?`chai ${health.wear.toFixed(1)}%`:'chưa rõ độ chai'} · ${number(battery.CycleCount) ?? 'chưa rõ'} chu kỳ`:'Không có số liệu pin'],['Điểm cần chú ý',`${findings.filter(f=>f.state==='warn').length} lưu ý · ${findings.filter(f=>f.state==='unknown').length} chưa rõ`]];
  $('#runMachine').innerHTML=rows.map(([k,v])=>`<div class="flex justify-between gap-4 py-2 border-t border-base-300 first:border-0"><span class="muted text-xs shrink-0">${esc(k)}</span><span class="text-sm text-right break-words min-w-0">${esc(v || 'Chưa xác định')}</span></div>`).join('');
  const left=manualItems.filter(m=>m.status==='Chưa thử').length;
  $('#runChecklist').textContent=left?`Biên bản còn ${left}/${manualItems.length} mục chưa thử (cổng, mạng, sạc, BIOS…).`:'Biên bản đã điền đủ.';
  $('#runEmpty').classList.add('hidden');$('#runContent').classList.remove('hidden');
}
const RUN_TILE={done:'bg-emerald-50 text-emerald-600',fail:'bg-red-50 text-red-600',skip:'bg-zinc-100 text-zinc-500',time:'bg-sky-50 text-sky-600'};
const RUN_BADGE={pass:'bg-emerald-50 text-emerald-700',fail:'bg-red-50 text-red-700',skip:'bg-base-200 text-base-content/60'};
$('#fullStop').addEventListener('click',async()=>{stopFull=true;releaseDevices();if(testBusy)await window.inspect.stop();if(!scanBusy && !testBusy)finishFull(true);else $('#fullDetail').textContent='Đang dừng. Nếu đang đọc firmware, chờ lượt quét hiện tại kết thúc.';});
// Screen colors use actual fullscreen and return on Esc.
const colors=['#ffffff','#000000','#ff0000','#00ff00','#0000ff','#808080','grid'];let colorIndex=0,pixelTimer=null,pixelAuto=false;const pixelMarks=[];
function paintColor(){const overlay=$('#screenOverlay');overlay.style.background=colors[colorIndex]==='grid'?'repeating-linear-gradient(0deg,#111 0 1px,transparent 1px 32px),repeating-linear-gradient(90deg,#111 0 1px,#fff 1px 32px)':colors[colorIndex];}
function stopPixelCycle(){clearInterval(pixelTimer);pixelTimer=null;pixelAuto=false;}
function closeScreen(){stopPixelCycle();const overlay=$('#screenOverlay');overlay.classList.add('hidden');if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});renderPixelMarks();}
// Shows the color overlay and tries real fullscreen; returns false if fullscreen was refused.
async function openScreen(index,hint){
  colorIndex=index;paintColor();
  const overlay=$('#screenOverlay');overlay.classList.remove('hidden');$('#screenHint').classList.remove('hidden');
  if(hint)$('#screenHint').textContent=hint;
  overlay.focus();
  try{await overlay.requestFullscreen();return true;}catch{return false;}
}
$$('[data-color]').forEach(b=>b.addEventListener('click',async()=>{if(!await openScreen(Number(b.dataset.color)))toast('Không bật được fullscreen; vẫn có thể xem màu trong cửa sổ.');}));
$('#screenOverlay').addEventListener('click',event=>{
  if(pixelAuto){if(pixelMarks.length>=200)return;pixelMarks.push({color:colors[colorIndex],x:Math.round(event.clientX),y:Math.round(event.clientY),width:innerWidth,height:innerHeight,dpr:devicePixelRatio});$('#screenHint').textContent=`Đã ghi ${pixelMarks.length} vị trí nghi ngờ · tọa độ tham khảo, không phải pixel vật lý · ESC thoát`;}
  else $('#screenHint').classList.toggle('hidden');
});
document.addEventListener('fullscreenchange',()=>{if(!document.fullscreenElement){stopPixelCycle();$('#screenOverlay').classList.add('hidden');renderPixelMarks();}});
function renderPixelMarks(){renderSummary('screen');$('#pixelMarks').textContent=pixelMarks.length?`Đã đánh dấu ${pixelMarks.length} vị trí nghi ngờ (sẽ ghi vào báo cáo).`:'Chưa đánh dấu vị trí nào.';}
$('#autoPixels').addEventListener('click',async()=>{
  stopPixelCycle();pixelAuto=true;
  if(!await openScreen(0,'TỰ ĐỔI MÀU MỖI 3 GIÂY · click để đánh dấu vị trí nghi ngờ · ESC thoát'))toast('Đang chạy màu trong cửa sổ; có thể phóng to cửa sổ để xem.');
  if(!$('#screenOverlay').classList.contains('hidden'))pixelTimer=setInterval(()=>{colorIndex=(colorIndex+1)%colors.length;paintColor();},3000);else stopPixelCycle();
});
$('#clearPixelMarks').addEventListener('click',()=>{pixelMarks.length=0;renderPixelMarks();});renderPixelMarks();
// Keyboard visualizer: only captures while explicitly active, outside text fields.
const rows=[
 ['Escape:Esc','F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12','PrintScreen:PrtSc','Delete:Del'],
 ['Backquote:`','Digit1:1','Digit2:2','Digit3:3','Digit4:4','Digit5:5','Digit6:6','Digit7:7','Digit8:8','Digit9:9','Digit0:0','Minus:-','Equal:=','Backspace:⌫'],
 ['Tab','KeyQ:Q','KeyW:W','KeyE:E','KeyR:R','KeyT:T','KeyY:Y','KeyU:U','KeyI:I','KeyO:O','KeyP:P','BracketLeft:[','BracketRight:]','Backslash:∖'],
 ['CapsLock:Caps','KeyA:A','KeyS:S','KeyD:D','KeyF:F','KeyG:G','KeyH:H','KeyJ:J','KeyK:K','KeyL:L','Semicolon:;','Quote:′','Enter:Enter'],
 ['ShiftLeft:Shift L','KeyZ:Z','KeyX:X','KeyC:C','KeyV:V','KeyB:B','KeyN:N','KeyM:M','Comma:,','Period:.','Slash:/','ShiftRight:Shift R','ArrowUp:↑'],
 ['ControlLeft:Ctrl L','MetaLeft:Win L','AltLeft:Alt L','Space:Space','AltRight:Alt R','MetaRight:Win R','ContextMenu:Menu','ControlRight:Ctrl R','ArrowLeft:←','ArrowDown:↓','ArrowRight:→'],
 ['Insert:Ins','Home','End','PageUp:PgUp','PageDown:PgDn','NumLock:Num','NumpadDivide:Num /','NumpadMultiply:Num *','NumpadSubtract:Num -','NumpadAdd:Num +'],
 ['Numpad0:Num 0','Numpad1:Num 1','Numpad2:Num 2','Numpad3:Num 3','Numpad4:Num 4','Numpad5:Num 5','Numpad6:Num 6','Numpad7:Num 7','Numpad8:Num 8','Numpad9:Num 9','NumpadDecimal:Num .','NumpadEnter:Num ↵']
];
$('#keyboard').innerHTML=rows.map(row=>`<div class="key-row">${row.map(key=>{const [code,label]=key.split(':');return `<span class="key" data-code="${code}" style="${code==='Space'?'flex:4':''}">${esc(label || code)}</span>`;}).join('')}</div>`).join('');
function setKeyboard(active){keyboardActive=active;$('#keyboardToggle').textContent=active?'Dừng thử phím':'Bắt đầu thử phím';$('#lastKey').textContent=active?'Đang nhận phím · Esc để dừng':'Đã ngừng nhận phím';$$('.key.pressed').forEach(el=>el.classList.remove('pressed'));if(active)$('#keyboard').focus();}
$('#keyboardToggle').addEventListener('click',()=>setKeyboard(!keyboardActive));
$('#clearKeys').addEventListener('click',()=>{$$('.key').forEach(el=>el.classList.remove('seen','pressed'));renderSummary('input');});
document.addEventListener('keydown',event=>{
  if(!$('#screenOverlay').classList.contains('hidden')){event.preventDefault();if(event.key==='Escape')closeScreen();else if(['ArrowRight','ArrowLeft',' '].includes(event.key)){colorIndex=(colorIndex+(event.key==='ArrowLeft'?-1:1)+colors.length)%colors.length;paintColor();}return;}
  if(!keyboardActive && event.ctrlKey && !event.altKey && event.key.toLowerCase()==='b'){event.preventDefault();toggleSidebar();return;}
  if(!keyboardActive || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(event.target.tagName))return;
  event.preventDefault();const key=$$('[data-code]').find(el=>el.dataset.code===event.code);key?.classList.add('seen','pressed');renderSummary('input');$('#lastKey').textContent=`Nhận: ${event.code} · ${event.key} · ${event.repeat?'đang giữ':'nhấn'}`;if(event.key==='Escape')setKeyboard(false);
},true);
document.addEventListener('keyup',event=>{$$('[data-code]').find(el=>el.dataset.code===event.code)?.classList.remove('pressed');});
window.addEventListener('blur',()=>{$$('.key.pressed').forEach(el=>el.classList.remove('pressed'));});
// Pointer pad supports mouse and touch. Counters are events, not a pass verdict.
const canvas=$('#pointerPad');let previous=null;const clicks=[0,0,0];let wheels=0;
function resizeCanvas(){if(canvas.clientWidth && canvas.width!==canvas.clientWidth){canvas.width=canvas.clientWidth;canvas.height=190;}}
function updateMouse(){renderSummary('input');$('#mouseStats').textContent=`Trái: ${clicks[0]} · Giữa: ${clicks[1]} · Phải: ${clicks[2]} · Cuộn: ${wheels}`;}
canvas.addEventListener('pointerdown',event=>{canvas.setPointerCapture(event.pointerId);if(event.button>=0 && event.button<3)clicks[event.button]++;updateMouse();const r=canvas.getBoundingClientRect();previous={x:event.clientX-r.left,y:event.clientY-r.top};});
canvas.addEventListener('pointermove',event=>{if(!previous || !event.buttons)return;const r=canvas.getBoundingClientRect(),point={x:event.clientX-r.left,y:event.clientY-r.top},ctx=canvas.getContext('2d');ctx.strokeStyle='#0a9d83';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(previous.x,previous.y);ctx.lineTo(point.x,point.y);ctx.stroke();previous=point;});
canvas.addEventListener('pointerup',()=>previous=null);canvas.addEventListener('pointercancel',()=>previous=null);canvas.addEventListener('contextmenu',e=>e.preventDefault());canvas.addEventListener('wheel',e=>{e.preventDefault();wheels++;updateMouse();},{passive:false});window.addEventListener('resize',resizeCanvas);
// Audio and media streams are never auto-started and always stopped on navigation.
function getAudio(){if(!audioContext || audioContext.state==='closed')audioContext=new AudioContext();audioContext.resume();return audioContext;}
function stopSound(){if(oscillator){try{oscillator.stop();}catch{}oscillator=null;}}
function playTone(pan){try{stopSound();const ctx=getAudio(),gain=ctx.createGain(),panner=ctx.createStereoPanner(),osc=ctx.createOscillator();oscillator=osc;osc.frequency.value=440;panner.pan.value=pan;gain.gain.setValueAtTime(0,ctx.currentTime);gain.gain.linearRampToValueAtTime(.12,ctx.currentTime+.04);gain.gain.setValueAtTime(.12,ctx.currentTime+.9);gain.gain.linearRampToValueAtTime(0,ctx.currentTime+1);osc.connect(gain).connect(panner).connect(ctx.destination);osc.start();osc.stop(ctx.currentTime+1.02);osc.onended=()=>{osc.disconnect();gain.disconnect();panner.disconnect();if(oscillator===osc)oscillator=null;};}catch(e){toast(e.message);}}
$('#leftSound').addEventListener('click',()=>playTone(-1));$('#rightSound').addEventListener('click',()=>playTone(1));$('#stopSound').addEventListener('click',stopSound);
function stopCamera(){cameraStream?.getTracks().forEach(t=>t.stop());cameraStream=null;$('#cameraPreview').srcObject=null;$('#cameraStatus').classList.remove('hidden');$('#cameraStatus').textContent='Camera đang tắt';$('#startCamera').disabled=false;$('#stopCamera').disabled=true;}
let cameraRequest=0,micRequest=0;
$('#startCamera').addEventListener('click',async()=>{const request=++cameraRequest;$('#startCamera').disabled=true;try{const deviceId=$('#cameraSource').value;const stream=await navigator.mediaDevices.getUserMedia({video:deviceId?{deviceId:{exact:deviceId},width:{ideal:1280},height:{ideal:720}}:true,audio:false});if(request!==cameraRequest || !$('#media').classList.contains('active')){stream.getTracks().forEach(t=>t.stop());return;}cameraStream=stream;evidence.camera=true;$('#cameraPreview').srcObject=stream;await $('#cameraPreview').play();$('#cameraStatus').classList.add('hidden');$('#stopCamera').disabled=false;await refreshMedia();}catch(e){if(request!==cameraRequest)return;stopCamera();$('#cameraStatus').textContent=mediaError(e,'camera');toast(mediaError(e,'camera'));}});
$('#stopCamera').addEventListener('click',()=>{cameraRequest++;stopCamera();});
function stopMic(){clearTimeout(micTimer);cancelAnimationFrame(micFrame);if(recorder && recorder.state!=='inactive')recorder.stop();micStream?.getTracks().forEach(t=>t.stop());micStream=null;$('#micLevel').value=0;$('#startMic').disabled=false;$('#stopMic').disabled=true;}
$('#startMic').addEventListener('click',async()=>{
  const request=++micRequest;$('#startMic').disabled=true;
  try{
    const deviceId=$('#micSource').value;const stream=await navigator.mediaDevices.getUserMedia({audio:{...(deviceId?{deviceId:{exact:deviceId}}:{}),echoCancellation:false,noiseSuppression:false,autoGainControl:false},video:false});
    if(request!==micRequest || !$('#media').classList.contains('active')){stream.getTracks().forEach(t=>t.stop());return;}
    micStream=stream;const ctx=getAudio(),source=ctx.createMediaStreamSource(stream),analyser=ctx.createAnalyser();analyser.fftSize=256;source.connect(analyser);const values=new Uint8Array(analyser.fftSize);
    function meter(){analyser.getByteTimeDomainData(values);const rms=Math.sqrt(values.reduce((sum,v)=>sum+(v-128)**2,0)/values.length)/128;$('#micLevel').value=Math.min(100,rms*350);micFrame=requestAnimationFrame(meter);}meter();
    const chunks=[];const current=new MediaRecorder(stream);recorder=current;
    current.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
    current.onstop=()=>{evidence.mic=chunks.length>0;source.disconnect();analyser.disconnect();if(micURL)URL.revokeObjectURL(micURL);micURL=URL.createObjectURL(new Blob(chunks,{type:current.mimeType}));$('#micPlayback').src=micURL;$('#micPlayback').classList.remove('hidden');$('#micStatus').textContent='Đã ghi xong · bấm phát để nghe lại';};
    current.start();$('#stopMic').disabled=false;$('#micStatus').textContent='Đang ghi tối đa 5 giây… nói thử vào micro';micTimer=setTimeout(stopMic,5000);
  }catch(e){if(request!==micRequest)return;stopMic();$('#micStatus').textContent=mediaError(e,'micro');toast(mediaError(e,'micro'));}
});
$('#stopMic').addEventListener('click',()=>{micRequest++;stopMic();});
function stopMedia(){cameraRequest++;micRequest++;stopCamera();stopMic();stopSound();$('#micPlayback').pause();}
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopMedia();});window.addEventListener('beforeunload',()=>{stopMedia();if(micURL)URL.revokeObjectURL(micURL);});
async function runTest(kind,drive){
  if(testBusy || scanBusy)throw Error('Đang có tác vụ chạy.');
  testBusy=true;updateLocks();$('#testProgress').value=0;$('#testStatus').textContent=kind==='disk'?`Đang thử ổ ${drive} · ${sizeLabel(diskTestSize)}…`:kind==='memoryDeep'?`Đang thử sâu ${memoryShare}% RAM trống…`:'Đang chạy bài thử…';
  if(kind==='memoryDeep')renderMemory();
  if(kind==='disk'){diskTestDrive=drive;renderDisks();}
  try{
    const result=await window.inspect.diagnostic(kind,drive,kind==='disk'?diskTestSize:kind==='memoryDeep'?memoryShare:undefined);
    if(kind==='disk')diskTests[drive]=result;
    lastTests[kind]=result;
    if(result.cancelled){$('#testStatus').textContent='Đã dừng trước khi chạy.';return result;}
    $('#testProgress').value=result.state==='completed'?100:0;$('#testStatus').textContent=result.state==='completed'?'Bài thử đã hoàn thành trong phạm vi mô tả.':'Bài thử không hoàn thành / có lỗi.';
    $('#testResults').insertAdjacentHTML('afterbegin',finding(result.state==='completed'?'done':'warn',result.title,result.detail));return result;
  }finally{testBusy=false;updateLocks();renderSummary('diagnostics');if(kind.startsWith('memory'))renderMemory();if(kind==='disk'){diskTestDrive=null;renderDisks();}}
}
$('#stopTest').addEventListener('click',()=>window.inspect.stop().catch(e=>toast(e.message)));
window.inspect.onTestProgress(message=>{
  $('#testProgress').value=message.value;$('#testStatus').textContent=message.detail;
  if($('#diskTestProgress'))$('#diskTestProgress').value=message.value;
  if($('#diskTestStatus'))$('#diskTestStatus').textContent=message.detail;
});
// Manual result entries are deliberately session-local. No stale pass results from an earlier machine.
$('#manualRows').innerHTML=manualItems.map((m,i)=>`<tr><td><p class="font-medium">${esc(m.title)}</p><p class="text-xs muted mt-0.5">${esc(m.hint)}</p></td><td><select class="select select-sm w-full" aria-label="Kết quả ${esc(m.title)}" data-manual="${i}"><option>Chưa thử</option><option>Đạt</option><option>Có lỗi</option><option>Không có / bỏ qua</option></select></td><td><input class="input input-sm input-ghost w-full min-w-40" aria-label="Ghi chú ${esc(m.title)}" data-note="${i}" maxlength="2000" placeholder="Ghi điều kiện thử / lỗi…"></td></tr>`).join('');
function updateSummary(){const counts=manualItems.reduce((c,m)=>(c[m.status]=(c[m.status]||0)+1,c),{});$('#checklistSummary').innerHTML=['Đạt','Có lỗi','Chưa thử','Không có / bỏ qua'].map(s=>`<span class="flex items-center gap-1.5"><span class="status ${SUMMARY_STATUS[s]}"></span>${s} <b class="tabular">${counts[s]||0}</b></span>`).join('');}
const SUMMARY_STATUS={'Đạt':'status-success','Có lỗi':'status-error','Chưa thử':'','Không có / bỏ qua':'status-neutral'};
$$('[data-manual]').forEach(el=>el.addEventListener('change',()=>setManual(el.dataset.manual,el.value)));
$$('[data-note]').forEach(el=>el.addEventListener('input',()=>{manualItems[el.dataset.note].note=el.value;}));
updateSummary();
// Device selectors make external and built-in cameras/microphones individually testable.
async function refreshMedia(){
  try{
    const devices=await navigator.mediaDevices.enumerateDevices();
    for(const [id,kind,label] of [['cameraSource','videoinput','Camera'],['micSource','audioinput','Micro']]){
      const select=$('#'+id),selected=select.value,matching=devices.filter(d=>d.kind===kind);
      select.replaceChildren(new Option(matching.length?'Mặc định Windows':`Không thấy ${label.toLowerCase()}`,''));matching.forEach((d,i)=>select.add(new Option(d.label || `${label} ${i+1}`,d.deviceId)));
      if([...select.options].some(o=>o.value===selected))select.value=selected;
    }
    mediaCounts={camera:devices.filter(d=>d.kind==='videoinput').length,mic:devices.filter(d=>d.kind==='audioinput').length,speaker:devices.filter(d=>d.kind==='audiooutput' && d.deviceId!=='default' && d.deviceId!=='communications').length};renderSummary('media');
    $('#mediaDeviceStatus').textContent=`Windows liệt kê ${devices.filter(d=>d.kind==='videoinput').length} camera, ${devices.filter(d=>d.kind==='audioinput').length} micro.`;
  }catch(e){$('#mediaDeviceStatus').textContent='Chưa dò được thiết bị: '+e.message;}
}
$('#refreshDevices').addEventListener('click',refreshMedia);navigator.mediaDevices.addEventListener('devicechange',refreshMedia);refreshMedia();
// Battery capacity figures and the measured discharge trace are separate data sources.
const mWh=value=>number(value)>0?`${(number(value)/1000).toFixed(2)} Wh`:'Chưa xác định';
// root/wmi BatteryStatus reports milli-units; 0xFFFFFFFF means "not reported".
const wmiUnit=(value,digits,positiveOnly=false)=>{const n=number(value);return n===null || n===4294967295 || (positiveOnly && n<=0)?null:(n/1000).toFixed(digits);};
function renderBatterySpecs(){
  const batteries=data(scanReport,'battery'),battery=batteries[0],health=battery?batteryHealth(battery):null;
  const metrics=[['Dung lượng thiết kế',battery?mWh(battery.DesignCapacity):'—','Theo firmware','battery'],['Sạc đầy hiện tại',battery?mWh(battery.FullChargeCapacity):'—','Không phải mức pin lúc này','battery'],['Độ chai',health?.wear!=null?`${health.wear.toFixed(1)}%`:'Chưa xác định',health?.remaining!=null?`Còn ${health.remaining.toFixed(1)}% so thiết kế`:'Thiếu dung lượng hợp lệ','battery'],['Chu kỳ sạc',number(battery?.CycleCount) ?? 'Chưa xác định','Số 0 cũng cần đối chiếu','battery']];
  $('#batteryMetrics').innerHTML=metrics.map(m=>stat(...m)).join('');
  $('#batterySpecs').innerHTML=batteries.length?renderTable('Bộ pin (powercfg)',{status:'ok',data:batteries}):note('Không có số liệu pin — máy không có pin hoặc firmware không cung cấp. Không kết luận pin tốt hay hỏng.');
}
let batteryReading=false;
async function refreshBattery(){
  if(batteryReading)return;batteryReading=true;$('#refreshBattery').disabled=true;
  try{const payload=await window.inspect.batteryCurrent();renderBatteryPayload(payload);return payload;}
  catch(e){$('#batteryLive').textContent='Chưa xác định: '+e.message;throw e;}
  finally{batteryReading=false;$('#refreshBattery').disabled=false;}
}
let lastBatteryPayload=null;
function renderBatteryPayload(payload){
  lastBatteryPayload=payload;
  const sample=payload.sample,summary=payload.summary,samples=payload.samples || [];
  if(sample){
    const power=sample.ac==='online'?'đang cắm nguồn':sample.ac==='offline'?'đang dùng pin':'nguồn chưa xác định';
    $('#batteryLive').textContent=sample.hasBattery===false?'Windows báo máy không có pin.':`${sample.percent===null?'Mức pin chưa xác định':sample.percent+'% pin'} · ${power} · ${sample.charging===true?'đang sạc':sample.charging===false?'không sạc':'chưa rõ trạng thái sạc'} · cập nhật ${new Date(sample.at).toLocaleTimeString('vi-VN')}`;
    const details=(sample.details || []).map(d=>({Name:d.InstanceName,VoltageV:wmiUnit(d.Voltage,3,true),RemainingWh:wmiUnit(d.RemainingCapacity,2),DischargeW:wmiUnit(d.DischargeRate,2),ChargeW:wmiUnit(d.ChargeRate,2),Charging:d.Charging,Discharging:d.Discharging}));
    $('#batteryLiveDetails').innerHTML=details.length?renderTable('Điện áp / công suất tức thời',{status:'ok',data:details}):note('Windows chưa cung cấp điện áp / công suất pin: '+esc(sample.detailError || 'không có dữ liệu'));
  }
  const active=summary?.state==='running';$('#startBattery').disabled=active;$('#stopBattery').disabled=!active;$('#batteryDuration').disabled=active;
  if(!summary)return;
  const stateLabels={running:'Đang theo dõi',completed:'Đủ thời gian đã chọn',stopped:'Đã dừng',interrupted:'Bị gián đoạn'};
  const elapsed=`${Math.floor(summary.elapsedSeconds/60)} phút ${summary.elapsedSeconds%60} giây`;
  $('#batteryProgress').value=Math.min(100,summary.elapsedSeconds/(summary.targetMinutes*60)*100);
  $('#batteryTestStatus').textContent=`${stateLabels[summary.state] || summary.state} · ${elapsed} · ${summary.startPercent ?? '—'}% → ${summary.endPercent ?? '—'}% · ${summary.dropPercentagePoints===null?'chưa rõ mức tụt':'giảm '+summary.dropPercentagePoints+' điểm %'} · ${summary.samples} mẫu. ${summary.reason || ''} ${summary.dropPercentagePoints===0?'Chưa thấy thay đổi ở độ phân giải % của Windows; không có nghĩa pin tốt.':''}`;
  const valid=samples.filter(s=>typeof s.percent==='number');
  if(valid.length){
    const width=720,height=150,first=Date.parse(valid[0].at),span=Math.max(1,Date.parse(valid.at(-1).at)-first);
    const points=valid.map(s=>`${35+(Date.parse(s.at)-first)/span*670},${130-s.percent*1.1}`).join(' ');
    $('#batteryChart').innerHTML=`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Mức pin theo thời gian, trục dọc 0 đến 100 phần trăm"><path d="M35 20H705M35 75H705" stroke="#e4e4e7" stroke-dasharray="3 4"/><path d="M35 130H705" stroke="#d4d4d8"/><text x="0" y="24" fill="#a1a1aa" font-size="10">100%</text><text x="8" y="134" fill="#a1a1aa" font-size="10">0%</text><polyline points="${points}" fill="none" stroke="#2563eb" stroke-width="2" stroke-linejoin="round"/></svg>`;
    $('#batterySamples').innerHTML=renderTable('8 mẫu gần nhất (đầy đủ trong báo cáo)',{status:'ok',data:valid.slice(-8).map(s=>({Time:new Date(s.at).toLocaleTimeString('vi-VN'),Percent:s.percent,AC:s.ac,Charging:s.charging}))});
  }
}
$('#refreshBattery').addEventListener('click',()=>refreshBattery().catch(e=>toast(e.message)));
$('#startBattery').addEventListener('click',async()=>{const button=$('#startBattery');button.disabled=true;try{renderBatteryPayload(await window.inspect.batteryStart(Number($('#batteryDuration').value)));toast('Đã bắt đầu ghi mức pin. Giữ điều kiện thử ổn định.');}catch(e){button.disabled=false;toast(e.message);$('#batteryTestStatus').textContent=e.message;}});
$('#stopBattery').addEventListener('click',()=>window.inspect.batteryStop().then(renderBatteryPayload).catch(e=>toast(e.message)));
window.inspect.onBatteryUpdate(renderBatteryPayload);
// Bootstrap with real hardware, never with a sample Service Tag or a cached identity.
runScan().catch(error=>{updateIdentity();toast('Chưa tự đọc được cấu hình: '+error.message);});
