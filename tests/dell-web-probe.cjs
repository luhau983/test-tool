const {app,session}=require('electron');
const {DellWebClient}=require('../src/dell-web.cjs');
app.whenReady().then(async()=>{
  const client=new DellWebClient((url,options)=>session.fromPartition('dell-web-probe').fetch(url,options));
  try{console.log(JSON.stringify(await client.lookup('2TKWSV3'),null,2));app.exit(0);}
  catch(error){console.log(error.message);app.exit(2);}
});
