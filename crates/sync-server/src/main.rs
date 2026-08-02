use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use std::{net::SocketAddr, sync::Arc};
use tokio::{
    net::TcpListener,
    sync::{Mutex, broadcast},
};
use tokio_tungstenite::{accept_async, tungstenite::Message};

#[tokio::main]
async fn main() -> Result<()> {
    let address: SocketAddr = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "127.0.0.1:39091".to_owned())
        .parse()
        .context("parse relay address")?;
    let listener = TcpListener::bind(address).await?;
    let local = listener.local_addr()?;
    println!("{local}");

    let (updates, _) = broadcast::channel::<Arc<Vec<u8>>>(64);
    let history = Arc::new(Mutex::new(Vec::<Arc<Vec<u8>>>::new()));

    loop {
        let (stream, _) = listener.accept().await?;
        let sender = updates.clone();
        let mut receiver = sender.subscribe();
        let history = Arc::clone(&history);
        tokio::spawn(async move {
            let result: Result<()> = async {
                let socket = accept_async(stream).await?;
                let (mut output, mut input) = socket.split();

                for update in history.lock().await.iter() {
                    output
                        .send(Message::Binary(update.as_ref().clone().into()))
                        .await?;
                }

                loop {
                    tokio::select! {
                        incoming = input.next() => match incoming {
                            Some(Ok(Message::Binary(bytes))) => {
                                let payload = Arc::new(bytes.to_vec());
                                history.lock().await.push(payload.clone());
                                let _ = sender.send(payload.clone());
                                let _ = sender.send(payload);
                            }
                            Some(Ok(Message::Close(_))) | None => break,
                            Some(Ok(_)) => {}
                            Some(Err(error)) => return Err(error.into()),
                        },
                        outgoing = receiver.recv() => match outgoing {
                            Ok(bytes) => output.send(Message::Binary(bytes.as_ref().clone().into())).await?,
                            Err(broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(broadcast::error::RecvError::Closed) => break,
                        }
                    }
                }
                Ok(())
            }
            .await;
            if let Err(error) = result {
                eprintln!("relay connection failed: {error:#}");
            }
        });
    }
}
