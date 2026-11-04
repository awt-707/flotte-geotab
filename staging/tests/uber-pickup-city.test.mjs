import test from 'node:test';
import assert from 'node:assert/strict';
import {uberPickupCity,uberPickupCitySuffix,uberLegacyPickupCity} from '../server/uber-pickup-city.mjs';
import {uberPickupCity as exported} from '../server/uber-reports.mjs';
test('explicit city suffix aliases are recognized across exporter languages',()=>{
 for(const address of ['Rue test, Dar-el-Beïda 20250, Maroc','Rue test, الدار البيضاء 20250, المغرب','Rue test, Kasablanka, Marokko','Rue test, 摩洛哥卡萨布兰卡','Rue test, 20000 Касабланка, Марокко'])assert.equal(uberPickupCity(address),'Casablanca');
 for(const address of ['Rue test, مراكش 40000, المغرب','Rue test, Марракеш, Марокко','Rue test, Marakeş 40000, Fas'])assert.equal(uberPickupCity(address),'Marrakech');
 assert.equal(exported,uberPickupCity);
});
test('an alias in a street, a different country or a neighboring locality never assigns the new city',()=>{
 for(const address of ['Rue Dar-el-Beïda, Rabat, Morocco','Avenue مراكش, Bouskoura, Maroc','Dar-el-Beïda, Algeria','Dar-el-Beïda','Somewhere Dar-el-Beïda, Morocco','Rue test, Bouskoura, Maroc','Rue test, Nouaceur, Maroc','Rue test, Mohammedia, Maroc','Rue test, Province de Nouaceur, Maroc','Rue test, Grand Dar-el-Beïda, Maroc'])assert.equal(uberPickupCity(address),null,address);
 assert.equal(uberPickupCitySuffix('Rue test, Dar-el-Beïda, Morocco'),'Casablanca');
});
test('historical recognized cities are preserved and never rewritten by the new suffix logic',()=>{
 for(const address of ['Rue test, Casablanca, Morocco','Rue test, Marrakech, Maroc','Casa test','Marrakesh, Morocco','Route de Casablanca, Rabat, Morocco'])assert.equal(uberPickupCity(address),uberLegacyPickupCity(address));
 assert.equal(uberPickupCity('Casablanca et Marrakech'),null);
});
