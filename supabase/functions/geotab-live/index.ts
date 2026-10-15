// Supabase Edge Function « geotab-live » : voir live.mjs
import { handle } from './live.mjs';
Deno.serve((req: Request) => handle(req, { env: (k: string) => Deno.env.get(k), fetch }));
