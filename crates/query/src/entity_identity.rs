//! Page/tag syntax shares one stable document IRI. Normalize legacy tag IRIs
//! in parsed algebra, never in authored source or string literal values.
use super::*;

pub(super) fn canonical_iri(value: &str) -> String {
    if let Some(rest) = value.strip_prefix(ENTITY_NS)
        && let Some((graph, rest)) = rest.split_once(':')
        && let Some(id) = rest.strip_prefix("tag:")
    {
        return format!("{ENTITY_NS}{graph}:page:{id}");
    }
    value.to_owned()
}

fn node(value: &mut NamedNode) {
    let canonical = canonical_iri(value.as_str());
    if canonical != value.as_str() {
        *value = NamedNode::new_unchecked(canonical);
    }
}
fn term(value: &mut TermPattern) {
    if let TermPattern::NamedNode(value) = value {
        node(value);
    }
}
fn ground(value: &mut GroundTerm) {
    if let GroundTerm::NamedNode(value) = value {
        node(value);
    }
}
fn path(value: &mut PropertyPathExpression) {
    match value {
        PropertyPathExpression::NamedNode(value) => node(value),
        PropertyPathExpression::Reverse(inner)
        | PropertyPathExpression::ZeroOrMore(inner)
        | PropertyPathExpression::OneOrMore(inner)
        | PropertyPathExpression::ZeroOrOne(inner) => path(inner),
        PropertyPathExpression::Sequence(left, right)
        | PropertyPathExpression::Alternative(left, right) => {
            path(left);
            path(right);
        }
        PropertyPathExpression::NegatedPropertySet(values) => {
            for value in values {
                node(value);
            }
        }
    }
}
fn expression(value: &mut Expression) {
    match value {
        Expression::NamedNode(value) => node(value),
        Expression::Exists(inner) => pattern(inner),
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
            expression(left);
            expression(right);
        }
        Expression::UnaryPlus(inner) | Expression::UnaryMinus(inner) | Expression::Not(inner) => {
            expression(inner)
        }
        Expression::If(condition, left, right) => {
            expression(condition);
            expression(left);
            expression(right);
        }
        Expression::In(left, values) => {
            expression(left);
            for value in values {
                expression(value);
            }
        }
        Expression::Coalesce(values) | Expression::FunctionCall(_, values) => {
            for value in values {
                expression(value);
            }
        }
        Expression::Literal(_) | Expression::Variable(_) | Expression::Bound(_) => {}
    }
}
fn pattern(value: &mut GraphPattern) {
    match value {
        GraphPattern::Bgp { patterns } => {
            for triple in patterns {
                term(&mut triple.subject);
                term(&mut triple.object);
                if let NamedNodePattern::NamedNode(value) = &mut triple.predicate {
                    node(value);
                }
            }
        }
        GraphPattern::Path {
            subject,
            path: p,
            object,
        } => {
            term(subject);
            path(p);
            term(object);
        }
        GraphPattern::Values { bindings, .. } => {
            for row in bindings {
                for value in row.iter_mut().flatten() {
                    ground(value);
                }
            }
        }
        GraphPattern::Join { left, right }
        | GraphPattern::Lateral { left, right }
        | GraphPattern::Union { left, right }
        | GraphPattern::Minus { left, right } => {
            pattern(left);
            pattern(right);
        }
        GraphPattern::LeftJoin {
            left,
            right,
            expression: expr,
        } => {
            pattern(left);
            pattern(right);
            if let Some(expr) = expr {
                expression(expr);
            }
        }
        GraphPattern::Filter { expr, inner } => {
            pattern(inner);
            expression(expr);
        }
        GraphPattern::Project { inner, .. }
        | GraphPattern::Distinct { inner }
        | GraphPattern::Reduced { inner }
        | GraphPattern::Slice { inner, .. } => pattern(inner),
        GraphPattern::Extend {
            inner,
            expression: expr,
            ..
        } => {
            pattern(inner);
            expression(expr);
        }
        GraphPattern::OrderBy {
            inner,
            expression: exprs,
        } => {
            pattern(inner);
            for expr in exprs {
                let (OrderExpression::Asc(expr) | OrderExpression::Desc(expr)) = expr;
                expression(expr);
            }
        }
        GraphPattern::Group {
            inner, aggregates, ..
        } => {
            pattern(inner);
            for (_, aggregate) in aggregates {
                if let AggregateExpression::FunctionCall { expr, .. } = aggregate {
                    expression(expr);
                }
            }
        }
        GraphPattern::Graph { .. } | GraphPattern::Service { .. } => {
            unreachable!("query validation rejects external graphs")
        }
    }
}

pub(super) fn normalize(query: &mut Query, bindings: &mut BTreeMap<String, RdfTerm>) {
    match query {
        Query::Select { pattern: p, .. } | Query::Ask { pattern: p, .. } => pattern(p),
        _ => unreachable!("query validation accepts SELECT and ASK only"),
    }
    for value in bindings.values_mut() {
        if let RdfTerm::Iri { value, .. } = value {
            *value = canonical_iri(value);
        }
    }
}
