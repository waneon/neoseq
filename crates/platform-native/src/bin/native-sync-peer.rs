use anyhow::{Context, Result, ensure};
use futures_util::{SinkExt, StreamExt};
use graph_core::SpikePeer;
use serde_json::json;
use std::time::Duration;
use tokio::time::{Instant, timeout_at};
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[tokio::main]
async fn main() -> Result<()> {
    let relay = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "ws://127.0.0.1:39091".to_owned());
    let expected_peer_hash = std::env::args().nth(2);
    let peer = SpikePeer::new(2)?;
    peer.edit("native-a|")?;
    let first = peer.export_all()?;
    peer.edit("native-b|")?;
    let second = peer.export_all()?;

    let (socket, _) = connect_async(&relay)
        .await
        .with_context(|| format!("connect native peer to {relay}"))?;
    let (mut output, mut input) = socket.split();
    // Deliberately send a superseding update before an older one. The relay duplicates both.
    output.send(Message::Binary(second.into())).await?;
    output.send(Message::Binary(first.into())).await?;

    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        let incoming = timeout_at(deadline, input.next()).await;
        match incoming {
            Ok(Some(Ok(Message::Binary(update)))) => peer.import(&update)?,
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) | Err(_) => break,
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(error))) => return Err(error.into()),
        }
    }

    let hash = peer.hash()?;
    if let Some(expected) = expected_peer_hash {
        ensure!(hash == expected, "native and Wasm peer hashes differ");
    }
    println!(
        "{}",
        serde_json::to_string(&json!({
            "peer": "native",
            "fixture_hash": hash,
            "status": "passed"
        }))?
    );
    Ok(())
}
