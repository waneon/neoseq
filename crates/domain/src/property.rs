use crate::{LocalDate, PageId, PropertyKey};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const REGISTRY_VERSION: u32 = 4;
pub const DEFAULT_QUERY_LANGUAGE: &str = "sparql-1.1/neoseq-v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PropertyType {
    Number,
    String,
    Page,
    Checkbox,
    Date,
    Query,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Cardinality {
    Single,
    Repeated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WritePolicy {
    User,
    Core,
    Derived,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Visibility {
    Picker,
    Info,
    Hidden,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PropertyTarget {
    Page,
    Block,
    Tag,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuerySpec {
    pub language: String,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum PropertyValue {
    Number(f64),
    String(String),
    Page(PageId),
    Checkbox(bool),
    Date(LocalDate),
    Query(QuerySpec),
}

impl PropertyValue {
    pub fn property_type(&self) -> PropertyType {
        match self {
            Self::Number(_) => PropertyType::Number,
            Self::String(_) => PropertyType::String,
            Self::Page(_) => PropertyType::Page,
            Self::Checkbox(_) => PropertyType::Checkbox,
            Self::Date(_) => PropertyType::Date,
            Self::Query(_) => PropertyType::Query,
        }
    }

    pub fn validate_shape(&self) -> Result<(), PropertyError> {
        match self {
            Self::Number(value) if !value.is_finite() => Err(PropertyError::NonFiniteNumber),
            Self::String(value) if value.len() > 65_536 => Err(PropertyError::StringTooLong),
            Self::Query(value) if value.language.is_empty() => {
                Err(PropertyError::EmptyQueryLanguage)
            }
            Self::Query(value) if value.language.len() > 128 => {
                Err(PropertyError::QueryLanguageTooLong)
            }
            Self::Query(value) if value.source.len() > 65_536 => Err(PropertyError::StringTooLong),
            _ => Ok(()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PropertyEntry {
    pub key: PropertyKey,
    pub value: PropertyValue,
}

pub type PropertyBag = Vec<PropertyEntry>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PropertyDefinition {
    pub key: &'static str,
    pub value_type: PropertyType,
    pub cardinality: Cardinality,
    pub defaultable: bool,
    pub allowed_strings: &'static [&'static str],
    pub write_policy: WritePolicy,
    pub visibility: Visibility,
    pub targets: &'static [PropertyTarget],
}

const NONE: &[&str] = &[];
const PAGE: &[PropertyTarget] = &[PropertyTarget::Page];
const BLOCK: &[PropertyTarget] = &[PropertyTarget::Block];
const PAGE_BLOCK: &[PropertyTarget] = &[PropertyTarget::Page, PropertyTarget::Block];
const PAGE_TAG: &[PropertyTarget] = &[PropertyTarget::Page, PropertyTarget::Tag];
const PAGE_KINDS: &[&str] = &["regular", "journal"];
const TASK_STATUSES: &[&str] = &["todo", "doing", "done", "cancelled"];
const TASK_PRIORITIES: &[&str] = &["low", "medium", "high"];

pub const REGISTRY: &[PropertyDefinition] = &[
    PropertyDefinition {
        key: "builtin.query",
        value_type: PropertyType::Query,
        cardinality: Cardinality::Single,
        defaultable: false,
        allowed_strings: NONE,
        write_policy: WritePolicy::User,
        visibility: Visibility::Picker,
        targets: BLOCK,
    },
    PropertyDefinition {
        key: "builtin.task-status",
        value_type: PropertyType::String,
        cardinality: Cardinality::Single,
        defaultable: true,
        allowed_strings: TASK_STATUSES,
        write_policy: WritePolicy::User,
        visibility: Visibility::Picker,
        targets: BLOCK,
    },
    PropertyDefinition {
        key: "builtin.scheduled",
        value_type: PropertyType::Date,
        cardinality: Cardinality::Single,
        defaultable: true,
        allowed_strings: NONE,
        write_policy: WritePolicy::User,
        visibility: Visibility::Picker,
        targets: BLOCK,
    },
    PropertyDefinition {
        key: "builtin.deadline",
        value_type: PropertyType::Date,
        cardinality: Cardinality::Single,
        defaultable: true,
        allowed_strings: NONE,
        write_policy: WritePolicy::User,
        visibility: Visibility::Picker,
        targets: BLOCK,
    },
    PropertyDefinition {
        key: "builtin.priority",
        value_type: PropertyType::String,
        cardinality: Cardinality::Single,
        defaultable: true,
        allowed_strings: TASK_PRIORITIES,
        write_policy: WritePolicy::User,
        visibility: Visibility::Picker,
        targets: BLOCK,
    },
    PropertyDefinition {
        key: "builtin.page-kind",
        value_type: PropertyType::String,
        cardinality: Cardinality::Single,
        defaultable: false,
        allowed_strings: PAGE_KINDS,
        write_policy: WritePolicy::Core,
        visibility: Visibility::Info,
        targets: PAGE,
    },
    PropertyDefinition {
        key: "builtin.journal-date",
        value_type: PropertyType::Date,
        cardinality: Cardinality::Single,
        defaultable: false,
        allowed_strings: NONE,
        write_policy: WritePolicy::Core,
        visibility: Visibility::Info,
        targets: PAGE,
    },
    PropertyDefinition {
        key: "builtin.created-at",
        value_type: PropertyType::String,
        cardinality: Cardinality::Single,
        defaultable: false,
        allowed_strings: NONE,
        write_policy: WritePolicy::Core,
        visibility: Visibility::Info,
        targets: PAGE_TAG,
    },
    PropertyDefinition {
        key: "builtin.updated-at",
        value_type: PropertyType::String,
        cardinality: Cardinality::Single,
        defaultable: false,
        allowed_strings: NONE,
        write_policy: WritePolicy::Core,
        visibility: Visibility::Info,
        targets: PAGE_BLOCK,
    },
    PropertyDefinition {
        key: "builtin.deleted-at",
        value_type: PropertyType::String,
        cardinality: Cardinality::Single,
        defaultable: false,
        allowed_strings: NONE,
        write_policy: WritePolicy::Core,
        visibility: Visibility::Hidden,
        targets: PAGE_TAG,
    },
];

pub fn registry() -> &'static [PropertyDefinition] {
    REGISTRY
}

pub fn definition(key: &PropertyKey) -> Option<&'static PropertyDefinition> {
    REGISTRY.iter().find(|item| item.key == key.as_str())
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
    #[error("property {0} cannot be a tag default")]
    NotDefaultable(String),
    #[error("property {0} is not a registered builtin")]
    UnknownBuiltin(String),
    #[error("property {0} must use the builtin.* or custom.* namespace")]
    InvalidNamespace(String),
    #[error("property {0} is managed by the core")]
    NotUserWritable(String),
    #[error("property number must be finite")]
    NonFiniteNumber,
    #[error("property string exceeds 65536 bytes")]
    StringTooLong,
    #[error("query language cannot be empty")]
    EmptyQueryLanguage,
    #[error("query language exceeds 128 bytes")]
    QueryLanguageTooLong,
    #[error("{0} is structural and cannot be stored as a property")]
    StructuralKey(String),
}

fn validate_namespace(key: &PropertyKey) -> Result<(), PropertyError> {
    let value = key.as_str();
    if value.starts_with("builtin.") {
        if definition(key).is_none() {
            return Err(PropertyError::UnknownBuiltin(value.to_owned()));
        }
        return Ok(());
    }
    if let Some(local) = value.strip_prefix("custom.")
        && !local.is_empty()
        && !local.contains('.')
    {
        return Ok(());
    }
    Err(PropertyError::InvalidNamespace(value.to_owned()))
}

pub fn validate_property(
    key: &PropertyKey,
    value: &PropertyValue,
    cardinality: Cardinality,
) -> Result<(), PropertyError> {
    value.validate_shape()?;
    if matches!(key.as_str(), "tag" | "page.title" | "block.page") {
        return Err(PropertyError::StructuralKey(key.to_string()));
    }
    validate_namespace(key)?;
    let Some(item) = definition(key) else {
        if matches!(value, PropertyValue::Query(_)) {
            return Err(PropertyError::WrongType {
                key: key.to_string(),
                expected: PropertyType::String,
                actual: PropertyType::Query,
            });
        }
        return Ok(());
    };
    if value.property_type() != item.value_type {
        return Err(PropertyError::WrongType {
            key: key.to_string(),
            expected: item.value_type,
            actual: value.property_type(),
        });
    }
    if cardinality != item.cardinality {
        return Err(PropertyError::WrongCardinality {
            key: key.to_string(),
            expected: item.cardinality,
            actual: cardinality,
        });
    }
    if !item.allowed_strings.is_empty()
        && !matches!(key.as_str(), "builtin.task-status" | "builtin.priority")
    {
        let PropertyValue::String(value) = value else {
            unreachable!("registry type was checked")
        };
        if !item.allowed_strings.contains(&value.as_str()) {
            return Err(PropertyError::InvalidString {
                key: key.to_string(),
                value: value.clone(),
            });
        }
    }
    Ok(())
}

pub fn validate_user_write(key: &PropertyKey) -> Result<(), PropertyError> {
    validate_namespace(key)?;
    if definition(key).is_some_and(|item| item.write_policy != WritePolicy::User) {
        return Err(PropertyError::NotUserWritable(key.to_string()));
    }
    Ok(())
}

pub fn validate_default(key: &PropertyKey, value: &PropertyValue) -> Result<(), PropertyError> {
    value.validate_shape()?;
    validate_namespace(key)?;
    if let Some(item) = definition(key) {
        if !item.defaultable {
            return Err(PropertyError::NotDefaultable(key.to_string()));
        }
        validate_property(key, value, Cardinality::Single)?;
    } else if matches!(value, PropertyValue::Query(_)) {
        return Err(PropertyError::NotDefaultable(key.to_string()));
    }
    Ok(())
}

pub fn registry_fixture() -> serde_json::Value {
    let properties: Vec<_> = REGISTRY
        .iter()
        .map(|item| {
            serde_json::json!({
                "key": item.key,
                "type": item.value_type,
                "cardinality": item.cardinality,
                "defaultable": item.defaultable,
                "allowed_strings": item.allowed_strings,
                "write_policy": item.write_policy,
                "visibility": item.visibility,
                "targets": item.targets,
            })
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
    fn validates_namespaces_and_query_contract() {
        let query = PropertyValue::Query(QuerySpec {
            language: DEFAULT_QUERY_LANGUAGE.into(),
            source: "SELECT * WHERE {}".into(),
        });
        assert!(validate_property(&key("builtin.query"), &query, Cardinality::Single).is_ok());
        assert!(
            validate_property(
                &key("custom.owner"),
                &PropertyValue::String("Ada".into()),
                Cardinality::Single
            )
            .is_ok()
        );
        assert!(
            validate_property(
                &key("owner"),
                &PropertyValue::String("Ada".into()),
                Cardinality::Single
            )
            .is_err()
        );
        assert!(
            validate_property(
                &key("builtin.unknown"),
                &PropertyValue::String("x".into()),
                Cardinality::Single
            )
            .is_err()
        );
        assert!(validate_property(&key("custom.query"), &query, Cardinality::Single).is_err());
    }

    #[test]
    fn separates_write_policy_from_namespace() {
        assert!(validate_user_write(&key("builtin.deadline")).is_ok());
        assert!(validate_user_write(&key("custom.owner")).is_ok());
        assert!(validate_user_write(&key("builtin.updated-at")).is_err());
    }

    #[test]
    fn only_declared_feature_and_custom_defaults_are_allowed() {
        assert!(
            validate_default(
                &key("builtin.priority"),
                &PropertyValue::String("high".into())
            )
            .is_ok()
        );
        assert!(validate_default(&key("custom.flag"), &PropertyValue::Checkbox(true)).is_ok());
        assert!(
            validate_default(
                &key("builtin.page-kind"),
                &PropertyValue::String("regular".into())
            )
            .is_err()
        );
    }

    #[test]
    fn registry_matches_the_versioned_fixture() {
        let expected: serde_json::Value = serde_json::from_str(include_str!(
            "../../../fixtures/core/property-definitions-v4.json"
        ))
        .unwrap();
        assert_eq!(registry_fixture(), expected);
    }
}
