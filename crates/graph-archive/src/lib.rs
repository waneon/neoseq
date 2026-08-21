//! Versioned, size-bounded packaging for portable Neoseq graph copies.
//!
//! This crate owns the untrusted archive container, not graph semantics. The
//! caller must still open the decoded Loro snapshot through `GraphCore` before
//! installing it in a repository.

use domain::GraphId;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read, Write};
use thiserror::Error;
use zip::{CompressionMethod, ZipArchive, ZipWriter, write::SimpleFileOptions};

pub const FORMAT: &str = "neoseq.graph-archive";
pub const ARCHIVE_VERSION: u32 = 1;
pub const PAYLOAD_ENCODING: &str = "loro-snapshot/v1";
pub const MANIFEST_PATH: &str = "manifest.json";
pub const SNAPSHOT_PATH: &str = "graph.loro";
pub const MAX_ARCHIVE_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_MANIFEST_BYTES: usize = 64 * 1024;
pub const MAX_SNAPSHOT_BYTES: usize = 256 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchiveManifest {
    pub format: String,
    pub archive_version: u32,
    pub archive_id: String,
    pub source: ArchiveSource,
    pub payload_encoding: String,
    pub exported_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggested_name: Option<String>,
    pub payload: ArchivePayload,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchiveSource {
    pub graph_id: GraphId,
    pub document_schema: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchivePayload {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone)]
pub struct ArchiveMetadata {
    pub archive_id: String,
    pub source_graph_id: GraphId,
    pub document_schema: u32,
    pub exported_at: String,
    pub suggested_name: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DecodedArchive {
    pub manifest: ArchiveManifest,
    pub snapshot: Vec<u8>,
}

#[derive(Debug, Error)]
pub enum ArchiveError {
    #[error("archive exceeds the size limit")]
    ArchiveTooLarge,
    #[error("archive must contain exactly manifest.json and graph.loro")]
    InvalidEntries,
    #[error("archive entries must use the stored ZIP method")]
    UnsupportedCompression,
    #[error("archive manifest exceeds the size limit")]
    ManifestTooLarge,
    #[error("archive graph snapshot exceeds the size limit")]
    SnapshotTooLarge,
    #[error("unsupported archive format or version")]
    UnsupportedVersion,
    #[error("archive manifest is invalid: {0}")]
    InvalidManifest(String),
    #[error("archive graph snapshot checksum does not match the manifest")]
    ChecksumMismatch,
    #[error("ZIP archive is invalid: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("archive I/O failed: {0}")]
    Io(#[from] std::io::Error),
}

pub fn encode(snapshot: &[u8], metadata: ArchiveMetadata) -> Result<Vec<u8>, ArchiveError> {
    if snapshot.len() > MAX_SNAPSHOT_BYTES {
        return Err(ArchiveError::SnapshotTooLarge);
    }
    validate_metadata(&metadata)?;
    let manifest = ArchiveManifest {
        format: FORMAT.to_owned(),
        archive_version: ARCHIVE_VERSION,
        archive_id: metadata.archive_id,
        source: ArchiveSource {
            graph_id: metadata.source_graph_id,
            document_schema: metadata.document_schema,
        },
        payload_encoding: PAYLOAD_ENCODING.to_owned(),
        exported_at: metadata.exported_at,
        suggested_name: metadata.suggested_name,
        payload: ArchivePayload {
            path: SNAPSHOT_PATH.to_owned(),
            size: snapshot.len() as u64,
            sha256: digest(snapshot),
        },
    };
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| ArchiveError::InvalidManifest(error.to_string()))?;
    if manifest_bytes.len() > MAX_MANIFEST_BYTES {
        return Err(ArchiveError::ManifestTooLarge);
    }

    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .unix_permissions(0o600);
    writer.start_file(MANIFEST_PATH, options)?;
    writer.write_all(&manifest_bytes)?;
    writer.start_file(SNAPSHOT_PATH, options)?;
    writer.write_all(snapshot)?;
    let bytes = writer.finish()?.into_inner();
    if bytes.len() > MAX_ARCHIVE_BYTES {
        return Err(ArchiveError::ArchiveTooLarge);
    }
    Ok(bytes)
}

pub fn decode(bytes: &[u8]) -> Result<DecodedArchive, ArchiveError> {
    if bytes.len() > MAX_ARCHIVE_BYTES {
        return Err(ArchiveError::ArchiveTooLarge);
    }
    let mut archive = ZipArchive::new(Cursor::new(bytes))?;
    if archive.len() != 2 {
        return Err(ArchiveError::InvalidEntries);
    }

    let mut manifest_bytes = None;
    let mut snapshot = None;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index)?;
        if file.compression() != CompressionMethod::Stored || file.is_dir() {
            return Err(ArchiveError::UnsupportedCompression);
        }
        match file.name() {
            MANIFEST_PATH => {
                if manifest_bytes.is_some() || file.size() > MAX_MANIFEST_BYTES as u64 {
                    return Err(if file.size() > MAX_MANIFEST_BYTES as u64 {
                        ArchiveError::ManifestTooLarge
                    } else {
                        ArchiveError::InvalidEntries
                    });
                }
                let mut value = Vec::with_capacity(file.size() as usize);
                file.read_to_end(&mut value)?;
                manifest_bytes = Some(value);
            }
            SNAPSHOT_PATH => {
                if snapshot.is_some() || file.size() > MAX_SNAPSHOT_BYTES as u64 {
                    return Err(if file.size() > MAX_SNAPSHOT_BYTES as u64 {
                        ArchiveError::SnapshotTooLarge
                    } else {
                        ArchiveError::InvalidEntries
                    });
                }
                let mut value = Vec::with_capacity(file.size() as usize);
                file.read_to_end(&mut value)?;
                snapshot = Some(value);
            }
            _ => return Err(ArchiveError::InvalidEntries),
        }
    }

    let manifest: ArchiveManifest = serde_json::from_slice(
        manifest_bytes
            .as_deref()
            .ok_or(ArchiveError::InvalidEntries)?,
    )
    .map_err(|error| ArchiveError::InvalidManifest(error.to_string()))?;
    validate_manifest(&manifest)?;
    let snapshot = snapshot.ok_or(ArchiveError::InvalidEntries)?;
    if manifest.payload.size != snapshot.len() as u64
        || manifest.payload.sha256 != digest(&snapshot)
    {
        return Err(ArchiveError::ChecksumMismatch);
    }
    Ok(DecodedArchive { manifest, snapshot })
}

fn validate_metadata(metadata: &ArchiveMetadata) -> Result<(), ArchiveError> {
    if metadata.archive_id.is_empty()
        || metadata.archive_id.len() > 160
        || metadata.archive_id.chars().any(char::is_control)
        || metadata.exported_at.is_empty()
        || metadata.exported_at.len() > 64
        || metadata.exported_at.chars().any(char::is_control)
        || metadata
            .suggested_name
            .as_ref()
            .is_some_and(|name| name.len() > 256 || name.chars().any(char::is_control))
    {
        return Err(ArchiveError::InvalidManifest(
            "archive metadata is outside its limits".to_owned(),
        ));
    }
    Ok(())
}

fn validate_manifest(manifest: &ArchiveManifest) -> Result<(), ArchiveError> {
    if manifest.format != FORMAT
        || manifest.archive_version != ARCHIVE_VERSION
        || manifest.payload_encoding != PAYLOAD_ENCODING
    {
        return Err(ArchiveError::UnsupportedVersion);
    }
    if manifest.payload.path != SNAPSHOT_PATH {
        return Err(ArchiveError::InvalidEntries);
    }
    if manifest.source.document_schema == 0 {
        return Err(ArchiveError::InvalidManifest(
            "document schema must be positive".to_owned(),
        ));
    }
    validate_metadata(&ArchiveMetadata {
        archive_id: manifest.archive_id.clone(),
        source_graph_id: manifest.source.graph_id.clone(),
        document_schema: manifest.source.document_schema,
        exported_at: manifest.exported_at.clone(),
        suggested_name: manifest.suggested_name.clone(),
    })
}

fn digest(bytes: &[u8]) -> String {
    hex_lower(&Sha256::digest(bytes))
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata() -> ArchiveMetadata {
        ArchiveMetadata {
            archive_id: "archive-1".to_owned(),
            source_graph_id: GraphId::new("source-graph").unwrap(),
            document_schema: 1,
            exported_at: "2026-08-21T12:00:00Z".to_owned(),
            suggested_name: Some("Research".to_owned()),
        }
    }

    #[test]
    fn round_trip_has_exact_allowlisted_entries() {
        let bytes = encode(b"loro snapshot", metadata()).unwrap();
        let decoded = decode(&bytes).unwrap();
        assert_eq!(decoded.snapshot, b"loro snapshot");
        assert_eq!(decoded.manifest.archive_id, "archive-1");
        assert_eq!(decoded.manifest.source.graph_id.as_str(), "source-graph");
        assert_eq!(decoded.manifest.suggested_name.as_deref(), Some("Research"));
    }

    #[test]
    fn rejects_an_unexpected_entry() {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        writer.start_file(MANIFEST_PATH, options).unwrap();
        writer.write_all(b"{}").unwrap();
        writer.start_file(SNAPSHOT_PATH, options).unwrap();
        writer.write_all(b"snapshot").unwrap();
        writer.start_file("../secret", options).unwrap();
        writer.write_all(b"secret").unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        assert!(matches!(decode(&bytes), Err(ArchiveError::InvalidEntries)));
    }

    #[test]
    fn rejects_a_payload_that_does_not_match_the_manifest() {
        let bytes = encode(b"original", metadata()).unwrap();
        let decoded = decode(&bytes).unwrap();
        let mut manifest = decoded.manifest;
        manifest.payload.sha256 = "00".repeat(32);

        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        writer.start_file(MANIFEST_PATH, options).unwrap();
        writer
            .write_all(&serde_json::to_vec(&manifest).unwrap())
            .unwrap();
        writer.start_file(SNAPSHOT_PATH, options).unwrap();
        writer.write_all(b"original").unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        assert!(matches!(
            decode(&bytes),
            Err(ArchiveError::ChecksumMismatch)
        ));
    }

    #[test]
    fn rejects_unknown_manifest_fields() {
        let bytes = encode(b"snapshot", metadata()).unwrap();
        let decoded = decode(&bytes).unwrap();
        let mut manifest = serde_json::to_value(decoded.manifest).unwrap();
        manifest
            .as_object_mut()
            .unwrap()
            .insert("target_graph_id".to_owned(), serde_json::json!("existing"));

        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        writer.start_file(MANIFEST_PATH, options).unwrap();
        writer
            .write_all(&serde_json::to_vec(&manifest).unwrap())
            .unwrap();
        writer.start_file(SNAPSHOT_PATH, options).unwrap();
        writer.write_all(b"snapshot").unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        assert!(matches!(
            decode(&bytes),
            Err(ArchiveError::InvalidManifest(_))
        ));
    }
}
