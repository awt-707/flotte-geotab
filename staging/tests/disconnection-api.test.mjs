import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createFleetApi} from '../server/fleet.mjs';

const NOW=Date.parse('2026-10-31T12:00:00Z');
const stamp=offset=>new Date(NOW+offset).toISOString();
const newSettings={enabled:true,policy:'any',duty_mode:'contract'};

function fixture(t){
  const tables={
    profiles:['admin','manager','viewer','pending'].map(role=>({user_id:role+'-id',role})),
    fleet_settings:[{id:1,enabled:true,offline_threshold_s:420,schedule:{start:'08:00',end:'18:00',days:[1,2,3],tz:'Africa/Casablanca'},disconnection_enabled:false,disconnection_policy:'any',duty_mode:'contract'}],
    fleet_sources:['uber','bolt','myclicar','geotab'].map(id=>({id,status:'healthy',last_success_at:stamp(0),stale_after_s:180})),
    fleet_drivers:[1,2].map(n=>({id:`00000000-0000-4000-8000-00000000000${n}`,name:`Synthetic driver ${n}`,ludy_driver_code:'TEST-'+n,agency_id:n})),
    vehicles:[1,2].map(n=>({key:'CAR-'+n,plate:'TEST-'+n,agency_id:n,active:'OUI'})),
    fleet_myclicar_contracts:[1,2].map(n=>({external_id:'contract-'+n,num:'TEST-'+n,client_code:'TEST-'+n,vehicle_key:'CAR-'+n,status:'IN_PROGRESS',current:true,eligible:true,deleted:false,end_at:null,effective_start_at:stamp(-3600000),observed_at:stamp(0)})),
    fleet_contract_assignment_overrides:[],fleet_identities:[],fleet_latest:[],fleet_source_events:[],params:[],
    fleet_disconnection_checkpoints:[],fleet_disconnection_alerts:[],
    fleet_alerts:[{id:'legacy-duration',status:'open'}],fleet_offline_motion_alerts:[{id:'legacy-motion',status:'open'}],alerts:[{id:'legacy-geotab',status:'open'}]
  };
  for(const [index,driver] of tables.fleet_drivers.entries()){
    const identity_id=`10000000-0000-4000-8000-00000000000${index+1}`,source=index?'bolt':'uber';
    tables.fleet_identities.push({id:identity_id,driver_id:driver.id,source});
    tables.fleet_latest.push({identity_id,driver_id:driver.id,source,status:'offline',observed_at:stamp(0),evidence:{}});
    tables.fleet_disconnection_alerts.push({id:`20000000-0000-4000-8000-00000000000${index+1}`,identity_id,driver_id:driver.id,source,vehicle_key:'CAR-'+(index+1),contract_id:'contract-'+(index+1),duty_key:'historical-duty-'+(index+1),observed_online_at:stamp(-120000),disconnected_at:stamp(-60000),opened_at:stamp(-60000),last_seen_at:stamp(-30000),status:'resolved',resolved_at:stamp(-30000),evidence:{kind:'platform_disconnection',policy:'any',duty:{mode:'contract'}}});
  }
  const requests=[],unexpected=[];let commitFails=false;
  const allowedDrivers=role=>role==='admin'?tables.fleet_drivers.map(row=>row.id):[tables.fleet_drivers[0].id];
  const fetchFn=async(url,options={})=>{
    const u=new URL(url),role=options.headers.Authorization?.slice(7),method=options.method||'GET';
    assert.equal(u.origin,'http://127.0.0.1:57421','API tests never access a provider or production');
    const table=u.pathname.split('/').at(-1),body=options.body===undefined?undefined:JSON.parse(options.body);
    requests.push({table,method,role,body,params:Object.fromEntries(u.searchParams)});
    if(u.pathname==='/auth/v1/user')return tables.profiles.some(row=>row.user_id===role+'-id')?Response.json({id:role+'-id'}):Response.json({}, {status:401});
    if(u.pathname==='/rest/v1/rpc/fleet_commit_disconnections'){
      assert.equal(role,'service');assert.equal(method,'POST');
      if(commitFails)return Response.json({error:'Synthetic local transaction failure'}, {status:503});
      assert.ok(['p_states','p_alerts','p_changes'].every(key=>Array.isArray(body[key])));
      tables.fleet_disconnection_checkpoints=structuredClone(body.p_states);
      return Response.json({states_saved:body.p_states.length,states_removed:0,alerts_created:body.p_alerts.length,changes_applied:body.p_changes.length});
    }
    if(!Object.hasOwn(tables,table)){unexpected.push(table);throw new Error('Unexpected synthetic table '+table);}
    let rows=tables[table];
    if(role!=='service'){
      if(table==='profiles')rows=rows.filter(row=>row.user_id===role+'-id');
      if(table==='fleet_drivers')rows=rows.filter(row=>allowedDrivers(role).includes(row.id));
      if(table==='fleet_disconnection_alerts')rows=rows.filter(row=>allowedDrivers(role).includes(row.driver_id));
      if(table==='vehicles'&&role!=='admin')rows=role==='viewer'?[]:rows.filter(row=>row.agency_id===1);
    }
    const matches=row=>[...u.searchParams].every(([key,value])=>{
      if(value.startsWith('eq.'))return String(row[key])===value.slice(3);
      if(value.startsWith('neq.'))return String(row[key])!==value.slice(4);
      if(value.startsWith('in.('))return value.slice(4,-1).split(',').includes(String(row[key]));
      if(value.startsWith('gte.'))return String(row[key])>=value.slice(4);
      return true;
    });
    rows=rows.filter(matches);
    if(method==='PATCH'){
      assert.equal(role,'service');assert.equal(table,'fleet_settings');
      for(const row of rows)Object.assign(row,body);
    }else assert.equal(method,'GET');
    const offset=Number(u.searchParams.get('offset')||0),limit=Number(u.searchParams.get('limit')||100000);
    return Response.json(rows.slice(offset,offset+limit));
  };
  const handler=createFleetApi({supabaseUrl:'http://127.0.0.1:57421',anonKey:'anon',serviceKey:'service',fetchFn,now:()=>NOW,
    setTimer(){assert.fail('A settings mutation or GET must not start connector polling');},clearTimer(){}});
  t.after(()=>{handler.close();assert.deepEqual(unexpected,[],'no missing mock table may hide a failed reconciliation');});
  async function call(path,{body,raw,token='admin',method=body===undefined&&raw===undefined?'GET':'POST'}={}){
    const payload=raw===undefined?(body===undefined?undefined:JSON.stringify(body)):raw;
    const req=Readable.from(payload===undefined?[]:[Buffer.from(payload)]);
    Object.assign(req,{url:'/api/fleet/'+path,method,headers:{host:'127.0.0.1:4173',...(token?{authorization:'Bearer '+token}:{})},socket:{remoteAddress:'127.0.0.1'}});
    let status,data;await handler(req,{writeHead:code=>{status=code;},end:value=>{data=JSON.parse(value);},setHeader(){}});
    return {status,data};
  }
  return {tables,requests,call,failCommits(value=true){commitFails=value;}};
}

test('disconnection reads require a valid local role and preserve row-level scope without writes',async t=>{
  const f=fixture(t),before=structuredClone(f.tables);
  for(const [token,expected] of [[null,401],['unknown',401],['pending',403]]){
    const start=f.requests.length,response=await f.call('disconnections',{token});assert.equal(response.status,expected);
    assert.ok(f.requests.slice(start).every(row=>['user','profiles'].includes(row.table)),'denied sessions cannot read fleet data');
  }
  for(const role of ['admin','manager','viewer']){
    const start=f.requests.length,{status,data}=await f.call('disconnections',{token:role});assert.equal(status,200);
    assert.equal(data.enabled,false);assert.equal(data.policy,'any');assert.equal(data.duty_mode,'contract');
    assert.equal(data.alerts.length,role==='admin'?2:1);assert.equal(data.coverage.expected_drivers,role==='admin'?2:1);
    assert.equal(data.coverage.source_fresh,true);assert.equal(data.alerts[0].driver_name,'Synthetic driver 1');
    if(role==='admin')assert.equal(data.coverage.contracts_seen,2);
    else assert.equal(Object.hasOwn(data.coverage,'contracts_seen'),false,'non-admin coverage contains no global counts');
    assert.equal(data.alerts[0].vehicle_key,role==='viewer'?null:'CAR-1');assert.equal(data.alerts[0].plate,role==='viewer'?null:'TEST-1');
    for(const table of ['fleet_drivers','vehicles','fleet_disconnection_alerts'])assert.ok(f.requests.slice(start).some(row=>row.table===table&&row.role===role),table+' uses the viewer session');
    assert.ok(f.requests.slice(start).filter(row=>row.table==='fleet_disconnection_alerts').every(row=>row.role===role),'incident records are never fetched with the service key for display');
  }
  assert.ok(f.requests.every(row=>row.method==='GET'));assert.deepEqual(f.tables,before,'reading derived statuses is side-effect free');
});

test('only administrators can change disconnection settings, before body validation or reconciliation',async t=>{
  const f=fixture(t),before=structuredClone(f.tables);
  for(const [token,expected] of [[null,401],['unknown',401],['pending',403],['viewer',403],['manager',403]]){
    const start=f.requests.length,response=await f.call('disconnections/settings',{token,raw:'{malformed'});assert.equal(response.status,expected);
    assert.ok(f.requests.slice(start).every(row=>['user','profiles'].includes(row.table)));
  }
  assert.deepEqual(f.tables,before);
});

test('disconnection settings reject invalid values, null, arrays, malformed JSON and oversized bodies without writes',async t=>{
  const f=fixture(t),before=structuredClone(f.tables);
  const invalid=[null,[],true,0,'enabled',{}, {policy:'any',duty_mode:'contract'}, {...newSettings,enabled:'true'}, {...newSettings,enabled:1}, {...newSettings,policy:'either'}, {...newSettings,policy:null}, {...newSettings,duty_mode:'schedule'}, {...newSettings,duty_mode:null}];
  for(const body of invalid){const response=await f.call('disconnections/settings',{body});assert.equal(response.status,400,JSON.stringify(body));}
  assert.equal((await f.call('disconnections/settings',{raw:'{invalid'})).status,400);
  assert.equal((await f.call('disconnections/settings',{body:{...newSettings,padding:'x'.repeat(65536)}})).status,413);
  assert.ok(f.requests.every(row=>row.method==='GET'));assert.deepEqual(f.tables,before);
});

test('new disconnection settings use a narrow update and leave duration, motion and Geotab rules untouched',async t=>{
  const f=fixture(t),old=structuredClone(f.tables.fleet_settings[0]);
  const oldAlerts=Object.fromEntries(['fleet_alerts','fleet_offline_motion_alerts','alerts'].map(table=>[table,structuredClone(f.tables[table])]));
  for(const enabled of [true,false])for(const policy of ['any','all'])for(const duty_mode of ['contract','shift']){
    const start=f.requests.length,response=await f.call('disconnections/settings',{body:{enabled,policy,duty_mode,offline_threshold_s:9999,schedule:null,motion_enabled:false}});
    assert.equal(response.status,200);assert.deepEqual(response.data,{enabled,policy,duty_mode});
    const mutations=f.requests.slice(start).filter(row=>row.method!=='GET');
    assert.equal(mutations.length,2,'one settings update followed by one atomic local reconciliation');
    assert.deepEqual(mutations[0].body,{disconnection_enabled:enabled,disconnection_policy:policy,duty_mode});
    assert.equal(mutations[0].params.id,'eq.1');assert.equal(mutations[1].table,'fleet_commit_disconnections');
    const current=f.tables.fleet_settings[0];assert.equal(current.enabled,old.enabled);assert.equal(current.offline_threshold_s,old.offline_threshold_s);assert.deepEqual(current.schedule,old.schedule);
    assert.equal(current.disconnection_enabled,enabled);assert.equal(current.disconnection_policy,policy);assert.equal(current.duty_mode,duty_mode);
    for(const [table,rows] of Object.entries(oldAlerts))assert.deepEqual(f.tables[table],rows,table+' is independent');
  }
});

test('legacy duration settings cannot overwrite the new disconnection policy or service mode',async t=>{
  const f=fixture(t);assert.equal((await f.call('disconnections/settings',{body:{enabled:true,policy:'all',duty_mode:'shift'}})).status,200);
  const start=f.requests.length,response=await f.call('settings',{body:{enabled:false,offline_threshold_s:120,schedule:null,disconnection_enabled:false,disconnection_policy:'any',duty_mode:'contract'}});
  assert.equal(response.status,200);
  const mutations=f.requests.slice(start).filter(row=>row.method!=='GET');assert.equal(mutations.length,1);
  assert.deepEqual(mutations[0].body,{enabled:false,offline_threshold_s:120,schedule:null});
  assert.deepEqual(f.tables.fleet_settings[0],{id:1,enabled:false,offline_threshold_s:120,schedule:null,disconnection_enabled:true,disconnection_policy:'all',duty_mode:'shift'});
  const view=await f.call('disconnections');assert.equal(view.status,200);assert.equal(view.data.enabled,true);assert.equal(view.data.policy,'all');assert.equal(view.data.duty_mode,'shift');
});

test('a failed local reconciliation reports degraded monitoring and retains saved settings and previous checkpoints for retry',async t=>{
  const f=fixture(t);const checkpoint={identity_id:f.tables.fleet_identities[0].id,state:{version:1,synthetic:'previous'},updated_at:stamp(-1000)};
  f.tables.fleet_disconnection_checkpoints.push(checkpoint);f.failCommits();
  const saved=await f.call('disconnections/settings',{body:newSettings});assert.equal(saved.status,200);assert.match(saved.data.warning,/interrompue/);
  assert.equal(f.tables.fleet_settings[0].disconnection_enabled,true);assert.deepEqual(f.tables.fleet_disconnection_checkpoints,[checkpoint]);
  const degraded=await f.call('disconnections');assert.equal(degraded.status,200);assert.ok(degraded.data.warnings.some(row=>row.code==='watch_interrupted'));
  f.failCommits(false);const retried=await f.call('disconnections/settings',{body:newSettings});assert.equal(retried.status,200);assert.equal(Object.hasOwn(retried.data,'warning'),false);
  assert.equal(f.tables.fleet_disconnection_checkpoints.length,2);assert.ok(f.tables.fleet_disconnection_checkpoints.every(row=>row.state.version===1&&row.state.status==='offline'&&row.state.online_at===null));
  const recovered=await f.call('disconnections');assert.ok(!recovered.data.warnings.some(row=>row.code==='watch_interrupted'));
});
