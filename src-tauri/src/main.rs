// Keep the console window off on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    idea_graph_lib::run()
}
