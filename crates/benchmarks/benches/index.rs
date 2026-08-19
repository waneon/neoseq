use criterion::{
    BenchmarkId, Criterion, SamplingMode, Throughput, criterion_group, criterion_main,
};
use neoseq_benchmarks::{BLOCK_COUNTS, LARGE_BLOCK_COUNT, snapshot};
use query::{GraphIndex, IndexDelta};
use std::hint::black_box;

fn bench_build(criterion: &mut Criterion) {
    let mut group = criterion.benchmark_group("index/build");
    for block_count in BLOCK_COUNTS {
        configure_large_sample(&mut group, block_count);
        group.throughput(Throughput::Elements(block_count as u64));
        let mut prepared = None;
        group.bench_function(BenchmarkId::from_parameter(block_count), move |bencher| {
            let snapshot = prepared.get_or_insert_with(|| snapshot(block_count));
            bencher.iter_with_large_drop(|| {
                GraphIndex::new_at(black_box(snapshot), "benchmark-frontier".to_owned())
                    .expect("benchmark index should build")
            });
        });
    }
    group.finish();
}

fn bench_full_refresh_noop(criterion: &mut Criterion) {
    let mut group = criterion.benchmark_group("index/full_refresh_noop");
    for block_count in BLOCK_COUNTS {
        configure_large_sample(&mut group, block_count);
        group.throughput(Throughput::Elements(block_count as u64));
        let mut prepared = None;
        group.bench_function(BenchmarkId::from_parameter(block_count), move |bencher| {
            let (snapshot, index) = prepared.get_or_insert_with(|| {
                let snapshot = snapshot(block_count);
                let mut index = GraphIndex::new_at(&snapshot, "frontier-0".to_owned())
                    .expect("benchmark index should build");
                assert!(
                    !index
                        .refresh_at(&snapshot, "frontier-0".to_owned())
                        .expect("no-op refresh should succeed")
                );
                (snapshot, index)
            });
            bencher.iter(|| {
                black_box(
                    index
                        .refresh_at(black_box(snapshot), "frontier-0".to_owned())
                        .expect("no-op refresh should succeed"),
                )
            });
        });
    }
    group.finish();
}

fn bench_apply_one_page(criterion: &mut Criterion) {
    let mut group = criterion.benchmark_group("index/apply_one_page");
    for block_count in BLOCK_COUNTS {
        configure_large_sample(&mut group, block_count);
        let mut prepared = None;
        group.bench_function(BenchmarkId::from_parameter(block_count), move |bencher| {
            let (index, base_page, changed_page, use_changed) = prepared.get_or_insert_with(|| {
                let base = snapshot(block_count);
                let base_page = base.pages[0].clone();
                let mut changed_page = base_page.clone();
                changed_page.blocks[0].markdown = "Changed benchmark content".to_owned();
                let mut index = GraphIndex::new_at(&base, "frontier-0".to_owned())
                    .expect("benchmark index should build");
                assert!(
                    index
                        .apply_delta(IndexDelta {
                            pages: vec![changed_page.clone()],
                            removed_pages: vec![],
                            tags: vec![],
                            removed_tags: vec![],
                            frontier: "frontier-1".to_owned(),
                        })
                        .expect("single-page delta should succeed")
                );
                assert!(
                    index
                        .apply_delta(IndexDelta {
                            pages: vec![base_page.clone()],
                            removed_pages: vec![],
                            tags: vec![],
                            removed_tags: vec![],
                            frontier: "frontier-0".to_owned(),
                        })
                        .expect("single-page delta should succeed")
                );
                (index, base_page, changed_page, true)
            });
            bencher.iter(|| {
                let (page, frontier) = if *use_changed {
                    (&*changed_page, "frontier-1")
                } else {
                    (&*base_page, "frontier-0")
                };
                *use_changed = !*use_changed;
                black_box(
                    index
                        .apply_delta(IndexDelta {
                            pages: vec![black_box(page.clone())],
                            removed_pages: vec![],
                            tags: vec![],
                            removed_tags: vec![],
                            frontier: frontier.to_owned(),
                        })
                        .expect("single-page delta should succeed"),
                )
            });
        });
    }
    group.finish();
}

fn configure_large_sample<M: criterion::measurement::Measurement>(
    group: &mut criterion::BenchmarkGroup<'_, M>,
    block_count: usize,
) {
    if block_count == LARGE_BLOCK_COUNT {
        group.sample_size(10).sampling_mode(SamplingMode::Flat);
    }
}

criterion_group!(
    benches,
    bench_build,
    bench_full_refresh_noop,
    bench_apply_one_page
);
criterion_main!(benches);
