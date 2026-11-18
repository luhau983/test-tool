const {test}=require('node:test');const assert=require('node:assert/strict');
const {licenseInfo,licenseExpiry,keyboardGuess,keyboardDevices,diskSpeedVerdict,memoryDiagnosticInfo,stabilityInfo,firstUseInfo,officeInfo,mdmInfo,hardwareTruth,memoryInfo,memoryVendor,usageInfo,ago,assess,CYCLE_WARN}=require('../src/assessment.cjs');
const {makeReport}=require('../src/report.cjs');
test('report includes the full-run statistics, escaped, and omits the section when there was no run',()=>{
  const run={startedAt:'2026-11-18T01:00:00.000Z',endedAt:'2026-11-18T01:05:30.000Z',stopped:false,steps:[{title:'Màn hình',status:'Đạt',detail:'0 vị trí'},{title:'Webcam <x>',status:'Có lỗi',detail:'<b>mờ</b>'},{title:'Pin',status:'Bỏ qua',detail:''}]};
  const html=makeReport({sections:{}},[],[],'',run);
  assert(html.includes('Kết quả lượt Test toàn bộ'));assert(html.includes('5 phút 30 giây'));assert(html.includes('Đạt 1'));assert(html.includes('Có lỗi 1'));assert(html.includes('Bỏ qua 1'));
  assert(html.includes('Webcam &lt;x&gt;'));assert(!html.includes('<b>mờ</b>'));
  assert(!makeReport({sections:{}},[],[],'').includes('Kết quả lượt Test toàn bộ'));
});
const lic=(rows,activation)=>({sections:{license:{status:'ok',data:rows,error:null},...(activation?{activation:{status:'ok',data:[activation],error:null}}:{})}});
const clean={ArtifactCount:0,Artifacts:'',KmsHost:null,PartOfDomain:false};

test('activated retail/OEM license without crack traces is genuine',()=>{
  const r=licenseInfo(lic([{Name:'Windows Pro',Channel:'OEM:DM',LicenseStatus:1,OemKeyInFirmware:true}],clean));
  assert.equal(r.verdict,'genuine');assert.equal(r.state,'info');assert.equal(r.label,'Bản quyền hợp lệ');assert.equal(r.status,'Đã kích hoạt');
  assert.equal(r.channel,'OEM:DM');assert(r.detail.includes('khóa OEM'));assert(r.detail.includes('HWID'),'nêu giới hạn không phân biệt được HWID');
});
test('crack tool leftovers mark Windows as cracked even on a retail channel',()=>{
  const r=licenseInfo(lic([{LicenseStatus:1,Channel:'Retail'}],{...clean,ArtifactCount:2,Artifacts:'Dịch vụ: Service KMSELDI | Tác vụ hẹn giờ: \\AutoPico Daily Restart'}));
  assert.equal(r.verdict,'cracked');assert.equal(r.label,'Có dấu hiệu crack');assert.equal(r.state,'warn');
  assert.deepEqual(r.evidence,['Dịch vụ: Service KMSELDI','Tác vụ hẹn giờ: \\AutoPico Daily Restart']);
});
test('KMS activation: KMS38 grace, local emulator, online KMS and real company KMS are told apart',()=>{
  const now=Date.parse('2026-11-18T00:00:00Z');
  const kms38=licenseInfo(lic([{LicenseStatus:1,Channel:'Volume:GVLK',GraceMinutes:6000000}],clean),now);
  assert.equal(kms38.verdict,'cracked');assert.match(kms38.detail,/năm 2038/);
  const local=licenseInfo(lic([{LicenseStatus:1,Channel:'Volume:GVLK',GraceMinutes:259000,KmsMachine:'127.0.0.2'}],clean),now);
  assert.equal(local.verdict,'cracked');assert.deepEqual(local.evidence,['Máy chủ KMS: 127.0.0.2']);
  const online=licenseInfo(lic([{LicenseStatus:1,Channel:'Volume:GVLK',GraceMinutes:259000}],{...clean,KmsHost:'kms.example.org'}),now);
  assert.equal(online.verdict,'suspect');assert.equal(online.label,'Nghi crack (KMS)');assert.match(online.detail,/kms\.example\.org/);
  assert.equal(licenseInfo(lic([{LicenseStatus:1,Channel:'',Description:'Windows(R) Operating System, VOLUME_KMSCLIENT channel'}],clean)).verdict,'suspect','nhận KMS qua Description');
  const company=licenseInfo(lic([{LicenseStatus:1,Channel:'Volume:GVLK',GraceMinutes:259000,KmsDiscovered:'kms.corp.local'}],{...clean,PartOfDomain:true}),now);
  assert.equal(company.verdict,'corporate');
  assert.equal(licenseInfo(lic([{LicenseStatus:1,Channel:'Volume:MAK'}],clean)).verdict,'corporate');
});
test('unactivated Windows and missing key are warnings',()=>{
  const r=licenseInfo(lic([{LicenseStatus:5,Channel:'Retail'}]));assert.equal(r.verdict,'inactive');assert.equal(r.state,'warn');assert.match(r.detail,/thông báo/);
  assert.equal(licenseInfo(lic([])).label,'Không có khóa Windows');
});
test('activated row wins over other installed keys',()=>{
  assert.equal(licenseInfo(lic([{LicenseStatus:0,Channel:'Retail'},{LicenseStatus:1,Channel:'Retail'}])).state,'info');
});
test('missing or failed license section stays unknown',()=>{
  assert.equal(licenseInfo({sections:{}}).state,'unknown');assert.equal(licenseInfo({sections:{}}).verdict,'unknown');
  assert.equal(licenseInfo({sections:{license:{status:'unknown',data:[],error:'timeout'}}}).detail,'timeout');
});
test('usage info combines install date, disk hours and battery date without inventing values',()=>{
  const r={sections:{os:{status:'ok',data:[{InstallDate:'2026-01-01'}]},battery:{status:'ok',data:[{ManufactureDate:'2021-05-10'}]}},diskDetails:[{counters:{powerOnHours:120}},{counters:{powerOnHours:null}},{counters:{powerOnHours:3400}}]};
  const u=usageInfo(r,Date.parse('2026-11-18'));
  assert.equal(u.windowsInstalled,'2026-01-01');assert.equal(u.windowsDays,321);assert.equal(u.diskPowerOnHours,3400);assert.equal(u.batteryManufactured,'2021-05-10');
  const empty=usageInfo({sections:{}});assert.equal(empty.windowsInstalled,null);assert.equal(empty.diskPowerOnHours,null);
});
test('relative age wording',()=>{assert.equal(ago(10),'10 ngày trước');assert.equal(ago(300),'khoảng 10 tháng trước');assert.equal(ago(1095),'khoảng 3.0 năm trước');assert.equal(ago(null),'');});
test('battery cycles at or above the threshold produce a warning; missing cycles never become zero',()=>{
  const bat=c=>({sections:{battery:{status:'ok',data:[{Name:'B1',DesignCapacity:50000,FullChargeCapacity:45000,CycleCount:c}]}}});
  const high=assess(bat(String(CYCLE_WARN))).find(c=>c.title.startsWith('Pin'));assert.equal(high.state,'warn');assert(high.title.includes(`${CYCLE_WARN} chu kỳ`));
  assert.equal(assess(bat('120')).find(c=>c.title.startsWith('Pin')).state,'info');
  assert(assess(bat('')).find(c=>c.title.startsWith('Pin')).title.includes('chưa rõ chu kỳ'));
});
test('assess reports license and install date findings',()=>{
  const r={sections:{os:{status:'ok',data:[{InstallDate:'2025-03-18'}]},license:{status:'ok',data:[{LicenseStatus:1,Channel:'Retail'}]}}};
  const titles=assess(r).map(c=>c.title);
  assert(titles.includes('Bản quyền Windows: Bản quyền hợp lệ'));assert(titles.some(t=>t.startsWith('Windows cài ngày 2025-03-18')));
});

const off=(o,activation={ArtifactCount:0,Artifacts:'',PartOfDomain:false})=>({sections:{office:{status:'ok',data:[{Installed:true,Hooks:'',KmsRequests:'',M365Licenses:false,Products:[],...o}],error:null},activation:{status:'ok',data:[activation],error:null}}});
const gvlk={Name:'Office 21, ProPlus2021VL_KMS_Client',Channel:'Volume:GVLK',LicenseStatus:1,PartialProductKey:'6F7TH',GraceMinutes:164000};
test('office: Ohook and activation tools → cracked',()=>{
  const hook=officeInfo(off({Products:[{...gvlk,Channel:'Retail'}],Hooks:'C:\Program Files\Microsoft Office\root\vfs\System\sppc.dll'}));
  assert.equal(hook.verdict,'cracked');assert.match(hook.evidence[0],/sppc\.dll/);
  assert.equal(officeInfo(off({Products:[{...gvlk,Channel:'Retail'}]},{Artifacts:'Thư mục: KMSAuto',PartOfDomain:false})).verdict,'cracked');
});
test('office: GVLK off-domain — outside KMS host → cracked, none → suspect; domain → corporate; KMS38 grace → cracked',()=>{
  const online=officeInfo(off({Products:[gvlk],KmsRequests:'2026-09-13 17:17 158.178.234.166:1688 | 2026-09-07 19:46 70.37.61.117:1688'}));
  assert.equal(online.verdict,'cracked');assert.deepEqual(online.evidence,['Máy chủ KMS: 158.178.234.166:1688','Máy chủ KMS: 70.37.61.117:1688']);assert.equal(online.requests.length,2);
  assert.equal(officeInfo(off({Products:[gvlk],KmsHost:'kms.example.org'})).verdict,'cracked');
  assert.equal(officeInfo(off({Products:[gvlk]})).verdict,'suspect');
  assert.equal(officeInfo(off({Products:[gvlk]},{Artifacts:'',PartOfDomain:true})).verdict,'corporate');
  assert.equal(officeInfo(off({Products:[{...gvlk,GraceMinutes:6000000}]})).verdict,'cracked');
});
test('office: retail genuine, MAK corporate, Microsoft 365, inactive, not installed, unknown',()=>{
  const retail=officeInfo(off({Products:[{Name:'Office 21, HomeBusiness2021R_Retail',Channel:'Retail',LicenseStatus:1}]}));
  assert.equal(retail.verdict,'genuine');assert.equal(retail.state,'info');assert.equal(retail.status,'Đã kích hoạt');
  assert.equal(officeInfo(off({Products:[{Channel:'Volume:MAK',LicenseStatus:1}]})).verdict,'corporate');
  assert.equal(officeInfo(off({M365Licenses:true})).verdict,'subscription');
  assert.equal(officeInfo(off({})).verdict,'inactive');
  assert.equal(officeInfo(off({Products:[{Channel:'Retail',LicenseStatus:5}]})).verdict,'inactive');
  assert.equal(officeInfo(off({Installed:false})).verdict,'notInstalled');
  assert.equal(officeInfo({sections:{}}).verdict,'unknown');
});
test('assess adds an Office finding only when Office is installed',()=>{
  assert(assess(off({Products:[gvlk]})).some(c=>c.title==='Microsoft Office: Office nghi crack (KMS)'));
  assert(!assess(off({Installed:false})).some(c=>c.title.startsWith('Microsoft Office')));
});

const mdmReport=m=>({sections:{mdm:{status:'ok',data:[{AzureAdJoined:false,DomainJoined:false,WorkplaceJoined:false,Enrollments:'',Agents:'',AutopilotTenant:null,...m}],error:null}}});
test('mdm: Autopilot beats MDM, then join, then agents; clean otherwise',()=>{
  const ap=mdmInfo(mdmReport({AutopilotTenant:'contoso.com',AutopilotProfile:'Std',Enrollments:'MS DM Server · a@contoso.com · enrollment.manage.microsoft.com'}));
  assert.equal(ap.verdict,'autopilot');assert.equal(ap.state,'warn');assert.match(ap.detail,/contoso\.com/);
  assert.deepEqual(ap.evidence,['Autopilot: contoso.com (hồ sơ Std)','MDM: MS DM Server · a@contoso.com · enrollment.manage.microsoft.com']);
  assert.equal(mdmInfo(mdmReport({Enrollments:'MS DM Server · a@contoso.com',AzureAdJoined:true})).verdict,'managed');
  assert.equal(mdmInfo(mdmReport({MdmUrl:'https://enrollment.manage.microsoft.com/x'})).verdict,'managed');
  const joined=mdmInfo(mdmReport({DomainJoined:true,Domain:'corp.local'}));assert.equal(joined.verdict,'joined');assert.deepEqual(joined.evidence,['Domain: corp.local']);
  assert.equal(mdmInfo(mdmReport({Agents:'Absolute Persistence | Configuration Manager'})).evidence.length,2);
  assert.equal(mdmInfo(mdmReport({Agents:'Absolute Persistence'})).verdict,'agent');
  const clean=mdmInfo(mdmReport({}));assert.equal(clean.verdict,'clean');assert.equal(clean.state,'info');assert.deepEqual(clean.evidence,[]);
  assert.match(mdmInfo(mdmReport({WorkplaceJoined:true})).detail,/cơ quan/);
  assert.equal(mdmInfo({sections:{}}).verdict,'unknown');
  assert(assess(mdmReport({AutopilotTenant:'x.com'})).some(c=>c.title==='Quản lý thiết bị: Đăng ký Autopilot của tổ chức'));
});

const truthReport=(t,disks=[])=>({diskDetails:disks,sections:{hardwareTruth:{status:'ok',data:[{CpuBrand:'Intel(R) Core(TM) i5-8350U CPU @ 1.70GHz',Major:10,Minor:0,Build:26100,ProductType:0x65,OemKeyTail:'8HVX7',
  Gpus:[{VendorId:'8086',DeviceId:'5917',Subsys:'07A81028',WindowsName:'Intel(R) UHD Graphics 620',InfFile:'oem12.inf',InfName:'Intel(R) UHD Graphics 620',InfSigned:true}],RegCpuName:'Intel(R) Core(TM) i5-8350U CPU @ 1.70GHz   ',RegEditionID:'Core',RegBuild:'26100',RegUBR:4351,...t}],error:null}}});
test('hardware truth: kernel / firmware values win; edited registry values are flagged',()=>{
  const ok=hardwareTruth(truthReport({},[{index:0,name:'NVMe SK hynix PC401',model:'SK hynix PC401'}]));
  assert.equal(ok.osName,'Windows 11 Home');assert.equal(ok.release,'24H2');assert.equal(ok.cpu,'Intel(R) Core(TM) i5-8350U CPU @ 1.70GHz');assert.equal(ok.oemKeyTail,'8HVX7');
  assert.deepEqual(ok.mismatches,[]);assert.equal(ok.items.length,5);
  const faked=hardwareTruth(truthReport({RegCpuName:'Intel(R) Core(TM) i9-13900H',RegEditionID:'Professional',Gpus:[{VendorId:'8086',DeviceId:'5917',WindowsName:'NVIDIA GeForce RTX 4090',InfName:'Intel(R) UHD Graphics 620',InfSigned:true}]},[{index:0,name:'Samsung SSD 990 PRO 2TB',model:'SK hynix PC401'}]));
  assert.deepEqual(faked.mismatches.map(m=>m.name),['CPU','Phiên bản (Edition)','Card đồ họa','Ổ 0']);
  assert.equal(faked.cpu,'Intel(R) Core(TM) i5-8350U CPU @ 1.70GHz','luôn hiện CPU thật');
  const finding=assess(truthReport({RegCpuName:'Intel(R) Core(TM) i9-13900H'})).find(c=>c.title.startsWith('Windows ghi khác phần cứng'));
  assert.equal(finding.state,'warn');assert.match(finding.detail,/i9-13900H.*i5-8350U/);
  assert(assess(truthReport({})).some(c=>c.title.startsWith('Thông tin Windows khớp phần cứng')));
  assert.equal(hardwareTruth({sections:{}}).available,false);
  const renamed=n=>hardwareTruth(truthReport({Gpus:[{VendorId:'10DE',DeviceId:'1C82',WindowsName:'NVIDIA GeForce RTX 3060',InfFile:'oem6.inf',InfName:'NVIDIA GeForce GTX 1050 Ti',InfSigned:n}]}));
  const same=renamed(true);assert.equal(same.gpus[0].match,false,'đổi tên cùng hãng vẫn bị bắt');assert.match(same.items.find(i=>i.name==='Card đồ họa').truth,/GTX 1050 Ti · PCI 10DE:1C82/);
  const unsigned=renamed(false);assert.equal(unsigned.gpus[0].model,null,'INF không có chữ ký thì không tin tên trong INF');assert.equal(unsigned.gpus[0].match,true,'chỉ còn so được hãng');
  assert.match(unsigned.items.find(i=>i.name==='Card đồ họa').source,/không có chữ ký/);
  assert.equal(hardwareTruth(truthReport({Build:19045,ProductType:0x30})).osName,'Windows 10 Pro');
});

const dimm=(slot,bank,o={})=>({Slot:slot,Bank:bank,SizeMiB:8192,Installed:'Yes',MemoryType:0x1A,FormFactor:0x0D,SpeedMTs:3200,ConfiguredMTs:3200,Manufacturer:'80CE000080CE',SerialNumber:'1234',PartNumber:'M471A1K43DB1-CWE ',DataWidth:64,TotalWidth:64,Rank:1,ConfiguredVoltageMV:1200,...o});
const ram=(slots,arrays=[{Use:3,MaxCapacityKiB:67108864,Slots:2}],truth={VisibleBytes:16*1073741824-500*1048576})=>({sections:{smbiosMemory:{status:'ok',data:slots},smbiosMemoryArray:{status:'ok',data:arrays},hardwareTruth:{status:'ok',data:[truth]}}});
test('memory vendor: JEDEC ids in either byte order, plain names kept',()=>{
  assert.equal(memoryVendor('80CE000080CE'),'Samsung');assert.equal(memoryVendor('CE00'),'Samsung');assert.equal(memoryVendor('80AD'),'SK hynix');
  assert.equal(memoryVendor('802C'),'Micron');assert.equal(memoryVendor('0198'),'Kingston');assert.equal(memoryVendor('Crucial'),'Crucial');assert.equal(memoryVendor('8551'),'JEDEC 8551');assert.equal(memoryVendor(''),null);
});
test('memory: dual channel, type, speed, upgrade room and part number',()=>{
  const m=memoryInfo(ram([dimm('DIMM A','ChannelA-DIMM0'),dimm('DIMM B','ChannelB-DIMM0')]));
  assert.equal(m.totalMiB,16384);assert.equal(m.channel,'dual');assert.deepEqual(m.types,['DDR4']);assert.equal(m.runningMTs,3200);assert.equal(m.maxGiB,64);
  assert.equal(m.upgradeable,false);assert.equal(m.modules[0].vendor,'Samsung');assert.equal(m.modules[0].part,'M471A1K43DB1-CWE');assert.equal(m.modules[0].formFactor,'SO-DIMM');
  assert(m.notes.some(n=>/kênh đôi/.test(n.text)));
});
test('memory: single channel with an empty slot, slower than rated, reserved memory, soldered',()=>{
  const m=memoryInfo(ram([dimm('DIMM A','BANK 0',{ConfiguredMTs:2666}),{Slot:'DIMM B',Bank:'BANK 2',SizeMiB:0,Installed:'No'}],undefined,{VisibleBytes:5*1073741824}));
  assert.equal(m.channel,'single');assert.equal(m.empty,1);assert.equal(m.upgradeable,true);assert.equal(m.runningMTs,2666);
  assert(m.notes.some(n=>n.state==='warn' && /kênh đơn/i.test(n.text)));assert(m.notes.some(n=>/2666.*3200/.test(n.text)));
  assert(m.notes.some(n=>n.state==='warn' && /dùng được 5\.0 GiB/.test(n.text)));
  const soldered=memoryInfo(ram([dimm('Onboard','BANK 0',{FormFactor:0x0B}),dimm('Onboard','BANK 1',{FormFactor:0x0B})]));
  assert.equal(soldered.socketed,0);assert.equal(soldered.upgradeable,false);assert(soldered.notes.some(n=>/hàn chết/.test(n.text)));
  assert.equal(memoryInfo({sections:{}}).available,false);
  assert.equal(memoryInfo(ram([dimm('X','',{})])).channel,null,'nhãn khe không nói kênh thì để chưa rõ');
});

test('license expiry: permanent, KMS 180 days, grace, evaluation, none',()=>{
  const now=Date.parse('2026-11-18T00:00:00Z');
  assert.equal(licenseExpiry({LicenseStatus:1,Channel:'Retail',GraceMinutes:0},now).permanent,true);
  assert.equal(licenseExpiry({LicenseStatus:1,Channel:'OEM:DM'},now).label,'Vĩnh viễn (không hết hạn)');
  const kms=licenseExpiry({LicenseStatus:1,Channel:'Volume:GVLK',GraceMinutes:164374},now);
  assert.equal(kms.permanent,false);assert.equal(kms.days,115);assert.match(kms.label,/còn 115 ngày.*KMS tự gia hạn/);
  const grace=licenseExpiry({LicenseStatus:5,Channel:'Retail',GraceMinutes:1440*3},now);assert.match(grace.label,/^Hết ân hạn .*còn 3 ngày/);
  assert.equal(licenseExpiry({LicenseStatus:5,GraceMinutes:0},now).label,'Đã hết hạn');
  const ev=licenseExpiry({LicenseStatus:1,Channel:'Retail',EvaluationEndDate:'2026-12-18T00:00:00Z'},now);assert.equal(ev.days,30);assert.match(ev.label,/bản dùng thử/);
  assert.match(licenseExpiry({LicenseStatus:1,EvaluationEndDate:'2026-01-01T00:00:00Z'},now).label,/đã hết hạn/);
  assert.equal(licenseExpiry({LicenseStatus:0},now).label,'Chưa có bản quyền');assert.equal(licenseExpiry(null),null);
});
test('memory vendor falls back to the part number when the BIOS has no maker',()=>{
  assert.equal(memoryVendor('Unknown','TEAMGROUP-UD4-3200'),'TeamGroup');assert.equal(memoryVendor('','CMK16GX4M2B3200C16'),'Corsair');
  assert.equal(memoryVendor('Unknown','F4-3200C16-8GVKB'),'G.Skill');assert.equal(memoryVendor('Unknown','XYZ'),null);
});

test('stability: blue screens (Kernel-Power code or WER), power loss, power button, WHEA',()=>{
  const st=stabilityInfo({sections:{stability:{status:'ok',data:[{SystemLogStart:'2026-08-01T00:00:00Z',
    Crashes:[{Time:'2026-11-12T08:45:00Z',Bugcheck:null,PowerButton:false},{Time:'2026-11-02T08:30:00Z',Bugcheck:'0x9F',PowerButton:false},{Time:'2026-10-05T09:41:00Z',Bugcheck:null,PowerButton:true}],
    BlueScreens:[{Time:'2026-11-02T08:31:00Z',Code:'0x0000009f'},{Time:'2026-09-01T10:00:00Z',Code:'0x000000d1'}],Whea:[{Time:'2026-09-02T00:00:00Z',Id:19,Level:'Warning'}]}]}}});
  assert.equal(st.total,4);assert.equal(st.blueScreens,2,'WER trùng thời điểm với Kernel-Power không đếm hai lần');
  assert.equal(st.powerLoss,1);assert.equal(st.powerButton,1);assert.equal(st.hardwareErrors,1);
  assert.deepEqual(st.events.map(e=>e.kind),['power','bsod','button','bsod']);assert.equal(st.events[3].code,'0x000000d1');
  assert.equal(stabilityInfo({sections:{}}).available,false);
  assert(assess({sections:{stability:{status:'ok',data:[{Crashes:[{Time:'2026-11-02T08:30:00Z',Bugcheck:'0x9F'}],BlueScreens:[],Whea:[]}]}}}).some(c=>/1 lần màn hình xanh/.test(c.title)));
});
test('first use: setup log and first profile give the setup date; disk hours give a bound',()=>{
  const now=Date.parse('2026-11-18T00:00:00Z');
  const f=firstUseInfo({diskDetails:[{counters:{powerOnHours:2400}}],sections:{firstUse:{status:'ok',data:[{SetupLogStart:'2025-12-30T18:00:16Z',FirstProfile:'2025-12-30T18:02:04Z',FirstProfileName:'an',OriginalInstall:null,CurrentInstall:'2025-03-18T01:19:24Z'}]}}},now);
  assert.equal(new Date(f.firstSetup).toISOString(),'2025-12-30T18:00:16.000Z');
  assert.deepEqual(f.marks.map(m=>m.key),['install','setup','profile','disk']);assert.equal(f.marks.find(m=>m.key==='disk').bound,true);
  assert.equal(firstUseInfo({sections:{}}).firstSetup,null);
});

test('Windows Memory Diagnostic results: newest first, judged by message then id',()=>{
  const r=rows=>memoryDiagnosticInfo({sections:{memoryDiag:{status:'ok',data:rows}}});
  const ok=r([{Time:'2026-10-01T00:00:00Z',Id:1201,Message:"The Windows Memory Diagnostic tested the computer's memory and detected no errors"},{Time:'2026-11-01T00:00:00Z',Id:1202,Message:'The Windows Memory Diagnostic tested the computer\'s memory and detected hardware errors.'}]);
  assert.equal(ok.last.verdict,'bad');assert.equal(ok.history[1].verdict,'ok');
  assert.equal(r([{Time:'2026-11-01T00:00:00Z',Id:1101,Message:''}]).last.verdict,'ok');
  assert.equal(r([]).available,false);
  assert(assess({sections:{memoryDiag:{status:'ok',data:[{Time:'2026-11-01T00:00:00Z',Id:1202,Message:'detected hardware errors'}]}}}).some(c=>c.title==='Windows Memory Diagnostic phát hiện lỗi RAM'));
});

test('disk speed verdict: graded by drive type, sustained-write drop, cached read and unknown drives',()=>{
  const nvme={protocol:'nvme',bus:'NVMe',isSSD:true},sata={protocol:'ata',bus:'SATA',isSSD:true,rotation:'SSD'},hdd={protocol:'ata',bus:'SATA',media:'HDD',rotation:'5400 rpm'};
  const m=(w,r,min,max,extra={})=>({sizeMiB:16384,writeMBps:w,readMBps:r,minWriteMBps:min,maxWriteMBps:max,...extra});
  const good=diskSpeedVerdict(m(1426,4582,963,1592),nvme);
  assert.equal(good.status,'good');assert.equal(good.label,'Tốt');assert.match(good.points[0].text,/SHA-256.{1,2}trên 16 GiB/);assert.match(good.expected,/SSD NVMe/);
  const qlc=diskSpeedVerdict(m(900,3000,120,2000),nvme);assert.equal(qlc.status,'caution');assert(qlc.points.some(p=>/bộ đệm nhanh của ổ đã đầy/.test(p.text)));
  assert.equal(diskSpeedVerdict(m(120,150,100,140),nvme).status,'bad');
  assert.equal(diskSpeedVerdict(m(480,520,430,500),sata).status,'good');
  assert.equal(diskSpeedVerdict(m(200,260,180,220),sata).status,'caution');
  assert.equal(diskSpeedVerdict(m(110,120,95,130),hdd).status,'good');
  assert.equal(diskSpeedVerdict(m(30,35,15,40),hdd).status,'bad');
  const cached=diskSpeedVerdict(m(1426,11567,963,1592,{readCached:true}),nvme);assert.equal(cached.status,'good');assert(cached.points.some(p=>/bộ đệm RAM/.test(p.text)));
  assert.equal(diskSpeedVerdict(m(30,30,20,40),{bus:'USB'}).status,'unknown');
  assert.equal(diskSpeedVerdict(null,nvme),null);
});

test('keyboard guess: desktop chassis, laptop panel size, external-only and unknown',()=>{
  const r=(chassis,displays)=>({sections:{smbiosChassis:{status:'ok',data:chassis==null?[]:[{ChassisType:chassis}]},displays:{status:'ok',data:displays}}});
  assert.equal(keyboardGuess(r(3,[{WidthCm:53,HeightCm:29,Internal:false}])).layout,'full');
  const big=keyboardGuess(r(10,[{WidthCm:34,HeightCm:19,Internal:true}]));assert.equal(big.layout,'full');assert.equal(big.panelInches,15.3);
  const small=keyboardGuess(r(10,[{WidthCm:31,HeightCm:17,Internal:true},{WidthCm:53,HeightCm:29,Internal:false}]));assert.equal(small.layout,'compact');assert.equal(small.panelInches,13.9);
  assert.equal(keyboardGuess(r(null,[{WidthCm:53,HeightCm:29,Internal:false}])).layout,'full');
  assert.equal(keyboardGuess({sections:{}}).layout,'compact');
});

test('keyboard devices: external warning on laptops, names, hints, desktop with several devices',()=>{
  const laptop=keyboardDevices([{Kind:'builtin',Status:'OK'},{Kind:'bluetooth',Name:'Keychron K3 TKL',Status:'OK'}]);
  assert.equal(laptop.builtin,true);assert.equal(laptop.external,1);assert.match(laptop.warning,/ngắt bàn phím rời/);assert.equal(laptop.hint,'compact');
  assert.equal(laptop.devices[1].title,'Keychron K3 TKL');
  const alone=keyboardDevices([{Kind:'builtin',Status:'OK'}]);assert.equal(alone.warning,null);
  const desk=keyboardDevices([{Kind:'usb',VidPid:'05AC:024F',Status:'OK'},{Kind:'usb',Name:'USB Gaming Keyboard',VidPid:'1A2C:4184',Status:'OK'}]);
  assert.match(desk.warning,/2 thiết bị nhận là bàn phím/);assert.equal(desk.devices[0].title,'Bàn phím USB 05AC:024F');assert.equal(desk.hint,null);
  assert.equal(keyboardDevices([{Kind:'usb',Name:'Numpad Full Size',Status:'Error'}]).devices[0].ok,false);
  const r=(kb)=>({sections:{smbiosChassis:{status:'ok',data:[{ChassisType:3}]},keyboards:{status:'ok',data:kb}}});
  assert.equal(keyboardGuess(r([{Kind:'usb',Name:'Mini 60% board'}])).layout,'compact');assert.equal(keyboardGuess(r([{Kind:'usb',Name:'Any'}])).layout,'full');
});
