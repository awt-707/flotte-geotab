import test from 'node:test';
import assert from 'node:assert/strict';
import {driverPlatformActivity} from '../server/platform-activity.mjs';

const NOW = Date.parse('2026-10-30T12:00:00Z');
const iso = seconds => new Date(NOW + seconds * 1000).toISOString();
const source = (id, extra = {}) => ({id,status:'healthy',last_success_at:iso(0),stale_after_s:90,...extra});
const row = (provider, status = 'offline', extra = {}) => ({identity_id:provider+'-account',driver_id:'driver',source:provider,status,observed_at:iso(0),offline_since:status === 'offline' ? iso(-60) : null,evidence:{},...extra});
const identity = (provider, extra = {}) => ({id:provider+'-account',driver_id:'driver',source:provider,...extra});
const verdict = (latest, extra = {}) => driverPlatformActivity({driverId:'driver',now:NOW,latest,sources:[source('uber'),source('bolt')],...extra});

test('a fresh activity on either platform overrides the other offline account',()=>{
  for (const provider of ['uber','bolt']) for (const status of ['available','on_trip','to_pickup','on_break']) {
    const other = provider === 'uber' ? 'bolt' : 'uber';
    const state = verdict([row(provider,status),row(other)]);
    assert.equal(state.status,'online'); assert.equal(state.offline_since,null);
    assert.deepEqual(state.active_sources,[provider]); assert.deepEqual(state.offline_sources,[other]);
  }
});

test('all known accounts must be offline and distance starts when the last one went offline',()=>{
  const state = verdict([row('bolt','offline',{offline_since:iso(-120)}),row('uber','offline',{offline_since:iso(-15)})]);
  assert.equal(state.status,'offline'); assert.equal(state.offline_since,iso(-15));
  assert.deepEqual(state.offline_sources,['bolt','uber']);
  assert.equal(verdict([row('bolt')]).offline_since,iso(-60),'single-platform drivers remain supported');
});

test('a return from online to offline starts a distinct combined episode',()=>{
  const bolt = row('bolt','offline',{offline_since:iso(-300)});
  assert.equal(verdict([bolt,row('uber','on_trip')]).status,'online');
  assert.equal(verdict([bolt,row('uber','offline',{offline_since:iso(-5)})]).offline_since,iso(-5));
});

test('known but missing, unknown or stale accounts prevent an offline verdict',()=>{
  assert.equal(verdict([row('bolt')],{identities:[identity('bolt'),identity('uber')]}).status,'unknown');
  for (const extra of [{status:'unknown',offline_since:null},{observed_at:iso(-91)},{observed_at:iso(6)},{observed_at:'invalid'}]) {
    assert.equal(verdict([row('bolt'),row('uber','offline',extra)]).status,'unknown');
  }
  assert.equal(verdict([row('bolt'),row('uber','on_trip',{observed_at:iso(-91)})]).status,'unknown');
});

test('source health and timestamps are required independently of fresh row timestamps',()=>{
  for (const extra of [{status:'paused'},{status:'error'},{status:'stale'},{last_success_at:iso(-91)},{last_success_at:iso(6)},{last_success_at:null}]) {
    assert.equal(verdict([row('bolt')],{sources:[source('bolt',extra)]}).status,'unknown');
  }
  assert.equal(verdict([row('bolt')],{sources:[]}).status,'unknown');
  assert.equal(verdict([row('bolt')],{sources:[source('bolt'),source('bolt',{status:'error'})]}).status,'unknown');
});

test('fresh online evidence remains decisive even while another known account is unavailable',()=>{
  assert.equal(verdict([row('uber','on_trip')],{identities:[identity('uber'),identity('bolt')]}).status,'online');
  assert.equal(verdict([row('uber','on_trip'),row('bolt')],{sources:[source('uber'),source('bolt',{status:'error'})]}).status,'online');
});

test('inactive accounts are excluded only with fresh supporting evidence',()=>{
  for (const account_status of ['deactivated','suspended','SUSPENDED']) {
    const inactive = row('bolt','offline',{evidence:{account_status}});
    assert.equal(verdict([row('uber'),inactive]).status,'offline');
    assert.deepEqual(verdict([row('uber'),inactive]).offline_sources,['uber']);
    assert.equal(verdict([{...inactive,observed_at:iso(-91)},row('uber')]).status,'unknown');
    assert.equal(verdict([inactive]).reason,'no_active_platform');
  }
});

test('identity discovery is safe across separate database reads without matching names',()=>{
  assert.equal(verdict([row('bolt')],{identities:[]}).status,'offline');
  assert.equal(verdict([row('bolt')],{identities:[identity('uber')]}).status,'unknown');
  assert.equal(verdict([row('bolt'),row('uber','on_trip',{driver_id:'another-driver'})]).status,'offline');
  assert.equal(verdict([row('bolt')],{identities:[identity('bolt',{driver_id:'another-driver'})]}).status,'unknown');
  assert.equal(verdict([row('bolt')],{identities:[identity('bolt',{source:'uber'})]}).status,'unknown');
});

test('older replayed rows cannot replace current activity and contradictory duplicates fail closed',()=>{
  const current = row('uber','on_trip'), previous = row('uber','offline',{observed_at:iso(-20)});
  for (const rows of [[current,previous],[previous,current],[current,current]]) assert.equal(verdict(rows).status,'online');
  assert.equal(verdict([current,row('uber')]).status,'unknown');
  assert.equal(verdict([row('bolt'),row('bolt','offline',{offline_since:iso(-45)})]).status,'unknown');
  assert.equal(verdict([row('bolt'),row('bolt','offline',{driver_id:'another-driver'})]).status,'unknown');
});

test('invalid or future offline starts never establish an episode',()=>{
  for (const since of [null,'invalid',iso(1),iso(-10)]) {
    const observed_at = since === iso(-10) ? iso(-20) : iso(0);
    assert.equal(verdict([row('bolt','offline',{offline_since:since,observed_at})]).status,'unknown');
  }
  assert.equal(verdict([]).reason,'no_known_platform');
  assert.equal(verdict([row('bolt')],{now:NaN}).reason,'invalid_time');
  assert.equal(verdict([row('bolt')],{driverId:null}).reason,'invalid_input');
});
