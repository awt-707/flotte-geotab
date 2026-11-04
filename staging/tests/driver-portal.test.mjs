import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createHash,randomUUID} from 'node:crypto';
import {createDriverPortalApi} from '../server/driver-portal.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
function fixture(){
 let time=Date.parse('2026-11-02T10:00:00Z');const stamp=()=>new Date(time).toISOString();
 const adminId=randomUUID(),viewerId=randomUUID(),first=randomUUID(),second=randomUUID(),code='LUDY-'+'a'.repeat(32);
 const tables={profiles:[{user_id:adminId,role:'admin'},{user_id:viewerId,role:'viewer'}],drivers:[{code:'CODE1',name:'Synthetic One',agency_id:1},{code:'CODE2',name:'Synthetic Two',agency_id:2}],
 driver_portal_accounts:[{id:first,ludy_driver_code:'CODE1',display_name:'Synthetic One',agency_id:1,active:true,credential_hash:hash(code),created_at:stamp(),rotated_at:stamp()},{id:second,ludy_driver_code:'CODE2',display_name:'Synthetic Two',agency_id:2,active:true,credential_hash:hash('LUDY-'+'b'.repeat(32)),created_at:stamp(),rotated_at:stamp()}],driver_portal_sessions:[],driver_reports:[],driver_notifications:[]};
 const requests=[];let transactionTail=Promise.resolve(),nextHeld=null;
 const holdNext=name=>{let entered,release;const ready=new Promise(resolve=>entered=resolve),waiting=new Promise(resolve=>release=resolve);nextHeld={name,entered,waiting};return {ready,release};};
 const fetchFn=async(url,options={})=>{const u=new URL(url);assert.equal(u.origin,'http://127.0.0.1:57421','only the pinned local database is allowed');const role=options.headers.Authorization?.slice(7),method=options.method||'GET';
 if(u.pathname==='/auth/v1/user')return ['admin','viewer'].includes(role)?Response.json({id:role==='admin'?adminId:viewerId}):Response.json({}, {status:401});
 const table=u.pathname.split('/').at(-1),payload=options.body?JSON.parse(options.body):undefined;requests.push({table,method,body:payload,params:Object.fromEntries(u.searchParams)});
 if(u.pathname.startsWith('/rest/v1/rpc/')){
  assert.equal(role,'service');assert.equal(method,'POST');assert.ok(['driver_portal_login','driver_portal_rotate'].includes(table));
  const operation=transactionTail.then(async()=>{
   if(nextHeld?.name===table){const gate=nextHeld;nextHeld=null;gate.entered();await gate.waiting;}
   if(table==='driver_portal_login'){
    const account=tables.driver_portal_accounts.find(row=>row.credential_hash===payload.p_credential_hash&&row.active);if(!account)return Response.json(null);
    const expires_at=new Date(time+12*3600000).toISOString();tables.driver_portal_sessions=tables.driver_portal_sessions.filter(row=>row.account_id!==account.id||row.expires_at>stamp());
    tables.driver_portal_sessions.push({token_hash:payload.p_token_hash,account_id:account.id,created_at:stamp(),expires_at});return Response.json({name:account.display_name,expires_at});
   }
   assert.equal(payload.p_user,adminId);const account=tables.driver_portal_accounts.find(row=>row.id===payload.p_account);if(!account)return Response.json(null);
   tables.driver_portal_sessions=tables.driver_portal_sessions.filter(row=>row.account_id!==account.id);
   Object.assign(account,{credential_hash:payload.p_credential_hash??account.credential_hash,active:payload.p_credential_hash!==null,rotated_at:stamp()});return Response.json({ok:true,active:account.active});
  });transactionTail=operation.then(()=>{},()=>{});return operation;
 }
 assert.ok(Object.hasOwn(tables,table),'known table '+table);if(table!=='profiles')assert.equal(role,'service');
 const match=row=>[...u.searchParams].every(([k,v])=>v.startsWith('eq.')?String(row[k])===v.slice(3):v.startsWith('gt.')?String(row[k])>v.slice(3):v.startsWith('lte.')?String(row[k])<=v.slice(4):v==='is.null'?row[k]==null:true);
 let rows=tables[table].filter(match);
 if(method==='POST'){
  if(table==='driver_portal_accounts'&&tables[table].some(row=>row.ludy_driver_code===payload.ludy_driver_code))return Response.json({}, {status:409});
  if(table==='driver_notifications'&&tables[table].some(row=>row.account_id===payload.account_id&&row.event_key===payload.event_key))return Response.json([]);
  const row={id:randomUUID(),admin_note:'',acknowledged_at:null,...payload};tables[table].push(row);rows=[row];
 }else if(method==='PATCH'){rows.forEach(row=>Object.assign(row,payload));}else if(method==='DELETE'){tables[table]=tables[table].filter(row=>!match(row));rows=[];}
 return Response.json(rows);
 };
 const api=createDriverPortalApi({supabaseUrl:'http://127.0.0.1:57421',anonKey:'anon',serviceKey:'service',fetchFn,now:()=>time});
 async function call(path,{body,token,method=body===undefined?'GET':'POST',origin='http://127.0.0.1:4173',clientIp,remoteAddress='127.0.0.1'}={}){const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);Object.assign(req,{url:path,method,headers:{host:'127.0.0.1:4173',...(origin?{origin}:{}),...(token?{authorization:'Bearer '+token}:{}),...(clientIp?{'x-ludy-client-ip':clientIp}:{})},socket:{remoteAddress}});let status,data;const handled=await api(req,{writeHead:value=>status=value,end:value=>data=JSON.parse(value)});return {handled,status,data};}
 return {api,tables,requests,call,code,first,second,stamp,holdNext,advance:ms=>time+=ms,login:async()=>{const r=await call('/api/driver/login',{body:{code}});assert.equal(r.status,200);return r.data.token;}};
}
test('driver sessions are opaque, expire, and never expose Supabase or fleet credentials',async()=>{
 const f=fixture(),token=await f.login();assert.match(token,/^dps_[a-zA-Z0-9_-]{43}$/);assert.equal(token.includes('.'),false);
 assert.equal(f.tables.driver_portal_sessions[0].token_hash,hash(token));assert.ok(!JSON.stringify(f.tables).includes(token));
 const me=await f.call('/api/driver/me',{token});assert.equal(me.status,200);assert.deepEqual(Object.keys(me.data).sort(),['name','notifications','reports']);
 assert.equal((await f.call('/api/operations/driver-portal',{token})).status,401);
 f.advance(12*3600000+1);assert.equal((await f.call('/api/driver/me',{token})).status,401);
});
test('each driver sees only own reports and sanitized own notifications, including against forged identifiers',async()=>{
 const f=fixture(),token=await f.login(),own=randomUUID(),foreign=randomUUID();
 f.tables.driver_reports.push({id:own,account_id:f.first,category:'traffic',city:'Casablanca',place:'Synthetic street',description:'Synthetic traffic',status:'pending',reviewed_by:'private-admin',reported_at:f.stamp()},{id:foreign,account_id:f.second,description:'OTHER SECRET'});
 f.tables.driver_notifications.push({id:own,account_id:f.first,kind:'info',title:'Own',message:'Own alert',observed_at:f.stamp(),evidence:{vehicle:'PRIVATE'},event_key:'PRIVATE_EVENT',acknowledged_at:null},{id:foreign,account_id:f.second,message:'OTHER SECRET'});
 const me=await f.call('/api/driver/me',{token});assert.equal(me.status,200);assert.equal(me.data.reports.length,1);assert.equal(me.data.notifications.length,1);
 assert.doesNotMatch(JSON.stringify(me.data),/OTHER SECRET|PRIVATE|account_id|reviewed_by|credential_hash/);
 assert.equal((await f.call('/api/driver/notifications/'+foreign+'/ack',{token,body:{}})).status,404);assert.equal(f.tables.driver_notifications[1].acknowledged_at,undefined);
 assert.equal((await f.call('/api/driver/notifications/'+own+'/ack',{token,body:{}})).status,200);assert.ok(f.tables.driver_notifications[0].acknowledged_at);
});
test('driver report identity and moderation fields are server-owned, and invalid reports do not write',async()=>{
 const f=fixture(),token=await f.login(),body={category:'incident',city:'Marrakech',place:'Synthetic place',description:'Synthetic description',account_id:f.second,status:'verified',admin_note:'forged',reported_at:'2000-01-01'};
 const created=await f.call('/api/driver/reports',{token,body});assert.equal(created.status,201);assert.equal(f.tables.driver_reports[0].account_id,f.first);assert.equal(created.data.report.status,'pending');assert.equal(created.data.report.admin_note,'');assert.equal(created.data.report.reported_at,f.stamp());
 for(const invalid of [null,[],{...body,category:'private-fleet'},{...body,city:'unknown'},{...body,description:'x'},{...body,place:'x'.repeat(241)}])assert.equal((await f.call('/api/driver/reports',{token,body:invalid})).status,400);
 assert.equal(f.tables.driver_reports.length,1);
 assert.equal((await f.call('/api/operations/driver-reports/'+created.data.report.id+'/moderate',{token,body:{status:'verified'}})).status,401);
});
test('login and submissions are limited and foreign origins are rejected before database access',async()=>{
 const f=fixture();assert.equal((await f.call('/api/driver/login',{origin:'https://foreign.invalid',body:{code:f.code}})).status,403);assert.equal(f.requests.length,0);
 for(let i=0;i<15;i++)assert.equal((await f.call('/api/driver/login',{body:{code:'bad'}})).status,401);
 assert.equal((await f.call('/api/driver/login',{body:{code:f.code}})).status,429);f.advance(600001);const token=await f.login();
 for(let i=0;i<12;i++)assert.equal((await f.call('/api/driver/reports',{token,body:{category:'incident',city:'Casablanca',place:'Synthetic place',description:'Synthetic description'}})).status,201);
 assert.equal((await f.call('/api/driver/reports',{token,body:{category:'incident',city:'Casablanca',place:'Synthetic place',description:'Synthetic description'}})).status,429);
});
test('driver login rate limits accept the gateway client IP only over loopback and keep distinct clients separate',async()=>{
 const f=fixture(),login=options=>f.call('/api/driver/login',{body:{code:f.code},...options});
 assert.equal((await login({clientIp:'192.0.2.1',remoteAddress:'198.51.100.10'})).status,403);assert.equal(f.requests.length,0);
 for(let i=0;i<15;i++)assert.equal((await login({clientIp:'192.0.2.1'})).status,200);
 assert.equal((await login({clientIp:'192.0.2.1'})).status,429);assert.equal((await login({clientIp:'192.0.2.2'})).status,200);
 for(let i=0;i<15;i++)assert.equal((await login({clientIp:'not-an-ip'})).status,200);
 assert.equal((await login({clientIp:'another-invalid-address'})).status,429,'invalid headers retain the same local limit');
 f.advance(600001);assert.equal((await login({clientIp:'192.0.2.1'})).status,200);
});
test('administrator provisioning returns a code once; reset and revocation invalidate existing sessions',async()=>{
 const f=fixture();f.tables.drivers.push({code:'CODE3',name:'Synthetic Three',agency_id:3});
 for(const token of [null,'viewer'])assert.equal((await f.call('/api/operations/driver-accounts',{token,body:{driver_code:'CODE3'}})).status,token?403:401);
 const created=await f.call('/api/operations/driver-accounts',{token:'admin',body:{driver_code:'CODE3'}});assert.equal(created.status,201);assert.match(created.data.code,/^LUDY-/);assert.equal(created.data.account.credential_hash,undefined);assert.doesNotMatch(JSON.stringify(f.tables),new RegExp(created.data.code));
 const listing=await f.call('/api/operations/driver-portal',{token:'admin'});assert.equal(listing.status,200);assert.doesNotMatch(JSON.stringify(listing.data),/credential_hash|token_hash/);
 const token=await f.login();const reset=await f.call('/api/operations/driver-accounts/'+f.first+'/reset',{token:'admin',body:{}});assert.equal(reset.status,200);assert.equal((await f.call('/api/driver/me',{token})).status,401);assert.equal((await f.call('/api/driver/login',{body:{code:f.code}})).status,401);
 const next=await f.call('/api/driver/login',{body:{code:reset.data.code}});assert.equal(next.status,200);assert.equal((await f.call('/api/operations/driver-accounts/'+f.first+'/revoke',{token:'admin',body:{}})).status,200);assert.equal((await f.call('/api/driver/me',{token:next.data.token})).status,401);assert.equal((await f.call('/api/driver/login',{body:{code:reset.data.code}})).status,401);
});
test('Geotab notifications are deduplicated per account and absent or revoked accounts receive nothing',async()=>{
 const f=fixture(),data={driverCode:'CODE1',eventKey:'event-1',kind:'overconsumption',title:'Consommation élevée',message:'Relâchez les accélérations.',observedAt:f.stamp(),evidence:{synthetic:true}};
 assert.deepEqual(await f.api.notify(data),{delivered:true,duplicate:false});assert.deepEqual(await f.api.notify(data),{delivered:false,duplicate:true});assert.equal(f.tables.driver_notifications.length,1);
 assert.equal((await f.api.notify({...data,driverCode:'ABSENT'})).reason,'no_active_account');f.tables.driver_portal_accounts[0].active=false;assert.equal((await f.api.notify({...data,eventKey:'event-2'})).reason,'no_active_account');
 await assert.rejects(f.api.notify({...data,observedAt:'invalid'}));await assert.rejects(f.api.notify({...data,evidence:[]}));
});
test('concurrent authentication and rotation are delegated to serialized database transactions',async()=>{
 for(const firstOperation of ['driver_portal_login','driver_portal_rotate']){
  const f=fixture(),gate=f.holdNext(firstOperation),login=()=>f.call('/api/driver/login',{body:{code:f.code}}),rotate=()=>f.call('/api/operations/driver-accounts/'+f.first+'/reset',{token:'admin',body:{}});
  const first=firstOperation==='driver_portal_login'?login():rotate();await gate.ready;
  const second=firstOperation==='driver_portal_login'?rotate():login();gate.release();const result=await Promise.all([first,second]);
  const loginResult=result[firstOperation==='driver_portal_login'?0:1],rotation=result[firstOperation==='driver_portal_login'?1:0];
  assert.equal(rotation.status,200);if(loginResult.status===200)assert.equal((await f.call('/api/driver/me',{token:loginResult.data.token})).status,401);else assert.equal(loginResult.status,401);
  assert.equal(f.tables.driver_portal_sessions.length,0);
  assert.ok(f.requests.some(row=>row.table==='driver_portal_login'&&row.method==='POST'));
  assert.ok(f.requests.some(row=>row.table==='driver_portal_rotate'&&row.method==='POST'));
  assert.equal(f.requests.some(row=>row.table==='driver_portal_accounts'&&row.method==='PATCH'),false);
  assert.equal(f.requests.some(row=>row.table==='driver_portal_sessions'&&row.method==='POST'),false);
 }
});
test('logout removes only its own session and login/reset never return database hashes',async()=>{
 const f=fixture(),token=await f.login(),other=await f.login();
 assert.equal((await f.call('/api/driver/logout',{token,body:{}})).status,200);
 assert.equal((await f.call('/api/driver/me',{token})).status,401);
 assert.equal((await f.call('/api/driver/me',{token:other})).status,200);
 assert.equal((await f.call('/api/operations/driver-accounts/'+randomUUID()+'/reset',{token:'admin',body:{}})).status,404);
 assert.equal((await f.call('/api/operations/driver-accounts/not-an-id/reset',{token:'admin',body:{}})).status,400);
 assert.equal((await f.call('/api/driver/nonexistent',{token:other})).status,404);
});
test('moderation is administrator-only and does not disclose internal identity in the driver response',async()=>{
 const f=fixture(),token=await f.login(),created=await f.call('/api/driver/reports',{token,body:{category:'accident',city:'Casablanca',place:'Synthetic street',description:'Synthetic incident'}}),id=created.data.report.id;
 assert.equal((await f.call('/api/operations/driver-reports/'+id+'/moderate',{token:'viewer',body:{status:'verified',note:'Reviewed'}})).status,403);
 const result=await f.call('/api/operations/driver-reports/'+id+'/moderate',{token:'admin',body:{status:'verified',note:'Merci, vérifié.'}});assert.equal(result.status,200);assert.equal(result.data.report.status,'verified');assert.equal(result.data.report.reviewed_by,undefined);
 assert.equal((await f.call('/api/driver/me',{token})).data.reports[0].admin_note,'Merci, vérifié.');
});
