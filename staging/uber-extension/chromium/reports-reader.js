/* Reads only the Reports UI selected by the operator. No private Uber endpoint
 * is reconstructed; generation is the normal, visible form action. */
(() => {
 'use strict';
 const VERSION='0.6.6',UUID='[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}';
 const normalize=value=>String(value||'').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase().replace(/\s+/g,' ').trim();
 const reportLabels={trip_activity:['trip activity','trip history','activite liee aux courses','activite des courses','historique des courses'],driver_activity:['driver activity','activite des chauffeurs','activite des conducteurs'],driver_quality:['driver quality','qualite des chauffeurs','qualite des conducteurs']};
 function permittedUrl(value){try{const url=new URL(value);return url.origin==='https://fleethub.uber.com'&&!url.username&&!url.password&&new RegExp('^/orgs/('+UUID+')/reports/?$','i').test(url.pathname);}catch{return false;}}
 function organizationId(value){return permittedUrl(value)?new URL(value).pathname.split('/')[2].toLowerCase():null;}
 function visible(node){if(!node||node.hidden||node.closest('[hidden],[aria-hidden="true"]'))return false;const css=node.ownerDocument.defaultView.getComputedStyle(node);return css.display!=='none'&&css.visibility!=='hidden'&&node.getClientRects().length>0;}
 const text=node=>normalize(node?.innerText||node?.textContent||node?.getAttribute('aria-label'));
 function period(config){if(!config||!/^\d{4}-\d{2}-\d{2}$/.test(config.start_date)||!/^\d{4}-\d{2}-\d{2}$/.test(config.end_date))throw Error('Période du rapport non configurée.');const start=Date.parse(config.start_date),end=Date.parse(config.end_date);if(!Number.isFinite(start)||!Number.isFinite(end)||end<start||end-start>31*86400000||new Date(start).toISOString().slice(0,10)!==config.start_date||new Date(end).toISOString().slice(0,10)!==config.end_date)throw Error('Période du rapport invalide.');return config.start_date+':'+config.end_date;}
 const reportEndDate=config=>config.end_exclusive===true?new Date(Date.parse(config.end_date)+86400000).toISOString().slice(0,10):config.end_date;
 function rowPeriodMatches(row,config){
  let value=typeof row==='string'?normalize(row):text(row);
  if(typeof row!=='string'){
   const table=row?.closest('table,[role="table"],[role="grid"]'),headers=table?[...table.querySelectorAll('th,[role="columnheader"]')]:[],indexes=headers.map((node,index)=>['report time range','periode du rapport','plage horaire du rapport'].includes(text(node))?index:-1).filter(index=>index>=0);
   // The visible range changes with the browser timezone. A report filename
   // can retain different dates and must never override this authoritative cell.
   if(indexes.length>1)return false;
   if(indexes.length===1){const cells=[...row.querySelectorAll('td,[role="cell"],[role="gridcell"]')];if(!cells[indexes[0]])return false;value=text(cells[indexes[0]]);}
  }
  const dates=[...value.matchAll(/\b(?:\d{4}[-/]\d{2}[-/]\d{2}|\d{2}[-/]\d{2}[-/]\d{4}|\d{8})\b/g)].map(match=>{if(/^\d{8}$/.test(match[0]))return match[0].slice(0,4)+'-'+match[0].slice(4,6)+'-'+match[0].slice(6);const a=match[0].split(/[-/]/);if(a[0].length===4)return a.join('-');return config.date_format==='mdy'?[a[2],a[0],a[1]].join('-'):config.date_format==='dmy'?[a[2],a[1],a[0]].join('-'):null;});
  const months=['january','february','march','april','may','june','july','august','september','october','november','december'],m=value.match(new RegExp('^('+months.join('|')+') (\\d{1,2})(?:,? (\\d{4}))?\\s*[-–—]\\s*(?:('+months.join('|')+') )?(\\d{1,2}),? (\\d{4})$'));
  if(m){const firstMonth=months.indexOf(m[1])+1,lastMonth=months.indexOf(m[4]||m[1])+1,lastYear=+m[6],firstYear=m[3]?+m[3]:lastYear-(firstMonth>lastMonth?1:0),iso=(year,month,day)=>String(year)+'-'+String(month).padStart(2,'0')+'-'+String(day).padStart(2,'0');dates.push(iso(firstYear,firstMonth,+m[2]),iso(lastYear,lastMonth,+m[5]));}
  return dates.some((date,index)=>date===config.start_date&&dates[index+1]===reportEndDate(config));
 }

 function downloadURL(value,page){try{const url=new URL(value,page);if(url.protocol==='blob:'&&url.origin==='https://fleethub.uber.com')return url.href;if(url.origin==='https://fleethub.uber.com'&&url.protocol==='https:'&&!url.username&&!url.password)return url.href;}catch{}return null;}
 const CONTROL='input:not([type="hidden"]),select,[role="combobox"],[data-baseweb="select"],[aria-haspopup="listbox"],button,[role="button"][aria-haspopup]';
 const SELECT_CONTROL='select,input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]),[role="combobox"],[data-baseweb="select"],[aria-haspopup="listbox"],button,[role="button"][aria-haspopup]';
 const ORGANIZATION_CONTROL='select,input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]),[role="combobox"],[data-baseweb="select"],[aria-haspopup="listbox"],[role="button"][aria-haspopup]';
 const FIELD_LABELS={report_type:['report type','type de rapport'],start_date:['start of report','start date','from','debut du rapport','date de debut'],end_date:['end of report','end date','until','fin du rapport','date de fin'],start_time:['start time','heure de debut'],end_time:['end time','heure de fin'],organization:['select organizations to include in report','organizations','organisation','organisations','selectionner les organisations a inclure dans le rapport']};
 const exact=value=>String(value||'').normalize('NFC').replace(/\s+/g,' ').trim().toLowerCase();
 const enabled=node=>node&&!node.disabled&&node.getAttribute('aria-disabled')!=='true';
 function named(node){
  const doc=node.ownerDocument,refs=(node.getAttribute('aria-labelledby')||'').split(/\s+/).filter(Boolean).map(id=>doc.getElementById(id)?.textContent||'').join(' ');
  return normalize(node.getAttribute('aria-label')||refs||[...doc.querySelectorAll('label')].filter(label=>label.htmlFor===node.id&&node.id||label.contains(node)).map(label=>label.textContent).join(' ')||node.name||node.id);
 }
 function controlsFor(doc,names,selector=CONTROL){
  const result=new Set([...doc.querySelectorAll(selector)].filter(node=>visible(node)&&names.includes(named(node))));
  if(result.size)return [...result].filter(node=>![...result].some(other=>other!==node&&other.contains(node)));
  // Several Uber fields have a visible sibling label without a label/for pair.
  // A label is usable only when its nearest container identifies one control.
  for(const label of doc.querySelectorAll('label,span,p,div,b,strong,legend')){
   if(!visible(label)||!names.includes(text(label)))continue;
   // Uber also renders labels and controls as successive siblings directly in
   // the drawer. Associate only the next unambiguous control before any other
   // known field label, rather than treating the entire drawer as one field.
   let caption=label;for(let depth=0;depth<3&&caption.parentElement&&caption.parentElement!==doc&&names.includes(text(caption.parentElement))&&![...caption.parentElement.querySelectorAll(selector)].some(visible);depth++)caption=caption.parentElement;
   for(let sibling=caption.nextElementSibling,step=0;sibling&&step<4;step++,sibling=sibling.nextElementSibling){
    if(!visible(sibling))continue;
    const nextLabels=[sibling,...sibling.querySelectorAll('label,span,p,div,b,strong,legend')].filter(visible).map(text);if(nextLabels.some(value=>Object.values(FIELD_LABELS).flat().includes(value)&&!names.includes(value)))break;
    const nodes=[...(sibling.matches(selector)?[sibling]:[]),...sibling.querySelectorAll(selector)].filter(visible),outer=nodes.filter(node=>!nodes.some(other=>other!==node&&other.contains(node)));
    if(outer.length===1)result.add(outer[0]);if(outer.length)break;
   }
   let parent=label.parentElement;
   for(let depth=0;parent&&depth<5;depth++,parent=parent.parentElement){
    const nodes=[...parent.querySelectorAll(selector)].filter(visible),outer=nodes.filter(node=>!nodes.some(other=>other!==node&&other.contains(node)));
    if(outer.length===1){result.add(outer[0]);break;}if(outer.length>1||parent===doc)break;
   }
  }
  return [...result].filter(node=>![...result].some(other=>other!==node&&other.contains(node)));
 }
 function onlyControl(doc,names,selector,required=false){const nodes=controlsFor(doc,names,selector);if(nodes.length>1||required&&nodes.length!==1)throw Error('Champ Rapports ambigu ou absent : '+names[0]+'.');return nodes[0]||null;}
 const fieldValue=node=>String(node&&['INPUT','SELECT','TEXTAREA'].includes(node.tagName)?node.value:node?.innerText||node?.textContent||'').trim();
 function dateValue(node){const value=fieldValue(node),match=value.match(/^(\d{4})[-/](\d{2})[-/](\d{2})$/);return match?match.slice(1).join('-'):null;}
 const timeValue=node=>{const values=node?.tagName==='SELECT'?[node.selectedOptions?.[0]?.textContent]:controlValues(node),times=[...new Set(values.map(normalize).map(value=>value.replace(/\s/g,'')).filter(value=>/^\d{1,2}:\d{2}(?::\d{2})?(?:[ap]m)?$/.test(value)))];return times.length===1?times[0]:null;};
 function controlValues(control){
  const values=new Set([fieldValue(control),control?.getAttribute('aria-valuetext')||'']),component=control.closest('[data-baseweb="select"]');let parent=control;
  if(control.matches('button,[role="button"]')||control.tagName==='INPUT'&&control.getAttribute('role')!=='combobox'&&!component)return [...values].filter(Boolean);
  for(let depth=0;parent&&depth<4;depth++,parent=parent.parentElement){
   if(parent.matches('body,main,form,[role="dialog"],aside'))break;
   const found=[...parent.querySelectorAll('[role="combobox"],select')],combos=found.filter(node=>!found.some(other=>other!==node&&other.contains(node)));if(combos.length>1)break;
   for(const node of parent.querySelectorAll('div,span'))if(visible(node)&&!node.closest('[role="listbox"],[role="option"],[role="menu"],[role="checkbox"]')&&!node.closest('label')?.querySelector('input[type="checkbox"]')&&node.children.length===0){const value=fieldValue(node);if(value.length<=160)values.add(value);}
   if(parent===component)break;
  }
  return [...values].filter(Boolean);
 }
 const matchesControl=(control,labels,fold=exact)=>controlValues(control).some(value=>labels.includes(fold(value)));
 function selectedReportType(control){
  const values=(control.tagName==='SELECT'?[control.selectedOptions?.[0]?.textContent]:controlValues(control)).map(normalize),types=Object.keys(reportLabels).filter(type=>reportLabels[type].some(label=>values.includes(label)));
  if(types.length>1)throw Error('Sélecteur de rapport ambigu : plusieurs types sont affichés comme sélectionnés.');return types[0]||null;
 }
 function reportSelected(form,config){return selectedReportType(form.select)===(config.report_type||'trip_activity');}
 function reportControlFallback(root,labels){
  const nodes=[...root.querySelectorAll('select,input:not([type="hidden"]),[role="combobox"],[data-baseweb="select"]')].filter(visible),outer=nodes.filter(node=>!nodes.some(other=>other!==node&&other.contains(node)));
  return outer.filter(node=>{
   if(node.tagName==='SELECT')return [...node.options].some(option=>labels.includes(normalize(option.textContent)));
   // A free text/search field is not evidence of the selected report type.
   if(node.tagName==='INPUT'&&!node.readOnly&&node.getAttribute('role')!=='combobox'&&!node.closest('[data-baseweb="select"]'))return false;
   return selectedReportType(node)!==null;
  });
 }
 function formScope(doc){
  const isGenerate=node=>['generate','generer','generer le rapport'].includes(normalize(node.value||node.innerText||node.textContent||node.getAttribute('aria-label'))),buttons=[...doc.querySelectorAll('button,[role="button"],input[type="submit"]')].filter(node=>visible(node)&&isGenerate(node));
  const dialogs=[...doc.querySelectorAll('[role="dialog"],[aria-modal="true"],dialog[open]')].filter(node=>visible(node)&&buttons.some(button=>node.contains(button)));
  if(dialogs.length===1)return {root:dialogs[0],kind:'dialog'};
  if(buttons.length===1){let node=buttons[0].parentElement;for(;node&&node!==doc.body;node=node.parentElement){const words=text(node);if(['report type','start of report','end of report'].every(label=>words.includes(label)))return {root:node,kind:'drawer'};}}
  return {root:doc,kind:'document'};
 }
 function organizationSelected(form,config){
  if(!form.organization)return true;
  const org=config.organization_id.toLowerCase(),label=exact(config.organization_label);
  if(form.organization.tagName==='SELECT'){const selected=[...form.organization.selectedOptions];return selected.length===1&&(selected[0].value.toLowerCase()===org||label&&exact(selected[0].textContent)===label);}
  return !!label&&matchesControl(form.organization,[label]);
 }
 function inspect(doc,url,config){
  const org=organizationId(url);if(!org||org!==String(config.organization_id||'').toLowerCase())throw Error('Ouvrez les rapports de la flotte configurée dans Ludy.');period(config);
  const labels=reportLabels[config.report_type||'trip_activity'];if(!labels)throw Error('Type de rapport non pris en charge.');const reportTypes=new Set(labels);
  if(doc.querySelector('input[type="password"]'))throw Error('Reconnectez-vous à Uber dans cet onglet.');
  const candidates=[];let blockedDownload=false;
  for(const link of doc.querySelectorAll('a[href]')){
   if(!visible(link)||!(/^(download|telecharger)(\b|\s|$)/.test(text(link))||link.hasAttribute('download')))continue;
   const row=link.closest('tr,[role="row"],li,article,[data-report-id]');if(!row||!visible(row))continue;const label=text(row);if(label.length>2500||![...reportTypes].some(type=>label.includes(type))||!rowPeriodMatches(row,config))continue;
   const href=downloadURL(link.getAttribute('href'),url);if(!href){blockedDownload=true;continue;}candidates.push({node:link,url:href});
  }
  if(candidates.length===1)return {status:'download',download:candidates[0],organizationId:org};
  if(candidates.length>1)throw Error('Plusieurs exports de cette période sont visibles. Gardez un seul rapport d’activité sélectionné.');
  if(blockedDownload)throw Error('Le lien d’export utilise un autre domaine. Ce téléchargement nécessite une configuration du navigateur ; aucune autorisation n’est contournée.');
  for(const button of doc.querySelectorAll('button,[role="button"]')){
   if(!visible(button)||!['download','telecharger'].includes(text(button)))continue;
   const row=button.closest('tr,[role="row"],li,article,[data-report-id]'),label=row&&text(row);
   if(label&&label.length<=2500&&labels.some(type=>label.includes(type))&&rowPeriodMatches(row,config))throw Error('Le rapport exact est prêt, mais Uber affiche un bouton Download sans lien lisible. Aucune nouvelle génération demandée.');
  }
  const scope=formScope(doc),root=scope.root;
  let selects=controlsFor(root,['report type','type de rapport'],SELECT_CONTROL);
  if(!selects.length)selects=reportControlFallback(root,labels);
  const start=onlyControl(root,['start of report','start date','from','debut du rapport','date de debut'],'input:not([type="hidden"])'),end=onlyControl(root,['end of report','end date','until','fin du rapport','date de fin'],'input:not([type="hidden"])');
  const buttons=[...root.querySelectorAll('button,[role="button"],input[type="submit"]')].filter(visible),generates=buttons.filter(button=>['generate','generer','generer le rapport'].includes(normalize(button.value||button.innerText||button.textContent||button.getAttribute('aria-label'))));
  if(!selects.length&&!start&&!end&&!doc.querySelector('[role="dialog"],dialog[open]')){
   const openers=buttons.filter(button=>enabled(button)&&['generate report','creer un rapport'].includes(text(button)));
   const page=text(doc.body),hasTable=['report name','report type','report time range','generated on'].every(label=>page.includes(label));
   if(openers.length===1&&hasTable)return {status:'landing',organizationId:org,open:openers[0]};
  }
  if(selects.length!==1||!start||!end||start===end||generates.length!==1)throw Error('Formulaire Rapports non reconnu. Ouvrez Generate Report ; le type, les dates et le bouton Generate doivent être visibles.');
  const select=selects[0],options=select.tagName==='SELECT'?[...select.options].filter(option=>reportTypes.has(normalize(option.textContent))):[];
  if(select.tagName==='SELECT'&&options.length!==1)throw Error('Le type de rapport demandé est absent ou ambigu dans Uber.');
  const startTime=onlyControl(root,['start time','heure de debut']),endTime=onlyControl(root,['end time','heure de fin']);
  const hasTimeLabels=[...root.querySelectorAll('label,span,p,div,b,strong,legend')].some(node=>visible(node)&&[...FIELD_LABELS.start_time,...FIELD_LABELS.end_time].includes(text(node)));
  if(!!startTime!==!!endTime||hasTimeLabels&&(!startTime||!endTime))throw Error('Les heures de début et de fin ne sont pas identifiables.');
  const organization=onlyControl(root,['select organizations to include in report','organizations','organisation','organisations','selectionner les organisations a inclure dans le rapport'],ORGANIZATION_CONTROL);
  if(!organization&&(startTime||text(doc.body).includes('select organizations to include in report')))throw Error('Champ Rapports absent : select organizations to include in report.');
  return {status:'form',organizationId:org,select,option:options[0]||null,start,end,startTime,endTime,organization,generate:generates[0]};
 }
 function setValue(input,value){if(input.value===value)return;if(!enabled(input)||input.readOnly)throw Error('Ce champ Uber se règle dans son calendrier : choisissez la période demandée dans Ludy.');const view=input.ownerDocument.defaultView,prototype=input.tagName==='SELECT'?view.HTMLSelectElement.prototype:view.HTMLInputElement.prototype;input.focus({preventScroll:true});Object.getOwnPropertyDescriptor(prototype,'value').set.call(input,value);input.dispatchEvent(new view.Event('input',{bubbles:true}));input.dispatchEvent(new view.Event('change',{bubbles:true}));input.blur();}
 function prepare(form,config){if(form.option)setValue(form.select,form.option.value);for(const [input,date]of [[form.start,config.start_date],[form.end,reportEndDate(config)]]){if(dateValue(input)!==date)setValue(input,input.type==='date'?date:/^\d{4}\//.test(input.value)||/yyyy\/mm\/dd/i.test(input.placeholder)?date.replaceAll('-','/'):date);}}
 async function waitFor(read,{signal,timeout=3500}={}){const until=Date.now()+timeout;for(;;){if(signal?.aborted)throw Error('Lecture interrompue.');const value=read();if(value)return value;if(Date.now()>=until)throw Error('Le contrôle Uber ne s’est pas ouvert. Réessayez avec le formulaire visible.');await new Promise(resolve=>setTimeout(resolve,100));}}
 function optionScope(control){control=control.querySelector?.('[role="combobox"],[aria-controls],[aria-owns]')||control;const doc=control.ownerDocument,ids=(control.getAttribute('aria-controls')||control.getAttribute('aria-owns')||'').split(/\s+/).filter(Boolean),linked=ids.map(id=>doc.getElementById(id)).filter(visible);if(linked.length===1)return linked[0];const popups=[...doc.querySelectorAll('[role="listbox"],[role="menu"]')].filter(visible);return popups.length===1?popups[0]:null;}
 async function choose(control,labels,{signal,organizationId=null}={}){
  if(control.tagName==='SELECT'){
   const options=[...control.options].filter(option=>organizationId&&option.value.toLowerCase()===organizationId||labels.includes(exact(option.textContent)));
   if(options.length!==1||control.multiple||!enabled(options[0]))throw Error('Choix Uber absent ou ambigu ; aucune sélection automatique effectuée.');setValue(control,options[0].value);return;
  }
  if(matchesControl(control,labels))return;
  if(!enabled(control))throw Error('Le sélecteur Uber est indisponible.');(control.querySelector?.('[role="combobox"],input,button')||control).click();
  const option=await waitFor(()=>{const scope=optionScope(control);if(!scope)return null;const options=[...scope.querySelectorAll('[role="option"],li,button')].filter(node=>visible(node)&&labels.includes(exact(node.innerText||node.textContent))),leaves=options.filter(node=>!options.some(other=>other!==node&&node.contains(other)));if(leaves.length>1)throw Error('Plusieurs options Uber portent ce libellé.');return leaves[0];},{signal});
  if(!enabled(option))throw Error('Le type de rapport est indisponible.');option.click();await new Promise(resolve=>setTimeout(resolve,120));
 }
 async function chooseOrganization(form,config,{signal}={}){
  const control=form.organization;if(!control||organizationSelected(form,config))return;
  const label=exact(config.organization_label),org=config.organization_id.toLowerCase();
  if(control.tagName==='SELECT')return choose(control,label?[label]:[],{signal,organizationId:org});
  if(!label)throw Error('Renseignez dans Ludy le nom exact de l’organisation affichée dans le sélecteur Uber.');
  const doc=control.ownerDocument;
  const candidates=()=>[...doc.querySelectorAll('input[type="checkbox"],[role="checkbox"]')].filter(visible).map(node=>({node,label:exact(node.getAttribute('aria-label')||[...doc.querySelectorAll('label')].filter(l=>l.htmlFor===node.id&&node.id||l.contains(node)).map(l=>l.textContent).join(' ')||node.parentElement?.innerText)}));
  if(!candidates().length){if(!enabled(control))throw Error('Le choix de l’organisation Uber est indisponible.');control.click();}
  const choice=await waitFor(()=>{const choices=candidates().filter(item=>item.node.value?.toLowerCase()===org||item.label===label);if(choices.length>1)throw Error('Plusieurs organisations Uber portent le nom configuré.');return choices[0];},{signal});
  const checked=node=>node.checked===true||node.getAttribute('aria-checked')==='true';
  if(candidates().some(item=>item.node!==choice.node&&checked(item.node)))throw Error('Une autre organisation est sélectionnée dans Uber. Gardez uniquement la flotte configurée dans Ludy.');
  if(!checked(choice.node)){if(!enabled(choice.node))throw Error('Organisation Uber indisponible.');choice.node.click();}
  await new Promise(resolve=>setTimeout(resolve,150));
  // Close the normal selector after its visible checkbox action; never select all.
  const current=onlyControl(formScope(doc).root,['select organizations to include in report','organizations','organisation','organisations','selectionner les organisations a inclure dans le rapport'],ORGANIZATION_CONTROL);
  if(current&&candidates().length)current.click();
 }
 function exposed(node){if(!visible(node))return false;const r=node.getBoundingClientRect(),doc=node.ownerDocument,x=r.left+r.width/2,y=r.top+r.height/2;if(x<0||y<0||x>=doc.defaultView.innerWidth||y>=doc.defaultView.innerHeight)return false;const top=doc.elementFromPoint(x,y);return !!top&&(top===node||node.contains(top));}
 function calendars(doc){return [...doc.querySelectorAll('[data-baseweb="calendar"][role="dialog"]')].filter(exposed);}
 function calendarDay(node){const m=(node.getAttribute('aria-label')||'').match(/\b(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2})(?:st|nd|rd|th)? (\d{4})\b/);if(!m)return null;const month=['January','February','March','April','May','June','July','August','September','October','November','December'].indexOf(m[1])+1;return m[3]+'-'+String(month).padStart(2,'0')+'-'+m[2].padStart(2,'0');}
 async function chooseCalendarDay(doc,date,{signal}={}){
  for(let step=0;step<4;step++){
   if(signal?.aborted)throw Error('Lecture interrompue.');const shown=calendars(doc);if(shown.length!==1)throw Error('Champ Rapports absent ou ambigu : calendrier.');const root=shown[0],cells=[...root.querySelectorAll('[role="gridcell"]')].filter(visible),matches=cells.filter(node=>calendarDay(node)===date&&exposed(node));
   if(matches.length>1)throw Error('Champ Rapports absent ou ambigu : date du calendrier.');
   if(matches.length===1){const choice=matches[0];if(!enabled(choice)||!/It.s available\.$/.test(choice.getAttribute('aria-label')||''))throw Error('Ce champ Uber se règle dans son calendrier : la date demandée est indisponible.');choice.click();await new Promise(resolve=>setTimeout(resolve,150));return;}
   const dates=cells.map(calendarDay).filter(Boolean).sort();if(!dates.length)throw Error('Champ Rapports absent ou ambigu : mois du calendrier.');const direction=date<dates[0]?'previous month.':'next month.',buttons=[...root.querySelectorAll('button')].filter(node=>exposed(node)&&exact(node.getAttribute('aria-label'))===direction&&enabled(node));if(buttons.length!==1)throw Error('Champ Rapports absent ou ambigu : navigation du calendrier.');buttons[0].click();await new Promise(resolve=>setTimeout(resolve,150));
  }
  throw Error('Ce champ Uber se règle dans son calendrier : période hors des mois accessibles.');
 }
 async function prepareDates(form,config,{signal,onStep}={}){
  const doc=form.start.ownerDocument,url=doc.location.href,end=reportEndDate(config);
  if(dateValue(form.start)===config.start_date&&dateValue(form.end)===end)return form;
  onStep?.('start_date');form.start.focus({preventScroll:true});form.start.click();for(let n=0;n<8&&!calendars(doc).length;n++){if(signal?.aborted)throw Error('Lecture interrompue.');await new Promise(resolve=>setTimeout(resolve,75));}
  if(calendars(doc).length){
   await chooseCalendarDay(doc,config.start_date,{signal});form=inspect(doc,url,config);onStep?.('end_date');
   if(!calendars(doc).length){form.end.focus({preventScroll:true});form.end.click();await waitFor(()=>calendars(doc).length,{signal,timeout:1500});}
   await chooseCalendarDay(doc,end,{signal});return inspect(doc,url,config);
  }
  for(const [key,date]of [['start',config.start_date],['end',end]]){onStep?.(key==='start'?'start_date':'end_date');const input=form[key];if(dateValue(input)!==date)setValue(input,input.type==='date'?date:/^\d{4}\//.test(input.value)||/yyyy\/mm\/dd/i.test(input.placeholder)?date.replaceAll('-','/'):date);await new Promise(resolve=>setTimeout(resolve,120));if(signal?.aborted)throw Error('Lecture interrompue.');form=inspect(doc,url,config);}
  return form;
 }
 async function prepareForm(form,config,{signal,onStep=()=>{}}={}){
  const doc=form.start.ownerDocument,url=doc.location.href;
  onStep('report_type');
  selectedReportType(form.select);
  await choose(form.select,reportLabels[config.report_type||'trip_activity'].map(exact),{signal});
  // React may replace controls after any selection. Always reacquire the live
  // controls before the next field instead of writing to detached elements.
  await new Promise(resolve=>setTimeout(resolve,120));form=inspect(doc,url,config);
  form=await prepareDates(form,config,{signal,onStep});
  if(form.startTime){onStep('start_time');await chooseTime(form.startTime,true,{signal});await new Promise(resolve=>setTimeout(resolve,120));form=inspect(doc,url,config);onStep('end_time');await chooseTime(form.endTime,config.end_exclusive===true,{signal});await new Promise(resolve=>setTimeout(resolve,120));form=inspect(doc,url,config);}
  onStep('organization');await chooseOrganization(form,config,{signal});await new Promise(resolve=>setTimeout(resolve,250));
  onStep('verify');
  const current=inspect(doc,url,config);verify(current,config);return current;
 }
 async function chooseTime(control,start,{signal}={}){
  const values=start?['00:00','00:00:00','12:00am']:['23:59','23:59:00','11:59pm'];if(values.includes(timeValue(control)))return;
  const labels=start?['12:00 am','00:00']:['11:59 pm','23:59'];
  if(control.tagName==='INPUT'&&control.getAttribute('role')!=='combobox'){setValue(control,control.type==='time'?start?'00:00':'23:59':labels[0]);return;}
  await choose(control,labels,{signal});
 }
 function verification(form,config){return {report_type:form.status==='form'&&reportSelected(form,config),start_date:dateValue(form.start)===config.start_date,end_date:dateValue(form.end)===reportEndDate(config),start_time:!form.startTime||['00:00','00:00:00','12:00am'].includes(timeValue(form.startTime)),end_time:!form.endTime||(config.end_exclusive===true?['00:00','00:00:00','12:00am']:['23:59','23:59:00','11:59pm']).includes(timeValue(form.endTime)),organization:organizationSelected(form,config),generate_enabled:!!enabled(form.generate)};}
 function verify(form,config){
  if(form.status!=='form'||!reportSelected(form,config)||dateValue(form.start)!==config.start_date||dateValue(form.end)!==reportEndDate(config)||!enabled(form.generate))throw Error('Vérifiez le type de rapport, les dates et l’organisation avant de générer.');
  if(form.startTime&&(!['00:00','00:00:00','12:00am'].includes(timeValue(form.startTime))||!(config.end_exclusive===true?['00:00','00:00:00','12:00am']:['23:59','23:59:00','11:59pm']).includes(timeValue(form.endTime))))throw Error('Le rapport doit couvrir les journées entières : 00:00 à 23:59.');
  if(!organizationSelected(form,config))throw Error('La sélection de l’organisation Uber ne correspond pas au nom exact configuré dans Ludy.');
 }
 function generate(form,config){verify(form,config);form.generate.click();}
 function diagnostic(error){
  const message=String(error?.message||'');
  const checks=[['session_required',/Reconnectez-vous à Uber/],['form_unrecognized',/Formulaire Rapports non reconnu/],['control_unrecognized',/Champ Rapports|absent ou ambigu|heures de début|Sélecteur de rapport ambigu/],['organization_required',/Renseignez dans Ludy le nom exact/],['organization_mismatch',/organisation Uber|organisations Uber|autre organisation|choix de l’organisation/],['dates_readonly',/champ Uber se règle dans son calendrier/],['download_link_missing',/bouton Download sans lien/],['download_host',/autre domaine/],['form_timeout',/contrôle Uber ne s’est pas ouvert/],['generation_verification',/avant de générer|journées entières/]];
  return checks.find(([,pattern])=>pattern.test(message))?.[0]||null;
 }
 function structure(doc){
  const {root,kind}=formScope(doc),definitions=FIELD_LABELS;
  const count=value=>Math.min(20,value),allLabels=[...root.querySelectorAll('label,span,p,div,b,strong,legend')].filter(visible),allowedTags=new Set(['INPUT','SELECT','BUTTON','DIV','SPAN','LABEL','TEXTAREA','OPTION']),allowedRoles=new Set(['combobox','button','listbox','option','checkbox','textbox']);
  const selectors={report_type:SELECT_CONTROL,start_date:'input:not([type="hidden"])',end_date:'input:not([type="hidden"])',organization:ORGANIZATION_CONTROL},matches={},fields=[];
  const valueKind=node=>{const value=fieldValue(node);return !value?'empty':/^\d{4}[-/]\d{2}[-/]\d{2}$/.test(value)?'date_ymd':/^\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]m)?$/i.test(value)?'time':Object.values(reportLabels).flat().includes(normalize(value))?'report_type':'other';};
  for(const [field,names]of Object.entries(definitions)){
   const labels=allLabels.filter(node=>names.includes(text(node))),controls=controlsFor(root,names,selectors[field]||CONTROL);if(Object.hasOwn(selectors,field))matches[field]=count(controls.length);
   const sample=new Set(controls);for(const label of labels.slice(0,3)){let node=label.parentElement;for(let depth=0;node&&depth<4;depth++,node=node.parentElement){const found=[...node.querySelectorAll(CONTROL)].filter(visible);if(found.length){for(const item of found.slice(0,8)){sample.add(item);for(const child of item.querySelectorAll('input,select,button,[role]'))if(visible(child))sample.add(child);}break;}if(node===root)break;}}
   const nodes=[...sample].slice(0,12),unique=(items,limit)=>[...new Set(items)].slice(0,limit);
   fields.push({field,labels:count(labels.length),tags:unique(nodes.map(node=>node.tagName).filter(tag=>allowedTags.has(tag)),8),roles:unique(nodes.map(node=>node.getAttribute('role')).filter(role=>allowedRoles.has(role)),6),inputs:unique(nodes.filter(node=>node.tagName==='INPUT').map(node=>['text','date','time','checkbox'].includes(node.type)?node.type:'other'),5),readonly:count(nodes.filter(node=>node.readOnly===true).length),values:unique(nodes.map(valueKind),5)});
  }
  matches.generate=count([...root.querySelectorAll('button,[role="button"],input[type="submit"]')].filter(node=>visible(node)&&['generate','generer','generer le rapport'].includes(normalize(node.value||node.innerText||node.textContent))).length);
  const result={scope:kind,matches,fields};return new TextEncoder().encode(JSON.stringify(result)).length<=2000?result:null;
 }
 function validateCSV(csv,reportType='trip_activity'){
  if(typeof csv!=='string'||new TextEncoder().encode(csv).length>6*1024*1024)throw Error('Rapport supérieur à 6 Mo : réduisez la période dans Ludy.');
  let value=csv.replace(/^\ufeff/,''),delimiter;const declared=value.match(/^sep=([,;\t])\r?\n/i);if(declared){delimiter=declared[1];value=value.slice(declared[0].length);}
  const counts={',':0,';':0,'\t':0};let quoted=false,header='';for(let i=0;i<value.length;i++){const c=value[i];if(c==='"'){if(quoted&&value[i+1]==='"'){header+='""';i++;continue;}quoted=!quoted;}if(!quoted&&(c==='\r'||c==='\n'))break;if(!quoted&&Object.hasOwn(counts,c))counts[c]++;header+=c;}
  const choices=Object.entries(counts).sort((a,b)=>b[1]-a[1]);if(!delimiter&&choices[0][1]>0&&choices[0][1]!==choices[1][1])delimiter=choices[0][0];
  if(!delimiter||quoted)throw Error('En-tête du rapport CSV non reconnu.');
  const fields=[];let field='';quoted=false;for(let i=0;i<header.length;i++){const c=header[i];if(c==='"'){if(quoted&&header[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}else if(c===delimiter&&!quoted){fields.push(field);field='';}else field+=c;}fields.push(field);
  const names=fields.map(value=>normalize(value).replace(/[_’'—–-]/g,' ').replace(/\s+/g,' '));
  const aliases=reportType==='trip_activity'?[['trip uuid','trip id','uuid de la course','id de la course','identifiant de la course'],['trip request time','heure de demande de course','heure de la demande de course','heure de demande','date et heure de la demande','date de demande de course','date et heure de demande de course'],['pickup address','pick up address','adresse de prise en charge','adresse de depart','lieu de prise en charge'],['trip status','statut de la course','etat de la course','statut course']]:reportType==='driver_activity'?[['trips completed','courses terminees','nombre de courses terminees'],['time online (days : hours: minutes)','time online (days: hours : minutes)','time online (days:hours:minutes)','time online (hours)','hours online','temps en ligne (jours:heures:minutes)','heures en ligne'],['time on trip (days: hours : minutes)','time on trip (days : hours: minutes)','time on trip (days:hours:minutes)','time on trip (hours)','hours on trip','temps en course (jours:heures:minutes)','heures en course']]:reportType==='driver_quality'?[['trips completed','courses terminees','nombre de courses terminees'],['acceptance rate','acceptance rate (%)','taux d acceptation','taux d acceptation (%)'],['cancellation rate','cancellation rate (%)','taux d annulation','taux d annulation (%)']]:null;
  if(!aliases)throw Error('Type de rapport non pris en charge.');
  if(reportType!=='trip_activity'){
   const has=group=>names.filter(name=>group.includes(name)).length===1;
   if(!has(['driver uuid','driver id','uuid du chauffeur','identifiant du chauffeur'])&&!(has(['driver first name','prenom du chauffeur','prenom chauffeur'])&&has(['driver last name','driver surname','nom du chauffeur','nom chauffeur'])))throw Error('Identité chauffeur absente du rapport.');
  }
  if(aliases.some(group=>names.filter(name=>group.includes(name)).length!==1))throw Error('Le fichier ne correspond pas au rapport détaillé d’activité des courses.');return csv;
 }
 async function readDownload(value,page,{fetchFn=fetch,signal,reportType='trip_activity'}={}){
  const url=downloadURL(value,page);if(!url)throw Error('Lien de téléchargement non autorisé.');
  const response=await fetchFn(url,{method:'GET',credentials:'same-origin',redirect:'error',cache:'no-store',signal});if(!response.ok)throw Error('Export Uber indisponible. Reconnectez-vous ou générez à nouveau le rapport.');
  if(Number(response.headers.get('content-length'))>6*1024*1024)throw Error('Rapport supérieur à 6 Mo : réduisez la période.');
  const reader=response.body?.getReader();if(!reader)throw Error('Réponse de téléchargement invalide.');const chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>6*1024*1024)throw Error('Rapport supérieur à 6 Mo : réduisez la période.');chunks.push(value);}}catch(error){await reader.cancel().catch(()=>{});throw error;}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return validateCSV(new TextDecoder('utf-8',{fatal:true}).decode(bytes),reportType);
 }
 globalThis.LudyUberReportsReader=Object.freeze({VERSION,permittedUrl,organizationId,period,rowPeriodMatches,inspect,prepare,prepareForm,verify,verification,waitFor,generate,diagnostic,structure,validateCSV,readDownload,downloadURL});
})();
