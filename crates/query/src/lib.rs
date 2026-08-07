//! Reproducible RDF projection and read-only SPARQL execution.

use domain::{BlockSnapshot, GraphId, GraphSnapshot, PageId, PropertyBag, PropertyValue, TagId};
use oxigraph::model::{
    GraphNameRef, Literal, NamedNode, QuadRef, Term, Triple, Variable,
    vocab::{rdf, xsd},
};
use oxigraph::sparql::{QueryResults, SparqlEvaluator};
use oxigraph::store::Store;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use spargebra::algebra::GraphPattern;
use spargebra::term::GroundTerm;
use spargebra::{Query, SparqlParser};
use std::{
    collections::{BTreeMap, HashSet},
    sync::Arc,
};
use thiserror::Error;

pub const QUERY_LANGUAGE: &str = "sparql-1.1/neoseq-v1";
pub const PROJECTION_VERSION: u32 = 1;
pub const ANALYZER_VERSION: u32 = 1;

pub const NEO_NS: &str = "urn:neoseq:vocab:v1:";
pub const PROPERTY_NS: &str = "urn:neoseq:property:";
pub const DEFAULT_PROPERTY_NS: &str = "urn:neoseq:default-property:";
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

/// One open graph's derived RDF index. Oxigraph's in-memory store provides the
/// dictionary and SPO/POS/OSP-family indexes. `entities` is the projection
/// ledger used to retract and replace an entity atomically.
pub struct GraphIndex {
    graph_id: GraphId,
    store: Store,
    entities: BTreeMap<String, HashSet<Triple>>,
    entity_refs: BTreeMap<String, QueryEntityRef>,
    normalized_text: Arc<BTreeMap<String, String>>,
    revision: u64,
    frontier: String,
}

impl GraphIndex {
    pub fn new(snapshot: &GraphSnapshot) -> Result<Self, QueryError> {
        let frontier = snapshot_fingerprint(snapshot)?;
        Self::new_at(snapshot, frontier)
    }

    pub fn new_at(snapshot: &GraphSnapshot, frontier: String) -> Result<Self, QueryError> {
        let mut index = Self {
            graph_id: snapshot.graph_id.clone(),
            store: Store::new().map_err(index_error)?,
            entities: BTreeMap::new(),
            entity_refs: BTreeMap::new(),
            normalized_text: Arc::new(BTreeMap::new()),
            revision: 0,
            frontier: String::new(),
        };
        index.refresh_at(snapshot, frontier)?;
        Ok(index)
    }

    /// Reprojects the immutable domain snapshot, but applies only entity-level
    /// triple differences. The store transaction is the publication boundary.
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
        let projected = project(snapshot)?;
        let previous_triples = flatten(&self.entities);
        let next_triples = flatten(&projected.entities);
        if previous_triples == next_triples && self.frontier == next_frontier {
            return Ok(false);
        }

        let mut transaction = self.store.start_transaction().map_err(index_error)?;
        for triple in previous_triples.difference(&next_triples) {
            transaction.remove(QuadRef::new(
                triple.subject.as_ref(),
                triple.predicate.as_ref(),
                triple.object.as_ref(),
                GraphNameRef::DefaultGraph,
            ));
        }
        for triple in next_triples.difference(&previous_triples) {
            transaction.insert(QuadRef::new(
                triple.subject.as_ref(),
                triple.predicate.as_ref(),
                triple.object.as_ref(),
                GraphNameRef::DefaultGraph,
            ));
        }
        transaction.commit().map_err(index_error)?;
        self.entities = projected.entities;
        self.entity_refs = projected.entity_refs;
        self.normalized_text = Arc::new(projected.normalized_text);
        self.frontier = next_frontier;
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

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn frontier(&self) -> &str {
        &self.frontier
    }

    pub fn triple_count(&self) -> usize {
        self.entities.values().map(HashSet::len).sum()
    }

    pub fn semantic_triples(&self) -> Vec<String> {
        let mut triples = flatten(&self.entities)
            .into_iter()
            .map(|triple| triple.to_string())
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

struct Projection {
    entities: BTreeMap<String, HashSet<Triple>>,
    entity_refs: BTreeMap<String, QueryEntityRef>,
    normalized_text: BTreeMap<String, String>,
}

fn project(snapshot: &GraphSnapshot) -> Result<Projection, QueryError> {
    let mut projection = Projection {
        entities: BTreeMap::new(),
        entity_refs: BTreeMap::new(),
        normalized_text: BTreeMap::new(),
    };
    for page in &snapshot.pages {
        let page_iri = entity_iri(&snapshot.graph_id, "page", page.id.as_str())?;
        projection.entity_refs.insert(
            page_iri.as_str().to_owned(),
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
            &snapshot.graph_id,
        )?;
        add_tags(&mut triples, &page_iri, &page.tags, &snapshot.graph_id)?;
        projection
            .normalized_text
            .insert(page.title.clone(), normalize_text(&page.title));
        projection
            .entities
            .insert(page_iri.as_str().to_owned(), triples);
        for (index, block) in page.blocks.iter().enumerate() {
            project_block(
                &mut projection,
                &snapshot.graph_id,
                &page.id,
                &page_iri,
                block,
                index,
            )?;
        }
    }
    for tag in &snapshot.tags {
        let tag_iri = entity_iri(&snapshot.graph_id, "tag", tag.id.as_str())?;
        projection.entity_refs.insert(
            tag_iri.as_str().to_owned(),
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
            &snapshot.graph_id,
        )?;
        add_properties(
            &mut triples,
            &tag_iri,
            &tag.defaults,
            DEFAULT_PROPERTY_NS,
            &snapshot.graph_id,
        )?;
        projection
            .entities
            .insert(tag_iri.as_str().to_owned(), triples);
    }
    Ok(projection)
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
    projection.entity_refs.insert(
        block_iri.as_str().to_owned(),
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
        .normalized_text
        .insert(block.markdown.clone(), normalize_text(&block.markdown));
    projection
        .entities
        .insert(block_iri.as_str().to_owned(), triples);
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
    for entry in bag {
        let predicate = named(&format!(
            "{namespace}{}",
            encode_component(entry.key.as_str())
        ))?;
        let value: Term = match &entry.value {
            PropertyValue::Number(value) => Literal::from(*value).into(),
            PropertyValue::String(value) => Literal::new_simple_literal(value).into(),
            PropertyValue::Page(page_id) => entity_iri(graph_id, "page", page_id.as_str())?.into(),
            PropertyValue::Checkbox(value) => Literal::from(*value).into(),
            PropertyValue::Date(value) => {
                Literal::new_typed_literal(value.as_str(), xsd::DATE).into()
            }
            PropertyValue::Query(value) => {
                triples.insert(Triple::new(
                    subject.clone(),
                    named(&format!("{namespace}builtin.query-language"))?,
                    Literal::new_simple_literal(&value.language),
                ));
                Literal::new_simple_literal(&value.source).into()
            }
        };
        triples.insert(Triple::new(subject.clone(), predicate, value));
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

pub fn property_iri(key: &str) -> Result<NamedNode, QueryError> {
    named(&format!("{PROPERTY_NS}{}", encode_component(key)))
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

fn flatten(entities: &BTreeMap<String, HashSet<Triple>>) -> HashSet<Triple> {
    entities
        .values()
        .flat_map(|triples| triples.iter().cloned())
        .collect()
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
    use domain::{BlockId, LocalDate, PageSnapshot, PropertyEntry, PropertyKey, TagSnapshot};

    fn snapshot() -> GraphSnapshot {
        GraphSnapshot {
            schema_version: 4,
            graph_id: GraphId::new("query graph").unwrap(),
            pages: vec![PageSnapshot {
                id: PageId::new("today").unwrap(),
                title: "Today".into(),
                properties: vec![
                    PropertyEntry {
                        key: PropertyKey::new("custom.count").unwrap(),
                        value: PropertyValue::Number(3.5),
                    },
                    PropertyEntry {
                        key: PropertyKey::new("custom.flag").unwrap(),
                        value: PropertyValue::Checkbox(true),
                    },
                    PropertyEntry {
                        key: PropertyKey::new("custom.link").unwrap(),
                        value: PropertyValue::Page(PageId::new("missing-page").unwrap()),
                    },
                    PropertyEntry {
                        key: PropertyKey::new("custom.alias").unwrap(),
                        value: PropertyValue::String("one".into()),
                    },
                    PropertyEntry {
                        key: PropertyKey::new("custom.alias").unwrap(),
                        value: PropertyValue::String("two".into()),
                    },
                ],
                tags: vec![TagId::new("project").unwrap()],
                blocks: vec![BlockSnapshot {
                    id: BlockId::new("todo-1").unwrap(),
                    markdown: "Ship the Query Engine".into(),
                    properties: vec![
                        PropertyEntry {
                            key: PropertyKey::new("builtin.task-status").unwrap(),
                            value: PropertyValue::String("todo".into()),
                        },
                        PropertyEntry {
                            key: PropertyKey::new("builtin.deadline").unwrap(),
                            value: PropertyValue::Date(LocalDate::new("2026-08-05").unwrap()),
                        },
                    ],
                    tags: vec![TagId::new("project").unwrap()],
                    children: vec![],
                }],
            }],
            tags: vec![TagSnapshot {
                id: TagId::new("project").unwrap(),
                name: "Project".into(),
                properties: vec![],
                defaults: vec![PropertyEntry {
                    key: PropertyKey::new("builtin.priority").unwrap(),
                    value: PropertyValue::String("high".into()),
                }],
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
        assert_eq!(index.triple_count(), 19);
        let triples = index.semantic_triples().join("\n");
        assert!(triples.contains("urn:neoseq:property:builtin.task-status"));
        assert!(triples.contains("urn:neoseq:default-property:builtin.priority"));
        assert!(triples.contains("missing-page"));
        assert!(triples.contains(xsd::BOOLEAN.as_str()));
        assert!(triples.contains(xsd::DOUBLE.as_str()));
        assert!(triples.contains("urn:neoseq:vocab:v1:parent"));
        assert!(triples.contains("query%20graph"));
    }

    #[test]
    fn sparql_executes_select_with_typed_binding_and_entity_metadata() {
        let index = GraphIndex::new(&snapshot()).unwrap();
        let mut query = request(
            "PREFIX neo: <urn:neoseq:vocab:v1:>\n\
             PREFIX prop: <urn:neoseq:property:>\n\
             SELECT ?block ?deadline WHERE {\n\
               ?block a neo:Block; prop:builtin.task-status \"todo\";\n\
                 prop:builtin.deadline ?deadline; neo:content ?content.\n\
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
        source.pages[0].blocks[0].properties[0].value = PropertyValue::String("done".into());
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
