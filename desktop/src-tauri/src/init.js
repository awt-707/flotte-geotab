// Injecté par l'application Ludy dans la page du site (avant ses scripts). Le site lit window.LUDY_APP :
// « ext » = volets externes (liste des Réglages) affichés dans la fenêtre, à droite du menu Ludy
// (commandes ext_show / ext_hide / ext_reload / ext_status / ext_login) ; « uber » : adresse par défaut du volet Uber Fleet ;
// « open » (1.3) : liens WhatsApp / e-mail / extérieurs ouverts par le système (commande open_external).
window.LUDY_APP = { version: '__VERSION__', uber: '__UBER__', embed: true, ext: true, open: true };
