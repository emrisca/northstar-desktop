fn main() {
    #[cfg(windows)]
    {
        // tauri-build normally links its manifest only into the application
        // binary. A test binary that links Tauri still imports TaskDialogIndirect,
        // so without Common Controls v6 it dies at startup with
        // STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139). Disable the default manifest
        // and link this one into every target instead.
        let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
        tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
            .expect("failed to run tauri-build");
        add_manifest();
    }

    #[cfg(not(windows))]
    tauri_build::build();
}

#[cfg(windows)]
fn add_manifest() {
    let manifest =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
}
