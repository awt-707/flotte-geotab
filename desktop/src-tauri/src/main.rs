// Application Ludy (Mac / Windows) : une fenêtre qui affiche le site Ludy, avec le volet « Uber Fleet » affiché dans la même
// fenêtre (Uber interdit d'être affiché dans un cadre d'un autre site ; une application peut l'ouvrir directement).
// Les mises à jour du site arrivent sans réinstaller l'application.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

const HOME: &str = "https://ludy-flotte.pages.dev/";
const UBER: &str = "https://fleethub.uber.com/orgs/692d0268-9766-4061-9c0e-85d7c124d10e/livemap?tab=4";

/// Pages ouvertes dans la fenêtre de l'application ; tout autre lien s'ouvre dans le navigateur
fn in_app(url: &url::Url) -> bool {
  let h = url.host_str().unwrap_or("");
  h == "ludy-flotte.pages.dev" || h == "uber.com" || h.ends_with(".uber.com")
}

/// Fichier libre dans le dossier Téléchargements : « nom.pdf », sinon « nom (2).pdf »…
fn free_path(dir: &PathBuf, name: &str) -> PathBuf {
  let p = dir.join(name);
  if !p.exists() { return p; }
  let (stem, ext) = match name.rfind('.') { Some(i) => (&name[..i], &name[i..]), None => (name, "") };
  (2..1000).map(|i| dir.join(format!("{stem} ({i}){ext}"))).find(|p| !p.exists()).unwrap_or(p)
}

fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .setup(|app| {
      let init = include_str!("init.js").replace("__VERSION__", env!("CARGO_PKG_VERSION")).replace("__UBER__", UBER);
      let downloads = app.path().download_dir().ok();
      let last: Arc<Mutex<Option<PathBuf>>> = Arc::new(Mutex::new(None));
      let (h1, h2) = (app.handle().clone(), app.handle().clone());
      WebviewWindowBuilder::new(app, "main", WebviewUrl::External(HOME.parse().unwrap()))
        .title("Ludy · Supervision de flotte")
        .inner_size(1440.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .center()
        .initialization_script(&init)
        .zoom_hotkeys_enabled(true)
        // liens « nouvel onglet » : Ludy et Uber dans la fenêtre, le reste (cartes…) dans le navigateur
        .on_new_window(move |url, _features| {
          if in_app(&url) {
            if let Some(w) = h1.get_webview_window("main") { let _ = w.navigate(url); }
          } else {
            let _ = h1.opener().open_url(url.as_str(), None::<&str>);
          }
          NewWindowResponse::Deny
        })
        // PDF et fichiers : enregistrés dans Téléchargements puis ouverts
        .on_download(move |_webview, event| {
          match event {
            DownloadEvent::Requested { destination, .. } => {
              if let Some(dir) = &downloads {
                let name = destination.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "document.pdf".into());
                *destination = free_path(dir, &name);
                *last.lock().unwrap() = Some(destination.clone());
              }
            }
            DownloadEvent::Finished { path, success, .. } => {
              if success {
                if let Some(p) = path.or_else(|| last.lock().unwrap().clone()) { let _ = h2.opener().open_path(p.to_string_lossy(), None::<&str>); }
              }
            }
            _ => {}
          }
          true
        })
        .build()?;
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("Ludy n'a pas pu démarrer");
}
