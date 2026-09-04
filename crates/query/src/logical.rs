//! Typed query algebra shared by authored plans and raw SPARQL.
//!
//! [`LogicalQuery`] owns SPARQL algebra, not source text. Product query
//! compilers can build it directly, while the raw-SPARQL compatibility path
//! parses once into the same representation.

use crate::QueryError;
use spargebra::{Query, SparqlParser};

pub use oxigraph::model::{Literal, NamedNode, Variable};
pub use spargebra::algebra::{Expression, GraphPattern, OrderExpression};
pub use spargebra::term::{NamedNodePattern, TermPattern, TriplePattern};

/// The execution representation of a query.
///
/// This is intentionally process-local and is not a second persisted query
/// format. A stored product plan should compile directly to this type; stored
/// raw SPARQL should be parsed into it at the boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogicalQuery {
    algebra: Query,
}

impl LogicalQuery {
    /// Parses the raw-SPARQL compatibility representation once, after
    /// `GraphIndex::execute` has enforced its source-size budget.
    pub(crate) fn from_sparql(source: &str) -> Result<Self, QueryError> {
        let algebra = SparqlParser::new()
            .parse_query(source)
            .map_err(|error| QueryError::Syntax(error.to_string()))?;
        Ok(Self { algebra })
    }

    /// Starts a typed SELECT query over an already-built logical pattern.
    pub fn select(
        pattern: GraphPattern,
        variables: impl IntoIterator<Item = Variable>,
    ) -> LogicalSelect {
        LogicalSelect {
            pattern,
            variables: variables.into_iter().collect(),
            order_by: Vec::new(),
            distinct: false,
            offset: 0,
            limit: None,
        }
    }

    /// Builds a typed ASK query without producing or parsing query text.
    pub fn ask(pattern: GraphPattern) -> Self {
        Self {
            algebra: Query::Ask {
                dataset: None,
                pattern,
                base_iri: None,
            },
        }
    }

    pub(crate) fn into_algebra(self) -> Query {
        self.algebra
    }

    pub(crate) fn to_sparql(&self) -> String {
        self.algebra.to_string()
    }
}

/// Builder for SELECT solution modifiers around a typed graph pattern.
///
/// Its lowering order follows SPARQL algebra: order, projection, duplicate
/// elimination, then slicing. The resulting tree is the same kind consumed by
/// the raw-SPARQL path and by the existing index planners.
#[derive(Debug, Clone)]
pub struct LogicalSelect {
    pattern: GraphPattern,
    variables: Vec<Variable>,
    order_by: Vec<OrderExpression>,
    distinct: bool,
    offset: usize,
    limit: Option<usize>,
}

impl LogicalSelect {
    pub fn order_by(mut self, order_by: impl IntoIterator<Item = OrderExpression>) -> Self {
        self.order_by = order_by.into_iter().collect();
        self
    }

    pub fn distinct(mut self) -> Self {
        self.distinct = true;
        self
    }

    pub fn offset(mut self, offset: usize) -> Self {
        self.offset = offset;
        self
    }

    pub fn limit(mut self, limit: usize) -> Self {
        self.limit = Some(limit);
        self
    }

    pub fn build(self) -> LogicalQuery {
        let mut pattern = self.pattern;
        if !self.order_by.is_empty() {
            pattern = GraphPattern::OrderBy {
                inner: Box::new(pattern),
                expression: self.order_by,
            };
        }
        pattern = GraphPattern::Project {
            inner: Box::new(pattern),
            variables: self.variables,
        };
        if self.distinct {
            pattern = GraphPattern::Distinct {
                inner: Box::new(pattern),
            };
        }
        if self.offset > 0 || self.limit.is_some() {
            pattern = GraphPattern::Slice {
                inner: Box::new(pattern),
                start: self.offset,
                length: self.limit,
            };
        }
        LogicalQuery {
            algebra: Query::Select {
                dataset: None,
                pattern,
                base_iri: None,
            },
        }
    }
}

/// Constructs a typed triple pattern without exposing source-string assembly.
pub fn triple(
    subject: impl Into<TermPattern>,
    predicate: impl Into<NamedNodePattern>,
    object: impl Into<TermPattern>,
) -> TriplePattern {
    TriplePattern {
        subject: subject.into(),
        predicate: predicate.into(),
        object: object.into(),
    }
}

/// Constructs one basic graph pattern from typed triples.
pub fn bgp(patterns: impl IntoIterator<Item = TriplePattern>) -> GraphPattern {
    GraphPattern::Bgp {
        patterns: patterns.into_iter().collect(),
    }
}
