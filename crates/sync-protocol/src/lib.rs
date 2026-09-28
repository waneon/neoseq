//! Versioned, size-bounded binary protocol shared by sync clients and the server.

use domain::GraphId;
use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;
use thiserror::Error;

pub mod generated {
    pub mod wire;
}
pub use generated::wire::*;

/// Envelope framing revision. Unlike the negotiated protocol version it never
/// crosses a language boundary: only `encode` and `decode` below read it.
pub const WIRE_VERSION: u16 = 1;
pub const HEADER_LEN: usize = 10;
pub const DEFAULT_MAX_GRAPH_BYTES: u32 = 1024 * 1024 * 1024;
/// Canonical wire/storage identity of an update: lowercase SHA-256 hex.
pub const CONTENT_ID_HEX_LEN: usize = 64;
const MAGIC: [u8; 4] = *b"NSQP";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Limits {
    pub max_frame_bytes: u32,
    pub max_update_bytes: u32,
    /// Maximum reconstructed Loro snapshot size accepted after an import.
    pub max_decompressed_bytes: u32,
    pub max_presence_bytes: u32,
    pub session_queue_capacity: u16,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_frame_bytes: 1_048_576,
            max_update_bytes: 524_288,
            // Bulk checkpoints travel over authenticated HTTP rather than the
            // bounded WebSocket control/update channel.
            max_decompressed_bytes: DEFAULT_MAX_GRAPH_BYTES,
            max_presence_bytes: 4_096,
            session_queue_capacity: 64,
        }
    }
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hello {
    pub protocol: u16,
    pub schema: u16,
    pub graph_id: GraphId,
    pub session_id: String,
    /// History generation owned by the server checkpoint coordinator.
    pub history_epoch: u64,
    /// Whether the local Base was installed from a server-approved checkpoint.
    pub has_server_base: bool,
    /// Loro's encoded version vector. Transport cursors are never substituted here.
    pub version_vector: Vec<u8>,
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Welcome {
    pub history_epoch: u64,
    pub server_version_vector: Vec<u8>,
    pub payload: WelcomePayload,
}

/// The one synchronization action selected for a newly opened session.
#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum WelcomePayload {
    /// Import the Loro operations absent from the client's current version vector.
    Delta { update: Vec<u8> },
    /// Download retained history and merge it into the existing replica.
    MergeDownload {},
    /// Replace local canonical state with this server-owned checkpoint.
    ReplaceInline { checkpoint: Vec<u8> },
    /// Download the replacement checkpoint from the authenticated HTTP endpoint.
    ReplaceDownload {},
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Update {
    pub history_epoch: u64,
    /// Content-addressed transport identity; must match `bytes`.
    pub message_id: ContentId,
    pub base_version_vector: Vec<u8>,
    pub bytes: Vec<u8>,
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ack {
    pub history_epoch: u64,
    /// The acknowledged update's content identity.
    pub message_id: ContentId,
    pub server_cursor: u64,
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Presence {
    pub expires_in_ms: u32,
    pub payload: Vec<u8>,
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    MalformedFrame,
    UnsupportedProtocol,
    UnsupportedSchema,
    FrameTooLarge,
    UpdateTooLarge,
    PresenceTooLarge,
    InvalidMessage,
    InvalidUpdate,
    AccessDenied,
    MembershipRevoked,
    RateLimited,
    StorageUnavailable,
    GraphLimitExceeded,
    StaleHistory,
    SlowConsumer,
    Internal,
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorMessage {
    pub code: ErrorCode,
    pub recoverable: bool,
    /// Stable, content-free diagnostic suitable for logs and clients.
    pub diagnostic: String,
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResyncRequired {
    pub code: ErrorCode,
    pub server_cursor: u64,
    pub history_epoch: u64,
    pub diagnostic: String,
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Message {
    Hello(Hello),
    Welcome(Welcome),
    Update(Update),
    Ack(Ack),
    Presence(Presence),
    Error(ErrorMessage),
    ResyncRequired(ResyncRequired),
    /// Echoed by the server to detect a stalled transport without touching graph state.
    Heartbeat {
        nonce: u32,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("protocol error {code:?}: {diagnostic}")]
pub struct ProtocolError {
    pub code: ErrorCode,
    pub diagnostic: &'static str,
}

impl ProtocolError {
    const fn new(code: ErrorCode, diagnostic: &'static str) -> Self {
        Self { code, diagnostic }
    }
}

/// Canonical identity shared by an update, its outbox entry, and its durable
/// receipt. Its serialized representation is lowercase SHA-256 hex.
#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct ContentId(String);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
#[error("content id must be lowercase SHA-256 hex")]
pub struct ContentIdError;

impl ContentId {
    pub fn new(value: impl Into<String>) -> Result<Self, ContentIdError> {
        let value = value.into();
        if is_content_id(&value) {
            Ok(Self(value))
        } else {
            Err(ContentIdError)
        }
    }

    pub fn for_bytes(bytes: &[u8]) -> Self {
        Self(hex::encode(Sha256::digest(bytes)))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn matches(&self, bytes: &[u8]) -> bool {
        self == &Self::for_bytes(bytes)
    }
}

impl fmt::Display for ContentId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ContentId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

fn is_content_id(value: &str) -> bool {
    value.len() == CONTENT_ID_HEX_LEN
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_update_identity(message: &Message) -> Result<(), ProtocolError> {
    if let Message::Update(update) = message
        && !update.message_id.matches(&update.bytes)
    {
        return Err(ProtocolError::new(
            ErrorCode::InvalidUpdate,
            "update content id does not match its bytes",
        ));
    }
    Ok(())
}

pub fn encode(message: &Message, max_frame_bytes: usize) -> Result<Vec<u8>, ProtocolError> {
    validate_update_identity(message)?;
    let payload = postcard::to_allocvec(message).map_err(|_| {
        ProtocolError::new(ErrorCode::InvalidMessage, "message could not be encoded")
    })?;
    let frame_len = HEADER_LEN
        .checked_add(payload.len())
        .ok_or_else(|| ProtocolError::new(ErrorCode::FrameTooLarge, "frame length overflow"))?;
    if frame_len > max_frame_bytes || payload.len() > u32::MAX as usize {
        return Err(ProtocolError::new(
            ErrorCode::FrameTooLarge,
            "frame exceeds negotiated limit",
        ));
    }

    let mut frame = Vec::with_capacity(frame_len);
    frame.extend_from_slice(&MAGIC);
    frame.extend_from_slice(&WIRE_VERSION.to_be_bytes());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

pub fn decode(frame: &[u8], max_frame_bytes: usize) -> Result<Message, ProtocolError> {
    if frame.len() > max_frame_bytes {
        return Err(ProtocolError::new(
            ErrorCode::FrameTooLarge,
            "frame exceeds negotiated limit",
        ));
    }
    if frame.len() < HEADER_LEN || frame[..4] != MAGIC {
        return Err(ProtocolError::new(
            ErrorCode::MalformedFrame,
            "invalid frame header",
        ));
    }
    let wire_version = u16::from_be_bytes([frame[4], frame[5]]);
    if wire_version != WIRE_VERSION {
        return Err(ProtocolError::new(
            ErrorCode::UnsupportedProtocol,
            "unsupported wire version",
        ));
    }
    let declared = u32::from_be_bytes([frame[6], frame[7], frame[8], frame[9]]) as usize;
    if declared != frame.len() - HEADER_LEN {
        return Err(ProtocolError::new(
            ErrorCode::MalformedFrame,
            "frame length mismatch",
        ));
    }
    let message = postcard::from_bytes(&frame[HEADER_LEN..])
        .map_err(|_| ProtocolError::new(ErrorCode::MalformedFrame, "invalid message payload"))?;
    validate_update_identity(&message)?;
    Ok(message)
}

pub fn validate_message(message: &Message, limits: Limits) -> Result<(), ProtocolError> {
    match message {
        Message::Hello(hello) => {
            if hello.session_id.is_empty()
                || hello.session_id.len() > 128
                || hello.version_vector.len() > 16_384
            {
                return Err(ProtocolError::new(
                    ErrorCode::InvalidMessage,
                    "invalid hello metadata",
                ));
            }
        }
        Message::Update(update) => {
            if update.base_version_vector.len() > 16_384 {
                return Err(ProtocolError::new(
                    ErrorCode::InvalidMessage,
                    "invalid update metadata",
                ));
            }
            if update.bytes.len() > limits.max_update_bytes as usize {
                return Err(ProtocolError::new(
                    ErrorCode::UpdateTooLarge,
                    "update exceeds negotiated limit",
                ));
            }
            validate_update_identity(message)?;
        }
        Message::Presence(presence) => {
            if presence.payload.len() > limits.max_presence_bytes as usize {
                return Err(ProtocolError::new(
                    ErrorCode::PresenceTooLarge,
                    "presence exceeds negotiated limit",
                ));
            }
        }
        Message::Welcome(_)
        | Message::Ack(_)
        | Message::Error(_)
        | Message::ResyncRequired(_)
        | Message::Heartbeat { .. } => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        protocol_version: u16,
        schema_version: u16,
        hello: HelloFixture,
        errors: Vec<ErrorFixture>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct HelloFixture {
        graph_id: String,
        session_id: String,
        has_server_base: bool,
        version_vector: Vec<u8>,
        frame_hex: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ErrorFixture {
        name: String,
        frame_hex: String,
        max_bytes: usize,
        code: ErrorCode,
    }

    fn hello() -> Message {
        Message::Hello(Hello {
            protocol: PROTOCOL_VERSION,
            schema: 6,
            graph_id: GraphId::new("graph-1").unwrap(),
            session_id: "session-1".into(),
            history_epoch: 0,
            has_server_base: true,
            version_vector: vec![1, 2, 3],
        })
    }

    #[test]
    fn binary_round_trip_is_stable() {
        let frame = encode(&hello(), 1024).unwrap();
        assert_eq!(&frame[..4], b"NSQP");
        assert_eq!(decode(&frame, 1024).unwrap(), hello());
    }

    #[test]
    fn welcome_payload_selects_exactly_one_sync_action() {
        let cases = [
            WelcomePayload::Delta { update: vec![1, 2] },
            WelcomePayload::MergeDownload {},
            WelcomePayload::ReplaceInline {
                checkpoint: vec![3, 4],
            },
            WelcomePayload::ReplaceDownload {},
        ];
        for payload in cases {
            let message = Message::Welcome(Welcome {
                history_epoch: 7,
                server_version_vector: vec![8, 9],
                payload,
            });
            let frame = encode(&message, 1024).unwrap();
            assert_eq!(decode(&frame, 1024).unwrap(), message);
        }

        assert_eq!(
            serde_json::to_value(WelcomePayload::Delta { update: vec![1] }).unwrap(),
            serde_json::json!({ "delta": { "update": [1] } })
        );
        assert_eq!(
            serde_json::to_value(WelcomePayload::ReplaceInline {
                checkpoint: vec![2]
            })
            .unwrap(),
            serde_json::json!({ "replace_inline": { "checkpoint": [2] } })
        );
        assert_eq!(
            serde_json::to_value(WelcomePayload::ReplaceDownload {}).unwrap(),
            serde_json::json!({ "replace_download": {} })
        );
        assert!(
            serde_json::from_value::<WelcomePayload>(serde_json::json!({
                "delta": { "update": [1], "checkpoint": [2] }
            }))
            .is_err()
        );
    }

    #[test]
    fn welcome_payload_rejects_multiple_actions() {
        assert!(
            serde_json::from_value::<WelcomePayload>(serde_json::json!({
                "delta": { "update": [] },
                "replace_inline": { "checkpoint": [1] }
            }))
            .is_err()
        );
    }

    #[test]
    fn hello_graph_ids_follow_domain_validation() {
        let hello_json = |graph_id: String| {
            serde_json::json!({
                "Hello": {
                    "protocol": PROTOCOL_VERSION,
                    "schema": 6,
                    "graph_id": graph_id,
                    "session_id": "session-1",
                    "history_epoch": 0,
                    "has_server_base": true,
                    "version_vector": []
                }
            })
        };

        assert!(serde_json::from_value::<Message>(hello_json("g".repeat(160))).is_ok());
        assert!(serde_json::from_value::<Message>(hello_json("g".repeat(161))).is_err());
        assert!(serde_json::from_value::<Message>(hello_json(String::new())).is_err());
    }

    #[test]
    fn rejects_unknown_wire_version_and_length() {
        let mut frame = encode(&hello(), 1024).unwrap();
        frame[5] = 2;
        assert_eq!(
            decode(&frame, 1024).unwrap_err().code,
            ErrorCode::UnsupportedProtocol
        );

        let mut frame = encode(&hello(), 1024).unwrap();
        frame[9] = frame[9].saturating_add(1);
        assert_eq!(
            decode(&frame, 1024).unwrap_err().code,
            ErrorCode::MalformedFrame
        );
    }

    #[test]
    fn enforces_frame_and_payload_limits() {
        assert_eq!(
            Limits::default().max_decompressed_bytes,
            DEFAULT_MAX_GRAPH_BYTES
        );
        assert_eq!(
            encode(&hello(), HEADER_LEN).unwrap_err().code,
            ErrorCode::FrameTooLarge
        );
        let limits = Limits {
            max_update_bytes: 2,
            ..Limits::default()
        };
        let update = Message::Update(Update {
            history_epoch: 0,
            message_id: ContentId::for_bytes(&[0; 3]),
            base_version_vector: Vec::new(),
            bytes: vec![0; 3],
        });
        assert_eq!(
            validate_message(&update, limits).unwrap_err().code,
            ErrorCode::UpdateTooLarge
        );
    }

    #[test]
    fn update_identity_is_canonical_and_bound_to_bytes() {
        let bytes = b"content-addressed update".to_vec();
        let identity = ContentId::for_bytes(&bytes);
        assert_eq!(identity.as_str().len(), CONTENT_ID_HEX_LEN);
        assert!(identity.matches(&bytes));
        assert_eq!(serde_json::to_value(&identity).unwrap(), identity.as_str());
        assert_eq!(
            ContentId::for_bytes(b"abc").as_str(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );

        let message = Message::Update(Update {
            history_epoch: 0,
            message_id: identity.clone(),
            base_version_vector: Vec::new(),
            bytes: bytes.clone(),
        });
        let frame = encode(&message, 1024).unwrap();
        assert_eq!(decode(&frame, 1024).unwrap(), message);

        let mut noncanonical_frame = frame.clone();
        let identity_offset = noncanonical_frame
            .windows(CONTENT_ID_HEX_LEN)
            .position(|window| window == identity.as_str().as_bytes())
            .expect("encoded update contains its content ID");
        noncanonical_frame[identity_offset] = b'A';
        assert_eq!(
            decode(&noncanonical_frame, 1024).unwrap_err().code,
            ErrorCode::MalformedFrame
        );

        let mut altered_frame = frame;
        *altered_frame.last_mut().unwrap() ^= 1;
        assert_eq!(
            decode(&altered_frame, 1024).unwrap_err().code,
            ErrorCode::InvalidUpdate
        );

        let uppercase = "A".repeat(CONTENT_ID_HEX_LEN);
        assert_eq!(uppercase.len(), CONTENT_ID_HEX_LEN);
        assert_eq!(ContentId::new(&uppercase), Err(ContentIdError));
        assert!(serde_json::from_value::<ContentId>(uppercase.into()).is_err());
        assert_eq!(ContentId::new("a".repeat(63)), Err(ContentIdError));

        let mismatched = Message::Update(Update {
            history_epoch: 0,
            message_id: identity,
            base_version_vector: Vec::new(),
            bytes: b"different bytes".to_vec(),
        });
        assert_eq!(
            validate_message(&mismatched, Limits::default())
                .unwrap_err()
                .code,
            ErrorCode::InvalidUpdate
        );
        assert_eq!(
            encode(&mismatched, 1024).unwrap_err().code,
            ErrorCode::InvalidUpdate
        );
    }

    #[test]
    fn shared_normal_and_error_fixture_is_current() {
        let fixture: Fixture =
            serde_json::from_str(include_str!("../../../fixtures/sync-protocol/current.json"))
                .unwrap();
        assert_eq!(fixture.protocol_version, PROTOCOL_VERSION);
        let message = Message::Hello(Hello {
            protocol: fixture.protocol_version,
            schema: fixture.schema_version,
            graph_id: GraphId::new(fixture.hello.graph_id).unwrap(),
            session_id: fixture.hello.session_id,
            history_epoch: 0,
            has_server_base: fixture.hello.has_server_base,
            version_vector: fixture.hello.version_vector,
        });
        assert_eq!(
            hex::encode(encode(&message, 1024).unwrap()),
            fixture.hello.frame_hex
        );
        for error in fixture.errors {
            let frame = hex::decode(error.frame_hex).unwrap();
            assert_eq!(
                decode(&frame, error.max_bytes).unwrap_err().code,
                error.code,
                "fixture {}",
                error.name
            );
        }
    }
}
