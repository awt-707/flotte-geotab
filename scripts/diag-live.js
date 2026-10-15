const {sheetV6}=require('./tests/lib/v6');const L=(d,h,m)=>Date.UTC(2026,9,d,h-1,m||0);
for (const now of [L(5,12,40), L(6,10)]) {
  const A=sheetV6(now);A.run("queueSync_(['2026-10-03','2026-10-04'], false)");
  const t=A.tab('DATA_TRAJETS');
  console.log('::notice::now='+new Date(now).toISOString()+' trajets='+t.length+' du04='+t.filter(r=>A.day(r['Début'])==='2026-10-04').length+' sync='+A.tab('DATA_SYNC').length+' queue='+A.run("PropertiesService.getScriptProperties().getProperty('SYNC_QUEUE')")+' logs='+JSON.stringify(A.tab('JOURNAL').slice(-3)).slice(0,600)+' node='+process.version+' tz='+Intl.DateTimeFormat().resolvedOptions().timeZone);
}
