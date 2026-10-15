//! Validation for the canonical causal document.
//!
//! This module deliberately depends on Loro and the domain envelope only. It
//! validates persisted container shapes without constructing a graph
//! projection, compiling a query, or applying editor policy.

use crate::core::CoreError;
use domain::{
    Cardinality, DefaultQueryId, GraphId, PageId, PropertyKey, PropertyType, PropertyValue,
    QUERY_DOCUMENT_SCHEMA, QUERY_DOCUMENT_VERSION, QUERY_LANGUAGE, QueryPlan, QueryViewColumn,
    QueryViewId, TagId, validate_property, validate_property_shape,
};
use loro::{
    Container, Index, LoroDoc, LoroMap, LoroText, LoroTree, LoroValue, TextDelta, TreeExternalDiff,
    TreeID, ValueOrContainer,
    event::{ContainerDiff, Diff, DiffEvent},
};
use std::collections::BTreeSet;

pub(crate) const GRAPH_SETTINGS_SCHEMA_VERSION: u32 = 1;
pub(crate) const MAX_DEFAULT_QUERY_TITLE: usize = 80;
pub(crate) const MAX_ENTITY_NAME_BYTES: usize = 1024;
pub(crate) const PAGE_REFERENCE_MARK: &str = "neoseq.page-reference";
pub(crate) const PAGE_REFERENCE_CHAR: char = '\u{fffc}';

/// One property field is one regular child-container generation selected by
/// the containing bag's LWW register. Payloads merge only after replicas share
/// that generation; concurrent first creations choose one whole child.
pub(crate) const PROPERTY_SHAPE_KEY: &str = "shape";
pub(crate) const PROPERTY_SINGLE_KEY: &str = "single";
pub(crate) const PROPERTY_SET_KEY: &str = "set";
pub(crate) const PROPERTY_DOCUMENT_KEY: &str = "document";

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct StoredPropertyShape {
    pub(crate) value_type: PropertyType,
    pub(crate) cardinality: Cardinality,
}

/// Atomic authority register for one query definition. The explicit Raw state
/// prevents legacy plan slots from becoming authoritative again after a plan
/// is removed.
pub(crate) const QUERY_PLAN_STATE_KEY: &str = "plan_state";
pub(crate) const QUERY_PLAN_STATE_VERSION: u32 = 1;

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum StoredPlanState {
    Raw,
    Built { version: u32, plan: QueryPlan },
}

/// Validates only the merge-closed storage contract shared by interactive and
/// server replicas. Query execution and visible projection belong to
/// `GraphCore`, not to this causal boundary.
pub(crate) fn validate_causal_document(doc: &LoroDoc, graph_id: &GraphId) -> Result<(), CoreError> {
    validate_metadata(doc, graph_id)?;
    let homes = Homes::new(doc);
    for (home, records) in HOMES.iter().zip(&homes.0) {
        for raw_id in records.keys() {
            homes.require_single(&raw_id)?;
            validate_document(home, &raw_id, records, &homes, true)?;
        }
    }
    validate_graph_settings(doc)
}

/// The containers an imported update changed, as validation units. A change
/// that does not fit a unit asks for the whole document to be validated.
#[derive(Debug, Default)]
pub(crate) struct CausalChanges {
    full: bool,
    metadata: bool,
    settings: bool,
    /// Documents whose record-level fields changed: names, properties, kinds.
    headers: BTreeSet<(&'static str, String)>,
    /// Documents to validate completely: new, or with a replaced outline.
    documents: BTreeSet<(&'static str, String)>,
    /// Blocks created or edited, by document.
    blocks: BTreeSet<(&'static str, String, TreeID)>,
}

impl CausalChanges {
    /// (whole document, headers, documents, blocks) — for tests.
    #[cfg(test)]
    pub(crate) fn scope(&self) -> (bool, usize, usize, usize) {
        (
            self.full,
            self.headers.len(),
            self.documents.len(),
            self.blocks.len(),
        )
    }

    pub(crate) fn record(&mut self, event: &DiffEvent<'_>) {
        for change in &event.events {
            if !self.full && !self.classify(change) {
                self.full = true;
            }
        }
    }

    /// Returns false for a change no unit covers.
    fn classify(&mut self, change: &ContainerDiff<'_>) -> bool {
        if change.is_unknown {
            return false;
        }
        let key = |index: usize| match change.path.get(index) {
            Some((_, Index::Key(key))) => Some(key.to_string()),
            _ => None,
        };
        let Some(root) = key(0) else {
            return false;
        };
        match root.as_str() {
            "meta" => self.metadata = true,
            "graph_settings" => self.settings = true,
            _ => {
                let Some(home) = HOMES.into_iter().find(|home| *home == root) else {
                    return false;
                };
                let Some(id) = key(1) else {
                    // The home map itself: documents added, replaced, or removed.
                    let Diff::Map(delta) = &change.diff else {
                        return false;
                    };
                    for (id, value) in &delta.updated {
                        if value.is_none() {
                            return false;
                        }
                        self.documents.insert((home, id.to_string()));
                    }
                    return true;
                };
                match (key(2).as_deref(), change.path.get(3)) {
                    (None, _) => {
                        self.documents.insert((home, id));
                    }
                    (Some("outline"), None) => {
                        // The tree itself: blocks created, moved, or deleted.
                        let Diff::Tree(diff) = &change.diff else {
                            return false;
                        };
                        for item in &diff.diff {
                            if matches!(item.action, TreeExternalDiff::Create { .. }) {
                                self.blocks.insert((home, id.clone(), item.target));
                            }
                        }
                    }
                    (Some("outline"), Some((_, Index::Node(node)))) => {
                        self.blocks.insert((home, id, *node));
                    }
                    (Some("outline"), Some(_)) => return false,
                    (Some(_), _) => {
                        self.headers.insert((home, id));
                    }
                }
            }
        }
        true
    }
}

/// Validates what an update changed, given a document that was valid before it.
/// Equivalent to [`validate_causal_document`] for every change it can classify.
pub(crate) fn validate_causal_changes(
    doc: &LoroDoc,
    graph_id: &GraphId,
    changes: &CausalChanges,
) -> Result<(), CoreError> {
    if changes.full {
        return validate_causal_document(doc, graph_id);
    }
    if changes.metadata {
        validate_metadata(doc, graph_id)?;
    }
    if changes.settings {
        validate_graph_settings(doc)?;
    }
    if changes.headers.is_empty() && changes.documents.is_empty() && changes.blocks.is_empty() {
        return Ok(());
    }
    // The room was valid before, so only a document this update added can
    // share its ID with another home or have broken a reference.
    let homes = Homes::new(doc);
    for (home, raw_id) in &changes.documents {
        homes.require_single(raw_id)?;
        validate_document(home, raw_id, &doc.get_map(*home), &homes, true)?;
    }
    for (home, raw_id) in &changes.headers {
        if changes.documents.contains(&(*home, raw_id.clone())) {
            continue;
        }
        validate_document(home, raw_id, &doc.get_map(*home), &homes, false)?;
    }
    for (home, raw_id, node) in &changes.blocks {
        if changes.documents.contains(&(*home, raw_id.clone())) {
            continue;
        }
        let record = required_map(
            doc.get_map(*home).get(raw_id),
            &format!("document {raw_id}"),
        )?;
        let outline = required_child_tree(&record, "outline", &format!("{home} {raw_id} outline"))?;
        let owner = format!("{}:{raw_id}", if *home == "tags" { "tag" } else { "page" });
        validate_outline_node(&outline, *node, &homes, &owner)?;
    }
    Ok(())
}

const HOMES: [&str; 3] = ["entities", "pages", "tags"];

/// The storage homes, answering document lookups in place.
struct Homes([LoroMap; 3]);

impl Homes {
    fn new(doc: &LoroDoc) -> Self {
        Self(HOMES.map(|home| doc.get_map(home)))
    }

    fn contains(&self, id: &PageId) -> bool {
        self.0
            .iter()
            .any(|records| records.get(id.as_str()).is_some())
    }

    /// A document ID lives in exactly one storage home.
    fn require_single(&self, raw_id: &str) -> Result<(), CoreError> {
        let homes = self
            .0
            .iter()
            .filter(|records| records.get(raw_id).is_some())
            .count();
        if homes > 1 {
            return Err(invalid(
                "document ID appears in multiple storage homes".into(),
            ));
        }
        Ok(())
    }
}

/// One document record; `with_outline` also validates every block.
fn validate_document(
    home: &str,
    raw_id: &str,
    records: &LoroMap,
    homes: &Homes,
    with_outline: bool,
) -> Result<(), CoreError> {
    let (outline, owner) = if home == "tags" {
        let tag_id = TagId::new(raw_id.to_string())
            .map_err(|_| invalid(format!("tag id is invalid: {raw_id}")))?;
        let tag = required_map(records.get(raw_id), &format!("tag {tag_id}"))?;
        validate_entity_fields(&tag)?;
        (validate_tag_header(&tag_id, &tag)?, format!("tag:{tag_id}"))
    } else {
        let page_id = PageId::new(raw_id.to_string())
            .map_err(|_| invalid(format!("page id is invalid: {raw_id}")))?;
        let page = required_map(records.get(raw_id), &format!("page {page_id}"))?;
        validate_entity_fields(&page)?;
        (
            validate_page_header(&page_id, &page)?,
            format!("page:{page_id}"),
        )
    };
    if with_outline {
        for node in outline.nodes() {
            validate_outline_node(&outline, node, homes, &owner)?;
        }
    }
    Ok(())
}

/// The kind register and defaults any home may carry after a conversion.
fn validate_entity_fields(record: &LoroMap) -> Result<(), CoreError> {
    if let Some(value) = record.get("kind")
        && !matches!(value, ValueOrContainer::Value(LoroValue::String(value)) if value.as_ref() == "page" || value.as_ref() == "tag")
    {
        return Err(invalid("invalid document kind or defaults".into()));
    }
    if let Some(value) = record.get("defaults") {
        required_map(Some(value), "document defaults")
            .and_then(|bag| validate_property_bag(&bag, "document defaults"))
            .map_err(|_| invalid("invalid document kind or defaults".into()))?;
    }
    Ok(())
}

fn validate_metadata(doc: &LoroDoc, graph_id: &GraphId) -> Result<(), CoreError> {
    let meta = doc.get_map("meta");
    match map_string(&meta, "graph_id") {
        Some(value) if value == graph_id.as_str() => {}
        _ => return Err(CoreError::SnapshotGraphMismatch),
    }
    let stored = map_i64(&meta, "schema_version").unwrap_or(0);
    let schema = u32::try_from(stored).map_err(|_| CoreError::UnsupportedSchema(stored))?;
    if !domain::supports_document_schema(schema) {
        return Err(CoreError::UnsupportedSchema(stored));
    }
    Ok(())
}

/// A page record without its blocks; returns its outline.
fn validate_page_header(page_id: &PageId, page: &LoroMap) -> Result<LoroTree, CoreError> {
    let root = required_child_map(page, "root", &format!("page {page_id} root"))?;
    let text = required_child_text(&root, "content", &format!("page {page_id} title"))?;
    let register = match page.get("name") {
        None => None,
        Some(ValueOrContainer::Value(LoroValue::String(name))) => Some(name.to_string()),
        Some(_) => return Err(invalid(format!("page {page_id} name is invalid"))),
    };
    let properties =
        required_child_map(&root, "properties", &format!("page {page_id} properties"))?;
    let tag_refs =
        required_child_map(&root, "tag_refs", &format!("page {page_id} tag references"))?;
    validate_tag_references(&tag_refs, &format!("page {page_id}"))?;
    validate_property_bag(&properties, &format!("page {page_id} properties"))?;
    let deleted = validate_lifecycle(&properties, true, &format!("page {page_id}"))?;

    let kind = validate_single_string_property(
        &properties,
        "builtin.page-kind",
        true,
        &format!("page {page_id}"),
    )?
    .expect("required property was validated");
    if kind != "regular" && kind != "journal" {
        return Err(invalid(format!("page {page_id} kind is invalid")));
    }
    let require_name = !deleted && kind == "regular";
    if let Some(name) = &register {
        validate_entity_name(name, "page", require_name, true)?;
    }
    // Without a register the schema-8 text is the name; beside one it is an
    // emptied leftover that still may not hold an atom.
    validate_entity_name(
        &text.to_string(),
        "page",
        register.is_none() && require_name,
        false,
    )?;
    required_child_tree(page, "outline", &format!("page {page_id} outline"))
}

/// A tag record without its blocks; returns its outline.
fn validate_tag_header(tag_id: &TagId, tag: &LoroMap) -> Result<LoroTree, CoreError> {
    let name = map_string(tag, "name")
        .ok_or_else(|| invalid(format!("tag {tag_id} name is missing or invalid")))?;
    let properties = required_child_map(tag, "properties", &format!("tag {tag_id} properties"))?;
    let defaults = required_child_map(tag, "defaults", &format!("tag {tag_id} defaults"))?;
    validate_property_bag(&properties, &format!("tag {tag_id} properties"))?;
    validate_property_bag(&defaults, &format!("tag {tag_id} defaults"))?;
    let deleted = validate_lifecycle(&properties, true, &format!("tag {tag_id}"))?;
    validate_entity_name(&name, "tag", !deleted, true)?;
    required_child_tree(tag, "outline", &format!("tag {tag_id} outline"))
}

fn validate_outline_node(
    outline: &LoroTree,
    node: TreeID,
    homes: &Homes,
    owner: &str,
) -> Result<(), CoreError> {
    let block_id = node.to_string();
    let meta = outline.get_meta(node)?;
    // Shallow snapshots can retain a deleted tree identity after its
    // metadata has been collected. A live node must always have metadata;
    // any attempted resurrection is validated again before admission.
    if meta.is_empty() && outline.is_node_deleted(&node)? {
        return Ok(());
    }
    let content = required_child_text(
        &meta,
        "content",
        &format!("{owner}: block {block_id} content"),
    )?;
    let properties = required_child_map(
        &meta,
        "properties",
        &format!("{owner}: block {block_id} properties"),
    )?;
    let tag_refs = required_child_map(
        &meta,
        "tag_refs",
        &format!("{owner}: block {block_id} tag references"),
    )?;
    validate_property_bag(
        &properties,
        &format!("{owner}: block {block_id} properties"),
    )?;
    validate_lifecycle(&properties, false, &format!("{owner}: block {block_id}"))?;
    validate_tag_references(&tag_refs, &format!("{owner}: block {block_id}"))?;
    validate_inline_page_references(&content, homes, owner)
}

fn validate_tag_references(tag_refs: &LoroMap, owner: &str) -> Result<(), CoreError> {
    for raw_id in tag_refs.keys() {
        TagId::new(raw_id.to_string())
            .map_err(|_| invalid(format!("{owner}: tag reference identity is invalid")))?;
        if !matches!(
            tag_refs.get(&raw_id),
            Some(ValueOrContainer::Value(LoroValue::Bool(true)))
        ) {
            return Err(invalid(format!("{owner}: tag reference value is invalid")));
        }
    }
    Ok(())
}

fn validate_inline_page_references(
    text: &LoroText,
    homes: &Homes,
    owner: &str,
) -> Result<(), CoreError> {
    for segment in text.to_delta() {
        let TextDelta::Insert { insert, attributes } = segment else {
            return Err(invalid(format!(
                "{owner}: block content contains a non-insert delta"
            )));
        };
        let reference = attributes
            .as_ref()
            .and_then(|attributes| attributes.get(PAGE_REFERENCE_MARK));
        match reference {
            Some(LoroValue::String(raw)) => {
                let page_id = PageId::new(raw.as_ref()).map_err(|_| {
                    invalid(format!("{owner}: page reference has an invalid identity"))
                })?;
                if !homes.contains(&page_id)
                    || insert
                        .chars()
                        .any(|character| character != PAGE_REFERENCE_CHAR)
                {
                    return Err(invalid(format!("{owner}: page reference atom is invalid")));
                }
            }
            Some(_) => {
                return Err(invalid(format!(
                    "{owner}: page reference identity is not a string"
                )));
            }
            None if insert.contains(PAGE_REFERENCE_CHAR) => {
                return Err(invalid(format!("{owner}: unmarked page reference atom")));
            }
            None => {}
        }
    }
    Ok(())
}

fn validate_lifecycle(
    properties: &LoroMap,
    deletable: bool,
    owner: &str,
) -> Result<bool, CoreError> {
    validate_single_string_property(properties, "builtin.created-at", true, owner)?;
    validate_single_string_property(properties, "builtin.updated-at", true, owner)?;
    let deleted =
        validate_single_string_property(properties, "builtin.deleted-at", false, owner)?.is_some();
    if deleted && !deletable {
        return Err(invalid(format!("{owner}: block lifecycle is invalid")));
    }
    Ok(deleted)
}

fn validate_single_string_property(
    properties: &LoroMap,
    raw_key: &str,
    required: bool,
    owner: &str,
) -> Result<Option<String>, CoreError> {
    let key = PropertyKey::new(raw_key).expect("static property key");
    let Some(field) = properties.get(raw_key).and_then(value_into_map) else {
        if required {
            return Err(invalid(format!("{owner}: property {raw_key} is missing")));
        }
        return Ok(None);
    };
    let shape = stored_property_shape(&field, &format!("{owner}: property {raw_key}"))?;
    if shape.value_type != PropertyType::String || shape.cardinality != Cardinality::Single {
        return Err(invalid(format!(
            "{owner}: property {raw_key} shape is invalid"
        )));
    }

    let encoded = field
        .get(PROPERTY_SINGLE_KEY)
        .and_then(value_into_string)
        .ok_or_else(|| invalid(format!("{owner}: property {raw_key} value is missing")))?;
    let value: PropertyValue = serde_json::from_str(&encoded)?;
    validate_property(&key, &value, Cardinality::Single)?;
    match value {
        PropertyValue::String(value) => Ok(Some(value)),
        _ => Err(invalid(format!(
            "{owner}: property {raw_key} value is invalid"
        ))),
    }
}

fn validate_property_bag(properties: &LoroMap, owner: &str) -> Result<(), CoreError> {
    for raw_key in properties.keys() {
        let key = PropertyKey::new(raw_key.to_string())
            .map_err(|_| invalid(format!("{owner}: property key is invalid: {raw_key}")))?;
        let field = required_map(
            properties.get(&raw_key),
            &format!("{owner}: property {raw_key}"),
        )?;
        let label = format!("{owner}: property {raw_key}");
        let shape = stored_property_shape(&field, &label)?;
        validate_property_shape(&key, shape.value_type, shape.cardinality)?;

        let payload_key = match (shape.value_type, shape.cardinality) {
            (PropertyType::Document, Cardinality::Single) => PROPERTY_DOCUMENT_KEY,
            (PropertyType::Document, Cardinality::Set) => {
                return Err(invalid(format!("{label} document cardinality is invalid")));
            }
            (_, Cardinality::Single) => PROPERTY_SINGLE_KEY,
            (_, Cardinality::Set) => PROPERTY_SET_KEY,
        };
        for slot in field.keys() {
            if slot.as_ref() != PROPERTY_SHAPE_KEY && slot.as_ref() != payload_key {
                return Err(invalid(format!("{label} contains an invalid slot: {slot}")));
            }
        }

        match (shape.value_type, shape.cardinality) {
            (PropertyType::Document, Cardinality::Single) => {
                let document = required_child_map(&field, PROPERTY_DOCUMENT_KEY, &label)?;
                validate_query_document(&document, &label)?;
            }
            (PropertyType::Document, Cardinality::Set) => unreachable!(),
            (_, Cardinality::Single) => {
                if let Some(value) = field.get(PROPERTY_SINGLE_KEY) {
                    validate_stored_property_value(value, &key, shape, &label)?;
                }
            }
            (_, Cardinality::Set) => {
                let values = required_child_map(&field, PROPERTY_SET_KEY, &label)?;
                for member in values.keys() {
                    let value = values.get(&member).ok_or_else(|| {
                        invalid(format!("{label} member disappeared during validation"))
                    })?;
                    let decoded = validate_stored_property_value(value, &key, shape, &label)?;
                    if member.as_ref() != property_member_slot(&decoded)? {
                        return Err(invalid(format!("{label} member identity is invalid")));
                    }
                }
            }
        }
    }
    Ok(())
}

fn stored_property_shape(field: &LoroMap, label: &str) -> Result<StoredPropertyShape, CoreError> {
    let encoded = field
        .get(PROPERTY_SHAPE_KEY)
        .and_then(value_into_string)
        .ok_or_else(|| invalid(format!("{label} shape is missing or invalid")))?;
    serde_json::from_str(&encoded).map_err(|_| invalid(format!("{label} shape is invalid")))
}

fn validate_stored_property_value(
    value: ValueOrContainer,
    key: &PropertyKey,
    shape: StoredPropertyShape,
    label: &str,
) -> Result<PropertyValue, CoreError> {
    let encoded = value_into_string(value)
        .ok_or_else(|| invalid(format!("{label} value is not an atomic string")))?;
    let value: PropertyValue =
        serde_json::from_str(&encoded).map_err(|_| invalid(format!("{label} value is invalid")))?;
    if value.property_type() != shape.value_type {
        return Err(invalid(format!(
            "{label} value type does not match its shape"
        )));
    }
    validate_property(key, &value, shape.cardinality)?;
    Ok(value)
}

fn property_member_slot(value: &PropertyValue) -> Result<String, CoreError> {
    use sha2::{Digest, Sha256};

    Ok(hex::encode(Sha256::digest(serde_json::to_vec(value)?)))
}

fn validate_graph_settings(doc: &LoroDoc) -> Result<(), CoreError> {
    let settings = doc.get_map("graph_settings");
    if map_i64(&settings, "schema_version") != Some(i64::from(GRAPH_SETTINGS_SCHEMA_VERSION)) {
        return Err(invalid(
            "graph settings schema is missing or unsupported".to_owned(),
        ));
    }
    let queries = required_child_map(&settings, "default_queries", "graph default queries")?;
    for raw_id in queries.keys() {
        let query_id = DefaultQueryId::new(raw_id.to_string())
            .map_err(|_| invalid(format!("default query id is invalid: {raw_id}")))?;
        let entry = required_map(queries.get(&raw_id), &format!("default query {query_id}"))?;
        let deleted = map_bool(&entry, "deleted")
            .ok_or_else(|| invalid(format!("default query {query_id} tombstone is invalid")))?;
        if deleted {
            continue;
        }
        let title = map_string(&entry, "title")
            .ok_or_else(|| invalid(format!("default query {query_id} title is invalid")))?;
        if title.chars().count() > MAX_DEFAULT_QUERY_TITLE {
            return Err(invalid(format!(
                "default query {query_id} title is too long"
            )));
        }
        map_u32(&entry, "position")
            .ok_or_else(|| invalid(format!("default query {query_id} position is invalid")))?;
        let document = required_child_map(
            &entry,
            "document",
            &format!("default query {query_id} document"),
        )?;
        validate_query_document(&document, &format!("default query {query_id} document"))?;
    }
    Ok(())
}

fn validate_query_document(document: &LoroMap, label: &str) -> Result<(), CoreError> {
    if map_string(document, "schema").as_deref() != Some(QUERY_DOCUMENT_SCHEMA)
        || map_u32(document, "version") != Some(QUERY_DOCUMENT_VERSION)
    {
        return Err(invalid(format!("{label} header is missing or unsupported")));
    }
    let default_view = map_string(document, "default_view_id")
        .ok_or_else(|| invalid(format!("{label} default view is invalid")))?;
    QueryViewId::new(default_view)
        .map_err(|_| invalid(format!("{label} default view is invalid")))?;
    let views = required_child_map(document, "views", &format!("{label} views"))?;
    for raw_id in views.keys() {
        QueryViewId::new(raw_id.to_string())
            .map_err(|_| invalid(format!("{label} view id is invalid: {raw_id}")))?;
        let view = required_map(views.get(&raw_id), &format!("{label} view {raw_id}"))?;
        let deleted = map_bool(&view, "deleted")
            .ok_or_else(|| invalid(format!("{label} view {raw_id} tombstone is invalid")))?;
        if deleted {
            continue;
        }
        map_string(&view, "name")
            .ok_or_else(|| invalid(format!("{label} view {raw_id} name is invalid")))?;
        match map_string(&view, "kind").as_deref() {
            Some("table" | "list") => {}
            _ => return Err(invalid(format!("{label} view {raw_id} kind is invalid"))),
        }
        map_u32(&view, "position")
            .ok_or_else(|| invalid(format!("{label} view {raw_id} position is invalid")))?;
        let columns = map_string(&view, "columns")
            .ok_or_else(|| invalid(format!("{label} view {raw_id} columns are invalid")))?;
        serde_json::from_str::<Vec<QueryViewColumn>>(&columns)
            .map_err(|_| invalid(format!("{label} view {raw_id} columns are invalid")))?;
        map_string(&view, "options")
            .ok_or_else(|| invalid(format!("{label} view {raw_id} options are invalid")))?;
        let definition = required_child_map(
            &view,
            "definition",
            &format!("{label} view {raw_id} definition"),
        )?;
        validate_query_definition(&definition, &format!("{label} view {raw_id}"))?;
    }
    Ok(())
}

fn validate_query_definition(definition: &LoroMap, label: &str) -> Result<(), CoreError> {
    if map_string(definition, "language").as_deref() != Some(QUERY_LANGUAGE) {
        return Err(invalid(format!("{label} query language is invalid")));
    }
    required_child_text(definition, "source", &format!("{label} query source"))?;
    decode_query_plan_state(definition, label).map(|_| ())
}

/// Decodes the one authoritative plan-state register, falling back to the
/// legacy two-slot envelope only when that register is absent.
///
/// This is deliberately a storage/domain decoder: it validates the opaque
/// [`QueryPlan`] envelope without asking the query compiler to understand its
/// version. Both causal validation and interactive projection use this exact
/// function so precedence and corruption handling cannot drift.
pub(crate) fn decode_query_plan_state(
    definition: &LoroMap,
    label: &str,
) -> Result<Option<QueryPlan>, CoreError> {
    // The discriminated register is authoritative. Legacy values beside it are
    // inert, including when the canonical state explicitly says Raw.
    if let Some(value) = definition.get(QUERY_PLAN_STATE_KEY) {
        let encoded = value_into_string(value)
            .ok_or_else(|| invalid(format!("{label} query plan state is invalid")))?;
        let state: StoredPlanState = serde_json::from_str(&encoded)
            .map_err(|_| invalid(format!("{label} query plan state is invalid")))?;
        return match state {
            StoredPlanState::Raw => Ok(None),
            StoredPlanState::Built { version, plan } => {
                if version != QUERY_PLAN_STATE_VERSION {
                    return Err(invalid(format!(
                        "{label} query plan storage version is unsupported"
                    )));
                }
                // This is deliberately the domain envelope check, not the
                // query compiler. Positive future plan versions remain opaque
                // causal data that the server can relay unchanged.
                plan.validate()?;
                Ok(Some(plan))
            }
        };
    }

    // Read compatibility for documents written before `plan_state`. Presence
    // is checked separately from type so malformed or partial pairs cannot be
    // mistaken for a Raw definition.
    let version = definition.get("plan_version");
    let payload = definition.get("plan");
    match (version, payload) {
        (None, None) => Ok(None),
        (
            Some(ValueOrContainer::Value(LoroValue::I64(version))),
            Some(ValueOrContainer::Value(LoroValue::String(payload))),
        ) => {
            let version = u32::try_from(version)
                .map_err(|_| invalid(format!("{label} query plan version is invalid")))?;
            let plan = QueryPlan {
                version,
                payload: (*payload).clone(),
            };
            plan.validate()?;
            Ok(Some(plan))
        }
        _ => Err(invalid(format!(
            "{label} query plan is incomplete or invalid"
        ))),
    }
}

fn validate_entity_name(
    value: &str,
    entity: &'static str,
    require_nonempty: bool,
    enforce_atomic_limit: bool,
) -> Result<(), CoreError> {
    if value.contains(PAGE_REFERENCE_CHAR) {
        return Err(invalid(format!(
            "{entity} name contains the reserved page-reference atom"
        )));
    }
    // A schema-8 page title was collaborative text, so concurrent valid edits
    // may exceed the command limit. A name register is atomic and cannot.
    if enforce_atomic_limit && value.len() > MAX_ENTITY_NAME_BYTES {
        return Err(CoreError::TextTooLong);
    }
    if require_nonempty && canonical_entity_name(value).is_empty() {
        return Err(CoreError::EmptyName { entity });
    }
    Ok(())
}

fn canonical_entity_name(value: &str) -> String {
    value
        .split_whitespace()
        .map(str::to_lowercase)
        .collect::<Vec<_>>()
        .join(" ")
}

fn invalid(message: String) -> CoreError {
    CoreError::InvalidHierarchy(message)
}

fn required_child_map(parent: &LoroMap, key: &str, label: &str) -> Result<LoroMap, CoreError> {
    required_map(parent.get(key), label)
}

fn required_map(value: Option<ValueOrContainer>, label: &str) -> Result<LoroMap, CoreError> {
    match value {
        Some(ValueOrContainer::Container(Container::Map(map))) => Ok(map),
        _ => Err(invalid(format!("{label} is missing or not a map"))),
    }
}

fn value_into_map(value: ValueOrContainer) -> Option<LoroMap> {
    match value {
        ValueOrContainer::Container(Container::Map(map)) => Some(map),
        _ => None,
    }
}

fn required_child_tree(parent: &LoroMap, key: &str, label: &str) -> Result<LoroTree, CoreError> {
    match parent.get(key) {
        Some(ValueOrContainer::Container(Container::Tree(tree))) => Ok(tree),
        _ => Err(invalid(format!("{label} is missing or not a tree"))),
    }
}

fn required_child_text(parent: &LoroMap, key: &str, label: &str) -> Result<LoroText, CoreError> {
    match parent.get(key) {
        Some(ValueOrContainer::Container(Container::Text(text))) => Ok(text),
        _ => Err(invalid(format!("{label} is missing or not text"))),
    }
}

fn value_into_string(value: ValueOrContainer) -> Option<String> {
    match value {
        ValueOrContainer::Value(LoroValue::String(value)) => Some((*value).clone()),
        _ => None,
    }
}

fn map_string(map: &LoroMap, key: &str) -> Option<String> {
    map.get(key).and_then(value_into_string)
}

fn map_i64(map: &LoroMap, key: &str) -> Option<i64> {
    match map.get(key) {
        Some(ValueOrContainer::Value(LoroValue::I64(value))) => Some(value),
        _ => None,
    }
}

fn map_u32(map: &LoroMap, key: &str) -> Option<u32> {
    map_i64(map, key).and_then(|value| u32::try_from(value).ok())
}

fn map_bool(map: &LoroMap, key: &str) -> Option<bool> {
    match map.get(key) {
        Some(ValueOrContainer::Value(LoroValue::Bool(value))) => Some(value),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn future_plan() -> QueryPlan {
        QueryPlan {
            version: domain::QUERY_PLAN_VERSION + 1,
            payload: r#"{"future":true}"#.to_owned(),
        }
    }

    #[test]
    fn canonical_plan_state_is_the_complete_authority() {
        let doc = LoroDoc::new();
        let definition = doc.get_map("definition");
        definition.insert("plan_version", 0_i64).unwrap();
        definition.insert("plan", "not json").unwrap();
        definition
            .insert(
                QUERY_PLAN_STATE_KEY,
                serde_json::to_string(&StoredPlanState::Raw).unwrap(),
            )
            .unwrap();

        assert_eq!(
            decode_query_plan_state(&definition, "definition").unwrap(),
            None
        );

        let plan = future_plan();
        definition
            .insert(
                QUERY_PLAN_STATE_KEY,
                serde_json::to_string(&StoredPlanState::Built {
                    version: QUERY_PLAN_STATE_VERSION,
                    plan: plan.clone(),
                })
                .unwrap(),
            )
            .unwrap();
        assert_eq!(
            decode_query_plan_state(&definition, "definition").unwrap(),
            Some(plan)
        );

        // A present but malformed authority never falls back to a valid legacy
        // pair beside it.
        definition.insert("plan_version", 1_i64).unwrap();
        definition.insert("plan", "{}").unwrap();
        definition.insert(QUERY_PLAN_STATE_KEY, "{").unwrap();
        assert!(matches!(
            decode_query_plan_state(&definition, "definition"),
            Err(CoreError::InvalidHierarchy(message))
                if message == "definition query plan state is invalid"
        ));
    }

    #[test]
    fn legacy_plan_state_requires_one_complete_valid_envelope() {
        let doc = LoroDoc::new();
        let definition = doc.get_map("definition");
        assert_eq!(
            decode_query_plan_state(&definition, "definition").unwrap(),
            None
        );

        definition.insert("plan_version", 2_i64).unwrap();
        assert!(matches!(
            decode_query_plan_state(&definition, "definition"),
            Err(CoreError::InvalidHierarchy(message))
                if message == "definition query plan is incomplete or invalid"
        ));

        let plan = future_plan();
        definition
            .insert("plan_version", i64::from(plan.version))
            .unwrap();
        definition.insert("plan", plan.payload.as_str()).unwrap();
        assert_eq!(
            decode_query_plan_state(&definition, "definition").unwrap(),
            Some(plan)
        );

        definition.insert("plan_version", "2").unwrap();
        assert!(matches!(
            decode_query_plan_state(&definition, "definition"),
            Err(CoreError::InvalidHierarchy(message))
                if message == "definition query plan is incomplete or invalid"
        ));
    }
}
