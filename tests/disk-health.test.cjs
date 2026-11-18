const {test}=require('node:test');const assert=require('node:assert/strict');
const {decodeDisk,decodeDisks,enrichDisks,lifeEstimate,temperatureStatus,HOURS_PER_DAY}=require('../src/disk-health.cjs');
const {assess,usageInfo}=require('../src/assessment.cjs');

// ---- Synthetic driver buffers (layouts per NVMe 1.4 / ACS-4) ----
const b64=buf=>buf.toString('base64');
function nvmeIdentify({wctemp=343}={}){
  const b=Buffer.alloc(4096);
  b.write('SN-NVME-1'.padEnd(20),4,'latin1');b.write('Test NVMe 1TB'.padEnd(40),24,'latin1');b.write('FW1.0'.padEnd(8),64,'latin1');
  b.writeUInt32LE(0x00010400,80);b.writeUInt16LE(wctemp,266);b.writeUInt16LE(353,268);b.writeBigUInt64LE(1000204886016n,280);
  b.writeUInt16LE(4,520);b[525]=1;return b;
}
function nvmeHealth({cw=0,kelvin=313,spare=100,threshold=10,used=0,read=2000,written=1000,cycles=50,hours=1000,unsafe=3,media=0}={}){
  const b=Buffer.alloc(512);b[0]=cw;b.writeUInt16LE(kelvin,1);b[3]=spare;b[4]=threshold;b[5]=used;
  for(const [offset,value] of [[32,read],[48,written],[112,cycles],[128,hours],[144,unsafe],[160,media]])b.writeBigUInt64LE(BigInt(value),offset);
  return b;
}
const nvme=(health={},identify={})=>({Index:1,FriendlyName:'Test NVMe',BusType:'NVMe',MediaType:'SSD',Size:1000204886016,DriveLetters:'C:',HealthStatus:'Healthy',Protocol:'nvme',Identify:b64(nvmeIdentify(identify)),HealthLog:b64(nvmeHealth(health)),DevStats:{},Errors:[]});

function ataText(b,word,text,words){const t=text.padEnd(words*2);for(let i=0;i<words;i++){b[(word+i)*2]=t.charCodeAt(i*2+1);b[(word+i)*2+1]=t.charCodeAt(i*2);}}
function ataIdentify({rotation=1}={}){
  const b=Buffer.alloc(512),w=(n,v)=>b.writeUInt16LE(v,n*2);
  ataText(b,10,'SER-ATA-1',10);ataText(b,23,'FW2.0',4);ataText(b,27,'Test SATA SSD',20);
  w(76,0x010E);w(77,3<<1);w(78,0x100);w(80,1<<10);w(82,0x21);w(83,0x0400);w(169,1);w(217,rotation);w(222,0x1000|1<<7);
  b.writeBigUInt64LE(1000215216n,200);return b;
}
function devPage(page,stats){const b=Buffer.alloc(512);b[2]=page;for(const [offset,value] of Object.entries(stats)){b.writeUIntLE(value,Number(offset),6);b[Number(offset)+7]=0xC0;}return b64(b);}
function smartTable(rows,thresholds){
  const data=Buffer.alloc(512),limits=Buffer.alloc(512);
  rows.forEach(([id,current,worst,raw],i)=>{const o=2+i*12;data[o]=id;data[o+3]=current;data[o+4]=worst;data.writeUIntLE(raw,o+5,6);});
  thresholds.forEach(([id,limit],i)=>{const o=2+i*12;limits[o]=id;limits[o+1]=limit;});
  return {SmartData:b64(data),SmartThresholds:b64(limits)};
}
const ata=(extra={},identify={})=>({Index:0,FriendlyName:'Test SATA',BusType:'SATA',MediaType:'SSD',Size:512110190592,DriveLetters:'D:',HealthStatus:'Healthy',Protocol:'ata',Identify:b64(ataIdentify(identify)),DevStats:{},Errors:[],...extra});

test('NVMe: identify + health log decode into a good drive with counters and life',()=>{
  const d=decodeDisk(nvme({used:4,hours:2000,written:40000}));
  assert.equal(d.model,'Test NVMe 1TB');assert.equal(d.serial,'SN-NVME-1');assert.equal(d.firmware,'FW1.0');assert.equal(d.standard,'NVM Express 1.4');
  assert.deepEqual(d.features,['S.M.A.R.T.','TRIM','VolatileWriteCache']);assert.equal(d.capacity,1000204886016);
  assert.equal(d.health.status,'good');assert.equal(d.health.label,'Tốt');assert.equal(d.health.percent,96);
  assert.equal(d.temperature.celsius,40);assert.equal(d.temperature.warn,70);assert.equal(d.temperature.status,'good');
  assert.equal(d.counters.writtenBytes,40000*512000);assert.equal(d.counters.readBytes,2000*512000);assert.equal(d.counters.powerOnHours,2000);assert.equal(d.counters.unsafeShutdowns,3);
  assert.equal(d.attributes.length,15);assert.equal(d.attributes[0].name,'Critical Warning');assert.equal(d.attributes[4].rawValue,4);
  assert.equal(d.life.remainingHours,2000*96/4);assert.equal(d.attributeKind,'nvme');
});
test('NVMe: critical warning bits, low spare, media errors and wear grade the drive',()=>{
  const bad=decodeDisk(nvme({cw:1}));assert.equal(bad.health.status,'bad');assert.match(bad.health.reasons[0],/dự phòng/);
  assert.equal(bad.attributes[0].status,'bad');
  assert.equal(decodeDisk(nvme({cw:8})).health.status,'bad');
  assert.equal(decodeDisk(nvme({spare:5,threshold:10})).health.status,'bad');
  const media=decodeDisk(nvme({media:2}));assert.equal(media.health.status,'caution');assert.equal(media.health.label,'Cẩn thận');assert.equal(media.attributes[13].status,'caution');
  assert.equal(decodeDisk(nvme({used:95})).health.status,'caution');
  assert.equal(decodeDisk(nvme({used:120})).health.percent,0);
  const hot=decodeDisk(nvme({kelvin:273+75,cw:2}));assert.equal(hot.temperature.status,'bad');assert.equal(hot.health.status,'caution');
  assert.equal(decodeDisk(nvme({kelvin:273+50},{wctemp:0})).temperature.warn,70,'không có WCTEMP thì dùng 70 °C');
});
test('ATA: identify strings are byte-swapped and interface/features are decoded',()=>{
  const d=decodeDisk(ata());
  assert.equal(d.model,'Test SATA SSD');assert.equal(d.serial,'SER-ATA-1');assert.equal(d.firmware,'FW2.0');
  assert.equal(d.transferMode,'SATA/600 | SATA/600');assert.equal(d.standard,'ACS-3 | SATA 3.2');assert.equal(d.rotation,'SSD');
  assert.deepEqual(d.features,['S.M.A.R.T.','48bit LBA','NCQ','TRIM','DevSleep','Write Cache']);assert.equal(d.capacity,1000215216*512);
  assert.equal(d.health.status,'unknown','không có Device Statistics / SMART thì chưa kết luận');
});
test('ATA: Device Statistics give hours, cycles, bytes, temperature and wear without admin',()=>{
  const d=decodeDisk(ata({NeedsAdmin:true,DevStats:{1:devPage(1,{8:530,16:1472,24:6293783,40:5129072}),4:devPage(4,{8:0}),5:devPage(5,{8:33,0x58:70}),6:devPage(6,{24:0}),7:devPage(7,{8:12})}}));
  assert.equal(d.counters.powerOnHours,1472);assert.equal(d.counters.powerCycles,530);assert.equal(d.counters.writtenBytes,6293783*512);assert.equal(d.counters.readBytes,5129072*512);
  assert.equal(d.temperature.celsius,33);assert.equal(d.temperature.warn,70);assert.equal(d.health.status,'good');assert.equal(d.health.percent,88);
  assert.equal(d.needsAdmin,true);assert.equal(d.attributes.length,0);assert.equal(d.life.percentUsed,12);
  const unsupported=decodeDisk(ata({DevStats:{1:b64(Buffer.alloc(512))}}));assert.equal(unsupported.counters.powerOnHours,null,'bit hỗ trợ = 0 thì không đọc thành 0');
  assert.equal(decodeDisk(ata({DevStats:{4:devPage(4,{8:3})}})).health.status,'caution');
});
test('ATA SMART table: below threshold is bad, remapped/pending sectors are caution',()=>{
  const ok=decodeDisk(ata(smartTable([[0x09,99,99,1200],[0x0C,99,99,40],[0xC2,67,50,33],[0xE7,95,95,0]],[[0x09,0],[0xE7,10]])));
  assert.equal(ok.health.status,'good');assert.equal(ok.health.percent,95,'SSD Life Left làm % sức khỏe');
  assert.equal(ok.counters.powerOnHours,1200);assert.equal(ok.counters.powerCycles,40);assert.equal(ok.temperature.celsius,33);
  assert.equal(ok.attributes.find(a=>a.id==='C2').name,'Temperature');assert.equal(ok.attributes[0].raw,'0000000004B0');
  const caution=decodeDisk(ata(smartTable([[0x05,100,100,8],[0xC5,100,100,0]],[[0x05,10]])));
  assert.equal(caution.health.status,'caution');assert.match(caution.health.reasons[0],/05 Reallocated/);
  const bad=decodeDisk(ata(smartTable([[0x05,5,5,900]],[[0x05,10]])));assert.equal(bad.health.status,'bad');assert.equal(bad.attributes[0].status,'bad');
  const hdd=decodeDisk(ata({...smartTable([[0xC2,40,40,45]],[]),MediaType:'HDD'},{rotation:7200}));
  assert.equal(hdd.rotation,'7200 RPM');assert.equal(hdd.isSSD,false);assert.equal(hdd.life,null);assert.equal(hdd.temperature.warn,55);
});
test('lifetime estimate is linear in power-on hours and refuses to guess from 0% wear',()=>{
  const l=lifeEstimate({percentUsed:10,powerOnHours:1000,writtenBytes:5e12});
  assert.equal(l.remainingHours,9000);assert.equal(l.years,9000/HOURS_PER_DAY/365);assert.equal(l.writtenPerHour,5e9);assert.equal(l.remainingPercent,90);
  assert.equal(lifeEstimate({percentUsed:0,powerOnHours:1000}).years,null);
  assert.equal(lifeEstimate({percentUsed:null,powerOnHours:1000}),null);
  assert.equal(lifeEstimate({percentUsed:130,powerOnHours:10}).remainingPercent,0);
});
test('temperature grading and Windows fallback when the drive reports nothing',()=>{
  assert.equal(temperatureStatus(null,60),'unknown');assert.equal(temperatureStatus(49,60),'good');assert.equal(temperatureStatus(50,60),'caution');assert.equal(temperatureStatus(60,60),'bad');
  assert.equal(decodeDisk({Index:2,FriendlyName:'USB',HealthStatus:'Unhealthy',Protocol:null,Errors:['x']}).health.status,'bad');
  assert.equal(decodeDisk({Index:2,FriendlyName:'USB',HealthStatus:'Warning',Protocol:null}).health.status,'caution');
  const broken=decodeDisks([null]);assert.equal(broken.length,1);assert.equal(broken[0].health.status,'unknown');assert.match(broken[0].errors[0],/Không giải mã được/);
});
test('enrichDisks adds details plus flat health / SMART tables; a failed read stays unknown',()=>{
  const report={sections:{smartRaw:{status:'ok',data:[nvme({used:3}),ata({NeedsAdmin:true})],error:null}}};
  enrichDisks(report);
  assert.equal(report.diskDetails.length,2);
  assert.equal(report.sections.diskHealth.data[0]['Sức khỏe'],'Tốt 97%');assert.equal(report.sections.diskHealth.data[0]['Ổ'],'Test NVMe 1TB (C:)');
  assert.match(report.sections.diskHealth.data[1]['Lý do'],/quyền Admin/);
  assert.equal(report.sections.diskSmart.data.length,15);assert.equal(report.sections.diskSmart.data[0].ID,'01');
  const failed={sections:{smartRaw:{status:'unknown',data:[],error:'Access denied'}}};enrichDisks(failed);
  assert.equal(failed.sections.diskHealth.status,'unknown');assert.equal(failed.sections.diskHealth.error,'Access denied');assert.equal(failed.diskDetails,undefined);
  const none={sections:{}};enrichDisks(none);assert.equal(none.sections.diskHealth,undefined);
});
test('findings and usage read the decoded drives',()=>{
  const report={sections:{smartRaw:{status:'ok',data:[nvme({media:1,hours:3400}),ata({NeedsAdmin:true})],error:null}}};enrichDisks(report);
  const checks=assess(report).filter(c=>c.title.startsWith('Ổ '));
  assert.equal(checks.length,2);
  assert.equal(checks[0].state,'warn');assert.match(checks[0].title,/Cẩn thận/);assert.match(checks[0].detail,/Media Errors/);
  assert.equal(checks[1].state,'unknown');assert.match(checks[1].detail,/quyền quản trị/);
  assert.equal(usageInfo(report).diskPowerOnHours,3400);
  assert(assess({sections:{}}).some(c=>c.title==='Chưa có dữ liệu sức khỏe ổ đĩa' && c.state==='unknown'));
});
