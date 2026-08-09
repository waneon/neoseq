use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};
use std::{fmt, str::FromStr};
use thiserror::Error;

const MAX_ID_LEN: usize = 160;
const MAX_KEY_LEN: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum IdError {
    #[error("{kind} cannot be empty")]
    Empty { kind: &'static str },
    #[error("{kind} exceeds {max} bytes")]
    TooLong { kind: &'static str, max: usize },
    #[error("{kind} contains a control character")]
    Control { kind: &'static str },
    #[error("invalid local date: {0}")]
    InvalidDate(String),
    #[error("property key must match `(builtin|user).<lowercase-kebab-name>`: {0}")]
    InvalidPropertyKey(String),
}

fn validate(value: &str, kind: &'static str, max: usize) -> Result<(), IdError> {
    if value.is_empty() {
        return Err(IdError::Empty { kind });
    }
    if value.len() > max {
        return Err(IdError::TooLong { kind, max });
    }
    if value.chars().any(char::is_control) {
        return Err(IdError::Control { kind });
    }
    Ok(())
}

macro_rules! opaque_string {
    ($name:ident, $kind:literal) => {
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, IdError> {
                let value = value.into();
                validate(&value, $kind, MAX_ID_LEN)?;
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl FromStr for $name {
            type Err = IdError;
            fn from_str(value: &str) -> Result<Self, Self::Err> {
                Self::new(value)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let value = String::deserialize(deserializer)?;
                Self::new(value).map_err(serde::de::Error::custom)
            }
        }
    };
}

opaque_string!(GraphId, "graph id");
opaque_string!(PageId, "page id");
opaque_string!(BlockId, "block id");
opaque_string!(TagId, "tag id");
opaque_string!(CommandId, "command id");
opaque_string!(QueryViewId, "query view id");

impl PageId {
    pub fn journal(graph: &GraphId, date: &LocalDate) -> Self {
        let mut digest = Sha256::new();
        digest.update(b"neoseq-journal-v1\0");
        digest.update(graph.as_str().as_bytes());
        digest.update(b"\0");
        digest.update(date.as_str().as_bytes());
        let hash = digest.finalize();
        Self(format!("journal-{}", hex_lower(&hash[..16])))
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0xf) as usize] as char);
    }
    output
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct PropertyKey(String);

impl PropertyKey {
    pub fn new(value: impl Into<String>) -> Result<Self, IdError> {
        let value = value.into();
        validate(&value, "property key", MAX_KEY_LEN)?;
        if value.trim() != value {
            return Err(IdError::Control {
                kind: "property key with surrounding whitespace",
            });
        }
        if !valid_property_key(&value) {
            return Err(IdError::InvalidPropertyKey(value));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

fn valid_property_key(value: &str) -> bool {
    let Some((namespace, name)) = value.split_once('.') else {
        return false;
    };
    matches!(namespace, "builtin" | "user") && valid_property_name(name)
}

fn valid_property_name(name: &str) -> bool {
    let mut segments = name.split('-');
    let Some(first) = segments.next() else {
        return false;
    };
    if !first.starts_with(|character: char| character.is_ascii_lowercase()) {
        return false;
    }
    if !first
        .chars()
        .all(|character| character.is_ascii_lowercase() || character.is_ascii_digit())
    {
        return false;
    }
    segments.all(|segment| {
        !segment.is_empty()
            && segment
                .chars()
                .all(|character| character.is_ascii_lowercase() || character.is_ascii_digit())
    })
}

impl fmt::Display for PropertyKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl FromStr for PropertyKey {
    type Err = IdError;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::new(value)
    }
}

impl<'de> Deserialize<'de> for PropertyKey {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct LocalDate(String);

impl LocalDate {
    pub fn new(value: impl Into<String>) -> Result<Self, IdError> {
        let value = value.into();
        if !valid_date(&value) {
            return Err(IdError::InvalidDate(value));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for LocalDate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl FromStr for LocalDate {
    type Err = IdError;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::new(value)
    }
}

impl<'de> Deserialize<'de> for LocalDate {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

fn valid_date(value: &str) -> bool {
    if value.len() != 10 || &value[4..5] != "-" || &value[7..8] != "-" {
        return false;
    }
    let Ok(year) = value[0..4].parse::<u32>() else {
        return false;
    };
    let Ok(month) = value[5..7].parse::<u32>() else {
        return false;
    };
    let Ok(day) = value[8..10].parse::<u32>() else {
        return false;
    };
    if year == 0 || !(1..=12).contains(&month) {
        return false;
    }
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let days = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    (1..=days).contains(&day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_calendar_dates() {
        assert!(LocalDate::new("2024-02-29").is_ok());
        assert!(LocalDate::new("2023-02-29").is_err());
        assert!(LocalDate::new("2026-13-01").is_err());
    }

    #[test]
    fn journal_ids_are_graph_scoped_and_deterministic() {
        let date = LocalDate::new("2026-08-03").unwrap();
        let one = PageId::journal(&GraphId::new("one").unwrap(), &date);
        assert_eq!(one, PageId::journal(&GraphId::new("one").unwrap(), &date));
        assert_ne!(one, PageId::journal(&GraphId::new("two").unwrap(), &date));
    }

    #[test]
    fn property_keys_use_one_owned_namespace_and_a_kebab_name() {
        for valid in ["builtin.task-status", "user.rating", "user.crm-id2"] {
            assert!(PropertyKey::new(valid).is_ok(), "{valid}");
        }
        for invalid in [
            "tag",
            "task.status",
            "custom.rating",
            "user.task.status",
            "user.Task",
            "user.-rating",
            "user.rating-",
            "user.two--words",
            "user.2rating",
        ] {
            assert!(PropertyKey::new(invalid).is_err(), "{invalid}");
        }
    }
}
