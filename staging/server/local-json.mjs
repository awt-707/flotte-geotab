// PostgREST returns 201 with no body for a successful insert using
// return=minimal. Treating it as invalid JSON reports failure after commit.
export async function readLocalJson(response){
 if(response.status===204)return null;
 const text=await response.text();
 if(response.status===201&&!text.trim())return null;
 return JSON.parse(text);
}
