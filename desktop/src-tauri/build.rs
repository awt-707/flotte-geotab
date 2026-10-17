fn main() {
  // commandes appelées par le site Ludy : volets externes (Uber Fleet, Clicar…) affichés dans la fenêtre
  tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["ext_show", "ext_hide", "ext_reload", "ext_status", "ext_login"])))
    .expect("tauri-build");
}
