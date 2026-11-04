/* Earnings is a provider statement, not a sum of estimated ride fares.
 * This reader inspects rendered controls only. It never calls a private Uber API. */
(() => {
 'use strict';
 const VERSION='1.0.0',UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
 const fail=(code,message)=>Object.assign(Error(message),{code});
 const fold=value=>String(value??'').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase().replace(/[’']/g,' ').replace(/\s+/g,' ').trim();
 // Fleet Earnings uses "Net earnings" for a settlement value affected by
 // payouts. Preserve that provider label separately from after-commission net.
 const aliases={revenue:['total earnings','total des revenus','revenus totaux'],gross:['gross earnings','gross fares','revenus bruts'],net:['net earnings after commissions','net after commissions','revenus nets apres commissions'],reported_net_earnings:['net earnings','revenus nets'],cash:['cash collected','especes percues','especes encaissees'],payout:['payout','payouts','versement','versements'],refunds_expenses:['refunds & expenses','refunds and expenses','remboursements et depenses'],adjustments:['payment-page-v2.driver-earnings.adjustment','adjustments','adjustments from previous periods','ajustements des periodes precedentes'],start_balance:['start balance','solde initial'],end_balance:['end balance','solde final'],fare:['fare','net fare','tarif net'],tips:['tips','tip','pourboires'],tolls:['tolls','peages'],bonus:['promotion','promotions','incentives','primes'],taxes:['taxes','tax withholdings','retenues fiscales'],commission:['service fee','service fees','commission','commissions']};
 // Exact untranslated keys observed in Fleet Hub's rendered column headers.
 const driverHeaders=['driver name','chauffeur','nom du chauffeur','payment-page-v2.search.placeholder'];
 const fieldFor=value=>Object.entries(aliases).find(([,names])=>names.includes(fold(value)))?.[0]||null;
 function providerUrl(value,expectedOrganization){
  let url;try{url=new URL(value);}catch{throw fail('source_url','Page Uber invalide.');}
  const match=url.pathname.match(/^\/orgs\/([a-f0-9-]{36})\/(.+?)\/?$/i);
  if(url.origin!=='https://fleethub.uber.com'||url.username||url.password||!match||!UUID.test(match[1])||expectedOrganization&&match[1].toLowerCase()!==String(expectedOrganization).toLowerCase())throw fail('organization_mismatch','La page ne correspond pas à la flotte Uber configurée.');
  return {organizationId:match[1].toLowerCase(),url:url.origin+url.pathname.replace(/\/$/,''),path:match[2]};
 }
 function money(raw,currency){
  if(raw===null||raw===undefined||/^(?:|—|–|-)$/.test(String(raw).trim()))return null;
  if(typeof raw!=='string'||raw.length>100||!/^([A-Z]{3})$/.test(currency||''))throw fail('amount_invalid','Montant ou devise Uber non reconnu.');
  let value=raw.replace(/[\u00a0\u202f]/g,' ').trim(),negative=false;
  const codes=value.match(/\b[A-Z]{3}\b/g)||[];
  if(codes.some(code=>code!==currency)||codes.length>1||/[$€£¥]/.test(value))throw fail('currency_ambiguous','Devise absente ou contradictoire dans le relevé Uber.');
  value=value.replace(new RegExp('\\b'+currency+'\\b'),'').replace(/\s+/g,' ').trim();
  if(/^\(.*\)$/.test(value)){negative=true;value=value.slice(1,-1).trim();}
  if(value.startsWith('-')||value.startsWith('−')){if(negative)throw fail('amount_invalid','Signe du montant Uber ambigu.');negative=true;value=value.slice(1).trim();}
  else if(value.startsWith('+'))value=value.slice(1).trim();
  let normalized;
  if(/^\d+(?:\.\d{1,2})?$/.test(value))normalized=value;
  else if(/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(value))normalized=value.replaceAll(',','');
  else if(/^\d+(?:,\d{1,2})$/.test(value))normalized=value.replace(',','.');
  else if(/^\d{1,3}(?:[ .]\d{3})+(?:,\d{1,2})?$/.test(value))normalized=value.replace(/[ .]/g,'').replace(',','.');
  else if(/^\d{1,3}(?: \d{3})+(?:\.\d{1,2})?$/.test(value))normalized=value.replaceAll(' ','');
  else throw fail('amount_invalid','Format monétaire Uber ambigu.');
  const [whole,fraction='']=normalized.split('.');let minor=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));if(negative)minor=-minor;
  if(minor>BigInt(Number.MAX_SAFE_INTEGER)||minor<BigInt(Number.MIN_SAFE_INTEGER))throw fail('amount_invalid','Montant Uber hors limites.');
  return Number(minor);
 }
 function period(label,{timeZone='Africa/Casablanca'}={}){
  if(timeZone!=='Africa/Casablanca'||!globalThis.LudyMoroccoTime)throw fail('timezone_required','Le fuseau d’affichage Uber doit être confirmé : Africa/Casablanca.');
  const text=String(label??'').replace(/[\u00a0\u202f]/g,' ').replace(/\s+/g,' ').trim();
  const part='(\\d{2})/(\\d{2})/(\\d{4})\\s+(\\d{1,2}):(\\d{2})(?:\\s*(AM|PM))?';
  const match=new RegExp('^'+part+'\\s*[–—-]\\s*'+part+'$','i').exec(text);
  if(!match)throw fail('period_unrecognized','La période Earnings doit contenir deux dates et heures complètes.');
  const instant=offset=>{const day=+match[offset],month=+match[offset+1],year=+match[offset+2];let hour=+match[offset+3];const minute=+match[offset+4],meridiem=match[offset+5]?.toUpperCase();if(meridiem){if(hour<1||hour>12)throw fail('period_unrecognized','Heure Uber invalide.');hour=hour%12+(meridiem==='PM'?12:0);}const at=globalThis.LudyMoroccoTime.moroccoWallTime({year,month,day,hour,minute,second:0});if(at===null)throw fail('period_unrecognized','Date ou heure Uber ambiguë.');return at;};
  const start=instant(1),end=instant(7);if(end<=start||end-start>367*86400000)throw fail('period_unrecognized','Période Earnings incohérente.');
  return {start_at:new Date(start).toISOString(),end_at:new Date(end).toISOString(),label:text,time_zone:timeZone};
 }
 const visible=node=>!!node&&!node.hidden&&!node.closest('[hidden],[aria-hidden="true"]')&&getComputedStyle(node).display!=='none'&&getComputedStyle(node).visibility!=='hidden'&&node.getClientRects().length>0;
 const text=node=>String(node?.innerText??node?.textContent??'').replace(/[\u00a0\u202f]/g,' ').replace(/\s+/g,' ').trim();
 // Observed Fleet Hub accordion: a LI contains one expanded role=button
 // header, then its immediate child LI categories. Nested Fare detail is
 // deliberately excluded; unknown or unreadable immediate children make the
 // proof incomplete instead of silently disappearing from a calculated sum.
 function breakdown(root,currency){
  if(!root||root.tagName!=='LI')return null;
  const header=[...root.children].filter(node=>node.matches('[role="button"]'));
  if(header.length!==1||header[0].getAttribute('aria-expanded')!=='true')return null;
  const children=[...root.querySelectorAll('li')].filter(node=>node.parentElement?.closest('li')===root);
  if(!children.length||children.length>30||children.some(node=>!visible(node)))return {complete:false,entries:[]};
  let complete=true;const entries=children.map(node=>{
   const own=[...node.children].filter(child=>child.matches('[role="button"]'));
   if(own.length!==1||!visible(own[0])){complete=false;return null;}
   const leaves=[...own[0].querySelectorAll('p,span,dt,strong')].filter(child=>!child.children.length&&visible(child));
   const amounts=leaves.filter(child=>{try{return money(text(child),currency)!==null;}catch{return false;}});
   const labels=leaves.filter(child=>!amounts.includes(child)&&text(child));
   if(amounts.length!==1||labels.length!==1){complete=false;return null;}
   const label=text(labels[0]);return {field:fieldFor(label)||'unknown',label,amount:text(amounts[0])};
  }).filter(Boolean);
  return {complete,entries};
 }
 function driverDetails(document,{driver,currency}={}){
  const drawers=[...document.querySelectorAll('[data-baseweb="drawer"]')].filter(visible);
  if(drawers.length!==1)return {pending:true,reason:'drawer_unavailable'};const drawer=drawers[0];
  const leaves=[...drawer.querySelectorAll('*')].filter(node=>node instanceof HTMLElement&&visible(node)&&!node.children.length);
  if(!driver?.driverNameComplete||!leaves.some(node=>text(node)===driver.driverName))return {pending:true,reason:'identity_not_displayed'};
  const metrics={},revenueNodes=[];
  for(const node of leaves){const field=fieldFor(text(node));if(!field)continue;if(field==='revenue')revenueNodes.push(node);
   let parent=node.parentElement;
   for(let level=0;parent&&drawer.contains(parent)&&level<3;level++,parent=parent.parentElement){
    if(text(parent).length>350)break;
    const values=[...parent.querySelectorAll('*')].filter(child=>child instanceof HTMLElement&&!child.children.length&&visible(child)).map(text).filter(value=>{try{return money(value,currency)!==null;}catch{return false;}});
    if(values.length===1){if(metrics[field]!==undefined&&money(metrics[field],currency)!==money(values[0],currency))return {pending:true,reason:'duplicate_financial_field',field};metrics[field]=values[0];break;}if(values.length>1)break;
   }
  }
  const mismatched=['revenue','refunds_expenses','adjustments','payout','reported_net_earnings'].find(field=>metrics[field]===undefined||money(metrics[field],currency)!==money(driver.metrics[field],currency));
  if(mismatched)return {pending:true,reason:'financial_row_mismatch',field:mismatched};
  const root=revenueNodes.length===1?revenueNodes[0].closest('li'):null;
  const header=root&&[...root.children].find(node=>node.matches('[role="button"]'));
  return {metrics,breakdown:breakdown(root,currency),expand:header&&header.getAttribute('aria-expanded')==='false'?header:null};
 }
 function earningsLink(document,url,organizationId){
  providerUrl(url,organizationId);
  const links=[...document.querySelectorAll('a[href]')].filter(visible).filter(node=>['earnings','revenus'].includes(fold(text(node)))).map(node=>{try{const target=new URL(node.getAttribute('href'),url);const parsed=providerUrl(target.href,organizationId);return {node,url:parsed.url};}catch{return null;}}).filter(Boolean);
  const urls=[...new Set(links.map(link=>link.url))];if(urls.length!==1)throw fail('earnings_link_missing','Ouvrez une page de la flotte contenant le lien Earnings visible.');return urls[0];
 }
 function earningsNavigation(document,url,organizationId){
  const source=providerUrl(url,organizationId);
  try{return {href:earningsLink(document,url,organizationId),node:null,current:source.path==='earnings'};}catch(error){if(error.code!=='earnings_link_missing')throw error;}
  // Observed Fleet Hub navigation: a SPAN in a clickable DIV,
  // without an anchor, href or ARIA link role. Follow its normal click only.
  const observed=[...document.querySelectorAll('[role="navigation"] [data-testid="header-nav-/earnings"]')].filter(visible).filter(node=>['earnings','revenus'].includes(fold(text(node))));if(observed.length===1)return {href:null,node:observed[0],current:source.path==='earnings'};
  const nodes=[...document.querySelectorAll('span,button,[role="tab"],[role="link"]')].filter(visible).filter(node=>node.closest('nav,[role="navigation"]')&&['earnings','revenus'].includes(fold(text(node)))&&getComputedStyle(node).cursor==='pointer');
  const leaves=nodes.filter(node=>!nodes.some(other=>other!==node&&node.contains(other)));if(leaves.length!==1)throw fail('earnings_link_missing','Ouvrez une page de la flotte contenant le lien Earnings visible.');
  return {href:null,node:leaves[0],current:source.path==='earnings'};
 }
 function inspect(document,url,{organizationId,timeZone='Africa/Casablanca'}={}){
  const source=providerUrl(url,organizationId),navigation=earningsNavigation(document,url,organizationId);
  if(navigation.href?source.url!==navigation.href:!navigation.current)throw fail('earnings_page_required','Ouvrez la page Earnings de cette flotte.');
  if([...document.querySelectorAll('input[type="password"]')].some(visible))throw fail('session_required','Reconnectez-vous normalement à Uber.');
  const headings=[...document.querySelectorAll('h1,[role="heading"]')].filter(visible).filter(node=>['earnings','revenus'].includes(fold(text(node))));if(headings.length!==1)throw fail('page_unrecognized','Titre Earnings absent ou ambigu.');
  const periods=[...document.querySelectorAll('button,[role="button"],input')].filter(visible).filter(node=>!node.closest('[role="option"],[role="listbox"],[role="menu"]')).map(node=>node.value||text(node)).flatMap(value=>{try{return [period(value,{timeZone})];}catch{return [];}});
  const uniquePeriods=[...new Map(periods.map(value=>[value.start_at+':'+value.end_at,value])).values()];if(!uniquePeriods.length)throw fail('period_missing','Période Earnings non encore affichée.');if(uniquePeriods.length!==1)throw fail('period_unrecognized','Fermez le calendrier Uber : une seule période complète doit être affichée.');
  const periodValue=uniquePeriods[0];
  const candidates=[...document.querySelectorAll('table,[role="table"],[role="grid"]')].filter(visible).filter(table=>[...table.querySelectorAll('th,[role="columnheader"]')].some(header=>driverHeaders.includes(fold(text(header)))));
  if(candidates.length!==1)throw fail('table_unrecognized','Tableau Driver earnings absent ou ambigu.');
  const table=candidates[0],headers=[...table.querySelectorAll('thead th,[role="columnheader"]')].filter(visible),columns=headers.map(header=>fieldFor(text(header))),driverColumn=headers.findIndex(header=>driverHeaders.includes(fold(text(header))));
  if(driverColumn<0||!columns.includes('revenue')||new Set(columns.filter(Boolean)).size!==columns.filter(Boolean).length)throw fail('table_unrecognized','Colonnes financières Uber manquantes ou ambiguës.');
  const currencyCodes=new Set();
  const register=value=>{for(const code of String(value).match(/\b(?:MAD|EUR|USD|GBP|CAD|CHF|AED|SAR|XOF|XAF)\b/g)||[])currencyCodes.add(code);};
  const metricNodes=[...document.querySelectorAll('div,span,p,dt,td,strong')].filter(visible).filter(node=>!table.contains(node)&&!node.closest('nav,[role="navigation"],[data-testid^="header-nav-"]')&&node.children.length===0&&fieldFor(text(node)));
  const fleet={};
  for(const node of metricNodes){const field=fieldFor(text(node));let parent=node.parentElement,value=null;
   for(let level=0;parent&&level<3;level++,parent=parent.parentElement){const content=text(parent);if(content.length>350)break;const leaves=[...parent.querySelectorAll('*')].filter(child=>child.children.length===0&&visible(child)).map(text).filter(value=>/^(?:[−-]\s*)?[A-Z]{3}\s*[+−-]?\s*\d[\d\s.,]*$|^[+−-]?\s*\d[\d\s.,]*\s*[A-Z]{3}$|^\(?[+−-]?\s*\d[\d\s.,]*\)?$/.test(value));const amounts=leaves.length?leaves:content.match(/(?:[−-]\s*)?\b[A-Z]{3}\s*[+−-]?\s*\d[\d\s.,]*|[+−-]?\s*\d[\d\s.,]*\s*\b[A-Z]{3}\b/g)||[];if(amounts.length===1){value=amounts[0].trim();break;}if(amounts.length>1)break;}
   if(value!==null){if(fleet[field]!==undefined&&fleet[field]!==value)throw fail('amount_ambiguous','Plusieurs totaux Uber différents portent le même libellé.');fleet[field]=value;register(value);}
  }
  const bodyRows=[...table.querySelectorAll('tbody tr,[role="row"]')].filter(visible).filter(row=>!row.querySelector('th,[role="columnheader"]'));
  // Fleet Hub disables both pager buttons while rows are loading. An empty
  // rendered grid alone is not proof of a genuinely empty statement.
  if(!bodyRows.length)throw fail('table_loading','Les lignes Earnings ne sont pas encore affichées.');
  if(bodyRows.length>200)throw fail('rows_limit','Trop de lignes sur une page Earnings.');
  const drivers=bodyRows.map(row=>{
   const cells=[...row.querySelectorAll('td,[role="cell"],[role="gridcell"]')].filter(visible);if(cells.length!==headers.length)throw fail('table_unrecognized','Ligne Earnings incomplète.');
   const own=cells[driverColumn],nameNodes=[...own.querySelectorAll('[data-baseweb="typo-labelmedium"]')].filter(visible),full=own.getAttribute('title')||own.querySelector('[title]')?.getAttribute('title')||own.getAttribute('aria-label')||(nameNodes.length===1?text(nameNodes[0]):text(own)),name=String(full).trim();
   if(!name||name.length>200)throw fail('driver_identity','Identité chauffeur illisible.');
   const identities=[...own.querySelectorAll('a[href]')].flatMap(link=>{try{const value=new URL(link.href,url);if(value.origin!=='https://fleethub.uber.com'||!value.pathname.startsWith('/orgs/'+source.organizationId+'/'))return [];const id=value.pathname.match(/\/drivers\/([a-f0-9-]{36})(?:\/|$)/i)?.[1];return id&&UUID.test(id)?[id.toLowerCase()]:[];}catch{return [];}});
   const idSet=[...new Set(identities)];if(idSet.length>1)throw fail('driver_identity','Identité chauffeur ambiguë.');
   const metrics={};for(let index=0;index<columns.length;index++)if(columns[index]){metrics[columns[index]]=text(cells[index]);register(metrics[columns[index]]);}
   return {providerDriverId:idSet[0]||null,driverName:name,driverNameComplete:!/(?:\.{2,}|…)$/.test(name),metrics};
  });
  if(currencyCodes.size===0)throw fail('currency_missing','Devise Earnings non encore affichée.');if(currencyCodes.size!==1)throw fail('currency_ambiguous','Plusieurs devises Earnings sont affichées.');const currency=[...currencyCodes][0];
  const revenueNodes=metricNodes.filter(node=>fieldFor(text(node))==='revenue');
  const fleetBreakdown=revenueNodes.length===1?breakdown(revenueNodes[0].closest('li'),currency):null;
  for(const entry of [fleet,...drivers.map(row=>row.metrics)])for(const value of Object.values(entry))money(value,currency);
  if(fleet.revenue!==undefined&&money(fleet.revenue,currency)===0&&drivers.some(row=>(money(row.metrics.revenue,currency)||0)>0))throw fail('fleet_loading','Les totaux de flotte Uber sont encore à zéro alors que des revenus chauffeur sont affichés.');
  if(!Object.keys(fleet).length&&!drivers.length)throw fail('amount_missing','Aucun montant Earnings reconnu.');
  const controls=[...document.querySelectorAll('button,[role="button"]')].filter(visible),one=names=>{const found=controls.filter(node=>names.includes(fold(node.getAttribute('aria-label')||text(node)).replace(/[‹›«»<>]/g,'').trim()));if(found.length>1)throw fail('pagination_ambiguous','Pagination Earnings ambiguë.');return found[0]||null;};
  const next=one(['next','next page','suivant','page suivante']),previous=one(['prev','previous','previous page','precedent','page precedente']),first=one(['first','first page','premier','premiere page']);
  const disabled=node=>!node||node.disabled||node.getAttribute('aria-disabled')==='true';
  const filtered=[...document.querySelectorAll('input[type="search"],input[placeholder*="Search"],input[placeholder*="Rechercher"],input[placeholder="Driver name"]')].some(node=>visible(node)&&node.value.trim());
  const pagerText=text(table.parentElement),range=pagerText.match(/\b(\d+)\s*[–-]\s*(\d+)\s+(?:of|sur)\s+(\d+)\b/i),totalRows=range?+range[3]:null;
  const download=controls.filter(node=>['download report','telecharger le rapport','telecharger un rapport'].includes(fold(text(node))));
  return {organizationId:source.organizationId,sourceUrl:source.url,providerPeriod:{...periodValue,mode:'provider'},currency,fleet,fleetBreakdown,drivers,filtered,pagination:{first:disabled(previous)&&disabled(first),last:disabled(next),controlsKnown:!!next&&!!previous,totalRows,rangeStart:range?+range[1]:null,rangeEnd:range?+range[2]:null,next,previous,firstControl:first},download:download.length===1?download[0]:null};
 }
 function snapshot(reading,{observedAt=new Date().toISOString(),pages=1,drivers=reading.drivers,complete=false,reason='Page visible uniquement.'}={}){
  return {version:1,source:'uber_fleet_earnings',organizationId:reading.organizationId,sourceUrl:reading.sourceUrl,observedAt,providerPeriod:reading.providerPeriod,currency:reading.currency,fleet:reading.fleet,fleetBreakdown:reading.fleetBreakdown||null,drivers,coverage:{complete,filtered:reading.filtered===true,driverRowsObserved:drivers.length,driverRowsTotal:reading.pagination.totalRows,pages,reason:complete?null:reason}};
 }
 globalThis.LudyUberEarningsReader=Object.freeze({VERSION,FIELDS:Object.keys(aliases),fieldFor,providerUrl,money,period,earningsLink,earningsNavigation,breakdown,driverDetails,inspect,snapshot});
})();
