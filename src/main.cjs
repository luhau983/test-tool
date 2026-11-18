const {app,BrowserWindow,ipcMain,dialog,shell,session} = require('electron');
const {spawn} = require('node:child_process');
const {Worker} = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {pathToFileURL} = require('node:url');
const {makeReport} = require('./report.cjs');
const {enrichFirmware} = require('./smbios.cjs');
const {diskSpeedVerdict} = require('./assessment.cjs');
const {enrichDisks} = require('./disk-health.cjs');
const {enrichUsage} = require('./usage-history.cjs');
const {WarrantyApiClient,validateTag,PORTAL_URL} = require('./warranty-api.cjs');
const {WarrantyWebClient,SUPPORT_HOST,supportPageURL} = require('./warranty-web.cjs');
const {summarizeBattery} = require('./battery-analysis.cjs');

const warrantyClient=new WarrantyApiClient();
let warrantyWebClient,warrantyResult=null,warrantyWebResult=null,warrantyBusy=false,supportWindow=null;
let batteryTest=null,batteryTimer=null,batterySamplePromise=null,batteryStarting=false;
let win,scan=null,scanning=false,running=null;
const diagnostics=[];
const children=new Set();
const pageURL=pathToFileURL(path.join(__dirname,'index.html')).href;
const resource=name=>path.join(__dirname,name).replace('app.asar'+path.sep,'app.asar.unpacked'+path.sep);
const psPath=path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
const parseJSON=text=>JSON.parse(text.replace(/^\uFEFF/,''));
const allowedStates=['Chưa thử','Đạt','Có lỗi','Không có / bỏ qua'];
const externalLinks={network:'ms-settings:network-wifi',bluetooth:'ms-settings:bluetooth',sound:'ms-settings:sound',camera:'ms-settings:privacy-webcam',microphone:'ms-settings:privacy-microphone',display:'ms-settings:display',activation:'ms-settings:activation',windowsupdate:'ms-settings:windowsupdate',accounts:'ms-settings:otherusers',recovery:'ms-settings:recovery',about:'ms-settings:about',defender:'windowsdefender:',workplace:'ms-settings:workplace',warrantyapi:PORTAL_URL};
const BATTERY_INTERVAL=15000;

function notify(channel,payload) { if(win && !win.isDestroyed()) win.webContents.send(channel,payload); }
// Every IPC call must come from the main local page; arguments after the event are passed through.
function handle(channel,fn) {
  ipcMain.handle(channel,(event,...args)=>{
    if(event.sender!==win?.webContents || event.senderFrame?.url!==pageURL) throw Error('Nguồn yêu cầu không hợp lệ');
    return fn(...args);
  });
}

// Runs PowerShell with the given arguments (a bundled script via psFile, or -Command). Without onLine, resolves with stdout.
const psFile=(script,...args)=>['-File',resource(script),...args];
function runPowerShell(args,{timeoutMs,timeoutMessage,failure,onLine}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(psPath,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',...args],{windowsHide:true});
    children.add(child);
    let output='',pending='',errors='';
    const timer=setTimeout(()=>{child.kill();reject(Error(timeoutMessage));},timeoutMs);
    const done=()=>{clearTimeout(timer);children.delete(child);};
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      if(!onLine){output+=chunk;return;}
      pending+=chunk;const lines=pending.split(/\r?\n/);pending=lines.pop();lines.forEach(onLine);
    });
    child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-5000);});
    child.on('error',error=>{done();reject(error);});
    child.on('close',code=>{done();code===0 ? resolve(output) : reject(Error(errors.trim() || failure || `PowerShell dừng với mã ${code}`));});
  });
}

// ---- Battery monitoring ----
function sampleBattery() {
  batterySamplePromise ||= runPowerShell(psFile('battery-sample.ps1'),{timeoutMs:12000,timeoutMessage:'Chưa đọc được trạng thái pin sau 12 giây.',failure:'Windows không trả trạng thái nguồn.'})
    .then(text=>{try{return parseJSON(text);}catch{throw Error('Dữ liệu trạng thái pin không hợp lệ.');}})
    .finally(()=>{batterySamplePromise=null;});
  return batterySamplePromise;
}
const batteryPayload=(sample=null)=>({sample,summary:summarizeBattery(batteryTest),samples:batteryTest?.samples || []});
const batteryRunning=()=>batteryTest?.state==='running';
function stopBattery(reason,state='stopped') {
  clearTimeout(batteryTimer);batteryTimer=null;
  if(!batteryRunning())return;
  Object.assign(batteryTest,{state,reason,endedAt:new Date().toISOString()});
  notify('battery-update',batteryPayload(batteryTest.samples.at(-1)));
}
// Returns why monitoring must stop for this sample, or null to continue.
function batteryStopReason(sample,previous,test) {
  if(previous && Date.parse(sample.at)-Date.parse(previous.at)>45000)return ['Gián đoạn lấy mẫu quá 45 giây (có thể ngủ máy). Kết quả chỉ tính phần đã ghi.','interrupted'];
  if(sample.hasBattery!==true || sample.percent===null)return ['Windows không còn cung cấp mức pin hợp lệ.','interrupted'];
  if(sample.ac!=='offline' || sample.charging===true)return ['Đã cắm sạc lại hoặc không xác định được trạng thái nguồn.','interrupted'];
  if(sample.percent<=5)return ['Đã xuống ≤5% pin, dừng theo dõi. Hãy cắm sạc.','stopped'];
  if(Date.parse(sample.at)-Date.parse(test.startedAt)>=test.minutes*60000)return ['Đủ thời gian theo dõi đã chọn.','completed'];
  return null;
}
async function batteryTick() {
  const current=batteryTest;
  if(!batteryRunning())return;
  try{
    const sample=await sampleBattery();
    if(current!==batteryTest || !batteryRunning())return;
    const previous=current.samples.at(-1);current.samples.push(sample);
    const stop=batteryStopReason(sample,previous,current);
    if(stop)return stopBattery(...stop);
    notify('battery-update',batteryPayload(sample));batteryTimer=setTimeout(batteryTick,BATTERY_INTERVAL);
  }catch(error){stopBattery(error.message,'interrupted');}
}
async function startBattery(minutes) {
  if(![2,10,30].includes(minutes))throw Error('Thời gian test pin không hợp lệ.');
  if(batteryStarting || batteryRunning())throw Error('Đang có bài theo dõi pin.');
  batteryStarting=true;
  try{
    const sample=await sampleBattery();
    if(sample.hasBattery!==true || sample.percent===null)throw Error('Máy không có pin hoặc Windows chưa cung cấp số liệu pin. Chưa thể test pin.');
    if(sample.ac!=='offline' || sample.charging===true)throw Error('Hãy rút sạc trước khi bắt đầu test pin. Ứng dụng không thể ngắt sạc bằng phần mềm.');
    if(sample.percent<=10)throw Error('Pin đang ≤10%. Hãy sạc thêm trước khi thử.');
    batteryTest={state:'running',startedAt:sample.at,minutes,samples:[sample],reason:''};
    batteryTimer=setTimeout(batteryTick,BATTERY_INTERVAL);
    const payload=batteryPayload(sample);notify('battery-update',payload);return payload;
  }finally{batteryStarting=false;}
}

// ---- Hardware scan & diagnostics ----
async function collect() {
  if(scanning) throw Error('Đang quét, vui lòng chờ.');
  if(running) throw Error('Hãy dừng bài thử trước khi quét.');
  scanning=true;
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'test-tool-scan-'));
  try {
    const output=path.join(dir,'scan.json');
    // collect.ps1 prints each Section name as it starts, which drives the progress bar.
    const total=((await fs.readFile(resource('collect.ps1'),'utf8')).match(/^Section '/gm) || []).length;let done=0;
    await runPowerShell(psFile('collect.ps1','-OutputPath',output),{timeoutMs:120000,timeoutMessage:'Quét quá 120 giây. Thử chạy lại hoặc mở bằng quyền quản trị nếu WMI bị chặn.',onLine:line=>notify('scan-progress',{key:line,done:++done,total})});
    const report=parseJSON(await fs.readFile(output,'utf8'));
    if(report.schema!==1 || !report.sections) throw Error('Báo cáo Windows không hợp lệ.');
    scan=enrichUsage(enrichDisks(enrichFirmware(report)));
    return scan;
  } finally {scanning=false; await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});}
}
// The SATA SMART attribute table needs an elevated process: runs smart.ps1 once through UAC and
// merges the result into the current scan. Only bundled paths are passed; declining UAC changes nothing.
const UAC_CANCELLED='UAC_CANCELLED';
async function readSmartElevated() {
  if(!scan) throw Error('Hãy quét máy trước khi đọc bảng SMART.');
  if(scanning || running) throw Error('Đợi quét hoặc bài thử hiện tại kết thúc.');
  scanning=true;
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'test-tool-smart-'));
  try {
    const output=path.join(dir,'smart.json'),script=resource('smart.ps1');
    if(/["'`$]/.test(script+output+psPath)) throw Error('Đường dẫn ứng dụng có ký tự đặc biệt, không chạy được bằng quyền quản trị.');
    const inner=`-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${script}" -SmartOutput "${output}"`;
    const command=`try { $p = Start-Process -FilePath '${psPath}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '${inner}' -ErrorAction Stop; exit $p.ExitCode } catch { if ($_.Exception.NativeErrorCode -eq 1223 -or $_.Exception.InnerException.NativeErrorCode -eq 1223) { [Console]::Error.Write('${UAC_CANCELLED}'); exit 12 }; throw }`;
    try { await runPowerShell(['-Command',command],{timeoutMs:120000,timeoutMessage:'Quá 120 giây chưa đọc xong bảng SMART.',failure:'Không chạy được bằng quyền quản trị.'}); }
    catch(error) { if(error.message.includes(UAC_CANCELLED)) throw Error('Đã hủy hộp thoại quyền quản trị (UAC). Bảng SMART chưa được đọc.'); throw error; }
    const result=parseJSON(await fs.readFile(output,'utf8'));
    if(result.schema!==1 || !Array.isArray(result.disks)) throw Error('Kết quả SMART không hợp lệ.');
    scan.sections.smartRaw={status:'ok',data:result.disks,error:null};
    enrichDisks(scan);
    return {diskDetails:scan.diskDetails,diskHealth:scan.sections.diskHealth,diskSmart:scan.sections.diskSmart};
  } finally {scanning=false; await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});}
}
const diagnosticTitles={cpu:'CPU · tải 1 luồng trong 15 giây',memory:'RAM · vùng nhớ 64 MiB',memoryDeep:'RAM · thử sâu',disk:'Ổ đĩa · ghi/đọc tệp 256 MiB, đo tốc độ'};
// Temp folder on the drive under test. Only drive letters from the current scan are accepted.
// The user's temp folder is used when it lives on that drive (a system-drive root needs admin rights).
const DISK_SIZES=[256,1024,4096,8192,16384]; // MiB options for the write test.
// Deep RAM test: share of the RAM that is free right now. At least 1.5 GiB stays free so Windows does not start paging
// the test buffers out (then the pagefile, not RAM, would be tested).
const MEMORY_SHARES=[25,50,75];
function memoryTestMiB(share) {
  const freeMiB=Math.floor(os.freemem()/1048576),keep=1536;
  const mib=Math.floor(Math.min(freeMiB*share/100,freeMiB-keep)/256)*256;
  if(mib<256) throw Error(`Chỉ còn ${freeMiB} MiB RAM trống, không đủ để thử sâu. Đóng bớt ứng dụng rồi thử lại.`);
  return mib;
}
async function diskTempDir(drive,sizeMiB) {
  const letters=new Set((scan?.diskDetails || []).flatMap(d=>String(d.driveLetters || '').split(/\s+/)).filter(Boolean));
  if(typeof drive!=='string' || !/^[A-Z]:$/.test(drive) || !letters.has(drive)) throw Error('Ổ cần thử không có trong kết quả quét. Hãy quét lại rồi chọn ổ.');
  const base=os.tmpdir().toUpperCase().startsWith(drive) ? os.tmpdir() : drive+path.sep;
  const stats=await fs.statfs(base);
  const need=(sizeMiB+1024)*1024*1024;
  if(stats.bavail*stats.bsize<need) throw Error(`Ổ ${drive} cần trống ít nhất ${Math.ceil(need/1073741824)} GiB để thử ${sizeMiB>=1024?sizeMiB/1024+' GiB':sizeMiB+' MiB'}.`);
  try { return await fs.mkdtemp(path.join(base,'test-tool-test-')); }
  catch(error) { throw Error(`Không tạo được thư mục tạm trên ổ ${drive}: ${error.message}`); }
}
function runWorker(kind,tempDir,job,sizeMiB=256) {
  // Heavy disk tests get 2 minutes per GiB on top of the base minute (a slow HDD writes + reads ~1 GiB in ~25 s).
  // Deep RAM test: ~16 passes over each word; slow laptops manage ~0.5 GB/s of that, so allow 90 s per GiB.
  const timeoutMs=60000+(kind==='disk'?Math.ceil(sizeMiB/1024)*120000:kind==='memoryDeep'?Math.ceil(sizeMiB/1024)*90000:0);
  return new Promise((resolve,reject)=>{
    const worker=new Worker(resource('diagnostic-worker.cjs'),{workerData:{kind,tempDir,sizeMiB}});
    job.worker=worker;
    const timer=setTimeout(()=>{job.timedOut=true;worker.terminate();},timeoutMs);
    let settled=false;
    worker.on('message',message=>{
      if(message.type==='progress') notify('test-progress',message);
      if(message.type==='result') {settled=true;clearTimeout(timer);resolve({state:message.state,detail:message.detail,metrics:message.metrics || null});}
    });
    worker.on('error',error=>{clearTimeout(timer);reject(error);});
    worker.on('exit',code=>{
      clearTimeout(timer);if(settled)return;
      const detail=job.cancelled?'Đã dừng theo yêu cầu. Bài thử chưa hoàn thành.':job.timedOut?`Quá ${Math.round(timeoutMs/60000)} phút, đã dừng. Kết quả chưa xác định.`:`Bài thử dừng, mã ${code}.`;
      resolve({state:job.cancelled?'cancelled':'unknown',detail});
    });
  });
}
async function runDiagnostic(kind,drive,sizeMiB=256) {
  if(!diagnosticTitles[kind]) throw Error('Bài thử không hợp lệ');
  if(kind==='disk' && !DISK_SIZES.includes(sizeMiB)) throw Error('Dung lượng thử không hợp lệ.');
  // For memoryDeep the third argument is the share (%) of free RAM, turned into MiB here.
  if(kind==='memoryDeep' && !MEMORY_SHARES.includes(sizeMiB)) throw Error('Mức RAM thử không hợp lệ.');
  if(running || scanning) throw Error('Đợi bài thử hoặc quá trình quét hiện tại kết thúc.');
  // Reserve the slot before touching the drive so two clicks cannot run two jobs.
  const job=running={worker:null,cancelled:false};
  let tempDir=null;
  try {
    if(kind==='disk') tempDir=await diskTempDir(drive,sizeMiB);
    if(kind==='memoryDeep') sizeMiB=memoryTestMiB(sizeMiB);
    if(job.cancelled) return {cancelled:true};
    const size=sizeMiB>=1024?`${+(sizeMiB/1024).toFixed(1)} GiB`:`${sizeMiB} MiB`;
    const title=kind==='disk'?`Ổ đĩa ${drive} · ghi/đọc ${size}, đo tốc độ`:kind==='memoryDeep'?`RAM · thử sâu ${size}, 5 bài`:diagnosticTitles[kind];
    const record={title,...(kind==='disk'?{drive}:{}),at:new Date().toISOString(),...await runWorker(kind,tempDir,job,sizeMiB)};
    if(kind==='disk' && record.metrics){
      const disk=(scan?.diskDetails || []).find(d=>String(d.driveLetters || '').split(/\s+/).includes(drive));
      record.verdict=diskSpeedVerdict(record.metrics,disk);
      if(record.verdict)record.detail=`${record.verdict.label}: ${record.verdict.summary} ${record.detail}`;
    }
    diagnostics.push(record);
    return record;
  } finally {
    if(tempDir) await fs.rm(tempDir,{recursive:true,force:true}).catch(error=>notify('cleanup-warning',`Không xóa được thư mục tạm ${tempDir}: ${error.message}`));
    if(running===job) running=null;
  }
}

// ---- Warranty lookups ----
// Serial number as published by firmware (SMBIOS Type 1), not via Windows CIM.
const firmwareTag=()=>String(scan?.sections?.smbiosSystem?.data?.[0]?.SerialNumber || '').trim().toUpperCase();
function withFirmwareMatch(result,requested) {
  const tag=firmwareTag();
  return {...result,firmwareTag:tag,matchesFirmware:tag?tag===requested:null};
}
async function warrantyExclusive(task) {
  if(warrantyBusy)throw Error('Đang tra bảo hành. Vui lòng chờ.');
  warrantyBusy=true;
  try{return await task();}finally{warrantyBusy=false;}
}
function warrantyWebLookup(tag) {
  const requested=validateTag(tag);
  return warrantyExclusive(async()=>{
    try{
      const result=await warrantyWebClient.lookup(requested);
      warrantyWebResult={status:'ok',data:[{Field:'Số serial gửi tra',Value:requested},{Field:'QueriedAt',Value:result.queriedAt},{Field:'Source',Value:result.source},...result.fields],error:null};
      return withFirmwareMatch(result,requested);
    }catch(error){warrantyWebResult={status:'unknown',data:[],error:`${requested}: ${error.message}`};throw error;}
  });
}
function warrantyApiLookup(tag) {
  return warrantyExclusive(async()=>{
    const requested=validateTag(tag);
    warrantyResult=await warrantyClient.lookup(requested);
    return withFirmwareMatch(warrantyResult,requested);
  });
}
const isSupportURL=url=>{try{const parsed=new URL(url);return parsed.protocol==='https:' && parsed.hostname===SUPPORT_HOST;}catch{return false;}};
// In-app support window: isolated session, no preload, navigation pinned to the support host.
async function openWarrantyBrowser(tag) {
  const requested=tag?validateTag(tag):null;
  const url=supportPageURL(requested);
  if(!supportWindow || supportWindow.isDestroyed()){
    supportWindow=new BrowserWindow({show:false,width:1160,height:850,title:'Trang hỗ trợ bảo hành',icon:path.join(__dirname,'logo.png'),autoHideMenuBar:true,webPreferences:{partition:'warranty-session',nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
    supportWindow.once('ready-to-show',()=>supportWindow?.show());
    for(const name of ['will-navigate','will-redirect'])supportWindow.webContents.on(name,(event,target)=>{if(!isSupportURL(target))event.preventDefault();});
    supportWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    supportWindow.on('closed',()=>{supportWindow=null;});
  }
  await supportWindow.loadURL(url);supportWindow.show();return true;
}
async function openSupportPage(requestedTag) {
  const tag=requestedTag?validateTag(requestedTag):firmwareTag();
  const url=supportPageURL(/^[A-Z0-9]{5,12}$/.test(tag)?tag:null);
  await shell.openExternal(url);return true;
}

// ---- Export ----
async function exportFirmware() {
  const raw=scan?.sections?.firmwareRaw?.data?.[0]?.Base64;
  if(!raw)throw Error('Chưa có dữ liệu firmware. Hãy quét máy trước.');
  const picked=await dialog.showSaveDialog(win,{defaultPath:'SMBIOS-RSMB.bin',filters:[{name:'Raw Windows SMBIOS',extensions:['bin']}]});
  if(picked.canceled)return {cancelled:true};
  await fs.writeFile(picked.filePath,Buffer.from(raw,'base64'));return {path:picked.filePath};
}
// Sanitizes renderer-supplied checklist data; everything is length-bounded before it reaches the report.
function manualRows(payload) {
  if(!payload || !Array.isArray(payload.manual) || payload.manual.length>50 || typeof payload.notes!=='string' || payload.notes.length>20000) throw Error('Dữ liệu báo cáo không hợp lệ');
  const manual=payload.manual.map(m=>({title:String(m.title).slice(0,200),status:allowedStates.includes(m.status)?m.status:'Chưa thử',note:String(m.note || '').slice(0,2000)}));
  if(Array.isArray(payload.pixelMarks) && payload.pixelMarks.length<=200)manual.push({title:'Vị trí điểm ảnh người dùng nghi ngờ (chưa xác minh, không phải tự phát hiện)',status:'Chưa thử',note:payload.pixelMarks.map(p=>`Màu ${String(p.color).slice(0,30)} · x=${Number(p.x)}, y=${Number(p.y)} CSS px · vùng ${Number(p.width)}×${Number(p.height)} · DPR=${Number(p.dpr)}`).join('\n')});
  if(typeof payload.batteryConditions==='string' && payload.batteryConditions.trim())manual.push({title:'Điều kiện theo dõi pin do người dùng ghi',status:'Chưa thử',note:payload.batteryConditions.slice(0,1000)});
  return manual;
}
function exportSections() {
  const exported=scan?structuredClone(scan):{sections:{}};
  const ok=data=>({status:'ok',data,error:null});
  if(warrantyResult)Object.assign(exported.sections,{warrantyApiAsset:ok([warrantyResult.asset]),warrantyApiCoverage:ok(warrantyResult.entitlements)});
  if(warrantyWebResult)exported.sections.warrantyWebsite=warrantyWebResult;
  if(batteryTest)Object.assign(exported.sections,{
    batteryTestSummary:ok([summarizeBattery(batteryTest)]),
    batteryTestSamples:ok(batteryTest.samples.map(({at,percent,ac,charging,batterySaver})=>({at,percent,ac,charging,batterySaver})))
  });
  return exported;
}
const RUN_LABELS={pass:'Đạt',fail:'Có lỗi',skip:'Bỏ qua'};
// The latest "Test toàn bộ" run, bounded and with statuses whitelisted; null when no run happened.
function fullRunSummary(run) {
  if(!run || !Array.isArray(run.steps))return null;
  const time=value=>Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
  return {startedAt:time(run.startedAt),endedAt:time(run.endedAt),stopped:run.stopped===true,
    steps:run.steps.slice(0,30).map(s=>({title:String(s?.title).slice(0,200),status:RUN_LABELS[s?.status] || 'Bỏ qua',detail:String(s?.detail || '').slice(0,1000)}))};
}
async function exportReport(payload) {
  const manual=manualRows(payload);
  const picked=await dialog.showSaveDialog(win,{title:'Lưu biên bản kiểm tra',defaultPath:`Test-tool-${new Date().toISOString().slice(0,10)}.html`,filters:[{name:'Báo cáo HTML (mở bằng trình duyệt, in PDF)',extensions:['html']}]});
  if(picked.canceled)return {cancelled:true};
  await fs.writeFile(picked.filePath,makeReport(exportSections(),manual,diagnostics,payload.notes,fullRunSummary(payload.fullRun)),'utf8');
  return {path:picked.filePath};
}

// ---- App lifecycle ----
function lockPermissions() {
  const supportSession=session.fromPartition('warranty-session');
  supportSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  supportSession.setPermissionCheckHandler(()=>false);
  warrantyWebClient=new WarrantyWebClient((url,options)=>supportSession.fetch(url,options));
  const allowMedia=(contents,permission)=>contents===win?.webContents && contents.getURL()===pageURL && ['media','fullscreen'].includes(permission);
  session.defaultSession.setPermissionRequestHandler((contents,permission,callback)=>callback(allowMedia(contents,permission)));
  session.defaultSession.setPermissionCheckHandler(allowMedia);
}
function registerIPC() {
  handle('scan',collect);
  handle('disk-smart-admin',readSmartElevated);
  // Keyboards connected right now (plugging one in after the scan should not need a full rescan).
  handle('list-keyboards',()=>runPowerShell(psFile('keyboards.ps1'),{timeoutMs:20000,timeoutMessage:'Đọc danh sách bàn phím quá 20 giây.',failure:'Windows không trả danh sách bàn phím.'})
    .then(text=>{const list=parseJSON(text || '[]');return Array.isArray(list)?list:[list];}));
  handle('battery-current',async()=>batteryPayload(await sampleBattery()));
  handle('battery-start',startBattery);
  handle('battery-stop',()=>{stopBattery('Người dùng dừng theo dõi. Kết quả chỉ tính phần đã ghi.');return batteryPayload(batteryTest?.samples.at(-1));});
  handle('warranty-config',credentials=>{
    if(credentials?.clear){warrantyClient.clear();return {configured:false};}
    warrantyClient.configure(credentials?.id,credentials?.secret);return {configured:true};
  });
  handle('warranty-web-lookup',warrantyWebLookup);
  handle('warranty-browser',openWarrantyBrowser);
  handle('warranty-lookup',warrantyApiLookup);
  handle('warranty-support',openSupportPage);
  handle('export-firmware',exportFirmware);
  handle('diagnostic',runDiagnostic);
  handle('stop-test',async()=>{if(running){running.cancelled=true;await running.worker?.terminate();}return true;});
  handle('open-tool',async tool=>{
    // Windows Memory Diagnostic: its manifest asks for admin (UAC), then it offers to restart and scan all RAM.
    if(tool==='memorydiag'){const error=await shell.openPath(path.join(process.env.SystemRoot || 'C:\\Windows','System32','mdsched.exe'));if(error)throw Error(`Không mở được Windows Memory Diagnostic: ${error}`);return true;}
    if(!Object.hasOwn(externalLinks,tool)) throw Error('Công cụ không hợp lệ');
    await shell.openExternal(externalLinks[tool]);return true;
  });
  handle('export',exportReport);
}
function createWindow() {
  win=new BrowserWindow({show:false,width:1320,height:900,minWidth:1024,minHeight:720,backgroundColor:'#f3f6f8',title:'Test tool',icon:path.join(__dirname,'logo.png'),autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,spellcheck:false}});
  win.once('ready-to-show',()=>win.show());
  win.webContents.on('did-finish-load',()=>win.show());
  win.webContents.on('console-message',details=>{if(details.level==='error')console.error(details.message);});
  win.webContents.on('did-fail-load',(_,code,message)=>console.error('Load failed',code,message));
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event,url)=>{if(url!==pageURL)event.preventDefault();});
  win.on('close',event=>{
    if(!scanning && !running && !batteryStarting && !batteryRunning())return;
    event.preventDefault();
    dialog.showMessageBox(win,{type:'info',message:'Đợi quét xong hoặc dừng bài thử / theo dõi pin trước khi đóng.',buttons:['OK']});
  });
  win.loadFile(path.join(__dirname,'index.html'));
}
app.whenReady().then(()=>{
  app.setAppUserModelId('local.testtool.app');
  lockPermissions();
  registerIPC();
  createWindow();
});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',()=>{children.forEach(child=>child.kill());running?.worker?.terminate();clearTimeout(batteryTimer);});
