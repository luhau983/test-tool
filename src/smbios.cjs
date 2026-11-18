// Decodes the raw Windows RSMB wrapper and selected DMTF SMBIOS structures.
// Unknown structure types are retained verbatim; missing fields stay null.
function parseSMBIOS(buffer) {
  if(!Buffer.isBuffer(buffer) || buffer.length<8) throw Error('SMBIOS thiếu header');
  const size=buffer.readUInt32LE(4);
  if(size>buffer.length-8) throw Error('SMBIOS bị cắt ngắn');
  const end=8+size, structures=[],groups={};
  const add=(name,row)=>{(groups[name] ||= []).push(row);};
  let p=8;
  while(p<end) {
    if(p+4>end) throw Error('SMBIOS thiếu header cấu trúc');
    const type=buffer[p], length=buffer[p+1];
    if(length<4 || p+length>end) throw Error('Độ dài cấu trúc SMBIOS không hợp lệ');
    const formatted=buffer.subarray(p,p+length),start=p+length;
    let q=start;
    while(q+1<end && !(buffer[q]===0 && buffer[q+1]===0))q++;
    if(q+1>=end) throw Error('SMBIOS thiếu kết thúc chuỗi');
    const strings=q===start?[]:buffer.subarray(start,q).toString('utf8').split('\0');
    const u8=o=>o<length?formatted[o]:null;
    const u16=o=>o+2<=length?formatted.readUInt16LE(o):null;
    const u32=o=>o+4<=length?formatted.readUInt32LE(o):null;
    const str=o=>{const index=u8(o);return index && index<=strings.length?strings[index-1].trim():null;};
    const handle='0x'+formatted.readUInt16LE(2).toString(16).padStart(4,'0');
    structures.push({Type:type,Handle:handle,Length:length,Strings:strings.join(' | '),Hex:formatted.toString('hex').match(/../g).join(' ')});
    if(type===0)add('smbiosBIOS',{Vendor:str(4),Version:str(5),ReleaseDate:str(8),SMBIOS:`${buffer[1]}.${buffer[2]}`,BIOSMajor:u8(20),BIOSMinor:u8(21)});
    if(type===1)add('smbiosSystem',{Manufacturer:str(4),Product:str(5),Version:str(6),SerialNumber:str(7),SKU:str(25),Family:str(26)});
    if(type===2)add('smbiosBoard',{Manufacturer:str(4),Product:str(5),Version:str(6),SerialNumber:str(7),AssetTag:str(8),Location:str(10)});
    if(type===3)add('smbiosChassis',{Manufacturer:str(4),ChassisType:u8(5)===null?null:u8(5)&127,Version:str(6),SerialNumber:str(7),AssetTag:str(8)});
    if(type===4)add('smbiosCPU',{Socket:str(4),Manufacturer:str(7),Version:str(16),MaxMHz:u16(20),CurrentMHz:u16(22),Cores:u8(35)===255?u16(42):u8(35),EnabledCores:u8(36)===255?u16(44):u8(36),Threads:u8(37)===255?u16(46):u8(37)});
    if(type===16){
      let max=u32(7);if(max===0x80000000)max=length>=23?Number(formatted.readBigUInt64LE(15))/1024:null;
      add('smbiosMemoryArray',{Handle:handle,Location:u8(4),Use:u8(5),ErrorCorrection:u8(6),MaxCapacityKiB:max,Slots:u16(13)});
    }
    if(type===17){
      const raw=u16(12);let sizeMiB=null;
      if(raw===0)sizeMiB=0;else if(raw===0x7fff){const ext=u32(28);sizeMiB=ext===null?null:ext&0x7fffffff;}
      else if(raw!==null && raw!==0xffff)sizeMiB=raw&0x8000?(raw&0x7fff)/1024:raw;
      const speed=u16(21),configured=u16(32);
      add('smbiosMemory',{Slot:str(16),Bank:str(17),SizeMiB:sizeMiB,Installed:raw===0?'No':raw===0xffff || raw===null?'Unknown':'Yes',MemoryType:u8(18),FormFactor:u8(14),SpeedMTs:speed===0xffff?u32(84):speed || null,ConfiguredMTs:configured===0xffff?u32(88):configured || null,Manufacturer:str(23),SerialNumber:str(24),PartNumber:str(26),DataWidth:u16(10),TotalWidth:u16(8),Rank:u8(27)===null?null:(u8(27)&15) || null,TypeDetail:u16(19),MinVoltageMV:u16(34) || null,MaxVoltageMV:u16(36) || null,ConfiguredVoltageMV:u16(38) || null});
    }
    if(type===22)add('smbiosBattery',{Location:str(4),Manufacturer:str(5),Date:str(6),SerialNumber:str(7),Name:str(8),Chemistry:u8(9),DesignCapacityRaw:u16(10),DesignVoltageMV:u16(12),CapacityMultiplier:u8(21)});
    p=q+2;
    if(type===127)break;
    if(structures.length>4096)throw Error('Quá nhiều cấu trúc SMBIOS');
  }
  return {version:`${buffer[1]}.${buffer[2]}`,size,structures,groups};
}
function enrichFirmware(report) {
  const raw=report.sections.firmwareRaw;
  if(raw?.status!=='ok' || !raw.data?.[0]?.Base64)return report;
  try {
    const decoded=parseSMBIOS(Buffer.from(raw.data[0].Base64,'base64'));
    for(const [key,data] of Object.entries(decoded.groups))report.sections[key]={status:'ok',data,error:null};
    report.sections.smbiosStructures={status:'ok',data:decoded.structures,error:null};
    // Retain original bytes for an exact binary export from the main process.
    report.sections.firmwareInfo={status:'ok',data:[{Source:'Windows GetSystemFirmwareTable(RSMB)',Version:decoded.version,Bytes:decoded.size,Structures:decoded.structures.length}],error:null};
  } catch(error) {report.sections.firmwareInfo={status:'unknown',data:[],error:error.message};}
  return report;
}
module.exports={parseSMBIOS,enrichFirmware};
