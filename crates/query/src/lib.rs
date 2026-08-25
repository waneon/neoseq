//! Reproducible RDF projection and read-only SPARQL execution.

use domain::{
    BlockSnapshot, GraphId, GraphSnapshot, OutlineOwner, PageId, PageSnapshot, PropertyBag,
    PropertyValue, TagId, TagSnapshot,
};
use oxigraph::model::{
    Dataset, GraphNameRef, Literal, NamedNode, Quad, QuadRef, Term, Triple, Variable,
    vocab::{rdf, xsd},
};
use oxigraph::sparql::{QueryResults, SparqlEvaluator};
use oxigraph::store::{StorageError, Store, Transaction};
use roaring::RoaringBitmap;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use spargebra::algebra::{Expression, Function, GraphPattern, OrderExpression};
use spargebra::term::{GroundTerm, NamedNodePattern, TermPattern, TriplePattern};
use spargebra::{Query, SparqlParser};
use std::{
    cmp::{Ordering, Reverse},
    collections::{BTreeMap, BTreeSet, BinaryHeap, HashMap, HashSet, VecDeque},
    sync::Arc,
};
use thiserror::Error;

pub const QUERY_LANGUAGE: &str = "sparql-1.1/neoseq-v1";

pub const NEO_NS: &str = "urn:neoseq:vocab:v1:";
pub const PROPERTY_NS: &str = "urn:neoseq:property:";
pub const DEFAULT_PROPERTY_NS: &str = "urn:neoseq:default-property:";
pub const PROPERTY_KEY_NS: &str = "urn:neoseq:property-key:";
pub const ENTITY_NS: &str = "urn:neoseq:entity:";
pub const MATCHES_TEXT: &str = "urn:neoseq:vocab:v1:matchesText";
const NEO_CONTENT: &str = "urn:neoseq:vocab:v1:content";
const NEO_NAME: &str = "urn:neoseq:vocab:v1:name";
const MIN_TOP_K_ENTITY_COUNT: usize = 12_000;
const MIN_TOP_K_CANDIDATE_COUNT: u64 = 5_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum QueryEntityRef {
    Page { id: String },
    Block { owner: OutlineOwner, id: String },
    Tag { id: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RdfTerm {
    Iri {
        value: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        entity: Option<QueryEntityRef>,
    },
    Literal {
        value: String,
        datatype: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        language: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct QueryBudget {
    pub max_source_bytes: usize,
    pub max_algebra_operators: usize,
    pub max_bindings: usize,
    pub max_rows: usize,
}

impl Default for QueryBudget {
    fn default() -> Self {
        Self {
            max_source_bytes: 65_536,
            max_algebra_operators: 512,
            max_bindings: 64,
            max_rows: 1_000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QueryRequest {
    pub language: String,
    pub source: String,
    #[serde(default)]
    pub bindings: BTreeMap<String, RdfTerm>,
    #[serde(default)]
    pub budget: QueryBudget,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum QueryResult {
    Select {
        variables: Vec<String>,
        rows: Vec<BTreeMap<String, RdfTerm>>,
        revision: u64,
        frontier: String,
    },
    Ask {
        value: bool,
        revision: u64,
        frontier: String,
    },
}

/// A validated, bounded replacement set for the derived index. Pages are the
/// structural publication unit because a tree edit may change parent and
/// sibling-index triples for more than the command's directly targeted block.
#[derive(Debug, Clone)]
pub struct IndexDelta {
    pub pages: Vec<PageSnapshot>,
    pub removed_pages: Vec<PageId>,
    pub tags: Vec<TagSnapshot>,
    pub removed_tags: Vec<TagId>,
    pub frontier: String,
}

/// One independently projected unit consumed by the cold index builder.
#[derive(Debug, Clone)]
pub enum IndexUnit {
    Page(PageSnapshot),
    Tag(TagSnapshot),
}

#[derive(Debug, Error)]
pub enum QueryError {
    #[error("unsupported query language: {0}")]
    UnsupportedLanguage(String),
    #[error("query source exceeds the configured budget")]
    SourceBudget,
    #[error("query has too many bound variables")]
    BindingBudget,
    #[error("query algebra exceeds the configured budget")]
    AlgebraBudget,
    #[error("query output exceeds the configured row budget")]
    RowBudget,
    #[error("SPARQL syntax error: {0}")]
    Syntax(String),
    #[error("query form is not allowed: {0}")]
    Disallowed(String),
    #[error("invalid RDF term: {0}")]
    InvalidTerm(String),
    #[error("RDF index failure: {0}")]
    Index(String),
    #[error("SPARQL evaluation failed: {0}")]
    Evaluation(String),
}

impl From<StorageError> for QueryError {
    fn from(error: StorageError) -> Self {
        Self::Index(error.to_string())
    }
}

#[derive(Default)]
struct TextIndex {
    by_subject: HashMap<String, u32>,
    entries: Vec<Option<TextEntry>>,
    free_ids: Vec<u32>,
    postings: HashMap<[char; 3], RoaringBitmap>,
    value_ref_counts: HashMap<String, usize>,
}

struct TextEntry {
    subject: String,
    value: String,
}

impl TextIndex {
    fn insert(
        &mut self,
        subject: String,
        value: String,
        normalized_text: &mut HashMap<String, String>,
    ) -> Result<(), QueryError> {
        self.remove(&subject, normalized_text);
        let id = if let Some(id) = self.free_ids.pop() {
            id
        } else {
            let id = u32::try_from(self.entries.len())
                .map_err(|_| QueryError::Index("text subject id overflow".into()))?;
            self.entries.push(None);
            id
        };
        let normalized = normalized_text
            .entry(value.clone())
            .or_insert_with(|| normalize_text(&value))
            .clone();
        for trigram in text_trigrams(&normalized) {
            self.postings.entry(trigram).or_default().insert(id);
        }
        *self.value_ref_counts.entry(value.clone()).or_default() += 1;
        self.by_subject.insert(subject.clone(), id);
        self.entries[id as usize] = Some(TextEntry { subject, value });
        Ok(())
    }

    fn remove(&mut self, subject: &str, normalized_text: &mut HashMap<String, String>) {
        let Some(id) = self.by_subject.remove(subject) else {
            return;
        };
        let Some(entry) = self.entries[id as usize].take() else {
            return;
        };
        if let Some(normalized) = normalized_text.get(&entry.value) {
            for trigram in text_trigrams(normalized) {
                if let Some(posting) = self.postings.get_mut(&trigram) {
                    posting.remove(id);
                    if posting.is_empty() {
                        self.postings.remove(&trigram);
                    }
                }
            }
        }
        if let Some(count) = self.value_ref_counts.get_mut(&entry.value) {
            *count -= 1;
            if *count == 0 {
                self.value_ref_counts.remove(&entry.value);
                normalized_text.remove(&entry.value);
            }
        }
        self.free_ids.push(id);
    }

    /// Returns exact matching subjects after using trigram postings as a
    /// candidate filter. Short needles deliberately fall back to Oxigraph.
    fn candidates(
        &self,
        needle: &str,
        normalized_text: &HashMap<String, String>,
    ) -> Option<Vec<String>> {
        self.candidate_ids(needle, normalized_text)
            .map(|candidates| {
                candidates
                    .iter()
                    .filter_map(|id| self.subject(id).map(str::to_owned))
                    .collect()
            })
    }

    fn candidate_ids(
        &self,
        needle: &str,
        normalized_text: &HashMap<String, String>,
    ) -> Option<RoaringBitmap> {
        let normalized_needle = normalize_text(needle);
        let trigrams = text_trigrams(&normalized_needle);
        if trigrams.is_empty() {
            return None;
        }
        let mut postings = Vec::with_capacity(trigrams.len());
        for trigram in &trigrams {
            let Some(posting) = self.postings.get(trigram) else {
                return Some(RoaringBitmap::new());
            };
            postings.push(posting);
        }
        postings.sort_by_key(|posting| posting.len());
        let mut candidates = postings[0].clone();
        for posting in &postings[1..] {
            candidates &= *posting;
            if candidates.is_empty() {
                break;
            }
        }
        Some(
            candidates
                .iter()
                .filter(|id| {
                    self.entries
                        .get(*id as usize)
                        .and_then(Option::as_ref)
                        .is_some_and(|entry| {
                            normalized_text
                                .get(&entry.value)
                                .is_some_and(|value| value.contains(&normalized_needle))
                        })
                })
                .collect(),
        )
    }

    fn len(&self) -> usize {
        self.by_subject.len()
    }

    fn id(&self, subject: &str) -> Option<u32> {
        self.by_subject.get(subject).copied()
    }

    fn subject(&self, id: u32) -> Option<&str> {
        self.entries
            .get(id as usize)?
            .as_ref()
            .map(|entry| entry.subject.as_str())
    }
}

fn text_trigrams(value: &str) -> BTreeSet<[char; 3]> {
    let characters = value.chars().collect::<Vec<_>>();
    characters
        .windows(3)
        .map(|window| [window[0], window[1], window[2]])
        .collect()
}

#[derive(Debug, Clone, Copy)]
struct TotalF64(f64);

impl PartialEq for TotalF64 {
    fn eq(&self, other: &Self) -> bool {
        self.0.to_bits() == other.0.to_bits()
    }
}

impl Eq for TotalF64 {}

impl PartialOrd for TotalF64 {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for TotalF64 {
    fn cmp(&self, other: &Self) -> Ordering {
        self.0.total_cmp(&other.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum OrderedValue {
    Number(TotalF64),
    Integer(i64),
    Date(String),
}

#[derive(Default)]
struct PropertyIndex {
    presence: HashMap<String, RoaringBitmap>,
    exact: HashMap<(String, Term), RoaringBitmap>,
    ordered: HashMap<String, BTreeMap<OrderedValue, RoaringBitmap>>,
}

impl PropertyIndex {
    fn insert_subject(&mut self, id: u32, triples: &HashSet<Triple>) {
        for triple in triples {
            let predicate = triple.predicate.as_str();
            if !indexed_predicate(predicate) {
                continue;
            }
            let predicate = predicate.to_owned();
            let value = triple.object.clone();
            self.presence
                .entry(predicate.clone())
                .or_default()
                .insert(id);
            self.exact
                .entry((predicate.clone(), value.clone()))
                .or_default()
                .insert(id);
            if let Some(value) = ordered_value(&value) {
                self.ordered
                    .entry(predicate.clone())
                    .or_default()
                    .entry(value)
                    .or_default()
                    .insert(id);
            }
        }
    }

    fn remove_subject(&mut self, id: u32, triples: &HashSet<Triple>) {
        for triple in triples {
            let predicate = triple.predicate.as_str();
            if !indexed_predicate(predicate) {
                continue;
            }
            let predicate = predicate.to_owned();
            let value = triple.object.clone();
            remove_from_posting(&mut self.presence, &predicate, id);
            remove_from_posting(&mut self.exact, &(predicate.clone(), value.clone()), id);
            if let Some(ordered) = ordered_value(&value)
                && let Some(values) = self.ordered.get_mut(&predicate)
            {
                if let Some(posting) = values.get_mut(&ordered) {
                    posting.remove(id);
                    if posting.is_empty() {
                        values.remove(&ordered);
                    }
                }
                if values.is_empty() {
                    self.ordered.remove(&predicate);
                }
            }
        }
    }

    fn exact(&self, predicate: &str, value: &Term) -> RoaringBitmap {
        self.exact
            .get(&(predicate.to_owned(), value.clone()))
            .cloned()
            .unwrap_or_default()
    }

    fn presence(&self, predicate: &str) -> RoaringBitmap {
        self.presence.get(predicate).cloned().unwrap_or_default()
    }

    fn compare(
        &self,
        predicate: &str,
        operator: Comparison,
        bound: &OrderedValue,
    ) -> RoaringBitmap {
        let Some(values) = self.ordered.get(predicate) else {
            return RoaringBitmap::new();
        };
        let mut matches = RoaringBitmap::new();
        for (value, posting) in values {
            let ordering = value.cmp(bound);
            let accepted = match operator {
                Comparison::Equal => ordering == Ordering::Equal,
                Comparison::Less => ordering == Ordering::Less,
                Comparison::LessOrEqual => ordering != Ordering::Greater,
                Comparison::Greater => ordering == Ordering::Greater,
                Comparison::GreaterOrEqual => ordering != Ordering::Less,
            };
            if accepted {
                matches |= posting;
            }
        }
        matches
    }

    fn has_ordered(&self, predicate: &str) -> bool {
        self.ordered.contains_key(predicate)
    }

    fn ordered_subjects(
        &self,
        predicate: &str,
        candidates: &RoaringBitmap,
        descending: bool,
        limit: usize,
        text_index: &TextIndex,
    ) -> Vec<String> {
        let Some(values) = self.ordered.get(predicate) else {
            return Vec::new();
        };
        let mut subjects = Vec::new();
        let mut seen = RoaringBitmap::new();
        {
            let mut append = |posting: &RoaringBitmap| {
                let matching = (posting & candidates) - &seen;
                let mut tied = matching
                    .iter()
                    .filter_map(|id| text_index.subject(id).map(|subject| (subject, id)))
                    .collect::<Vec<_>>();
                tied.sort_by(|left, right| left.0.cmp(right.0));
                for (subject, id) in tied {
                    seen.insert(id);
                    subjects.push(subject.to_owned());
                    if subjects.len() == limit {
                        return true;
                    }
                }
                false
            };
            if descending {
                for posting in values.values().rev() {
                    if append(posting) {
                        break;
                    }
                }
            } else {
                for posting in values.values() {
                    if append(posting) {
                        break;
                    }
                }
            }
        }
        if subjects.len() < limit {
            let missing = candidates - &seen;
            let mut missing = missing
                .iter()
                .filter_map(|id| text_index.subject(id))
                .collect::<Vec<_>>();
            missing.sort();
            subjects.extend(
                missing
                    .into_iter()
                    .take(limit - subjects.len())
                    .map(str::to_owned),
            );
        }
        subjects
    }
}

#[derive(Debug, Clone, Copy)]
enum Comparison {
    Equal,
    Less,
    LessOrEqual,
    Greater,
    GreaterOrEqual,
}

impl Comparison {
    fn reverse(self) -> Self {
        match self {
            Self::Equal => Self::Equal,
            Self::Less => Self::Greater,
            Self::LessOrEqual => Self::GreaterOrEqual,
            Self::Greater => Self::Less,
            Self::GreaterOrEqual => Self::LessOrEqual,
        }
    }
}

fn remove_from_posting<K: Eq + std::hash::Hash + Clone>(
    postings: &mut HashMap<K, RoaringBitmap>,
    key: &K,
    id: u32,
) {
    if let Some(posting) = postings.get_mut(key) {
        posting.remove(id);
        if posting.is_empty() {
            postings.remove(key);
        }
    }
}

fn indexed_predicate(predicate: &str) -> bool {
    predicate != NEO_CONTENT && predicate != NEO_NAME
}

fn ordered_value(value: &Term) -> Option<OrderedValue> {
    let Term::Literal(value) = value else {
        return None;
    };
    match value.datatype().as_str() {
        datatype if datatype == xsd::DOUBLE.as_str() => value
            .value()
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite())
            .map(TotalF64)
            .map(OrderedValue::Number),
        datatype if datatype == xsd::INTEGER.as_str() => {
            value.value().parse().ok().map(OrderedValue::Integer)
        }
        datatype if datatype == xsd::DATE.as_str() => {
            Some(OrderedValue::Date(value.value().to_owned()))
        }
        _ => None,
    }
}

/// One open graph's derived RDF index. Oxigraph's in-memory store provides the
/// dictionary and SPO/POS/OSP-family indexes. The compact page ledger names
/// subjects to retract and replace atomically without duplicating their triples.
pub struct GraphIndex {
    graph_id: GraphId,
    store: Store,
    entity_refs: HashMap<String, QueryEntityRef>,
    owner_entities: HashMap<OutlineOwner, BTreeSet<String>>,
    text_index: TextIndex,
    property_index: PropertyIndex,
    normalized_text: Arc<HashMap<String, String>>,
    triple_count: usize,
    revision: u64,
    frontier: String,
}

impl GraphIndex {
    pub fn new(snapshot: &GraphSnapshot) -> Result<Self, QueryError> {
        let frontier = snapshot_fingerprint(snapshot)?;
        Self::new_at(snapshot, frontier)
    }

    pub fn new_at(snapshot: &GraphSnapshot, frontier: String) -> Result<Self, QueryError> {
        let units = snapshot
            .tags
            .iter()
            .cloned()
            .map(IndexUnit::Tag)
            .chain(snapshot.pages.iter().cloned().map(IndexUnit::Page))
            .map(Ok::<_, String>);
        Self::from_units(snapshot.graph_id.clone(), frontier, units)
    }

    /// Builds an index while retaining at most one projected page outside the
    /// RDF store and its bounded bulk-loader buffers.
    pub fn from_units<E>(
        graph_id: GraphId,
        frontier: String,
        units: impl IntoIterator<Item = Result<IndexUnit, E>>,
    ) -> Result<Self, QueryError>
    where
        E: std::fmt::Display,
    {
        let store = Store::new().map_err(index_error)?;
        let units = units
            .into_iter()
            .map(|unit| unit.map_err(|error| QueryError::Index(error.to_string())));
        let mut projected = ProjectionStream::new(graph_id.clone(), units);
        {
            let mut loader = store
                .bulk_loader()
                .with_num_threads(1)
                .with_max_memory_size_in_megabytes(256);
            loader.load_ok_quads::<QueryError, QueryError>(&mut projected)?;
            loader.commit().map_err(index_error)?;
        }
        let projected = projected.finish();
        Ok(Self {
            graph_id,
            store,
            entity_refs: projected.entity_refs,
            owner_entities: projected.owner_entities,
            text_index: projected.text_index,
            property_index: projected.property_index,
            normalized_text: Arc::new(projected.normalized_text),
            triple_count: projected.triple_count,
            revision: 1,
            frontier,
        })
    }

    /// Rebuilds from an immutable domain snapshot when its frontier changed.
    pub fn refresh(&mut self, snapshot: &GraphSnapshot) -> Result<bool, QueryError> {
        let frontier = snapshot_fingerprint(snapshot)?;
        self.refresh_at(snapshot, frontier)
    }

    pub fn refresh_at(
        &mut self,
        snapshot: &GraphSnapshot,
        next_frontier: String,
    ) -> Result<bool, QueryError> {
        if snapshot.graph_id != self.graph_id {
            return Err(QueryError::Index(
                "snapshot belongs to another graph".into(),
            ));
        }
        if self.frontier == next_frontier {
            return Ok(false);
        }
        let units = snapshot
            .tags
            .iter()
            .cloned()
            .map(IndexUnit::Tag)
            .chain(snapshot.pages.iter().cloned().map(IndexUnit::Page))
            .map(Ok::<_, String>);
        self.rebuild_from_units(snapshot.graph_id.clone(), next_frontier, units)
    }

    pub fn rebuild_from_units<E>(
        &mut self,
        graph_id: GraphId,
        next_frontier: String,
        units: impl IntoIterator<Item = Result<IndexUnit, E>>,
    ) -> Result<bool, QueryError>
    where
        E: std::fmt::Display,
    {
        if graph_id != self.graph_id {
            return Err(QueryError::Index(
                "projection units belong to another graph".into(),
            ));
        }
        if self.frontier == next_frontier {
            return Ok(false);
        }
        let revision = self.revision.saturating_add(1);
        let mut rebuilt = Self::from_units(graph_id, next_frontier, units)?;
        rebuilt.revision = revision;
        *self = rebuilt;
        Ok(true)
    }

    /// Applies page/tag replacements without walking or cloning the rest of the
    /// graph. One store transaction remains the publication boundary.
    pub fn apply_delta(&mut self, delta: IndexDelta) -> Result<bool, QueryError> {
        let mut projected = Projection::default();
        let mut replaced = BTreeSet::new();
        let mut owners = delta
            .removed_pages
            .into_iter()
            .map(|id| OutlineOwner::Page { id })
            .chain(
                delta
                    .removed_tags
                    .into_iter()
                    .map(|id| OutlineOwner::Tag { id }),
            )
            .collect::<BTreeSet<_>>();
        for page in &delta.pages {
            owners.insert(OutlineOwner::Page {
                id: page.id.clone(),
            });
            project_page(&mut projected, &self.graph_id, page)?;
        }
        for tag in &delta.tags {
            owners.insert(OutlineOwner::Tag { id: tag.id.clone() });
            project_tag(&mut projected, &self.graph_id, tag)?;
        }
        for owner in &owners {
            if let Some(keys) = self.owner_entities.get(owner) {
                replaced.extend(keys.iter().cloned());
            }
            if let Some(keys) = projected.owner_entities.get(owner) {
                replaced.extend(keys.iter().cloned());
            }
        }

        let mut previous = BTreeMap::new();
        for key in &replaced {
            let triples = triples_for_subject(&self.store, key)?;
            if !triples.is_empty() {
                previous.insert(key.clone(), triples);
            }
        }
        let triples_changed = replaced
            .iter()
            .any(|key| previous.get(key) != projected.entities.get(key));
        if !triples_changed && self.frontier == delta.frontier {
            return Ok(false);
        }

        let next_triple_count = if triples_changed {
            let removed = previous.values().map(HashSet::len).sum::<usize>();
            let inserted = projected.entities.values().map(HashSet::len).sum::<usize>();
            self.triple_count
                .checked_sub(removed)
                .and_then(|count| count.checked_add(inserted))
                .ok_or_else(|| QueryError::Index("triple count overflow".into()))?
        } else {
            self.triple_count
        };
        if triples_changed {
            let mut transaction = self.store.start_transaction().map_err(index_error)?;
            for key in &replaced {
                write_entity_diff(
                    &mut transaction,
                    previous.get(key),
                    projected.entities.get(key),
                );
            }
            transaction.commit().map_err(index_error)?;
        }
        self.triple_count = next_triple_count;

        for key in &replaced {
            self.entity_refs.remove(key);
        }
        for (key, entity_ref) in projected.entity_refs {
            self.entity_refs.insert(key, entity_ref);
        }
        if triples_changed {
            let normalized_text = Arc::make_mut(&mut self.normalized_text);
            for key in &replaced {
                if let (Some(id), Some(triples)) = (self.text_index.id(key), previous.get(key)) {
                    self.property_index.remove_subject(id, triples);
                }
                self.text_index.remove(key, normalized_text);
            }
            for (key, value) in projected.entity_text {
                self.text_index.insert(key, value, normalized_text)?;
            }
            for (key, triples) in &projected.entities {
                let id = self.text_index.id(key).ok_or_else(|| {
                    QueryError::Index("projected entity has no text subject".into())
                })?;
                self.property_index.insert_subject(id, triples);
            }
        }
        for owner in owners {
            self.owner_entities.remove(&owner);
            if let Some(keys) = projected.owner_entities.remove(&owner) {
                self.owner_entities.insert(owner, keys);
            }
        }
        self.frontier = delta.frontier;
        self.revision = self.revision.saturating_add(1);
        Ok(true)
    }

    pub fn execute(&self, request: QueryRequest) -> Result<QueryResult, QueryError> {
        let ceiling = QueryBudget::default();
        let budget = QueryBudget {
            max_source_bytes: request
                .budget
                .max_source_bytes
                .min(ceiling.max_source_bytes),
            max_algebra_operators: request
                .budget
                .max_algebra_operators
                .min(ceiling.max_algebra_operators),
            max_bindings: request.budget.max_bindings.min(ceiling.max_bindings),
            max_rows: request.budget.max_rows.min(ceiling.max_rows),
        };
        if request.language != QUERY_LANGUAGE {
            return Err(QueryError::UnsupportedLanguage(request.language));
        }
        if request.source.len() > budget.max_source_bytes {
            return Err(QueryError::SourceBudget);
        }
        if request.bindings.len() > budget.max_bindings {
            return Err(QueryError::BindingBudget);
        }

        let mut query = SparqlParser::new()
            .parse_query(&request.source)
            .map_err(|error| QueryError::Syntax(error.to_string()))?;
        let bindings = request.bindings;
        let text_calls = validate_query(&query, budget.max_algebra_operators, &bindings)?;
        let top_k_subjects = select_top_k_candidates(
            &query,
            &bindings,
            &self.text_index,
            &self.property_index,
            &self.normalized_text,
        )?;
        if top_k_subjects.is_none() {
            inject_text_candidates(
                &mut query,
                &bindings,
                &self.text_index,
                &self.normalized_text,
            )?;
        }
        let normalized_needles = text_calls
            .iter()
            .filter_map(|call| resolve_text_needle(call, &bindings))
            .map(|needle| {
                let normalized = normalize_text(&needle);
                (needle, normalized)
            })
            .collect::<HashMap<_, _>>();
        inject_query_bindings(&mut query, bindings)?;
        let candidate_dataset = top_k_subjects
            .map(|subjects| self.candidate_dataset(subjects))
            .transpose()?;

        let normalized_text = self.normalized_text.clone();
        let matcher = NamedNode::new(MATCHES_TEXT).map_err(term_error)?;
        let prepared = SparqlEvaluator::new()
            .with_custom_function(matcher, move |arguments| {
                let [Term::Literal(content), Term::Literal(needle)] = arguments else {
                    return None;
                };
                let fallback;
                let normalized_needle = if let Some(needle) = normalized_needles.get(needle.value())
                {
                    needle.as_str()
                } else {
                    fallback = normalize_text(needle.value());
                    &fallback
                };
                let matches = normalized_text.get(content.value()).map_or_else(
                    || normalize_text(content.value()).contains(normalized_needle),
                    |normalized| normalized.contains(normalized_needle),
                );
                Some(Literal::from(matches).into())
            })
            .for_query(query);

        let evaluated = if let Some(dataset) = candidate_dataset.as_ref() {
            prepared.on_queryable_dataset(dataset).execute()
        } else {
            prepared.on_store(&self.store).execute()
        }
        .map_err(|error| QueryError::Evaluation(error.to_string()))?;

        match evaluated {
            QueryResults::Boolean(value) => Ok(QueryResult::Ask {
                value,
                revision: self.revision,
                frontier: self.frontier.clone(),
            }),
            QueryResults::Solutions(mut solutions) => {
                let variables = solutions
                    .variables()
                    .iter()
                    .map(|variable| variable.as_str().to_owned())
                    .collect::<Vec<_>>();
                let mut rows = Vec::new();
                for solution in &mut solutions {
                    if rows.len() >= budget.max_rows {
                        return Err(QueryError::RowBudget);
                    }
                    let solution =
                        solution.map_err(|error| QueryError::Evaluation(error.to_string()))?;
                    let mut row = BTreeMap::new();
                    for variable in &variables {
                        if let Some(term) = solution.get(variable.as_str()) {
                            row.insert(variable.clone(), self.map_ox_term(term)?);
                        }
                    }
                    rows.push(row);
                }
                Ok(QueryResult::Select {
                    variables,
                    rows,
                    revision: self.revision,
                    frontier: self.frontier.clone(),
                })
            }
            QueryResults::Graph(_) => Err(QueryError::Disallowed(
                "CONSTRUCT and DESCRIBE are not supported".into(),
            )),
        }
    }

    pub fn frontier(&self) -> &str {
        &self.frontier
    }

    pub fn triple_count(&self) -> usize {
        self.triple_count
    }

    pub fn semantic_triples(&self) -> Vec<String> {
        let mut triples = self
            .store
            .iter()
            .map(|quad| quad.expect("in-memory RDF store should remain readable"))
            .map(|quad| Triple::new(quad.subject, quad.predicate, quad.object).to_string())
            .collect::<Vec<_>>();
        triples.sort();
        triples
    }

    fn candidate_dataset(&self, subjects: Vec<String>) -> Result<Dataset, QueryError> {
        let mut dataset = Dataset::new();
        let mut pending = subjects
            .into_iter()
            .map(|subject| (subject, 0_u8))
            .collect::<VecDeque<_>>();
        let mut visited = HashSet::new();
        while let Some((subject, depth)) = pending.pop_front() {
            if !visited.insert(subject.clone()) {
                continue;
            }
            let subject = NamedNode::new(subject).map_err(term_error)?;
            for quad in self.store.quads_for_pattern(
                Some(subject.as_ref().into()),
                None,
                None,
                Some(GraphNameRef::DefaultGraph),
            ) {
                let quad = quad.map_err(index_error)?;
                if depth < 2
                    && let Term::NamedNode(object) = &quad.object
                    && object.as_str().starts_with(ENTITY_NS)
                {
                    pending.push_back((object.as_str().to_owned(), depth + 1));
                }
                dataset.insert(&quad);
            }
        }
        Ok(dataset)
    }

    fn map_ox_term(&self, term: &Term) -> Result<RdfTerm, QueryError> {
        match term {
            Term::NamedNode(node) => Ok(RdfTerm::Iri {
                value: node.as_str().to_owned(),
                entity: self.entity_refs.get(node.as_str()).cloned(),
            }),
            Term::Literal(literal) => Ok(RdfTerm::Literal {
                value: literal.value().to_owned(),
                datatype: literal.datatype().as_str().to_owned(),
                language: literal.language().map(str::to_owned),
            }),
            Term::BlankNode(_) => Err(QueryError::InvalidTerm(
                "blank nodes are not part of the Neoseq projection".into(),
            )),
        }
    }
}

#[derive(Default)]
struct Projection {
    entities: BTreeMap<String, HashSet<Triple>>,
    entity_refs: BTreeMap<String, QueryEntityRef>,
    owner_entities: BTreeMap<OutlineOwner, BTreeSet<String>>,
    entity_text: BTreeMap<String, String>,
}

struct ProjectionStream<I> {
    graph_id: GraphId,
    units: I,
    pending: std::vec::IntoIter<Quad>,
    entity_refs: HashMap<String, QueryEntityRef>,
    owner_entities: HashMap<OutlineOwner, BTreeSet<String>>,
    text_index: TextIndex,
    property_index: PropertyIndex,
    normalized_text: HashMap<String, String>,
    triple_count: usize,
}

struct ProjectionBuild {
    entity_refs: HashMap<String, QueryEntityRef>,
    owner_entities: HashMap<OutlineOwner, BTreeSet<String>>,
    text_index: TextIndex,
    property_index: PropertyIndex,
    normalized_text: HashMap<String, String>,
    triple_count: usize,
}

impl<I> ProjectionStream<I>
where
    I: Iterator<Item = Result<IndexUnit, QueryError>>,
{
    fn new(graph_id: GraphId, units: I) -> Self {
        Self {
            graph_id,
            units,
            pending: Vec::new().into_iter(),
            entity_refs: HashMap::new(),
            owner_entities: HashMap::new(),
            text_index: TextIndex::default(),
            property_index: PropertyIndex::default(),
            normalized_text: HashMap::new(),
            triple_count: 0,
        }
    }

    fn finish(self) -> ProjectionBuild {
        ProjectionBuild {
            entity_refs: self.entity_refs,
            owner_entities: self.owner_entities,
            text_index: self.text_index,
            property_index: self.property_index,
            normalized_text: self.normalized_text,
            triple_count: self.triple_count,
        }
    }

    fn project_unit(&mut self, unit: IndexUnit) -> Result<(), QueryError> {
        let mut projected = Projection::default();
        let owner = match unit {
            IndexUnit::Page(page) => {
                let owner = OutlineOwner::Page {
                    id: page.id.clone(),
                };
                project_page(&mut projected, &self.graph_id, &page)?;
                owner
            }
            IndexUnit::Tag(tag) => {
                let owner = OutlineOwner::Tag { id: tag.id.clone() };
                project_tag(&mut projected, &self.graph_id, &tag)?;
                owner
            }
        };
        if projected
            .entity_refs
            .keys()
            .any(|key| self.entity_refs.contains_key(key))
        {
            return Err(QueryError::Index(
                "projection contains a duplicate entity subject".into(),
            ));
        }

        let keys = projected.owner_entities.remove(&owner).unwrap_or_default();
        self.owner_entities.insert(owner, keys);
        for (key, value) in projected.entity_text {
            self.text_index
                .insert(key, value, &mut self.normalized_text)?;
        }
        for (key, triples) in &projected.entities {
            let id = self
                .text_index
                .id(key)
                .ok_or_else(|| QueryError::Index("projected entity has no text subject".into()))?;
            self.property_index.insert_subject(id, triples);
        }
        self.entity_refs.extend(projected.entity_refs);
        self.triple_count = self
            .triple_count
            .checked_add(projected.entities.values().map(HashSet::len).sum())
            .ok_or_else(|| QueryError::Index("triple count overflow".into()))?;
        self.pending = projected
            .entities
            .into_values()
            .flatten()
            .map(|triple| {
                Quad::new(
                    triple.subject,
                    triple.predicate,
                    triple.object,
                    GraphNameRef::DefaultGraph,
                )
            })
            .collect::<Vec<_>>()
            .into_iter();
        Ok(())
    }
}

impl<I> Iterator for ProjectionStream<I>
where
    I: Iterator<Item = Result<IndexUnit, QueryError>>,
{
    type Item = Result<Quad, QueryError>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if let Some(quad) = self.pending.next() {
                return Some(Ok(quad));
            }
            let unit = match self.units.next()? {
                Ok(unit) => unit,
                Err(error) => return Some(Err(error)),
            };
            if let Err(error) = self.project_unit(unit) {
                return Some(Err(error));
            }
        }
    }
}

fn project_page(
    projection: &mut Projection,
    graph_id: &GraphId,
    page: &PageSnapshot,
) -> Result<(), QueryError> {
    let page_iri = entity_iri(graph_id, "page", page.id.as_str())?;
    let key = page_iri.as_str().to_owned();
    projection.entity_refs.insert(
        key.clone(),
        QueryEntityRef::Page {
            id: page.id.to_string(),
        },
    );
    let mut triples = HashSet::new();
    triples.insert(Triple::new(
        page_iri.clone(),
        rdf::TYPE,
        named(&format!("{NEO_NS}Page"))?,
    ));
    triples.insert(Triple::new(
        page_iri.clone(),
        named_ref("content")?,
        Literal::new_simple_literal(&page.title),
    ));
    add_properties(
        &mut triples,
        &page_iri,
        &page.properties,
        PROPERTY_NS,
        graph_id,
    )?;
    add_tags(&mut triples, &page_iri, &page.tags, graph_id)?;
    projection
        .owner_entities
        .entry(OutlineOwner::Page {
            id: page.id.clone(),
        })
        .or_default()
        .insert(key.clone());
    projection
        .entity_text
        .insert(key.clone(), page.title.clone());
    projection.entities.insert(key, triples);
    let owner = OutlineOwner::Page {
        id: page.id.clone(),
    };
    for (index, block) in page.blocks.iter().enumerate() {
        project_block(projection, graph_id, &owner, &page_iri, block, index)?;
    }
    Ok(())
}

fn project_tag(
    projection: &mut Projection,
    graph_id: &GraphId,
    tag: &TagSnapshot,
) -> Result<(), QueryError> {
    let tag_iri = entity_iri(graph_id, "tag", tag.id.as_str())?;
    let key = tag_iri.as_str().to_owned();
    projection.entity_refs.insert(
        key.clone(),
        QueryEntityRef::Tag {
            id: tag.id.to_string(),
        },
    );
    let mut triples = HashSet::new();
    triples.insert(Triple::new(
        tag_iri.clone(),
        rdf::TYPE,
        named(&format!("{NEO_NS}Tag"))?,
    ));
    triples.insert(Triple::new(
        tag_iri.clone(),
        named_ref("name")?,
        Literal::new_simple_literal(&tag.name),
    ));
    add_properties(
        &mut triples,
        &tag_iri,
        &tag.properties,
        PROPERTY_NS,
        graph_id,
    )?;
    add_properties(
        &mut triples,
        &tag_iri,
        &tag.defaults,
        DEFAULT_PROPERTY_NS,
        graph_id,
    )?;
    projection
        .owner_entities
        .entry(OutlineOwner::Tag { id: tag.id.clone() })
        .or_default()
        .insert(key.clone());
    projection.entity_text.insert(key.clone(), tag.name.clone());
    projection.entities.insert(key, triples);
    let owner = OutlineOwner::Tag { id: tag.id.clone() };
    for (index, block) in tag.blocks.iter().enumerate() {
        project_block(projection, graph_id, &owner, &tag_iri, block, index)?;
    }
    Ok(())
}

fn project_block(
    projection: &mut Projection,
    graph_id: &GraphId,
    owner: &OutlineOwner,
    parent: &NamedNode,
    block: &BlockSnapshot,
    sibling_index: usize,
) -> Result<(), QueryError> {
    let block_iri = entity_iri(graph_id, "block", block.id.as_str())?;
    let owner_iri = match owner {
        OutlineOwner::Page { id } => entity_iri(graph_id, "page", id.as_str())?,
        OutlineOwner::Tag { id } => entity_iri(graph_id, "tag", id.as_str())?,
    };
    let key = block_iri.as_str().to_owned();
    projection.entity_refs.insert(
        key.clone(),
        QueryEntityRef::Block {
            owner: owner.clone(),
            id: block.id.to_string(),
        },
    );
    let mut triples = HashSet::new();
    triples.insert(Triple::new(
        block_iri.clone(),
        rdf::TYPE,
        named(&format!("{NEO_NS}Block"))?,
    ));
    triples.insert(Triple::new(
        block_iri.clone(),
        named_ref("content")?,
        Literal::new_simple_literal(&block.markdown),
    ));
    triples.insert(Triple::new(
        block_iri.clone(),
        named_ref("owner")?,
        owner_iri.clone(),
    ));
    if matches!(owner, OutlineOwner::Page { .. }) {
        triples.insert(Triple::new(
            block_iri.clone(),
            named_ref("page")?,
            owner_iri,
        ));
    }
    triples.insert(Triple::new(
        block_iri.clone(),
        named_ref("parent")?,
        parent.clone(),
    ));
    triples.insert(Triple::new(
        block_iri.clone(),
        named_ref("siblingIndex")?,
        Literal::from(sibling_index as i64),
    ));
    add_properties(
        &mut triples,
        &block_iri,
        &block.properties,
        PROPERTY_NS,
        graph_id,
    )?;
    add_tags(&mut triples, &block_iri, &block.tags, graph_id)?;
    projection
        .owner_entities
        .entry(owner.clone())
        .or_default()
        .insert(key.clone());
    projection
        .entity_text
        .insert(key.clone(), block.markdown.clone());
    projection.entities.insert(key, triples);
    for (index, child) in block.children.iter().enumerate() {
        project_block(projection, graph_id, owner, &block_iri, child, index)?;
    }
    Ok(())
}

fn add_tags(
    triples: &mut HashSet<Triple>,
    subject: &NamedNode,
    tags: &[TagId],
    graph_id: &GraphId,
) -> Result<(), QueryError> {
    for tag in tags {
        triples.insert(Triple::new(
            subject.clone(),
            named_ref("tag")?,
            entity_iri(graph_id, "tag", tag.as_str())?,
        ));
    }
    Ok(())
}

fn add_properties(
    triples: &mut HashSet<Triple>,
    subject: &NamedNode,
    bag: &PropertyBag,
    namespace: &str,
    graph_id: &GraphId,
) -> Result<(), QueryError> {
    let presence = if namespace == DEFAULT_PROPERTY_NS {
        named_ref("hasDefaultProperty")?
    } else {
        named_ref("hasProperty")?
    };
    for field in bag {
        triples.insert(Triple::new(
            subject.clone(),
            presence.clone(),
            named(&format!(
                "{PROPERTY_KEY_NS}{}",
                encode_component(field.key.as_str())
            ))?,
        ));
        let predicate = named(&format!(
            "{namespace}{}",
            encode_component(field.key.as_str())
        ))?;
        for property_value in &field.values {
            let value: Term = match property_value {
                PropertyValue::Number(value) => Literal::from(*value).into(),
                PropertyValue::String(value) => Literal::new_simple_literal(value).into(),
                PropertyValue::Page(page_id) => {
                    entity_iri(graph_id, "page", page_id.as_str())?.into()
                }
                PropertyValue::Checkbox(value) => Literal::from(*value).into(),
                PropertyValue::Date(value) => {
                    Literal::new_typed_literal(value.as_str(), xsd::DATE).into()
                }
                // Document properties are canonical feature configuration, not
                // scalar graph facts. Their field marker above remains
                // queryable, while each schema owns any future semantic
                // projection explicitly.
                PropertyValue::Document(_) | PropertyValue::UnsupportedDocument(_) => continue,
            };
            triples.insert(Triple::new(subject.clone(), predicate.clone(), value));
        }
    }
    Ok(())
}

#[derive(Clone)]
struct TextCall {
    content: Variable,
    needle: TextNeedle,
}

#[derive(Clone)]
enum TextNeedle {
    Literal(String),
    Binding(Variable),
}

fn validate_query(
    query: &Query,
    max_operators: usize,
    bindings: &BTreeMap<String, RdfTerm>,
) -> Result<Vec<TextCall>, QueryError> {
    let sse = query.to_sse();
    let (dataset, pattern) = match query {
        Query::Select {
            dataset, pattern, ..
        }
        | Query::Ask {
            dataset, pattern, ..
        } => (dataset, pattern),
        Query::Construct { .. } => {
            return Err(QueryError::Disallowed("CONSTRUCT".into()));
        }
        Query::Describe { .. } => {
            return Err(QueryError::Disallowed("DESCRIBE".into()));
        }
    };
    if dataset.is_some() {
        return Err(QueryError::Disallowed("FROM/FROM NAMED".into()));
    }
    if sse.contains("(service ") {
        return Err(QueryError::Disallowed("SERVICE".into()));
    }
    if sse.contains("(graph ") {
        return Err(QueryError::Disallowed("GRAPH".into()));
    }
    if sse.bytes().filter(|byte| *byte == b'(').count() > max_operators {
        return Err(QueryError::AlgebraBudget);
    }
    let mut calls = Vec::new();
    collect_text_calls(pattern, bindings, &mut calls)?;
    for call in &calls {
        if !pattern_has_text_object(pattern, &call.content) {
            return Err(QueryError::Disallowed(
                "neo:matchesText first argument must be the object of neo:content or neo:name"
                    .into(),
            ));
        }
    }
    Ok(calls)
}

fn collect_text_calls(
    pattern: &GraphPattern,
    bindings: &BTreeMap<String, RdfTerm>,
    calls: &mut Vec<TextCall>,
) -> Result<(), QueryError> {
    match pattern {
        GraphPattern::Bgp { .. } | GraphPattern::Path { .. } | GraphPattern::Values { .. } => {}
        GraphPattern::Join { left, right }
        | GraphPattern::Lateral { left, right }
        | GraphPattern::Union { left, right }
        | GraphPattern::Minus { left, right } => {
            collect_text_calls(left, bindings, calls)?;
            collect_text_calls(right, bindings, calls)?;
        }
        GraphPattern::LeftJoin {
            left,
            right,
            expression,
        } => {
            collect_text_calls(left, bindings, calls)?;
            collect_text_calls(right, bindings, calls)?;
            if let Some(expression) = expression {
                collect_text_calls_in_expression(expression, bindings, calls)?;
            }
        }
        GraphPattern::Filter { expr, inner } => {
            collect_text_calls(inner, bindings, calls)?;
            collect_text_calls_in_expression(expr, bindings, calls)?;
        }
        GraphPattern::Graph { inner, .. }
        | GraphPattern::Service { inner, .. }
        | GraphPattern::Project { inner, .. }
        | GraphPattern::Distinct { inner }
        | GraphPattern::Reduced { inner }
        | GraphPattern::Slice { inner, .. } => collect_text_calls(inner, bindings, calls)?,
        GraphPattern::Extend {
            inner, expression, ..
        } => {
            collect_text_calls(inner, bindings, calls)?;
            collect_text_calls_in_expression(expression, bindings, calls)?;
        }
        GraphPattern::OrderBy { inner, expression } => {
            collect_text_calls(inner, bindings, calls)?;
            for order in expression {
                let expression = match order {
                    spargebra::algebra::OrderExpression::Asc(expression)
                    | spargebra::algebra::OrderExpression::Desc(expression) => expression,
                };
                collect_text_calls_in_expression(expression, bindings, calls)?;
            }
        }
        GraphPattern::Group {
            inner, aggregates, ..
        } => {
            collect_text_calls(inner, bindings, calls)?;
            for (_, aggregate) in aggregates {
                if let spargebra::algebra::AggregateExpression::FunctionCall { expr, .. } =
                    aggregate
                {
                    collect_text_calls_in_expression(expr, bindings, calls)?;
                }
            }
        }
    }
    Ok(())
}

fn collect_text_calls_in_expression(
    expression: &Expression,
    bindings: &BTreeMap<String, RdfTerm>,
    calls: &mut Vec<TextCall>,
) -> Result<(), QueryError> {
    match expression {
        Expression::FunctionCall(Function::Custom(function), arguments)
            if function.as_str() == MATCHES_TEXT =>
        {
            let [Expression::Variable(content), needle] = arguments.as_slice() else {
                return Err(QueryError::Disallowed(
                    "neo:matchesText requires a content variable and a literal or bound needle"
                        .into(),
                ));
            };
            let needle = match needle {
                Expression::Literal(needle) => TextNeedle::Literal(needle.value().to_owned()),
                Expression::Variable(variable) if binding_literal(variable, bindings).is_some() => {
                    TextNeedle::Binding(variable.clone())
                }
                _ => {
                    return Err(QueryError::Disallowed(
                        "neo:matchesText needle must be a literal or bound literal parameter"
                            .into(),
                    ));
                }
            };
            calls.push(TextCall {
                content: content.clone(),
                needle,
            });
        }
        Expression::Exists(pattern) => collect_text_calls(pattern, bindings, calls)?,
        Expression::Or(left, right)
        | Expression::And(left, right)
        | Expression::Equal(left, right)
        | Expression::SameTerm(left, right)
        | Expression::Greater(left, right)
        | Expression::GreaterOrEqual(left, right)
        | Expression::Less(left, right)
        | Expression::LessOrEqual(left, right)
        | Expression::Add(left, right)
        | Expression::Subtract(left, right)
        | Expression::Multiply(left, right)
        | Expression::Divide(left, right) => {
            collect_text_calls_in_expression(left, bindings, calls)?;
            collect_text_calls_in_expression(right, bindings, calls)?;
        }
        Expression::UnaryPlus(inner) | Expression::UnaryMinus(inner) | Expression::Not(inner) => {
            collect_text_calls_in_expression(inner, bindings, calls)?
        }
        Expression::If(condition, left, right) => {
            collect_text_calls_in_expression(condition, bindings, calls)?;
            collect_text_calls_in_expression(left, bindings, calls)?;
            collect_text_calls_in_expression(right, bindings, calls)?;
        }
        Expression::In(left, right) => {
            collect_text_calls_in_expression(left, bindings, calls)?;
            for expression in right {
                collect_text_calls_in_expression(expression, bindings, calls)?;
            }
        }
        Expression::Coalesce(expressions) | Expression::FunctionCall(_, expressions) => {
            for expression in expressions {
                collect_text_calls_in_expression(expression, bindings, calls)?;
            }
        }
        Expression::NamedNode(_)
        | Expression::Literal(_)
        | Expression::Variable(_)
        | Expression::Bound(_) => {}
    }
    Ok(())
}

fn binding_literal<'a>(
    variable: &Variable,
    bindings: &'a BTreeMap<String, RdfTerm>,
) -> Option<&'a str> {
    bindings.iter().find_map(|(name, term)| {
        if name.trim_start_matches(['?', '$']) != variable.as_str() {
            return None;
        }
        match term {
            RdfTerm::Literal { value, .. } => Some(value.as_str()),
            RdfTerm::Iri { .. } => None,
        }
    })
}

fn resolve_text_needle(call: &TextCall, bindings: &BTreeMap<String, RdfTerm>) -> Option<String> {
    match &call.needle {
        TextNeedle::Literal(value) => Some(value.clone()),
        TextNeedle::Binding(variable) => binding_literal(variable, bindings).map(str::to_owned),
    }
}

fn pattern_has_text_object(pattern: &GraphPattern, variable: &Variable) -> bool {
    match pattern {
        GraphPattern::Bgp { patterns } => patterns.iter().any(|pattern| {
            matches!(
                (&pattern.predicate, &pattern.object),
                (NamedNodePattern::NamedNode(predicate), TermPattern::Variable(object))
                    if (predicate.as_str() == NEO_CONTENT || predicate.as_str() == NEO_NAME)
                        && object == variable
            )
        }),
        GraphPattern::Path { .. } | GraphPattern::Values { .. } => false,
        GraphPattern::Join { left, right }
        | GraphPattern::Lateral { left, right }
        | GraphPattern::Union { left, right }
        | GraphPattern::Minus { left, right } => {
            pattern_has_text_object(left, variable) || pattern_has_text_object(right, variable)
        }
        GraphPattern::LeftJoin {
            left,
            right,
            expression,
        } => {
            pattern_has_text_object(left, variable)
                || pattern_has_text_object(right, variable)
                || expression
                    .as_ref()
                    .is_some_and(|expression| expression_has_text_object(expression, variable))
        }
        GraphPattern::Filter { inner, expr } => {
            pattern_has_text_object(inner, variable) || expression_has_text_object(expr, variable)
        }
        GraphPattern::Extend {
            inner, expression, ..
        } => {
            pattern_has_text_object(inner, variable)
                || expression_has_text_object(expression, variable)
        }
        GraphPattern::OrderBy { inner, expression } => {
            pattern_has_text_object(inner, variable)
                || expression.iter().any(|order| match order {
                    spargebra::algebra::OrderExpression::Asc(expression)
                    | spargebra::algebra::OrderExpression::Desc(expression) => {
                        expression_has_text_object(expression, variable)
                    }
                })
        }
        GraphPattern::Group {
            inner, aggregates, ..
        } => {
            pattern_has_text_object(inner, variable)
                || aggregates.iter().any(|(_, aggregate)| match aggregate {
                    spargebra::algebra::AggregateExpression::CountSolutions { .. } => false,
                    spargebra::algebra::AggregateExpression::FunctionCall { expr, .. } => {
                        expression_has_text_object(expr, variable)
                    }
                })
        }
        GraphPattern::Graph { inner, .. }
        | GraphPattern::Service { inner, .. }
        | GraphPattern::Project { inner, .. }
        | GraphPattern::Distinct { inner }
        | GraphPattern::Reduced { inner }
        | GraphPattern::Slice { inner, .. } => pattern_has_text_object(inner, variable),
    }
}

fn expression_has_text_object(expression: &Expression, variable: &Variable) -> bool {
    match expression {
        Expression::Exists(pattern) => pattern_has_text_object(pattern, variable),
        Expression::Or(left, right)
        | Expression::And(left, right)
        | Expression::Equal(left, right)
        | Expression::SameTerm(left, right)
        | Expression::Greater(left, right)
        | Expression::GreaterOrEqual(left, right)
        | Expression::Less(left, right)
        | Expression::LessOrEqual(left, right)
        | Expression::Add(left, right)
        | Expression::Subtract(left, right)
        | Expression::Multiply(left, right)
        | Expression::Divide(left, right) => {
            expression_has_text_object(left, variable)
                || expression_has_text_object(right, variable)
        }
        Expression::UnaryPlus(inner) | Expression::UnaryMinus(inner) | Expression::Not(inner) => {
            expression_has_text_object(inner, variable)
        }
        Expression::If(condition, left, right) => {
            expression_has_text_object(condition, variable)
                || expression_has_text_object(left, variable)
                || expression_has_text_object(right, variable)
        }
        Expression::In(left, right) => {
            expression_has_text_object(left, variable)
                || right
                    .iter()
                    .any(|expression| expression_has_text_object(expression, variable))
        }
        Expression::Coalesce(expressions) | Expression::FunctionCall(_, expressions) => expressions
            .iter()
            .any(|expression| expression_has_text_object(expression, variable)),
        Expression::NamedNode(_)
        | Expression::Literal(_)
        | Expression::Variable(_)
        | Expression::Bound(_) => false,
    }
}

struct SimpleCore<'a> {
    mandatory: Vec<&'a TriplePattern>,
    optional: Vec<&'a TriplePattern>,
    filters: Vec<&'a Expression>,
}

enum TopKOrder {
    Subject { descending: bool },
    Property { predicate: String, descending: bool },
}

fn select_top_k_candidates(
    query: &Query,
    bindings: &BTreeMap<String, RdfTerm>,
    text_index: &TextIndex,
    property_index: &PropertyIndex,
    normalized_text: &HashMap<String, String>,
) -> Result<Option<Vec<String>>, QueryError> {
    // Below this measured crossover, even analyzing and intersecting sidecar
    // postings costs more than letting Oxigraph execute the full query.
    if text_index.len() < MIN_TOP_K_ENTITY_COUNT {
        return Ok(None);
    }
    let pattern = match query {
        Query::Select { pattern, .. } => pattern,
        Query::Ask { .. } | Query::Construct { .. } | Query::Describe { .. } => return Ok(None),
    };
    let Some((core, order, take)) = top_k_parts(pattern) else {
        return Ok(None);
    };
    let Some(simple) = simple_core(core) else {
        return Ok(None);
    };
    let Some(root) = simple_root(&simple) else {
        return Ok(None);
    };
    if !optional_connected(&simple.optional, &root) {
        return Ok(None);
    }

    let mut variable_predicates = HashMap::<Variable, String>::new();
    let mut optional_predicates = HashMap::<Variable, String>::new();
    let mut candidates = None::<RoaringBitmap>;
    let mut deferred = Vec::new();
    let mut has_type = false;
    for triple in &simple.mandatory {
        let TermPattern::Variable(subject) = &triple.subject else {
            return Ok(None);
        };
        if *subject != root {
            return Ok(None);
        }
        let NamedNodePattern::NamedNode(predicate) = &triple.predicate else {
            return Ok(None);
        };
        let predicate = predicate.as_str().to_owned();
        if predicate == rdf::TYPE.as_str() {
            has_type = true;
        }
        match &triple.object {
            TermPattern::NamedNode(value) => intersect_candidates(
                &mut candidates,
                property_index.exact(&predicate, &value.clone().into()),
            ),
            TermPattern::Literal(value) => intersect_candidates(
                &mut candidates,
                property_index.exact(&predicate, &value.clone().into()),
            ),
            TermPattern::Variable(variable) => {
                if let Some(value) = binding_term(variable, bindings)? {
                    intersect_candidates(&mut candidates, property_index.exact(&predicate, &value));
                } else {
                    if variable_predicates
                        .insert(variable.clone(), predicate.clone())
                        .is_some_and(|previous| previous != predicate)
                    {
                        return Ok(None);
                    }
                    deferred.push((variable.clone(), predicate));
                }
            }
            TermPattern::BlankNode(_) => return Ok(None),
        }
    }
    if !has_type {
        return Ok(None);
    }
    for triple in &simple.optional {
        let (
            TermPattern::Variable(subject),
            NamedNodePattern::NamedNode(predicate),
            TermPattern::Variable(variable),
        ) = (&triple.subject, &triple.predicate, &triple.object)
        else {
            continue;
        };
        if *subject == root {
            optional_predicates
                .entry(variable.clone())
                .or_insert_with(|| predicate.as_str().to_owned());
        }
    }

    let mut used_variables = HashSet::new();
    for filter in &simple.filters {
        let mut leaves = Vec::new();
        if !filter_leaves(filter, &mut leaves) {
            return Ok(None);
        }
        for leaf in leaves {
            match leaf {
                Expression::FunctionCall(Function::Custom(function), arguments)
                    if function.as_str() == MATCHES_TEXT =>
                {
                    let [Expression::Variable(content), needle] = arguments.as_slice() else {
                        return Ok(None);
                    };
                    let Some(predicate) = variable_predicates.get(content) else {
                        return Ok(None);
                    };
                    if predicate != NEO_CONTENT && predicate != NEO_NAME {
                        return Ok(None);
                    }
                    let Some(needle) = expression_literal(needle, bindings)? else {
                        return Ok(None);
                    };
                    let Some(matches) = text_index.candidate_ids(&needle, normalized_text) else {
                        return Ok(None);
                    };
                    intersect_candidates(&mut candidates, matches);
                    used_variables.insert(content.clone());
                }
                Expression::Equal(left, right)
                | Expression::Less(left, right)
                | Expression::LessOrEqual(left, right)
                | Expression::Greater(left, right)
                | Expression::GreaterOrEqual(left, right) => {
                    let comparison = match leaf {
                        Expression::Equal(_, _) => Comparison::Equal,
                        Expression::Less(_, _) => Comparison::Less,
                        Expression::LessOrEqual(_, _) => Comparison::LessOrEqual,
                        Expression::Greater(_, _) => Comparison::Greater,
                        Expression::GreaterOrEqual(_, _) => Comparison::GreaterOrEqual,
                        _ => unreachable!(),
                    };
                    let Some((variable, value, comparison)) =
                        comparison_parts(left, right, comparison, bindings)?
                    else {
                        return Ok(None);
                    };
                    let Some(predicate) = variable_predicates.get(&variable) else {
                        return Ok(None);
                    };
                    let matches = if let Some(value) = ordered_value(&value) {
                        property_index.compare(predicate, comparison, &value)
                    } else if matches!(comparison, Comparison::Equal) {
                        property_index.exact(predicate, &value)
                    } else {
                        return Ok(None);
                    };
                    intersect_candidates(&mut candidates, matches);
                    used_variables.insert(variable);
                }
                Expression::In(left, values) => {
                    let Expression::Variable(variable) = left.as_ref() else {
                        return Ok(None);
                    };
                    let Some(predicate) = variable_predicates.get(variable) else {
                        return Ok(None);
                    };
                    let mut matches = RoaringBitmap::new();
                    for value in values {
                        let Some(value) = expression_term(value, bindings)? else {
                            return Ok(None);
                        };
                        if let Some(value) = ordered_value(&value) {
                            matches |= property_index.compare(predicate, Comparison::Equal, &value);
                        } else {
                            matches |= property_index.exact(predicate, &value);
                        }
                    }
                    intersect_candidates(&mut candidates, matches);
                    used_variables.insert(variable.clone());
                }
                _ => return Ok(None),
            }
        }
    }
    for (variable, predicate) in deferred {
        if used_variables.contains(&variable) {
            continue;
        }
        if predicate == NEO_CONTENT || predicate == NEO_NAME {
            continue;
        }
        intersect_candidates(&mut candidates, property_index.presence(&predicate));
    }
    let Some(candidates) = candidates else {
        return Ok(None);
    };
    let order = match top_k_order(
        order,
        &root,
        &variable_predicates,
        &optional_predicates,
        property_index,
    ) {
        Some(order) => order,
        None => return Ok(None),
    };
    // Building the bounded RDF dataset has a fixed cost. For small candidate
    // sets Oxigraph's native top-k is cheaper; the sidecar wins beyond this
    // measured crossover.
    if candidates.len() < MIN_TOP_K_CANDIDATE_COUNT {
        return Ok(None);
    }
    let selected = match order {
        TopKOrder::Subject { descending } => {
            if descending {
                let mut subjects = BinaryHeap::<Reverse<String>>::new();
                for subject in candidates.iter().filter_map(|id| text_index.subject(id)) {
                    if subjects.len() < take {
                        subjects.push(Reverse(subject.to_owned()));
                    } else if subjects
                        .peek()
                        .is_some_and(|smallest| subject > smallest.0.as_str())
                    {
                        subjects.pop();
                        subjects.push(Reverse(subject.to_owned()));
                    }
                }
                let mut subjects = subjects
                    .into_iter()
                    .map(|Reverse(subject)| subject)
                    .collect::<Vec<_>>();
                subjects.sort_by(|left, right| right.cmp(left));
                subjects
            } else {
                let mut subjects = BinaryHeap::<String>::new();
                for subject in candidates.iter().filter_map(|id| text_index.subject(id)) {
                    if subjects.len() < take {
                        subjects.push(subject.to_owned());
                    } else if subjects
                        .peek()
                        .is_some_and(|largest| subject < largest.as_str())
                    {
                        subjects.pop();
                        subjects.push(subject.to_owned());
                    }
                }
                let mut subjects = subjects.into_vec();
                subjects.sort();
                subjects
            }
        }
        TopKOrder::Property {
            predicate,
            descending,
        } => property_index.ordered_subjects(&predicate, &candidates, descending, take, text_index),
    };
    Ok(Some(selected))
}

fn top_k_parts(pattern: &GraphPattern) -> Option<(&GraphPattern, &[OrderExpression], usize)> {
    let mut current = pattern;
    let mut order = None;
    let mut slice = None;
    loop {
        current = match current {
            GraphPattern::Slice {
                inner,
                start,
                length: Some(length),
            } if slice.is_none() => {
                slice = start.checked_add(*length);
                inner
            }
            GraphPattern::OrderBy { inner, expression } if order.is_none() => {
                order = Some(expression.as_slice());
                inner
            }
            GraphPattern::Project { inner, .. } => inner,
            GraphPattern::Distinct { .. }
            | GraphPattern::Reduced { .. }
            | GraphPattern::Group { .. } => return None,
            _ => break,
        };
    }
    Some((current, order?, slice?))
}

fn simple_core(pattern: &GraphPattern) -> Option<SimpleCore<'_>> {
    let mut result = SimpleCore {
        mandatory: Vec::new(),
        optional: Vec::new(),
        filters: Vec::new(),
    };
    if collect_simple_core(pattern, &mut result) {
        Some(result)
    } else {
        None
    }
}

fn collect_simple_core<'a>(pattern: &'a GraphPattern, result: &mut SimpleCore<'a>) -> bool {
    match pattern {
        GraphPattern::Bgp { patterns } => result.mandatory.extend(patterns),
        GraphPattern::Join { left, right } => {
            return collect_simple_core(left, result) && collect_simple_core(right, result);
        }
        GraphPattern::LeftJoin {
            left,
            right,
            expression,
        } => {
            if expression.is_some() {
                return false;
            }
            if !collect_simple_core(left, result)
                || !collect_optional_triples(right, &mut result.optional)
            {
                return false;
            }
        }
        GraphPattern::Filter { expr, inner } => {
            if !collect_simple_core(inner, result) {
                return false;
            }
            result.filters.push(expr);
        }
        GraphPattern::Extend { inner, .. } => return collect_simple_core(inner, result),
        GraphPattern::Path { .. }
        | GraphPattern::Values { .. }
        | GraphPattern::Lateral { .. }
        | GraphPattern::Union { .. }
        | GraphPattern::Graph { .. }
        | GraphPattern::Minus { .. }
        | GraphPattern::Service { .. }
        | GraphPattern::OrderBy { .. }
        | GraphPattern::Project { .. }
        | GraphPattern::Distinct { .. }
        | GraphPattern::Reduced { .. }
        | GraphPattern::Slice { .. }
        | GraphPattern::Group { .. } => return false,
    }
    true
}

fn collect_optional_triples<'a>(
    pattern: &'a GraphPattern,
    triples: &mut Vec<&'a TriplePattern>,
) -> bool {
    match pattern {
        GraphPattern::Bgp { patterns } => triples.extend(patterns),
        GraphPattern::Join { left, right } => {
            return collect_optional_triples(left, triples)
                && collect_optional_triples(right, triples);
        }
        GraphPattern::LeftJoin {
            left,
            right,
            expression,
        } => {
            if expression.is_some() {
                return false;
            }
            return collect_optional_triples(left, triples)
                && collect_optional_triples(right, triples);
        }
        _ => return false,
    }
    true
}

fn optional_connected(triples: &[&TriplePattern], root: &Variable) -> bool {
    let mut depths = HashMap::from([(root.clone(), 0_u8)]);
    let mut remaining = (0..triples.len()).collect::<BTreeSet<_>>();
    loop {
        let mut resolved = Vec::new();
        for index in &remaining {
            let triple = triples[*index];
            let (TermPattern::Variable(subject), NamedNodePattern::NamedNode(_)) =
                (&triple.subject, &triple.predicate)
            else {
                return false;
            };
            let Some(depth) = depths.get(subject).copied() else {
                continue;
            };
            if depth > 2 {
                return false;
            }
            if let TermPattern::Variable(object) = &triple.object {
                depths.entry(object.clone()).or_insert(depth + 1);
            }
            resolved.push(*index);
        }
        if resolved.is_empty() {
            return remaining.is_empty();
        }
        for index in resolved {
            remaining.remove(&index);
        }
    }
}

fn simple_root(simple: &SimpleCore<'_>) -> Option<Variable> {
    let mut root = None;
    for triple in &simple.mandatory {
        let (
            TermPattern::Variable(subject),
            NamedNodePattern::NamedNode(predicate),
            TermPattern::NamedNode(kind),
        ) = (&triple.subject, &triple.predicate, &triple.object)
        else {
            continue;
        };
        if predicate.as_str() != rdf::TYPE.as_str()
            || !matches!(
                kind.as_str(),
                "urn:neoseq:vocab:v1:Block"
                    | "urn:neoseq:vocab:v1:Page"
                    | "urn:neoseq:vocab:v1:Tag"
            )
        {
            continue;
        }
        if root.as_ref().is_some_and(|root| root != subject) {
            return None;
        }
        root = Some(subject.clone());
    }
    root
}

fn filter_leaves<'a>(expression: &'a Expression, leaves: &mut Vec<&'a Expression>) -> bool {
    if let Expression::And(left, right) = expression {
        filter_leaves(left, leaves) && filter_leaves(right, leaves)
    } else if matches!(
        expression,
        Expression::FunctionCall(Function::Custom(function), _) if function.as_str() == MATCHES_TEXT
    ) || matches!(
        expression,
        Expression::Equal(_, _)
            | Expression::Less(_, _)
            | Expression::LessOrEqual(_, _)
            | Expression::Greater(_, _)
            | Expression::GreaterOrEqual(_, _)
            | Expression::In(_, _)
    ) {
        leaves.push(expression);
        true
    } else {
        false
    }
}

fn comparison_parts(
    left: &Expression,
    right: &Expression,
    comparison: Comparison,
    bindings: &BTreeMap<String, RdfTerm>,
) -> Result<Option<(Variable, Term, Comparison)>, QueryError> {
    if let Expression::Variable(variable) = left
        && let Some(value) = expression_term(right, bindings)?
    {
        return Ok(Some((variable.clone(), value, comparison)));
    }
    if let Expression::Variable(variable) = right
        && let Some(value) = expression_term(left, bindings)?
    {
        return Ok(Some((variable.clone(), value, comparison.reverse())));
    }
    Ok(None)
}

fn expression_literal(
    expression: &Expression,
    bindings: &BTreeMap<String, RdfTerm>,
) -> Result<Option<String>, QueryError> {
    match expression {
        Expression::Literal(value) => Ok(Some(value.value().to_owned())),
        Expression::Variable(variable) => {
            Ok(binding_literal(variable, bindings).map(str::to_owned))
        }
        _ => Ok(None),
    }
}

fn expression_term(
    expression: &Expression,
    bindings: &BTreeMap<String, RdfTerm>,
) -> Result<Option<Term>, QueryError> {
    match expression {
        Expression::NamedNode(value) => Ok(Some(value.clone().into())),
        Expression::Literal(value) => Ok(Some(value.clone().into())),
        Expression::Variable(variable) => binding_term(variable, bindings),
        _ => Ok(None),
    }
}

fn binding_term(
    variable: &Variable,
    bindings: &BTreeMap<String, RdfTerm>,
) -> Result<Option<Term>, QueryError> {
    let Some((_, value)) = bindings
        .iter()
        .find(|(name, _)| name.trim_start_matches(['?', '$']) == variable.as_str())
    else {
        return Ok(None);
    };
    let value = to_ground_term(value.clone())?;
    Ok(Some(match value {
        GroundTerm::NamedNode(value) => value.into(),
        GroundTerm::Literal(value) => value.into(),
    }))
}

fn intersect_candidates(current: &mut Option<RoaringBitmap>, next: RoaringBitmap) {
    if let Some(current) = current {
        *current &= next;
    } else {
        *current = Some(next);
    }
}

fn top_k_order(
    order: &[OrderExpression],
    root: &Variable,
    mandatory: &HashMap<Variable, String>,
    optional: &HashMap<Variable, String>,
    property_index: &PropertyIndex,
) -> Option<TopKOrder> {
    let mut property = None::<(Variable, bool)>;
    let mut subject_direction = None;
    let mut other = Vec::new();
    for order in order {
        let (descending, expression) = match order {
            OrderExpression::Asc(expression) => (false, expression),
            OrderExpression::Desc(expression) => (true, expression),
        };
        if let Expression::Variable(variable) = expression {
            if variable == root {
                subject_direction = Some(descending);
            } else if property
                .replace((variable.clone(), descending))
                .is_some_and(|(previous, _)| previous != *variable)
            {
                return None;
            }
        } else {
            other.push((descending, expression));
        }
    }
    if let Some((variable, descending)) = property {
        // Optional property variables can be unbound. The query compiler emits
        // an explicit BOUND bucket to keep those rows last; without it, SPARQL
        // has direction-dependent error ordering that this fast path does not
        // try to reproduce.
        if optional.contains_key(&variable) && other.is_empty() {
            return None;
        }
        if other
            .iter()
            .any(|(descending, expression)| *descending || !is_bound_last(expression, &variable))
        {
            return None;
        }
        if subject_direction.unwrap_or(false) {
            return None;
        }
        let predicate = mandatory
            .get(&variable)
            .or_else(|| optional.get(&variable))?;
        if !property_index.has_ordered(predicate) {
            return None;
        }
        Some(TopKOrder::Property {
            predicate: predicate.clone(),
            descending,
        })
    } else {
        if !other.is_empty() {
            return None;
        }
        Some(TopKOrder::Subject {
            descending: subject_direction?,
        })
    }
}

fn is_bound_last(expression: &Expression, variable: &Variable) -> bool {
    matches!(
        expression,
        Expression::If(condition, when_bound, when_missing)
            if matches!(condition.as_ref(), Expression::Bound(bound) if bound == variable)
                && matches!(when_bound.as_ref(), Expression::Literal(value) if value.value() == "0")
                && matches!(when_missing.as_ref(), Expression::Literal(value) if value.value() == "1")
    )
}

fn inject_text_candidates(
    query: &mut Query,
    bindings: &BTreeMap<String, RdfTerm>,
    index: &TextIndex,
    normalized_text: &HashMap<String, String>,
) -> Result<(), QueryError> {
    let pattern = match query {
        Query::Select { pattern, .. } | Query::Ask { pattern, .. } => pattern,
        Query::Construct { .. } | Query::Describe { .. } => return Ok(()),
    };
    let core = query_core_pattern(pattern);
    let mut text_subjects = HashMap::new();
    let mut ambiguous = HashSet::new();
    collect_mandatory_text_subjects(core, &mut text_subjects, &mut ambiguous);
    let mut calls = Vec::new();
    collect_mandatory_text_calls(core, &mut calls);

    let mut by_subject = BTreeMap::<Variable, BTreeSet<String>>::new();
    for call in calls {
        let Some(subject) = text_subjects.get(&call.content) else {
            continue;
        };
        if ambiguous.contains(&call.content) {
            continue;
        }
        let Some(needle) = resolve_text_needle(&call, bindings) else {
            continue;
        };
        let Some(candidates) = index.candidates(&needle, normalized_text) else {
            continue;
        };
        if !candidates.is_empty()
            && (candidates.len() > 100_000 || candidates.len().saturating_mul(4) > index.len())
        {
            continue;
        }
        let candidates = candidates.into_iter().collect::<BTreeSet<_>>();
        by_subject
            .entry(subject.clone())
            .and_modify(|current| current.retain(|candidate| candidates.contains(candidate)))
            .or_insert(candidates);
    }
    for (subject, candidates) in by_subject {
        let rows = candidates
            .into_iter()
            .map(|candidate| Ok(vec![Some(named(&candidate)?.into())]))
            .collect::<Result<Vec<Vec<Option<GroundTerm>>>, QueryError>>()?;
        inject_values(pattern, vec![subject], rows);
    }
    Ok(())
}

fn query_core_pattern(mut pattern: &GraphPattern) -> &GraphPattern {
    loop {
        pattern = match pattern {
            GraphPattern::OrderBy { inner, .. }
            | GraphPattern::Project { inner, .. }
            | GraphPattern::Distinct { inner }
            | GraphPattern::Reduced { inner }
            | GraphPattern::Slice { inner, .. }
            | GraphPattern::Group { inner, .. } => inner,
            _ => return pattern,
        };
    }
}

fn collect_mandatory_text_subjects(
    pattern: &GraphPattern,
    subjects: &mut HashMap<Variable, Variable>,
    ambiguous: &mut HashSet<Variable>,
) {
    match pattern {
        GraphPattern::Bgp { patterns } => {
            for pattern in patterns {
                let (
                    TermPattern::Variable(subject),
                    NamedNodePattern::NamedNode(predicate),
                    TermPattern::Variable(content),
                ) = (&pattern.subject, &pattern.predicate, &pattern.object)
                else {
                    continue;
                };
                if predicate.as_str() != NEO_CONTENT && predicate.as_str() != NEO_NAME {
                    continue;
                }
                if subjects
                    .insert(content.clone(), subject.clone())
                    .is_some_and(|previous| previous != *subject)
                {
                    ambiguous.insert(content.clone());
                }
            }
        }
        GraphPattern::Join { left, right } => {
            collect_mandatory_text_subjects(left, subjects, ambiguous);
            collect_mandatory_text_subjects(right, subjects, ambiguous);
        }
        GraphPattern::LeftJoin { left, .. }
        | GraphPattern::Lateral { left, .. }
        | GraphPattern::Minus { left, .. } => {
            collect_mandatory_text_subjects(left, subjects, ambiguous);
        }
        GraphPattern::Filter { inner, .. } | GraphPattern::Extend { inner, .. } => {
            collect_mandatory_text_subjects(inner, subjects, ambiguous);
        }
        GraphPattern::Path { .. }
        | GraphPattern::Union { .. }
        | GraphPattern::Graph { .. }
        | GraphPattern::Service { .. }
        | GraphPattern::Values { .. }
        | GraphPattern::OrderBy { .. }
        | GraphPattern::Project { .. }
        | GraphPattern::Distinct { .. }
        | GraphPattern::Reduced { .. }
        | GraphPattern::Slice { .. }
        | GraphPattern::Group { .. } => {}
    }
}

fn collect_mandatory_text_calls(pattern: &GraphPattern, calls: &mut Vec<TextCall>) {
    match pattern {
        GraphPattern::Join { left, right } => {
            collect_mandatory_text_calls(left, calls);
            collect_mandatory_text_calls(right, calls);
        }
        GraphPattern::LeftJoin { left, .. }
        | GraphPattern::Lateral { left, .. }
        | GraphPattern::Minus { left, .. } => {
            collect_mandatory_text_calls(left, calls);
        }
        GraphPattern::Filter { expr, inner } => {
            collect_conjunctive_text_calls(expr, calls);
            collect_mandatory_text_calls(inner, calls);
        }
        GraphPattern::Extend { inner, .. } => collect_mandatory_text_calls(inner, calls),
        GraphPattern::Bgp { .. }
        | GraphPattern::Path { .. }
        | GraphPattern::Union { .. }
        | GraphPattern::Graph { .. }
        | GraphPattern::Service { .. }
        | GraphPattern::Values { .. }
        | GraphPattern::OrderBy { .. }
        | GraphPattern::Project { .. }
        | GraphPattern::Distinct { .. }
        | GraphPattern::Reduced { .. }
        | GraphPattern::Slice { .. }
        | GraphPattern::Group { .. } => {}
    }
}

fn collect_conjunctive_text_calls(expression: &Expression, calls: &mut Vec<TextCall>) {
    match expression {
        Expression::And(left, right) => {
            collect_conjunctive_text_calls(left, calls);
            collect_conjunctive_text_calls(right, calls);
        }
        Expression::FunctionCall(Function::Custom(function), arguments)
            if function.as_str() == MATCHES_TEXT =>
        {
            if let [Expression::Variable(content), needle] = arguments.as_slice() {
                let needle = match needle {
                    Expression::Literal(needle) => {
                        Some(TextNeedle::Literal(needle.value().to_owned()))
                    }
                    Expression::Variable(variable) => Some(TextNeedle::Binding(variable.clone())),
                    _ => None,
                };
                if let Some(needle) = needle {
                    calls.push(TextCall {
                        content: content.clone(),
                        needle,
                    });
                }
            }
        }
        _ => {}
    }
}

fn inject_query_bindings(
    query: &mut Query,
    bindings: BTreeMap<String, RdfTerm>,
) -> Result<(), QueryError> {
    if bindings.is_empty() {
        return Ok(());
    }
    let mut variables = Vec::with_capacity(bindings.len());
    let mut row = Vec::with_capacity(bindings.len());
    for (name, value) in bindings {
        variables.push(Variable::new(name.trim_start_matches(['?', '$'])).map_err(term_error)?);
        row.push(Some(to_ground_term(value)?));
    }
    let pattern = match query {
        Query::Select { pattern, .. } | Query::Ask { pattern, .. } => pattern,
        Query::Construct { .. } | Query::Describe { .. } => {
            return Err(QueryError::Disallowed(
                "only SELECT and ASK accept bindings".into(),
            ));
        }
    };
    inject_values(pattern, variables, vec![row]);
    Ok(())
}

/// Inserts an algebraic VALUES row inside solution modifiers. This gives bound
/// variables normal SPARQL join semantics without rewriting query text, while
/// preserving the SELECT projection exactly as authored.
fn inject_values(
    pattern: &mut GraphPattern,
    variables: Vec<Variable>,
    rows: Vec<Vec<Option<GroundTerm>>>,
) {
    match pattern {
        GraphPattern::Filter { inner, .. }
        | GraphPattern::Extend { inner, .. }
        | GraphPattern::OrderBy { inner, .. }
        | GraphPattern::Project { inner, .. }
        | GraphPattern::Distinct { inner }
        | GraphPattern::Reduced { inner }
        | GraphPattern::Slice { inner, .. }
        | GraphPattern::Group { inner, .. } => inject_values(inner, variables, rows),
        _ => {
            let original = std::mem::replace(pattern, GraphPattern::Bgp { patterns: vec![] });
            *pattern = GraphPattern::Join {
                left: Box::new(GraphPattern::Values {
                    variables,
                    bindings: rows,
                }),
                right: Box::new(original),
            };
        }
    }
}

fn to_ground_term(term: RdfTerm) -> Result<GroundTerm, QueryError> {
    match term {
        RdfTerm::Iri { value, .. } => Ok(named(&value)?.into()),
        RdfTerm::Literal {
            value,
            datatype,
            language,
        } => {
            if let Some(language) = language {
                Literal::new_language_tagged_literal(value, language)
                    .map(Into::into)
                    .map_err(term_error)
            } else {
                Ok(Literal::new_typed_literal(value, named(&datatype)?).into())
            }
        }
    }
}

pub fn entity_iri(graph_id: &GraphId, kind: &str, id: &str) -> Result<NamedNode, QueryError> {
    named(&format!(
        "{ENTITY_NS}{}:{kind}:{}",
        encode_component(graph_id.as_str()),
        encode_component(id)
    ))
}

pub fn normalize_text(value: &str) -> String {
    value
        .chars()
        .flat_map(char::to_lowercase)
        .map(|character| {
            if character.is_alphanumeric() || character.is_whitespace() {
                character
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn encode_component(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push('%');
            encoded.push(char::from(HEX[(byte >> 4) as usize]));
            encoded.push(char::from(HEX[(byte & 0x0f) as usize]));
        }
    }
    encoded
}

fn named(value: &str) -> Result<NamedNode, QueryError> {
    NamedNode::new(value).map_err(term_error)
}

fn named_ref(local: &str) -> Result<NamedNode, QueryError> {
    named(&format!("{NEO_NS}{local}"))
}

fn triples_for_subject(store: &Store, key: &str) -> Result<HashSet<Triple>, QueryError> {
    let subject = NamedNode::new(key).map_err(term_error)?;
    store
        .quads_for_pattern(
            Some(subject.as_ref().into()),
            None,
            None,
            Some(GraphNameRef::DefaultGraph),
        )
        .map(|quad| {
            let quad = quad.map_err(index_error)?;
            Ok(Triple::new(quad.subject, quad.predicate, quad.object))
        })
        .collect()
}

fn write_entity_diff(
    transaction: &mut Transaction<'_>,
    previous: Option<&HashSet<Triple>>,
    next: Option<&HashSet<Triple>>,
) {
    if let Some(previous) = previous {
        for triple in previous {
            if next.is_none_or(|next| !next.contains(triple)) {
                transaction.remove(QuadRef::new(
                    triple.subject.as_ref(),
                    triple.predicate.as_ref(),
                    triple.object.as_ref(),
                    GraphNameRef::DefaultGraph,
                ));
            }
        }
    }
    if let Some(next) = next {
        for triple in next {
            if previous.is_none_or(|previous| !previous.contains(triple)) {
                transaction.insert(QuadRef::new(
                    triple.subject.as_ref(),
                    triple.predicate.as_ref(),
                    triple.object.as_ref(),
                    GraphNameRef::DefaultGraph,
                ));
            }
        }
    }
}

fn snapshot_fingerprint(snapshot: &GraphSnapshot) -> Result<String, QueryError> {
    let bytes =
        serde_json::to_vec(snapshot).map_err(|error| QueryError::Index(error.to_string()))?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

fn index_error(error: impl std::fmt::Display) -> QueryError {
    QueryError::Index(error.to_string())
}

fn term_error(error: impl std::fmt::Display) -> QueryError {
    QueryError::InvalidTerm(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use domain::{
        BlockId, Cardinality, GraphSettings, LocalDate, PageSnapshot, PropertyField, PropertyKey,
        PropertyType, TagSnapshot,
    };

    fn single(key: &str, value: PropertyValue) -> PropertyField {
        PropertyField {
            key: PropertyKey::new(key).unwrap(),
            value_type: value.property_type(),
            cardinality: Cardinality::Single,
            values: vec![value],
        }
    }

    fn snapshot() -> GraphSnapshot {
        GraphSnapshot {
            schema_version: domain::SCHEMA_VERSION,
            graph_id: GraphId::new("query graph").unwrap(),
            pages: vec![PageSnapshot {
                id: PageId::new("today").unwrap(),
                title: "Today".into(),
                properties: vec![
                    single("user.count", PropertyValue::Number(3.5)),
                    single("user.flag", PropertyValue::Checkbox(true)),
                    single(
                        "user.link",
                        PropertyValue::Page(PageId::new("missing-page").unwrap()),
                    ),
                    PropertyField {
                        key: PropertyKey::new("user.alias").unwrap(),
                        value_type: PropertyType::String,
                        cardinality: Cardinality::Set,
                        values: vec![
                            PropertyValue::String("one".into()),
                            PropertyValue::String("two".into()),
                        ],
                    },
                    PropertyField {
                        key: PropertyKey::new("user.empty").unwrap(),
                        value_type: PropertyType::String,
                        cardinality: Cardinality::Single,
                        values: vec![],
                    },
                ],
                tags: vec![TagId::new("project").unwrap()],
                blocks: vec![BlockSnapshot {
                    id: BlockId::new("todo-1").unwrap(),
                    markdown: "Ship the Query Engine".into(),
                    properties: vec![
                        single("builtin.task-status", PropertyValue::String("todo".into())),
                        single(
                            "builtin.task-deadline",
                            PropertyValue::Date(LocalDate::new("2026-08-05").unwrap()),
                        ),
                    ],
                    tags: vec![TagId::new("project").unwrap()],
                    children: vec![],
                }],
            }],
            tags: vec![TagSnapshot {
                id: TagId::new("project").unwrap(),
                name: "Project".into(),
                properties: vec![],
                defaults: vec![single(
                    "builtin.task-priority",
                    PropertyValue::String("high".into()),
                )],
                blocks: vec![],
            }],
            settings: GraphSettings::default(),
            quarantined: vec![],
        }
    }

    fn ordered_snapshot(block_count: usize) -> GraphSnapshot {
        GraphSnapshot {
            schema_version: domain::SCHEMA_VERSION,
            graph_id: GraphId::new("ordered-query").unwrap(),
            pages: vec![PageSnapshot {
                id: PageId::new("ordered-page").unwrap(),
                title: "Ordered".into(),
                properties: vec![],
                tags: vec![],
                blocks: (0..block_count)
                    .map(|index| BlockSnapshot {
                        id: BlockId::new(format!("block-{index:05}")).unwrap(),
                        markdown: format!("Block {index}"),
                        properties: vec![
                            single("builtin.task-status", PropertyValue::String("todo".into())),
                            single(
                                "builtin.task-deadline",
                                PropertyValue::Date(
                                    LocalDate::new(format!("2026-08-{:02}", index % 15 + 1))
                                        .unwrap(),
                                ),
                            ),
                        ],
                        tags: vec![],
                        children: vec![],
                    })
                    .collect(),
            }],
            tags: vec![],
            settings: GraphSettings::default(),
            quarantined: vec![],
        }
    }

    fn request(source: &str) -> QueryRequest {
        QueryRequest {
            language: QUERY_LANGUAGE.into(),
            source: source.into(),
            bindings: BTreeMap::new(),
            budget: QueryBudget::default(),
        }
    }

    #[test]
    fn trigram_postings_return_exact_candidates_and_track_replacements() {
        let mut index = TextIndex::default();
        let mut normalized = HashMap::new();
        index
            .insert(
                "urn:first".into(),
                "Alpha, Query Engine".into(),
                &mut normalized,
            )
            .unwrap();
        index
            .insert(
                "urn:second".into(),
                "Alpha elsewhere".into(),
                &mut normalized,
            )
            .unwrap();

        assert_eq!(
            index.candidates("query engine", &normalized).unwrap(),
            ["urn:first"]
        );
        assert!(
            index
                .candidates("missing trigram", &normalized)
                .unwrap()
                .is_empty()
        );
        assert!(index.candidates("qu", &normalized).is_none());

        index
            .insert("urn:first".into(), "Replaced text".into(), &mut normalized)
            .unwrap();
        assert!(
            index
                .candidates("query engine", &normalized)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            index.candidates("replaced", &normalized).unwrap(),
            ["urn:first"]
        );
        index.remove("urn:first", &mut normalized);
        assert!(
            index
                .candidates("replaced", &normalized)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn matches_text_enforces_its_plannable_shape() {
        let index = GraphIndex::new(&snapshot()).unwrap();
        for source in [
            "PREFIX neo: <urn:neoseq:vocab:v1:> ASK { FILTER(neo:matchesText(\"content\", \"needle\")) }",
            "PREFIX neo: <urn:neoseq:vocab:v1:> ASK { ?item neo:content ?content . FILTER(neo:matchesText(?content, ?needle)) }",
            "PREFIX neo: <urn:neoseq:vocab:v1:> ASK { ?item neo:page ?content . FILTER(neo:matchesText(?content, \"needle\")) }",
        ] {
            assert!(matches!(
                index.execute(request(source)),
                Err(QueryError::Disallowed(_))
            ));
        }

        assert!(matches!(
            index
                .execute(request(
                    "PREFIX neo: <urn:neoseq:vocab:v1:> ASK { ?tag neo:name ?name . FILTER(neo:matchesText(?name, \"project\")) }",
                ))
                .unwrap(),
            QueryResult::Ask { value: true, .. }
        ));
    }

    #[test]
    fn top_k_preselection_skips_small_property_candidate_sets() {
        let index = GraphIndex::new(&snapshot()).unwrap();
        let mut request = request(
            "PREFIX neo: <urn:neoseq:vocab:v1:>\n\
             PREFIX prop: <urn:neoseq:property:>\n\
             SELECT ?block ?deadline WHERE {\n\
               ?block a neo:Block ;\n\
                      prop:builtin.task-status ?status ;\n\
                      prop:builtin.task-deadline ?deadline .\n\
               FILTER (?deadline <= ?today)\n\
             } ORDER BY ?deadline ?block LIMIT 100",
        );
        request.bindings.insert(
            "status".into(),
            RdfTerm::Literal {
                value: "todo".into(),
                datatype: xsd::STRING.as_str().into(),
                language: None,
            },
        );
        request.bindings.insert(
            "today".into(),
            RdfTerm::Literal {
                value: "2026-08-15".into(),
                datatype: xsd::DATE.as_str().into(),
                language: None,
            },
        );
        let query = SparqlParser::new().parse_query(&request.source).unwrap();
        assert!(
            select_top_k_candidates(
                &query,
                &request.bindings,
                &index.text_index,
                &index.property_index,
                &index.normalized_text,
            )
            .unwrap()
            .is_none(),
            "{}",
            query.to_sse()
        );
        assert!(!query.to_sse().contains("(table (vars ?block)"));
    }

    #[test]
    fn top_k_shape_rejects_inline_values_and_optional_filters() {
        for source in [
            "PREFIX neo: <urn:neoseq:vocab:v1:>\n\
             SELECT ?block WHERE {\n\
               ?block a neo:Block .\n\
               VALUES ?block { <urn:neoseq:entity:query%20graph:block:todo-1> }\n\
             } ORDER BY ?block LIMIT 10",
            "PREFIX neo: <urn:neoseq:vocab:v1:>\n\
             PREFIX prop: <urn:neoseq:property:>\n\
             SELECT ?block ?deadline WHERE {\n\
               ?block a neo:Block .\n\
               OPTIONAL { ?block prop:builtin.task-deadline ?deadline .\n\
                          FILTER(?deadline < \"2026-08-15\"^^<http://www.w3.org/2001/XMLSchema#date>) }\n\
             } ORDER BY ASC(IF(BOUND(?deadline), 0, 1)) ?deadline ?block LIMIT 10",
        ] {
            let query = SparqlParser::new().parse_query(source).unwrap();
            let Query::Select { pattern, .. } = &query else {
                panic!("expected SELECT")
            };
            let (core, _, _) = top_k_parts(pattern).unwrap();
            assert!(simple_core(core).is_none(), "{}", query.to_sse());
        }
    }

    #[test]
    fn ordered_property_top_k_matches_the_full_sparql_fallback() {
        let index = GraphIndex::new(&ordered_snapshot(12_001)).unwrap();
        let source = "PREFIX neo: <urn:neoseq:vocab:v1:>\n\
                      PREFIX prop: <urn:neoseq:property:>\n\
                      SELECT ?block ?deadline WHERE {\n\
                        ?block a neo:Block ;\n\
                               prop:builtin.task-status ?status ;\n\
                               prop:builtin.task-deadline ?deadline .\n\
                        FILTER (?deadline <= ?today)\n\
                      } ORDER BY ?deadline ?block LIMIT 100";
        let mut accelerated = request(source);
        accelerated.bindings.insert(
            "status".into(),
            RdfTerm::Literal {
                value: "todo".into(),
                datatype: xsd::STRING.as_str().into(),
                language: None,
            },
        );
        accelerated.bindings.insert(
            "today".into(),
            RdfTerm::Literal {
                value: "2026-08-15".into(),
                datatype: xsd::DATE.as_str().into(),
                language: None,
            },
        );
        let parsed = SparqlParser::new().parse_query(source).unwrap();
        assert_eq!(
            select_top_k_candidates(
                &parsed,
                &accelerated.bindings,
                &index.text_index,
                &index.property_index,
                &index.normalized_text,
            )
            .unwrap()
            .unwrap()
            .len(),
            100
        );

        let mut fallback = accelerated.clone();
        fallback.source = fallback
            .source
            .replace("} ORDER BY", "  FILTER(STRLEN(\"x\") = 1)\n} ORDER BY");
        let QueryResult::Select {
            rows: accelerated, ..
        } = index.execute(accelerated).unwrap()
        else {
            panic!("expected SELECT")
        };
        let QueryResult::Select { rows: fallback, .. } = index.execute(fallback).unwrap() else {
            panic!("expected SELECT")
        };
        assert_eq!(accelerated, fallback);
    }

    #[test]
    fn projects_entities_properties_tags_and_hierarchy() {
        let index = GraphIndex::new(&snapshot()).unwrap();
        assert_eq!(index.triple_count(), 28);
        let triples = index.semantic_triples().join("\n");
        assert!(triples.contains("urn:neoseq:property:builtin.task-status"));
        assert!(triples.contains("urn:neoseq:default-property:builtin.task-priority"));
        assert!(triples.contains("missing-page"));
        assert!(triples.contains(xsd::BOOLEAN.as_str()));
        assert!(triples.contains(xsd::DOUBLE.as_str()));
        assert!(triples.contains("urn:neoseq:vocab:v1:parent"));
        assert!(triples.contains("query%20graph"));
        assert!(triples.contains("<urn:neoseq:property-key:user.empty>"));
        assert!(!triples.contains("<urn:neoseq:property:user.empty>"));
    }

    #[test]
    fn projects_tag_owned_blocks_with_their_outline_owner() {
        let mut source = snapshot();
        source.tags[0].blocks.push(BlockSnapshot {
            id: BlockId::new("tag-note").unwrap(),
            markdown: "Notes about this tag".into(),
            properties: vec![],
            tags: vec![],
            children: vec![],
        });
        let tag_iri = entity_iri(&source.graph_id, "tag", "project").unwrap();
        let index = GraphIndex::new(&source).unwrap();
        let query = request(&format!(
            "PREFIX neo: <urn:neoseq:vocab:v1:>\n\
             SELECT ?block WHERE {{ ?block a neo:Block; neo:owner <{}> }}",
            tag_iri.as_str(),
        ));
        let QueryResult::Select { rows, .. } = index.execute(query).unwrap() else {
            panic!("expected SELECT")
        };
        assert!(matches!(
            rows.as_slice(),
            [row] if matches!(
                row.get("block"),
                Some(RdfTerm::Iri {
                    entity: Some(QueryEntityRef::Block {
                        owner: OutlineOwner::Tag { id },
                        id: block,
                    }),
                    ..
                }) if id.as_str() == "project" && block == "tag-note"
            )
        ));
    }

    #[test]
    fn sparql_executes_select_with_typed_binding_and_entity_metadata() {
        let index = GraphIndex::new(&snapshot()).unwrap();
        let mut query = request(
            "PREFIX neo: <urn:neoseq:vocab:v1:>\n\
             PREFIX prop: <urn:neoseq:property:>\n\
             SELECT ?block ?deadline WHERE {\n\
               ?block a neo:Block; prop:builtin.task-status \"todo\";\n\
                 prop:builtin.task-deadline ?deadline; neo:content ?content.\n\
               FILTER(?deadline <= ?today && neo:matchesText(?content, ?needle))\n\
             } ORDER BY ?block",
        );
        query.bindings.insert(
            "today".into(),
            RdfTerm::Literal {
                value: "2026-08-06".into(),
                datatype: xsd::DATE.as_str().into(),
                language: None,
            },
        );
        query.bindings.insert(
            "needle".into(),
            RdfTerm::Literal {
                value: "query engine".into(),
                datatype: xsd::STRING.as_str().into(),
                language: None,
            },
        );
        let QueryResult::Select { rows, .. } = index.execute(query).unwrap() else {
            panic!("expected SELECT")
        };
        assert_eq!(rows.len(), 1);
        assert!(matches!(
            rows[0].get("block"),
            Some(RdfTerm::Iri {
                entity: Some(QueryEntityRef::Block { id, .. }),
                ..
            }) if id == "todo-1"
        ));
    }

    /// The query builder writes SPARQL, so the shapes it writes are part of
    /// this profile's contract: a bound parameter standing in for a constant
    /// object, negation as `NOT EXISTS`, alternatives as a disjunction of
    /// `EXISTS`, optional columns, `GROUP_CONCAT` over a repeated relation, and
    /// the subject as the one order a `LIMIT` cuts against. A change here breaks
    /// every built query.
    ///
    /// Alternatives are `EXISTS`, deliberately, and this test is where that is
    /// nailed down: a `UNION` branch is evaluated before it joins, so a bound
    /// parameter inside one is unbound and its whole branch silently answers
    /// nothing. `EXISTS` is evaluated against the solution in hand, so both the
    /// subject and every parameter reach it.
    #[test]
    fn sparql_accepts_the_shapes_the_query_builder_compiles() {
        let index = GraphIndex::new(&snapshot()).unwrap();
        let mut query = request(
            "PREFIX neo: <urn:neoseq:vocab:v1:>\n\
             PREFIX prop: <urn:neoseq:property:>\n\
             SELECT ?item ?c0 (GROUP_CONCAT(DISTINCT ?c1; SEPARATOR=\"\\u001F\") AS ?c1_list)\n\
                    (COUNT(DISTINCT ?c1) AS ?c2) WHERE {\n\
               ?item a neo:Block .\n\
               ?item prop:builtin.task-status ?p0 .\n\
               FILTER(\n\
                 EXISTS { ?item neo:tag ?p1 }\n\
                 || EXISTS { ?item prop:builtin.task-deadline ?v0 . FILTER(?v0 <= ?p2) }\n\
               )\n\
               FILTER NOT EXISTS { ?item prop:user.done ?v1 }\n\
               OPTIONAL { ?item neo:content ?c0 }\n\
               OPTIONAL { ?item neo:tag ?t0 . ?t0 neo:name ?c1 }\n\
             }\n\
             GROUP BY ?item ?c0\n\
             ORDER BY ?item\n\
             LIMIT 50",
        );
        query.bindings.insert(
            "p0".into(),
            RdfTerm::Literal {
                value: "todo".into(),
                datatype: xsd::STRING.as_str().into(),
                language: None,
            },
        );
        query.bindings.insert(
            "p1".into(),
            RdfTerm::Iri {
                value: entity_iri(&GraphId::new("query graph").unwrap(), "tag", "project")
                    .unwrap()
                    .as_str()
                    .to_owned(),
                entity: None,
            },
        );
        query.bindings.insert(
            "p2".into(),
            RdfTerm::Literal {
                value: "2026-12-31".into(),
                datatype: xsd::DATE.as_str().into(),
                language: None,
            },
        );
        let QueryResult::Select {
            variables, rows, ..
        } = index.execute(query).unwrap()
        else {
            panic!("expected SELECT")
        };
        assert_eq!(variables, ["item", "c0", "c1_list", "c2"]);
        assert_eq!(rows.len(), 1);
        assert!(matches!(
            rows[0].get("c0"),
            Some(RdfTerm::Literal { value, .. }) if value == "Ship the Query Engine"
        ));
        assert!(matches!(
            rows[0].get("c1_list"),
            Some(RdfTerm::Literal { value, .. }) if value == "Project"
        ));

        // The separator a list column joins on has to survive the parser and
        // reach the cell intact, because the renderer splits on it.
        let joined = request(
            "PREFIX neo: <urn:neoseq:vocab:v1:>\n\
             PREFIX prop: <urn:neoseq:property:>\n\
             SELECT ?item (GROUP_CONCAT(DISTINCT ?c0; SEPARATOR=\"\\u001F\") AS ?c0_list) WHERE {\n\
               ?item a neo:Page .\n\
               OPTIONAL { ?item prop:user.alias ?c0 }\n\
             } GROUP BY ?item",
        );
        let QueryResult::Select { rows, .. } = index.execute(joined).unwrap() else {
            panic!("expected SELECT")
        };
        let Some(RdfTerm::Literal { value, .. }) = rows[0].get("c0_list") else {
            panic!("expected a joined literal")
        };
        assert_eq!(value.split('\u{1f}').count(), 2);

        // The reason alternatives are not `UNION`: the same question asked that
        // way answers nothing, because `?p0` never reaches the branch.
        let mut unioned = request(
            "PREFIX neo: <urn:neoseq:vocab:v1:>\n\
             SELECT ?item WHERE {\n\
               ?item a neo:Block .\n\
               { ?item a neo:Block . ?item neo:content ?v0 .\n\
                 FILTER(neo:matchesText(?v0, ?p0)) }\n\
             }",
        );
        let mut existing = request(
            "PREFIX neo: <urn:neoseq:vocab:v1:>\n\
             SELECT ?item WHERE {\n\
               ?item a neo:Block .\n\
               FILTER(EXISTS { ?item neo:content ?v0 . FILTER(neo:matchesText(?v0, ?p0)) })\n\
             }",
        );
        let needle = RdfTerm::Literal {
            value: "query".into(),
            datatype: xsd::STRING.as_str().into(),
            language: None,
        };
        unioned.bindings.insert("p0".into(), needle.clone());
        existing.bindings.insert("p0".into(), needle);
        let QueryResult::Select { rows: none, .. } = index.execute(unioned).unwrap() else {
            panic!("expected SELECT")
        };
        let QueryResult::Select { rows: found, .. } = index.execute(existing).unwrap() else {
            panic!("expected SELECT")
        };
        assert!(none.is_empty());
        assert_eq!(found.len(), 1);
    }

    #[test]
    fn sparql_rejects_non_local_or_graph_producing_forms() {
        let index = GraphIndex::new(&snapshot()).unwrap();
        for source in [
            "CONSTRUCT WHERE { ?s ?p ?o }",
            "SELECT * FROM <urn:other> WHERE { ?s ?p ?o }",
            "SELECT * WHERE { SERVICE <https://example.com> { ?s ?p ?o } }",
            "SELECT * WHERE { GRAPH ?g { ?s ?p ?o } }",
        ] {
            assert!(matches!(
                index.execute(request(source)),
                Err(QueryError::Disallowed(_))
            ));
        }
    }

    #[test]
    fn rebuild_matches_incremental_refresh() {
        let mut source = snapshot();
        let mut incremental = GraphIndex::new(&source).unwrap();
        source.pages[0].blocks[0].markdown = "Done".into();
        assert!(incremental.refresh(&source).unwrap());
        let rebuilt = GraphIndex::new(&source).unwrap();
        assert_eq!(incremental.semantic_triples(), rebuilt.semantic_triples());
        assert_eq!(incremental.frontier(), rebuilt.frontier());
    }

    #[test]
    fn differential_incremental_and_rebuilt_results_match() {
        let mut source = snapshot();
        let mut incremental = GraphIndex::new(&source).unwrap();
        source.pages[0].blocks[0].properties[0].values = vec![PropertyValue::String("done".into())];
        incremental.refresh(&source).unwrap();
        let rebuilt = GraphIndex::new(&source).unwrap();
        let query = request(
            "PREFIX prop: <urn:neoseq:property:> SELECT ?task ?status WHERE { ?task prop:builtin.task-status ?status } ORDER BY ?task",
        );
        let QueryResult::Select {
            variables: incremental_variables,
            rows: incremental_rows,
            frontier: incremental_frontier,
            ..
        } = incremental.execute(query.clone()).unwrap()
        else {
            panic!("expected SELECT")
        };
        let QueryResult::Select {
            variables: rebuilt_variables,
            rows: rebuilt_rows,
            frontier: rebuilt_frontier,
            ..
        } = rebuilt.execute(query).unwrap()
        else {
            panic!("expected SELECT")
        };
        assert_eq!(incremental_variables, rebuilt_variables);
        assert_eq!(incremental_rows, rebuilt_rows);
        assert_eq!(incremental_frontier, rebuilt_frontier);
    }

    #[test]
    fn page_and_tag_delta_matches_rebuild_and_retracts_removed_entities() {
        let mut source = snapshot();
        let mut incremental = GraphIndex::new(&source).unwrap();
        source.pages[0].blocks[0].markdown = "Delta text".into();
        source.tags[0].name = "Renamed".into();
        let frontier = snapshot_fingerprint(&source).unwrap();
        assert!(
            incremental
                .apply_delta(IndexDelta {
                    pages: vec![source.pages[0].clone()],
                    removed_pages: vec![],
                    tags: vec![source.tags[0].clone()],
                    removed_tags: vec![],
                    frontier,
                })
                .unwrap()
        );
        let rebuilt = GraphIndex::new(&source).unwrap();
        assert_eq!(incremental.semantic_triples(), rebuilt.semantic_triples());
        assert_eq!(incremental.frontier(), rebuilt.frontier());
        assert!(matches!(
            incremental
                .execute(request(
                    "PREFIX neo: <urn:neoseq:vocab:v1:> ASK { ?item neo:content ?content . FILTER(neo:matchesText(?content, \"delta text\")) }",
                ))
                .unwrap(),
            QueryResult::Ask { value: true, .. }
        ));

        let page_id = source.pages.remove(0).id;
        let tag_id = source.tags.remove(0).id;
        let frontier = snapshot_fingerprint(&source).unwrap();
        incremental
            .apply_delta(IndexDelta {
                pages: vec![],
                removed_pages: vec![page_id],
                tags: vec![],
                removed_tags: vec![tag_id],
                frontier,
            })
            .unwrap();
        let rebuilt = GraphIndex::new(&source).unwrap();
        assert_eq!(incremental.semantic_triples(), rebuilt.semantic_triples());
        assert_eq!(incremental.frontier(), rebuilt.frontier());
        assert_eq!(incremental.triple_count(), 0);
    }

    #[test]
    fn property_postings_track_page_replacements() {
        let mut source = snapshot();
        let mut index = GraphIndex::new(&source).unwrap();
        let block = entity_iri(&source.graph_id, "block", "todo-1")
            .unwrap()
            .as_str()
            .to_owned();
        let predicate = format!("{PROPERTY_NS}builtin.task-status");
        let todo: Term = Literal::new_simple_literal("todo").into();
        let done: Term = Literal::new_simple_literal("done").into();
        let id = index.text_index.id(&block).unwrap();
        assert!(index.property_index.exact(&predicate, &todo).contains(id));
        assert!(!index.property_index.exact(&predicate, &done).contains(id));

        source.pages[0].blocks[0].properties[0] =
            single("builtin.task-status", PropertyValue::String("done".into()));
        index
            .apply_delta(IndexDelta {
                pages: vec![source.pages[0].clone()],
                removed_pages: vec![],
                tags: vec![],
                removed_tags: vec![],
                frontier: snapshot_fingerprint(&source).unwrap(),
            })
            .unwrap();

        let id = index.text_index.id(&block).unwrap();
        assert!(!index.property_index.exact(&predicate, &todo).contains(id));
        assert!(index.property_index.exact(&predicate, &done).contains(id));
    }

    #[test]
    fn budget_limits_fail_before_returning_partial_rows() {
        let index = GraphIndex::new(&snapshot()).unwrap();

        let mut source = request("ASK {}");
        source.budget.max_source_bytes = 1;
        assert!(matches!(
            index.execute(source),
            Err(QueryError::SourceBudget)
        ));

        let mut raised_source = request(&" ".repeat(QueryBudget::default().max_source_bytes + 1));
        raised_source.budget.max_source_bytes = usize::MAX;
        assert!(matches!(
            index.execute(raised_source),
            Err(QueryError::SourceBudget)
        ));

        let mut bindings = request("ASK {}");
        bindings.budget.max_bindings = 0;
        bindings.bindings.insert(
            "value".into(),
            RdfTerm::Literal {
                value: "x".into(),
                datatype: xsd::STRING.as_str().into(),
                language: None,
            },
        );
        assert!(matches!(
            index.execute(bindings),
            Err(QueryError::BindingBudget)
        ));

        let mut algebra = request("ASK { ?s ?p ?o }");
        algebra.budget.max_algebra_operators = 0;
        assert!(matches!(
            index.execute(algebra),
            Err(QueryError::AlgebraBudget)
        ));

        let mut rows = request("SELECT ?s ?p ?o WHERE { ?s ?p ?o }");
        rows.budget.max_rows = 1;
        assert!(matches!(index.execute(rows), Err(QueryError::RowBudget)));
    }
}
