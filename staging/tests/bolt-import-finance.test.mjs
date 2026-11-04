import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const context=vm.createContext({});vm.runInContext(readFileSync(new URL('../site/caisse_calc.js',import.meta.url),'utf8'),context);
const header=['Date','Chauffeur','Détails','Total des paiements|DH','Espèce|DH','Dans l\'app|DH'];
const fixture=()=>[header,['2026-11-02 04:00','Synthetic driver','123-A-1','1 250,50','250,50','1 000,00']];
test('Bolt import requires explicit money, MAD currency and coherent duplicate sessions',()=>{
 const value=context.cshParseBolt(fixture());assert.equal(value.rows[0].total,1250.5);assert.equal(value.rows[0].cash,250.5);assert.equal(value.rows[0].raw['Total des paiements|DH'],'1 250,50');
 for(const cell of ['',null,'NaN','12abc','1e3','10 EUR','€10','12,3456']){const rows=fixture();rows[1][3]=cell;assert.equal(context.cshParseBolt(rows).rows.length,0);assert.ok(context.cshParseBolt(rows).error);}
 const other=fixture();other[0]=header.map(h=>h.replace('|DH','|EUR'));assert.equal(context.cshParseBolt(other).rows.length,0);
 const same=fixture();same.push([...same[1]]);assert.equal(context.cshParseBolt(same).rows.length,1);same[2][3]='1251';assert.equal(context.cshParseBolt(same).rows.length,0);assert.match(context.cshParseBolt(same).error,/montants différents/);
 const missing=fixture();missing[0]=header.map(h=>h.startsWith('Total')?'Other':h);assert.equal(context.cshParseBolt(missing).rows.length,0);
});
test('strict Bolt money preserves signs, grouping and real zero without truncating decimals',()=>{
 for(const [raw,number] of [['1,234.56',1234.56],['1.234,56',1234.56],['1,234',1234],['1.234',1234],['-29,00 MAD',-29],['0',0],[0,0]])assert.equal(context.cshBoltMoney(raw),number);
 assert.equal(context.cshBoltMoney(0.001),null);assert.equal(context.cshBoltMoney(0.000000001),null);assert.equal(context.cshBoltMoney(1.15),1.15);assert.equal(context.cshBoltMoney(Infinity),null);
});
