const{IBApi,EventName,SecType}=require("@stoqey/ib");
const ib=new IBApi({host:"127.0.0.1",port:4002,clientId:91});
let got=false;
ib.on(EventName.error,(e,c)=>{if(![2104,2106,2158].includes(c))console.log("ERR",c,e&&e.message?e.message:e)});
ib.on(EventName.tickPrice,(r,f,p)=>{if(p>0){got=true;console.log("QUOTE field",f,"=",p)}});
ib.connect();
setTimeout(()=>{ib.reqMarketDataType(3);ib.reqMktData(1,{symbol:"MES",secType:SecType.FUT,exchange:"CME",currency:"USD",lastTradeDateOrContractMonth:"202609",tradingClass:"MES",multiplier:"5"},"",false,false);},2000);
setTimeout(()=>{console.log(got?"QUOTE OK -- data flows":"NO QUOTE -- data subscription needed");process.exit(0)},12000);
