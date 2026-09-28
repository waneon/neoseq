//! Explicit compatibility at the portable-copy boundary. Live replicas and
//! recovery continue to require the current schema.

use crate::{CoreError, GraphCore, SCHEMA_VERSION, document::StoredPropertyShape};
use domain::{Cardinality, GraphId, PropertyField, PropertyType, validate_property_field};
use loro::{Container, ExportMode, LoroDoc, LoroMap, LoroValue, ValueOrContainer};
use std::collections::BTreeMap;

impl GraphCore {
    /// Opens an archive source for copying, upgrading supported legacy storage
    /// in memory. The declared schema must agree with the snapshot itself.
    pub fn from_archive_snapshot(
        graph_id: GraphId,
        peer_id: u64,
        document_schema: u32,
        snapshot: &[u8],
    ) -> Result<Self, CoreError> {
        match document_schema {
            SCHEMA_VERSION | 7 => Self::from_snapshot(graph_id, peer_id, snapshot),
            6 => {
                let doc = LoroDoc::from_snapshot(snapshot)?;
                let meta = doc.get_map("meta");
                if !matches!(meta.get("graph_id"), Some(ValueOrContainer::Value(LoroValue::String(value))) if value.as_ref() == graph_id.as_str())
                {
                    return Err(CoreError::SnapshotGraphMismatch);
                }
                if !matches!(
                    meta.get("schema_version"),
                    Some(ValueOrContainer::Value(LoroValue::I64(6)))
                ) {
                    return Err(invalid("archive manifest and snapshot schemas disagree"));
                }
                if let Some(writer) = meta.get("minimum_writer_schema")
                    && !matches!(writer, ValueOrContainer::Value(LoroValue::I64(1..=6)))
                {
                    return Err(invalid("unsupported archive minimum writer schema"));
                }
                crate::core::configure_inline_content(&doc);
                doc.set_peer_id(peer_id)?;
                migrate_v6(&doc)?;
                meta.insert("schema_version", i64::from(SCHEMA_VERSION))?;
                meta.delete("minimum_writer_schema")?;
                meta.delete("applied_migrations")?;
                doc.set_next_commit_origin("system:archive-migration");
                doc.commit();
                Self::from_snapshot(graph_id, peer_id, &doc.export(ExportMode::Snapshot)?)
            }
            version => Err(CoreError::UnsupportedSchema(i64::from(version))),
        }
    }
}

fn invalid(message: &str) -> CoreError {
    CoreError::InvalidHierarchy(message.to_owned())
}

fn map(value: Option<ValueOrContainer>) -> Result<LoroMap, CoreError> {
    match value {
        Some(ValueOrContainer::Container(Container::Map(map))) => Ok(map),
        _ => Err(invalid("schema 6 archive is missing a required map")),
    }
}

fn migrate_v6(doc: &LoroDoc) -> Result<(), CoreError> {
    for root in ["pages", "tags"] {
        let entities = doc.get_map(root);
        for id in entities.keys() {
            let entity = map(entities.get(&id))?;
            if root == "pages" {
                let node = map(entity.get("root"))?;
                migrate_bag(&map(node.get("properties"))?)?;
            } else {
                migrate_bag(&map(entity.get("properties"))?)?;
                migrate_bag(&map(entity.get("defaults"))?)?;
            }
            let Some(ValueOrContainer::Container(Container::Tree(outline))) = entity.get("outline")
            else {
                return Err(invalid("schema 6 archive is missing a required outline"));
            };
            for node in outline.nodes() {
                let metadata = outline.get_meta(node)?;
                if metadata.is_empty() && outline.is_node_deleted(&node)? {
                    continue;
                }
                migrate_bag(&map(metadata.get("properties"))?)?;
            }
        }
    }
    Ok(())
}

fn migrate_bag(bag: &LoroMap) -> Result<(), CoreError> {
    // Capture the old slots before introducing new field generations. Reject
    // malformed or orphaned slots instead of silently losing authored data.
    let mut slots = BTreeMap::new();
    bag.for_each(|key, value| {
        slots.insert(key.to_owned(), value);
    });
    let mut fields = BTreeMap::new();
    for (slot, value) in &slots {
        let Some(key) = slot.strip_prefix("f:") else {
            continue;
        };
        let ValueOrContainer::Value(LoroValue::String(encoded)) = value else {
            return Err(invalid("schema 6 property marker must be a string"));
        };
        let marker: PropertyField = serde_json::from_str(encoded)?;
        if marker.key.as_str() != key || !marker.values.is_empty() {
            return Err(invalid("schema 6 property marker is invalid"));
        }
        validate_property_field(&marker)?;
        let field = bag.insert_container(key, LoroMap::new())?;
        field.insert(
            "shape",
            serde_json::to_string(&StoredPropertyShape {
                value_type: marker.value_type,
                cardinality: marker.cardinality,
            })?,
        )?;
        if marker.cardinality == Cardinality::Set {
            field.ensure_mergeable_map("set")?;
        }
        fields.insert(key, (marker, field));
    }
    for (slot, value) in &slots {
        let Some((kind, rest)) = slot.split_once(':') else {
            return Err(invalid("invalid schema 6 property slot"));
        };
        if kind == "f" {
            continue;
        }
        let (key, member) = if kind == "r" {
            let (key, member) = rest
                .rsplit_once(':')
                .ok_or_else(|| invalid("invalid schema 6 set member slot"))?;
            (key, Some(member))
        } else {
            (rest, None)
        };
        let (marker, field) = fields
            .get(key)
            .ok_or_else(|| invalid("schema 6 property payload has no field marker"))?;
        match (kind, marker.value_type, marker.cardinality, value) {
            ("s", value_type, Cardinality::Single, ValueOrContainer::Value(value))
                if value_type != PropertyType::Document =>
            {
                field.insert("single", value.clone())?;
            }
            ("r", value_type, Cardinality::Set, ValueOrContainer::Value(value))
                if value_type != PropertyType::Document =>
            {
                field
                    .ensure_mergeable_map("set")?
                    .insert(member.expect("set member parsed above"), value.clone())?;
            }
            (
                "d",
                PropertyType::Document,
                Cardinality::Single,
                ValueOrContainer::Container(Container::Map(document)),
            ) => {
                copy_document(document, &field.ensure_mergeable_map("document")?, 0)?;
            }
            _ => {
                return Err(invalid(
                    "schema 6 property payload does not match its field",
                ));
            }
        }
    }
    for slot in slots.keys() {
        bag.delete(slot)?;
    }
    Ok(())
}

fn copy_document(source: &LoroMap, target: &LoroMap, depth: usize) -> Result<(), CoreError> {
    if depth > 32 {
        return Err(invalid("archive query document is nested too deeply"));
    }
    for key in source.keys() {
        match source.get(&key) {
            Some(ValueOrContainer::Value(value)) => target.insert(&key, value)?,
            Some(ValueOrContainer::Container(Container::Map(child))) => {
                copy_document(&child, &target.ensure_mergeable_map(&key)?, depth + 1)?;
            }
            Some(ValueOrContainer::Container(Container::Text(text))) => {
                target
                    .ensure_mergeable_text(&key)?
                    .apply_delta(&text.to_delta())?;
            }
            _ => return Err(invalid("unsupported archive query document container")),
        }
    }
    Ok(())
}
