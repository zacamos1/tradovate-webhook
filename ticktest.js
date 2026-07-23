const { IBApi, EventName } = require('@stoqey/ib');
const ib = new IBApi({ host: process.env.TWS_HOST||'127.0.0.1', port: parseInt(process.env.TWS_PORT||'4002',10), clientId: 78 });
let got = {};
ib.on(EventName.connected, ()=>console.log('connected'));
ib.on(EventName.error, (e,c,r)=>{ if(r===-1) console.log('ERR', c, e&&e.message?e.message:e); });
ib.on(EventName.tickPrice, (reqId, field, value)=>{
  console.log('TICK reqId='+reqId+' field='+JSON.stringify(field)+' value='+value);
});
ib.connect();
setTimeout(()=>{
  const c={ symbol:'SPY', secType:'STK', exchange:'SMART', currency:'USD' };
  ib.reqMktData(1, c, '', false, false);
}, 2500);
setTimeout(()=>{ try{ib.disconnect();}catch(e){} process.exit(0); }, 10000);
