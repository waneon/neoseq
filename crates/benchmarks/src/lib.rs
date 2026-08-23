use domain::{
    BlockId, BlockSnapshot, Cardinality, GraphId, GraphSettings, GraphSnapshot, LocalDate, PageId,
    PageSnapshot, PropertyField, PropertyKey, PropertyValue, TagId, TagSnapshot,
};
use query::{IndexUnit, QUERY_LANGUAGE, QueryBudget, QueryRequest, RdfTerm};
use std::{collections::BTreeMap, convert::Infallible};

pub const LARGE_BLOCK_COUNT: usize = 1_000_000;
pub const BLOCK_COUNTS: [usize; 3] = [100, 10_000, LARGE_BLOCK_COUNT];

const BLOCKS_PER_PAGE: usize = 10;
const GRAPH_ID: &str = "benchmark";
const TAG_COUNT: usize = 4;
const XSD_DATE: &str = "http://www.w3.org/2001/XMLSchema#date";
const XSD_STRING: &str = "http://www.w3.org/2001/XMLSchema#string";

pub fn snapshot(block_count: usize) -> GraphSnapshot {
    assert!(block_count > 0);

    let page_count = block_count.div_ceil(BLOCKS_PER_PAGE);
    let pages = (0..page_count)
        .map(|page_index| {
            let first_block = page_index * BLOCKS_PER_PAGE;
            let end_block = (first_block + BLOCKS_PER_PAGE).min(block_count);
            PageSnapshot {
                id: page_id_value(page_index),
                title: format!("Benchmark page {page_index}"),
                properties: Vec::new(),
                tags: vec![tag_id(page_index % TAG_COUNT)],
                blocks: (first_block..end_block).map(block).collect(),
            }
        })
        .collect();
    let tags = (0..TAG_COUNT)
        .map(|index| TagSnapshot {
            id: tag_id(index),
            name: format!("Benchmark tag {index}"),
            properties: Vec::new(),
            defaults: Vec::new(),
            blocks: Vec::new(),
        })
        .collect();

    GraphSnapshot {
        schema_version: 4,
        graph_id: GraphId::new(GRAPH_ID).expect("static benchmark graph id"),
        pages,
        tags,
        settings: GraphSettings::default(),
        quarantined: Vec::new(),
    }
}

/// Generates the same fixture one page at a time so cold-build benchmarks do
/// not keep a second, complete domain snapshot beside the derived index.
pub fn streaming_units(block_count: usize) -> impl Iterator<Item = Result<IndexUnit, Infallible>> {
    assert!(block_count > 0);
    let tags = (0..TAG_COUNT).map(|index| {
        IndexUnit::Tag(TagSnapshot {
            id: tag_id(index),
            name: format!("Benchmark tag {index}"),
            properties: Vec::new(),
            defaults: Vec::new(),
            blocks: Vec::new(),
        })
    });
    let pages = (0..block_count.div_ceil(BLOCKS_PER_PAGE)).map(move |page_index| {
        let first_block = page_index * BLOCKS_PER_PAGE;
        let end_block = (first_block + BLOCKS_PER_PAGE).min(block_count);
        IndexUnit::Page(PageSnapshot {
            id: page_id_value(page_index),
            title: format!("Benchmark page {page_index}"),
            properties: Vec::new(),
            tags: vec![tag_id(page_index % TAG_COUNT)],
            blocks: (first_block..end_block).map(block).collect(),
        })
    });
    tags.chain(pages).map(Ok)
}

pub fn graph_id() -> GraphId {
    GraphId::new(GRAPH_ID).expect("static benchmark graph id")
}

pub fn request(source: &str) -> QueryRequest {
    QueryRequest {
        language: QUERY_LANGUAGE.to_owned(),
        source: source.to_owned(),
        bindings: BTreeMap::new(),
        budget: QueryBudget::default(),
    }
}

pub fn iri_binding(value: String) -> RdfTerm {
    RdfTerm::Iri {
        value,
        entity: None,
    }
}

pub fn string_binding(value: &str) -> RdfTerm {
    literal_binding(value, XSD_STRING)
}

pub fn date_binding(value: &str) -> RdfTerm {
    literal_binding(value, XSD_DATE)
}

pub fn block_iri(block_index: usize) -> String {
    entity_iri("block", &format!("block-{block_index:06}"))
}

pub fn page_iri(page_index: usize) -> String {
    entity_iri("page", &format!("page-{page_index:06}"))
}

fn block(index: usize) -> BlockSnapshot {
    let status = ["todo", "doing", "done"][index % 3];
    let markdown = if index.is_multiple_of(20) {
        format!("Regression needle in benchmark block {index}")
    } else {
        format!("Representative benchmark content for block {index}")
    };

    BlockSnapshot {
        id: BlockId::new(format!("block-{index:06}")).expect("generated benchmark block id"),
        markdown,
        properties: vec![
            single(
                "builtin.task-status",
                PropertyValue::String(status.to_owned()),
            ),
            single(
                "builtin.task-deadline",
                PropertyValue::Date(
                    LocalDate::new(format!("2026-08-{:02}", index % 28 + 1))
                        .expect("generated benchmark date"),
                ),
            ),
        ],
        tags: vec![tag_id(index % TAG_COUNT)],
        children: Vec::new(),
    }
}

fn single(key: &str, value: PropertyValue) -> PropertyField {
    PropertyField {
        key: PropertyKey::new(key).expect("static benchmark property key"),
        value_type: value.property_type(),
        cardinality: Cardinality::Single,
        values: vec![value],
    }
}

fn page_id_value(index: usize) -> PageId {
    PageId::new(format!("page-{index:06}")).expect("generated benchmark page id")
}

fn tag_id(index: usize) -> TagId {
    TagId::new(format!("tag-{index}")).expect("generated benchmark tag id")
}

fn entity_iri(kind: &str, id: &str) -> String {
    format!("urn:neoseq:entity:{GRAPH_ID}:{kind}:{id}")
}

fn literal_binding(value: &str, datatype: &str) -> RdfTerm {
    RdfTerm::Literal {
        value: value.to_owned(),
        datatype: datatype.to_owned(),
        language: None,
    }
}
