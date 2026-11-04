const fold=value=>String(value||'').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase().replace(/\s+/gu,' ').trim();
const ALIASES={
 Casablanca:['casablanca','casa','الدار البيضاء','الدارالبيضاء','casablanka','kasablanka','kazablanka','dar-el-beida','دار البيضاء','казабланка','касабланка','卡萨布兰卡','卡薩布蘭卡','카사블랑카','カサブランカ','καζαμπλανκα','קזבלנקה','คาซาบลังกา'],
 Marrakech:['marrakech','marrakesh','مراكش','марракеш','马拉喀什','馬拉喀什','마라케시','マラケシュ','marakes','μαρακες']
};
const countries=['morocco','maroc','marokko','марокко','fas','marruecos','marrocos','μαροκο','marocko','marocco','maroko','摩洛哥','모로코','المغرب','モロッコ','מרוקו','โมร็อกโก'].map(fold).sort((a,b)=>b.length-a.length);
const aliases=new Map(Object.entries(ALIASES).flatMap(([city,values])=>values.map(value=>[fold(value),city])));
/** Historical behavior retained so already imported UUIDs keep their city. */
export function uberLegacyPickupCity(address){const value=fold(address),casa=/\b(?:casablanca|casa)\b/.test(value),marrakech=/\b(?:marrakech|marrakesh)\b/.test(value);return casa===marrakech?null:casa?'Casablanca':'Marrakech';}
/** A city alias must occupy the final locality component, optionally with a
 * postcode, followed by an explicit Morocco country suffix. Never use street
 * names, a geographic region, coordinates, or a neighboring municipality. */
export function uberPickupCitySuffix(address){
 const parts=fold(address).split(/[,،，]/u).map(value=>value.trim()).filter(Boolean);if(!parts.length)return null;
 let locality=parts.pop(),country=false;
 if(countries.includes(locality)){country=true;locality=parts.pop()||'';}
 else for(const name of countries){
  // East Asian exports may concatenate country and locality without a comma.
  if(!/^[a-z ]+$/.test(name)&&locality.startsWith(name)){country=true;locality=locality.slice(name.length).trim();break;}
 }
 locality=locality.replace(/^\d{4,6}\s*/u,'').replace(/\s*\d{4,6}$/u,'').trim();
 const city=aliases.get(locality);if(!city)return null;
 return country?city:null;
}
export function uberPickupCity(address){return uberLegacyPickupCity(address)||uberPickupCitySuffix(address);}
