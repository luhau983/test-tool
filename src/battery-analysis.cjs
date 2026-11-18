function summarizeBattery(test,now=Date.now()){
  if(!test)return null;
  const valid=test.samples.filter(s=>typeof s.percent==='number' && s.percent>=0 && s.percent<=100);
  const first=valid[0],last=valid[valid.length-1];
  return {state:test.state,reason:test.reason || '',startedAt:test.startedAt,endedAt:test.endedAt || null,targetMinutes:test.minutes,elapsedSeconds:Math.max(0,Math.round(((test.endedAt?Date.parse(test.endedAt):now)-Date.parse(test.startedAt))/1000)),samples:test.samples.length,startPercent:first?.percent ?? null,endPercent:last?.percent ?? null,dropPercentagePoints:first && last?first.percent-last.percent:null,scope:'Mức pin tổng hệ thống do Windows báo; phụ thuộc độ sáng, tải, Wi-Fi, nhiệt độ và độ phân giải % của firmware. Không suy ra thời lượng tuyệt đối hay kết luận pin tốt từ bài thử ngắn.'};
}
module.exports={summarizeBattery};
