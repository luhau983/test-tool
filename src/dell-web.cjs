const {validateTag}=require('./dell-api.cjs');
const {readLimitedJSON,isTimeout}=require('./http.cjs');
const WEB_URL='https://www.dell.com/support/assetdiscovery/en-vn/validate/asset';
function requestBody(tag){return {Selection:validateTag(tag),appName:'warranty',EnableAssetSearch:true,EnableSRSearch:false,EnableKeywordSearch:false,EnableSolutionIdSearch:true};}
function flatten(payload){
  const fields=[];
  function walk(value,key,depth){
    if(fields.length>=200 || depth>8 || /cookie|csrf|authorization|secret|token/i.test(key))return;
    if(value===null || ['string','number','boolean'].includes(typeof value)){fields.push({Field:key || 'Value',Value:typeof value==='string'?value.slice(0,4000):value});return;}
    if(typeof value==='object')for(const [name,child] of Object.entries(value)){walk(child,key?`${key}.${name}`:name,depth+1);if(fields.length>=200)break;}
  }
  walk(payload,'',0);return fields;
}
class DellWebClient{
  constructor(fetchImpl=fetch){this.fetch=fetchImpl;}
  async lookup(value){
    const body=requestBody(value);
    let response;
    try{response=await this.fetch(WEB_URL,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json',Origin:'https://www.dell.com',Referer:'https://www.dell.com/support/contractservices/en-vn','X-Requested-With':'XMLHttpRequest'},credentials:'include',redirect:'error',signal:AbortSignal.timeout(20000),body:JSON.stringify(body)});}
    catch(error){if(isTimeout(error))throw Error('Endpoint web Dell quá 20 giây. Thử lại sau.');throw Error('Không kết nối được endpoint web Dell. Kiểm tra Internet / proxy.');}
    if(response.status===403)throw Error('Dell website trả HTTP 403 Access Denied. Yêu cầu đang bị chặn, chưa có kết quả mã máy. Có thể mở trang Dell trong app để tra trực tiếp; không kết luận Service Tag sai từ lỗi này.');
    if(response.status===429)throw Error('Dell website giới hạn tần suất (HTTP 429). Đợi rồi thử lại.');
    if(!response.ok)throw Error(`Dell website trả HTTP ${response.status}. Chưa xác định được thông tin máy.`);
    const payload=await readLimitedJSON(response,'Dell web','Dell website chưa trả JSON; có thể đang hiển thị trang chặn / xác minh. Mở trang Dell để xem trực tiếp.');
    if(payload===null || typeof payload!=='object')throw Error('Cấu trúc phản hồi Dell web chưa được nhận diện.');
    return {serviceTag:body.Selection,queriedAt:new Date().toISOString(),source:'Dell website · validate/asset',fields:flatten(payload)};
  }
}
module.exports={DellWebClient,WEB_URL,requestBody,flatten};
