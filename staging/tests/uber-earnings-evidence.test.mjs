import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {projectUberEarningsEvidence,attachUberEarningsIdentities,observeUberEarningsEvidence} from '../server/uber-earnings-evidence.mjs';
import {normalizeUberEarnings,parseUberEarningsPeriod} from '../server/uber-earnings.mjs';
const org='11111111-1111-4111-8111-111111111111',driver='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',now=Date.parse('2026-11-03T16:00:00Z');
const displayed=parseUberEarningsPeriod('02/11/2026 04:02 AM - 03/11/2026 03:15 PM');
const start=Date.parse(displayed.start_at)+12345,end=Date.parse(displayed.end_at)+32100;
const money=(minor,currencyCode='MAD')=>({amountE5:String(minor*1000),currencyCode});
function fixture(){return {request:{variables:{supplierUuid:org,timeRange:{startTimeUnixMillis:String(start),endTimeUnixMillis:String(end)},driverList:null}},response:{data:{getEarnerBreakdownsV2:{earnerEarningsBreakdowns:[{earnerUuid:driver,earnerMetadata:{name:'Synthetic Driver',pictureUrl:'private-photo',email:'private-email'},earnings:{amount:money(67000),children:[{secret:'unused-child'}]},reimbursements:{amount:money(0)},adjustmentsFromPreviousPeriods:{amount:money(2700)},payouts:{amount:money(-38200)},netOutstanding:money(31500),tripInfos:[{unused:'unused-trip'}]}]}}},organizationId:org};}
function snapshot(){return {version:1,source:'uber_fleet_earnings',organizationId:org,sourceUrl:'https://fleethub.uber.com/orgs/'+org+'/earnings',observedAt:new Date(now).toISOString(),providerPeriod:displayed,currency:'MAD',fleet:{revenue:'670,00 MAD'},drivers:[{providerDriverId:null,driverName:'Synthetic Driver',driverNameComplete:true,metrics:{revenue:'670,00 MAD',refunds_expenses:'0,00 MAD',adjustments:'27,00 MAD',payout:'-382,00 MAD',reported_net_earnings:'315,00 MAD'}}],coverage:{complete:true,filtered:false,driverRowsObserved:1,driverRowsTotal:1,pages:1}};}
test('passive evidence projects only displayed financial fields and matches a unique UUID using the full financial row and exact window',()=>{
 const evidence=projectUberEarningsEvidence(fixture());assert.equal(evidence.rows[0].providerDriverId,driver);const serialized=JSON.stringify(evidence);for(const text of ['private-photo','private-email','unused-child','unused-trip'])assert.ok(!serialized.includes(text));
 const {snapshot:attached,matched,observed}=attachUberEarningsIdentities(snapshot(),[evidence]);assert.equal(matched,1);assert.equal(observed,true);assert.equal(attached.drivers[0].providerDriverId,driver);assert.equal(Date.parse(attached.providerPeriod.start_at),start);assert.equal(Date.parse(attached.providerPeriod.end_at),end);
 const normalized=normalizeUberEarnings(attached,{organizationId:org,now});assert.equal(normalized.drivers[0].reported_net_earnings_minor,31500);assert.equal(normalized.drivers[0].net_minor,null);assert.equal(Date.parse(normalized.provider_period.end_at),end);
});
test('other fleets, filters, malformed money and API errors cannot supply identities',()=>{
 for(const mutate of [f=>f.request.variables.supplierUuid=other,f=>f.request.variables.driverList=[driver],f=>f.response.errors=[{}],f=>f.request.variables.timeRange.endTimeUnixMillis='invalid']){const f=fixture();mutate(f);assert.equal(projectUberEarningsEvidence(f),null);}
 const fractional=fixture();fractional.response.data.getEarnerBreakdownsV2.earnerEarningsBreakdowns[0].earnings.amount.amountE5='67000001';assert.equal(projectUberEarningsEvidence(fractional).rows.length,0);
 const currency=fixture();currency.response.data.getEarnerBreakdownsV2.earnerEarningsBreakdowns[0].netOutstanding.currencyCode='EUR';assert.equal(projectUberEarningsEvidence(currency).rows.length,0);
});
test('a name alone, incomplete name, ambiguous financial identity or two precise windows never establish an identity',()=>{
 const evidence=projectUberEarningsEvidence(fixture());const wrong=snapshot();wrong.drivers[0].metrics.payout='-381,00 MAD';assert.equal(attachUberEarningsIdentities(wrong,[evidence]).matched,0);
 const incomplete=snapshot();incomplete.drivers[0].driverNameComplete=false;assert.equal(attachUberEarningsIdentities(incomplete,[evidence]).matched,0);
 const ambiguous={...evidence,rows:[...evidence.rows,{...evidence.rows[0],providerDriverId:other}]};assert.equal(attachUberEarningsIdentities(snapshot(),[ambiguous]).matched,0);
 assert.equal(attachUberEarningsIdentities(snapshot(),[evidence,{...evidence,end:end+1000}]).observed,false);assert.equal(attachUberEarningsIdentities(snapshot(),[{...evidence,start:start-60000}]).matched,0);
});
test('observer listens only to normal page responses and detaches without reading authentication headers or making requests',async()=>{
 const page=new EventEmitter(),f=fixture(),reads=[];
 const response={url:()=> 'https://fleethub.uber.com/graphql',status:()=>200,request:()=>({resourceType:()=> 'fetch',postDataJSON:()=>f.request}),headerValue:async name=>{reads.push(name);assert.equal(name,'content-length');return null;},body:async()=>Buffer.from(JSON.stringify(f.response))};
 const observer=observeUberEarningsEvidence({page,organizationId:org});page.emit('response',{...response,url:()=> 'https://outside.invalid/graphql'});assert.equal(reads.length,0);page.emit('response',response);const result=await observer.attach(snapshot());assert.equal(result.matched,1);assert.deepEqual(reads,['content-length']);page.emit('response',{...response,status:()=>429});assert.equal(observer.rateLimited,true);assert.deepEqual(reads,['content-length'],'a rate limit needs no body or auth details');observer.dispose();assert.equal(page.listenerCount('response'),0);assert.equal((await observer.attach(snapshot())).matched,0);
});
