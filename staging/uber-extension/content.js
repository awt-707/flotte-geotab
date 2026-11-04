(() => {
  'use strict';
  const VERSION='0.6.6',previous=globalThis.__ludyUberCollector;
  if(previous?.version===VERSION)return;
  // Old injected listeners cannot be removed without their original callback.
  // Require one page reload instead of running two collectors in the same tab.
  if(previous&&!previous.dispose)throw Error('Rechargez la page Uber pour appliquer la nouvelle extension.');
  previous?.dispose?.();
  const api=globalThis.browser || globalThis.chrome;
  let runId=null,timer=null,job=null,refreshPending=false,lastInteractionAt=0;
  const canRefresh=()=>document.visibilityState==='visible'&&Date.now()-lastInteractionAt>=5000;
  function resume(){refreshPending=false;if(runId&&!timer)timer=setInterval(read,15000);}
  function refreshReady(){
    if(!refreshPending||job||!runId)return;
    if(!canRefresh()){resume();return;}
    void api.runtime.sendMessage({type:'LUDY_UBER_REFRESH_READY',runId}).catch(()=>{});
  }
  async function read() {
    if(!runId||job||refreshPending)return;
    const current=runId,task={abort:new AbortController()};job=task;let deadline;
    try{
      const result=await globalThis.LudyUberScanner.scan({signal:task.abort.signal});
      if(task.abort.signal.aborted||runId!==current||job!==task)return;
      const reply=await Promise.race([api.runtime.sendMessage({type:'LUDY_UBER_READ',runId:current,result}),new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('Lecture locale sans réponse.')),12000);})]);
      if(runId===current&&reply?.ok&&reply.data?.active===false)stop();
    }catch{}finally{clearTimeout(deadline);if(job===task)job=null;refreshReady();}
  }
  function stop(){clearInterval(timer);timer=null;runId=null;refreshPending=false;job?.abort.abort();job=null;}
  function onMessage(message,sender,respond){
    if(sender.id!==api.runtime.id)return false;
    if(message?.type==='LUDY_UBER_START'&&typeof message.runId==='string'){
      stop();runId=message.runId;timer=setInterval(read,15000);void read();respond({ok:true});return false;
    }
    if(message?.type==='LUDY_UBER_STOP'){stop();respond({ok:true});}
    if(message?.type==='LUDY_UBER_PING')respond({running:!!runId,runId,version:VERSION,busy:!!job,refreshPending});
    if(message?.type==='LUDY_UBER_SCAN'){void read();respond({ok:true});}
    if(message?.type==='LUDY_UBER_PREPARE_REFRESH'&&message.runId===runId&&runId){
      if(!canRefresh()){resume();respond({ok:true,runId,version:VERSION,ready:false,reason:'not_available'});return false;}
      refreshPending=true;clearInterval(timer);timer=null;
      respond({ok:true,runId,version:VERSION,ready:!job,busy:!!job});return false;
    }
    if(message?.type==='LUDY_UBER_CANCEL_REFRESH'&&message.runId===runId&&runId){resume();respond({ok:true});}
    return false;
  }
  const onVisibility=()=>{
    if(document.visibilityState!=='visible'){job?.abort.abort();job=null;if(refreshPending)resume();}
    // A fresh hidden-page result suspends the local source immediately. The
    // cancelled sweep can never publish its earlier, now invisible rows.
    if(runId)void read();
  };
  const onPageHide=()=>{if(runId)void api.runtime.sendMessage({type:'LUDY_UBER_CLOSED',runId}).catch(()=>{});stop();};
  const onInteraction=event=>{if(event.isTrusted){lastInteractionAt=Date.now();if(refreshPending&&!job)resume();}};
  api.runtime.onMessage.addListener(onMessage);
  document.addEventListener('visibilitychange',onVisibility);
  document.addEventListener('pointerdown',onInteraction,true);document.addEventListener('keydown',onInteraction,true);document.addEventListener('wheel',onInteraction,{passive:true,capture:true});
  addEventListener('pagehide',onPageHide);
  globalThis.__ludyUberCollector={version:VERSION,dispose(){stop();api.runtime.onMessage.removeListener(onMessage);document.removeEventListener('visibilitychange',onVisibility);document.removeEventListener('pointerdown',onInteraction,true);document.removeEventListener('keydown',onInteraction,true);document.removeEventListener('wheel',onInteraction,true);removeEventListener('pagehide',onPageHide);}};
})();
