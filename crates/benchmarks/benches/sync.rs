//! Server admission cost of one small update as the graph grows. A typing
//! update is a few hundred bytes; its admission should not scale with the graph.

use criterion::{BenchmarkId, Criterion, criterion_group, criterion_main};
use domain::{Command, CommandEnvelope, CommandId, GraphId, OutlineItem, OutlineOwner, PageId};
use graph_core::{GraphCore, server::ServerGraph};
use std::hint::black_box;

const BLOCKS_PER_PAGE: usize = 100;

struct Fixture {
    server: ServerGraph,
    update: Vec<u8>,
}

fn fixture(block_count: usize) -> Fixture {
    let graph_id = GraphId::new("sync-benchmark").expect("valid graph ID");
    let mut writer = GraphCore::new(graph_id.clone(), 1, "t0").expect("graph opens");
    let mut sequence = 0;
    let mut run = |writer: &mut GraphCore, command: Command| {
        sequence += 1;
        writer
            .execute(
                CommandEnvelope {
                    graph_id: graph_id.clone(),
                    command_id: CommandId::new(format!("c{sequence}")).expect("valid command ID"),
                    command,
                },
                "t1",
            )
            .expect("benchmark command applies")
    };
    for page in 0..block_count / BLOCKS_PER_PAGE {
        let page_id = PageId::new(format!("p{page}")).expect("valid page ID");
        run(
            &mut writer,
            Command::EnsurePage {
                page_id: page_id.clone(),
                title: format!("Page {page}"),
            },
        );
        let items = (0..BLOCKS_PER_PAGE)
            .map(|index| OutlineItem {
                depth: usize::from(index % 3 != 0),
                markdown: format!("Block {page}-{index} with a sentence of ordinary note text."),
            })
            .collect();
        run(
            &mut writer,
            Command::InsertOutline {
                owner: OutlineOwner::Page { id: page_id },
                parent: None,
                index: 0,
                replace: None,
                items,
            },
        );
    }
    let server = ServerGraph::from_checkpoint(
        graph_id.clone(),
        2,
        &writer.export_snapshot().expect("snapshot exports"),
    )
    .expect("checkpoint opens");
    let page_id = PageId::new("p0").expect("valid page ID");
    let block_id = writer.page_snapshot(&page_id).expect("page reads").blocks[0]
        .id
        .clone();
    let update = run(
        &mut writer,
        Command::SpliceMarkdown {
            owner: OutlineOwner::Page { id: page_id },
            block_id,
            index: 0,
            delete: 0,
            insert: "x".into(),
        },
    )
    .update;
    Fixture { server, update }
}

fn bench_prepare_update(criterion: &mut Criterion) {
    let mut group = criterion.benchmark_group("sync/prepare_update");
    group.sample_size(10);
    for block_count in [1_000, 10_000, 50_000] {
        let fixture = fixture(block_count);
        group.bench_function(BenchmarkId::from_parameter(block_count), |bencher| {
            bencher.iter_with_large_drop(|| {
                fixture
                    .server
                    .prepare_update(black_box(&fixture.update))
                    .expect("update admits")
            });
        });
    }
    group.finish();
}

criterion_group!(benches, bench_prepare_update);
criterion_main!(benches);
