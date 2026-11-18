const {workerData,parentPort}=require('node:worker_threads');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const progress=(value,detail)=>parentPort.postMessage({type:'progress',value,detail});
try {
  let detail,metrics=null;
  if(workerData.kind==='cpu') {
    const start=performance.now();let iterations=0,value=0;
    while(performance.now()-start<15000) {
      for(let i=0;i<100000;i++) value+=Math.sqrt((i%997)+1);
      iterations++;
      if(iterations%30===0)progress(Math.min(100,(performance.now()-start)/150),`Đang tải 1 luồng · ${Math.floor((performance.now()-start)/1000)}/15 giây`);
    }
    if(!Number.isFinite(value)) throw Error('Tính toán trả giá trị bất thường');
    detail=`Hoàn thành tải 1 luồng 15 giây (${iterations} vòng). Chỉ xác nhận bài thử chạy xong, không xác nhận ổn định mọi lõi, GPU hay nhiệt độ. Không có cảm biến CPU đáng tin cậy trong ứng dụng.`;
  } else if(workerData.kind==='memory') {
    const buffer=Buffer.alloc(64*1024*1024);const patterns=[0,255,170,85];
    patterns.forEach((pattern,index)=>{
      buffer.fill(pattern);
      for(let i=0;i<buffer.length;i++)if(buffer[i]!==pattern)throw Error(`Dữ liệu RAM sai ở byte ${i}`);
      progress((index+1)*25,`Đã xác minh mẫu ${index+1}/4`);
    });
    detail='Đọc/ghi đúng 4 mẫu trên vùng nhớ 64 MiB của ứng dụng. Windows có thể dùng bộ nhớ ảo; đây không phải bài kiểm tra toàn bộ RAM. Chạy thêm chẩn đoán tích hợp của hãng (F12 lúc khởi động) hoặc Windows Memory Diagnostic.';
  } else if(workerData.kind==='memoryDeep') {
    // User-mode RAM test in the style of MemTest86's patterns, over `sizeMiB` of this process' memory (256 MiB chunks):
    // address-in-address, moving inversions 0/1 and checkerboard, walking bit, and a seeded random fill. Windows decides
    // which physical pages back the buffers and may page some out under pressure, so main limits the size to a share of
    // free RAM. Faults are reported as chunk + byte offset (physical addresses are not visible from user mode).
    const CHUNK_WORDS=64*1024*1024,sizeMiB=workerData.sizeMiB,chunks=[],errors=[];let errorCount=0;
    for(let mib=0;mib<sizeMiB;mib+=256)chunks.push(new Uint32Array(Math.min(256,sizeMiB-mib)*262144));
    const words=chunks.reduce((s,c)=>s+c.length,0),start=performance.now();
    const fail=(pass,c,i,expected,actual)=>{errorCount++;if(errors.length<50)errors.push({pass,chunk:c,offset:i*4,expected:(expected>>>0).toString(16).padStart(8,'0'),actual:(actual>>>0).toString(16).padStart(8,'0'),bits:((expected^actual)>>>0).toString(2).split('').filter(b=>b==='1').length});};
    const passes=[
      ['Địa chỉ trong ô nhớ',(a,c)=>{const base=c*CHUNK_WORDS;for(let i=0;i<a.length;i++)a[i]=(base+i)^0x5a5a5a5a;for(let i=0;i<a.length;i++){const e=((base+i)^0x5a5a5a5a)>>>0;if(a[i]!==e)fail(1,c,i,e,a[i]);}}],
      ['Đảo bit 0 / 1',(a,c)=>movingInversions(a,c,2,0x00000000)],
      ['Bàn cờ 1010 / 0101',(a,c)=>movingInversions(a,c,3,0xaaaaaaaa)],
      ['Bit chạy',(a,c)=>{for(const inv of [0,0xffffffff]){for(let i=0;i<a.length;i++)a[i]=((1<<(i&31))^inv)>>>0;for(let i=0;i<a.length;i++){const e=((1<<(i&31))^inv)>>>0;if(a[i]!==e)fail(4,c,i,e,a[i]);}}}],
      ['Ngẫu nhiên',(a,c)=>{let x=(0x9e3779b9^(c+1)*2654435761)>>>0||1;const seed=x;for(let i=0;i<a.length;i++){x^=x<<13;x^=x>>>17;x^=x<<5;a[i]=x;}x=seed;for(let i=0;i<a.length;i++){x^=x<<13;x^=x>>>17;x^=x<<5;if(a[i]!==(x>>>0))fail(5,c,i,x,a[i]);}}],
    ];
    function movingInversions(a,c,pass,p){
      const q=~p>>>0;a.fill(p);
      for(let i=0;i<a.length;i++){if(a[i]!==p)fail(pass,c,i,p,a[i]);a[i]=q;}
      for(let i=a.length-1;i>=0;i--){if(a[i]!==q)fail(pass,c,i,q,a[i]);a[i]=p;}
      for(let i=0;i<a.length;i++)if(a[i]!==p)fail(pass,c,i,p,a[i]);
    }
    const steps=passes.length*chunks.length;let step=0;
    passes.forEach(([name,run],p)=>chunks.forEach((a,c)=>{
      run(a,c);step++;
      progress(Math.round(step/steps*100),`Bài ${p+1}/${passes.length} · ${name} · ${Math.min(sizeMiB,(c+1)*256).toLocaleString('vi-VN')} / ${sizeMiB.toLocaleString('vi-VN')} MiB${errorCount?` · ${errorCount} lỗi`:''}`);
    }));
    const seconds=Math.round((performance.now()-start)/1000),label=sizeMiB>=1024?`${(sizeMiB/1024).toFixed(1)} GiB`:`${sizeMiB} MiB`;
    metrics={sizeMiB,passes:passes.length,seconds,errorCount,errors,MBps:Math.round(words*4*16/1e6/Math.max(1,seconds))};
    if(errorCount){
      throw Object.assign(Error(`Phát hiện ${errorCount.toLocaleString('vi-VN')} lỗi trên ${label} RAM (${passes.length} bài, ${seconds} giây). Lỗi đầu: bài ${errors[0].pass}, đoạn ${errors[0].chunk}, byte ${errors[0].offset} — cần ${errors[0].expected}, đọc được ${errors[0].actual} (${errors[0].bits} bit sai). RAM rất có thể hỏng: chạy Windows Memory Diagnostic hoặc chẩn đoán tích hợp của hãng (F12 lúc khởi động) để xác nhận, thử từng thanh.`),{metrics});
    }
    detail=`Không có lỗi trên ${label} RAM sau ${passes.length} bài (địa chỉ, đảo bit 0/1, bàn cờ, bit chạy, ngẫu nhiên) trong ${seconds} giây. Chỉ kiểm phần RAM Windows cấp cho app; muốn quét toàn bộ RAM, chạy Windows Memory Diagnostic.`;
  } else if(workerData.kind==='disk') {
    // Writes `sizeMiB` in 8 MiB chunks with write-through (libuv UV_FS_O_DSYNC → FILE_FLAG_WRITE_THROUGH), so each
    // write reaches the drive instead of the RAM cache. Write speed is sampled ~40 times across the file: on heavy
    // files an SSD's fast cache fills and the speed drops, which an average alone would hide. Then reads back and
    // compares SHA-256. Only write/read calls are timed; random data and hashing are not.
    const WRITE_THROUGH=0x04000000,{O_CREAT,O_EXCL,O_WRONLY}=fs.constants;
    const sizeMiB=workerData.sizeMiB || 256,CHUNK=8*1024*1024,CHUNKS=Math.max(1,Math.round(sizeMiB/8)),TOTAL=CHUNK*CHUNKS;
    const label=sizeMiB>=1024?`${sizeMiB/1024} GiB`:`${sizeMiB} MiB`,doneLabel=i=>i*8>=1024?`${(i*8/1024).toFixed(1)} GiB`:`${i*8} MiB`;
    const file=path.join(workerData.tempDir,'verify.bin');
    const written=crypto.createHash('sha256'),per=Math.max(1,Math.floor(CHUNKS/40)),samples=[];
    let writeMs=0,segmentMs=0,segmentChunks=0;
    const fd=fs.openSync(file,O_CREAT|O_EXCL|O_WRONLY|WRITE_THROUGH);
    try {
      for(let i=0;i<CHUNKS;i++) {
        const chunk=crypto.randomBytes(CHUNK);written.update(chunk);
        const start=performance.now();let offset=0;
        while(offset<CHUNK)offset+=fs.writeSync(fd,chunk,offset,CHUNK-offset);
        const ms=performance.now()-start;writeMs+=ms;segmentMs+=ms;segmentChunks++;
        if(segmentChunks===per){samples.push(Math.round(CHUNK*per/1e6/(segmentMs/1000)));segmentMs=0;segmentChunks=0;}
        progress(2+(i+1)/CHUNKS*58,`Đang ghi ${doneLabel(i+1)} / ${label} · ${samples.at(-1) ?? '—'} MB/s`);
      }
      const start=performance.now();fs.fsyncSync(fd);writeMs+=performance.now()-start;
    } finally {fs.closeSync(fd);}
    // Read back unbuffered (UV_FS_O_DIRECT → FILE_FLAG_NO_BUFFERING): the file was just written, so a buffered read
    // would come from Windows' RAM cache (e.g. 11 GB/s on a 6 GB/s drive). Opening it unbuffered also purges that cache.
    // allocUnsafeSlow gives a page-aligned buffer as NO_BUFFERING requires; if the volume still refuses, fall back.
    const read=crypto.createHash('sha256'),buffer=Buffer.allocUnsafeSlow(CHUNK);let readMs=0,readCached=false,rfd;
    try {rfd=fs.openSync(file,fs.constants.O_RDONLY|0x02000000);fs.readSync(rfd,buffer,0,CHUNK,0);}
    catch {if(rfd!==undefined)fs.closeSync(rfd);rfd=fs.openSync(file,'r');readCached=true;}
    try {
      for(let i=0;i<CHUNKS;i++) {
        const start=performance.now();let got=0;
        while(got<CHUNK){const n=fs.readSync(rfd,buffer,got,CHUNK-got,i*CHUNK+got);if(!n)break;got+=n;}
        readMs+=performance.now()-start;
        if(got!==CHUNK)throw Error(`Tệp đọc lại bị thiếu dữ liệu ở đoạn ${i+1}/${CHUNKS}`);
        read.update(buffer);
        progress(60+(i+1)/CHUNKS*39,`Đang đọc lại ${doneLabel(i+1)} / ${label}`);
      }
    } finally {fs.closeSync(rfd);}
    if(read.digest('hex')!==written.digest('hex'))throw Error('Nội dung tệp đọc lại khác dữ liệu đã ghi');
    const speed=ms=>Math.round(TOTAL/1e6/(ms/1000));
    metrics={sizeMiB,readCached,writeMBps:speed(writeMs),readMBps:speed(readMs),minWriteMBps:samples.length?Math.min(...samples):null,maxWriteMBps:samples.length?Math.max(...samples):null,samples};
    detail=`Ghi ${metrics.writeMBps} MB/s (thấp nhất ${metrics.minWriteMBps ?? '—'} MB/s) · đọc lại ${metrics.readMBps} MB/s · ${label} khớp SHA-256 tại ${workerData.tempDir}. Ghi thẳng xuống ổ (write-through)${readCached?'; ổ không cho đọc bỏ qua bộ đệm nên tốc độ đọc có thể đến từ RAM':', đọc thẳng từ ổ (bỏ qua bộ đệm Windows)'}. Không phải benchmark chuẩn hay quét toàn bộ bề mặt. Tệp tạm được dọn sau bài thử.`;
  } else throw Error('Unknown diagnostic');
  parentPort.postMessage({type:'result',state:'completed',detail,metrics});
} catch(error) {
  const detail=error instanceof RangeError?`Không cấp được đủ bộ nhớ cho bài thử (${error.message}). Đóng bớt ứng dụng hoặc chọn mức thấp hơn.`:error.message;
  parentPort.postMessage({type:'result',state:'error',detail,metrics:error.metrics || null});
}
