const {test}=require('node:test');
const assert=require('node:assert/strict');
const {batteryHealth,assess,number}=require('../src/assessment.cjs');
const {parseSMBIOS,enrichFirmware}=require('../src/smbios.cjs');
const {makeReport}=require('../src/report.cjs');
const {Worker}=require('node:worker_threads');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
test('missing battery values are unknown, never zero wear',()=>{
  for(const b of [{},{DesignCapacity:0,FullChargeCapacity:100},{DesignCapacity:100,FullChargeCapacity:0},{DesignCapacity:'-',FullChargeCapacity:80}])assert.equal(batteryHealth(b).state,'unknown');
  assert.equal(number(null),null);assert.equal(number(''),null);assert.equal(number(0),0);
});
test('battery ratio, wear threshold, calibration excess',()=>{
  assert.equal(batteryHealth({DesignCapacity:50000,FullChargeCapacity:40000}).remaining,80);
  assert.equal(batteryHealth({DesignCapacity:50000,FullChargeCapacity:30000}).state,'warn');
  assert.equal(batteryHealth({DesignCapacity:100,FullChargeCapacity:120}).state,'unknown');
});
test('device error codes produce warnings',()=>{
  const r={sections:{devices:{status:'ok',data:[{Name:'Camera',ConfigManagerErrorCode:28}]}}};
  assert(assess(r).some(c=>c.title==='Thiết bị: Camera' && c.state==='warn'));
});
function raw(structs){const payload=Buffer.concat(structs),head=Buffer.from([0,3,5,0,0,0,0,0]);head.writeUInt32LE(payload.length,4);return Buffer.concat([head,payload]);}
function structure(type,length,strings,fill){const b=Buffer.alloc(length);b[0]=type;b[1]=length;fill?.(b);return Buffer.concat([b,Buffer.from(strings.length?strings.join('\0')+'\0\0':'\0\0')]);}
test('SMBIOS parses firmware strings and retains unknown structure',()=>{
  const b=raw([structure(1,27,['Dell Inc.','Latitude 5420','ABC1234'],b=>{b[4]=1;b[5]=2;b[7]=3;}),structure(250,4,['OEM data']),structure(127,4,[])]);
  const result=parseSMBIOS(b);assert.equal(result.groups.smbiosSystem[0].Product,'Latitude 5420');assert.equal(result.groups.smbiosSystem[0].SerialNumber,'ABC1234');assert.equal(result.structures[1].Type,250);assert.equal(result.structures[1].Strings,'OEM data');
});
test('SMBIOS memory differentiates empty slots, unknown and extended sizes',()=>{
  const b=raw([structure(17,34,['DIMM A'],b=>{b[16]=1;b.writeUInt16LE(0,12);}),structure(17,34,[],b=>{b.writeUInt16LE(0xffff,12);}),structure(17,34,[],b=>{b.writeUInt16LE(0x7fff,12);b.writeUInt32LE(32768,28);})]);
  const rows=parseSMBIOS(b).groups.smbiosMemory;assert.equal(rows[0].Installed,'No');assert.equal(rows[0].SizeMiB,0);assert.equal(rows[1].SizeMiB,null);assert.equal(rows[2].SizeMiB,32768);
});
test('SMBIOS rejects truncated wrapper, invalid lengths and unterminated strings',()=>{
  assert.throws(()=>parseSMBIOS(Buffer.alloc(2)));
  const a=raw([structure(1,4,[])]);a.writeUInt32LE(999,4);assert.throws(()=>parseSMBIOS(a));
  const b=raw([Buffer.from([1,0,0,0,0,0])]);assert.throws(()=>parseSMBIOS(b));
  const c=raw([Buffer.from([1,4,0,0,65])]);assert.throws(()=>parseSMBIOS(c));
});
test('firmware parse failures retain raw bytes and expose unknown status',()=>{
  const r={sections:{firmwareRaw:{status:'ok',data:[{Base64:'AA=='}]}}};enrichFirmware(r);assert.equal(r.sections.firmwareInfo.status,'unknown');assert.equal(r.sections.firmwareRaw.data[0].Base64,'AA==');
});
test('HTML report escapes device, manual, notes and error content',()=>{
  const html=makeReport({sections:{system:{status:'ok',data:[{Model:'<script>bad()</script>'}]}}},[{title:'<img src=x>',status:'Chưa thử',note:'<b>oops</b>'}],[],'<script>alert(1)</script>');
  assert(!html.includes('<script>'));assert(html.includes('&lt;script&gt;'));assert(html.includes('Chưa thử'));assert(html.includes('Không phải chứng nhận'));
});
function worker(kind,tempDir){return new Promise((resolve,reject)=>{const w=new Worker(path.join(__dirname,'../src/diagnostic-worker.cjs'),{workerData:{kind,tempDir}});w.on('message',m=>{if(m.type==='result')resolve(m);});w.on('error',reject);});}
test('RAM diagnostic verifies its allocated memory',async()=>{const r=await worker('memory');assert.equal(r.state,'completed');assert(r.detail.includes('64 MiB'));});
test('disk diagnostic verifies real bytes and preserves existing files',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dell-inspect-unit-'));
  try{await fs.writeFile(path.join(dir,'existing.txt'),'do not touch');const r=await worker('disk',dir);assert.equal(r.state,'completed');assert.equal(await fs.readFile(path.join(dir,'existing.txt'),'utf8'),'do not touch');assert.equal((await fs.stat(path.join(dir,'verify.bin'))).size,256*1024*1024);assert.match(r.detail,/Ghi \d+ MB\/s .* đọc lại \d+ MB\/s/);}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('disk diagnostic refuses to overwrite an existing verify file',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dell-inspect-unit-'));
  try{await fs.writeFile(path.join(dir,'verify.bin'),'original');const r=await worker('disk',dir);assert.equal(r.state,'error');assert.equal(await fs.readFile(path.join(dir,'verify.bin'),'utf8'),'original');}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('PowerShell scripts have UTF-8 BOM for Windows PowerShell 5.1',async()=>{for(const name of ['collect.ps1','smart.ps1']){const b=await fs.readFile(path.join(__dirname,'../src',name));assert.equal(b.subarray(0,3).toString('hex'),'efbbbf',name);}});
test('report identity comes from SMBIOS Type 1, not Windows CIM sections',()=>{
  const html=makeReport({sections:{smbiosSystem:{status:'ok',data:[{Product:'Latitude 7490',SerialNumber:'ABC1234'}]},system:{status:'ok',data:[{Model:'CIM model'}]},bios:{status:'ok',data:[{SerialNumber:'CIMTAG1'}]}}},[],[],'');
  assert(html.includes('Latitude 7490 · Service Tag: ABC1234'));assert(!html.includes('Service Tag: CIMTAG1'));
});
