use crate::{LocalDate, PageId, PropertyKey};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const REGISTRY_VERSION: u32 = 4;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PropertyTarget {
    Page,
    Block,
    TagMetadata,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PropertyWritePolicy {
    User,
    Core,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StringValuePolicy {
    Any,
    Suggested,
    Restricted,
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
    pub valid_targets: &'static [PropertyTarget],
    pub user_writable_targets: &'static [PropertyTarget],
    pub write_policy: PropertyWritePolicy,
    pub defaultable: bool,
    pub string_value_policy: StringValuePolicy,
    pub allowed_strings: &'static [&'static str],
}

const NONE: &[&str] = &[];
const PAGE: &[PropertyTarget] = &[PropertyTarget::Page];
const PAGE_BLOCK: &[PropertyTarget] = &[PropertyTarget::Page, PropertyTarget::Block];
const PAGE_TAG: &[PropertyTarget] = &[PropertyTarget::Page, PropertyTarget::TagMetadata];
const NO_TARGETS: &[PropertyTarget] = &[];
const PAGE_KINDS: &[&str] = &["regular", "journal"];
const TASK_STATUSES: &[&str] = &["todo", "doing", "done", "cancelled"];
const TASK_PRIORITIES: &[&str] = &["low", "medium", "high"];
const QUERY_LANGUAGES: &[&str] = &["sparql-1.1/neoseq-v1"];

pub const REGISTRY: &[PropertyDefinition] = &[
    PropertyDefinition {
        key: "query.source",
        value_type: PropertyType::String,
        cardinality: Cardinality::Single,
        valid_targets: PAGE_BLOCK,
        user_writable_targets: PAGE_BLOCK,
        write_policy: PropertyWritePolicy::User,
        defaultable: false,
        string_value_policy: StringValuePolicy::Any,
        allowed_strings: NONE,
    },
    PropertyDefinition {
        key: "query.language",
        value_type: PropertyType::String,
        cardinality: Cardinality::Single,
        valid_targets: PAGE_BLOCK,
        user_writable_targets: PAGE_BLOCK,
        write_policy: PropertyWritePolicy::User,
        defaultable: false,
        string_value_policy: StringValuePolicy::Restricted,
        allowed_strings: QUERY_LANGUAGES,
    },
    PropertyDefinition {
        key: "task.status",
        value_type: PropertyType::String,
        cardinality: Cardinality::Single,
        valid_targets: PAGE_BLOCK,
        user_writable_targets: PAGE_BLOCK,
        write_policy: PropertyWritePolicy::User,
        defaultable: true,
        string_value_policy: StringValuePolicy::Suggested,
        allowed_strings: TASK_STATUSES,
    },
    PropertyDefinition {
        key: "task.scheduled",
        value_type: PropertyType::Date,
        cardinality: Cardinality::Single,
        valid_targets: PAGE_BLOCK,
        user_writable_targets: PAGE_BLOCK,
        write_policy: PropertyWritePolicy::User,
        defaultable: true,
        string_value_policy: StringValuePolicy::Any,
        allowed_strings: NONE,
    },
    PropertyDefinition {
        key: "task.deadline",
        value_type: PropertyType::Date,
        cardinality: Cardinality::Single,
        valid_targets: PAGE_BLOCK,
        user_writable_targets: PAGE_BLOCK,
        write_policy: PropertyWritePolicy::User,
        defaultable: true,
        string_value_policy: StringValuePolicy::Any,
        allowed_strings: NONE,
    },
    PropertyDefinition {
        key: "task.priority",
        value_type: PropertyType::String,
        cardinality: Cardinality::Single,
        valid_targets: PAGE_BLOCK,
        user_writable_targets: PAGE_BLOCK,
        write_policy: PropertyWritePolicy::User,
        defaultable: true,
        string_value_policy: StringValuePolicy::Suggested,
        allowed_strings: TASK_PRIORITIES,
    },
    PropertyDefinition {
        key: "page.kind",
        value_type: PropertyType::String,
        cardinality: Cardinality::Single,
        valid_targets: PAGE,
        user_writable_targets: NO_TARGETS,
        write_policy: PropertyWritePolicy::Core,
        defaultable: false,
        string_value_policy: StringValuePolicy::Restricted,
        allowed_strings: PAGE_KINDS,
    },
    PropertyDefinition {
        key: "journal.date",
        value_type: PropertyType::Date,
        cardinality: Cardinality::Single,
        valid_targets: PAGE,
        user_writable_targets: NO_TARGETS,
        write_policy: PropertyWritePolicy::Core,
        defaultable: false,
        string_value_policy: StringValuePolicy::Any,
        allowed_strings: NONE,
    },
    PropertyDefinition {
        key: "system.created-at",
        value_type: PropertyType::String,
        cardinality: Cardinality::Single,
        valid_targets: PAGE_TAG,
        user_writable_targets: NO_TARGETS,
        write_policy: PropertyWritePolicy::Core,
        defaultable: false,
        string_value_policy: StringValuePolicy::Any,
        allowed_strings: NONE,
    },
    PropertyDefinition {
        key: "system.updated-at",
        value_type: PropertyType::String,
        cardinality: Cardinality::Single,
        valid_targets: PAGE_BLOCK,
        user_writable_targets: NO_TARGETS,
        write_policy: PropertyWritePolicy::Core,
        defaultable: false,
        string_value_policy: StringValuePolicy::Any,
        allowed_strings: NONE,
    },
    PropertyDefinition {
        key: "system.deleted-at",
        value_type: PropertyType::String,
        cardinality: Cardinality::Single,
        valid_targets: PAGE_TAG,
        user_writable_targets: NO_TARGETS,
        write_policy: PropertyWritePolicy::Core,
        defaultable: false,
        string_value_policy: StringValuePolicy::Any,
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
    #[error("property {0} cannot be a tag default")]
    NotDefaultable(String),
    #[error("property number must be finite")]
    NonFiniteNumber,
    #[error("property string exceeds 65536 bytes")]
    StringTooLong,
    #[error("{0} is structural and cannot be stored as a property")]
    StructuralKey(String),
    #[error("property {key} is not valid on {target:?}")]
    InvalidTarget { key: String, target: PropertyTarget },
    #[error("property {0} is managed by the core")]
    CoreManaged(String),
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
    if item.string_value_policy == StringValuePolicy::Restricted {
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

pub fn validate_property_target(
    key: &PropertyKey,
    target: PropertyTarget,
) -> Result<(), PropertyError> {
    if matches!(key.as_str(), "tag" | "page.title" | "block.page") {
        return Err(PropertyError::StructuralKey(key.to_string()));
    }
    let valid = definition(key).map_or_else(
        || match target {
            // Unknown page and system keys remain readable for forward
            // compatibility; the write policy below still reserves system.*.
            PropertyTarget::Page => true,
            PropertyTarget::Block => {
                !key.as_str().starts_with("page.") && !key.as_str().starts_with("system.")
            }
            PropertyTarget::TagMetadata => key.as_str().starts_with("system."),
        },
        |item| item.valid_targets.contains(&target),
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
        if item.write_policy == PropertyWritePolicy::Core
            || !item.user_writable_targets.contains(&target)
        {
            return Err(PropertyError::CoreManaged(key.to_string()));
        }
    } else if key.as_str().starts_with("system.") {
        return Err(PropertyError::CoreManaged(key.to_string()));
    }
    Ok(())
}

pub fn validate_default(key: &PropertyKey, value: &PropertyValue) -> Result<(), PropertyError> {
    value.validate_shape()?;
    if key.as_str().starts_with("page.")
        || key.as_str().starts_with("system.")
        || matches!(key.as_str(), "tag" | "block.page")
    {
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
                "valid_targets": item.valid_targets,
                "user_writable_targets": item.user_writable_targets,
                "write_policy": item.write_policy,
                "defaultable": item.defaultable,
                "string_value_policy": item.string_value_policy,
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
            .is_ok()
        );
        assert!(
            validate_property(
                &key("tag"),
                &PropertyValue::Page(PageId::new("p").unwrap()),
                Cardinality::Repeated
            )
            .is_err()
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
    fn registry_owns_target_and_write_policy() {
        assert!(validate_property_write(&key("task.status"), PropertyTarget::Page).is_ok());
        assert!(validate_property_write(&key("task.status"), PropertyTarget::Block).is_ok());
        assert!(
            validate_property_target(&key("system.created-at"), PropertyTarget::TagMetadata)
                .is_ok()
        );
        assert!(validate_property_write(&key("page.kind"), PropertyTarget::Page).is_err());
        assert!(validate_property_write(&key("system.deleted-at"), PropertyTarget::Page).is_err());
        assert!(validate_property_target(&key("page.custom"), PropertyTarget::Block).is_err());
        assert!(validate_property_write(&key("custom.value"), PropertyTarget::Block).is_ok());
        assert!(validate_property_target(&key("system.future"), PropertyTarget::Page).is_ok());
        assert!(validate_property_write(&key("system.future"), PropertyTarget::Page).is_err());
    }

    #[test]
    fn string_policy_distinguishes_suggestions_from_restrictions() {
        assert!(
            validate_property(
                &key("task.status"),
                &PropertyValue::String("waiting".into()),
                Cardinality::Single,
            )
            .is_ok()
        );
        assert!(
            validate_property(
                &key("query.language"),
                &PropertyValue::String("future-query-language".into()),
                Cardinality::Single,
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
