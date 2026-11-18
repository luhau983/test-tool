// Shared HTTP helpers for the Dell clients: bounded JSON body reading and timeout detection.
const MAX_BYTES=2*1024*1024;
const isTimeout=error=>error?.name==='TimeoutError' || error?.name==='AbortError';
async function readLimitedJSON(response,label,invalidJSON){
  if(!response.body)throw Error(invalidJSON);
  const reader=response.body.getReader();let size=0;const chunks=[];
  try{
    while(true){
      const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;
      if(size>MAX_BYTES){await reader.cancel();throw Error(`Phản hồi ${label} vượt giới hạn 2 MiB.`);}
      chunks.push(Buffer.from(value));
    }
  }finally{reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error(invalidJSON);}
}
module.exports={readLimitedJSON,isTimeout,MAX_BYTES};
