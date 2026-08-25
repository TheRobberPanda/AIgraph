// Keep the console window off on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK's DMA-BUF renderer paints nothing on a good many Linux setups —
    // the window comes up, the page loads, and every pixel stays the toolkit's
    // default grey. It looks exactly like a crash, which is how it cost an
    // afternoon here. Turning it off costs a little compositing performance and
    // is what every Tauri app on Linux ends up doing.
    //
    // Set before the webview is created and only when unset, so anyone who has
    // deliberately chosen a value keeps it.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        // SAFETY: single-threaded, before anything reads the environment.
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    aigraph_lib::run()
}
