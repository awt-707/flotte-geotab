// Single Morocco clock used by the browser and the server (via morocco-time.mjs).
// IANA tzdb 2026f: https://data.iana.org/time-zones/tzdb/africa
// Decree 2.26.530: https://www.cg.gov.ma/en/node/13036 (18 September 2026).
// At 02:00 local on 20 September 2026, clocks returned to permanent GMT.
// Keep earlier Ramadan transitions; never substitute a constant offset for history.
const STAGING_TZ_RULES = Object.freeze([
 [1514764800000,0],[1521943200000,60],[1526176800000,0],[1529200800000,60],
 [1557021600000,0],[1560045600000,60],[1587261600000,0],[1590890400000,60],
 [1618106400000,0],[1621130400000,60],[1648346400000,0],[1651975200000,60],
 [1679191200000,0],[1682215200000,60],[1710036000000,0],[1713060000000,60],
 [1740276000000,0],[1743904800000,60],[1771120800000,0],[1774144800000,60],
 [Date.UTC(2026,8,20,1),0]
].map(row=>Object.freeze(row)));

globalThis.LudyMoroccoTime = (()=>{
 const MINUTE=60000,HOUR=3600000,weekdays=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
 let historicalFormatter;
 const epoch=value=>value==null||value===''?NaN:new Date(value).getTime();
 const pad=value=>String(value).padStart(2,'0');
 function moroccoOffsetMinutes(value){
  const at=epoch(value);if(!Number.isFinite(at))return null;
  if(at<STAGING_TZ_RULES[0][0]){
   historicalFormatter ||= new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Casablanca',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
   const p=Object.fromEntries(historicalFormatter.formatToParts(new Date(at)).filter(p=>p.type!=='literal').map(p=>[p.type,+p.value]));
   return (Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second)-Math.floor(at/1000)*1000)/MINUTE;
  }
  let low=0,high=STAGING_TZ_RULES.length-1;
  while(low<high){const middle=(low+high+1)>>1;if(STAGING_TZ_RULES[middle][0]<=at)low=middle;else high=middle-1;}
  return STAGING_TZ_RULES[low][1];
 }
 function moroccoParts(value){
  const at=epoch(value),offset=moroccoOffsetMinutes(at);if(offset===null)return null;
  const d=new Date(at+offset*MINUTE);
  return {year:d.getUTCFullYear(),month:d.getUTCMonth()+1,day:d.getUTCDate(),hour:d.getUTCHours(),minute:d.getUTCMinutes(),second:d.getUTCSeconds(),weekday:weekdays[d.getUTCDay()]};
 }
 function moroccoDay(value){const p=moroccoParts(value);return p?`${p.year}-${pad(p.month)}-${pad(p.day)}`:null;}
 // A wall clock without an offset must identify exactly one instant. Both the
 // Ramadan clock changes and the final September fold can be ambiguous.
 function moroccoWallTime({year,month,day,hour=0,minute=0,second=0}={}){
  const wanted={year,month,day,hour,minute,second};
  if(!Object.values(wanted).every(Number.isInteger)||year<1900||year>9999||month<1||month>12||day<1||day>31||hour<0||hour>23||minute<0||minute>59||second<0||second>59)return null;
  const wall=Date.UTC(year,month-1,day,hour,minute,second),check=new Date(wall);
  if(check.getUTCFullYear()!==year||check.getUTCMonth()+1!==month||check.getUTCDate()!==day)return null;
  const offsets=new Set([-36,0,36].map(hours=>moroccoOffsetMinutes(wall+hours*HOUR)));
  const matches=[...offsets].map(offset=>wall-offset*MINUTE).filter(at=>{
   const p=moroccoParts(at);return p&&Object.keys(wanted).every(key=>p[key]===wanted[key]);
  });
  return matches.length===1?matches[0]:null;
 }
 return Object.freeze({moroccoParts,moroccoDay,moroccoOffsetMinutes,moroccoWallTime,tzdbVersion:'2026f'});
})();

// The driver portal does not load lib.js. Preserve its padded-string interface.
function stagingLocalDateParts(value){
 const p=globalThis.LudyMoroccoTime.moroccoParts(value);if(!p)return null;
 return Object.fromEntries(['year','month','day','hour','minute','second'].map(key=>[key,String(p[key]).padStart(key==='year'?4:2,'0')]));
}
