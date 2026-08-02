use domain::PingResponse;

#[tauri::command]
fn ping() -> PingResponse {
    graph_core::ping("tauri-spike")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ping])
        .run(tauri::generate_context!())
        .expect("failed to run NeoSeq Step 1 shell");
}
