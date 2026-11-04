import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createFleetApi } from '../server/fleet.mjs';

test('Geotab configuration requires a local admin; viewers read only their local vehicle cache',async()=>{
  const reads=[];
  const fetchFn=async(url,options={})=>{
    const u=new URL(url);assert.equal(u.origin,'http://127.0.0.1:57421','no provider or production access');
    const token=options.headers.Authorization?.slice(7);
    if(u.pathname==='/auth/v1/user')return new Response(JSON.stringify({id:token}),{status:['admin','viewer'].includes(token)?200:401});
    assert.equal(options.method,'GET');
    const table=u.pathname.split('/').pop();reads.push({table,token});
    const data=table==='profiles'?[{user_id:token,role:token}]:table==='fleet_sources'?[{id:'geotab',status:'unconnected',metadata:{}}]:[];
    return new Response(JSON.stringify(data));
  };
  let archiveReads=0;
  const archiveStatus={status:'warning',pending:2,persisted:true,activeFailover:false,texat:{enabled:false}};
  const api=createFleetApi({supabaseUrl:'http://127.0.0.1:57421',serviceKey:'service',anonKey:'anon',fetchFn,getTelemetryArchiveStatus:()=>{archiveReads++;return archiveStatus;}});
  const call=async(action,token,body)=>{
    const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
    Object.assign(req,{url:'/api/fleet/geotab/'+action,method:body===undefined?'GET':'POST',headers:{host:'127.0.0.1:4173',...(token?{authorization:'Bearer '+token}:{})},socket:{remoteAddress:'127.0.0.1'}});
    let status,data;await api(req,{writeHead:s=>{status=s;},end:s=>{data=JSON.parse(s);}});return {status,data};
  };
  try {
    assert.equal((await call('status')).status,401);
    assert.equal((await call('status','viewer')).status,403);
    assert.equal((await call('connect','viewer',{database:'test',userName:'test',password:'fake'})).status,403);
    assert.equal(archiveReads,0,'unauthorized status requests never read aggregate archive health');
    const config=await call('status','admin');assert.equal(config.status,200);assert.equal(config.data.configured,false);assert.equal('password' in config.data,false);
    assert.deepEqual(config.data.telemetry_archive,archiveStatus);assert.equal(archiveReads,1);
    reads.length=0;const live=await call('live','viewer');assert.equal(live.status,200);assert.equal(live.data.source.configured,false);
    assert.ok(reads.some(r=>r.table==='vehicles'&&r.token==='viewer'));assert.ok(reads.some(r=>r.table==='live_status'&&r.token==='viewer'));
    assert.equal(Object.hasOwn(live.data,'telemetry_archive'),false);assert.equal(archiveReads,1,'fleet-wide archive health is not attached to viewer vehicle reads');
  } finally {api.close();}
});

test('standby history, detail and reports clearly require the Geotab collector without provider access',async()=>{
  const fetchFn=async(url,options={})=>{
    const u=new URL(url);assert.equal(u.origin,'http://127.0.0.1:57421');
    if(u.pathname==='/auth/v1/user')return Response.json({id:'viewer'});
    assert.equal(u.pathname,'/rest/v1/profiles','standby must stop before any historical or provider request');
    return Response.json([{user_id:'viewer',role:'viewer'}]);
  };
  const api=createFleetApi({supabaseUrl:'http://127.0.0.1:57421',sharedCollection:true,serviceKey:'service',anonKey:'anon',fetchFn});
  try{
    for(const action of ['history','detail','report']){
      const req=Readable.from([]);Object.assign(req,{url:'/api/fleet/geotab/'+action+'?key=vehicle',method:'GET',headers:{host:'127.0.0.1:4173',authorization:'Bearer viewer'},socket:{remoteAddress:'127.0.0.1'}});
      let status,data;await api(req,{writeHead:s=>{status=s;},end:s=>{data=JSON.parse(s);}});
      assert.equal(status,409);assert.equal(data.error,'Ouvrez cette vue sur le poste qui collecte Geotab.');
    }
  }finally{await api.close();}
});
