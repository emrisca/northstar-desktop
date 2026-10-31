//! The desktop shell.
//!
//! Batch 0 opens one window on the front end that already exists and registers
//! no commands. The endpoints that front end asks for are listed in
//! `src/native.js` and `docs/analysis.md`, each with the batch that ports it.
//! When a command lands, register it here and delete its entry from the bridge.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("the Northstar window failed to start");
}
