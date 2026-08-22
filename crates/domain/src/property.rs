use crate::{
    LocalDate, PageId, PropertyKey, QueryView, QueryViewId, QueryViewKind, QueryViewOptions,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const REGISTRY_VERSION: u32 = 6;
pub const QUERY_PROPERTY_KEY: &str = "builtin.query";
pub const QUERY_DOCUMENT_SCHEMA: &str = "neoseq.query";
pub const QUERY_DOCUMENT_VERSION: u32 = 1;
pub const QUERY_LANGUAGE: &str = "sparql-1.1/neoseq-v1";
pub const QUERY_PLAN_LIMIT: usize = 32_768;
/// How many columns one saved view may order by. A reader who needs a ninth
/// tie-breaker needs a different query, not a longer list.
pub const QUERY_VIEW_SORT_LIMIT: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PropertyType {
    Number,
    String,
    Page,
    Checkbox,
    Date,
    Document,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Cardinality {
    Single,
    Set,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PropertyTarget {
    Page,
    Block,
    TagMetadata,
    TagDefault,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PropertyAccess {
    User,
    Core,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PropertyCopyPolicy {
    Portable,
    Regenerate,
    Omit,
}

/// A property's semantic order. Display labels and picker placement are client
/// concerns; this contract says when the declared choices themselves are an
/// ordered domain.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PropertyOrdering {
    ChoiceOrder,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct PropertyPlacement {
    pub target: PropertyTarget,
    pub access: PropertyAccess,
}

impl PropertyPlacement {
    const fn user(target: PropertyTarget) -> Self {
        Self {
            target,
            access: PropertyAccess::User,
        }
    }

    const fn core(target: PropertyTarget) -> Self {
        Self {
            target,
            access: PropertyAccess::Core,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StringSpec {
    Any,
    Suggested(&'static [&'static str]),
    OneOf(&'static [&'static str]),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PropertyValueSpec {
    Number,
    String(StringSpec),
    Page,
    Checkbox,
    Date,
    Document(DocumentSpec),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct DocumentSpec {
    pub schema: &'static str,
    pub version: u32,
}

impl PropertyValueSpec {
    pub const fn property_type(self) -> PropertyType {
        match self {
            Self::Number => PropertyType::Number,
            Self::String(_) => PropertyType::String,
            Self::Page => PropertyType::Page,
            Self::Checkbox => PropertyType::Checkbox,
            Self::Date => PropertyType::Date,
            Self::Document(_) => PropertyType::Document,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PropertyShape {
    Single(PropertyValueSpec),
    Set(PropertyValueSpec),
}

impl PropertyShape {
    pub const fn cardinality(self) -> Cardinality {
        match self {
            Self::Single(_) => Cardinality::Single,
            Self::Set(_) => Cardinality::Set,
        }
    }

    pub const fn value(self) -> PropertyValueSpec {
        match self {
            Self::Single(value) | Self::Set(value) => value,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum PropertyValue {
    Number(f64),
    String(String),
    Page(PageId),
    Checkbox(bool),
    Date(LocalDate),
    Document(PropertyDocument),
    UnsupportedDocument(PropertyDocumentHeader),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PropertyDocumentHeader {
    pub schema: String,
    pub version: u32,
}

/// The builder's structured description of a query.
///
/// `source` stays the executable artifact: the core parses, plans, and runs
/// SPARQL and nothing else. A plan is the *authoring* representation the query
/// builder writes that source from, kept beside it so reopening a query reopens
/// the builder rather than a wall of SPARQL. Its `payload` grammar therefore
/// belongs to the authoring layer, and the domain owns only what makes the
/// document well-formed: a JSON object, within bounds, carrying its own version
/// so a client that does not understand it can fall back to editing the source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueryPlan {
    pub version: u32,
    pub payload: String,
}

impl QueryPlan {
    pub fn validate(&self) -> Result<(), PropertyError> {
        if self.version == 0 {
            return Err(PropertyError::InvalidDocument(
                "query plan version must be positive".to_owned(),
            ));
        }
        if self.payload.len() > QUERY_PLAN_LIMIT {
            return Err(PropertyError::StringTooLong);
        }
        let parsed = serde_json::from_str::<serde_json::Value>(&self.payload)
            .map_err(|_| PropertyError::InvalidDocument("query plan is not JSON".to_owned()))?;
        if !parsed.is_object() {
            return Err(PropertyError::InvalidDocument(
                "query plan must be a JSON object".to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PropertyDocument {
    pub schema: String,
    pub version: u32,
    pub source: String,
    pub language: String,
    pub views: Vec<QueryView>,
    pub default_view_id: QueryViewId,
    #[serde(default)]
    pub plan: Option<QueryPlan>,
}

impl PropertyDocument {
    pub fn default_query(source: String) -> Self {
        Self {
            schema: QUERY_DOCUMENT_SCHEMA.to_owned(),
            version: QUERY_DOCUMENT_VERSION,
            source,
            language: QUERY_LANGUAGE.to_owned(),
            views: vec![
                QueryView {
                    id: QueryViewId::new("table").expect("static query view id"),
                    name: "Table".to_owned(),
                    kind: QueryViewKind::Table,
                    position: 0,
                    columns: Vec::new(),
                    options: QueryViewOptions::default(),
                },
                QueryView {
                    id: QueryViewId::new("list").expect("static query view id"),
                    name: "List".to_owned(),
                    kind: QueryViewKind::List,
                    position: 1,
                    columns: Vec::new(),
                    options: QueryViewOptions::default(),
                },
            ],
            default_view_id: QueryViewId::new("table").expect("static query view id"),
            plan: None,
        }
    }

    pub fn validate(&self) -> Result<(), PropertyError> {
        if self.schema != QUERY_DOCUMENT_SCHEMA || self.version != QUERY_DOCUMENT_VERSION {
            return Err(PropertyError::UnsupportedDocument {
                schema: self.schema.clone(),
                version: self.version,
            });
        }
        if self.language != QUERY_LANGUAGE {
            return Err(PropertyError::InvalidDocument(
                "unsupported query language".to_owned(),
            ));
        }
        if self.source.len() > 65_536 {
            return Err(PropertyError::StringTooLong);
        }
        if self.views.is_empty() || self.views.len() > 32 {
            return Err(PropertyError::InvalidDocument(
                "query document must contain between 1 and 32 views".to_owned(),
            ));
        }
        let mut ids = std::collections::BTreeSet::new();
        for view in &self.views {
            if !ids.insert(view.id.clone()) {
                return Err(PropertyError::InvalidDocument(
                    "duplicate query view id".to_owned(),
                ));
            }
            if view.name.is_empty() || view.name.len() > 128 {
                return Err(PropertyError::InvalidDocument(
                    "invalid query view name".to_owned(),
                ));
            }
            if view.columns.len() > 128
                || view.columns.iter().any(|column| {
                    column.variable.is_empty()
                        || column.variable.len() > 128
                        || column.variable.chars().any(char::is_control)
                })
            {
                return Err(PropertyError::InvalidDocument(
                    "invalid query view column selection".to_owned(),
                ));
            }
            let mut variables = std::collections::BTreeSet::new();
            if view
                .columns
                .iter()
                .any(|column| !variables.insert(column.variable.as_str()))
            {
                return Err(PropertyError::InvalidDocument(
                    "duplicate query view column".to_owned(),
                ));
            }
            // A sort names a result variable, and each term is bounded exactly
            // as a column selection is. A term is not required to name a
            // variable the view lists: a query that has since dropped a column
            // keeps the order it had, and simply stops applying it. One variable
            // may appear once — ordering by the same column twice says nothing
            // the first term did not already say.
            if view.options.sort.len() > QUERY_VIEW_SORT_LIMIT {
                return Err(PropertyError::InvalidDocument(
                    "too many query view sort terms".to_owned(),
                ));
            }
            let mut sorted = std::collections::BTreeSet::new();
            for sort in &view.options.sort {
                if sort.variable.is_empty()
                    || sort.variable.len() > 128
                    || sort.variable.chars().any(char::is_control)
                {
                    return Err(PropertyError::InvalidDocument(
                        "invalid query view sort variable".to_owned(),
                    ));
                }
                if !sorted.insert(sort.variable.as_str()) {
                    return Err(PropertyError::InvalidDocument(
                        "duplicate query view sort variable".to_owned(),
                    ));
                }
            }
        }
        if !ids.contains(&self.default_view_id) {
            return Err(PropertyError::InvalidDocument(
                "default query view does not exist".to_owned(),
            ));
        }
        if let Some(plan) = &self.plan {
            plan.validate()?;
        }
        Ok(())
    }
}

impl PropertyValue {
    pub fn property_type(&self) -> PropertyType {
        match self {
            Self::Number(_) => PropertyType::Number,
            Self::String(_) => PropertyType::String,
            Self::Page(_) => PropertyType::Page,
            Self::Checkbox(_) => PropertyType::Checkbox,
            Self::Date(_) => PropertyType::Date,
            Self::Document(_) => PropertyType::Document,
            Self::UnsupportedDocument(_) => PropertyType::Document,
        }
    }

    pub fn validate_shape(&self) -> Result<(), PropertyError> {
        match self {
            Self::Number(value) if !value.is_finite() => Err(PropertyError::NonFiniteNumber),
            Self::String(value) if value.len() > 65_536 => Err(PropertyError::StringTooLong),
            Self::Document(value) => value.validate(),
            Self::UnsupportedDocument(value) => Err(PropertyError::UnsupportedDocument {
                schema: value.schema.clone(),
                version: value.version,
            }),
            _ => Ok(()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PropertyField {
    pub key: PropertyKey,
    pub value_type: PropertyType,
    pub cardinality: Cardinality,
    pub values: Vec<PropertyValue>,
}

pub type PropertyBag = Vec<PropertyField>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PropertySpec {
    pub shape: PropertyShape,
    pub ordering: Option<PropertyOrdering>,
    pub placements: &'static [PropertyPlacement],
    pub copy: PropertyCopyPolicy,
}

impl PropertySpec {
    pub fn access(&self, target: PropertyTarget) -> Option<PropertyAccess> {
        self.placements
            .iter()
            .find(|placement| placement.target == target)
            .map(|placement| placement.access)
    }
}

/// A query is authored on the three things that can *ask* one: a page, a block,
/// and a tag — whose query is the tag's own view of the graph it names.
const USER_PAGE_BLOCK_TAG: &[PropertyPlacement] = &[
    PropertyPlacement::user(PropertyTarget::Page),
    PropertyPlacement::user(PropertyTarget::Block),
    PropertyPlacement::user(PropertyTarget::TagMetadata),
];
const USER_PAGE_BLOCK_DEFAULT: &[PropertyPlacement] = &[
    PropertyPlacement::user(PropertyTarget::Page),
    PropertyPlacement::user(PropertyTarget::Block),
    PropertyPlacement::user(PropertyTarget::TagDefault),
];
/// What a tag *is* rather than what it copies: how it is filed, and how it looks
/// wherever it appears. None of these is ever materialized onto a block.
const USER_TAG: &[PropertyPlacement] = &[PropertyPlacement::user(PropertyTarget::TagMetadata)];
const CORE_PAGE: &[PropertyPlacement] = &[PropertyPlacement::core(PropertyTarget::Page)];
const CORE_PAGE_TAG: &[PropertyPlacement] = &[
    PropertyPlacement::core(PropertyTarget::Page),
    PropertyPlacement::core(PropertyTarget::TagMetadata),
];
const CORE_PAGE_BLOCK_TAG: &[PropertyPlacement] = &[
    PropertyPlacement::core(PropertyTarget::Page),
    PropertyPlacement::core(PropertyTarget::Block),
    PropertyPlacement::core(PropertyTarget::TagMetadata),
];
const PAGE_KINDS: &[&str] = &["regular", "journal"];
/// The eight named hue steps the accent itself offers. A tag names one of them,
/// never a colour: lightness and chroma stay the mode's, so every tag a reader
/// can paint lands on the measured row of the contrast table in both modes.
const TAG_COLORS: &[&str] = &[
    "red", "orange", "green", "teal", "blue", "iris", "violet", "rose",
];
const TASK_STATUSES: &[&str] = &["todo", "doing", "done", "cancelled"];
const TASK_PRIORITIES: &[&str] = &["low", "medium", "high"];

pub const REGISTRY: &[(&str, PropertySpec)] = &[
    (
        QUERY_PROPERTY_KEY,
        PropertySpec {
            shape: PropertyShape::Single(PropertyValueSpec::Document(DocumentSpec {
                schema: QUERY_DOCUMENT_SCHEMA,
                version: QUERY_DOCUMENT_VERSION,
            })),
            ordering: None,
            placements: USER_PAGE_BLOCK_TAG,
            copy: PropertyCopyPolicy::Portable,
        },
    ),
    (
        "builtin.tag-group",
        PropertySpec {
            shape: PropertyShape::Single(PropertyValueSpec::String(StringSpec::Any)),
            ordering: None,
            placements: USER_TAG,
            copy: PropertyCopyPolicy::Portable,
        },
    ),
    (
        "builtin.tag-order",
        PropertySpec {
            shape: PropertyShape::Single(PropertyValueSpec::Number),
            ordering: None,
            placements: USER_TAG,
            copy: PropertyCopyPolicy::Portable,
        },
    ),
    (
        "builtin.tag-color",
        PropertySpec {
            shape: PropertyShape::Single(PropertyValueSpec::String(StringSpec::Suggested(
                TAG_COLORS,
            ))),
            ordering: None,
            placements: USER_TAG,
            copy: PropertyCopyPolicy::Portable,
        },
    ),
    (
        "builtin.tag-icon",
        PropertySpec {
            shape: PropertyShape::Single(PropertyValueSpec::String(StringSpec::Any)),
            ordering: None,
            placements: USER_TAG,
            copy: PropertyCopyPolicy::Portable,
        },
    ),
    (
        "builtin.task-status",
        PropertySpec {
            shape: PropertyShape::Single(PropertyValueSpec::String(StringSpec::Suggested(
                TASK_STATUSES,
            ))),
            ordering: Some(PropertyOrdering::ChoiceOrder),
            placements: USER_PAGE_BLOCK_DEFAULT,
            copy: PropertyCopyPolicy::Portable,
        },
    ),
    (
        "builtin.task-scheduled",
        PropertySpec {
            shape: PropertyShape::Single(PropertyValueSpec::Date),
            ordering: None,
            placements: USER_PAGE_BLOCK_DEFAULT,
            copy: PropertyCopyPolicy::Portable,
        },
    ),
    (
        "builtin.task-scheduled-time",
        PropertySpec {
            shape: PropertyShape::Single(PropertyValueSpec::String(StringSpec::Any)),
            ordering: None,
            placements: USER_PAGE_BLOCK_DEFAULT,
            copy: PropertyCopyPolicy::Portable,
        },
    ),
    (
        "builtin.task-deadline",
        PropertySpec {
            shape: PropertyShape::Single(PropertyValueSpec::Date),
            ordering: None,
            placements: USER_PAGE_BLOCK_DEFAULT,
            copy: PropertyCopyPolicy::Portable,
        },
    ),
    (
        "builtin.task-deadline-time",
        PropertySpec {
            shape: PropertyShape::Single(PropertyValueSpec::String(StringSpec::Any)),
            ordering: None,
            placements: USER_PAGE_BLOCK_DEFAULT,
            copy: PropertyCopyPolicy::Portable,
        },
    ),
    (
        "builtin.task-repeat",
        PropertySpec {
            shape: PropertyShape::Single(PropertyValueSpec::String(StringSpec::Any)),
            ordering: None,
            placements: USER_PAGE_BLOCK_DEFAULT,
            copy: PropertyCopyPolicy::Portable,
        },
    ),
    (
        "builtin.task-priority",
        PropertySpec {
            shape: PropertyShape::Single(PropertyValueSpec::String(StringSpec::Suggested(
                TASK_PRIORITIES,
            ))),
            ordering: Some(PropertyOrdering::ChoiceOrder),
            placements: USER_PAGE_BLOCK_DEFAULT,
            copy: PropertyCopyPolicy::Portable,
        },
    ),
    (
        "builtin.page-kind",
        PropertySpec {
            shape: PropertyShape::Single(PropertyValueSpec::String(StringSpec::OneOf(PAGE_KINDS))),
            ordering: None,
            placements: CORE_PAGE,
            copy: PropertyCopyPolicy::Omit,
        },
    ),
    (
        "builtin.journal-date",
        PropertySpec {
            shape: PropertyShape::Single(PropertyValueSpec::Date),
            ordering: None,
            placements: CORE_PAGE,
            copy: PropertyCopyPolicy::Omit,
        },
    ),
    (
        "builtin.created-at",
        PropertySpec {
            shape: PropertyShape::Single(PropertyValueSpec::String(StringSpec::Any)),
            ordering: None,
            placements: CORE_PAGE_BLOCK_TAG,
            copy: PropertyCopyPolicy::Regenerate,
        },
    ),
    (
        "builtin.updated-at",
        PropertySpec {
            shape: PropertyShape::Single(PropertyValueSpec::String(StringSpec::Any)),
            ordering: None,
            placements: CORE_PAGE_BLOCK_TAG,
            copy: PropertyCopyPolicy::Regenerate,
        },
    ),
    (
        "builtin.deleted-at",
        PropertySpec {
            shape: PropertyShape::Single(PropertyValueSpec::String(StringSpec::Any)),
            ordering: None,
            placements: CORE_PAGE_TAG,
            copy: PropertyCopyPolicy::Omit,
        },
    ),
];

pub fn definition(key: &PropertyKey) -> Option<&'static PropertySpec> {
    REGISTRY
        .iter()
        .find(|(name, _)| *name == key.as_str())
        .map(|(_, spec)| spec)
}

pub fn property_copy_policy(key: &PropertyKey) -> PropertyCopyPolicy {
    definition(key).map_or_else(
        || {
            if key.as_str().starts_with("user.") {
                PropertyCopyPolicy::Portable
            } else {
                PropertyCopyPolicy::Omit
            }
        },
        |spec| spec.copy,
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum PropertyError {
    #[error("property {key} expects {expected:?}, got {actual:?}")]
    WrongType {
        key: String,
        expected: PropertyType,
        actual: PropertyType,
    },
    #[error("property {key} is {expected:?}, not {actual:?}")]
    WrongCardinality {
        key: String,
        expected: Cardinality,
        actual: Cardinality,
    },
    #[error("property {key} does not allow string value {value:?}")]
    InvalidString { key: String, value: String },
    #[error("property number must be finite")]
    NonFiniteNumber,
    #[error("property string exceeds 65536 bytes")]
    StringTooLong,
    #[error("property {key} is not valid on {target:?}")]
    InvalidTarget { key: String, target: PropertyTarget },
    #[error("property {0} is managed by the core")]
    CoreManaged(String),
    #[error("single-valued property {0} contains more than one value")]
    TooManySingleValues(String),
    #[error("unsupported property document {schema} v{version}")]
    UnsupportedDocument { schema: String, version: u32 },
    #[error("invalid property document: {0}")]
    InvalidDocument(String),
    #[error("property document {0} requires a document-specific command")]
    DocumentCommandRequired(String),
}

pub fn validate_property(
    key: &PropertyKey,
    value: &PropertyValue,
    cardinality: Cardinality,
) -> Result<(), PropertyError> {
    value.validate_shape()?;
    let Some(item) = definition(key) else {
        return Ok(());
    };
    let value_spec = item.shape.value();
    if value.property_type() != value_spec.property_type() {
        return Err(PropertyError::WrongType {
            key: key.to_string(),
            expected: value_spec.property_type(),
            actual: value.property_type(),
        });
    }
    if cardinality != item.shape.cardinality() {
        return Err(PropertyError::WrongCardinality {
            key: key.to_string(),
            expected: item.shape.cardinality(),
            actual: cardinality,
        });
    }
    if let PropertyValueSpec::String(StringSpec::OneOf(allowed)) = value_spec {
        let PropertyValue::String(value) = value else {
            unreachable!("registry type was checked")
        };
        if !allowed.contains(&value.as_str()) {
            return Err(PropertyError::InvalidString {
                key: key.to_string(),
                value: value.clone(),
            });
        }
    }
    if let PropertyValueSpec::Document(spec) = value_spec {
        let document = match value {
            PropertyValue::Document(document) => document,
            PropertyValue::UnsupportedDocument(document) => {
                return Err(PropertyError::UnsupportedDocument {
                    schema: document.schema.clone(),
                    version: document.version,
                });
            }
            _ => unreachable!("registry type was checked"),
        };
        if document.schema != spec.schema || document.version != spec.version {
            return Err(PropertyError::UnsupportedDocument {
                schema: document.schema.clone(),
                version: document.version,
            });
        }
        document.validate()?;
    }
    Ok(())
}

pub fn validate_property_shape(
    key: &PropertyKey,
    value_type: PropertyType,
    cardinality: Cardinality,
) -> Result<(), PropertyError> {
    let Some(item) = definition(key) else {
        return Ok(());
    };
    let expected_type = item.shape.value().property_type();
    if value_type != expected_type {
        return Err(PropertyError::WrongType {
            key: key.to_string(),
            expected: expected_type,
            actual: value_type,
        });
    }
    let expected_cardinality = item.shape.cardinality();
    if cardinality != expected_cardinality {
        return Err(PropertyError::WrongCardinality {
            key: key.to_string(),
            expected: expected_cardinality,
            actual: cardinality,
        });
    }
    Ok(())
}

pub fn validate_property_field(field: &PropertyField) -> Result<(), PropertyError> {
    validate_property_shape(&field.key, field.value_type, field.cardinality)?;
    if field.cardinality == Cardinality::Single && field.values.len() > 1 {
        return Err(PropertyError::TooManySingleValues(field.key.to_string()));
    }
    for value in &field.values {
        if value.property_type() != field.value_type {
            return Err(PropertyError::WrongType {
                key: field.key.to_string(),
                expected: field.value_type,
                actual: value.property_type(),
            });
        }
        validate_property(&field.key, value, field.cardinality)?;
    }
    Ok(())
}

pub fn validate_property_target(
    key: &PropertyKey,
    target: PropertyTarget,
) -> Result<(), PropertyError> {
    let valid = definition(key).map_or_else(
        || key.as_str().starts_with("builtin.") || target != PropertyTarget::TagMetadata,
        |item| item.access(target).is_some(),
    );
    if valid {
        Ok(())
    } else {
        Err(PropertyError::InvalidTarget {
            key: key.to_string(),
            target,
        })
    }
}

pub fn validate_property_write(
    key: &PropertyKey,
    target: PropertyTarget,
) -> Result<(), PropertyError> {
    validate_property_target(key, target)?;
    if let Some(item) = definition(key) {
        if item.access(target) == Some(PropertyAccess::Core) {
            return Err(PropertyError::CoreManaged(key.to_string()));
        }
    } else if key.as_str().starts_with("builtin.") {
        return Err(PropertyError::CoreManaged(key.to_string()));
    }
    Ok(())
}

pub fn registry_fixture() -> serde_json::Value {
    let properties: serde_json::Map<_, _> = REGISTRY
        .iter()
        .map(|(key, spec)| {
            let placements: serde_json::Map<_, _> = spec
                .placements
                .iter()
                .map(|placement| {
                    let target = match placement.target {
                        PropertyTarget::Page => "page",
                        PropertyTarget::Block => "block",
                        PropertyTarget::TagMetadata => "tag_metadata",
                        PropertyTarget::TagDefault => "tag_default",
                    };
                    (target.to_owned(), serde_json::json!(placement.access))
                })
                .collect();
            (
                (*key).to_owned(),
                match spec.ordering {
                    Some(ordering) => serde_json::json!({
                        "shape": spec.shape,
                        "ordering": ordering,
                        "placements": placements,
                        "copy": spec.copy,
                    }),
                    None => serde_json::json!({
                        "shape": spec.shape,
                        "placements": placements,
                        "copy": spec.copy,
                    }),
                },
            )
        })
        .collect();
    serde_json::json!({"schema": REGISTRY_VERSION, "properties": properties})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(value: &str) -> PropertyKey {
        PropertyKey::new(value).unwrap()
    }

    #[test]
    fn validates_well_known_contracts_and_preserves_unknown_types() {
        assert!(
            validate_property(
                &key("builtin.task-status"),
                &PropertyValue::String("done".into()),
                Cardinality::Single
            )
            .is_ok()
        );
        assert!(
            validate_property(
                &key("builtin.task-status"),
                &PropertyValue::String("later".into()),
                Cardinality::Single
            )
            .is_ok()
        );
        assert!(
            validate_property(
                &key("user.number"),
                &PropertyValue::Number(3.5),
                Cardinality::Set
            )
            .is_ok()
        );
    }

    #[test]
    fn registry_placements_own_target_and_access_policy() {
        assert!(validate_property_write(&key("builtin.task-status"), PropertyTarget::Page).is_ok());
        assert!(
            validate_property_write(&key("builtin.task-status"), PropertyTarget::Block).is_ok()
        );
        assert!(
            validate_property_write(&key("builtin.task-status"), PropertyTarget::TagDefault)
                .is_ok()
        );
        assert!(
            validate_property_target(&key(QUERY_PROPERTY_KEY), PropertyTarget::TagDefault).is_err()
        );
        assert!(
            validate_property_target(&key("builtin.created-at"), PropertyTarget::TagMetadata)
                .is_ok()
        );
        assert!(
            validate_property_target(&key("builtin.created-at"), PropertyTarget::Block).is_ok()
        );
        assert!(
            validate_property_target(&key("builtin.updated-at"), PropertyTarget::TagMetadata)
                .is_ok()
        );
        assert!(
            validate_property_target(&key("builtin.deleted-at"), PropertyTarget::Block).is_err()
        );
        assert!(validate_property_write(&key("builtin.page-kind"), PropertyTarget::Page).is_err());
        assert!(validate_property_write(&key("builtin.deleted-at"), PropertyTarget::Page).is_err());
        assert!(validate_property_write(&key("user.value"), PropertyTarget::Block).is_ok());
        assert!(validate_property_target(&key("user.value"), PropertyTarget::TagMetadata).is_err());
        assert!(validate_property_target(&key("builtin.future"), PropertyTarget::Page).is_ok());
        assert!(validate_property_target(&key("builtin.future"), PropertyTarget::Block).is_ok());
        assert!(
            validate_property_target(&key("builtin.future"), PropertyTarget::TagMetadata).is_ok()
        );
        assert!(validate_property_write(&key("builtin.future"), PropertyTarget::Page).is_err());
    }

    #[test]
    fn string_policy_distinguishes_suggestions_from_restrictions() {
        assert!(
            validate_property(
                &key("builtin.task-status"),
                &PropertyValue::String("waiting".into()),
                Cardinality::Single,
            )
            .is_ok()
        );
        assert!(
            validate_property(
                &key("builtin.page-kind"),
                &PropertyValue::String("future-page-kind".into()),
                Cardinality::Single,
            )
            .is_err()
        );
    }

    #[test]
    fn query_document_has_stable_views_and_validates_its_default() {
        let mut document = PropertyDocument::default_query("SELECT * WHERE {}".to_owned());
        assert!(document.validate().is_ok());
        document.default_view_id = QueryViewId::new("missing").unwrap();
        assert!(document.validate().is_err());
    }

    #[test]
    fn query_view_columns_are_unique_and_bounded() {
        let mut document = PropertyDocument::default_query("SELECT * WHERE {}".to_owned());
        document.views[0].columns = vec![
            crate::QueryViewColumn {
                variable: "task".to_owned(),
                hidden: false,
                width: Some(220),
            },
            crate::QueryViewColumn {
                variable: "status".to_owned(),
                hidden: true,
                width: None,
            },
        ];
        assert!(document.validate().is_ok());
        document.views[0].columns[1].variable = "task".to_owned();
        assert!(document.validate().is_err());
    }

    #[test]
    fn query_view_sort_is_a_bounded_list_of_distinct_variables() {
        let mut document = PropertyDocument::default_query("SELECT * WHERE {}".to_owned());
        document.views[0].options.sort = vec![
            crate::QueryViewSort {
                variable: "status".to_owned(),
                descending: true,
            },
            crate::QueryViewSort {
                variable: "task".to_owned(),
                descending: false,
            },
        ];
        assert!(document.validate().is_ok());
        // Ordering by one column twice says nothing the first term did not.
        document.views[0].options.sort[1].variable = "status".to_owned();
        assert!(document.validate().is_err());
        document.views[0].options.sort = (0..=QUERY_VIEW_SORT_LIMIT)
            .map(|index| crate::QueryViewSort {
                variable: format!("v{index}"),
                descending: false,
            })
            .collect();
        assert!(document.validate().is_err());
    }

    /// A reader who had ordered a table before the order became a list keeps
    /// that order: the single object earlier builds wrote still deserializes.
    #[test]
    fn query_view_sort_reads_the_single_form_earlier_builds_wrote() {
        let legacy = serde_json::json!({
            "compact": true,
            "wrap": false,
            "sort": { "variable": "status", "descending": true },
        });
        let options: crate::QueryViewOptions = serde_json::from_value(legacy).unwrap();
        assert_eq!(options.sort.len(), 1);
        assert_eq!(options.sort[0].variable, "status");
        assert!(options.sort[0].descending);

        let list = serde_json::json!({
            "sort": [{ "variable": "a" }, { "variable": "b", "descending": true }],
        });
        let options: crate::QueryViewOptions = serde_json::from_value(list).unwrap();
        assert_eq!(options.sort.len(), 2);
        assert!(options.sort[1].descending);

        let absent: crate::QueryViewOptions = serde_json::from_value(json_object()).unwrap();
        assert!(absent.sort.is_empty());
    }

    fn json_object() -> serde_json::Value {
        serde_json::json!({})
    }

    #[test]
    fn query_plan_accepts_a_bounded_json_object_only() {
        let mut document = PropertyDocument::default_query("SELECT * WHERE {}".to_owned());
        document.plan = Some(QueryPlan {
            version: 1,
            payload: "{\"subject\":\"block\"}".to_owned(),
        });
        assert!(document.validate().is_ok());
        document.plan = Some(QueryPlan {
            version: 1,
            payload: "[1,2]".to_owned(),
        });
        assert!(document.validate().is_err());
        document.plan = Some(QueryPlan {
            version: 0,
            payload: "{}".to_owned(),
        });
        assert!(document.validate().is_err());
        document.plan = Some(QueryPlan {
            version: 1,
            payload: format!("{{\"a\":\"{}\"}}", "x".repeat(QUERY_PLAN_LIMIT)),
        });
        assert!(document.validate().is_err());
    }

    #[test]
    fn registry_matches_the_checked_in_contract() {
        let expected: serde_json::Value =
            serde_json::from_str(include_str!("../../../contracts/property-registry.json"))
                .unwrap();
        assert_eq!(registry_fixture(), expected);
    }
}
