-- =============================================================================
-- Courses privées : tout devis préparé par un gestionnaire est validé par l'administrateur (29/10/2026, demande d'Ahmed :
-- « un gestionnaire génère la demande, un administrateur la valide ou la réajuste et la valide »).
-- À exécuter dans Supabase > SQL Editor (après 20261117000000_grilles_villes.sql). Rejouable sans risque.
-- - mission_guard : devis d'un gestionnaire = validation obligatoire (pas d'envoi, d'acceptation ni de confirmation avant) ;
--   la course rapide (data.quick, sans devis) reste lancée tout de suite ; le reste de la règle est celui de 20261113000000
-- - le site : bouton « Envoyer à l'administrateur pour validation » (data.submitted), file « À valider » et pastille du menu
--   de l'administrateur, « Enregistrer et valider », « Demander une correction », ajustement de prix de l'administrateur
-- =============================================================================
create or replace function public.mission_guard() returns trigger language plpgsql set search_path = public as $$
declare lim numeric;
begin
  if coalesce(public.my_role(), 'service') = 'manager' then
    if tg_op = 'INSERT' and (new.validated_by is not null or new.validated_at is not null) then
      raise exception 'validation réservée à l''administrateur';
    end if;
    if tg_op = 'UPDATE' and (new.validated_by is distinct from old.validated_by or new.validated_at is distinct from old.validated_at) then
      raise exception 'validation réservée à l''administrateur';
    end if;
    -- besoin de validation : jamais retiré par un gestionnaire ; règles connues de la base (24 h / VIP, plus de 3 jours, montant)
    select nullif(data->>'validationAmount', '')::numeric into lim from public.pricing_grid where id = 1;
    -- devis préparé par un gestionnaire : toujours validé (réajusté au besoin) par l'administrateur ; la course rapide (sans devis) non
    new.needs_validation := coalesce(new.needs_validation, false) or (tg_op = 'UPDATE' and coalesce(old.needs_validation, false))
      or (coalesce(new.data->>'quick', '') <> 'true' and (tg_op = 'INSERT' or old.status = 'Demande'))   -- devis déjà envoyés avant cette règle : inchangés
      or coalesce(new.level = '24h / VIP', false) or coalesce((new.end_at - new.start_at) > interval '3 days', false) or coalesce(lim > 0 and new.total_ttc > lim, false);
    -- devis à valider : pas d'envoi ni de confirmation tant que l'administrateur n'a pas validé
    if new.needs_validation and new.validated_at is null and new.status not in ('Demande', 'Annulée', 'Refusée') then
      raise exception 'validation de l''exploitation requise avant « % »', new.status;
    end if;
  end if;
  -- mission modifiée après validation (prix, dates, véhicule, niveau, détail du prix) : la validation tombe, à refaire
  if tg_op = 'UPDATE' and old.validated_at is not null and new.validated_at is not distinct from old.validated_at
     and (new.total_ttc is distinct from old.total_ttc or new.start_at is distinct from old.start_at or new.end_at is distinct from old.end_at
          or new.category is distinct from old.category or new.level is distinct from old.level or new.vehicle_key is distinct from old.vehicle_key
          or (new.data -> 'price' -> 'lines') is distinct from (old.data -> 'price' -> 'lines')) then
    if coalesce(public.my_role(), '') = 'manager' and new.needs_validation and new.status not in ('Demande', 'Annulée', 'Refusée') then
      raise exception 'devis validé par l''exploitation : prix, dates, véhicule et niveau modifiables seulement par l''administrateur';
    end if;
    new.validated_at := null; new.validated_by := null;
  end if;
  return new;
end $$;
