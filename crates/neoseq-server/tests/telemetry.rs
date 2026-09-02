mod support;

use domain::GraphId;
use neoseq_server::RoomConfig;
use std::{
    io::{self, Write},
    sync::{Arc, Mutex},
};
use support::*;

#[derive(Clone)]
struct Capture(Arc<Mutex<Vec<u8>>>);

struct CaptureWriter(Arc<Mutex<Vec<u8>>>);

impl Write for CaptureWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0
            .lock()
            .expect("capture mutex")
            .extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Capture {
    type Writer = CaptureWriter;

    fn make_writer(&'a self) -> Self::Writer {
        CaptureWriter(self.0.clone())
    }
}

#[tokio::test(flavor = "current_thread")]
async fn structured_telemetry_excludes_content_credentials_and_raw_updates() {
    let bytes = Arc::new(Mutex::new(Vec::new()));
    let subscriber = tracing_subscriber::fmt()
        .json()
        .with_writer(Capture(bytes.clone()))
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);
    let fixture = fixture(RoomConfig::default());
    let graph_id = GraphId::new(GRAPH).unwrap();
    let (_, update) = client_update(
        &fixture.snapshot,
        2,
        "private-command",
        "private-message",
        "private-page",
        "Secret note text that must not enter telemetry",
    );
    let raw_update_hex = hex::encode(&update.bytes);
    let mut opened = fixture
        .manager
        .open(
            &graph_id,
            "telemetry-session",
            OWNER,
            0,
            &fixture.base_version,
        )
        .await
        .unwrap()
        .connection;
    let mut receiver = opened.take_outbound();
    fixture
        .manager
        .submit_update(&opened, update)
        .await
        .unwrap();
    assert_ack(&mut receiver, "private-message").await;

    let output = String::from_utf8(bytes.lock().expect("capture mutex").clone()).unwrap();
    assert!(output.contains("durable update accepted"));
    for secret in [
        "Secret note text that must not enter telemetry",
        "private-message",
        "private-command",
        GRAPH,
        OWNER,
        "telemetry-session",
        "Bearer ",
        &raw_update_hex,
    ] {
        assert!(!output.contains(secret), "telemetry leaked: {secret}");
    }
}
