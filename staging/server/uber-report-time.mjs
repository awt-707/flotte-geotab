import {parseDemandTime} from './demand-analytics.mjs';
export function parseUberReportTime(value,{csv_timezone='Africa/Casablanca',date_format='ymd',now=Date.now()}={}){
 if(!['UTC','Africa/Casablanca'].includes(csv_timezone))throw Object.assign(Error('Fuseau horaire du CSV Uber à confirmer dans les réglages.'),{status:400,code:'timezone_required'});
 if(csv_timezone==='Africa/Casablanca'||typeof value==='string'&&/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim()))return parseDemandTime(value,{date_format,now});
 if(typeof value!=='string')throw Object.assign(Error('Horodatage UTC Uber invalide.'),{status:400});
 const m=value.trim().match(/^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})[T ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
 if(!m)throw Object.assign(Error('Horodatage UTC Uber invalide.'),{status:400});
 const [,a,b,c,h,min,sec='00']=m,[year,month,day]=a.length===4||date_format==='ymd'?[a,b,c]:date_format==='dmy'?[c,b,a]:[c,a,b];
 return parseDemandTime(`${year.padStart(4,'0')}-${month.padStart(2,'0')}-${day.padStart(2,'0')}T${h.padStart(2,'0')}:${min}:${sec}Z`,{date_format,now});
}
