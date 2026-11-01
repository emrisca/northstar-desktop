//! The native application menu.
//!
//! The interface keeps its in-window Project and Tools menus, because those are
//! part of the product. This menu adds the commands an operating system expects
//! to own: a standard application menu on macOS, File actions with ordinary
//! accelerators, View > Enter Full Screen, and Help. Menu items dispatch to the
//! same bridge functions the HTML menus use, so there is only one implementation
//! of opening, saving, printing or showing settings.
//!
//! Map shortcuts are deliberately left alone: no menu item uses an unmodified
//! letter or a key the map tools already use.

use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Manager};

fn item(
    app: &AppHandle,
    id: &str,
    text: &str,
    accelerator: Option<&str>,
) -> tauri::Result<tauri::menu::MenuItem<tauri::Wry>> {
    let mut builder = MenuItemBuilder::with_id(id, text);
    if let Some(accelerator) = accelerator {
        builder = builder.accelerator(accelerator);
    }
    builder.build(app)
}

fn dispatch(app: &AppHandle, action: &str) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let action = serde_json::to_string(action).unwrap_or_else(|_| "\"\"".into());
    // The interface is a plain script with no module loader, so evaluating the
    // bridge call avoids adding the JavaScript event API just for the menu.
    let _ = window.eval(&format!(
        "window.northstarMenu && window.northstarMenu({action});"
    ));
}

/// Build and attach the menu. `app.set_menu` installs it for the main window;
/// the event handler forwards only our own ids and leaves predefined items to
/// the operating system.
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let about = item(app, "app.about", "About Northstar", None)?;
    let settings = item(app, "app.settings", "Settings…", Some("CmdOrCtrl+,"))?;
    let open = item(app, "file.open", "Open Project…", Some("CmdOrCtrl+O"))?;
    let recent = item(app, "file.recent", "Recent Projects…", None)?;
    let new = item(app, "file.new", "New Project", Some("CmdOrCtrl+N"))?;
    let save = item(app, "file.save", "Save", Some("CmdOrCtrl+S"))?;
    let save_copy = item(
        app,
        "file.save-copy",
        "Save a Copy…",
        Some("CmdOrCtrl+Shift+S"),
    )?;
    let print = item(
        app,
        "file.print",
        "Print Selected-Points Report…",
        Some("CmdOrCtrl+P"),
    )?;
    let close = PredefinedMenuItem::close_window(app, None)?;
    let quit = PredefinedMenuItem::quit(app, Some("Quit Northstar"))?;
    let logs = item(app, "help.logs", "Open Log Folder", None)?;
    let fullscreen = PredefinedMenuItem::fullscreen(app, None)?;
    let separator = PredefinedMenuItem::separator(app)?;

    let mut file = SubmenuBuilder::new(app, "File")
        .item(&new)
        .item(&open)
        .item(&recent)
        .item(&separator)
        .item(&save)
        .item(&save_copy)
        .item(&separator)
        .item(&print)
        .item(&separator)
        .item(&close);
    if !cfg!(target_os = "macos") {
        file = file
            .item(&separator)
            .item(&settings)
            .item(&separator)
            .item(&quit);
    }
    let file = file.build()?;

    let view = SubmenuBuilder::new(app, "View").item(&fullscreen).build()?;

    let mut help = SubmenuBuilder::new(app, "Help").item(&logs);
    if !cfg!(target_os = "macos") {
        help = help.item(&separator).item(&about);
    }
    let help = help.build()?;

    let mut menu = MenuBuilder::new(app);
    #[cfg(target_os = "macos")]
    {
        let services = PredefinedMenuItem::services(app, None)?;
        let hide = PredefinedMenuItem::hide(app, None)?;
        let hide_others = PredefinedMenuItem::hide_others(app, None)?;
        let show_all = PredefinedMenuItem::show_all(app, None)?;
        let separator = PredefinedMenuItem::separator(app)?;
        let application = SubmenuBuilder::new(app, "Northstar")
            .item(&about)
            .item(&settings)
            .item(&separator)
            .item(&services)
            .item(&separator)
            .item(&hide)
            .item(&hide_others)
            .item(&show_all)
            .item(&separator)
            .item(&quit)
            .build()?;
        menu = menu.item(&application);
    }
    let menu = menu.item(&file).item(&view).item(&help).build()?;
    app.set_menu(menu)?;

    app.on_menu_event(|app, event| {
        let id = event.id().0.as_str();
        let action = match id {
            "app.about" | "help.about" => Some("about"),
            "app.settings" | "file.settings" => Some("settings"),
            "file.new" => Some("file.new"),
            "file.open" => Some("file.open"),
            "file.recent" => Some("file.recent"),
            "file.save" => Some("file.save"),
            "file.save-copy" => Some("file.save-copy"),
            "file.print" => Some("file.print"),
            "help.logs" => Some("logs"),
            _ => None,
        };
        if let Some(action) = action {
            dispatch(app, action);
        }
    });
    Ok(())
}
