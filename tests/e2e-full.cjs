// Full end-to-end test: runs the real main/preload/renderer in a hidden Electron window and drives every feature.
// External effects are stubbed: native dialogs write into a temp folder, shell.openExternal is recorded,
// Support-site traffic is served by a protocol handler and the warranty API by a fetch stub. Nothing leaves the machine.
// Run: pnpm test:e2e   (set QA_APP_DIR=<unpacked app dir> to test a packaged build)
const {app,BrowserWindow,dialog,shell,session,ipcMain}=require('electron');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const assert=require('node:assert/strict');

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'test-tool-e2e-'));
const appDir=process.env.QA_APP_DIR || path.join(__dirname,'..');
app.setPath('userData',path.join(dir,'profile'));app.disableHardwareAcceleration();

// ---- Stubs ----
BrowserWindow.prototype.show=function(){};
let cancelOpenDialog=false,nextSavePath=null;const opened=[],messageBoxes=[];
let openDialogs=0;
dialog.showOpenDialog=async()=>{openDialogs++;return cancelOpenDialog?{canceled:true,filePaths:[]}:{canceled:false,filePaths:[dir]};};
dialog.showSaveDialog=async()=>({canceled:false,filePath:nextSavePath});
dialog.showMessageBox=async(_win,options)=>{messageBoxes.push(options.message);return {response:0};};
shell.openExternal=async url=>{opened.push(url);};
const {TOKEN_URL,PORTAL_URL}=require('../src/warranty-api.cjs');
const {supportPageURL}=require('../src/warranty-web.cjs');
const fetchCalls=[];
globalThis.fetch=async(url,options={})=>{
  fetchCalls.push({url:String(url),body:String(options.body || '')});
  const json=body=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
  if(String(url)===TOKEN_URL)return json({access_token:'e2e-token',expires_in:3600});
  return json([{serviceTag:'ABC1234',systemDescription:'Model 5420',shipDate:'2021-06-01',countryCode:'VN',entitlements:[{serviceLevelDescription:'Premium Support',startDate:'2021-06-01',endDate:'2024-06-01'}]}]);
};

require(path.join(appDir,'src/main.cjs'));

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const results=[];
async function step(name,fn){
  const started=Date.now();
  try{await fn();results.push({name,ok:true});console.log(`✔ ${name} (${Date.now()-started} ms)`);}
  catch(error){results.push({name,ok:false});console.log(`✖ ${name}\n    ${error.message.split('\n').join('\n    ')}`);}
}

app.whenReady().then(async()=>{
  // Never show a real UAC popup in tests: the automatic elevated SMART read after each scan is answered as "declined".
  const smartAdminCalls=[];
  ipcMain.removeHandler('disk-smart-admin');
  ipcMain.handle('disk-smart-admin',()=>{smartAdminCalls.push(Date.now());throw Error('Đã hủy hộp thoại quyền quản trị (UAC). Bảng SMART chưa được đọc.');});
  // Support-site traffic in the isolated warranty session is answered locally.
  session.fromPartition('warranty-session').protocol.handle('https',request=>{
    if(request.method==='POST')return new Response(JSON.stringify({IsValid:true,ProductName:'Model E2E',csrfToken:'never-export'}),{headers:{'Content-Type':'application/json'}});
    return new Response('<!doctype html><title>Support</title><p>stub</p>',{headers:{'Content-Type':'text/html'}});
  });
  const win=BrowserWindow.getAllWindows()[0];
  const consoleErrors=[];win.webContents.on('console-message',details=>{if(details.level==='error')consoleErrors.push(details.message);});
  if(win.webContents.isLoadingMainFrame())await new Promise(resolve=>win.webContents.once('did-finish-load',resolve));
  const js=code=>win.webContents.executeJavaScript(code,true);
  async function until(code,timeout=30000,label=code){const start=Date.now();while(Date.now()-start<timeout){if(await js(code))return;await wait(150);}throw Error('Hết thời gian chờ: '+label);}
  const text=selector=>js(`document.querySelector(${JSON.stringify(selector)}).textContent`);
  const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const setValue=(selector,value)=>js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input'));el.dispatchEvent(new Event('change'));})()`);

  await step('Khởi động: preload API, 15 mục menu, 25 mục biên bản chưa thử',async()=>{
    const api=await js('Object.keys(window.inspect).sort().join()');
    for(const name of ['scan','diskSmartAdmin','diagnostic','stop','export','exportFirmware','warrantyLookup','warrantyWebLookup','warrantyConfigure','warrantyBrowserOpen','batteryCurrent','batteryStart','batteryStop','openTool','support'])assert(api.split(',').includes(name),`thiếu window.inspect.${name}`);
    assert.equal(await js('typeof require'),'undefined','renderer không được có Node');
    assert.equal(await js('document.querySelectorAll(".nav").length'),15);
    assert.equal(await js('!!document.querySelector(".brand")'),false,'không còn logo + tên ở thanh bên');
    assert.equal(await js('!document.querySelector("#runEmpty").classList.contains("hidden")'),true,'trang thống kê trống trước lượt test');
    assert.equal(await js('manualItems.filter(m=>m.status==="Chưa thử").length'),25);
  });

  await step('Quét tự động khi mở: SMBIOS, bản quyền, ngày cài Windows',async()=>{
    await until('!scanBusy && scanReport!==null',120000,'quét xong');
    const s=await js('Object.fromEntries(Object.entries(scanReport.sections).map(([k,v])=>[k,v.status]))');
    for(const key of ['firmwareRaw','hardwareTruth','firmwareInfo','smbiosSystem','smbiosBIOS','os','license','activation','activationHistory','powerEvents','stability','firstUse','displays','keyboards','windowsInfo','office','mdm','accounts','hotfixes','smartRaw','diskHealth'])assert.equal(s[key],'ok',`section ${key}=${s[key]}`);
    assert(await js('scanReport.diskDetails.length')>=1,'đọc được ít nhất một ổ');
    if(await js('smartNeedsAdmin()')){
      await until('!scanBusy',5000);
      assert.equal(smartAdminCalls.length,1,'tự mở hộp thoại quyền quản trị một lần sau khi quét');
      assert.equal(await js('smartDeclined'),true,'từ chối thì không tự hỏi lại');
    }
    for(const removed of ['system','bios','baseboard','cpu','memory','storage'])assert.equal(s[removed],undefined,`không được đọc ${removed} qua Windows CIM`);
    assert.equal(await text('#machineName'),await js('scanReport.sections.smbiosSystem.data[0].Product || "Không đọc được model từ SMBIOS"'));
    assert.equal(await js('document.querySelectorAll("#metrics .stat-card").length'),4);
    assert.equal(await js('document.querySelectorAll("#usageMetrics .stat-card").length'),3);
    const usage=await text('#usageMetrics');
    assert(usage.includes('Windows cài đặt') && usage.includes('Bản quyền Windows') && usage.includes('Chu kỳ sạc pin'));
    assert(/^\d{4}-\d{2}-\d{2}$/.test(await js('scanReport.sections.os.data[0].InstallDate')),'InstallDate phải dạng yyyy-MM-dd');
    assert(!(await js('JSON.stringify(scanReport.sections.license)')).match(/[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}/),'không được chứa khóa Windows đầy đủ');
    assert((await text('#usageMetrics')).includes(await js('licenseInfo(scanReport).label')),'thẻ bản quyền hiện kết luận hợp lệ / crack');
    assert(!(await text('#warrantyIdentity')).includes('Đang tự đọc'));
  });

  await step('Điều hướng: đủ 15 trang, tiêu đề + phụ đề',async()=>{
    const pages=await js('Object.keys(pages)');
    for(const page of pages){
      await js(`go("${page}")`);
      assert.equal(await js(`document.querySelector("#${page}").classList.contains("active") && document.querySelectorAll(".page.active").length===1`),true,page);
      assert.equal(await text('#pageTitle'),await js(`pages["${page}"][0]`));
      assert.equal(await js(`document.querySelector(".nav.menu-active").dataset.page`),page);
    }
  });

  await step('Thanh bên: nút thu gọn/mở, Ctrl+B, nhớ trạng thái',async()=>{
    const width='Math.round(document.querySelector(".sidebar").getBoundingClientRect().width)';
    // The test window is hidden, so CSS transitions never advance; check the end state instead.
    await js('document.head.insertAdjacentHTML("beforeend","<style id=noAnim>.sidebar,.main-area{transition:none!important}</style>")');
    const labelShown='getComputedStyle(document.querySelector(".nav-label")).display!=="none"';
    await js('document.querySelector("#toggleSidebar").click()');
    assert.equal(await js('document.body.classList.contains("sidebar-collapsed")'),true);
    await until(`${width}===60`,2000,'thanh bên thu về 4rem (60px)');
    assert.equal(await js(labelShown),false);
    assert.equal(await js('localStorage.getItem("sidebarCollapsed")'),'1');
    assert.equal(await js('document.querySelector(".nav[data-page=battery]").title'),'Pin & sạc');
    win.webContents.focus();
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'B',modifiers:['control']});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'B',modifiers:['control']});
    await until('!document.body.classList.contains("sidebar-collapsed")',2000,'Ctrl+B mở lại thanh bên');
    await until(`${width}===210`,2000,'thanh bên rộng 14rem (210px)');
    assert.equal(await js(labelShown),true);
    assert.equal(await js('localStorage.getItem("sidebarCollapsed")'),'0');
    await js('document.querySelector("#noAnim").remove()');
  });

  await step('Phần cứng / BIOS: bảng dữ liệu được dựng, escape nội dung',async()=>{
    assert(await js('document.querySelectorAll("#hardwareSections .data-table").length')>=3);
    assert(await js('document.querySelectorAll("#firmwareSections .data-table").length')>=3);
    assert.equal(await js('document.querySelector("#firmwareSections").innerHTML.includes("<script")'),false);
  });

  await step('Ổ cứng: tab từng ổ, sức khỏe, nhiệt độ, SMART, đọc quyền quản trị (giả lập), thử tốc độ',async()=>{
    await js('go("disks")');
    const count=await js('scanReport.diskDetails.length');
    assert.equal(await js('document.querySelectorAll("#diskTabs .disk-tab").length'),count);
    for(let i=0;i<count;i++){
      await click(`#diskTabs [data-disk="${i}"]`);
      assert.equal(await js('document.querySelector("#diskTabs .disk-tab.active").dataset.disk'),String(i));
      const d=await js(`scanReport.diskDetails[${i}]`);
      assert.equal(await js('document.querySelectorAll("#diskView .hbox").length'),2);
      assert((await text('#diskView .hbox')).includes(d.health.label),'ô tình trạng sức khỏe');
      assert((await text('#diskView')).includes(d.model));
      if(d.attributes.length)assert.equal(await js('document.querySelectorAll("#diskView .smart-table tbody tr").length'),d.attributes.length);
      assert.equal(await js('!!document.querySelector("#smartAdmin")'),d.needsAdmin===true,'nút quyền quản trị chỉ khi cần');
      if(d.isSSD)assert((await text('#diskView')).includes('Tuổi thọ SSD'));
    }
    // UAC is never shown in tests: the elevated read is replaced by a fixture with one SATA attribute.
    const original=await js('JSON.stringify({sections:{diskHealth:scanReport.sections.diskHealth,diskSmart:scanReport.sections.diskSmart},diskDetails:scanReport.diskDetails})');
    const details=JSON.parse(original).diskDetails;
    Object.assign(details[0],{needsAdmin:false,attributeKind:'ata',attributes:[{id:'05',name:'Reallocated Sectors Count',current:100,worst:100,threshold:10,raw:'000000000000',rawValue:0,status:'good'}]});
    ipcMain.removeHandler('disk-smart-admin');
    ipcMain.handle('disk-smart-admin',()=>({diskDetails:details,diskHealth:{status:'ok',data:[],error:null},diskSmart:{status:'ok',data:[],error:null}}));
    await click('#diskTabs [data-disk="0"]');await js('readSmartAdmin()');await until('!scanBusy',5000);
    assert((await text('#diskView .smart-table')).includes('Reallocated Sectors Count'));
    assert.equal(await js('!!document.querySelector("#smartAdmin")'),false);
    const restored=JSON.parse(original);await js(`Object.assign(scanReport.sections,${JSON.stringify(restored.sections)});scanReport.diskDetails=${JSON.stringify(restored.diskDetails)};renderScan()`);
    // The speed test runs right away on the drive being viewed: no folder picker, result stays on this page.
    const opensBefore=openDialogs;
    const drive=await js('firstLetter(scanReport.diskDetails[0])');
    if(drive){
      await click('#diskTabs [data-disk="0"]');
      assert.equal(await js('document.querySelector("#diskView article").textContent.includes("Thử ghi / đọc")'),true,'khu thử tốc độ nằm đầu trang');
      await click('#diskTestRun');await until('testBusy',5000);
      assert.equal(await js('!!document.querySelector("#diskTestProgress")'),true,'có thanh tiến độ');
      await until('!testBusy',60000,'thử ổ xong');
      assert.equal(await js('document.querySelector(".page.active").id'),'disks','ở lại trang Ổ cứng');
      assert.match(await text('#diskView article'),/\d+ MB\/s ghi.* · \d+ MB\/s đọc/);
      assert.equal(openDialogs,opensBefore,'không mở hộp chọn thư mục');
    }
    await js('document.querySelector("#testResults").innerHTML=""');
  });

  await step('Sử dụng: thẻ thống kê, biểu đồ 30 ngày, danh sách lần dùng, thời gian kích hoạt',async()=>{
    await js('go("usage")');
    const u=await js('scanReport.usage');
    assert.equal(u.available,true,'đọc được nhật ký bật / tắt máy');
    assert.equal(await js('document.querySelectorAll("#usageView .stat-card").length'),5);
    assert.equal(await js('document.querySelectorAll("#usageView .usage-chart rect").length'),30);
    assert.equal(await js('document.querySelectorAll("#usageView tbody tr").length')-await js('stabilityInfo(scanReport).events.length'),Math.min(300,Math.max(1,u.sessions.length)));
    assert((await text('#usageView')).includes('Windows đã kích hoạt'));
    for(const part of ['Số lần sập','Lịch sử sập','Mốc dùng máy lần đầu'])assert((await text('#usageView')).includes(part),`thiếu ${part}`);
    if(u.sessions.length)assert((await js('[...document.querySelectorAll("#usageView table")].at(-1).querySelector("tbody tr").textContent')).includes(u.sessions[0].startLabel));
  });

  await step('Windows: phiên bản, bản quyền + bằng chứng, bảo mật, tài khoản, cập nhật',async()=>{
    await js('go("windows")');
    const view=await text('#windowsView');
    for(const part of ['Phiên bản','Bản quyền Windows','Bảo mật','Tài khoản trên máy','Bản cập nhật gần đây','Thời điểm kích hoạt','Microsoft Office','Quản lý thiết bị (MDM)','Đối chiếu Windows ↔ phần cứng','Hết hạn bản quyền'])assert(view.includes(part),`thiếu ${part}`);
    assert(view.includes(await js('officeInfo(scanReport).label')));
    assert(view.includes(await js('licenseInfo(scanReport).label')));
    assert.equal(await js('document.querySelectorAll("#windowsView table")[1].querySelectorAll("tbody tr").length'),Math.max(1,await js('data(scanReport,"accounts").length')));
    assert(!view.match(/[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}/),'không hiện khóa đầy đủ');
  });

  await step('Font Open Sans đóng gói kèm app, cỡ gốc 15px',async()=>{
    assert.equal(await js('getComputedStyle(document.documentElement).fontSize'),'15px');
    assert.equal(await js(`document.fonts.check("13px 'Open Sans'","Kiểm tra máy")`),true);
    await js('document.fonts.ready');
    assert(await js(`[...document.fonts].some(f=>f.family.replace(/["']/g,'')==='Open Sans' && f.status==='loaded')`),'Open Sans chưa tải được');
  });

  await step('Mỗi tab có thẻ tổng quan ở đầu trang',async()=>{
    for(const page of ['overview','hardware','disks','memory','windows','usage','firmware','warranty','battery','screen','input','media','diagnostics']){
      await js(`go("${page}")`);
      const n=await js(`document.querySelectorAll("#${page} .stat-card").length`);
      assert(n>=3,`trang ${page} chỉ có ${n} thẻ tổng quan`);
    }
    await js('go("input")');assert((await text('[data-summary="input"]')).includes('Phím đã nhận'));
    await js('go("diagnostics")');assert((await text('[data-summary="diagnostics"]')).includes('Chưa chạy') || (await text('[data-summary="diagnostics"]')).includes('Đạt'));
  });

  await step('RAM: thẻ tóm tắt, bảng đủ khe từ SMBIOS',async()=>{
    await js('go("memory")');
    const m=await js('memoryInfo(scanReport)');
    assert.equal(m.available,true);
    assert.equal(await js('document.querySelectorAll("#memoryView .stat-card").length'),4);
    assert.equal(await js('document.querySelectorAll("#memoryView tbody tr").length'),m.slots.length);
    assert((await text('#memoryView')).includes('nguồn SMBIOS'));
    for(const part of ['Thử RAM sâu trong Windows','Quét toàn bộ RAM (Windows Memory Diagnostic)'])assert((await text('#memoryView')).includes(part),`thiếu ${part}`);
    assert.match(await js('window.inspect.diagnostic("memoryDeep",undefined,90).then(()=>"ok",e=>e.message)'),/Mức RAM thử không hợp lệ/);
    await js('setMemoryShare(25)');
    await click('#memoryView [data-test="memoryDeep"]');
    await until('lastTests.memoryDeep && !testBusy',240000,'thử RAM sâu xong');
    const deep=await js('lastTests.memoryDeep');
    assert.equal(deep.state,'completed',deep.detail);assert.equal(deep.metrics.errorCount,0);assert.equal(deep.metrics.passes,5);
    assert((await text('#memoryView')).includes('Không có lỗi trên'));
    assert((await text('[data-summary="diagnostics"]')).includes('RAM (thử sâu)') || true);
  });

  await step('Giao diện sáng / tối: công tắc, đổi theme, nhớ lựa chọn',async()=>{
    const start=await js('document.documentElement.dataset.theme');
    await click('#toggleTheme');
    const next=await js('document.documentElement.dataset.theme');
    assert.notEqual(next,start);assert(['inspect','inspect-dark'].includes(next));
    assert.equal(await js('localStorage.getItem("theme")'),next==='inspect-dark'?'dark':'light');
    assert.notEqual(await js('getComputedStyle(document.body).backgroundColor'),'',);
    await click('#toggleTheme');assert.equal(await js('document.documentElement.dataset.theme'),start);
  });

  await step('Ổ cứng: chọn dung lượng thử 256 MiB – 16 GiB, nhớ lựa chọn, bật lần đầu',async()=>{
    await js('go("disks")');
    assert.deepEqual(await js('[...document.querySelector("#diskView [data-disk-size]").options].map(o=>Number(o.value))'),[256,1024,4096,8192,16384]);
    await js('const el=document.querySelector("#diskView [data-disk-size]");el.value="4096";el.dispatchEvent(new Event("change",{bubbles:true}))');
    assert.equal(await js('diskTestSize'),4096);assert.equal(await js('localStorage.getItem("diskTestSize")'),'4096');
    assert.equal(await js('document.querySelector("#diagnostics [data-disk-size]").value'),'4096','đồng bộ với trang Bài thử nhanh');
    assert((await text('#diskTestHint')).includes('4 GiB'));
    assert.match(await js('window.inspect.diagnostic("disk",firstLetter(scanReport.diskDetails[0]),12345).then(()=>"ok",e=>e.message)'),/Dung lượng thử không hợp lệ/);
    await js('setDiskTestSize(256)');
    if(await js('scanReport.diskDetails[0].counters.powerOnHours!=null'))assert((await text('#diskView')).includes('Bật lần đầu'));
  });

  await step('Lưu bảng SMBIOS thô (.bin) đúng từng byte',async()=>{
    nextSavePath=path.join(dir,'smbios.bin');
    await click('#exportFirmware');await until('document.querySelector("#toastText").textContent.includes("Đã lưu:")',10000);
    const expected=Buffer.from(await js('scanReport.sections.firmwareRaw.data[0].Base64'),'base64');
    assert(fs.readFileSync(nextSavePath).equals(expected));
  });

  await step('Test toàn bộ: 6 bài tự động + 7 bước người thử chấm → trang thống kê',async()=>{
    await js('go("warranty")');await setValue('#warrantyMethod','web');await js('document.querySelector("#warrantyInFull").checked=true');await setValue('#warrantyTag','ABC1234');
    const findingsBefore=await js('document.querySelectorAll("#testResults .finding").length');
    await click('#testAll');
    await until('fullStep===6 && !testBusy && !scanBusy',180000,'chạy xong phần tự động');
    assert.equal(await js('runLog.steps.map(s=>s.status).join()'),'pass,pass,pass,pass,pass,pass',await js('JSON.stringify(runLog.steps)'));
    const drives=await js('diskDrives()');
    assert.equal(await js('document.querySelectorAll("#testResults .finding").length')-findingsBefore,2+drives.length,'CPU, RAM và từng ổ');
    assert(await text('#warrantyResults').then(t=>t.includes('Model E2E')),'tra bảo hành trong lượt Test toàn bộ');
    for(const root of [os.tmpdir(),...drives.map(d=>d+path.sep)])assert.equal(fs.readdirSync(root).filter(n=>n.startsWith('test-tool-test-')).length,0,`thư mục tạm ổ đĩa phải được dọn ở ${root}`);
    assert.equal(await js('document.querySelector("#fullPass").classList.contains("hidden")'),false,'bước thủ công có nút Đạt');
    const choose=async(button,page)=>{assert.equal(await js('document.querySelector(".page.active").id'),page);await click(button);await wait(100);};
    await choose('#fullPass','screen');
    await js('setKeyboard(true);document.querySelector("#keyboard").dispatchEvent(new KeyboardEvent("keydown",{key:"q",code:"KeyQ",bubbles:true,cancelable:true}))');
    await choose('#fullPass','input');await choose('#fullFail','input');
    await choose('#fullPass','media');await choose('#fullNext','media');await choose('#fullNext','media');
    await choose('#fullPass','battery');
    await until('!fullRun',5000,'kết thúc lượt test');
    assert.equal(await js('document.querySelector(".page.active").id'),'summary','tự chuyển sang trang thống kê');
    assert.equal(await js('runLog.steps.length'),13);
    assert.match(await js('runLog.steps[1].detail'),/Tốt|Cẩn thận|Xấu|Chưa rõ/,'bước sức khỏe ổ cứng');
    assert.match(await js('runLog.steps[5].detail'),/ghi \d+ MB\/s/,'bài thử ổ có tốc độ');
    const stats=await text('#runStats');assert(stats.includes('Đạt10') && stats.includes('Có lỗi1') && stats.includes('Bỏ qua2'),stats);
    assert((await text('#runVerdict')).includes('Phát hiện 1 mục có lỗi'));
    assert(await js('[...document.querySelectorAll("#runSteps tr")].some(r=>r.textContent.includes("Bàn phím") && r.textContent.includes("1/"))'),'bằng chứng số phím');
    assert((await text('#runMachine')).includes('Bản quyền Windows'));
    assert.equal(await js('manualItems[2].status+manualItems[4].status+manualItems[5].status+manualItems[7].status'),'ĐạtĐạtCó lỗiChưa thử','chỉ ghi biên bản theo lựa chọn của người thử');
    assert.equal(await js('manualItems.filter(m=>m.status==="Chưa thử").length'),19);
    await js('document.querySelector("#warrantyInFull").checked=false');
  });

  await step('Ổ cứng: sau bài thử có đánh giá theo loại ổ, đọc thẳng từ ổ',async()=>{
    const drive=await js('Object.keys(diskTests).find(k=>diskTests[k].metrics)');
    assert(drive,'chưa có kết quả thử ổ');
    const r=await js(`diskTests["${drive}"]`);
    assert(r.verdict && ['good','caution','bad','unknown'].includes(r.verdict.status),'thiếu đánh giá');
    assert.equal(r.metrics.readCached,false,'đọc phải bỏ qua bộ đệm Windows');
    assert(r.detail.startsWith(r.verdict.label+':'));
    await js(`go("disks");diskIndex=scanReport.diskDetails.findIndex(d=>firstLetter(d)==="${drive}");renderDisks()`);
    assert((await text('#diskView')).includes(`Đánh giá: ${r.verdict.label}`));
  });

  await step('Dừng Test toàn bộ giữa chừng vẫn có thống kê',async()=>{
    const saved=await js('JSON.stringify(runLog)');
    await click('#testAll');await until('scanBusy',10000);await click('#fullStop');
    await until('!fullRun && !scanBusy',120000,'dừng lượt test');
    assert.equal(await js('runLog.stopped'),true);assert((await text('#runVerdict')).includes('Đã dừng giữa chừng'));
    await js(`runLog=${saved};renderRunSummary()`);
  });

  await step('Bài thử: RAM chạy riêng, dừng CPU giữa chừng, hủy chọn ổ',async()=>{
    await js('go("diagnostics")');
    await click('[data-test="memory"]');await until('!testBusy',60000);
    assert((await text('#testResults .finding')).includes('RAM'));
    await click('[data-test="cpu"]');await until('testBusy',5000);await wait(800);
    assert.equal(await js('document.querySelector("#scan").disabled && document.querySelector("#testAll").disabled'),true,'khóa nút khi đang chạy');
    await click('#stopTest');await until('!testBusy',20000);
    assert((await text('#testResults .finding')).includes('Đã dừng'));
    for(const bad of ['Z:','C:\\Windows','..',''])assert.match(await js(`window.inspect.diagnostic("disk",${JSON.stringify(bad)}).then(()=>"ok",e=>e.message)`),/không có trong kết quả quét/,`từ chối ổ ${bad}`);
    assert.equal(await js('[...document.querySelectorAll("#diskTarget option")].map(o=>o.value).join()'),await js('diskDrives().join()'),'danh sách ổ để thử');
  });

  await step('Không cho đóng cửa sổ khi bài thử đang chạy',async()=>{
    await click('[data-test="cpu"]');await until('testBusy',5000);
    messageBoxes.length=0;win.close();await wait(300);
    assert.equal(win.isDestroyed(),false);assert(messageBoxes.some(m=>m.includes('dừng bài thử')));
    await click('#stopTest');await until('!testBusy',20000);
  });

  await step('Màn hình: màu toàn màn, phím đổi màu, Esc, tự chạy + đánh dấu điểm',async()=>{
    await js('go("screen")');
    await click('[data-color="2"]');
    assert.equal(await js('!document.querySelector("#screenOverlay").classList.contains("hidden") && colorIndex===2'),true);
    await js('document.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}))');assert.equal(await js('colorIndex'),3);
    await js('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
    assert.equal(await js('document.querySelector("#screenOverlay").classList.contains("hidden")'),true);
    await click('#autoPixels');await until('pixelTimer!==null',5000);await wait(3300);assert.equal(await js('colorIndex>0'),true,'tự đổi màu');
    await js('document.querySelector("#screenOverlay").dispatchEvent(new MouseEvent("click",{clientX:123,clientY:45,bubbles:true}));closeScreen()');
    assert.equal(await js('pixelMarks.length'),1);assert((await text('#pixelMarks')).includes('1 vị trí'));
    await click('#clearPixelMarks');assert.equal(await js('pixelMarks.length'),0);
    await click('#autoPixels');await until('pixelTimer!==null',5000);
    await js('document.querySelector("#screenOverlay").dispatchEvent(new MouseEvent("click",{clientX:123,clientY:45,bubbles:true}));closeScreen()');
    assert.equal(await js('pixelTimer'),null,'đóng màn hình phải dừng vòng màu');
  });

  await step('Bàn phím: bắt phím, giữ/nhả, Esc dừng, xóa dấu',async()=>{
    await js('go("input")');await click('#keyboardToggle');assert.equal(await js('keyboardActive'),true);
    const key=(type,code,keyName)=>js(`document.querySelector("#keyboard").dispatchEvent(new KeyboardEvent("${type}",{key:"${keyName}",code:"${code}",bubbles:true,cancelable:true}))`);
    await key('keydown','KeyA','a');
    assert.equal(await js('document.querySelector("[data-code=KeyA]").classList.contains("seen") && document.querySelector("[data-code=KeyA]").classList.contains("pressed")'),true);
    await key('keyup','KeyA','a');assert.equal(await js('document.querySelector("[data-code=KeyA]").classList.contains("pressed")'),false);
    assert((await text('#lastKey')).includes('KeyA'));
    await key('keydown','Escape','Escape');assert.equal(await js('keyboardActive'),false);
    await key('keydown','KeyB','b');assert.equal(await js('document.querySelector("[data-code=KeyB]").classList.contains("seen")'),false,'không bắt phím khi đã dừng');
    await click('#clearKeys');assert.equal(await js('document.querySelectorAll(".key.seen").length'),0);
  });

  await step('Bàn phím: tự nhận kiểu có / không phím số, đổi tay, phím số tự chuyển',async()=>{
    await js('go("input")');
    const guess=await js('keyboardGuess(scanReport)');
    await setValue('#kbLayout','auto');
    assert.equal(await js('!!document.querySelector(".key-pad")'),guess.layout==='full',guess.reason);
    assert((await text('#kbInfo')).includes('Tự nhận'));
    await setValue('#kbLayout','compact');assert.equal(await js('!!document.querySelector(".key-pad")'),false);
    await setValue('#kbLayout','full');assert.equal(await js('document.querySelectorAll(".key-pad .key").length'),17);
    assert.equal(await js('localStorage.getItem("kbLayout")'),'full');
    await setValue('#kbLayout','compact');await js('kbChoice="auto";renderKeyboard();if(document.querySelector(".key-pad")){kbChoice="compact";renderKeyboard();kbChoice="auto";}');
    await js('setKeyboard(true);document.querySelector("#keyboard").dispatchEvent(new KeyboardEvent("keydown",{key:"5",code:"Numpad5",bubbles:true,cancelable:true}))');
    assert.equal(await js('!!document.querySelector(".key-pad") && document.querySelector("[data-code=Numpad5]").classList.contains("seen")'),true,'nhấn phím số phải hiện bàn phím có phím số');
    assert((await text('#kbDevices')).includes('Bàn phím đang kết nối'));
    await click('#kbRefresh');await until('!kbDeviceBusy && Array.isArray(kbDeviceList)',30000,'dò lại bàn phím');
    assert.equal(await js('document.querySelectorAll("#kbDevices .badge").length'),await js('keyboardDevices(kbDeviceList).devices.length'));
    await js('setKeyboard(false);kbChoice="auto";localStorage.removeItem("kbLayout");renderKeyboard();document.querySelectorAll(".key").forEach(k=>k.classList.remove("seen","pressed"))');
  });

  await step('Touchpad: click trái/phải và cuộn được đếm',async()=>{
    await js('go("input");document.querySelector("#pointerPad").scrollIntoView({block:"center"})');await wait(200);
    const r=await js('(()=>{const b=document.querySelector("#pointerPad").getBoundingClientRect();return {x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)};})()');
    for(const button of ['left','right']){win.webContents.sendInputEvent({type:'mouseDown',x:r.x,y:r.y,button,clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',x:r.x,y:r.y,button,clickCount:1});}
    win.webContents.sendInputEvent({type:'mouseWheel',x:r.x,y:r.y,deltaX:0,deltaY:-120});
    await until('document.querySelector("#mouseStats").textContent==="Trái: 1 · Giữa: 0 · Phải: 1 · Cuộn: 1"',5000,'đếm click/cuộn');
  });

  await step('Âm thanh & camera: loa 2 kênh, dò thiết bị, camera/micro bật hoặc báo lỗi rõ',async()=>{
    await js('go("media")');await click('#refreshDevices');await until('document.querySelector("#mediaDeviceStatus").textContent.includes("Windows liệt kê")',5000);
    await click('#leftSound');await click('#rightSound');await click('#stopSound');
    await click('#startCamera');await wait(100);
    await until('!document.querySelector("#startCamera").disabled || !document.querySelector("#stopCamera").disabled',15000,'camera phản hồi');
    if(!(await js('document.querySelector("#stopCamera").disabled'))){await click('#stopCamera');}
    else assert.notEqual(await text('#cameraStatus'),'Camera đang tắt','không có camera phải báo lỗi cụ thể');
    await click('#startMic');await wait(100);
    await until('!document.querySelector("#startMic").disabled || !document.querySelector("#stopMic").disabled',15000,'micro phản hồi');
    assert.notEqual(await text('#micStatus'),'Chưa bật · bản ghi chỉ giữ trong RAM');
    if(!(await js('document.querySelector("#stopMic").disabled')))await click('#stopMic');
    await js('go("overview")');assert.equal(await js('cameraStream===null && micStream===null'),true,'rời trang phải tắt thiết bị');
  });

  await step('Pin: đọc trạng thái hiện tại, bắt đầu test (chạy hoặc từ chối có lý do)',async()=>{
    await js('go("battery")');await until('!batteryReading && !document.querySelector("#batteryLive").textContent.includes("Chưa đọc")',20000,'đọc trạng thái pin');
    assert.equal(await js('document.querySelectorAll("#batteryMetrics .stat-card").length'),4);
    await setValue('#batteryConditions','Độ sáng 50% <b>e2e</b>');
    await click('#startBattery');
    await until('document.querySelector("#batteryTestStatus").textContent!=="Chưa test."',20000,'phản hồi test pin');
    if(!(await js('document.querySelector("#stopBattery").disabled'))){await click('#stopBattery');await until('document.querySelector("#batteryTestStatus").textContent.includes("Đã dừng")',10000);}
    else assert(/pin|sạc/i.test(await text('#batteryTestStatus')),'phải nêu lý do không chạy');
  });

  await step('Tra bảo hành qua trang hỗ trợ: kết quả, lọc token, mã sai, mở trang trong app',async()=>{
    await js('go("warranty")');await setValue('#warrantyMethod','web');
    assert.equal(await js('document.querySelector("#warrantyClientId").closest("article").classList.contains("hidden")'),true);
    await setValue('#warrantyTag','ABC1234');await click('#warrantyLookup');
    await until('document.querySelector("#warrantyResults").textContent.includes("Model E2E")',10000);
    assert.equal((await text('#warrantyResults')).includes('never-export'),false,'token phiên không được hiển thị');
    await setValue('#warrantyTag','invalid!');await click('#warrantyLookup');await until('document.querySelector("#warrantyResults").textContent.includes("5–12")',5000);
    await setValue('#warrantyTag','ABC1234');await click('#openWarrantyBrowser');
    const start=Date.now();while(BrowserWindow.getAllWindows().length<2 && Date.now()-start<10000)await wait(100);
    const supportWin=BrowserWindow.getAllWindows().find(w=>w!==win);assert(supportWin,'phải mở cửa sổ trang hỗ trợ');
    while(!supportWin.webContents.getURL() && Date.now()-start<10000)await wait(100);
    assert(supportWin.webContents.getURL()===supportPageURL('ABC1234'),supportWin.webContents.getURL());supportWin.destroy();
  });

  await step('Tra API bảo hành: thiếu khóa, nạp khóa, OAuth + bảo hành, xóa khóa',async()=>{
    await setValue('#warrantyMethod','api');await setValue('#warrantyTag','ABC1234');
    await click('#warrantyLookup');await until('document.querySelector("#warrantyResults").textContent.includes("Cần Client ID")',5000);
    assert.equal(fetchCalls.length,0,'không gọi mạng khi chưa có khóa');
    await setValue('#warrantyClientId','e2e-id');await setValue('#warrantySecret','e2e-secret-value');await click('#warrantyConnect');
    await until('document.querySelector("#warrantyAuthStatus").textContent.includes("Đã nạp")',5000);
    assert.equal(await js('document.querySelector("#warrantySecret").value'),'','xóa ô secret sau khi nạp');
    await click('#warrantyLookup');await until('document.querySelector("#warrantyResults").textContent.includes("Model 5420")',10000);
    assert((await text('#warrantyResults')).includes('Premium Support'));
    assert.equal(fetchCalls[0].url,TOKEN_URL);assert(fetchCalls[0].body.includes('client_secret=e2e-secret-value'));
    await click('#warrantyClear');await until('document.querySelector("#warrantyAuthStatus").textContent.includes("Đã xóa")',5000);
    await setValue('#warrantyMethod','web');
  });

  await step('Liên kết ngoài: trang hỗ trợ, cài đặt Windows, cổng API bảo hành',async()=>{
    opened.length=0;
    await setValue('#warrantyTag','ABC1234');await click('#supportFallback');await click('#support');
    await js('document.querySelectorAll("[data-tool]").forEach(b=>b.click())');await wait(500);
    assert(opened.some(u=>u.includes('ABC1234') && u.includes('/overview')));
    for(const link of ['ms-settings:display','ms-settings:sound','ms-settings:privacy-microphone','ms-settings:privacy-webcam',PORTAL_URL,'ms-settings:activation','ms-settings:windowsupdate','ms-settings:otherusers','ms-settings:recovery','ms-settings:about','windowsdefender:','ms-settings:workplace'])assert(opened.includes(link),`thiếu ${link}`);
  });

  await step('Biên bản: chọn kết quả, ghi chú, tổng hợp, xuất HTML đầy đủ + escape',async()=>{
    await js('go("checklist")');
    await js(`(()=>{const s=document.querySelectorAll("select[data-manual]");s[0].value="Đạt";s[0].dispatchEvent(new Event("change"));s[1].value="Có lỗi";s[1].dispatchEvent(new Event("change"));const n=document.querySelector("[data-note='1']");n.value="Nứt bản lề <img src=x>";n.dispatchEvent(new Event("input"));})()`);
    const counts=await js('manualItems.reduce((c,m)=>(c[m.status]=(c[m.status]||0)+1,c),{})');
    const summary=await text('#checklistSummary');
    for(const [label,value] of Object.entries(counts))assert(summary.includes(`${label} ${value}`),summary);
    await setValue('#notes','<script>QA</script> giá 10tr');
    nextSavePath=path.join(dir,'report.html');await click('#exportBottom');
    await until('document.querySelector("#toastText").textContent.includes("Đã lưu báo cáo")',10000);
    const report=fs.readFileSync(nextSavePath,'utf8');
    for(const expected of ['Kết quả lượt Test toàn bộ','Đạt 10','Có lỗi 1','diskHealth','diskSmart','ghi/đọc 256 MiB, đo tốc độ','&lt;script&gt;QA&lt;/script&gt;','Nứt bản lề &lt;img src=x&gt;','Có lỗi','CPU · tải 1 luồng','RAM · vùng nhớ 64 MiB','smbiosSystem','license','Bản quyền Windows','InstallDate','x=123, y=45','Độ sáng 50% &lt;b&gt;e2e&lt;/b&gt;','warrantyWebsite','warrantyApiCoverage','Premium Support'])assert(report.includes(expected),`báo cáo thiếu: ${expected}`);
    assert(!report.includes('smartRaw'),'không xuất dữ liệu SMART thô base64');
    for(const secret of ['e2e-secret-value','e2e-token','never-export','<script>QA'])assert(!report.includes(secret),`báo cáo lộ: ${secret}`);
  });

  await step('Bảo mật IPC: trang khác dùng cùng preload bị từ chối',async()=>{
    const other=new BrowserWindow({show:false,webPreferences:{preload:path.join(appDir,'src/preload.cjs'),contextIsolation:true,sandbox:true}});
    await other.loadURL('data:text/html,<p>x</p>');
    const result=await other.webContents.executeJavaScript('window.inspect.exportFirmware().then(()=>"allowed",e=>e.message)',true);
    other.destroy();assert(result.includes('Nguồn yêu cầu không hợp lệ'),result);
  });

  await step('Không có lỗi console trong renderer',async()=>{assert.equal(consoleErrors.length,0,consoleErrors.join('\n'));});

  const failed=results.filter(r=>!r.ok);
  console.log(`\n${results.length-failed.length}/${results.length} nhóm chức năng đạt${failed.length?` · lỗi: ${failed.map(f=>f.name).join('; ')}`:''}`);
  win.destroy();app.exit(failed.length?1:0);
}).catch(error=>{console.error(error);app.exit(1);}).finally(()=>{try{fs.rmSync(dir,{recursive:true,force:true});}catch{}});
