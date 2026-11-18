const {validateTag}=require('./warranty-api.cjs');
const {readLimitedJSON,isTimeout}=require('./http.cjs');
// Manufacturer support site (the only place its host name appears, with warranty-api.cjs).
const SUPPORT_HOST='www.dell.com';
const WEB_URL=`https://${SUPPORT_HOST}/support/assetdiscovery/en-vn/validate/asset`;
const supportPageURL=serial=>serial?`https://${SUPPORT_HOST}/support/home/en-vn/product-support/servicetag/${encodeURIComponent(serial)}/overview`:`https://${SUPPORT_HOST}/support/contractservices/en-vn`;
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
class WarrantyWebClient{
  constructor(fetchImpl=fetch){this.fetch=fetchImpl;}
  async lookup(value){
    const body=requestBody(value);
    let response;
    try{response=await this.fetch(WEB_URL,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json',Origin:`https://${SUPPORT_HOST}`,Referer:`https://${SUPPORT_HOST}/support/contractservices/en-vn`,'X-Requested-With':'XMLHttpRequest'},credentials:'include',redirect:'error',signal:AbortSignal.timeout(20000),body:JSON.stringify(body)});}
    catch(error){if(isTimeout(error))throw Error('Trang hỗ trợ của hãng quá 20 giây. Thử lại sau.');throw Error('Không kết nối được trang hỗ trợ của hãng. Kiểm tra Internet / proxy.');}
    if(response.status===403)throw Error('Trang hỗ trợ của hãng trả HTTP 403 Access Denied. Yêu cầu đang bị chặn, chưa có kết quả mã máy. Có thể mở trang hỗ trợ trong app để tra trực tiếp; không kết luận số serial sai từ lỗi này.');
    if(response.status===429)throw Error('Trang hỗ trợ của hãng giới hạn tần suất (HTTP 429). Đợi rồi thử lại.');
    if(!response.ok)throw Error(`Trang hỗ trợ của hãng trả HTTP ${response.status}. Chưa xác định được thông tin máy.`);
    const payload=await readLimitedJSON(response,'Trang hỗ trợ','Trang hỗ trợ của hãng chưa trả JSON; có thể đang hiển thị trang chặn / xác minh. Mở trang hỗ trợ để xem trực tiếp.');
    if(payload===null || typeof payload!=='object')throw Error('Cấu trúc phản hồi trang hỗ trợ chưa được nhận diện.');
    return {serial:body.Selection,queriedAt:new Date().toISOString(),source:'Trang hỗ trợ của hãng · validate/asset',fields:flatten(payload)};
  }
}
module.exports={WarrantyWebClient,WEB_URL,SUPPORT_HOST,supportPageURL,requestBody,flatten};
