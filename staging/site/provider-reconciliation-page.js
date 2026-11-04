const PROVIDER_RECONCILIATION={generation:0,view:null};
function providerReconciliationCleanup(){PROVIDER_RECONCILIATION.generation++;PROVIDER_RECONCILIATION.view?.dispose();PROVIDER_RECONCILIATION.view=null;}
async function pageProviderReconciliation(){
 providerReconciliationCleanup();const generation=PROVIDER_RECONCILIATION.generation,my=ROUTING,owner=S.session?.user?.id,sessionRevision=S.sessionRevision||0,host=document.querySelector('#page');
 if(!host)return;if(!isAdmin()){host.innerHTML='<p>Rapprochements financiers réservés à l’administrateur.</p>';return;}
 const current=()=>generation===PROVIDER_RECONCILIATION.generation&&my===ROUTING&&owner===S.session?.user?.id&&sessionRevision===(S.sessionRevision||0)&&isAdmin();
 host.innerHTML='<p>Préparation des rapprochements financiers…</p>';
 try{const module=await import('./provider-reconciliation-ui.js');if(!current())return;const snapshotId=new URLSearchParams(location.hash.split('?')[1]||'').get('snapshot');
  PROVIDER_RECONCILIATION.view=module.mountProviderReconciliation({element:host,client:module.createProviderReconciliationClient({supabase:sb}),isCurrent:current,snapshotId});
 }catch{if(current())host.innerHTML='<p>Le module de rapprochement est indisponible.</p>';}
}
