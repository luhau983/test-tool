const {test}=require('node:test');const assert=require('node:assert/strict');
const {buildSessions,dailyHours,summarize,activationAge,enrichUsage,kindOf}=require('../src/usage-history.cjs');

const H=3600000;
const t0=Date.parse('2026-11-10T08:00:00Z');
const ev=(offsetHours,provider,id)=>({Time:new Date(t0+offsetHours*H).toISOString(),Provider:`Microsoft-Windows-${provider}`,Id:id});
const boot=h=>ev(h,'Kernel-General',12),shutdown=h=>ev(h,'Kernel-General',13);

test('event kinds map from provider + id; unknown events are ignored',()=>{
  assert.equal(kindOf(boot(0)),'boot');assert.equal(kindOf(shutdown(0)),'shutdown');
  assert.equal(kindOf(ev(0,'Kernel-Power',41)),'crash');assert.equal(kindOf(ev(0,'Kernel-Power',506)),'sleep');
  assert.equal(kindOf(ev(0,'Kernel-Power',507)),'wake');assert.equal(kindOf(ev(0,'Power-Troubleshooter',1)),'wake');
  assert.equal(kindOf(ev(0,'Kernel-General',1)),null);assert.equal(kindOf({LogStartsAt:'x'}),null);
});
test('sessions: boot → shutdown, restart, sleep/wake, crash and the running session',()=>{
  const now=t0+40*H;
  const s=buildSessions([
    shutdown(2),boot(0),                      // unordered input is sorted
    boot(2.02),ev(5,'Kernel-Power',42),       // restart within 3 min, then sleep
    ev(7,'Kernel-Power',107),shutdown(8),     // wake, shutdown
    boot(20),                                 // no shutdown before the next boot: crash
    boot(30),ev(31,'Kernel-Power',41),        // explicit crash event
    boot(39),{LogStartsAt:'2026-11-01T00:00:00Z'}
  ],now);
  assert.deepEqual(s.map(x=>[x.startKind,x.endKind]),[['boot','shutdown'],['restart','sleep'],['wake','shutdown'],['boot','crash'],['boot','crash'],['boot','running']]);
  assert.equal(s[0].durationMs,2*H);assert.equal(s[1].startLabel,'Khởi động lại');assert.equal(s[1].endLabel,'Ngủ / màn hình tắt');
  assert.equal(s[3].durationMs,null);assert.equal(s[3].end,null);assert.equal(s[3].endLabel,'Mất điện / treo');
  assert.equal(s[5].durationMs,1*H);assert.equal(s[5].endLabel,'Đang chạy');
  assert.deepEqual(buildSessions(null),[]);
});
test('daily hours split sessions across local midnight and keep the last 30 days',()=>{
  const local=new Date(2026,10,10,22,0,0).getTime();// 22:00 local
  const sessions=[{start:new Date(local).toISOString(),durationMs:4*H},{start:new Date(local).toISOString(),durationMs:null}];
  const days=dailyHours(sessions,new Date(2026,10,12,12).getTime(),30);
  assert.equal(days.length,30);
  assert.equal(days[27].hours,2);assert.equal(days[28].hours,2);assert.equal(days[29].hours,0);
  assert.equal(dailyHours([{start:new Date(2025,0,1).toISOString(),durationMs:H}],Date.now(),30).every(d=>d.hours===0),true,'ngoài 30 ngày không tính');
});
test('summary counts boots, wakes, crashes, total and average hours',()=>{
  const now=t0+10*24*H;
  const s=buildSessions([boot(0),shutdown(5),boot(24),ev(26,'Kernel-Power',506),ev(27,'Kernel-Power',507),shutdown(30),boot(48)],t0+50*H);
  const sum=summarize(s,new Date(t0).toISOString(),now);
  assert.equal(sum.sessions,4);assert.equal(sum.boots,3);assert.equal(sum.unexpected,0);
  assert.equal(sum.totalHours,5+2+3+2);assert.equal(sum.longestHours,5);assert.equal(sum.spanDays,10);assert.equal(sum.hoursPerDay,1.2);
  assert.equal(summarize([],null,now).hoursPerDay,null);
});
test('activation age: lower bound, exact window, and nothing found',()=>{
  const now=Date.parse('2026-11-18T00:00:00Z');
  const lower=activationAge({FirstActivatedSeen:'2026-08-25T00:00:00Z',LastNotActivatedBefore:null,LogStartsAt:'2026-08-24T00:00:00Z'},now);
  assert.equal(lower.known,true);assert.equal(lower.exact,false);assert.equal(lower.days,85);assert.match(lower.label,/ít nhất từ/);assert.match(lower.note,/Nhật ký chỉ còn từ/);
  const exact=activationAge({FirstActivatedSeen:'2026-09-02T00:00:00Z',LastNotActivatedBefore:'2026-09-01T00:00:00Z'},now);
  assert.equal(exact.exact,true);assert.match(exact.label,/trong khoảng/);
  assert.equal(activationAge({FirstActivatedSeen:null},now).known,false);assert.equal(activationAge(null),null);
});
test('enrichUsage adds report.usage and a flat sessions table; a failed log stays unavailable',()=>{
  const report={sections:{powerEvents:{status:'ok',data:[{LogStartsAt:new Date(t0).toISOString()},boot(0),shutdown(3)],error:null},activationHistory:{status:'ok',data:[{FirstActivatedSeen:new Date(t0).toISOString()}]}}};
  enrichUsage(report,t0+24*H);
  assert.equal(report.usage.available,true);assert.equal(report.usage.sessions.length,1);assert.equal(report.usage.summary.totalHours,3);
  assert.equal(report.usage.activation.known,true);assert.equal(report.usage.daily.length,30);
  assert.equal(report.sections.usageSessions.data[0]['Thời lượng'],'3 giờ 0 phút');assert.equal(report.sections.usageSessions.data[0]['Kết thúc bằng'],'Tắt máy');
  const failed={sections:{powerEvents:{status:'unknown',data:[],error:'Access denied'}}};enrichUsage(failed);
  assert.equal(failed.usage.available,false);assert.equal(failed.usage.error,'Access denied');assert.equal(failed.sections.usageSessions,undefined);
});
