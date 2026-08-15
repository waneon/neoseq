//! Versioned, size-bounded binary protocol shared by sync clients and the server.

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const WIRE_VERSION: u16 = 1;
pub const PROTOCOL_VERSION: u16 = 1;
pub const HEADER_LEN: usize = 10;
const MAGIC: [u8; 4] = *b"NSQP";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct VersionRange {
    pub min: u16,
    pub max: u16,
}

impl VersionRange {
    pub const fn exact(version: u16) -> Self {
        Self {
            min: version,
            max: version,
        }
    }

    pub fn select(self, supported: Self) -> Option<u16> {
        let min = self.min.max(supported.min);
        let max = self.max.min(supported.max);
        (min <= max).then_some(max)
    }

    pub const fn is_valid(self) -> bool {
        self.min <= self.max
    }
}

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
            max_decompressed_bytes: 524_288,
            max_presence_bytes: 4_096,
            session_queue_capacity: 64,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GraphStatus {
    Active,
    ReadOnly,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hello {
    pub protocol: VersionRange,
    pub schema: VersionRange,
    pub graph_id: String,
    pub session_id: String,
    /// Loro's encoded version vector. Transport cursors are never substituted here.
    pub version_vector: Vec<u8>,
    pub last_acknowledgement: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Welcome {
    pub protocol: u16,
    pub schema: u16,
    pub graph_status: GraphStatus,
    pub limits: Limits,
    pub membership_version: u64,
    pub server_cursor: u64,
    pub server_version_vector: Vec<u8>,
    /// A Loro update containing operations absent from the client's version vector.
    pub missing_update: Vec<u8>,
    /// A Loro snapshot offered when an incremental update would exceed the
    /// negotiated update limit. Empty when `missing_update` is used.
    pub checkpoint: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Update {
    pub message_id: String,
    pub base_version_vector: Vec<u8>,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ack {
    pub message_id: String,
    pub server_cursor: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Presence {
    pub sequence: u64,
    pub expires_in_ms: u32,
    pub payload: Vec<u8>,
}

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
    AuthenticationRequired,
    AccessDenied,
    MembershipRevoked,
    RateLimited,
    StorageUnavailable,
    GraphLimitExceeded,
    SlowConsumer,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorMessage {
    pub code: ErrorCode,
    pub recoverable: bool,
    /// Stable, content-free diagnostic suitable for logs and clients.
    pub diagnostic: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResyncRequired {
    pub code: ErrorCode,
    pub server_cursor: u64,
    pub diagnostic: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Message {
    Hello(Hello),
    Welcome(Welcome),
    Update(Update),
    Ack(Ack),
    Presence(Presence),
    Error(ErrorMessage),
    ResyncRequired(ResyncRequired),
}

impl Message {
    pub const fn kind(&self) -> &'static str {
        match self {
            Self::Hello(_) => "hello",
            Self::Welcome(_) => "welcome",
            Self::Update(_) => "update",
            Self::Ack(_) => "ack",
            Self::Presence(_) => "presence",
            Self::Error(_) => "error",
            Self::ResyncRequired(_) => "resync_required",
        }
    }
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

pub fn encode(message: &Message, max_frame_bytes: usize) -> Result<Vec<u8>, ProtocolError> {
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
    postcard::from_bytes(&frame[HEADER_LEN..])
        .map_err(|_| ProtocolError::new(ErrorCode::MalformedFrame, "invalid message payload"))
}

pub fn validate_message(message: &Message, limits: Limits) -> Result<(), ProtocolError> {
    match message {
        Message::Hello(hello) => {
            if !hello.protocol.is_valid()
                || !hello.schema.is_valid()
                || hello.graph_id.is_empty()
                || hello.graph_id.len() > 128
                || hello.session_id.is_empty()
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
            if update.message_id.is_empty()
                || update.message_id.len() > 128
                || update.base_version_vector.len() > 16_384
            {
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
        }
        Message::Presence(presence) => {
            if presence.payload.len() > limits.max_presence_bytes as usize {
                return Err(ProtocolError::new(
                    ErrorCode::PresenceTooLarge,
                    "presence exceeds negotiated limit",
                ));
            }
        }
        Message::Welcome(_) | Message::Ack(_) | Message::Error(_) | Message::ResyncRequired(_) => {}
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
        hello: HelloFixture,
        errors: Vec<ErrorFixture>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct HelloFixture {
        graph_id: String,
        session_id: String,
        version_vector: Vec<u8>,
        last_acknowledgement: u64,
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
            protocol: VersionRange::exact(PROTOCOL_VERSION),
            schema: VersionRange::exact(1),
            graph_id: "graph-1".into(),
            session_id: "session-1".into(),
            version_vector: vec![1, 2, 3],
            last_acknowledgement: Some(7),
        })
    }

    #[test]
    fn binary_round_trip_is_stable() {
        let frame = encode(&hello(), 1024).unwrap();
        assert_eq!(&frame[..4], b"NSQP");
        assert_eq!(decode(&frame, 1024).unwrap(), hello());
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
            encode(&hello(), HEADER_LEN).unwrap_err().code,
            ErrorCode::FrameTooLarge
        );
        let limits = Limits {
            max_update_bytes: 2,
            ..Limits::default()
        };
        let update = Message::Update(Update {
            message_id: "m1".into(),
            base_version_vector: Vec::new(),
            bytes: vec![0; 3],
        });
        assert_eq!(
            validate_message(&update, limits).unwrap_err().code,
            ErrorCode::UpdateTooLarge
        );
    }

    #[test]
    fn selects_highest_shared_version() {
        assert_eq!(
            VersionRange { min: 1, max: 4 }.select(VersionRange { min: 2, max: 3 }),
            Some(3)
        );
        assert_eq!(
            VersionRange { min: 1, max: 2 }.select(VersionRange { min: 3, max: 4 }),
            None
        );
    }

    #[test]
    fn shared_normal_and_error_fixture_is_current() {
        let fixture: Fixture =
            serde_json::from_str(include_str!("../../../fixtures/sync-protocol/current.json"))
                .unwrap();
        assert_eq!(fixture.protocol_version, PROTOCOL_VERSION);
        let message = Message::Hello(Hello {
            protocol: VersionRange::exact(fixture.protocol_version),
            schema: VersionRange::exact(1),
            graph_id: fixture.hello.graph_id,
            session_id: fixture.hello.session_id,
            version_vector: fixture.hello.version_vector,
            last_acknowledgement: Some(fixture.hello.last_acknowledgement),
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
