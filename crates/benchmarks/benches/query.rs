use criterion::{BatchSize, BenchmarkId, Criterion, SamplingMode, criterion_group, criterion_main};
use neoseq_benchmarks::{
    BLOCK_COUNTS, LARGE_BLOCK_COUNT, block_iri, date_binding, iri_binding, page_iri, request,
    snapshot, string_binding,
};
use query::{GraphIndex, QueryRequest, QueryResult};
use std::hint::black_box;

fn bench_query(criterion: &mut Criterion) {
    let mut group = criterion.benchmark_group("query");
    for block_count in BLOCK_COUNTS {
        if block_count == LARGE_BLOCK_COUNT {
            group.sample_size(10).sampling_mode(SamplingMode::Flat);
        }
        let mut index = None;

        for (name, request) in query_cases(block_count) {
            group.bench_with_input(
                BenchmarkId::new(name, block_count),
                &request,
                |bencher, request| {
                    let index = index.get_or_insert_with(|| {
                        let snapshot = snapshot(block_count);
                        GraphIndex::new_at(&snapshot, "benchmark-frontier".to_owned())
                            .expect("benchmark index should build")
                    });
                    let QueryResult::Select { rows, .. } = index
                        .execute(request.clone())
                        .expect("benchmark query should execute")
                    else {
                        panic!("benchmark query {name} should return SELECT results");
                    };
                    assert!(!rows.is_empty(), "benchmark query {name} should match rows");
                    bencher.iter_batched(
                        || request.clone(),
                        |request| {
                            index
                                .execute(black_box(request))
                                .expect("benchmark query should execute")
                        },
                        BatchSize::SmallInput,
                    );
                },
            );
        }
    }
    group.finish();
}

fn query_cases(block_count: usize) -> Vec<(&'static str, QueryRequest)> {
    let mut lookup_by_id = request(
        "PREFIX neo: <urn:neoseq:vocab:v1:>\n\
         SELECT ?content WHERE { ?block neo:content ?content }",
    );
    lookup_by_id
        .bindings
        .insert("block".to_owned(), iri_binding(block_iri(block_count / 2)));

    let mut page_blocks_ordered = request(
        "PREFIX neo: <urn:neoseq:vocab:v1:>\n\
         SELECT ?block ?content ?index WHERE {\n\
           ?block a neo:Block ;\n\
                  neo:page ?page ;\n\
                  neo:content ?content ;\n\
                  neo:siblingIndex ?index .\n\
         } ORDER BY ?index ?block LIMIT 100",
    );
    page_blocks_ordered
        .bindings
        .insert("page".to_owned(), iri_binding(page_iri(0)));

    let mut property_equals = request(
        "PREFIX prop: <urn:neoseq:property:>\n\
         SELECT ?block WHERE { ?block prop:builtin.task-status ?status } LIMIT 100",
    );
    property_equals
        .bindings
        .insert("status".to_owned(), string_binding("todo"));

    let mut property_range = request(
        "PREFIX prop: <urn:neoseq:property:>\n\
         SELECT ?block ?deadline WHERE {\n\
           ?block prop:builtin.task-deadline ?deadline .\n\
           FILTER (?deadline <= ?today)\n\
         } LIMIT 100",
    );
    property_range
        .bindings
        .insert("today".to_owned(), date_binding("2026-08-15"));
    let mut property_range_ordered = property_range.clone();
    property_range_ordered.source = property_range_ordered
        .source
        .replace("LIMIT 100", "ORDER BY ?deadline ?block LIMIT 100");

    let mut property_filter_ordered = request(
        "PREFIX neo: <urn:neoseq:vocab:v1:>\n\
         PREFIX prop: <urn:neoseq:property:>\n\
         SELECT ?block ?deadline WHERE {\n\
           ?block a neo:Block ;\n\
                  prop:builtin.task-status ?status ;\n\
                  prop:builtin.task-deadline ?deadline .\n\
           FILTER (?deadline <= ?today)\n\
         } ORDER BY ?deadline ?block LIMIT 100",
    );
    property_filter_ordered
        .bindings
        .insert("status".to_owned(), string_binding("todo"));
    property_filter_ordered
        .bindings
        .insert("today".to_owned(), date_binding("2026-08-15"));

    let mut text_match_unordered = request(
        "PREFIX neo: <urn:neoseq:vocab:v1:>\n\
         SELECT ?block WHERE {\n\
           ?block a neo:Block ; neo:content ?content .\n\
           FILTER (neo:matchesText(?content, ?needle))\n\
         } LIMIT 100",
    );
    text_match_unordered
        .bindings
        .insert("needle".to_owned(), string_binding("regression needle"));

    let mut text_match_ordered = request(
        "PREFIX neo: <urn:neoseq:vocab:v1:>\n\
         SELECT ?block WHERE {\n\
           ?block a neo:Block ; neo:content ?content .\n\
           FILTER (neo:matchesText(?content, ?needle))\n\
         } ORDER BY ?block LIMIT 100",
    );
    text_match_ordered
        .bindings
        .insert("needle".to_owned(), string_binding("regression needle"));

    vec![
        ("lookup_by_id", lookup_by_id),
        ("page_blocks_ordered", page_blocks_ordered),
        ("property_equals", property_equals),
        ("property_range", property_range),
        ("property_range_ordered", property_range_ordered),
        ("property_filter_ordered", property_filter_ordered),
        ("text_match_unordered", text_match_unordered),
        ("text_match_ordered", text_match_ordered),
    ]
}

criterion_group!(benches, bench_query);
criterion_main!(benches);
