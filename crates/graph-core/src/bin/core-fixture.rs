use anyhow::Result;
use graph_core::{fixture_document, fixture_hash, fixture_snapshot, ping, semantic_json};
use serde_json::json;

fn main() -> Result<()> {
    let command = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "manifest".to_owned());

    match command.as_str() {
        "hash" => println!("{}", fixture_hash()?),
        "snapshot" => std::io::Write::write_all(&mut std::io::stdout(), &fixture_snapshot()?)?,
        "manifest" => {
            let response = ping("native-spike");
            let doc = fixture_document()?;
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "contract_version": response.contract_version,
                    "core_version": response.core_version,
                    "echo": response.echo,
                    "fixture_hash": fixture_hash()?,
                    "fixture": serde_json::from_str::<serde_json::Value>(&semantic_json(&doc)?)?,
                    "loro_version": "1.13.7"
                }))?
            );
        }
        other => anyhow::bail!("unknown command: {other}"),
    }

    Ok(())
}
