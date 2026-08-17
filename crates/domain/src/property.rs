use crate::{LocalDate, PageId, PropertyKey, QueryView, QueryViewId, QueryViewKind};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const REGISTRY_VERSION: u32 = 1;
pub const QUERY_PROPERTY_KEY: &str = "builtin.query";
pub const QUERY_DOCUMENT_SCHEMA: &str = "neoseq.query";
pub const QUERY_DOCUMENT_VERSION: u32 = 1;
pub const QUERY_LANGUAGE: &str = "sparql-1.1/neoseq-v1";

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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PropertyDocument {
    pub schema: String,
    pub version: u32,
    pub source: String,
    pub language: String,
    pub views: Vec<QueryView>,
    pub default_view_id: QueryViewId,
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
                    visible_variables: Vec::new(),
                },
                QueryView {
                    id: QueryViewId::new("list").expect("static query view id"),
                    name: "List".to_owned(),
                    kind: QueryViewKind::List,
                    position: 1,
                    visible_variables: Vec::new(),
                },
            ],
            default_view_id: QueryViewId::new("table").expect("static query view id"),
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
            if view.visible_variables.len() > 128
                || view.visible_variables.iter().any(|variable| {
                    variable.is_empty()
                        || variable.len() > 128
                        || variable.chars().any(char::is_control)
                })
            {
                return Err(PropertyError::InvalidDocument(
                    "invalid query view variable selection".to_owned(),
                ));
            }
        }
        if !ids.contains(&self.default_view_id) {
            return Err(PropertyError::InvalidDocument(
                "default query view does not exist".to_owned(),
            ));
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
    pub placements: &'static [PropertyPlacement],
}

impl PropertySpec {
    pub fn access(&self, target: PropertyTarget) -> Option<PropertyAccess> {
        self.placements
            .iter()
            .find(|placement| placement.target == target)
            .map(|placement| placement.access)
    }
}

const USER_PAGE_BLOCK: &[PropertyPlacement] = &[
    PropertyPlacement::user(PropertyTarget::Page),
    PropertyPlacement::user(PropertyTarget::Block),
];
const USER_PAGE_BLOCK_DEFAULT: &[PropertyPlacement] = &[
    PropertyPlacement::user(PropertyTarget::Page),
    PropertyPlacement::user(PropertyTarget::Block),
    PropertyPlacement::user(PropertyTarget::TagDefault),
];
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
            placements: USER_PAGE_BLOCK,
        },
    ),
    (
        "builtin.task-status",
        PropertySpec {
            shape: PropertyShape::Single(PropertyValueSpec::String(StringSpec::Suggested(
                TASK_STATUSES,
            ))),
            placements: USER_PAGE_BLOCK_DEFAULT,
        },
    ),
    (
        "builtin.task-scheduled",
        PropertySpec {
            shape: PropertyShape::Single(PropertyValueSpec::Date),
            placements: USER_PAGE_BLOCK_DEFAULT,
        },
    ),
    (
        "builtin.task-deadline",
        PropertySpec {
            shape: PropertyShape::Single(PropertyValueSpec::Date),
            placements: USER_PAGE_BLOCK_DEFAULT,
        },
    ),
    (
        "builtin.task-priority",
        PropertySpec {
            shape: PropertyShape::Single(PropertyValueSpec::String(StringSpec::Suggested(
                TASK_PRIORITIES,
            ))),
            placements: USER_PAGE_BLOCK_DEFAULT,
        },
    ),
    (
        "builtin.page-kind",
        PropertySpec {
            shape: PropertyShape::Single(PropertyValueSpec::String(StringSpec::OneOf(PAGE_KINDS))),
            placements: CORE_PAGE,
        },
    ),
    (
        "builtin.journal-date",
        PropertySpec {
            shape: PropertyShape::Single(PropertyValueSpec::Date),
            placements: CORE_PAGE,
        },
    ),
    (
        "builtin.created-at",
        PropertySpec {
            shape: PropertyShape::Single(PropertyValueSpec::String(StringSpec::Any)),
            placements: CORE_PAGE_BLOCK_TAG,
        },
    ),
    (
        "builtin.updated-at",
        PropertySpec {
            shape: PropertyShape::Single(PropertyValueSpec::String(StringSpec::Any)),
            placements: CORE_PAGE_BLOCK_TAG,
        },
    ),
    (
        "builtin.deleted-at",
        PropertySpec {
            shape: PropertyShape::Single(PropertyValueSpec::String(StringSpec::Any)),
            placements: CORE_PAGE_TAG,
        },
    ),
];

pub fn definition(key: &PropertyKey) -> Option<&'static PropertySpec> {
    REGISTRY
        .iter()
        .find(|(name, _)| *name == key.as_str())
        .map(|(_, spec)| spec)
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
                serde_json::json!({"shape": spec.shape, "placements": placements}),
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
    fn registry_matches_the_checked_in_contract() {
        let expected: serde_json::Value =
            serde_json::from_str(include_str!("../../../contracts/property-registry.json"))
                .unwrap();
        assert_eq!(registry_fixture(), expected);
    }
}
