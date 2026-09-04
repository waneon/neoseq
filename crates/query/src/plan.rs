//! The product query grammar and its direct lowering to logical algebra.

use crate::{
    LogicalQuery, QueryBudget, QueryError, RdfTerm,
    logical::{GraphPattern, NamedNode, OrderExpression, TermPattern, Variable, bgp, triple},
};
use domain::{
    GraphId, LocalDate, PropertyKey, PropertyType, PropertyValueSpec, QueryPlan as StoredQueryPlan,
    StringSpec, definition,
};
pub use domain::{
    PLAN_ANY_OF_MAX, PLAN_LIMIT_MAX, PLAN_MAX_CONDITIONS, PLAN_MAX_DEPTH, QUERY_PLAN_VERSION,
};
use oxigraph::model::{Literal, vocab::rdf, vocab::xsd};
use serde::{Deserialize, Deserializer, Serialize, Serializer, de};
use spargebra::algebra::{
    AggregateExpression, AggregateFunction, Expression, Function, PropertyPathExpression,
};
use std::collections::{BTreeMap, HashSet};

const PLAN_MAX_NODES: usize = 256;
const PLAN_MAX_COLUMNS: usize = 128;
const SUBJECT_VARIABLE: &str = "q_subject";
const LIST_SEPARATOR: &str = "\u{1f}";
pub const DERIVED_SOURCE_PROVENANCE: &str = domain::QUERY_PLAN_SOURCE_PROVENANCE;

/// A builder result bound that is valid by construction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlanLimit(u16);

impl PlanLimit {
    pub fn new(value: usize) -> Result<Self, QueryError> {
        if !(1..=PLAN_LIMIT_MAX).contains(&value) {
            return Err(invalid_plan("plan limit is out of range"));
        }
        Ok(Self(value as u16))
    }

    pub const fn get(self) -> usize {
        self.0 as usize
    }
}

impl Serialize for PlanLimit {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_u16(self.0)
    }
}

impl<'de> Deserialize<'de> for PlanLimit {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = usize::deserialize(deserializer)?;
        Self::new(value).map_err(de::Error::custom)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanSubject {
    Block,
    Page,
    Tag,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PlanField {
    Content,
    Property { key: String },
    Tag,
    Page,
    Ancestor,
    SiblingIndex,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanOperator {
    Contains,
    NotContains,
    StartsWith,
    EndsWith,
    Equals,
    NotEquals,
    AnyOf,
    Lt,
    Lte,
    Gt,
    Gte,
    Between,
    IsTrue,
    IsFalse,
    IsSet,
    IsEmpty,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelativeDateUnit {
    Day,
    Week,
    Month,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanRelativeDate {
    pub unit: RelativeDateUnit,
    pub offset: i32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PlanValue {
    Text { value: String },
    Number { value: f64 },
    Date { value: String },
    Relative { value: PlanRelativeDate },
    Page { value: String },
    Tag { value: String },
    List { values: Vec<String> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanMatch {
    All,
    Any,
    None,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PlanNode {
    Condition {
        id: String,
        field: PlanField,
        op: PlanOperator,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<PlanValue>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value2: Option<PlanValue>,
    },
    Group {
        id: String,
        #[serde(rename = "match")]
        mode: PlanMatch,
        children: Vec<PlanNode>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PlanColumnSource {
    Subject,
    Content,
    Page,
    Property { key: String },
    Tags,
    Parent,
    SiblingIndex,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanAggregate {
    List,
    Count,
    Sum,
    Avg,
    Min,
    Max,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanColumn {
    pub id: String,
    pub source: PlanColumnSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aggregate: Option<PlanAggregate>,
}

/// The single persisted authoring representation used by the product builder.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BuiltQueryPlan {
    pub version: u32,
    pub subject: PlanSubject,
    #[serde(rename = "where")]
    pub where_clause: PlanNode,
    pub columns: Vec<PlanColumn>,
    pub limit: PlanLimit,
    #[serde(default)]
    pub distinct: bool,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BuiltQueryProjection {
    #[default]
    View,
    Entities,
}

/// The authored query crossing CorePort.
///
/// A built query carries its plan as authority. Raw SPARQL remains an explicit
/// escape hatch rather than an alternative field that can disagree with it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AuthoredQueryRequest {
    Built {
        plan: BuiltQueryPlan,
        today: LocalDate,
        #[serde(default)]
        projection: BuiltQueryProjection,
        #[serde(default)]
        budget: QueryBudget,
    },
    RawSparql {
        language: String,
        source: String,
        #[serde(default)]
        bindings: BTreeMap<String, RdfTerm>,
        #[serde(default)]
        budget: QueryBudget,
    },
}

impl BuiltQueryPlan {
    pub(crate) fn compile(
        &self,
        graph_id: &GraphId,
        today: &LocalDate,
        projection: BuiltQueryProjection,
    ) -> Result<LogicalQuery, QueryError> {
        self.validate()?;
        PlanCompiler::direct(graph_id, today, self.subject).compile(self, projection)
    }

    fn validate(&self) -> Result<(), QueryError> {
        if self.version != QUERY_PLAN_VERSION {
            return Err(invalid_plan(format!(
                "unsupported plan version: {}",
                self.version
            )));
        }
        if self.columns.is_empty() || self.columns.len() > PLAN_MAX_COLUMNS {
            return Err(invalid_plan("plan column count is out of range"));
        }
        let mut variables = HashSet::new();
        for column in &self.columns {
            if column.id.is_empty() {
                return Err(invalid_plan("column id must not be empty"));
            }
            validate_column_source(self.subject, &column.source)?;
            let variable = column_variable(column);
            if !variables.insert(variable) {
                return Err(invalid_plan("column ids produce duplicate variables"));
            }
        }
        let PlanNode::Group { .. } = &self.where_clause else {
            return Err(invalid_plan("the root where node must be a group"));
        };
        let mut nodes = 0;
        let mut conditions = 0;
        validate_node(
            &self.where_clause,
            self.subject,
            0,
            &mut nodes,
            &mut conditions,
        )
    }
}

/// Derives the non-authoritative SPARQL artifact stored beside a built plan.
///
/// Its operands remain parameters because relative dates are execution inputs,
/// not persisted dates. Built execution never reads this source.
pub fn derive_plan_source(plan: &StoredQueryPlan) -> Result<String, QueryError> {
    plan.validate()
        .map_err(|error| invalid_plan(error.to_string()))?;
    let typed: BuiltQueryPlan =
        serde_json::from_str(&plan.payload).map_err(|error| invalid_plan(error.to_string()))?;
    if typed.version != plan.version {
        return Err(invalid_plan("plan envelope and payload versions disagree"));
    }
    typed.validate()?;
    let logical =
        PlanCompiler::parameterized(typed.subject).compile(&typed, BuiltQueryProjection::View)?;
    Ok(format!(
        "{}{version};fnv1a32={hash:08x}\n{}\n",
        DERIVED_SOURCE_PROVENANCE,
        logical.to_sparql(),
        version = plan.version,
        hash = fnv1a32(plan.payload.as_bytes()),
    ))
}

fn fnv1a32(bytes: &[u8]) -> u32 {
    bytes.iter().fold(0x811c_9dc5, |hash, byte| {
        (hash ^ u32::from(*byte)).wrapping_mul(0x0100_0193)
    })
}

fn validate_node(
    node: &PlanNode,
    subject: PlanSubject,
    depth: usize,
    nodes: &mut usize,
    conditions: &mut usize,
) -> Result<(), QueryError> {
    *nodes += 1;
    if *nodes > PLAN_MAX_NODES {
        return Err(invalid_plan("plan has too many nodes"));
    }
    match node {
        PlanNode::Condition {
            id,
            field,
            op,
            value,
            value2,
        } => {
            if id.is_empty() {
                return Err(invalid_plan("condition id must not be empty"));
            }
            *conditions += 1;
            if *conditions > PLAN_MAX_CONDITIONS {
                return Err(invalid_plan("plan has too many conditions"));
            }
            validate_field(subject, field)?;
            if !operators_for(field).contains(op) {
                return Err(invalid_plan("operator is not valid for its field"));
            }
            let takes_value = !matches!(
                op,
                PlanOperator::IsSet
                    | PlanOperator::IsEmpty
                    | PlanOperator::IsTrue
                    | PlanOperator::IsFalse
            );
            if takes_value != value.is_some() {
                return Err(invalid_plan("operator and value shape disagree"));
            }
            if matches!(op, PlanOperator::Between) != value2.is_some() {
                return Err(invalid_plan("between requires exactly two values"));
            }
            if matches!(op, PlanOperator::AnyOf) != matches!(value, Some(PlanValue::List { .. })) {
                return Err(invalid_plan("any_of requires a list value"));
            }
            if !matches!(op, PlanOperator::AnyOf) && matches!(value, Some(PlanValue::List { .. })) {
                return Err(invalid_plan("only any_of accepts a list value"));
            }
            if let Some(PlanValue::List { values }) = value
                && values.len() > PLAN_ANY_OF_MAX
            {
                return Err(invalid_plan("any_of has too many values"));
            }
            if matches!(value2, Some(PlanValue::List { .. })) {
                return Err(invalid_plan("a range bound must be a scalar"));
            }
            if value
                .as_ref()
                .is_some_and(|value| !value_matches_field(field, value))
                || value2
                    .as_ref()
                    .is_some_and(|value| !value_matches_field(field, value))
            {
                return Err(invalid_plan("value type is not valid for its field"));
            }
            if value.as_ref().is_some_and(invalid_scalar)
                || value2.as_ref().is_some_and(invalid_scalar)
            {
                return Err(invalid_plan("plan contains an invalid scalar"));
            }
        }
        PlanNode::Group { id, children, .. } => {
            if id.is_empty() {
                return Err(invalid_plan("group id must not be empty"));
            }
            if depth >= PLAN_MAX_DEPTH {
                return Err(invalid_plan("plan groups are nested too deeply"));
            }
            for child in children {
                validate_node(child, subject, depth + 1, nodes, conditions)?;
            }
        }
    }
    Ok(())
}

fn invalid_scalar(value: &PlanValue) -> bool {
    match value {
        PlanValue::Number { value } => !value.is_finite(),
        PlanValue::Date { value } => LocalDate::new(value.clone()).is_err(),
        PlanValue::List { .. }
        | PlanValue::Text { .. }
        | PlanValue::Relative { .. }
        | PlanValue::Page { .. }
        | PlanValue::Tag { .. } => false,
    }
}

fn value_matches_field(field: &PlanField, value: &PlanValue) -> bool {
    if matches!(value, PlanValue::List { .. }) {
        return matches!(
            field_type(field),
            FieldType::String | FieldType::Choice | FieldType::Page | FieldType::Tag
        );
    }
    matches!(
        (field_type(field), value),
        (
            FieldType::String | FieldType::Choice,
            PlanValue::Text { .. }
        ) | (
            FieldType::Number | FieldType::Integer,
            PlanValue::Number { .. }
        ) | (
            FieldType::Date,
            PlanValue::Date { .. } | PlanValue::Relative { .. }
        ) | (FieldType::Page, PlanValue::Page { .. })
            | (FieldType::Tag, PlanValue::Tag { .. })
    )
}

fn validate_field(subject: PlanSubject, field: &PlanField) -> Result<(), QueryError> {
    let valid = match subject {
        PlanSubject::Block => true,
        PlanSubject::Page => matches!(
            field,
            PlanField::Content | PlanField::Property { .. } | PlanField::Tag
        ),
        PlanSubject::Tag => matches!(field, PlanField::Content | PlanField::Property { .. }),
    };
    if !valid {
        return Err(invalid_plan("field is not available for the plan subject"));
    }
    if let PlanField::Property { key } = field {
        PropertyKey::new(key.clone()).map_err(|error| invalid_plan(error.to_string()))?;
    }
    Ok(())
}

fn validate_column_source(
    subject: PlanSubject,
    source: &PlanColumnSource,
) -> Result<(), QueryError> {
    let valid = match subject {
        PlanSubject::Block => true,
        PlanSubject::Page => matches!(
            source,
            PlanColumnSource::Subject
                | PlanColumnSource::Content
                | PlanColumnSource::Property { .. }
                | PlanColumnSource::Tags
        ),
        PlanSubject::Tag => matches!(
            source,
            PlanColumnSource::Subject
                | PlanColumnSource::Content
                | PlanColumnSource::Property { .. }
        ),
    };
    if !valid {
        return Err(invalid_plan(
            "column source is not available for the plan subject",
        ));
    }
    if let PlanColumnSource::Property { key } = source {
        PropertyKey::new(key.clone()).map_err(|error| invalid_plan(error.to_string()))?;
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FieldType {
    String,
    Choice,
    Number,
    Checkbox,
    Date,
    Page,
    Tag,
    Integer,
}

fn field_type(field: &PlanField) -> FieldType {
    match field {
        PlanField::Content => FieldType::String,
        PlanField::Tag => FieldType::Tag,
        PlanField::Page | PlanField::Ancestor => FieldType::Page,
        PlanField::SiblingIndex => FieldType::Integer,
        PlanField::Property { key } => PropertyKey::new(key.clone())
            .ok()
            .and_then(|key| definition(&key))
            .map(|spec| match spec.shape.value() {
                PropertyValueSpec::Number => FieldType::Number,
                PropertyValueSpec::Checkbox => FieldType::Checkbox,
                PropertyValueSpec::Date => FieldType::Date,
                PropertyValueSpec::Page => FieldType::Page,
                PropertyValueSpec::String(StringSpec::Suggested(_) | StringSpec::OneOf(_)) => {
                    FieldType::Choice
                }
                PropertyValueSpec::String(StringSpec::Any) | PropertyValueSpec::Document(_) => {
                    FieldType::String
                }
            })
            .unwrap_or(FieldType::String),
    }
}

fn operators_for(field: &PlanField) -> &'static [PlanOperator] {
    use PlanOperator::{
        AnyOf, Between, Contains, EndsWith, Equals, Gt, Gte, IsEmpty, IsFalse, IsSet, IsTrue, Lt,
        Lte, NotContains, NotEquals, StartsWith,
    };
    match field_type(field) {
        FieldType::Checkbox => &[IsTrue, IsFalse, IsSet, IsEmpty],
        FieldType::Number | FieldType::Integer => {
            &[Equals, NotEquals, Gt, Gte, Lt, Lte, Between, IsSet, IsEmpty]
        }
        FieldType::Date => &[Equals, NotEquals, Lt, Lte, Gt, Gte, Between, IsSet, IsEmpty],
        FieldType::Page | FieldType::Tag | FieldType::Choice => {
            &[Equals, NotEquals, AnyOf, IsSet, IsEmpty]
        }
        FieldType::String => &[
            Contains,
            NotContains,
            Equals,
            NotEquals,
            StartsWith,
            EndsWith,
            AnyOf,
            IsSet,
            IsEmpty,
        ],
    }
}

enum OperandMode<'a> {
    Direct {
        graph_id: &'a GraphId,
        today: &'a LocalDate,
    },
    Parameterized {
        next: usize,
    },
}

struct PlanCompiler<'a> {
    operands: OperandMode<'a>,
    subject: PlanSubject,
    subject_variable: Variable,
    local_sequence: usize,
}

impl<'a> PlanCompiler<'a> {
    fn direct(graph_id: &'a GraphId, today: &'a LocalDate, subject: PlanSubject) -> Self {
        Self {
            operands: OperandMode::Direct { graph_id, today },
            subject,
            subject_variable: Variable::new_unchecked(SUBJECT_VARIABLE),
            local_sequence: 0,
        }
    }

    fn parameterized(subject: PlanSubject) -> Self {
        Self {
            operands: OperandMode::Parameterized { next: 0 },
            subject,
            subject_variable: Variable::new_unchecked(SUBJECT_VARIABLE),
            local_sequence: 0,
        }
    }

    fn compile(
        mut self,
        plan: &BuiltQueryPlan,
        projection: BuiltQueryProjection,
    ) -> Result<LogicalQuery, QueryError> {
        let subject_type = named(&format!(
            "{}{}",
            crate::NEO_NS,
            match self.subject {
                PlanSubject::Block => "Block",
                PlanSubject::Page => "Page",
                PlanSubject::Tag => "Tag",
            }
        ))?;
        let root = bgp([triple(
            self.subject_variable.clone(),
            named(rdf::TYPE.as_str())?,
            subject_type,
        )]);
        let (mut pattern, _) = self.apply_node(root, &plan.where_clause)?;

        let mut projection_variables = Vec::new();
        let mut grouped_variables = Vec::new();
        let mut aggregates = Vec::new();
        let mut aggregated = false;
        let columns: &[PlanColumn] = match projection {
            BuiltQueryProjection::View => &plan.columns,
            BuiltQueryProjection::Entities => &[],
        };
        for column in columns {
            let variable = Variable::new(column_variable(column)).map_err(term_error)?;
            if let Some(aggregate) = column.aggregate {
                aggregated = true;
                let inner = if matches!(column.source, PlanColumnSource::Subject) {
                    self.subject_variable.clone()
                } else {
                    self.local("a")
                };
                if !matches!(column.source, PlanColumnSource::Subject) {
                    pattern = self.apply_column(pattern, column, inner.clone())?;
                }
                projection_variables.push(variable.clone());
                aggregates.push((variable, aggregate_expression(aggregate, inner)));
                continue;
            }

            pattern = self.apply_column(pattern, column, variable.clone())?;
            projection_variables.push(variable.clone());
            grouped_variables.push(variable.clone());
            if let Some(time_key) = moment_time_key(column) {
                let companion =
                    Variable::new(format!("q_time_{}", variable.as_str())).map_err(term_error)?;
                pattern = optional(
                    pattern,
                    bgp([triple(
                        self.subject_variable.clone(),
                        property_predicate(time_key)?,
                        companion.clone(),
                    )]),
                );
                projection_variables.push(companion.clone());
                grouped_variables.push(companion);
            }
        }

        if aggregated {
            pattern = GraphPattern::Group {
                inner: Box::new(pattern),
                variables: grouped_variables,
                aggregates,
            };
        } else {
            projection_variables.insert(0, self.subject_variable.clone());
        }

        let mut select = LogicalQuery::select(pattern, projection_variables);
        if !aggregated {
            select = select.order_by([OrderExpression::Asc(self.subject_variable.clone().into())]);
            if plan.distinct {
                select = select.distinct();
            }
        }
        Ok(select.limit(plan.limit.get()).build())
    }

    fn apply_node(
        &mut self,
        base: GraphPattern,
        node: &PlanNode,
    ) -> Result<(GraphPattern, bool), QueryError> {
        match node {
            PlanNode::Condition {
                field,
                op,
                value,
                value2,
                ..
            } => self.apply_condition(base, field, *op, value.as_ref(), value2.as_ref()),
            PlanNode::Group { mode, children, .. } => match mode {
                PlanMatch::All => {
                    let mut pattern = base;
                    let mut changed = false;
                    for child in children {
                        let (next, child_changed) = self.apply_node(pattern, child)?;
                        pattern = next;
                        changed |= child_changed;
                    }
                    Ok((pattern, changed))
                }
                PlanMatch::Any | PlanMatch::None => {
                    let mut branches = Vec::new();
                    for child in children {
                        let (branch, changed) = self.apply_node(empty_pattern(), child)?;
                        if changed {
                            branches.push(Expression::Exists(Box::new(branch)));
                        }
                    }
                    let Some(mut expression) = branches
                        .into_iter()
                        .reduce(|left, right| Expression::Or(Box::new(left), Box::new(right)))
                    else {
                        return Ok((base, false));
                    };
                    if matches!(mode, PlanMatch::None) {
                        expression = Expression::Not(Box::new(expression));
                    }
                    Ok((filter(base, expression), true))
                }
            },
        }
    }

    fn apply_condition(
        &mut self,
        base: GraphPattern,
        field: &PlanField,
        op: PlanOperator,
        value: Option<&PlanValue>,
        value2: Option<&PlanValue>,
    ) -> Result<(GraphPattern, bool), QueryError> {
        let positive = match op {
            PlanOperator::NotContains => Some(PlanOperator::Contains),
            PlanOperator::NotEquals => Some(PlanOperator::Equals),
            PlanOperator::IsEmpty => Some(PlanOperator::IsSet),
            _ => None,
        };
        if let Some(positive) = positive {
            let (branch, changed) =
                self.apply_positive_condition(empty_pattern(), field, positive, value, value2)?;
            if !changed {
                return Ok((base, false));
            }
            return Ok((
                filter(
                    base,
                    Expression::Not(Box::new(Expression::Exists(Box::new(branch)))),
                ),
                true,
            ));
        }
        self.apply_positive_condition(base, field, op, value, value2)
    }

    fn apply_positive_condition(
        &mut self,
        base: GraphPattern,
        field: &PlanField,
        op: PlanOperator,
        value: Option<&PlanValue>,
        value2: Option<&PlanValue>,
    ) -> Result<(GraphPattern, bool), QueryError> {
        let predicate = field_predicate(field, self.subject)?;
        if matches!(op, PlanOperator::IsTrue | PlanOperator::IsFalse) {
            let relation = relation(
                self.subject_variable.clone(),
                predicate,
                Literal::from(matches!(op, PlanOperator::IsTrue)).into(),
            );
            return Ok((join(base, relation), true));
        }
        if matches!(op, PlanOperator::IsSet) {
            let value = self.local("v");
            let relation = relation(self.subject_variable.clone(), predicate, value.into());
            return Ok((join(base, relation), true));
        }
        let Some(value) = value else {
            return Ok((base, false));
        };
        if matches!(op, PlanOperator::AnyOf) {
            let PlanValue::List { values: members } = value else {
                return Ok((base, false));
            };
            let members = members
                .iter()
                .filter(|member| !member.is_empty())
                .take(PLAN_ANY_OF_MAX)
                .map(|member| self.list_member(field, member))
                .collect::<Result<Vec<_>, _>>()?;
            if members.is_empty() {
                return Ok((base, false));
            }
            let bound = self.local("v");
            let relation = relation(
                self.subject_variable.clone(),
                predicate,
                bound.clone().into(),
            );
            return Ok((
                filter(
                    join(base, relation),
                    Expression::In(Box::new(bound.into()), members),
                ),
                true,
            ));
        }

        if matches!(op, PlanOperator::Equals) && equals_by_term(field) {
            let object = self.scalar_term(value)?;
            let relation = relation(self.subject_variable.clone(), predicate, object);
            return Ok((join(base, relation), true));
        }

        let bound = self.local("v");
        let relation = relation(
            self.subject_variable.clone(),
            predicate,
            bound.clone().into(),
        );
        let left: Expression = bound.into();
        let right = self.scalar_expression(value)?;
        let expression = match op {
            PlanOperator::Equals => Expression::Equal(Box::new(left), Box::new(right)),
            PlanOperator::Contains if matches!(field, PlanField::Content) => {
                Expression::FunctionCall(
                    Function::Custom(named(crate::MATCHES_TEXT)?),
                    vec![left, right],
                )
            }
            PlanOperator::Contains => Expression::FunctionCall(
                Function::Contains,
                vec![lowercase_string(left), lowercase(right)],
            ),
            PlanOperator::StartsWith => Expression::FunctionCall(
                Function::StrStarts,
                vec![lowercase_string(left), lowercase(right)],
            ),
            PlanOperator::EndsWith => Expression::FunctionCall(
                Function::StrEnds,
                vec![lowercase_string(left), lowercase(right)],
            ),
            PlanOperator::Between => {
                let upper = self.scalar_expression(value2.unwrap_or(value))?;
                Expression::And(
                    Box::new(Expression::GreaterOrEqual(
                        Box::new(left.clone()),
                        Box::new(right),
                    )),
                    Box::new(Expression::LessOrEqual(Box::new(left), Box::new(upper))),
                )
            }
            PlanOperator::Lt => Expression::Less(Box::new(left), Box::new(right)),
            PlanOperator::Lte => Expression::LessOrEqual(Box::new(left), Box::new(right)),
            PlanOperator::Gt => Expression::Greater(Box::new(left), Box::new(right)),
            PlanOperator::Gte => Expression::GreaterOrEqual(Box::new(left), Box::new(right)),
            _ => return Ok((base, false)),
        };
        Ok((filter(join(base, relation), expression), true))
    }

    fn apply_column(
        &mut self,
        base: GraphPattern,
        column: &PlanColumn,
        target: Variable,
    ) -> Result<GraphPattern, QueryError> {
        let right = match &column.source {
            PlanColumnSource::Subject => return Ok(base),
            PlanColumnSource::Tags => {
                let tag = self.local("t");
                bgp([
                    triple(
                        self.subject_variable.clone(),
                        named(&format!("{}tag", crate::NEO_NS))?,
                        tag.clone(),
                    ),
                    triple(tag, named(&format!("{}name", crate::NEO_NS))?, target),
                ])
            }
            PlanColumnSource::Property { key }
                if matches!(column.aggregate, Some(PlanAggregate::List))
                    && property_type(key) == PropertyType::Page =>
            {
                let reference = self.local("r");
                optional(
                    bgp([triple(
                        self.subject_variable.clone(),
                        property_predicate(key)?,
                        reference.clone(),
                    )]),
                    bgp([triple(
                        reference,
                        named(&format!("{}content", crate::NEO_NS))?,
                        target,
                    )]),
                )
            }
            PlanColumnSource::Property { key } => bgp([triple(
                self.subject_variable.clone(),
                property_predicate(key)?,
                target,
            )]),
            source => {
                let local = match source {
                    PlanColumnSource::Content if matches!(self.subject, PlanSubject::Tag) => "name",
                    PlanColumnSource::Content => "content",
                    PlanColumnSource::Page => "page",
                    PlanColumnSource::Parent => "parent",
                    PlanColumnSource::SiblingIndex => "siblingIndex",
                    PlanColumnSource::Subject
                    | PlanColumnSource::Property { .. }
                    | PlanColumnSource::Tags => unreachable!(),
                };
                bgp([triple(
                    self.subject_variable.clone(),
                    named(&format!("{}{local}", crate::NEO_NS))?,
                    target,
                )])
            }
        };
        Ok(optional(base, right))
    }

    fn scalar_term(&mut self, value: &PlanValue) -> Result<TermPattern, QueryError> {
        if let OperandMode::Parameterized { next } = &mut self.operands {
            let variable = Variable::new_unchecked(format!("q_p{next}"));
            *next += 1;
            return Ok(variable.into());
        }
        let OperandMode::Direct { graph_id, today } = self.operands else {
            unreachable!("parameterized operands returned above")
        };
        match value {
            PlanValue::Text { value } => Ok(Literal::new_simple_literal(value).into()),
            PlanValue::Number { value } => Ok(Literal::new_typed_literal(
                value.to_string(),
                named(xsd::DOUBLE.as_str())?,
            )
            .into()),
            PlanValue::Date { value } => {
                Ok(Literal::new_typed_literal(value, named(xsd::DATE.as_str())?).into())
            }
            PlanValue::Relative { value } => Ok(Literal::new_typed_literal(
                resolve_relative_date(*value, today)?,
                named(xsd::DATE.as_str())?,
            )
            .into()),
            PlanValue::Page { value } => Ok(crate::entity_iri(graph_id, "page", value)?.into()),
            PlanValue::Tag { value } => Ok(crate::entity_iri(graph_id, "tag", value)?.into()),
            PlanValue::List { .. } => Err(invalid_plan("list is not a scalar")),
        }
    }

    fn scalar_expression(&mut self, value: &PlanValue) -> Result<Expression, QueryError> {
        match self.scalar_term(value)? {
            TermPattern::NamedNode(node) => Ok(node.into()),
            TermPattern::Literal(literal) => Ok(literal.into()),
            TermPattern::Variable(variable) => Ok(variable.into()),
            _ => Err(invalid_plan("plan value did not compile to a ground term")),
        }
    }

    fn list_member(&mut self, field: &PlanField, member: &str) -> Result<Expression, QueryError> {
        let value = match field_type(field) {
            FieldType::Page => PlanValue::Page {
                value: member.to_owned(),
            },
            FieldType::Tag => PlanValue::Tag {
                value: member.to_owned(),
            },
            _ => PlanValue::Text {
                value: member.to_owned(),
            },
        };
        self.scalar_expression(&value)
    }

    fn local(&mut self, prefix: &str) -> Variable {
        self.local_sequence += 1;
        Variable::new_unchecked(format!("q_{prefix}{}", self.local_sequence))
    }
}

enum FieldPredicate {
    Named(NamedNode),
    Path(PropertyPathExpression),
}

fn field_predicate(field: &PlanField, subject: PlanSubject) -> Result<FieldPredicate, QueryError> {
    let named =
        |local: &str| named(&format!("{}{local}", crate::NEO_NS)).map(FieldPredicate::Named);
    match field {
        PlanField::Content if matches!(subject, PlanSubject::Tag) => named("name"),
        PlanField::Content => named("content"),
        PlanField::Property { key } => property_predicate(key).map(FieldPredicate::Named),
        PlanField::Tag => named("tag"),
        PlanField::Page => named("page"),
        PlanField::Ancestor => Ok(FieldPredicate::Path(PropertyPathExpression::OneOrMore(
            Box::new(PropertyPathExpression::NamedNode(named_node("parent")?)),
        ))),
        PlanField::SiblingIndex => named("siblingIndex"),
    }
}

fn relation(subject: Variable, predicate: FieldPredicate, object: TermPattern) -> GraphPattern {
    match predicate {
        FieldPredicate::Named(predicate) => bgp([triple(subject, predicate, object)]),
        FieldPredicate::Path(path) => GraphPattern::Path {
            subject: subject.into(),
            path,
            object,
        },
    }
}

fn property_predicate(key: &str) -> Result<NamedNode, QueryError> {
    named(&format!("{}{}", crate::PROPERTY_NS, encode_component(key)))
}

fn named_node(local: &str) -> Result<NamedNode, QueryError> {
    named(&format!("{}{local}", crate::NEO_NS))
}

fn named(value: &str) -> Result<NamedNode, QueryError> {
    NamedNode::new(value).map_err(term_error)
}

fn term_error(error: impl std::fmt::Display) -> QueryError {
    QueryError::InvalidTerm(error.to_string())
}

fn invalid_plan(error: impl Into<String>) -> QueryError {
    QueryError::InvalidPlan(error.into())
}

fn empty_pattern() -> GraphPattern {
    bgp([])
}

fn is_empty(pattern: &GraphPattern) -> bool {
    matches!(pattern, GraphPattern::Bgp { patterns } if patterns.is_empty())
}

fn join(left: GraphPattern, right: GraphPattern) -> GraphPattern {
    if is_empty(&left) {
        return right;
    }
    if is_empty(&right) {
        return left;
    }
    GraphPattern::Join {
        left: Box::new(left),
        right: Box::new(right),
    }
}

fn optional(left: GraphPattern, right: GraphPattern) -> GraphPattern {
    GraphPattern::LeftJoin {
        left: Box::new(left),
        right: Box::new(right),
        expression: None,
    }
}

fn filter(inner: GraphPattern, expression: Expression) -> GraphPattern {
    GraphPattern::Filter {
        expr: expression,
        inner: Box::new(inner),
    }
}

fn lowercase(expression: Expression) -> Expression {
    Expression::FunctionCall(Function::LCase, vec![expression])
}

fn lowercase_string(expression: Expression) -> Expression {
    lowercase(Expression::FunctionCall(Function::Str, vec![expression]))
}

fn equals_by_term(field: &PlanField) -> bool {
    !matches!(field_type(field), FieldType::Number | FieldType::Integer)
}

fn property_type(key: &str) -> PropertyType {
    PropertyKey::new(key.to_owned())
        .ok()
        .and_then(|key| definition(&key))
        .map(|spec| spec.shape.value().property_type())
        .unwrap_or(PropertyType::String)
}

fn aggregate_expression(aggregate: PlanAggregate, inner: Variable) -> AggregateExpression {
    let (name, distinct) = match aggregate {
        PlanAggregate::List => (
            AggregateFunction::GroupConcat {
                separator: Some(LIST_SEPARATOR.to_owned()),
            },
            true,
        ),
        PlanAggregate::Count => (AggregateFunction::Count, true),
        PlanAggregate::Sum => (AggregateFunction::Sum, false),
        PlanAggregate::Avg => (AggregateFunction::Avg, false),
        PlanAggregate::Min => (AggregateFunction::Min, false),
        PlanAggregate::Max => (AggregateFunction::Max, false),
    };
    AggregateExpression::FunctionCall {
        name,
        expr: inner.into(),
        distinct,
    }
}

fn column_variable(column: &PlanColumn) -> String {
    let cleaned = column
        .id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    if !cleaned.starts_with(|character: char| character.is_ascii_alphabetic())
        || cleaned.starts_with("q_")
    {
        format!("c_{cleaned}")
    } else {
        cleaned
    }
}

fn moment_time_key(column: &PlanColumn) -> Option<&'static str> {
    if column.aggregate.is_some() {
        return None;
    }
    match &column.source {
        PlanColumnSource::Property { key } if key == "builtin.task-scheduled" => {
            Some("builtin.task-scheduled-time")
        }
        PlanColumnSource::Property { key } if key == "builtin.task-deadline" => {
            Some("builtin.task-deadline-time")
        }
        _ => None,
    }
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

fn resolve_relative_date(
    relative: PlanRelativeDate,
    today: &LocalDate,
) -> Result<String, QueryError> {
    let (year, month, day) = parse_date(today.as_str())?;
    match relative.unit {
        RelativeDateUnit::Day => {
            format_date_from_days(days_from_civil(year, month, day) + i64::from(relative.offset))
        }
        RelativeDateUnit::Week => {
            let days = days_from_civil(year, month, day);
            let weekday_from_monday = (days + 3).rem_euclid(7);
            format_date_from_days(days - weekday_from_monday + i64::from(relative.offset) * 7)
        }
        RelativeDateUnit::Month => {
            let month_index = i64::from(year) * 12 + i64::from(month - 1);
            let shifted = month_index + i64::from(relative.offset);
            let year = shifted.div_euclid(12);
            let month = shifted.rem_euclid(12) + 1;
            if !(1..=9_999).contains(&year) {
                return Err(invalid_plan("relative date is outside the supported range"));
            }
            Ok(format!("{year:04}-{month:02}-01"))
        }
    }
}

fn parse_date(value: &str) -> Result<(i32, u32, u32), QueryError> {
    let date = LocalDate::new(value.to_owned()).map_err(|error| invalid_plan(error.to_string()))?;
    let value = date.as_str();
    Ok((
        value[0..4]
            .parse()
            .map_err(|error| invalid_plan(format!("invalid year: {error}")))?,
        value[5..7]
            .parse()
            .map_err(|error| invalid_plan(format!("invalid month: {error}")))?,
        value[8..10]
            .parse()
            .map_err(|error| invalid_plan(format!("invalid day: {error}")))?,
    ))
}

// Proleptic Gregorian conversion, with 1970-01-01 as day zero.
fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let adjusted_year = i64::from(year) - i64::from(month <= 2);
    let era = adjusted_year.div_euclid(400);
    let year_of_era = adjusted_year - era * 400;
    let shifted_month = i64::from(month) + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn format_date_from_days(days: i64) -> Result<String, QueryError> {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    if !(1..=9_999).contains(&year) {
        return Err(invalid_plan("relative date is outside the supported range"));
    }
    Ok(format!("{year:04}-{month:02}-{day:02}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn core_port_json_uses_the_typescript_plan_shape() {
        let value = json!({
            "version": 1,
            "subject": "block",
            "where": {
                "id": "root",
                "kind": "group",
                "match": "all",
                "children": [{
                    "id": "tags",
                    "kind": "condition",
                    "field": { "kind": "tag" },
                    "op": "any_of",
                    "value": { "type": "list", "values": ["project", "later"] }
                }]
            },
            "columns": [{ "id": "text", "source": { "kind": "content" } }],
            "limit": 100,
            "distinct": false
        });
        let plan: BuiltQueryPlan = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(plan.limit.get(), 100);
        assert_eq!(serde_json::to_value(plan).unwrap(), value);

        let stored = StoredQueryPlan {
            version: QUERY_PLAN_VERSION,
            payload: serde_json::to_string(&value).unwrap(),
        };
        let source = derive_plan_source(&stored).unwrap();
        let marker = format!(
            "{DERIVED_SOURCE_PROVENANCE}1;fnv1a32={:08x}\n",
            fnv1a32(stored.payload.as_bytes())
        );
        assert!(source.starts_with(&marker));
        assert!(source.contains("?q_p0"));
        assert!(source.contains("?q_p1"));
        LogicalQuery::from_sparql(source.strip_prefix(&marker).unwrap()).unwrap();
    }

    #[test]
    fn plan_limit_rejects_fractional_zero_and_excessive_values_at_the_boundary() {
        for value in [json!(0), json!(1.5), json!(1001)] {
            assert!(serde_json::from_value::<PlanLimit>(value).is_err());
        }
        assert_eq!(
            serde_json::from_value::<PlanLimit>(json!(1)).unwrap().get(),
            1
        );
        assert_eq!(
            serde_json::from_value::<PlanLimit>(json!(1000))
                .unwrap()
                .get(),
            1000
        );
    }

    #[test]
    fn relative_dates_match_calendar_boundaries() {
        let today = LocalDate::new("2026-09-04").unwrap();
        assert_eq!(
            resolve_relative_date(
                PlanRelativeDate {
                    unit: RelativeDateUnit::Day,
                    offset: -5,
                },
                &today,
            )
            .unwrap(),
            "2026-08-30"
        );
        assert_eq!(
            resolve_relative_date(
                PlanRelativeDate {
                    unit: RelativeDateUnit::Week,
                    offset: 0,
                },
                &today,
            )
            .unwrap(),
            "2026-08-31"
        );
        assert_eq!(
            resolve_relative_date(
                PlanRelativeDate {
                    unit: RelativeDateUnit::Month,
                    offset: -9,
                },
                &today,
            )
            .unwrap(),
            "2025-12-01"
        );
    }
}
