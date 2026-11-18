const {test}=require('node:test');const assert=require('node:assert/strict');const {summarizeBattery}=require('../src/battery-analysis.cjs');
test('battery test reports measured percentage points, not predicted runtime',()=>{
  const result=summarizeBattery({state:'completed',startedAt:'2026-11-18T00:00:00Z',endedAt:'2026-11-18T00:10:00Z',minutes:10,samples:[{percent:90},{percent:87}]});
  assert.equal(result.elapsedSeconds,600);assert.equal(result.dropPercentagePoints,3);assert.equal(result.endPercent,87);assert.equal(result.estimatedRuntime,undefined);
});
test('unknown / absent battery percentages do not become zero',()=>{
  const result=summarizeBattery({state:'interrupted',startedAt:'2026-11-18T00:00:00Z',endedAt:'2026-11-18T00:00:30Z',minutes:2,samples:[{percent:null},{percent:255}]});
  assert.equal(result.startPercent,null);assert.equal(result.dropPercentagePoints,null);
});
test('unchanged percentage is retained without a healthy verdict',()=>{
  const result=summarizeBattery({state:'stopped',startedAt:'2026-11-18T00:00:00Z',endedAt:'2026-11-18T00:00:30Z',minutes:10,samples:[{percent:80},{percent:80}]});
  assert.equal(result.dropPercentagePoints,0);assert.equal(result.state,'stopped');assert.equal(result.health,undefined);
});
