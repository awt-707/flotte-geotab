import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateUberEarnings, validUberEarningsProvenance} from '../server/uber-earnings-calculation.mjs';
const entries = [{field:'fare',label:'Fare',minor:84700},{field:'commission',label:'Service Fee',minor:-14800},{field:'taxes',label:'Taxes',minor:-2900}];
const amounts = {revenue_minor:67000,gross_minor:null,net_minor:null,reported_net_earnings_minor:31500,payout_minor:-38200,adjustments_minor:2700};
test('verified full breakdown preserves settlement values and calculates an explicitly named gross and net',()=>{
 const result=calculateUberEarnings(amounts,{complete:true,entries});assert.equal(result.amounts.gross_minor,84700);assert.equal(result.amounts.net_minor,69900);assert.equal(result.amounts.taxes_minor,-2900);assert.equal(result.amounts.tips_minor,0);assert.equal(result.amounts.reported_net_earnings_minor,31500);assert.equal(result.amounts.payout_minor,-38200);assert.equal(result.provenance.net_definition,'after_uber_fees_before_provider_taxes');assert.equal(validUberEarningsProvenance(result.amounts,result.provenance),true);
 const changed=structuredClone(result.provenance);changed.entries[0].minor++;assert.equal(validUberEarningsProvenance(result.amounts,changed),false);
});
test('tips and promotions belong to gross; unknown, partial or unreconciled categories never produce it',()=>{
 const plus=[...entries,{field:'tips',label:'Tip',minor:500},{field:'bonus',label:'Promotion',minor:1000}];const value=calculateUberEarnings({...amounts,revenue_minor:68500},{complete:true,entries:plus});assert.equal(value.amounts.gross_minor,86200);assert.equal(value.amounts.net_minor,71400);
 for(const breakdown of [{complete:false,entries},{complete:true,entries:[...entries,{field:'other',label:'Other',minor:0}]},{complete:true,entries:[...entries,entries[0]]},{complete:true,entries:entries.slice(0,2)}]){const result=calculateUberEarnings(amounts,breakdown);assert.equal(result.amounts.net_minor,null);assert.equal(result.amounts.gross_minor,null);assert.equal(result.provenance.status,'unavailable');}
 assert.equal(calculateUberEarnings(amounts,null).provenance,null);
});

test('an omitted optional category cannot overwrite an already observed nonzero component',()=>{
 const fareOnly={complete:true,entries:[{field:'fare',label:'Fare',minor:10000}]};
 for(const field of ['tips','bonus','commission','taxes'])for(const value of [500,-500]){
  const input={revenue_minor:10000,gross_minor:null,net_minor:null,[field+'_minor']:value};
  const result=calculateUberEarnings(input,fareOnly);
  assert.equal(result.provenance.reason,'conflicting_component');
  assert.equal(result.amounts[field+'_minor'],value);
  assert.equal(result.amounts.gross_minor,null);assert.equal(result.amounts.net_minor,null);
  assert.deepEqual(result.amounts,input);
 }
 const knownZero=calculateUberEarnings({revenue_minor:10000,gross_minor:null,net_minor:null,tips_minor:0},fareOnly);
 assert.equal(knownZero.provenance.status,'verified');assert.equal(knownZero.amounts.tips_minor,0);
 assert.equal(validUberEarningsProvenance(knownZero.amounts,knownZero.provenance),true);
});
