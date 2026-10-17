// Application Ludy (Mac / Windows) : une fenêtre avec deux vues.
// - « ludy » : le site Ludy, sur toute la fenêtre (ses mises à jour arrivent sans réinstaller l'application) ;
// - « uber » : Uber Fleet Hub, posée sur la zone de contenu du site, à droite du menu Ludy, quand le volet Uber Fleet est
//   choisi dans le menu ; masquée (pas fermée : session et page gardées) quand on choisit un autre volet.
// Uber interdit d'être affiché dans un cadre d'un autre site ; une vue de l'application peut l'ouvrir directement.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::ipc::CapabilityBuilder;
use tauri::webview::{DownloadEvent, NewWindowResponse, WebviewBuilder};
use tauri::window::WindowBuilder;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Runtime, WebviewUrl};
use tauri_plugin_opener::OpenerExt;

const HOME: &str = "https://ludy-flotte.pages.dev/";
const UBER: &str = "https://fleethub.uber.com/orgs/692d0268-9766-4061-9c0e-85d7c124d10e/livemap?tab=4";

/// Adresse du site : LUDY_HOME (essais en local, version de développement seulement), sinon le site en ligne
fn home() -> String {
  #[cfg(debug_assertions)]
  if let Ok(h) = std::env::var("LUDY_HOME") { return h; }
  HOME.to_string()
}

fn is_uber(url: &url::Url) -> bool {
  let h = url.host_str().unwrap_or("");
  h == "uber.com" || h.ends_with(".uber.com")
}

/// Fichier libre dans le dossier Téléchargements : « nom.pdf », sinon « nom (2).pdf »…
fn free_path(dir: &PathBuf, name: &str) -> PathBuf {
  let p = dir.join(name);
  if !p.exists() { return p; }
  let (stem, ext) = match name.rfind('.') { Some(i) => (&name[..i], &name[i..]), None => (name, "") };
  (2..1000).map(|i| dir.join(format!("{stem} ({i}){ext}"))).find(|p| !p.exists()).unwrap_or(p)
}

/// Téléchargements (PDF, exports) : dossier Téléchargements, puis fichier ouvert
fn with_downloads<R: Runtime>(b: WebviewBuilder<R>, app: &AppHandle<R>) -> WebviewBuilder<R> {
  let dir = app.path().download_dir().ok();
  let last: Arc<Mutex<Option<PathBuf>>> = Arc::new(Mutex::new(None));
  let h = app.clone();
  b.on_download(move |_w, event| {
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
          if let Some(p) = path.or_else(|| last.lock().unwrap().clone()) { let _ = h.opener().open_path(p.to_string_lossy(), None::<&str>); }
        }
      }
      _ => {}
    }
    true
  })
}

/// Affiche le volet Uber Fleet sur la zone (x, y, w, h) de la page Ludy (pixels CSS = pixels logiques de la fenêtre)
#[tauri::command]
fn uber_show<R: Runtime>(app: AppHandle<R>, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
  let (pos, size) = (LogicalPosition::new(x.max(0.0), y.max(0.0)), LogicalSize::new(w.max(100.0), h.max(100.0)));
  if let Some(v) = app.get_webview("uber") {
    v.set_position(pos).map_err(|e| e.to_string())?;
    v.set_size(size).map_err(|e| e.to_string())?;
    v.show().map_err(|e| e.to_string())?;
    let _ = v.set_focus();
    return Ok(());
  }
  let win = app.get_window("main").ok_or("fenêtre absente")?;
  let h2 = app.clone();
  let b = WebviewBuilder::new("uber", WebviewUrl::External(UBER.parse().unwrap()))
    // nouvel onglet demandé par Uber : dans le volet s'il reste chez Uber, sinon dans le navigateur
    .on_new_window(move |url, _f| {
      if is_uber(&url) { if let Some(v) = h2.get_webview("uber") { let _ = v.navigate(url); } }
      else { let _ = h2.opener().open_url(url.as_str(), None::<&str>); }
      NewWindowResponse::Deny
    });
  let v = win.add_child(with_downloads(b, &app), pos, size).map_err(|e| e.to_string())?;
  let _ = v.set_focus();
  Ok(())
}

/// Masque le volet Uber Fleet (la page Uber reste chargée : retour instantané)
#[tauri::command]
fn uber_hide<R: Runtime>(app: AppHandle<R>) {
  if let Some(v) = app.get_webview("uber") { let _ = v.hide(); }
  if let Some(v) = app.get_webview("ludy") { let _ = v.set_focus(); }
}

fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .invoke_handler(tauri::generate_handler![uber_show, uber_hide])
    .setup(|app| {
      let home = home();
      let origin = { let u: url::Url = home.parse().expect("adresse du site"); u.origin().ascii_serialization() };
      // seul le site Ludy peut demander d'afficher / masquer le volet Uber
      app.add_capability(CapabilityBuilder::new("ludy-site").webview("ludy").remote(format!("{origin}/*"))
        .permission("allow-uber-show").permission("allow-uber-hide"))?;
      let win = WindowBuilder::new(app, "main")
        .title("Ludy · Supervision de flotte")
        .inner_size(1440.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .center()
        .build()?;
      let init = include_str!("init.js").replace("__VERSION__", env!("CARGO_PKG_VERSION")).replace("__UBER__", UBER);
      let h1 = app.handle().clone();
      let site = origin.clone();
      let b = WebviewBuilder::new("ludy", WebviewUrl::External(home.parse().unwrap()))
        .initialization_script(&init)
        .auto_resize()
        // liens « nouvel onglet » : le site dans sa vue, le reste (cartes…) dans le navigateur
        .on_new_window(move |url, _f| {
          if url.origin().ascii_serialization() == site { if let Some(v) = h1.get_webview("ludy") { let _ = v.navigate(url); } }
          else { let _ = h1.opener().open_url(url.as_str(), None::<&str>); }
          NewWindowResponse::Deny
        });
      let size = win.inner_size()?.to_logical::<f64>(win.scale_factor()?);
      win.add_child(with_downloads(b, app.handle()), LogicalPosition::new(0.0, 0.0), size)?;
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("Ludy n'a pas pu démarrer");
}
