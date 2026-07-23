const { IBApi, EventName } = require('@stoqey/ib');
const ib = new IBApi({ host: process.env.TWS_HOST||'127.0.0.1', port: parseInt(process.env.TWS_PORT||'4002',10), clientId: 79 });
ib.on(EventName.connected, ()=>console.log('connected'));
ib.on(EventName.error, (e,c,r)=>{ console.log('ERR code='+c+' reqId='+r+' msg='+(e&&e.message?e.message:e)); });
ib.on(EventName.tickPrice, (reqId, field, value)=>{
  console.log('TICK reqId='+reqId+' field='+JSON.stringify(field)+' value='+value);
});
ib.connect();
setTimeout(()=>{
  try { ib.reqMarketDataType(3); console.log('requested delayed data type'); } catch(e){ console.log('reqMarketDataType threw', e.message); }
  const c={ symbol:'SPY', secType:'STK', exchange:'SMART', currency:'USD' };
  ib.reqMktData(1, c, '', false, false);
}, 2500);
setTimeout(()=>{ try{ib.disconnect();}catch(e){} process.exit(0); }, 12000);
