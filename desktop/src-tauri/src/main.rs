// Application Ludy (Mac / Windows) : une fenêtre et plusieurs vues.
// - « ludy » : le site Ludy, sur toute la fenêtre (ses mises à jour arrivent sans réinstaller l'application) ;
// - une vue par volet externe (Uber Fleet, Clicar… : liste réglée sur le site, Réglages > Volets externes), posée sur la zone de contenu du site, à droite du menu Ludy, quand
//   le volet est choisi dans le menu ; masquée (pas fermée : session et page gardées) quand on choisit un autre volet.
// Ces sites interdisent d'être affichés dans un cadre d'un autre site ; une vue de l'application peut les ouvrir directement.
// Windows (1.6, signalé par Ahmed : défilement et clics sans effet, affichage décalé, lenteur, écran à 125 / 150 %) : les vues
// superposées dans une même fenêtre (multiwebview de Tauri, encore « unstable ») sont mal placées et ne reçoivent plus bien la
// souris quand la mise à l'échelle de Windows n'est pas 100 %. Sous Windows : Ludy dans une fenêtre normale (une seule vue,
// ouverte agrandie) et chaque volet externe dans sa propre fenêtre. Mac : inchangé (une fenêtre, volets à droite du menu).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::ipc::CapabilityBuilder;
use tauri::webview::{DownloadEvent, NewWindowResponse};
#[cfg(target_os = "windows")]
use tauri::WebviewWindowBuilder;
#[cfg(not(target_os = "windows"))]
use tauri::{webview::WebviewBuilder, window::WindowBuilder, LogicalPosition, LogicalSize};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl};
use tauri_plugin_opener::OpenerExt;

const HOME: &str = "https://ludy-flotte.pages.dev/";
const UBER: &str = "https://fleethub.uber.com/orgs/692d0268-9766-4061-9c0e-85d7c124d10e/livemap?tab=4";
const TITLE: &str = "Ludy · Supervision de flotte";
/// Volets externes dans leur propre fenêtre (Windows) plutôt qu'à droite du menu Ludy
const EXT_WINDOWS: bool = cfg!(target_os = "windows");

/// Volets externes (Uber Fleet, Clicar…) : la liste est réglée sur le site (Réglages > Volets externes), l'application
/// ouvre l'adresse demandée par le site Ludy (https seulement) : ajouter un site ne demande pas de nouvelle application.
fn ext_label(id: &str) -> Result<String, String> {
  let ok = !id.is_empty() && id.len() <= 40 && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
  if ok { Ok(format!("ext-{id}")) } else { Err(format!("volet invalide : {id}")) }
}
fn ext_parse(u: &str) -> Result<url::Url, String> {
  let u: url::Url = u.parse().map_err(|_| format!("adresse invalide : {u}"))?;
  if u.scheme() != "https" || u.host_str().is_none() { return Err(format!("adresse refusée (https seulement) : {u}")); }
  Ok(u)
}
fn same_site(a: &url::Url, b: &url::Url) -> bool {
  let (x, y) = (a.host_str().unwrap_or(""), b.host_str().unwrap_or(""));
  let base = |h: &str| { let p: Vec<&str> = h.split('.').collect(); if p.len() >= 2 { p[p.len() - 2..].join(".") } else { h.to_string() } };
  base(x) == base(y)
}
/// Adresse actuelle de chaque volet ouvert (pour le rouvrir à sa nouvelle adresse si elle change dans les Réglages)
struct Opened(Mutex<std::collections::HashMap<String, String>>);

/// Identifiants des accès réservés (identifiant / mot de passe demandés par le navigateur), par site : fichier logins.json
/// du dossier de l'application, sur cet ordinateur seulement
fn logins_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> { app.path().app_config_dir().ok().map(|d| d.join("logins.json")) }
fn logins<R: Runtime>(app: &AppHandle<R>) -> serde_json::Map<String, serde_json::Value> {
  logins_path(app).and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}
/// Adresse du volet, avec l'identifiant de l'accès réservé s'il a été saisi pour ce site
fn with_login<R: Runtime>(app: &AppHandle<R>, u: &url::Url) -> url::Url {
  let mut u = u.clone();
  if let Some(l) = logins(app).get(u.host_str().unwrap_or("")) {
    let _ = u.set_username(l["user"].as_str().unwrap_or(""));
    let _ = u.set_password(l["pass"].as_str());
  }
  u
}

/// Adresse du site : LUDY_HOME (essais en local, version de développement seulement), sinon le site en ligne
fn home() -> String {
  #[cfg(debug_assertions)]
  if let Ok(h) = std::env::var("LUDY_HOME") { return h; }
  HOME.to_string()
}

/// Fichier libre dans le dossier Téléchargements : « nom.pdf », sinon « nom (2).pdf »…
fn free_path(dir: &PathBuf, name: &str) -> PathBuf {
  let p = dir.join(name);
  if !p.exists() { return p; }
  let (stem, ext) = match name.rfind('.') { Some(i) => (&name[..i], &name[i..]), None => (name, "") };
  (2..1000).map(|i| dir.join(format!("{stem} ({i}){ext}"))).find(|p| !p.exists()).unwrap_or(p)
}

/// Fichier ouvert tout seul après téléchargement : documents, tableurs et images seulement (jamais un programme ni un script)
fn safe_open(p: &std::path::Path) -> bool {
  matches!(p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(), Some("pdf" | "xlsx" | "xls" | "csv" | "png" | "jpg" | "jpeg"))
}

/// Téléchargements (PDF, exports) : dossier Téléchargements, puis fichier ouvert s'il vient de Ludy (auto_open) et sans risque ;
/// sinon (volet externe : Uber, Clicar…, ou autre type de fichier) seulement montré dans son dossier
#[cfg(not(target_os = "windows"))]
fn with_downloads<R: Runtime>(b: WebviewBuilder<R>, app: &AppHandle<R>, auto_open: bool) -> WebviewBuilder<R> {
  b.on_download(downloads(app, auto_open))
}
fn downloads<R: Runtime>(app: &AppHandle<R>, auto_open: bool) -> impl Fn(tauri::Webview<R>, DownloadEvent<'_>) -> bool + Send + Sync + 'static {
  let dir = app.path().download_dir().ok();
  let last: Arc<Mutex<Option<PathBuf>>> = Arc::new(Mutex::new(None));
  let h = app.clone();
  move |_w, event| {
    match event {
      DownloadEvent::Requested { destination, .. } => {
        if let Some(d) = &dir {
          let name = destination.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "document.pdf".into());
          *destination = free_path(d, &name);
          *last.lock().unwrap() = Some(destination.clone());
        }
      }
      DownloadEvent::Finished { path, success, .. } => {
        if success {
          if let Some(p) = path.or_else(|| last.lock().unwrap().clone()) {
            if auto_open && safe_open(&p) { let _ = h.opener().open_path(p.to_string_lossy(), None::<&str>); }
            else { let _ = h.opener().reveal_item_in_dir(&p); }
          }
        }
      }
      _ => {}
    }
    true
  }
}

/// Application WhatsApp installée sur cet ordinateur ? (Mac : dossier Applications ; Windows : application du Store ou ancienne version)
fn whatsapp_installed() -> bool {
  #[cfg(target_os = "macos")]
  {
    let home = std::env::var("HOME").unwrap_or_default();
    return ["/Applications/WhatsApp.app".to_string(), format!("{home}/Applications/WhatsApp.app")].iter().any(|p| std::path::Path::new(p).exists());
  }
  #[cfg(target_os = "windows")]
  {
    let local = PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default());
    if local.join("WhatsApp").join("WhatsApp.exe").exists() { return true; }
    return std::fs::read_dir(local.join("Packages")).map(|d| d.flatten().any(|e| e.file_name().to_string_lossy().starts_with("5319275A.WhatsAppDesktop"))).unwrap_or(false);
  }
  #[allow(unreachable_code)]
  false
}
/// Lien WhatsApp (wa.me / api.whatsapp.com) → whatsapp://send (ouvre directement l'application WhatsApp de l'ordinateur)
fn whatsapp_link(u: &url::Url) -> Option<url::Url> {
  let host = u.host_str().unwrap_or("");
  if host != "wa.me" && host != "api.whatsapp.com" { return None; }
  let q: std::collections::HashMap<String, String> = u.query_pairs().into_owned().collect();
  let phone = if host == "wa.me" { u.path().trim_matches('/').to_string() } else { q.get("phone").cloned().unwrap_or_default() };
  let mut w = url::Url::parse("whatsapp://send").ok()?;
  { let mut p = w.query_pairs_mut();
    if !phone.is_empty() && phone.chars().all(|c| c.is_ascii_digit()) { p.append_pair("phone", &phone); }
    if let Some(t) = q.get("text") { p.append_pair("text", t); } }
  Some(w)
}
/// Lien vers l'extérieur (WhatsApp, e-mail, cartes…) : ouvert par le système (application WhatsApp, messagerie, navigateur).
/// La vue web de l'application ne sait pas ouvrir mailto: ni WhatsApp elle-même.
fn open_out<R: Runtime>(app: &AppHandle<R>, u: &url::Url) -> Result<(), String> {
  match u.scheme() {
    "https" | "http" => {
      if let Some(w) = whatsapp_link(u) { if whatsapp_installed() && app.opener().open_url(w.as_str(), None::<&str>).is_ok() { return Ok(()); } }
      app.opener().open_url(u.as_str(), None::<&str>).map_err(|e| e.to_string())
    }
    "mailto" | "tel" | "whatsapp" => app.opener().open_url(u.as_str(), None::<&str>).map_err(|e| e.to_string()),
    s => Err(format!("lien refusé : {s}")),
  }
}
#[tauri::command]
fn open_external<R: Runtime>(app: AppHandle<R>, url: String) -> Result<(), String> {
  open_out(&app, &url::Url::parse(&url).map_err(|e| e.to_string())?)
}

/// Affiche le volet `id` (adresse `url`) sur la zone (x, y, w, h) de la page Ludy (pixels CSS = pixels logiques) ; les autres sont masqués
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn ext_show<R: Runtime>(app: AppHandle<R>, opened: tauri::State<Opened>, id: String, url: String, x: f64, y: f64, w: f64, h: f64, name: Option<String>) -> Result<(), String> {
  let label = ext_label(&id)?;
  let target = ext_parse(&url)?;
  #[cfg(target_os = "windows")]
  { let _ = (x, y, w, h); ext_window(&app, &mut opened.0.lock().unwrap(), &label, &target, &url, name) }
  #[cfg(not(target_os = "windows"))]
  { let _ = name; ext_pane(&app, &mut opened.0.lock().unwrap(), label, target, url, x, y, w, h) }
}
/// Mac : volet posé sur la zone de contenu de la page Ludy, dans la même fenêtre
#[cfg(not(target_os = "windows"))]
#[allow(clippy::too_many_arguments)]
fn ext_pane<R: Runtime>(app: &AppHandle<R>, op: &mut std::collections::HashMap<String, String>, label: String, target: url::Url, url: String, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
  let app = app.clone();
  for v in app.webviews().values() { if v.label().starts_with("ext-") && v.label() != label { let _ = v.hide(); } }
  let (pos, size) = (LogicalPosition::new(x.max(0.0), y.max(0.0)), LogicalSize::new(w.max(100.0), h.max(100.0)));
  if let Some(v) = app.get_webview(&label) {
    v.set_position(pos).map_err(|e| e.to_string())?;
    v.set_size(size).map_err(|e| e.to_string())?;
    if op.get(&label).map(|u| u != &url).unwrap_or(true) { let _ = v.navigate(with_login(&app, &target)); op.insert(label.clone(), url); }
    v.show().map_err(|e| e.to_string())?;
    let _ = v.set_focus();
    return Ok(());
  }
  let win = app.get_window("main").ok_or("fenêtre absente")?;
  let (h2, l2, home) = (app.clone(), label.clone(), target.clone());
  let b = WebviewBuilder::new(&label, WebviewUrl::External(with_login(&app, &target)))
    // nouvel onglet demandé par le site : dans le volet s'il reste sur le même site, sinon dans le navigateur
    .on_new_window(move |u, _f| {
      if same_site(&u, &home) { if let Some(v) = h2.get_webview(&l2) { let _ = v.navigate(u); } }
      else { let _ = open_out(&h2, &u); }
      NewWindowResponse::Deny
    })
    .on_navigation({ let h = app.clone(); move |u| { if matches!(u.scheme(), "mailto" | "tel" | "whatsapp") { let _ = open_out(&h, u); false } else { true } } });
  let v = win.add_child(with_downloads(b, &app, false), pos, size).map_err(|e| e.to_string())?;
  op.insert(label, url);
  let _ = v.set_focus();
  Ok(())
}

/// Volet externe dans sa propre fenêtre (Windows) : créée au premier affichage (agrandie), ensuite ramenée au premier plan ;
/// rouverte à sa nouvelle adresse si elle a changé dans les Réglages ; jamais fermée en changeant de page dans Ludy
#[cfg(target_os = "windows")]
fn ext_window<R: Runtime>(app: &AppHandle<R>, op: &mut std::collections::HashMap<String, String>, label: &str, target: &url::Url, url: &str, name: Option<String>) -> Result<(), String> {
  if let Some(w) = app.get_webview_window(label) {
    if op.get(label).map(|u| u != url).unwrap_or(true) { let _ = w.navigate(with_login(app, target)); op.insert(label.to_string(), url.to_string()); }
    let _ = w.unminimize(); let _ = w.show(); let _ = w.set_focus();
    return Ok(());
  }
  let (h2, l2, home) = (app.clone(), label.to_string(), target.clone());
  let title = format!("Ludy · {}", name.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| target.host_str().unwrap_or("").to_string()));
  WebviewWindowBuilder::new(app, label, WebviewUrl::External(with_login(app, target)))
    .title(title).inner_size(1280.0, 800.0).min_inner_size(700.0, 500.0).maximized(true)
    .on_new_window(move |u, _f| {
      if same_site(&u, &home) { if let Some(v) = h2.get_webview(&l2) { let _ = v.navigate(u); } }
      else { let _ = open_out(&h2, &u); }
      NewWindowResponse::Deny
    })
    .on_navigation({ let h = app.clone(); move |u| { if matches!(u.scheme(), "mailto" | "tel" | "whatsapp") { let _ = open_out(&h, u); false } else { true } } })
    .on_download(downloads(app, false))
    .build().map_err(|e| e.to_string())?;
  op.insert(label.to_string(), url.to_string());
  Ok(())
}

/// Masque les volets externes (leurs pages restent chargées : retour instantané) ; Windows : fenêtres propres, laissées ouvertes
#[tauri::command]
fn ext_hide<R: Runtime>(app: AppHandle<R>) {
  if EXT_WINDOWS { let _ = app; return; }   // Windows : fenêtres propres, rien à masquer (et jamais de focus donné par programme :
  // WebView2 ne fait plus défiler la page à la molette après, MicrosoftEdge/WebView2Feedback#829)
  for v in app.webviews().values() { if v.label().starts_with("ext-") { let _ = v.hide(); } }
  if let Some(v) = app.get_webview("ludy") { let _ = v.set_focus(); }   // clavier rendu à Ludy
}

/// Recharge le volet à son adresse de départ (avec l'accès réservé enregistré)
#[tauri::command]
fn ext_reload<R: Runtime>(app: AppHandle<R>, id: String, url: String) -> Result<(), String> {
  let (label, target) = (ext_label(&id)?, ext_parse(&url)?);
  if let Some(v) = app.get_webview(&label) { v.navigate(with_login(&app, &target)).map_err(|e| e.to_string())?; }
  Ok(())
}

/// Accès réservé du site : identifiant déjà saisi sur cet ordinateur ?
#[tauri::command]
fn ext_status<R: Runtime>(app: AppHandle<R>, url: String) -> Result<serde_json::Value, String> {
  let u = ext_parse(&url)?;
  let l = logins(&app);
  let e = l.get(u.host_str().unwrap_or(""));
  Ok(serde_json::json!({ "saved": e.is_some(), "user": e.and_then(|v| v["user"].as_str()).unwrap_or("") }))
}

/// Enregistre l'identifiant de l'accès réservé du site (sur cet ordinateur) ; identifiant vide = oublié
#[tauri::command]
fn ext_login<R: Runtime>(app: AppHandle<R>, url: String, user: String, pass: String) -> Result<(), String> {
  let u = ext_parse(&url)?;
  let host = u.host_str().unwrap_or("").to_string();
  let mut l = logins(&app);
  if user.is_empty() { l.remove(&host); } else { l.insert(host, serde_json::json!({ "user": user, "pass": pass })); }
  let p = logins_path(&app).ok_or("dossier de l'application introuvable")?;
  if let Some(d) = p.parent() { std::fs::create_dir_all(d).map_err(|e| e.to_string())?; }
  std::fs::write(&p, serde_json::to_string(&l).unwrap()).map_err(|e| e.to_string())?;
  #[cfg(unix)]
  { use std::os::unix::fs::PermissionsExt; let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600)); }
  Ok(())
}

fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .manage(Opened(Mutex::new(Default::default())))
    .invoke_handler(tauri::generate_handler![ext_show, ext_hide, ext_reload, ext_status, ext_login, open_external])
    .setup(|app| {
      let home = home();
      let origin = { let u: url::Url = home.parse().expect("adresse du site"); u.origin().ascii_serialization() };
      // seul le site Ludy peut afficher / masquer les volets externes et enregistrer leurs accès réservés
      app.add_capability(CapabilityBuilder::new("ludy-site").webview("ludy").remote(format!("{origin}/*"))
        .permission("allow-ext-show").permission("allow-ext-hide").permission("allow-ext-reload").permission("allow-ext-status").permission("allow-ext-login").permission("allow-open-external"))?;
      let init = include_str!("init.js").replace("__VERSION__", env!("CARGO_PKG_VERSION")).replace("__UBER__", UBER).replace("__EXTWIN__", if EXT_WINDOWS { "true" } else { "false" });
      let (site, site2) = (origin.clone(), origin.clone());
      // liens « nouvel onglet » : le site dans sa vue, le reste (cartes…) dans le navigateur
      let h1 = app.handle().clone();
      let new_window = move |url: url::Url, _f| {
        if url.origin().ascii_serialization() == site { if let Some(v) = h1.get_webview("ludy") { let _ = v.navigate(url); } }
        else { let _ = open_out(&h1, &url); }
        NewWindowResponse::Deny
      };
      // e-mail, téléphone, WhatsApp dans la page : ouverts par le système (la vue web ne les ouvre pas) ; la vue Ludy ne montre que
      // le site Ludy (une page externe, sans barre d'adresse, pourrait imiter l'écran de connexion) : le reste va au navigateur
      let h3 = app.handle().clone();
      let navigation = move |url: &url::Url| {
        if matches!(url.scheme(), "mailto" | "tel" | "whatsapp") { let _ = open_out(&h3, url); return false; }
        if matches!(url.scheme(), "blob" | "data" | "about") || url.origin().ascii_serialization() == site2 { return true; }
        let _ = open_out(&h3, url); false
      };
      // Windows : fenêtre normale avec une seule vue (pas de vue superposée), ouverte agrandie (1440 × 900 dépasse l'écran à 150 %)
      #[cfg(target_os = "windows")]
      {
        WebviewWindowBuilder::new(app, "ludy", WebviewUrl::External(home.parse().unwrap()))
          .title(TITLE).inner_size(1280.0, 800.0).min_inner_size(900.0, 600.0).maximized(true)
          .initialization_script(&init)
          .on_new_window(new_window).on_navigation(navigation).on_download(downloads(app.handle(), true))
          .build()?;
        return Ok(());
      }
      #[cfg(not(target_os = "windows"))]
      let win = WindowBuilder::new(app, "main")
        .title(TITLE)
        .inner_size(1440.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .center()
        .build()?;
      #[cfg(not(target_os = "windows"))]
      {
        let b = WebviewBuilder::new("ludy", WebviewUrl::External(home.parse().unwrap()))
          .initialization_script(&init)
          .auto_resize()
          .on_new_window(new_window)
          .on_navigation(navigation);
        let size = win.inner_size()?.to_logical::<f64>(win.scale_factor()?);
        win.add_child(with_downloads(b, app.handle(), true), LogicalPosition::new(0.0, 0.0), size)?;
        Ok(())
      }
    })
    .run(tauri::generate_context!())
    .expect("Ludy n'a pas pu démarrer");
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn fichiers_ouverts_seuls() {
    use std::path::Path;
    assert!(safe_open(Path::new("/x/Manifeste-Mission.PDF")) && safe_open(Path::new("rapport.xlsx")));
    assert!(!safe_open(Path::new("x.command")) && !safe_open(Path::new("setup.exe")) && !safe_open(Path::new("a.bat")) && !safe_open(Path::new("sans_extension")));
  }
  #[test]
  fn lien_whatsapp() {
    let w = whatsapp_link(&url::Url::parse("https://wa.me/212612345678?text=Manifeste%20%E2%86%92%20Rabat%0AChauffeur%20%3A%20Z").unwrap()).unwrap();
    assert_eq!(w.scheme(), "whatsapp");
    let q: std::collections::HashMap<String, String> = w.query_pairs().into_owned().collect();
    assert_eq!(q["phone"], "212612345678");
    assert_eq!(q["text"], "Manifeste → Rabat\nChauffeur : Z");
    let w = whatsapp_link(&url::Url::parse("https://wa.me/?text=Bonjour").unwrap()).unwrap();
    assert!(!w.query_pairs().any(|(k, _)| k == "phone"));
    assert!(whatsapp_link(&url::Url::parse("https://www.openstreetmap.org/?mlat=1").unwrap()).is_none());
  }
}
