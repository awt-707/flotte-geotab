import test from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopSession} from '../desktop-runtime/session.mjs';

const config={supabaseUrl:'https://abcdefghijklmnopqrst.supabase.co',publishableKey:'sb_publishable_fixture'};
const userId='10000000-0000-4000-8000-000000000001';
const otherId='10000000-0000-4000-8000-000000000002';
const now=()=>Date.parse('2026-11-05T00:00:00Z');
const jwt=(claims={})=>['e30',Buffer.from(JSON.stringify({sub:userId,role:'authenticated',exp:now()/1000+3600,...claims})).toString('base64url'),'signature'].join('.');
const temporaryMessage='Vérification de la session Ludy momentanément indisponible.';

for(const endpoint of ['auth','profile']){
  test(`${endpoint}: transient HTTP failures preserve retryable status without trusting the response body`,async t=>{
    for(const status of [408,429,500,502,503,504,599])await t.test(String(status),async()=>{
      let calls=0,bodyReads=0;
      const auth=createDesktopSession({config,now,fetchFn:async(url,options)=>{
        calls++;
        assert.equal(options.headers.Authorization,'Bearer '+jwt());
        if(endpoint==='profile'&&url.endsWith('/auth/v1/user'))return Response.json({id:userId});
        return {ok:false,status,json:async()=>{bodyReads++;return {role:'admin',error:'provider-private-detail'};}};
      }});
      try{
        await assert.rejects(auth.authenticate(jwt()),error=>{
          assert.equal(error.status,503);assert.equal(error.message,temporaryMessage);
          assert.ok(!error.message.includes(jwt()));assert.ok(!error.message.includes(config.publishableKey));
          return true;
        });
        assert.equal(calls,endpoint==='auth'?1:2);assert.equal(bodyReads,0);assert.equal(auth.current(),null);
      }finally{auth.clear();}
    });
  });
  test(`${endpoint}: real authentication and authorization refusals remain terminal`,async t=>{
    for(const status of [401,403])await t.test(String(status),async()=>{
      let calls=0;
      const auth=createDesktopSession({config,now,fetchFn:async url=>{
        calls++;
        if(endpoint==='profile'&&url.endsWith('/auth/v1/user'))return Response.json({id:userId});
        return {ok:false,status,json:()=>assert.fail('A refusal body must not be trusted or exposed')};
      }});
      try{
        await assert.rejects(auth.authenticate(jwt()),{status});
        assert.equal(auth.current(),null);assert.equal(calls,endpoint==='auth'?1:2);
      }finally{auth.clear();}
    });
  });
}

test('a failed profile refresh cannot replace the current role or extend its expiry; a retry revalidates Auth',async()=>{
  let rejectProfile=false,role='viewer',authCalls=0;
  const auth=createDesktopSession({config,now,fetchFn:async url=>{
    if(url.endsWith('/auth/v1/user')){authCalls++;return Response.json({id:userId});}
    return rejectProfile?new Response('private provider detail',{status:503}):Response.json([{role}]);
  }});
  try{
    const first=await auth.authenticate(jwt());
    role='admin';rejectProfile=true;
    const refreshedToken=jwt({exp:now()/1000+7200});
    await assert.rejects(auth.authenticate(refreshedToken),{status:503});
    assert.equal(auth.current(),first);assert.equal(auth.current().role,'viewer');
    assert.equal(auth.current().expiresAt,now()+3600000);
    rejectProfile=false;
    const retried=await auth.authenticate(refreshedToken);
    assert.equal(authCalls,3);assert.equal(retried.role,'admin');assert.equal(retried.token,refreshedToken);
    assert.equal(retried.expiresAt,now()+7200000);
  }finally{auth.clear();}
});

test('expired or privileged JWTs and a mismatched verified Auth user still fail closed',async()=>{
  let calls=0;
  const auth=createDesktopSession({config,now,fetchFn:async()=>{calls++;return Response.json({id:otherId});}});
  try{
    for(const token of ['not-a-jwt',jwt({role:'service_role'}),jwt({exp:now()/1000})]){
      await assert.rejects(auth.authenticate(token),{status:401});
    }
    assert.equal(calls,0);
    await assert.rejects(auth.authenticate(jwt()),{status:401});
    assert.equal(calls,1);assert.equal(auth.current(),null);
  }finally{auth.clear();}
});

test('a successful retry arriving after logout cannot recreate the desktop session',async()=>{
  let resolveProfile;
  const pendingProfile=new Promise(resolve=>{resolveProfile=resolve;});
  let profileRequested;
  const entered=new Promise(resolve=>{profileRequested=resolve;});
  const auth=createDesktopSession({config,now,fetchFn:async url=>{
    if(url.endsWith('/auth/v1/user'))return Response.json({id:userId});
    profileRequested();return pendingProfile;
  }});
  const authenticating=auth.authenticate(jwt());
  await entered;auth.clear();resolveProfile(Response.json([{role:'admin'}]));
  await assert.rejects(authenticating,{status:409});assert.equal(auth.current(),null);
});
