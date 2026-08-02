use anyhow::Result;
use platform_native::sqlite_round_trip;
use serde_json::json;

fn main() -> Result<()> {
    let command = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "manifest".to_owned());

    match command.as_str() {
        "persistence" => {
            let path = std::env::args()
                .nth(2)
                .map(Into::into)
                .unwrap_or_else(|| std::env::temp_dir().join("neoseq-step1.db"));
            let (hash, replayed_updates, journal_mode) = sqlite_round_trip(&path)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "adapter": "sqlite",
                    "state_hash": hash,
                    "journal_mode": journal_mode,
                    "replayed_updates": replayed_updates,
                    "path": path,
                    "status": "passed"
                }))?
            );
        }
        "manifest" => {
            let ping = graph_core::ping("native-adapter");
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "adapter": "native",
                    "contract_version": ping.contract_version,
                    "core_version": ping.core_version,
                    "fixture_hash": graph_core::fixture_hash()?
                }))?
            );
        }
        other => anyhow::bail!("unknown command: {other}"),
    }

    Ok(())
}
