fn main() {
  // commandes appelées par le site Ludy (afficher / masquer le volet Uber Fleet dans la fenêtre)
  tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["uber_show", "uber_hide"])))
    .expect("tauri-build");
}
