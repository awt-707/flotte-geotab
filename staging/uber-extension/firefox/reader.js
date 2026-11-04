/* Lecture de la vue affichée uniquement. Aucun accès aux requêtes, cookies ou formulaires. */
(() => {
  'use strict';
  const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  const PALETTE = Object.freeze({'#545454': 'available', '#276ef1': 'on_trip', '#05944f': 'to_pickup'});
  const normalize = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const STATES = Object.freeze({disponible:'available', disponibles:'available', available:'available', 'en course':'on_trip', 'on trip':'on_trip', 'en route':'on_trip', 'en approche':'to_pickup', 'en route vers le lieu de prise en charge':'to_pickup', 'en route to pickup':'to_pickup', 'hors ligne':'offline', offline:'offline'});
  const stateOf = value => STATES[normalize(value)] || 'unknown';
  function transparentHit(element,hit,decorative) {
    if(getComputedStyle(element).pointerEvents!=='none'||!hit)return false;
    if(hit.contains(element))return true;
    // A non-interactive status badge can let the earlier avatar image receive
    // the hit. Accept only that small local image, never an unrelated overlay.
    const host=element.parentElement,photo=hit.closest('img,svg'),box=host?.getBoundingClientRect();
    if(!decorative||!host||!photo||!host.contains(photo)||box.width>96||box.height>96||
      !(photo.compareDocumentPosition(element)&Node.DOCUMENT_POSITION_FOLLOWING))return false;
    return (Number.parseInt(getComputedStyle(photo).zIndex,10)||0)<=(Number.parseInt(getComputedStyle(element).zIndex,10)||0);
  }
  function visible(element, rect = element.getBoundingClientRect(), decorative = false) {
    if (!(element instanceof Element) || rect.width < 1 || rect.height < 1 || rect.left < 0 || rect.top < 0 || rect.right > innerWidth + .5 || rect.bottom > innerHeight + .5) return false;
    for (let parent = element; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || +style.opacity === 0 || parent.hidden || parent.getAttribute('aria-busy') === 'true' || !decorative && parent.getAttribute('aria-hidden') === 'true') return false;
      if (parent !== element) {
        const box = parent.getBoundingClientRect();
        if (/hidden|clip|auto|scroll/.test(style.overflowX) && (rect.left < box.left-.5 || rect.right > box.right+.5)) return false;
        if (/hidden|clip|auto|scroll/.test(style.overflowY) && (rect.top < box.top-.5 || rect.bottom > box.bottom+.5)) return false;
      }
    }
    const hits = [[.5,.5],[.15,.25],[.85,.75]].map(([x,y]) => {
      const hit = document.elementFromPoint(rect.left+rect.width*x, rect.top+rect.height*y);
      // Badges and labels commonly let their enclosing card receive clicks.
      // An unrelated overlapping element still makes the observation unusable.
      return hit === element || element.contains(hit) || transparentHit(element,hit,decorative);
    });
    return decorative ? hits.some(Boolean) : hits.every(Boolean);
  }
  function renderedLines(element,excludeActions=false) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), values = [];
    let node, count = 0;
    while ((node = walker.nextNode()) && ++count <= 500) {
      const parent = node.parentElement;
      if (!parent || parent.closest('input,textarea,select,option,script,style,noscript,template,svg,[contenteditable],a[href^="tel:"]')) continue;
      const action=parent.closest('button,[role="button"]');
      if(excludeActions&&action&&action!==element)continue;
      const range = document.createRange(); range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      if (!visible(parent, rect)) continue;
      const value = node.nodeValue.replace(/\s+/g, ' ').trim();
      if (value && value.length <= 160) values.push({value, rect, node});
    }
    values.sort((a,b) => a.rect.top-b.rect.top || a.rect.left-b.rect.left);
    const lines = [];
    for (const entry of values) {
      let line = lines.find(item => Math.abs(item.top-entry.rect.top) < Math.min(item.height, entry.rect.height)*.45);
      if (!line) { line = {top:entry.rect.top, left:entry.rect.left, bottom:entry.rect.bottom, height:entry.rect.height, parts:[]}; lines.push(line); }
      line.parts.push(entry);
    }
    return lines.map(line => ({...line, text:line.parts.sort((a,b)=>a.rect.left-b.rect.left).map(item=>item.value).join(' ')}));
  }
  const text = element => element ? renderedLines(element).map(line=>line.text).join(' ').trim() : '';
  function plateText(value) {
    const candidate=String(value||'').replace(/^(?:plaque|immatriculation|license plate|licence plate|registration)\s*[:·-]?\s*/i,'').trim().toUpperCase();
    // Only complete plate-shaped text. Never derive a plate from a name, model, phone or hidden attribute.
    if(/^(?:[0-9]{1,6}[- |·]+[\p{L}]{1,3}[- |·]+[0-9]{1,3}|[A-Z]{2}[- ]?[0-9]{3}[- ]?[A-Z]{2}|WW[- ]?[0-9]{4,8}|[0-9]{4,8}[- ]?WW)$/u.test(candidate))return candidate;
    return null;
  }
  function vehicleDetails(element,explicitCell) {
    const candidates=new Map();
    for(const line of renderedLines(explicitCell||element)){
      const whole=plateText(line.text),parts=line.text.split(/\s*[·•]\s*/u),plate=whole||parts.length===2&&plateText(parts[0]);
      // Two plate-shaped fragments are a contradiction, never a model.
      for(const part of parts){const other=plateText(part);if(other&&!candidates.has(other))candidates.set(other,new Set());}
      if(!plate)continue;if(!candidates.has(plate))candidates.set(plate,new Set());
      const model=!whole&&parts[1]?.trim();
      if(model&&model.length<=100&&/\p{L}/u.test(model)&&/^[\p{L}\p{N} .()/-]+$/u.test(model)&&!plateText(model)&&!/[+@]|\d{7}/.test(model))candidates.get(plate).add(model);
    }
    if(candidates.size!==1)return null;
    const [plate,models]=[...candidates][0];
    return {vehicleLabel:plate,...(models.size===1?{vehicleModel:[...models][0]}:{})};
  }
  function detailScope(card,avatars,panel) {
    let scope=card;
    // Uber can wrap a header several times before its sibling details. Never
    // cross another driver's avatar/badge pair, including an offscreen one.
    for(let candidate=card.parentElement,depth=0;candidate&&candidate!==panel&&depth<8;candidate=candidate.parentElement,depth++){
      if(avatars.filter(avatar=>candidate.contains(avatar)).length!==1||/^(auto|scroll)$/.test(getComputedStyle(candidate).overflowY))break;
      scope=candidate;
    }
    return scope;
  }
  function detailTarget(card,nameLine) {
    const target=nameLine?.parts[0]?.node?.parentElement;
    if(!target||!card.contains(target)||target.closest('a,input,select,textarea,form,[contenteditable]'))return null;
    for(let element=target;element&&card.contains(element);element=element.parentElement){
      if(element instanceof HTMLButtonElement||element.getAttribute('role')==='button'||element.hasAttribute('aria-expanded')||getComputedStyle(element).cursor==='pointer')return target;
    }
    return null;
  }
  const validName = name => name.length >= 2 && name.length <= 160 && /\p{L}/u.test(name) && !/\+?\d[\d ()-]{6,}/.test(name) && stateOf(name)==='unknown';
  function sourceId(element, name, explicitCell) {
    const candidates = new Set();
    const displayed = text(explicitCell); if (UUID.test(displayed)) candidates.add(displayed.toLowerCase());
    for (const anchor of element.querySelectorAll('a[href]')) {
      if (!visible(anchor) || normalize(text(anchor)) !== normalize(name)) continue;
      try {
        const url = new URL(anchor.href, location.href), id = url.pathname.match(/\/drivers\/([0-9a-f-]{36})\/?$/i)?.[1];
        if (url.origin===location.origin && id && UUID.test(id)) candidates.add(id.toLowerCase());
      } catch {}
    }
    return candidates.size===1 ? [...candidates][0] : null;
  }
  function rgbColor(value) {
    const match = value.match(/^rgba?\(\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i);
    if (!match || match.slice(1,4).some(part=>+part>255) || match[4]!==undefined && +match[4]!==1) return null;
    return '#'+match.slice(1,4).map(part=>(+part).toString(16).padStart(2,'0')).join('');
  }
  function statusDots(card,origin,visibleOnly=true,avatar=null) {
    const dots=[];
    for(const element of [...card.querySelectorAll('*')].slice(0,200)){
      // An internal SVG circle can be a portrait or a car wheel. The badge used
      // by these cards is a separate element beside/over the avatar image.
      if(avatar?.contains(element))continue;
      const box=element.getBoundingClientRect();
      if(box.width<5||box.width>20||box.height<5||box.height>20||visibleOnly&&!visible(element,box,true))continue;
      const cx=box.left+box.width/2,cy=box.top+box.height/2;
      if(cx<origin.left-8||cx>origin.right+8||cy<origin.top-8||cy>origin.bottom+8)continue;
      const style=getComputedStyle(element);
      if(!(element instanceof SVGCircleElement)&&!(style.borderRadius.includes('%')&&parseFloat(style.borderRadius)>=40)&&parseFloat(style.borderRadius)<Math.min(box.width,box.height)*.4)continue;
      const color=rgbColor(element instanceof SVGElement?style.fill:style.backgroundColor);
      if(color)dots.push({element,color});
    }
    return dots;
  }
  function driverAvatar(avatar,panel) {
    const origin=avatar.getBoundingClientRect();
    // Size alone also matches the car icon in an expanded card. An avatar is
    // recognized by a nearby rendered status badge. Offscreen pairs still form
    // boundaries; their text and state are never collected through this check.
    for(let host=avatar.parentElement,depth=0;host&&host!==panel&&depth<6;host=host.parentElement,depth++){
      if(statusDots(host,origin,false,avatar).length)return true;
    }
    return false;
  }
  function scrollContainer(entries) {
    if(!entries.length)return null;
    for(let element=entries[0].element.parentElement,depth=0;element&&depth<14;element=element.parentElement,depth++){
      if(element===document.body||element===document.documentElement)break;
      const style=getComputedStyle(element);
      if(!/^(?:auto|scroll)$/.test(style.overflowY)||element.scrollHeight<=element.clientHeight+1||element.clientHeight<40)continue;
      if(entries.every(entry=>element.contains(entry.element))&&visible(element))return element;
    }
    return null;
  }
  function filteredPanel(panel) {
    if(!panel)return false;
    const search=[...panel.querySelectorAll('input[type="search"],input[type="text"],input:not([type])')]
      .some(element=>visible(element)&&!!element.value.trim());
    const filter=[...panel.querySelectorAll('button,[role="button"],[role="combobox"]')].some(element=>{
      if(!visible(element))return false;
      const value=normalize(text(element));
      return /^(?:statut|status|etat)\s*(?:\([1-9]\d*\)|:.*\S)/.test(value)||stateOf(value)!=='unknown';
    });
    return search||filter;
  }
  function inspect() {
    const observedAt = new Date().toISOString(), rows = [], warnings = [], entries = [], ambiguousKeys = [];
    let panel=null;
    const organizationId = location.pathname.match(/^\/orgs\/([0-9a-f-]{36})\/livemap\/?$/i)?.[1]?.toLowerCase();
    const result = status => ({result:{observedAt, sourceAt:null, ...(organizationId && UUID.test(organizationId) ? {organizationId} : {}), status, rows, warnings},
      panel,scrollRoot:scrollContainer(entries),entries,ambiguousKeys,filtered:filteredPanel(panel)});
    if (document.visibilityState!=='visible') { warnings.push('La page Uber doit rester visible sur le second écran.'); return result('error'); }
    if (navigator.onLine===false) { warnings.push('Réseau du navigateur indisponible. Les états affichés ne sont pas reconfirmés.'); return result('error'); }
    if ([...document.querySelectorAll('input[type="password"]')].some(element=>visible(element))) { warnings.push('Connexion Uber à rétablir dans la page.'); return result('error'); }
    const disconnected=[...document.querySelectorAll('[role="alert"],[role="status"]')].some(element=>{
      const label=normalize(text(element));
      return label.length<=200&&/^(?:connexion perdue|connexion interrompue|connexion indisponible|hors connexion|aucune connexion internet|reconnexion en cours|connection lost|connection interrupted|no internet connection|you are offline|reconnecting)(?:[.!… :]|$)/.test(label);
    });
    if(disconnected){warnings.push('Uber indique une connexion interrompue. Lecture suspendue jusqu’à son rétablissement.');return result('error');}
    const push = (element, name, rawState, state, explicitCell,plateCell,scope=element,target=null) => {
      if (!validName(name) || !rawState || rawState.length>160) return;
      if (rows.length>=200) { if (!warnings.includes('Lecture limitée à 200 chauffeurs visibles.')) warnings.push('Lecture limitée à 200 chauffeurs visibles.'); return; }
      const vehicle=vehicleDetails(scope,plateCell);
      const row={sourceId:sourceId(element,name,explicitCell), name, rawState, state, readAt:observedAt, sourceAt:null,...(vehicle?{...vehicle,vehicleReadAt:observedAt,vehicleState:state}:{})};
      const expanded=!!vehicle||element.getAttribute('aria-expanded')==='true'||target?.closest('[aria-expanded]')?.getAttribute('aria-expanded')==='true'||scope!==element&&renderedLines(scope).some(line=>stateOf(line.text)!=='unknown');
      rows.push(row);entries.push({row,element,detailScope:scope,detailTarget:target,expanded});
    };
    let recognized = false;
    for (const table of document.querySelectorAll('table,[role="table"],[role="grid"]')) {
      const tableRows = [...table.querySelectorAll('tr,[role="row"]')].filter(row=>row.closest('table,[role="table"],[role="grid"]')===table);
      let header, nameIndex=-1, stateIndex=-1, idIndex=-1,plateIndex=-1;
      const cells = row => [...row.querySelectorAll('th,td,[role="columnheader"],[role="cell"],[role="gridcell"]')].filter(cell=>cell.closest('tr,[role="row"]')===row);
      for (const row of tableRows) {
        if (!row.querySelector('th,[role="columnheader"]')) continue;
        const labels = cells(row).map(cell=>normalize(text(cell)).replace(/[↑↓↕▲▼]+$/g,'').trim());
        nameIndex = labels.findIndex(label=>['chauffeur','nom du chauffeur','driver','driver name','nom','name'].includes(label));
        stateIndex = labels.findIndex(label=>['etat','statut','etat uber','statut uber','status','driver status','activity status'].includes(label));
        idIndex = labels.findIndex(label=>['identifiant chauffeur','id chauffeur','driver id','driver uuid','uuid'].includes(label));
        plateIndex = labels.findIndex(label=>['plaque','immatriculation','plaque d immatriculation','plaque d’immatriculation',"plaque d'immatriculation",'license plate','licence plate','registration'].includes(label));
        if (nameIndex>=0 && stateIndex>=0 && nameIndex!==stateIndex) {header=row; break;}
      }
      if (!header) continue;
      const candidates=[];
      for (const row of tableRows) {
        if (row===header || row.querySelector('th,[role="columnheader"]')) continue;
        const columns=cells(row), name=text(columns[nameIndex]), rawState=text(columns[stateIndex]);
        if (name && rawState) candidates.push({row,name,rawState,state:stateOf(rawState),idCell:columns[idIndex],plateCell:columns[plateIndex]});
      }
      if (!candidates.some(row=>row.state!=='unknown')) continue;
      recognized=true;panel=table;
      for (const candidate of candidates) push(candidate.row,candidate.name,candidate.rawState,candidate.state,candidate.idCell,candidate.plateCell);
    }
    if (!recognized) {
      const controls=[...document.querySelectorAll('button,[role="button"],[role="combobox"],label,h1,h2,h3,h4,summary,span,div')].filter(element=>element.children.length<4 && visible(element));
      const drivers=controls.filter(element=>['chauffeur','chauffeurs','driver','drivers'].includes(normalize(text(element))));
      const statuses=controls.filter(element=>/^(statut|status|etat)(\s*(?:\(\d+\)|:.*))?$/.test(normalize(text(element)))||stateOf(text(element))!=='unknown');
      const panels=[];
      for (const driver of drivers) {
        for (let element=driver.parentElement, depth=0; element && depth<8; element=element.parentElement,depth++) {
          if (statuses.some(status=>element.contains(status)) && element.querySelector('img,svg')&&!panels.includes(element))panels.push(element);
        }
      }
      // Filter chevrons are SVG too. Only a candidate containing an actual
      // readable driver card may become the list panel.
      for (const candidatePanel of panels) {
        panel=candidatePanel;const before=rows.length;
        const allAvatars=[...panel.querySelectorAll('img,svg')].filter(element=>{const box=element.getBoundingClientRect();return box.width>=24&&box.width<=96&&box.height>=24&&box.height<=96;}).slice(0,400).filter(element=>driverAvatar(element,panel));
        const avatars=allAvatars.filter(element=>visible(element,element.getBoundingClientRect(),true));
        const seen=new Set();
        for (const avatar of avatars.slice(0,400)) {
          const origin=avatar.getBoundingClientRect();
          for (let card=avatar.parentElement, depth=0; card && card!==panel && depth<6; card=card.parentElement,depth++) {
            if(seen.has(card) || avatars.filter(item=>card.contains(item)).length!==1)break;
            const dots=statusDots(card,origin,true,avatar);
            if(dots.length!==1)continue;
            const lines=renderedLines(card,true), nameLine=lines.find(line=>line.left>=origin.right+2 && line.top>=origin.top-8 && line.top<=origin.bottom+4 && validName(line.text));
            if(!nameLine)continue;
            const dot=dots[0], labels=[dot.element.getAttribute('aria-label'),dot.element.getAttribute('title')].filter(label=>label && label.length<=80 && stateOf(label)!=='unknown');
            const label=labels[0],colorState=PALETTE[dot.color],labelStates=new Set(labels.map(stateOf));
            const conflicting=labelStates.size>1||colorState&&label&&colorState!==stateOf(label);
            if(conflicting&&!warnings.includes('Pastille et libellé contradictoires : état inconnu.'))warnings.push('Pastille et libellé contradictoires : état inconnu.');
            push(card,nameLine.text,conflicting?'Pastille et libellé contradictoires':label || `Pastille ${dot.color}`,conflicting?'unknown':label?stateOf(label):colorState || 'unknown',null,null,detailScope(card,allAvatars,panel),detailTarget(card,nameLine));
            recognized=true;seen.add(card);break;
          }
        }
        if(rows.length>before)break;
        panel=null;
      }
    }
    const identities=new Map();
    for(const row of rows){const key=row.sourceId || normalize(row.name);identities.set(key,(identities.get(key)||0)+1);}
    for(const [key,count] of identities)if(count>1)ambiguousKeys.push(key);
    for(let index=rows.length-1;index>=0;index--)if(identities.get(rows[index].sourceId || normalize(rows[index].name))>1){rows.splice(index,1);entries.splice(index,1);if(!warnings.includes('Identités répétées ignorées : correspondance à vérifier.'))warnings.push('Identités répétées ignorées : correspondance à vérifier.');}
    if(!rows.length){warnings.push('Aucun chauffeur exploitable dans la vue affichée. Aucun absent déclaré hors ligne.');return result('error');}
    warnings.push('Chauffeurs visibles uniquement ; fraîcheur des données Uber non fournie.');
    return result('observing');
  }
  const read=()=>inspect().result;
  globalThis.LudyUberReader = Object.freeze({read, inspect, stateOf, palette:PALETTE});
})();
