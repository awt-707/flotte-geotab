import {isTransientDesktopError} from './transport.mjs';
const fail=()=>Object.assign(Error('Bail de collecte invalide.'),{code:'DESKTOP_LEASE_INVALID'});
/** All transitions are serialized; cancellation invalidates even a pending claim. */
export function createDesktopCoordinator({rpc,deviceId,getSession,onLeader=async()=>{},onLost=async()=>{},onStatus=()=>{},onRegistered=async()=>{},
  now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,intervalMs=25000}){
  let enabled=false,paused=false,closed=false,revision=0,registrationRevision=0,registration=null,requestController=null,
    timer=null,deadlineTimer=null,lease=null,leaseDeadline=0,state='paused',tail=Promise.resolve();
  const serial=fn=>{const p=tail.then(fn);tail=p.catch(()=>{});return p;};
  const available=()=>!closed&&!paused&&getSession()?.role==='admin';
  const eligible=()=>available()&&enabled;
  const status=()=>({state,lease:lease?{fence:lease.fence,expires_at:lease.expires_at}:null});
  const publish=s=>{state=s;onStatus(status());};
  function cancel(){++revision;requestController?.abort();requestController=null;clearTimer(timer);clearTimer(deadlineTimer);timer=deadlineTimer=null;}
  async function drop(){clearTimer(deadlineTimer);deadlineTimer=null;leaseDeadline=0;if(lease){lease=null;await onLost();}}
  async function release(old){if(old)await rpc('desktop_worker_release',{p_device_id:deviceId,p_fence:old.fence}).catch(()=>{});}
  function schedule(){if(available()&&(enabled||registration)){timer=setTimer(()=>{timer=null;void tick();},intervalMs);timer?.unref?.();}}
  async function step(){
    if(!available()||!enabled&&!registration){await drop();publish('paused');return;}
    const ticket=revision,restoring=registration,controller=new AbortController();requestController=controller;
    let renewing=false,awaitingLease=false;
    try {
      if(restoring){
        // An automatic recovery must never re-enable a device disabled centrally.
        // An uncertain activation is resolved by reading its state, not replaying it.
        const result=await rpc(restoring.enabled?'desktop_worker_status':'desktop_worker_register',
          {p_device_id:deviceId,...(restoring.enabled?{}:{p_label:'Ludy Desktop',p_enabled:false})},{signal:controller.signal});
        if(ticket!==revision||!available())return;
        if(result?.device?.id!==deviceId||result.device.owner!==true||typeof result.device.enabled!=='boolean')throw fail();
        enabled=restoring.enabled&&result.device.enabled;registration=null;
        await onRegistered(enabled);
        if(ticket!==revision||!available())return;
        if(!enabled){publish('paused');return;}
      }
      const start=now();renewing=!!lease;awaitingLease=true;
      const result=await rpc(renewing?'desktop_worker_renew':'desktop_worker_claim',{p_device_id:deviceId,...(lease?{p_fence:lease.fence}:{})},{signal:controller.signal});
      awaitingLease=false;
      const next=result?.lease;
      if(ticket!==revision||!eligible()){if(next?.owned)await release(next);return;}
      if(!next?.owned){await drop();publish('follower');return;}
      // Use the server timestamp only as an upper bound. 70 seconds from request
      // start gives a conservative local deadline within the database's 90s TTL.
      if(!Number.isSafeInteger(next.fence)||next.fence<1||!Number.isFinite(Date.parse(next.expires_at)))throw fail();
      const deadline=Math.min(start+70000,Date.parse(next.expires_at)-5000);
      if(deadline<=now())throw fail();
      const gained=!lease||lease.fence!==next.fence;
      if(gained)await drop();lease=next;leaseDeadline=deadline;
      clearTimer(deadlineTimer);deadlineTimer=setTimer(()=>{
        cancel();const old=lease;lease=null;leaseDeadline=0;
        // onLost aborts generation work immediately, before any awaited cleanup.
        const stopping=onLost();publish('unavailable');
        void serial(async()=>{await stopping;await release(old);schedule();});
      },deadline-now());deadlineTimer?.unref?.();
      if(gained)await onLeader(Object.freeze({...next}));
      if(ticket===revision&&eligible())publish('leader');
    }catch(error){
      if(ticket!==revision||!available())return;
      // Only an explicitly temporary renewal failure may use the already
      // confirmed lease. Neither its fence nor its existing deadline is extended.
      if(awaitingLease&&renewing&&lease&&leaseDeadline>now()&&isTransientDesktopError(error)){publish('leader');return;}
      if(restoring&&!isTransientDesktopError(error))registration=null;
      await drop();publish('unavailable');
    }finally{if(requestController===controller)requestController=null;if(ticket===revision)schedule();}
  }
  function tick(){clearTimer(timer);timer=null;return serial(step);}
  async function stop({releaseLease=true}={}){
    cancel();const old=lease;lease=null;leaseDeadline=0;const stopping=onLost();publish('paused');
    await serial(async()=>{await stopping;if(releaseLease)await release(old);});
  }
  return {status,
    async restore(value){
      if(typeof value!=='boolean'||getSession()?.role!=='admin')throw Object.assign(Error('Administrateur requis.'),{status:403});
      ++registrationRevision;enabled=false;registration={enabled:value};await stop();await tick();
    },
    async register(value){
      if(typeof value!=='boolean'||getSession()?.role!=='admin')throw Object.assign(Error('Administrateur requis.'),{status:403});
      const ticket=++registrationRevision;registration=null;enabled=false;
      await stop();
      await rpc('desktop_worker_register',{p_device_id:deviceId,p_label:'Ludy Desktop',p_enabled:value});
      // A registration may finish while the OS suspends this process. Only
      // resume() may clear that suspension; a late RPC must not restart work.
      if(ticket!==registrationRevision||closed)return;
      enabled=value;if(enabled&&!paused)await tick();
    },
    tick,
    async pause(){paused=true;await stop();},
    async resume(){if(closed)return;paused=false;await tick();},
    async close(){closed=true;++registrationRevision;registration=null;enabled=false;await stop();},
    async reset(){++registrationRevision;registration=null;enabled=false;await stop();}
  };
}
