// The control app. One empty webview, same Tauri version, same window settings,
// no plugins and no frontend. Its memory is the floor that any STRYV figure
// must be measured against.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running the STRYV control app");
}
