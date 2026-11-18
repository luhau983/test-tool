const {app,session}=require('electron');
const {WarrantyWebClient}=require('../src/warranty-web.cjs');
app.whenReady().then(async()=>{
  const client=new WarrantyWebClient((url,options)=>session.fromPartition('warranty-web-probe').fetch(url,options));
  try{console.log(JSON.stringify(await client.lookup('2TKWSV3'),null,2));app.exit(0);}
  catch(error){console.log(error.message);app.exit(2);}
});
