-- =============================================================================
-- Promotions Uber / Bolt à l'encaissement du shift (13/11/2026, demande d'Ahmed) : le client paie moins que le montant affiché
-- (promotion de la plateforme), la différence n'est pas un manque du chauffeur et doit être payée par la plateforme.
-- À exécuter dans Supabase > SQL Editor (après 20261124000000_societes.sql). Rejouable sans risque.
-- - cash_moves.promo : montant de la promotion saisi avec l'encaissement (jamais retenu au chauffeur)
-- - cash_moves.promo_status : vérification du paiement par la plateforme (À vérifier, Payée, Non payée), modifiable à tout moment
-- =============================================================================
alter table public.cash_moves add column if not exists promo numeric(12,2);
alter table public.cash_moves add column if not exists promo_status text;
alter table public.cash_moves drop constraint if exists cash_moves_promo_check;
alter table public.cash_moves add constraint cash_moves_promo_check check (promo is null or promo >= 0);
alter table public.cash_moves drop constraint if exists cash_moves_promo_status_check;
alter table public.cash_moves add constraint cash_moves_promo_status_check check (promo_status is null or promo_status in ('À vérifier', 'Payée', 'Non payée'));

-- gestionnaire : le statut de la promotion se modifie comme le justificatif ou le commentaire, même après 24 h
do $$ declare src text; begin
  select pg_get_functiondef('public.cash_guard()'::regprocedure) into src;
  if position('''promo_status''' in src) = 0 then
    src := replace(src, '''comment'', ''updated_at''', '''comment'', ''promo_status'', ''updated_at''');
    execute src;
  end if;
end $$;
