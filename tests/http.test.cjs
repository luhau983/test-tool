const {test}=require('node:test');const assert=require('node:assert/strict');
const {readLimitedJSON,isTimeout,MAX_BYTES}=require('../src/http.cjs');
test('bounded JSON reader parses normal bodies',async()=>{assert.deepEqual(await readLimitedJSON(new Response('{"a":1}'),'X','bad'),{a:1});});
test('bounded JSON reader rejects bodies over 2 MiB',async()=>{await assert.rejects(()=>readLimitedJSON(new Response('x'.repeat(MAX_BYTES+1)),'Trang hỗ trợ','bad'),/Trang hỗ trợ vượt giới hạn 2 MiB/);});
test('empty body and non-JSON use the caller message',async()=>{await assert.rejects(()=>readLimitedJSON(new Response(null,{status:200}),'X','not json'),/not json/);await assert.rejects(()=>readLimitedJSON(new Response('<html>'),'X','not json'),/not json/);});
test('timeout detection covers abort and timeout errors only',()=>{assert(isTimeout({name:'TimeoutError'}));assert(isTimeout({name:'AbortError'}));assert(!isTimeout(new TypeError('x')));assert(!isTimeout(null));});
