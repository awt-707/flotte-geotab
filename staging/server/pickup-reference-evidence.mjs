// Reviewed public establishment locations. These are not pickup entrances/GPS.
// The original CSV remains unchanged; every correction keeps its original value.
export const REFERENCE_SHA256='27479317e095b9a253c14d8af49b20549f6e5e332486e813e5e968e235807c54';
export const CHECKED_AT='2026-11-03';
export const ALGORITHM_SOURCE={
 url:'https://github.com/google/open-location-code/blob/83986da0156bbf51fba33d0327d8ca4b7f955c89/js/src/openlocationcode.js',
 commit:'83986da0156bbf51fba33d0327d8ca4b7f955c89',
 originalSha256:'271165812e3007d71b025b518cb2c0424a2646cb94cb5751521f3313d4b1e505',
 license:'Apache-2.0'
};
const accor=(id,title,latitude,longitude)=>({title,url:'https://all.accor.com/hotel/'+id+'/index.fr.shtml',latitude,longitude,method:'GPS explicitement publié par Accor',checkedAt:CHECKED_AT});
const novotel=accor('6572','Novotel Casablanca City Center',33.598417,-7.613917);
const ibis=accor('6573','ibis Casablanca City Center',33.598,-7.6125);
const mansour=accor('B4P6','Mövenpick Mansour Eddahbi Marrakech',31.6244222,-8.0157307);
export const LOCALITY_CONTEXTS={Casablanca:novotel,Marrakech:mansour};
export const VENUE_REVIEWS=[
 {entryId:'c5ff7e86e297991a572497d3',action:'replace',sources:[accor('B4P8','Mövenpick Casablanca',33.583635,-7.623772)],
  note:'La localisation publiée par Accor remplace le point estimé. Elle ne certifie pas une entrée de prise en charge.'},
 {entryId:'15c42f10ef338441e064d15e',action:'replace',sources:[{title:'Menara Mall — site officiel',url:'https://www.menaramall.com/contact',latitude:31.6186366,longitude:-8.0092535,method:'GeoCoordinates et carte intégrée du site officiel concordants',checkedAt:CHECKED_AT,sourceSha256:'96e661f66b89431264b40e84edf6306accaa4d13a037ccf6076f6c7b25642c7e'}],
  note:'La localisation publiée par le centre commercial remplace le point estimé ; entrée de prise en charge non vérifiée.'},
 {entryId:'1622953dd58e60e351531ba8',action:'replace',sources:[{title:'M Avenue Marrakech — site officiel',url:'https://m-avenue.ma/experience-m-avenue-/m-info/',latitude:31.6212,longitude:-8.0163,method:'GeoCoordinates du ShoppingCenter publié dans les données structurées du site officiel',checkedAt:CHECKED_AT,sourceSha256:'87120e1f25d81df0f4118e1a3c1049e07d7a944749caba32aca8eea3a745858f'}],
  note:'La localisation publiée par M Avenue remplace le point estimé ; elle désigne le site, pas une entrée particulière.'},
 {entryId:'a3376a11d2c56bfbb4f86a6e',action:'compare',sources:[novotel,ibis],
  note:'Le libellé regroupe deux hôtels. Le point fourni reste indicatif ; les deux localisations publiées sont présentées séparément.'},
 {entryId:'1daf39ba4b68b50eb4724a78',action:'compare',sources:[mansour],
  note:'Le libellé regroupe le Palais des Congrès et le Mansour Eddahbi. La localisation publiée du seul hôtel ne justifie pas de déplacer tout le repère.'},
 {entryId:'e4f2e4e303be828d96908fc3',action:'unresolved',sources:[{title:'Royal Mansour Casablanca — contact officiel',url:'https://www.royalmansour.com/casablanca/contact/',checkedAt:CHECKED_AT,method:'Adresse postale confirmée ; aucune coordonnée explicite exploitable sur la page examinée'}],
  note:'Le site officiel confirme le 27 avenue des FAR ; il ne confirme pas les coordonnées fournies.'},
 {entryId:'a2715cef2ff05b365cd3f971',action:'unresolved',sources:[{title:'Jardin Majorelle — accès officiel',url:'https://www.jardinmajorelle.com/lejardin/',checkedAt:CHECKED_AT,sourceSha256:'4f05b9dfc3f1c4772cb8b1793774d7dcae725faa4e782628ba626356cdf6f76b',method:'Adresse rue Yves Saint Laurent confirmée ; aucune coordonnée explicite exploitable dans la page'}],
  note:'L’adresse officielle confirme le jardin, mais ne valide ni le point estimé ni une entrée de prise en charge.'},
 {entryId:'c9a02e752d34a1ec1b1750be',action:'unresolved',sources:[{title:'Es Saadi Marrakech Resort — accès officiel',url:'https://www.essaadi.com/en/access-contact/',checkedAt:CHECKED_AT,sourceSha256:'783c455f97b976c4fd891c1b88811851858b8c69291e20ba500f73ef0163b4ae',method:'Quartier Hivernage confirmé ; aucune coordonnée explicite commune aux trois lieux regroupés'}],
  note:'Le libellé regroupe resort, casino et théâtre. Le quartier confirmé ne suffit pas à valider leur point commun estimé.'},
 {entryId:'0f57f08b2808af87a5add7da',action:'unresolved',sources:[{title:'La Mamounia — contact et accès officiels',url:'https://mamounia.com/en/contact.html',checkedAt:CHECKED_AT,sourceSha256:'95f23869b0e383c5066bd37613006d6beb302691c025b2c70db8373fb5edf1ef',method:'Plan d’accès au parking publié, sans coordonnée explicite attribuable au libellé groupé'}],
  note:'Le plan de l’hôtel ne confirme pas un point commun à Bab Jdid et à la Mamounia. L’estimation reste inchangée et non validée.'}
];
export function metersBetween(a,b){
 const rad=Math.PI/180,dlat=(a.latitude-b.latitude)*rad,dlon=(a.longitude-b.longitude)*rad;
 return 12742017.6*Math.asin(Math.sqrt(Math.sin(dlat/2)**2+Math.cos(a.latitude*rad)*Math.cos(b.latitude*rad)*Math.sin(dlon/2)**2));
}
export function applyPickupReferenceEvidence(catalog){
 const result=structuredClone(catalog);if(result.source.sha256!==REFERENCE_SHA256)return result;
 for(const review of VENUE_REVIEWS){
  const entry=result.entries.find(row=>row.id===review.entryId);if(!entry)throw Error('Reviewed reference entry missing.');
  const original={latitude:entry.latitude,longitude:entry.longitude,coordinates:structuredClone(entry.coordinates),mapsUrl:entry.mapsUrl};
  const sources=review.sources.map(source=>({...source,...(Number.isFinite(source.latitude)&&Number.isFinite(source.longitude)?{distanceFromProvidedMeters:Math.round(metersBetween(entry,source))}:{})}));
  entry.review={...review,sources,checkedAt:CHECKED_AT,pickupVerified:false};
  if(review.action==='replace'){
   const source=sources[0];entry.latitude=source.latitude;entry.longitude=source.longitude;
   entry.coordinates={basis:'official_venue_location',sourceLabel:source.title,verified:false,uncertaintyMeters:null,rawPlusCode:null,original};
   entry.mapsUrl='https://www.google.com/maps?q='+entry.latitude+','+entry.longitude;
  }
 }
 return result;
}
