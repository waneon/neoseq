use criterion::{
    BenchmarkId, Criterion, SamplingMode, Throughput, criterion_group, criterion_main,
};
use neoseq_benchmarks::{BLOCK_COUNTS, LARGE_BLOCK_COUNT, snapshot};
use query::GraphIndex;
use std::hint::black_box;

fn bench_build(criterion: &mut Criterion) {
    let mut group = criterion.benchmark_group("index/build");
    for block_count in BLOCK_COUNTS {
        configure_large_sample(&mut group, block_count);
        group.throughput(Throughput::Elements(block_count as u64));
        group.bench_with_input(
            BenchmarkId::from_parameter(block_count),
            &block_count,
            |bencher, &block_count| {
                let snapshot = snapshot(block_count);
                bencher.iter_with_large_drop(|| {
                    GraphIndex::new_at(black_box(&snapshot), "benchmark-frontier".to_owned())
                        .expect("benchmark index should build")
                });
            },
        );
    }
    group.finish();
}

fn bench_refresh_noop(criterion: &mut Criterion) {
    let mut group = criterion.benchmark_group("index/refresh_noop");
    for block_count in BLOCK_COUNTS {
        configure_large_sample(&mut group, block_count);
        group.throughput(Throughput::Elements(block_count as u64));
        group.bench_with_input(
            BenchmarkId::from_parameter(block_count),
            &block_count,
            |bencher, &block_count| {
                let snapshot = snapshot(block_count);
                let mut index = GraphIndex::new_at(&snapshot, "frontier-0".to_owned())
                    .expect("benchmark index should build");
                assert!(
                    !index
                        .refresh_at(&snapshot, "frontier-0".to_owned())
                        .expect("no-op refresh should succeed")
                );
                bencher.iter(|| {
                    black_box(
                        index
                            .refresh_at(black_box(&snapshot), "frontier-0".to_owned())
                            .expect("no-op refresh should succeed"),
                    )
                });
            },
        );
    }
    group.finish();
}

fn bench_refresh_one_block(criterion: &mut Criterion) {
    let mut group = criterion.benchmark_group("index/refresh_one_block");
    for block_count in BLOCK_COUNTS {
        configure_large_sample(&mut group, block_count);
        group.throughput(Throughput::Elements(block_count as u64));
        group.bench_with_input(
            BenchmarkId::from_parameter(block_count),
            &block_count,
            |bencher, &block_count| {
                let base = snapshot(block_count);
                let mut changed = base.clone();
                changed.pages[0].blocks[0].markdown = "Changed benchmark content".to_owned();
                let mut index = GraphIndex::new_at(&base, "frontier-0".to_owned())
                    .expect("benchmark index should build");
                assert!(
                    index
                        .refresh_at(&changed, "frontier-1".to_owned())
                        .expect("single-block refresh should succeed")
                );
                assert!(
                    index
                        .refresh_at(&base, "frontier-0".to_owned())
                        .expect("single-block refresh should succeed")
                );
                let mut use_changed = true;

                bencher.iter(|| {
                    let (snapshot, frontier) = if use_changed {
                        (&changed, "frontier-1")
                    } else {
                        (&base, "frontier-0")
                    };
                    use_changed = !use_changed;
                    black_box(
                        index
                            .refresh_at(black_box(snapshot), frontier.to_owned())
                            .expect("single-block refresh should succeed"),
                    )
                });
            },
        );
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
    bench_refresh_noop,
    bench_refresh_one_block
);
criterion_main!(benches);
