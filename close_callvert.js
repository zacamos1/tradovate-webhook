const { IBApi, EventName, SecType, OrderAction, OrderType } = require('@stoqey/ib');
const ib = new IBApi({ host:'127.0.0.1', port:4002, clientId: 9 });
const ACCOUNT='DUN460366';
const SHORT_CALL=892879751, LONG_CALL=889935106;
let oid=null;
ib.on(EventName.error,(e,c,r)=>{ if(![2104,2106,2107,2158].includes(c)) console.log(`[ib] ${c}: ${e&&e.message?e.message:e}`); });
ib.on(EventName.orderStatus,(id,st,f,rem,px)=>console.log(`#${id} ${st}${px?' @'+px:''}`));
ib.on(EventName.nextValidId,(id)=>{
  oid=id;
  console.log('BUY 1 short call back (MKT)...');
  ib.placeOrder(oid,{conId:SHORT_CALL,symbol:'XSP',secType:SecType.OPT,exchange:'SMART',currency:'USD'},
    {action:OrderAction.BUY,orderType:OrderType.MKT,totalQuantity:1,account:ACCOUNT,transmit:true});
  setTimeout(()=>{
    console.log('SELL 1 long call (MKT)...');
    ib.placeOrder(oid+1,{conId:LONG_CALL,symbol:'XSP',secType:SecType.OPT,exchange:'SMART',currency:'USD'},
      {action:OrderAction.SELL,orderType:OrderType.MKT,totalQuantity:1,account:ACCOUNT,transmit:true});
    setTimeout(()=>{ console.log('done — verify in positions'); process.exit(0); },15000);
  },8000);
});
ib.connect();
