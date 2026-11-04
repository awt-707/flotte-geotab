// Explicit local integration check, not part of offline tests. Requires the local stack and :4173.
// Creates uniquely named synthetic rows/users, removes only those exact rows in finally.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import { assertLocalSupabase } from '../server/fleet.mjs';
const runtime=JSON.parse(await fs.readFile(new URL('../.local/runtime.json',import.meta.url),'utf8'));
const creds=JSON.parse(await fs.readFile(new URL('../.local/credentials.json',import.meta.url),'utf8'));
assert.equal(runtime.projectId,'ludy-staging');assert.equal(creds.environment,'staging-local-only');
const base=assertLocalSupabase(runtime.supabaseUrl),site='http://127.0.0.1:4173';
const tokenHeaders=t=>({apikey:t===runtime.serviceKey?runtime.serviceKey:runtime.anonKey,Authorization:'Bearer '+t,'Content-Type':'application/json'});
async function sb(path,method='GET',body,token=runtime.serviceKey){return fetch(base+path,{method,headers:{...tokenHeaders(token),Prefer:'return=representation'},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15000)});}
async function data(path,method='GET',body,token){const r=await sb(path,method,body,token);assert.ok(r.ok,'Local Supabase '+path.split('?')[0]+' HTTP '+r.status);return r.status===204?null:r.json();}
async function login(email,password){const r=await data('/auth/v1/token?grant_type=password','POST',{email,password},runtime.anonKey);assert.ok(r.access_token);return r.access_token;}
async function api(path,token,body){return fetch(site+'/api/fleet/'+path,{method:body===undefined?'GET':'POST',headers:{...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});}
const marker=await data('/rest/v1/params?key=eq.environment&select=value');assert.equal(marker[0]?.value,'staging');
const suffix=randomUUID(),name='TEST FLEET '+suffix,email='fleet-test-'+suffix+'@example.invalid',password=randomBytes(24).toString('base64url');
const admin=await login(creds.email,creds.password);let user,agency,driver,otherDriver,ludyCode;
try{
 assert.equal((await api('overview')).status,401);
 const anon=await sb('/rest/v1/fleet_drivers','GET',undefined,runtime.anonKey);assert.ok(anon.status===401 || anon.status===403);
 user=await data('/auth/v1/admin/users','POST',{email,password,email_confirm:true});
 await data('/rest/v1/profiles?user_id=eq.'+user.id,'PATCH',{role:'manager'});
 const viewer=await login(email,password);
 agency=(await data('/rest/v1/agencies','POST',{name}))[0];
 driver=(await data('/rest/v1/fleet_drivers','POST',{name,agency_id:agency.id}))[0];
 const identity=(await data('/rest/v1/fleet_identities','POST',{driver_id:driver.id,source:'uber',source_key:'test:'+suffix,external_id:suffix,organization_id:'synthetic-test'}))[0];
 const at=new Date(Date.now()-10000).toISOString();
 await data('/rest/v1/fleet_observations','POST',{driver_id:driver.id,identity_id:identity.id,source:'uber',status:'available',observed_at:at,evidence:{test:true}});
 const noScope=await data('/rest/v1/fleet_drivers?id=eq.'+driver.id,'GET',undefined,viewer);assert.equal(noScope.length,0);
 const sourcePrivacy=await data('/rest/v1/fleet_sources?select=id,metadata','GET',undefined,viewer);assert.equal(sourcePrivacy.length,0,'source company metadata is admin-only');
 await data('/rest/v1/user_agencies','POST',{user_id:user.id,agency_id:agency.id});
 const scoped=await data('/rest/v1/fleet_drivers?id=eq.'+driver.id,'GET',undefined,viewer);assert.equal(scoped.length,1);
 const obs=await data('/rest/v1/fleet_observations?driver_id=eq.'+driver.id,'GET',undefined,viewer);assert.equal(obs.length,1);
 const refused=await sb('/rest/v1/fleet_drivers?id=eq.'+driver.id,'PATCH',{name:'forbidden'},viewer);assert.equal(refused.status,403);
 assert.equal((await api('pair',viewer,{})).status,403);
 const pairing=await api('pair',admin,{});assert.equal(pairing.status,200);const p=await pairing.json();assert.ok(p.token.startsWith('ludy_uber_'));assert.ok(Date.parse(p.expires_at)>Date.now());
 const bad=await api('uber/ingest','ludy_uber_invalid',{});assert.equal(bad.status,401);
 const over=await api('overview',admin);assert.equal(over.status,200);const o=await over.json();assert.equal(o.sources.length,4);assert.ok(o.drivers.some(d=>d.id===driver.id));
 const history=await api('history?driver_id='+driver.id,viewer);assert.equal(history.status,200);const h=await history.json();assert.equal(h.driver.id,driver.id);assert.ok(h.intervals.some(x=>x.status==='unknown'));
 ludyCode='FLEET_TEST_'+suffix;await data('/rest/v1/drivers','POST',{code:ludyCode,name,agency_id:agency.id,source:'manuel'});
 otherDriver=(await data('/rest/v1/fleet_drivers','POST',{name:name+' Bolt'}))[0];
 const otherIdentity=(await data('/rest/v1/fleet_identities','POST',{driver_id:otherDriver.id,source:'bolt',source_key:'test:'+suffix,external_id:suffix,organization_id:'synthetic-test'}))[0];
 await data('/rest/v1/fleet_observations','POST',{driver_id:otherDriver.id,identity_id:otherIdentity.id,source:'bolt',status:'offline',observed_at:at,evidence:{test:true}});
 for(const id of [driver.id,otherDriver.id]){const linked=await api('drivers/link',admin,{driver_id:id,ludy_driver_code:ludyCode});assert.equal(linked.status,200);const result=await linked.json();assert.equal(result.driver_id,driver.id);}
 const canonical=await data('/rest/v1/fleet_drivers?id=eq.'+driver.id);assert.equal(canonical[0].agency_id,agency.id);assert.equal(canonical[0].ludy_driver_code,ludyCode);
 const allObs=await data('/rest/v1/fleet_observations?driver_id=eq.'+driver.id);assert.equal(allObs.length,2,'merge preserves both histories');
 const ids=await data('/rest/v1/fleet_identities?driver_id=eq.'+driver.id);assert.equal(ids.length,2,'merge preserves provider identities');
 assert.equal((await data('/rest/v1/fleet_drivers?id=eq.'+otherDriver.id)).length,0,'duplicate record merged');
 const idem=await api('drivers/link',admin,{driver_id:driver.id,ludy_driver_code:ludyCode});assert.equal(idem.status,200);
 assert.equal((await sb('/rest/v1/rpc/fleet_link_driver','POST',{p_driver:driver.id,p_ludy_code:ludyCode},viewer)).status,403);
 console.log('Fleet local integration OK: real Auth, admin gates, anonymous denial, agency RLS, private metadata, read-only clients, pairing, history and atomic identity merge. No upstream provider called.');
}finally{
 if(driver)await data('/rest/v1/fleet_drivers?id=eq.'+driver.id,'DELETE');
 if(otherDriver)await data('/rest/v1/fleet_drivers?id=eq.'+otherDriver.id,'DELETE');
 if(ludyCode)await data('/rest/v1/drivers?code=eq.'+ludyCode,'DELETE');
 if(user)await data('/auth/v1/admin/users/'+user.id,'DELETE');
 if(agency)await data('/rest/v1/agencies?id=eq.'+agency.id,'DELETE');
}
