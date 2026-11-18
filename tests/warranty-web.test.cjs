const {test}=require('node:test');const assert=require('node:assert/strict');
const {WarrantyWebClient,WEB_URL,requestBody,flatten}=require('../src/warranty-web.cjs');
const response=(body,status=200)=>new Response(JSON.stringify(body),{status});
test('web lookup uses supplied endpoint/body without API credentials or copied cookies',async()=>{
  let request;const client=new WarrantyWebClient(async(url,options)=>{request={url,options};return response({Success:true,ProductName:'Model sample',RedirectUrl:'/support/home'});});
  const result=await client.lookup('abc1234');assert.equal(request.url,WEB_URL);assert.deepEqual(JSON.parse(request.options.body),requestBody('ABC1234'));assert.equal(request.options.headers.Cookie,undefined);assert.equal(request.options.headers.Authorization,undefined);assert.equal(request.options.credentials,'include');assert.equal(result.serial,'ABC1234');assert(result.fields.some(r=>r.Field==='ProductName' && r.Value==='Model sample'));
});
test('HTTP 403 is a blocked request, never an invalid-tag or warranty verdict',async()=>{const client=new WarrantyWebClient(async()=>response({},403));await assert.rejects(()=>client.lookup('ABC1234'),e=>e.message.includes('403 Access Denied') && e.message.includes('không kết luận số serial sai'));});
test('web response remains neutral for valid JSON with unknown/error schema',async()=>{const client=new WarrantyWebClient(async()=>response({IsValid:false,Error:'Not found'}));const result=await client.lookup('ABC1234');assert(result.fields.some(f=>f.Field==='IsValid' && f.Value===false));assert.equal(result.asset,undefined);assert.equal(result.entitlements,undefined);});
test('web rejects HTML success pages instead of treating them as API JSON',async()=>{const client=new WarrantyWebClient(async()=>new Response('<html>Access Denied</html>'));await assert.rejects(()=>client.lookup('ABC1234'),/chưa trả JSON/);});
test('web result flattening removes session secrets and bounds nested fields',()=>{const fields=flatten({model:'Model',nested:{csrfToken:'never export',Cookie:'never export',details:{cpu:'test'}}});assert.equal(fields.length,2);assert(!JSON.stringify(fields).includes('never export'));});
