use crate::{LocalDate, PageId, PropertyKey};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const REGISTRY_VERSION: u32 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PropertyType {
    Number,
    String,
    Page,
    Checkbox,
    Date,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Cardinality {
    Single,
    Repeated,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum PropertyValue {
    Number(f64),
    String(String),
    Page(PageId),
    Checkbox(bool),
    Date(LocalDate),
}

impl PropertyValue {
    pub fn property_type(&self) -> PropertyType {
        match self {
            Self::Number(_) => PropertyType::Number,
            Self::String(_) => PropertyType::String,
            Self::Page(_) => PropertyType::Page,
            Self::Checkbox(_) => PropertyType::Checkbox,
            Self::Date(_) => PropertyType::Date,
        }
    }

    pub fn validate_shape(&self) -> Result<(), PropertyError> {
        match self {
            Self::Number(value) if !value.is_finite() => Err(PropertyError::NonFiniteNumber),
            Self::String(value) if value.len() > 65_536 => Err(PropertyError::StringTooLong),
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
}

const NONE: &[&str] = &[];
const PAGE_KINDS: &[&str] = &["regular", "journal"];
const TASK_STATUSES: &[&str] = &["todo", "doing", "done", "cancelled"];
const TASK_PRIORITIES: &[&str] = &["low", "medium", "high"];
const QUERY_LANGUAGES: &[&str] = &["neoseq"];

pub const REGISTRY: &[PropertyDefinition] = &[
    PropertyDefinition {
        key: "tag",
        value_type: PropertyType::Page,
        cardinality: Cardinality::Repeated,
        defaultable: false,
        allowed_strings: NONE,
    },
    PropertyDefinition {
        key: "query.source",
        value_type: PropertyType::String,
        cardinality: Cardinality::Single,
        defaultable: false,
        allowed_strings: NONE,
    },
    PropertyDefinition {
        key: "query.language",
        value_type: PropertyType::String,
        cardinality: Cardinality::Single,
        defaultable: false,
        allowed_strings: QUERY_LANGUAGES,
    },
    PropertyDefinition {
        key: "task.status",
        value_type: PropertyType::String,
        cardinality: Cardinality::Single,
        defaultable: true,
        allowed_strings: TASK_STATUSES,
    },
    PropertyDefinition {
        key: "task.scheduled",
        value_type: PropertyType::Date,
        cardinality: Cardinality::Single,
        defaultable: true,
        allowed_strings: NONE,
    },
    PropertyDefinition {
        key: "task.deadline",
        value_type: PropertyType::Date,
        cardinality: Cardinality::Single,
        defaultable: true,
        allowed_strings: NONE,
    },
    PropertyDefinition {
        key: "task.priority",
        value_type: PropertyType::String,
        cardinality: Cardinality::Single,
        defaultable: true,
        allowed_strings: TASK_PRIORITIES,
    },
    PropertyDefinition {
        key: "page.title",
        value_type: PropertyType::String,
        cardinality: Cardinality::Single,
        defaultable: false,
        allowed_strings: NONE,
    },
    PropertyDefinition {
        key: "page.kind",
        value_type: PropertyType::String,
        cardinality: Cardinality::Single,
        defaultable: false,
        allowed_strings: PAGE_KINDS,
    },
    PropertyDefinition {
        key: "journal.date",
        value_type: PropertyType::Date,
        cardinality: Cardinality::Single,
        defaultable: false,
        allowed_strings: NONE,
    },
    PropertyDefinition {
        key: "system.created-at",
        value_type: PropertyType::String,
        cardinality: Cardinality::Single,
        defaultable: false,
        allowed_strings: NONE,
    },
    PropertyDefinition {
        key: "system.deleted-at",
        value_type: PropertyType::String,
        cardinality: Cardinality::Single,
        defaultable: false,
        allowed_strings: NONE,
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
    #[error("property {0} cannot be a page default")]
    NotDefaultable(String),
    #[error("property number must be finite")]
    NonFiniteNumber,
    #[error("property string exceeds 65536 bytes")]
    StringTooLong,
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
    if !item.allowed_strings.is_empty() {
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

pub fn validate_default(key: &PropertyKey, value: &PropertyValue) -> Result<(), PropertyError> {
    value.validate_shape()?;
    if key.as_str().starts_with("page.") || key.as_str().starts_with("system.") {
        return Err(PropertyError::NotDefaultable(key.to_string()));
    }
    if let Some(item) = definition(key) {
        if !item.defaultable {
            return Err(PropertyError::NotDefaultable(key.to_string()));
        }
        validate_property(key, value, Cardinality::Single)?;
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
    fn validates_well_known_contracts_and_preserves_unknown_types() {
        assert!(
            validate_property(
                &key("task.status"),
                &PropertyValue::String("done".into()),
                Cardinality::Single
            )
            .is_ok()
        );
        assert!(
            validate_property(
                &key("task.status"),
                &PropertyValue::String("later".into()),
                Cardinality::Single
            )
            .is_err()
        );
        assert!(
            validate_property(
                &key("tag"),
                &PropertyValue::Page(PageId::new("p").unwrap()),
                Cardinality::Repeated
            )
            .is_ok()
        );
        assert!(
            validate_property(
                &key("future.number"),
                &PropertyValue::Number(3.5),
                Cardinality::Repeated
            )
            .is_ok()
        );
    }

    #[test]
    fn only_declared_feature_and_unknown_defaults_are_allowed() {
        assert!(
            validate_default(&key("task.priority"), &PropertyValue::String("high".into())).is_ok()
        );
        assert!(validate_default(&key("custom.flag"), &PropertyValue::Checkbox(true)).is_ok());
        assert!(
            validate_default(&key("tag"), &PropertyValue::Page(PageId::new("p").unwrap())).is_err()
        );
        assert!(validate_default(&key("page.title"), &PropertyValue::String("x".into())).is_err());
    }

    #[test]
    fn registry_matches_the_versioned_fixture() {
        let expected: serde_json::Value = serde_json::from_str(include_str!(
            "../../../fixtures/core/property-definitions-v2.json"
        ))
        .unwrap();
        assert_eq!(registry_fixture(), expected);
    }
}
