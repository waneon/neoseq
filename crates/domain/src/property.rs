use crate::{
    LocalDate, PageId, PropertyKey, QueryView, QueryViewId, QueryViewKind, QueryViewOptions,
};
use serde::{Deserialize, Deserializer, Serialize, de};
use thiserror::Error;

pub const REGISTRY_VERSION: u32 = 9;
pub const QUERY_PROPERTY_KEY: &str = "builtin.query";
pub const QUERY_DOCUMENT_SCHEMA: &str = "neoseq.query";
pub const QUERY_DOCUMENT_VERSION: u32 = 2;
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
    pub views: Vec<QueryView>,
    pub default_view_id: QueryViewId,
}

impl PropertyDocument {
    pub fn default_query(source: String) -> Self {
        Self {
            schema: QUERY_DOCUMENT_SCHEMA.to_owned(),
            version: QUERY_DOCUMENT_VERSION,
            // One view, named for what it shows rather than for how it is drawn.
            // A document used to be born with a `Table` and a `List` holding the
            // same rows under two names for their own shapes, which is chrome
            // rather than information: the layout is a *property* of a view, and
            // a second view is what a reader makes when they mean a second
            // question — not something the product guesses on their behalf.
            views: vec![QueryView {
                id: QueryViewId::new("all").expect("static query view id"),
                name: "All".to_owned(),
                definition: crate::QueryDefinition {
                    source,
                    language: QUERY_LANGUAGE.to_owned(),
                    plan: None,
                },
                kind: QueryViewKind::Table,
                position: 0,
                columns: Vec::new(),
                options: QueryViewOptions::default(),
            }],
            default_view_id: QueryViewId::new("all").expect("static query view id"),
        }
    }

    pub fn validate(&self) -> Result<(), PropertyError> {
        if self.schema != QUERY_DOCUMENT_SCHEMA || self.version != QUERY_DOCUMENT_VERSION {
            return Err(PropertyError::UnsupportedDocument {
                schema: self.schema.clone(),
                version: self.version,
            });
        }
        if self.views.is_empty() || self.views.len() > 32 {
            return Err(PropertyError::InvalidDocument(
                "query document must contain between 1 and 32 views".to_owned(),
            ));
        }
        let mut ids = std::collections::BTreeSet::new();
        for view in &self.views {
            if view.definition.language != QUERY_LANGUAGE {
                return Err(PropertyError::InvalidDocument(
                    "unsupported query language".to_owned(),
                ));
            }
            if view.definition.source.len() > 65_536 {
                return Err(PropertyError::StringTooLong);
            }
            if let Some(plan) = &view.definition.plan {
                plan.validate()?;
            }
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
            if view.options.list_sort.len() > QUERY_VIEW_SORT_LIMIT {
                return Err(PropertyError::InvalidDocument(
                    "too many query list sort terms".to_owned(),
                ));
            }
            let mut sorted_fields = std::collections::BTreeSet::new();
            for sort in &view.options.list_sort {
                if sort.field.is_empty()
                    // A property key may itself occupy 128 bytes; its stable
                    // `property:` field prefix still has to fit.
                    || sort.field.len() > 256
                    || sort.field.chars().any(char::is_control)
                {
                    return Err(PropertyError::InvalidDocument(
                        "invalid query list sort field".to_owned(),
                    ));
                }
                if !sorted_fields.insert(sort.field.as_str()) {
                    return Err(PropertyError::InvalidDocument(
                        "duplicate query list sort field".to_owned(),
                    ));
                }
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

/// A property map with an array-shaped wire representation.
///
/// Fields are kept in key order, so iteration and serialization are stable,
/// while construction and deserialization reject duplicate keys. Mutation is
/// deliberately limited to operations that preserve those invariants.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(transparent)]
pub struct PropertyBag(Vec<PropertyField>);

impl PropertyBag {
    pub const fn new() -> Self {
        Self(Vec::new())
    }

    pub fn try_from_fields(
        fields: impl IntoIterator<Item = PropertyField>,
    ) -> Result<Self, PropertyError> {
        let mut fields = fields.into_iter().collect::<Vec<_>>();
        for field in &fields {
            validate_projected_property_field(field)?;
        }
        fields.sort_by(|left, right| left.key.cmp(&right.key));
        if let Some(duplicate) = fields
            .windows(2)
            .find(|pair| pair[0].key == pair[1].key)
            .map(|pair| pair[0].key.to_string())
        {
            return Err(PropertyError::DuplicateKey(duplicate));
        }
        Ok(Self(fields))
    }

    pub fn get(&self, key: &str) -> Option<&PropertyField> {
        self.0
            .binary_search_by(|field| field.key.as_str().cmp(key))
            .ok()
            .map(|index| &self.0[index])
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    pub fn iter(&self) -> std::slice::Iter<'_, PropertyField> {
        self.0.iter()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn insert(&mut self, field: PropertyField) -> Result<Option<PropertyField>, PropertyError> {
        validate_projected_property_field(&field)?;
        match self.0.binary_search_by(|item| item.key.cmp(&field.key)) {
            Ok(index) => Ok(Some(std::mem::replace(&mut self.0[index], field))),
            Err(index) => {
                self.0.insert(index, field);
                Ok(None)
            }
        }
    }

    pub fn remove(&mut self, key: &str) -> Option<PropertyField> {
        self.0
            .binary_search_by(|field| field.key.as_str().cmp(key))
            .ok()
            .map(|index| self.0.remove(index))
    }

    pub fn retain(&mut self, mut keep: impl FnMut(&PropertyField) -> bool) {
        self.0.retain(|field| keep(field));
    }
}

impl TryFrom<Vec<PropertyField>> for PropertyBag {
    type Error = PropertyError;

    fn try_from(fields: Vec<PropertyField>) -> Result<Self, Self::Error> {
        Self::try_from_fields(fields)
    }
}

impl<'de> Deserialize<'de> for PropertyBag {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let fields = Vec::<PropertyField>::deserialize(deserializer)?;
        Self::try_from(fields).map_err(de::Error::custom)
    }
}

impl<'a> IntoIterator for &'a PropertyBag {
    type Item = &'a PropertyField;
    type IntoIter = std::slice::Iter<'a, PropertyField>;

    fn into_iter(self) -> Self::IntoIter {
        self.iter()
    }
}

impl IntoIterator for PropertyBag {
    type Item = PropertyField;
    type IntoIter = std::vec::IntoIter<PropertyField>;

    fn into_iter(self) -> Self::IntoIter {
        self.0.into_iter()
    }
}

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
/// The two things a reader navigates to, and therefore the two a reader stars.
const USER_PAGE_TAG: &[PropertyPlacement] = &[
    PropertyPlacement::user(PropertyTarget::Page),
    PropertyPlacement::user(PropertyTarget::TagMetadata),
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
        // What a reader keeps to hand. It sits on the page or the tag rather than
        // in a list of its own, so nothing has to be kept in step when one is
        // deleted, and it travels with the graph rather than with the browser
        // that starred it.
        "builtin.favorite",
        PropertySpec {
            shape: PropertyShape::Single(PropertyValueSpec::Checkbox),
            ordering: None,
            placements: USER_PAGE_TAG,
            copy: PropertyCopyPolicy::Portable,
        },
    ),
    (
        // Where it sits in that list. One number, exactly as a tag's own order
        // is: favourites sort by it and a move lands on the midpoint between
        // its new neighbours, so an ordinary move writes only what moved. It
        // lives beside the flag rather than in a list, for the same reason the
        // flag does — nothing to keep in step when one is deleted.
        "builtin.favorite-order",
        PropertySpec {
            shape: PropertyShape::Single(PropertyValueSpec::Number),
            ordering: None,
            placements: USER_PAGE_TAG,
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
    #[error("property bag contains duplicate key {0}")]
    DuplicateKey(String),
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
    validate_property_field_inner(field, false)
}

fn validate_projected_property_field(field: &PropertyField) -> Result<(), PropertyError> {
    validate_property_field_inner(field, true)
}

fn validate_property_field_inner(
    field: &PropertyField,
    allow_unsupported_document: bool,
) -> Result<(), PropertyError> {
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
        // An unsupported document is a valid forward-compatible read
        // projection, though the strict command validator below still rejects
        // writing it back into canonical storage.
        if allow_unsupported_document && matches!(value, PropertyValue::UnsupportedDocument(_)) {
            continue;
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

    fn string_field(raw_key: &str, value: &str) -> PropertyField {
        PropertyField {
            key: key(raw_key),
            value_type: PropertyType::String,
            cardinality: Cardinality::Single,
            values: vec![PropertyValue::String(value.to_owned())],
        }
    }

    #[test]
    fn property_bag_keeps_array_json_and_orders_fields_by_key() {
        let bag = PropertyBag::try_from_fields([
            string_field("user.z-last", "last"),
            string_field("user.a-first", "first"),
        ])
        .unwrap();

        assert_eq!(
            bag.iter()
                .map(|field| field.key.as_str())
                .collect::<Vec<_>>(),
            ["user.a-first", "user.z-last"]
        );
        assert_eq!(
            bag.get("user.a-first").unwrap().values,
            [PropertyValue::String("first".to_owned())]
        );
        let json = serde_json::to_value(&bag).unwrap();
        assert!(json.is_array());
        assert_eq!(json[0]["key"], "user.a-first");
        assert_eq!(serde_json::from_value::<PropertyBag>(json).unwrap(), bag);
    }

    #[test]
    fn property_bag_rejects_duplicate_keys_at_every_input_boundary() {
        let fields = vec![
            string_field("user.same", "one"),
            string_field("user.same", "two"),
        ];
        assert!(matches!(
            PropertyBag::try_from(fields.clone()),
            Err(PropertyError::DuplicateKey(key)) if key == "user.same"
        ));

        let json = serde_json::to_value(fields).unwrap();
        let error = serde_json::from_value::<PropertyBag>(json).unwrap_err();
        assert!(error.to_string().contains("duplicate key user.same"));
    }

    #[test]
    fn property_bag_validates_field_shape_and_replaces_by_key_safely() {
        let invalid = PropertyField {
            key: key("user.invalid"),
            value_type: PropertyType::Number,
            cardinality: Cardinality::Single,
            values: vec![PropertyValue::String("not a number".to_owned())],
        };
        assert!(matches!(
            PropertyBag::try_from_fields([invalid]),
            Err(PropertyError::WrongType { .. })
        ));

        let mut bag = PropertyBag::try_from_fields([string_field("user.value", "before")])
            .expect("valid field");
        let replaced = bag
            .insert(string_field("user.value", "after"))
            .unwrap()
            .unwrap();
        assert_eq!(
            replaced.values,
            [PropertyValue::String("before".to_owned())]
        );
        assert_eq!(bag.len(), 1);
        assert_eq!(
            bag.get("user.value").unwrap().values,
            [PropertyValue::String("after".to_owned())]
        );
    }

    #[test]
    fn property_bag_preserves_forward_compatible_document_projections() {
        let field = PropertyField {
            key: key(QUERY_PROPERTY_KEY),
            value_type: PropertyType::Document,
            cardinality: Cardinality::Single,
            values: vec![PropertyValue::UnsupportedDocument(PropertyDocumentHeader {
                schema: "future.query".to_owned(),
                version: 99,
            })],
        };
        let bag = PropertyBag::try_from_fields([field]).unwrap();
        let json = serde_json::to_value(&bag).unwrap();

        assert_eq!(serde_json::from_value::<PropertyBag>(json).unwrap(), bag);
        assert!(validate_property_field(bag.get(QUERY_PROPERTY_KEY).unwrap()).is_err());
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

    #[test]
    fn query_list_sort_is_a_bounded_list_of_distinct_fields() {
        let mut document = PropertyDocument::default_query("SELECT * WHERE {}".to_owned());
        document.views[0].options.list_sort = vec![
            crate::QueryViewFieldSort {
                field: "content".to_owned(),
                descending: false,
            },
            crate::QueryViewFieldSort {
                field: "property:builtin.task-priority".to_owned(),
                descending: true,
            },
        ];
        assert!(document.validate().is_ok());
        document.views[0].options.list_sort[1].field = "content".to_owned();
        assert!(document.validate().is_err());
        document.views[0].options.list_sort = (0..=QUERY_VIEW_SORT_LIMIT)
            .map(|index| crate::QueryViewFieldSort {
                field: format!("property:user.field-{index}"),
                descending: false,
            })
            .collect();
        assert!(document.validate().is_err());
    }

    #[test]
    fn query_plan_accepts_a_bounded_json_object_only() {
        let mut document = PropertyDocument::default_query("SELECT * WHERE {}".to_owned());
        document.views[0].definition.plan = Some(QueryPlan {
            version: 1,
            payload: "{\"subject\":\"block\"}".to_owned(),
        });
        assert!(document.validate().is_ok());
        document.views[0].definition.plan = Some(QueryPlan {
            version: 1,
            payload: "[1,2]".to_owned(),
        });
        assert!(document.validate().is_err());
        document.views[0].definition.plan = Some(QueryPlan {
            version: 0,
            payload: "{}".to_owned(),
        });
        assert!(document.validate().is_err());
        document.views[0].definition.plan = Some(QueryPlan {
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
