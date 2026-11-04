import test from 'node:test';import assert from 'node:assert/strict';import {readLocalJson}from'../server/local-json.mjs';
test('successful minimal inserts do not become false failures after commit',async()=>{
 assert.equal(await readLocalJson(new Response(null,{status:201})),null);
 assert.equal(await readLocalJson(new Response(null,{status:204})),null);
 assert.deepEqual(await readLocalJson(Response.json([{id:'fixture'}],{status:201})),[{id:'fixture'}]);
 assert.deepEqual(await readLocalJson(Response.json([])),[]);
});
test('missing or malformed read results remain errors instead of looking like an empty snapshot',async()=>{
 await assert.rejects(readLocalJson(new Response('',{status:200})),SyntaxError);
 await assert.rejects(readLocalJson(new Response('not JSON',{status:201})),SyntaxError);
});
