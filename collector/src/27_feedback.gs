// ============================================================================
// Avis clients (23/11/2026, demande d'Ahmed) : le message laissé par un client (QR dans la voiture) est traduit en français
// par Google (LanguageApp, gratuit sur Apps Script) pour le volet « Avis clients ». Une seule traduction par avis (comment_fr
// restant null). La plaque et le chauffeur du moment sont déjà posés par la base (create_feedback). Rien d'inventé : si la
// traduction échoue, le message d'origine est recopié tel quel dans comment_fr.
// ============================================================================
function feedbackStep_() {
  if (typeof LanguageApp === 'undefined') return '';   // traduction indisponible : laissé au prochain passage
  var rows;
  try { rows = dbSelect_('client_feedback', 'select=id,lang,comment&comment=not.is.null&comment_fr=is.null', 'id'); }
  catch (e) { if (/client_feedback|42P01|PGRST2/.test(e.message)) return ''; throw e; }   // migration 20261218000000 pas encore exécutée
  if (!rows.length) return '';
  var n = 0;
  rows.slice(0, 20).forEach(function (r) {
    var fr;
    try { fr = LanguageApp.translate(r.comment, r.lang || '', 'fr'); } catch (e) { fr = ''; }
    sbReq_('patch', 'client_feedback?id=eq.' + r.id, { comment_fr: fr || r.comment }, { Prefer: 'return=minimal' });
    n++;
  });
  return 'Avis clients : ' + n + ' message(s) traduit(s)';
}
