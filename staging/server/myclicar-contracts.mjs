import {moroccoWallTime} from './morocco-time.mjs';
// Provider data is projected before it reaches the local reference tables. No I/O.
export const MYCLICAR_LEASE_SECONDS = 300;
const ACTIVE_STATUS = 'IN_PROGRESS';
const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const failure = () => new Error('Contrats MyClicar invalides : aucun import partiel effectué.');
function text(value, maximum, required = false) {
  if (value == null) {if(required)throw failure();return '';}
  if (!['string','number'].includes(typeof value) || typeof value==='number'&&!Number.isSafeInteger(value)) throw failure();
  const result=String(value).trim();
  if(result.length>maximum || required&&!result || /[\u0000-\u001f]/.test(result))throw failure();
  return result;
}
function iso(value) {
  if(value==null||value==='')return null;
  if(typeof value!=='string'||!isoPattern.test(value)||!Number.isFinite(Date.parse(value)))throw failure();
  const [year,month,day]=value.slice(0,10).split('-').map(Number),calendar=new Date(Date.UTC(year,month-1,day));
  if(calendar.getUTCFullYear()!==year||calendar.getUTCMonth()+1!==month||calendar.getUTCDate()!==day||Number(value.slice(11,13))>23)throw failure();
  return new Date(value).toISOString();
}

/** Effective handover fields use Moroccan wall time; ISO API dates keep their offset. */
export function parseMyClicarLocalTime(value) {
  if(value==null||value==='')return null;
  if(typeof value!=='string')throw failure();
  const match=value.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(?:à\s+)?(\d{2})(?:h|:)(\d{2})(?::(\d{2}))?$/u);
  if(!match)throw failure();
  const wanted={year:+match[3],month:+match[2],day:+match[1],hour:+match[4],minute:+match[5],second:+(match[6]||0)};
  const at=moroccoWallTime(wanted);
  if(at===null)throw failure();
  return new Date(at).toISOString();
}

export function normalizeMyClicarContracts(rows,{observedAt,now=Date.now()}={}) {
  const at=iso(observedAt);
  if(!at||Date.parse(at)>now+5000||now-Date.parse(at)>MYCLICAR_LEASE_SECONDS*1000||!Array.isArray(rows)||rows.length>10000)throw failure();
  const ids=new Set(),numbers=new Set();
  const contracts=rows.map(row=>{
    if(!row||typeof row!=='object'||Array.isArray(row))throw failure();
    const external_id=text(row.id,120,true),num=text(row.reference,120,true);
    if(ids.has(external_id)||numbers.has(num))throw failure();ids.add(external_id);numbers.add(num);
    const listedDeparture=parseMyClicarLocalTime(row.departureConditionDate),detailDeparture=row.detailsVerified===true?iso(row.effectiveDepartureAt):null;
    // The portal's formatted list omits its timezone and seconds. A verified
    // ISO detail timestamp is authoritative and must not be shifted again.
    const effective_start_at=detailDeparture||listedDeparture;
    const listedReturn=iso(row.actualReturnDate),checkout=parseMyClicarLocalTime(row.checkoutDate),detailReturn=row.detailsVerified===true?iso(row.effectiveReturnAt):null;
    const scheduled=iso(row.departureDate),end_at=detailReturn||listedReturn||checkout||null;
    const start_at=effective_start_at||scheduled;
    if(end_at&&start_at&&Date.parse(end_at)<Date.parse(start_at))throw failure();
    return {external_id,num,client_code:text(row.clientReference,120)||null,name:text(row.contactName,160),
      plate:text(row.vehicleRegistration,120).toUpperCase(),temporary_plate:text(row.vehicleTemporaryRegistration,120).toUpperCase(),
      model:[text(row.vehicleBrand,100),text(row.vehicleModel,160)].filter(Boolean).join(' ').slice(0,260),
      status:text(row.status,60,true),start_at,effective_start_at,end_at,
      provider_updated_at:iso(row.updatedAt),deleted:row.deletedAt!=null&&row.deletedAt!=='',
      ...(row.detailsVerified===true?{vehicle_external_id:text(row.vehicleExternalId,120,true),departure_agency_external_id:text(row.departureAgencyExternalId,120)||null,return_agency_external_id:text(row.returnAgencyExternalId,120)||null,details_verified:true}:{})};
  });
  return {contracts,counts:{contracts:contracts.length,active_contracts:contracts.filter(row=>isCurrentMyClicarContract({...row,current:true,observed_at:at},Date.parse(at))).length}};
}

export function isCurrentMyClicarContract(row,now=Date.now()) {
  const observed=Date.parse(row?.observed_at),start=Date.parse(row?.effective_start_at);
  return row?.current===true && row.status===ACTIVE_STATUS && row.deleted===false && !row.end_at &&
    Number.isFinite(start)&&start<=now&&Number.isFinite(observed)&&observed<=now+5000&&now-observed<=MYCLICAR_LEASE_SECONDS*1000;
}

/** Claims are used only with a complete, healthy snapshot and exact local references. */
export function myClicarClaims({contracts=[],source,now=Date.now()}={}) {
  const success=Date.parse(source?.last_success_at),ttl=Math.min(Number(source?.stale_after_s)||MYCLICAR_LEASE_SECONDS,MYCLICAR_LEASE_SECONDS);
  const healthy=source?.status==='healthy'&&Number.isFinite(success)&&success<=now+5000&&now-success<=ttl*1000;
  const current=healthy?contracts.filter(row=>isCurrentMyClicarContract(row,now)&&now-Date.parse(row.observed_at)<=ttl*1000):[];
  const claims=new Map();
  for(const row of current){
    if(!row.client_code)continue;
    const own=current.filter(other=>other.client_code===row.client_code);
    const competing=current.filter(other=>other.external_id!==row.external_id&&row.vehicle_key&&(other.vehicle_key===row.vehicle_key||other.vehicle_candidates?.includes(row.vehicle_key)));
    const eligible=row.eligible===true&&!!row.vehicle_key&&own.length===1&&!competing.length;
    const expiry=Math.min(Date.parse(row.observed_at)+ttl*1000,success+ttl*1000);
    claims.set(row.client_code,{contract:row,eligible,evidence:eligible?{method:'myclicar_contract',source:'myclicar',contract_id:row.external_id,contract_num:row.num,
      client_code:row.client_code,vehicle_key:row.vehicle_key,observed_at:row.observed_at,expires_at:new Date(expiry).toISOString()}:null});
  }
  return claims;
}
