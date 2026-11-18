const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DellClient,normalize,validateTag,TOKEN_URL,WARRANTY_URL}=require('../src/dell-api.cjs');
const {mediaError}=require('../src/media-errors.cjs');
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
test('Service Tag is normalized and rejects URL / query injection',()=>{assert.equal(validateTag(' abc1234 '),'ABC1234');for(const tag of ['', '../x','ABC&foo=1','A'.repeat(13)])assert.throws(()=>validateTag(tag));});
test('missing API credentials fail before any network request',async()=>{let calls=0;const client=new DellClient(async()=>{calls++;});await assert.rejects(()=>client.lookup('ABC1234'),/Client ID/);assert.equal(calls,0);});
test('OAuth credentials are in POST body only; token cached; lookup encoded on fixed Dell URL',async()=>{
  const calls=[];const client=new DellClient(async(url,options)=>{calls.push({url,options});return url===TOKEN_URL?response({access_token:'test-token',expires_in:3600}):response([{serviceTag:'ABC1234',systemDescription:'Latitude 5420',entitlements:[]}]);});
  client.configure('test-client','secret+&=test');const result=await client.lookup('abc1234');await client.lookup('ABC1234');assert.equal(calls.length,3);assert.equal(result.asset.Model,'Latitude 5420');assert(!calls[0].url.includes('secret'));assert.equal(new URLSearchParams(calls[0].options.body).get('client_secret'),'secret+&=test');assert.equal(calls[1].url,WARRANTY_URL+'?servicetags=ABC1234');assert.equal(calls[1].options.headers.Authorization,'Bearer test-token');assert.equal(calls[1].options.redirect,'error');
});
test('invalid / mismatched tags do not produce a warranty verdict',()=>{assert.throws(()=>normalize([{serviceTag:'ABC1234',invalid:true}],'ABC1234'));assert.throws(()=>normalize([{serviceTag:'OTHER12'}],'ABC1234'));});
test('warranty entries preserve dates and missing dates stay unknown',()=>{
  const r=normalize([{serviceTag:'ABC1234',entitlements:[{startDate:'2020-01-01',endDate:'2021-01-01'},{startDate:'2020-01-01',endDate:'2030-01-01'},{}]}],'ABC1234','2026-11-18T00:00:00Z');assert.equal(r.entitlements[0].Status,'Đã hết khoảng ngày dịch vụ');assert.equal(r.entitlements[1].Status,'Trong khoảng ngày dịch vụ');assert.equal(r.entitlements[2].Status,'Chưa xác định');
});
test('API HTTP errors do not leak response bodies or credentials',async()=>{const client=new DellClient(async()=>response({echo:'sensitive-token-secret'},401));client.configure('id','secret');await assert.rejects(()=>client.lookup('ABC1234'),error=>error.message.includes('xác thực') && !error.message.includes('sensitive-token'));});
test('clearing credentials during token request prevents restoring token',async()=>{
  let release;const client=new DellClient(()=>new Promise(resolve=>release=resolve));client.configure('id','secret');const pending=client.lookup('ABC1234');client.clear();release(response({access_token:'stale-token'}));await assert.rejects(()=>pending,/đã bị thay đổi/);assert.equal(client.configured,false);assert.equal(client.token,null);
});
test('camera error messages distinguish missing, permission and busy devices',()=>{assert(mediaError({name:'NotFoundError'},'camera').includes('chưa cung cấp'));assert(mediaError({name:'NotAllowedError'},'camera').includes('bị từ chối'));assert(mediaError({name:'NotReadableError'},'camera').includes('Teams'));});
