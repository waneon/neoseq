//! Reproducible RDF projection and read-only SPARQL execution.

use domain::{
    BlockSnapshot, GraphId, GraphSnapshot, PageId, PageSnapshot, PropertyBag, PropertyValue, TagId,
    TagSnapshot,
};
use oxigraph::model::{
    GraphNameRef, Literal, NamedNode, Quad, QuadRef, Term, Triple, Variable,
    vocab::{rdf, xsd},
};
use oxigraph::sparql::{QueryResults, SparqlEvaluator};
use oxigraph::store::{StorageError, Store, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use spargebra::algebra::GraphPattern;
use spargebra::term::GroundTerm;
use spargebra::{Query, SparqlParser};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum QueryEntityRef {
    Page { id: String },
    Block { page_id: String, id: String },
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

/// One open graph's derived RDF index. Oxigraph's in-memory store provides the
/// dictionary and SPO/POS/OSP-family indexes. The compact page ledger names
/// subjects to retract and replace atomically without duplicating their triples.
pub struct GraphIndex {
    graph_id: GraphId,
    store: Store,
    entity_refs: HashMap<String, QueryEntityRef>,
    page_entities: HashMap<PageId, BTreeSet<String>>,
    page_text: HashMap<PageId, Vec<String>>,
    text_ref_counts: HashMap<String, usize>,
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
            page_entities: projected.page_entities,
            page_text: projected.page_text,
            text_ref_counts: projected.text_ref_counts,
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
        let mut page_ids = delta.removed_pages.into_iter().collect::<BTreeSet<_>>();
        for page in &delta.pages {
            page_ids.insert(page.id.clone());
            project_page(&mut projected, &self.graph_id, page)?;
        }
        for page_id in &page_ids {
            if let Some(keys) = self.page_entities.get(page_id) {
                replaced.extend(keys.iter().cloned());
            }
            if let Some(keys) = projected.page_entities.get(page_id) {
                replaced.extend(keys.iter().cloned());
            }
        }

        for tag in &delta.tags {
            let key = entity_iri(&self.graph_id, "tag", tag.id.as_str())?
                .as_str()
                .to_owned();
            replaced.insert(key);
            project_tag(&mut projected, &self.graph_id, tag)?;
        }
        for tag_id in delta.removed_tags {
            replaced.insert(
                entity_iri(&self.graph_id, "tag", tag_id.as_str())?
                    .as_str()
                    .to_owned(),
            );
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
        for page_id in page_ids {
            if let Some(values) = self.page_text.remove(&page_id) {
                for value in values {
                    self.remove_text(&value);
                }
            }
            self.page_entities.remove(&page_id);
            if let Some(keys) = projected.page_entities.remove(&page_id) {
                let values = keys
                    .iter()
                    .filter_map(|key| projected.entity_text.get(key).cloned())
                    .collect::<Vec<_>>();
                for value in &values {
                    self.insert_text(value);
                }
                self.page_text.insert(page_id.clone(), values);
                self.page_entities.insert(page_id, keys);
            }
        }
        self.frontier = delta.frontier;
        self.revision = self.revision.saturating_add(1);
        Ok(true)
    }

    fn remove_text(&mut self, value: &str) {
        let Some(count) = self.text_ref_counts.get_mut(value) else {
            return;
        };
        *count -= 1;
        if *count == 0 {
            self.text_ref_counts.remove(value);
            Arc::make_mut(&mut self.normalized_text).remove(value);
        }
    }

    fn insert_text(&mut self, value: &str) {
        let count = self.text_ref_counts.entry(value.to_owned()).or_default();
        *count += 1;
        if *count == 1 {
            Arc::make_mut(&mut self.normalized_text)
                .insert(value.to_owned(), normalize_text(value));
        }
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
        validate_query(&query, budget.max_algebra_operators)?;
        inject_query_bindings(&mut query, request.bindings)?;

        let normalized_text = self.normalized_text.clone();
        let matcher = NamedNode::new(MATCHES_TEXT).map_err(term_error)?;
        let prepared = SparqlEvaluator::new()
            .with_custom_function(matcher, move |arguments| {
                let [Term::Literal(content), Term::Literal(needle)] = arguments else {
                    return None;
                };
                let normalized = normalized_text
                    .get(content.value())
                    .cloned()
                    .unwrap_or_else(|| normalize_text(content.value()));
                Some(Literal::from(normalized.contains(&normalize_text(needle.value()))).into())
            })
            .for_query(query);

        match prepared
            .on_store(&self.store)
            .execute()
            .map_err(|error| QueryError::Evaluation(error.to_string()))?
        {
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
    page_entities: BTreeMap<PageId, BTreeSet<String>>,
    entity_text: BTreeMap<String, String>,
}

struct ProjectionStream<I> {
    graph_id: GraphId,
    units: I,
    pending: std::vec::IntoIter<Quad>,
    entity_refs: HashMap<String, QueryEntityRef>,
    page_entities: HashMap<PageId, BTreeSet<String>>,
    page_text: HashMap<PageId, Vec<String>>,
    text_ref_counts: HashMap<String, usize>,
    normalized_text: HashMap<String, String>,
    triple_count: usize,
}

struct ProjectionBuild {
    entity_refs: HashMap<String, QueryEntityRef>,
    page_entities: HashMap<PageId, BTreeSet<String>>,
    page_text: HashMap<PageId, Vec<String>>,
    text_ref_counts: HashMap<String, usize>,
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
            page_entities: HashMap::new(),
            page_text: HashMap::new(),
            text_ref_counts: HashMap::new(),
            normalized_text: HashMap::new(),
            triple_count: 0,
        }
    }

    fn finish(self) -> ProjectionBuild {
        ProjectionBuild {
            entity_refs: self.entity_refs,
            page_entities: self.page_entities,
            page_text: self.page_text,
            text_ref_counts: self.text_ref_counts,
            normalized_text: self.normalized_text,
            triple_count: self.triple_count,
        }
    }

    fn project_unit(&mut self, unit: IndexUnit) -> Result<(), QueryError> {
        let mut projected = Projection::default();
        let page_id = match unit {
            IndexUnit::Page(page) => {
                let page_id = page.id.clone();
                project_page(&mut projected, &self.graph_id, &page)?;
                Some(page_id)
            }
            IndexUnit::Tag(tag) => {
                project_tag(&mut projected, &self.graph_id, &tag)?;
                None
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

        if let Some(page_id) = page_id {
            let keys = projected.page_entities.remove(&page_id).unwrap_or_default();
            let values = keys
                .iter()
                .filter_map(|key| projected.entity_text.get(key).cloned())
                .collect::<Vec<_>>();
            for value in &values {
                insert_text_cache(&mut self.text_ref_counts, &mut self.normalized_text, value);
            }
            self.page_entities.insert(page_id.clone(), keys);
            self.page_text.insert(page_id, values);
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
        .page_entities
        .entry(page.id.clone())
        .or_default()
        .insert(key.clone());
    projection
        .entity_text
        .insert(key.clone(), page.title.clone());
    projection.entities.insert(key, triples);
    for (index, block) in page.blocks.iter().enumerate() {
        project_block(projection, graph_id, &page.id, &page_iri, block, index)?;
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
    projection.entities.insert(key, triples);
    Ok(())
}

fn project_block(
    projection: &mut Projection,
    graph_id: &GraphId,
    page_id: &PageId,
    parent: &NamedNode,
    block: &BlockSnapshot,
    sibling_index: usize,
) -> Result<(), QueryError> {
    let block_iri = entity_iri(graph_id, "block", block.id.as_str())?;
    let page_iri = entity_iri(graph_id, "page", page_id.as_str())?;
    let key = block_iri.as_str().to_owned();
    projection.entity_refs.insert(
        key.clone(),
        QueryEntityRef::Block {
            page_id: page_id.to_string(),
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
    triples.insert(Triple::new(block_iri.clone(), named_ref("page")?, page_iri));
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
        .page_entities
        .entry(page_id.clone())
        .or_default()
        .insert(key.clone());
    projection
        .entity_text
        .insert(key.clone(), block.markdown.clone());
    projection.entities.insert(key, triples);
    for (index, child) in block.children.iter().enumerate() {
        project_block(projection, graph_id, page_id, &block_iri, child, index)?;
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

fn validate_query(query: &Query, max_operators: usize) -> Result<(), QueryError> {
    let sse = query.to_sse();
    let dataset = match query {
        Query::Select { dataset, .. } | Query::Ask { dataset, .. } => dataset,
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
    Ok(())
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
    inject_values(pattern, variables, row);
    Ok(())
}

/// Inserts an algebraic VALUES row inside solution modifiers. This gives bound
/// variables normal SPARQL join semantics without rewriting query text, while
/// preserving the SELECT projection exactly as authored.
fn inject_values(
    pattern: &mut GraphPattern,
    variables: Vec<Variable>,
    row: Vec<Option<GroundTerm>>,
) {
    match pattern {
        GraphPattern::Filter { inner, .. }
        | GraphPattern::Extend { inner, .. }
        | GraphPattern::OrderBy { inner, .. }
        | GraphPattern::Project { inner, .. }
        | GraphPattern::Distinct { inner }
        | GraphPattern::Reduced { inner }
        | GraphPattern::Slice { inner, .. }
        | GraphPattern::Group { inner, .. } => inject_values(inner, variables, row),
        _ => {
            let original = std::mem::replace(pattern, GraphPattern::Bgp { patterns: vec![] });
            *pattern = GraphPattern::Join {
                left: Box::new(GraphPattern::Values {
                    variables,
                    bindings: vec![row],
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

fn insert_text_cache(
    counts: &mut HashMap<String, usize>,
    normalized: &mut HashMap<String, String>,
    value: &str,
) {
    let count = counts.entry(value.to_owned()).or_default();
    *count += 1;
    if *count == 1 {
        normalized.insert(value.to_owned(), normalize_text(value));
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
        BlockId, Cardinality, LocalDate, PageSnapshot, PropertyField, PropertyKey, PropertyType,
        TagSnapshot,
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
            schema_version: 1,
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
            }],
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
    fn projects_entities_properties_tags_and_hierarchy() {
        let index = GraphIndex::new(&snapshot()).unwrap();
        assert_eq!(index.triple_count(), 27);
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
    /// an aggregate alias used as a sort key. A change here breaks every built
    /// query.
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
             ORDER BY DESC(?c2) ?c0 ?item\n\
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
