-- Entirely synthetic reference data. No live positions, platform status, trip,
-- payroll, customer record, or production export is loaded here.
insert into public.agencies(id, name, city)
overriding system value
values (9001, 'Agence de test A', 'Ville de test'), (9002, 'Agence de test B', 'Ville de test')
on conflict (id) do nothing;
-- Explicit synthetic ids also advance the identity sequence for later UI inserts.
select setval(pg_get_serial_sequence('public.agencies', 'id'), (select max(id) from public.agencies), true);

insert into public.parc(plate, brand, model, vin, fuel, agency_id, note)
values ('STG001', 'TEST', 'Vehicule de demonstration', null, 'Essence', 9001, 'Fictif : staging uniquement'),
       ('STG002', 'TEST', 'Vehicule de demonstration', null, 'Essence', 9002, 'Fictif : staging uniquement')
on conflict (plate) do nothing;

insert into public.vehicles(key, plate, brand, model, agency_id, active)
values ('001STG', 'STG001', 'TEST', 'Vehicule de demonstration', 9001, 'OUI'),
       ('002STG', 'STG002', 'TEST', 'Vehicule de demonstration', 9002, 'OUI')
on conflict (key) do nothing;

insert into public.drivers(code, name, email, agency_id, source, status, note)
values ('STG-DRIVER-A', 'Chauffeur fictif A', 'driver-a@example.invalid', 9001, 'manuel', 'ACTIF', 'Fictif : staging uniquement'),
       ('STG-DRIVER-B', 'Chauffeur fictif B', 'driver-b@example.invalid', 9002, 'manuel', 'ACTIF', 'Fictif : staging uniquement')
on conflict (code) do nothing;

insert into public.params(key, label, value, note, sort) values
('environment', 'Environnement', 'staging', 'Local uniquement', -10),
('appSites', 'Volets externes', '[]', 'Aucun site externe active automatiquement', -9),
('parcId', 'Ancien classeur parc', '', 'Desactive en staging', -8),
('cashSheetId', 'Classeur caisse', '', 'Desactive en staging', -7),
('rhDriveContracts', 'Drive contrats', '', 'Desactive en staging', -6),
('rhDrivePayroll', 'Drive paie', '', 'Desactive en staging', -5),
('rhDriveClock', 'Drive pointage', '', 'Desactive en staging', -4),
('shiftDay', 'Shift jour', '7', 'Heure du Maroc', 1),
('shiftNight', 'Shift nuit', '19', 'Heure du Maroc', 2),
('shiftAdvance', 'Avance shift', '2', 'Heure du Maroc', 3)
on conflict (key) do update set value = excluded.value, note = excluded.note;

-- Remove business identity defaults introduced by copied production migrations.
update public.manifest_config set company = '{"name":"Societe fictive de test"}'::jsonb;
update public.agencies set cash_sheet_id = null, rh_drive = '{}'::jsonb;
update public.alert_recipients set active = false;
update public.report_schedules set active = false;
