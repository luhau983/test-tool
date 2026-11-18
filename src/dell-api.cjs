const {readLimitedJSON,isTimeout}=require('./http.cjs');
const TOKEN_URL='https://apigtwb2c.us.dell.com/auth/oauth/v2/token';
const WARRANTY_URL='https://apigtwb2c.us.dell.com/PROD/sbil/eapi/v5/asset-entitlements';
function validateTag(value){const tag=String(value || '').trim().toUpperCase();if(!/^[A-Z0-9]{5,12}$/.test(tag))throw Error('Service Tag phải gồm 5–12 ký tự chữ/số. Đối chiếu tem máy hoặc BIOS.');return tag;}
const statuses={400:'Yêu cầu không hợp lệ; kiểm tra Service Tag / quyền API.',401:'Dell từ chối xác thực. Kiểm tra Client ID / Secret hoặc token.',403:'Tài khoản chưa được Dell cấp quyền Warranty API.',404:'Không tìm thấy tài nguyên ở Dell API.',429:'Đã chạm giới hạn Dell API. Đợi rồi thử lại.'};
async function readJSON(response){
  if(!response.ok)throw Error(statuses[response.status] || `Dell API trả HTTP ${response.status}. Thử lại sau.`);
  return readLimitedJSON(response,'Dell API','Dell API trả dữ liệu không phải JSON hợp lệ.');
}
const CHANGED='Khóa đã bị thay đổi / xóa trong lúc tra. Hãy thử lại.';
function normalize(payload,tag,at=new Date().toISOString()){
  const rows=Array.isArray(payload)?payload:Array.isArray(payload?.assets)?payload.assets:[payload];
  const item=rows.find(row=>String(row?.serviceTag || '').toUpperCase()===tag);
  if(!item || item.invalid===true || item.invalid==='true')throw Error('Dell không tìm thấy Service Tag này. Không kết luận máy giả chỉ từ lỗi tra cứu.');
  const scalar=value=>typeof value==='string' || typeof value==='number' || typeof value==='boolean'?value:null;
  const asset={ServiceTag:tag,Model:scalar(item.systemDescription || item.productLineDescription),ProductFamily:scalar(item.productFamily),ProductId:scalar(item.productId),ShipDate:scalar(item.shipDate),CountryCode:scalar(item.countryCode),Duplicated:scalar(item.duplicated),QueriedAt:at,Source:'Dell TechDirect Warranty API v5'};
  const entitlements=(Array.isArray(item.entitlements)?item.entitlements:[]).map(e=>{
    const start=Date.parse(e.startDate),end=Date.parse(e.endDate),now=Date.parse(at);
    return {Service:scalar(e.serviceLevelDescription || e.serviceLevelCode || e.entitlementType),StartDate:scalar(e.startDate),EndDate:scalar(e.endDate),Status:!Number.isFinite(start)||!Number.isFinite(end)?'Chưa xác định':now<start?'Chưa bắt đầu':now<=end?'Trong khoảng ngày dịch vụ':'Đã hết khoảng ngày dịch vụ',ItemNumber:scalar(e.itemNumber)};
  });
  return {asset,entitlements};
}
class DellClient{
  constructor(fetchImpl=fetch){this.fetch=fetchImpl;this.clear();}
  configure(id,secret){
    if(typeof id!=='string'||typeof secret!=='string'||!id.trim()||!secret.trim()||id.length>1024||secret.length>4096)throw Error('Nhập Client ID và Client Secret do Dell TechDirect cấp.');
    this.clear();this.id=id.trim();this.secret=secret.trim();
  }
  // Each configure/clear bumps the generation so an in-flight lookup cannot restore stale credentials.
  clear(){this.generation=(this.generation || 0)+1;this.id=null;this.secret=null;this.token=null;this.expires=0;}
  get configured(){return Boolean(this.id && this.secret);}
  async request(url,options={}){
    try{return await readJSON(await this.fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(20000)}));}
    catch(error){if(isTimeout(error))throw Error('Dell API quá 20 giây. Kiểm tra Internet rồi thử lại.');if(error instanceof TypeError)throw Error('Không kết nối được Dell API. Kiểm tra Internet, proxy hoặc chứng chỉ mạng.');throw error;}
  }
  async lookup(value){
    const tag=validateTag(value);
    if(!this.configured)throw Error('Cần Client ID / Secret được Dell duyệt cho Warranty API. Nhập trong tab Tra Dell API; không cần gửi khóa vào chat.');
    const generation=this.generation;
    if(!this.token || Date.now()>=this.expires){
      const token=await this.request(TOKEN_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},body:new URLSearchParams({grant_type:'client_credentials',client_id:this.id,client_secret:this.secret}).toString()});
      if(this.generation!==generation)throw Error(CHANGED);
      if(typeof token.access_token!=='string' || !token.access_token)throw Error('Dell chưa trả access token hợp lệ. Kiểm tra quyền TechDirect.');
      this.token=token.access_token;const seconds=Number(token.expires_in);this.expires=Date.now()+Math.max(0,(Number.isFinite(seconds)?Math.min(seconds,3600):300)-60)*1000;
    }
    try{
      const payload=await this.request(`${WARRANTY_URL}?servicetags=${encodeURIComponent(tag)}`,{headers:{Authorization:`Bearer ${this.token}`,Accept:'application/json'}});
      if(this.generation!==generation)throw Error(CHANGED);
      return normalize(payload,tag);
    }catch(error){if(error.message.includes('xác thực')){this.token=null;this.expires=0;}throw error;}
  }
}
module.exports={DellClient,validateTag,normalize,TOKEN_URL,WARRANTY_URL};
