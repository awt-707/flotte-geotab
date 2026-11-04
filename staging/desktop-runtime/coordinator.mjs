const fail=()=>Object.assign(Error('Bail de collecte invalide.'),{code:'DESKTOP_LEASE_INVALID'});
/** All transitions are serialized; cancellation invalidates even a pending claim. */
export function createDesktopCoordinator({rpc,deviceId,getSession,onLeader=async()=>{},onLost=async()=>{},onStatus=()=>{},
  now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,intervalMs=25000}){
  let enabled=false,paused=false,closed=false,revision=0,timer=null,deadlineTimer=null,lease=null,state='paused',tail=Promise.resolve();
  const serial=fn=>{const p=tail.then(fn);tail=p.catch(()=>{});return p;};
  const eligible=()=>!closed&&!paused&&enabled&&getSession()?.role==='admin';
  const status=()=>({state,lease:lease?{fence:lease.fence,expires_at:lease.expires_at}:null});
  const publish=s=>{state=s;onStatus(status());};
  function cancel(){++revision;clearTimer(timer);clearTimer(deadlineTimer);timer=deadlineTimer=null;}
  async function drop(){if(lease){lease=null;await onLost();}}
  async function release(old){if(old)await rpc('desktop_worker_release',{p_device_id:deviceId,p_fence:old.fence}).catch(()=>{});}
  function schedule(){if(eligible()){timer=setTimer(()=>{timer=null;void tick();},intervalMs);timer?.unref?.();}}
  async function step(){
    if(!eligible()){await drop();publish('paused');return;}
    const ticket=revision,start=now();
    try {
      const result=await rpc(lease?'desktop_worker_renew':'desktop_worker_claim',{p_device_id:deviceId,...(lease?{p_fence:lease.fence}:{})});
      const next=result?.lease;
      if(ticket!==revision||!eligible()){if(next?.owned)await release(next);return;}
      if(!next?.owned){await drop();publish('follower');return;}
      // Use the server timestamp only as an upper bound. 70 seconds from request
      // start gives a conservative local deadline within the database's 90s TTL.
      if(!Number.isSafeInteger(next.fence)||next.fence<1||!Number.isFinite(Date.parse(next.expires_at)))throw fail();
      const deadline=Math.min(start+70000,Date.parse(next.expires_at)-5000);
      if(deadline<=now())throw fail();
      const gained=!lease||lease.fence!==next.fence;
      if(gained)await drop();lease=next;
      clearTimer(deadlineTimer);deadlineTimer=setTimer(()=>{
        cancel();const old=lease;lease=null;
        // onLost aborts generation work immediately, before any awaited cleanup.
        const stopping=onLost();publish('unavailable');
        void serial(async()=>{await stopping;await release(old);schedule();});
      },deadline-now());deadlineTimer?.unref?.();
      if(gained)await onLeader(Object.freeze({...next}));
      if(ticket===revision&&eligible())publish('leader');
    }catch{
      await drop();publish('unavailable');
    }finally{if(ticket===revision)schedule();}
  }
  function tick(){clearTimer(timer);timer=null;return serial(step);}
  async function stop({releaseLease=true}={}){
    cancel();const old=lease;lease=null;const stopping=onLost();publish('paused');
    await serial(async()=>{await stopping;if(releaseLease)await release(old);});
  }
  return {status,
    async register(value){
      if(typeof value!=='boolean'||getSession()?.role!=='admin')throw Object.assign(Error('Administrateur requis.'),{status:403});
      await stop();
      await rpc('desktop_worker_register',{p_device_id:deviceId,p_label:'Ludy Desktop',p_enabled:value});
      // A registration may finish while the OS suspends this process. Only
      // resume() may clear that suspension; a late RPC must not restart work.
      enabled=value;if(enabled&&!paused&&!closed)await tick();
    },
    tick,
    async pause(){paused=true;await stop();},
    async resume(){if(closed)return;paused=false;await tick();},
    async close(){closed=true;enabled=false;await stop();},
    async reset(){enabled=false;await stop();}
  };
}
