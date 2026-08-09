use crate::GraphCore;
use domain::{
    BlockId, Command, CommandEnvelope, CommandId, EntityId, GraphId, LocalDate, PageId,
    PropertyKey, PropertyOwner, PropertyValue, QueryViewId, TagId,
};

const REPRODUCIBLE_SEEDS: &[u64] = &[
    0x02_0000_0001,
    0x02_0000_0002,
    0x02_0000_0042,
    0x02_c0de_cafe,
    0x02_dead_beef,
];

struct Fixture {
    graph: GraphId,
    page_a: PageId,
    tag_a: TagId,
    tag_b: TagId,
    text: BlockId,
    ancestor: BlockId,
    descendant: BlockId,
    moving: BlockId,
    alternate_parent: BlockId,
    snapshot: Vec<u8>,
}

fn key(value: &str) -> PropertyKey {
    PropertyKey::new(value).unwrap()
}

fn execute(core: &mut GraphCore, graph: &GraphId, peer: u64, sequence: usize, command: Command) {
    core.execute(
        CommandEnvelope {
            graph_id: graph.clone(),
            command_id: CommandId::new(format!("seed-peer-{peer}-command-{sequence}")).unwrap(),
            command,
        },
        &format!("seed-{peer}-{sequence}"),
    )
    .unwrap();
}

fn base_fixture(seed: u64) -> Fixture {
    let graph = GraphId::new(format!("convergence-{seed:x}")).unwrap();
    let page_a = PageId::new("page-a").unwrap();
    let page_b = PageId::new("page-b").unwrap();
    let tag_a = TagId::new("tag-a").unwrap();
    let tag_b = TagId::new("tag-b").unwrap();
    let mut core = GraphCore::new(graph.clone(), 1, "base").unwrap();
    for (sequence, (page, title)) in [(&page_a, "A"), (&page_b, "B")].into_iter().enumerate() {
        execute(
            &mut core,
            &graph,
            1,
            sequence,
            Command::EnsurePage {
                page_id: page.clone(),
                title: title.into(),
            },
        );
    }
    for (sequence, (tag_id, name)) in [(&tag_a, "Tag A"), (&tag_b, "Tag B")]
        .into_iter()
        .enumerate()
    {
        execute(
            &mut core,
            &graph,
            1,
            sequence + 2,
            Command::EnsureTag {
                tag_id: tag_id.clone(),
                name: name.into(),
            },
        );
    }
    execute(
        &mut core,
        &graph,
        1,
        10,
        Command::SetProperty {
            owner: PropertyOwner::TagDefault {
                tag_id: tag_b.clone(),
            },
            key: key("builtin.task-priority"),
            value: PropertyValue::String("high".into()),
        },
    );
    let mut insert = |sequence, parent: Option<BlockId>, markdown: &str| {
        core.execute(
            CommandEnvelope {
                graph_id: graph.clone(),
                command_id: CommandId::new(format!("base-block-{sequence}")).unwrap(),
                command: Command::InsertBlock {
                    page_id: page_a.clone(),
                    parent,
                    index: sequence,
                    markdown: markdown.into(),
                },
            },
            "base",
        )
        .unwrap()
        .result
        .created_block
        .unwrap()
    };
    let text = insert(0, None, "abcdef");
    let ancestor = insert(1, None, "ancestor");
    let descendant = insert(0, Some(ancestor.clone()), "descendant");
    let moving = insert(2, None, "moving");
    let alternate_parent = insert(3, None, "alternate");
    execute(
        &mut core,
        &graph,
        1,
        20,
        Command::SetProperty {
            owner: PropertyOwner::Block {
                page_id: page_a.clone(),
                id: text.clone(),
            },
            key: key("builtin.task-status"),
            value: PropertyValue::String("todo".into()),
        },
    );
    execute(
        &mut core,
        &graph,
        1,
        21,
        Command::AddTag {
            entity: EntityId::Block {
                page_id: page_a.clone(),
                id: text.clone(),
            },
            tag_id: tag_a.clone(),
        },
    );
    let snapshot = core.export_snapshot().unwrap();
    Fixture {
        graph,
        page_a,
        tag_a,
        tag_b,
        text,
        ancestor,
        descendant,
        moving,
        alternate_parent,
        snapshot,
    }
}

fn run_seed(seed: u64) {
    let fixture = base_fixture(seed);
    let mut left = GraphCore::from_snapshot(
        fixture.graph.clone(),
        seed.wrapping_mul(2).max(2),
        &fixture.snapshot,
    )
    .unwrap();
    let mut right = GraphCore::from_snapshot(
        fixture.graph.clone(),
        seed.wrapping_mul(2).wrapping_add(1).max(3),
        &fixture.snapshot,
    )
    .unwrap();
    let left_peer = seed.wrapping_mul(2).max(2);
    let right_peer = seed.wrapping_mul(2).wrapping_add(1).max(3);

    let insert_at = (seed as usize) % 3;
    execute(
        &mut left,
        &fixture.graph,
        left_peer,
        0,
        Command::SpliceMarkdown {
            page_id: fixture.page_a.clone(),
            block_id: fixture.text.clone(),
            index: insert_at,
            delete: 1,
            insert: "L".into(),
        },
    );
    execute(
        &mut right,
        &fixture.graph,
        right_peer,
        0,
        Command::SpliceMarkdown {
            page_id: fixture.page_a.clone(),
            block_id: fixture.text.clone(),
            index: insert_at,
            delete: 1,
            insert: "R".into(),
        },
    );
    execute(
        &mut left,
        &fixture.graph,
        left_peer,
        1,
        Command::MoveBlocks {
            block_ids: vec![fixture.moving.clone()],
            page_id: fixture.page_a.clone(),
            parent: None,
            index: 0,
        },
    );
    execute(
        &mut right,
        &fixture.graph,
        right_peer,
        1,
        Command::MoveBlocks {
            block_ids: vec![fixture.moving.clone()],
            page_id: fixture.page_a.clone(),
            parent: Some(fixture.alternate_parent.clone()),
            index: 0,
        },
    );
    execute(
        &mut left,
        &fixture.graph,
        left_peer,
        2,
        Command::DeleteBlocks {
            page_id: fixture.page_a.clone(),
            block_ids: vec![fixture.ancestor.clone()],
        },
    );
    execute(
        &mut right,
        &fixture.graph,
        right_peer,
        2,
        Command::MoveBlocks {
            block_ids: vec![fixture.descendant.clone()],
            page_id: fixture.page_a.clone(),
            parent: None,
            index: 1,
        },
    );
    execute(
        &mut left,
        &fixture.graph,
        left_peer,
        3,
        Command::SetProperty {
            owner: PropertyOwner::Block {
                page_id: fixture.page_a.clone(),
                id: fixture.text.clone(),
            },
            key: key("builtin.task-status"),
            value: PropertyValue::String("doing".into()),
        },
    );
    execute(
        &mut right,
        &fixture.graph,
        right_peer,
        3,
        Command::RemoveProperty {
            owner: PropertyOwner::Block {
                page_id: fixture.page_a.clone(),
                id: fixture.text.clone(),
            },
            key: key("builtin.task-status"),
        },
    );
    execute(
        &mut left,
        &fixture.graph,
        left_peer,
        4,
        Command::AddTag {
            entity: EntityId::Block {
                page_id: fixture.page_a.clone(),
                id: fixture.text.clone(),
            },
            tag_id: fixture.tag_b.clone(),
        },
    );
    execute(
        &mut right,
        &fixture.graph,
        right_peer,
        4,
        Command::RemoveTag {
            entity: EntityId::Block {
                page_id: fixture.page_a.clone(),
                id: fixture.text.clone(),
            },
            tag_id: fixture.tag_a.clone(),
        },
    );
    execute(
        &mut left,
        &fixture.graph,
        left_peer,
        5,
        Command::EnsureJournal {
            date: LocalDate::new("2026-08-03").unwrap(),
        },
    );
    execute(
        &mut right,
        &fixture.graph,
        right_peer,
        5,
        Command::EnsureJournal {
            date: LocalDate::new("2026-08-03").unwrap(),
        },
    );
    execute(
        &mut left,
        &fixture.graph,
        left_peer,
        6,
        Command::AddTag {
            entity: EntityId::Block {
                page_id: fixture.page_a.clone(),
                id: fixture.text.clone(),
            },
            tag_id: fixture.tag_b.clone(),
        },
    );
    execute(
        &mut right,
        &fixture.graph,
        right_peer,
        6,
        Command::SetProperty {
            owner: PropertyOwner::Block {
                page_id: fixture.page_a.clone(),
                id: fixture.text.clone(),
            },
            key: key("builtin.task-priority"),
            value: PropertyValue::String("low".into()),
        },
    );

    let left_update = left.export_all().unwrap();
    let right_update = right.export_all().unwrap();
    if seed & 1 == 0 {
        left.import_remote(&right_update).unwrap();
        right.import_remote(&left_update).unwrap();
        right.import_remote(&left_update).unwrap();
    } else {
        right.import_remote(&left_update).unwrap();
        left.import_remote(&right_update).unwrap();
        left.import_remote(&right_update).unwrap();
    }
    assert_eq!(
        left.fingerprint().unwrap(),
        right.fingerprint().unwrap(),
        "reproducible convergence seed: {seed:#x}"
    );
}

#[test]
fn convergence_randomized_disruptions_use_saved_seeds() {
    for &seed in REPRODUCIBLE_SEEDS {
        run_seed(seed);
    }
    let mut state = 0x02_5eed_f00du64;
    for _ in 0..48 {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        run_seed(state);
    }
}

#[test]
fn convergence_deleted_tag_is_not_published_after_concurrent_add() {
    let fixture = base_fixture(0x02_dead_7001);
    let mut left = GraphCore::from_snapshot(fixture.graph.clone(), 2, &fixture.snapshot).unwrap();
    let mut right = GraphCore::from_snapshot(fixture.graph.clone(), 3, &fixture.snapshot).unwrap();

    execute(
        &mut left,
        &fixture.graph,
        2,
        0,
        Command::DeleteTag {
            tag_id: fixture.tag_b.clone(),
        },
    );
    execute(
        &mut right,
        &fixture.graph,
        3,
        0,
        Command::AddTag {
            entity: EntityId::Block {
                page_id: fixture.page_a.clone(),
                id: fixture.text.clone(),
            },
            tag_id: fixture.tag_b.clone(),
        },
    );

    let left_update = left.export_all().unwrap();
    let right_update = right.export_all().unwrap();
    left.import_remote(&right_update).unwrap();
    right.import_remote(&left_update).unwrap();

    for core in [&left, &right] {
        let snapshot = core.snapshot().unwrap();
        assert!(snapshot.tags.iter().all(|tag| tag.id != fixture.tag_b));
        let block = snapshot.pages[0]
            .blocks
            .iter()
            .find(|block| block.id == fixture.text)
            .unwrap();
        assert!(block.tags.iter().all(|tag| tag != &fixture.tag_b));
        assert!(block.properties.iter().any(|entry| {
            entry.key.as_str() == "builtin.task-priority"
                && entry.values == [PropertyValue::String("high".into())]
        }));
    }
    assert_eq!(left.fingerprint().unwrap(), right.fingerprint().unwrap());
}

#[test]
fn convergence_query_text_and_view_choice_merge_independently() {
    let graph = GraphId::new("query-document-convergence").unwrap();
    let page = PageId::new("page").unwrap();
    let mut base = GraphCore::new(graph.clone(), 1, "base").unwrap();
    execute(
        &mut base,
        &graph,
        1,
        0,
        Command::EnsurePage {
            page_id: page.clone(),
            title: "Page".into(),
        },
    );
    let block = base
        .execute(
            CommandEnvelope {
                graph_id: graph.clone(),
                command_id: CommandId::new("query-block").unwrap(),
                command: Command::InsertBlock {
                    page_id: page.clone(),
                    parent: None,
                    index: 0,
                    markdown: "Query".into(),
                },
            },
            "base",
        )
        .unwrap()
        .result
        .created_block
        .unwrap();
    let owner = PropertyOwner::Block {
        page_id: page.clone(),
        id: block,
    };
    execute(
        &mut base,
        &graph,
        1,
        2,
        Command::SetQuerySource {
            owner: owner.clone(),
            source: "SELECT * WHERE {}".into(),
        },
    );
    let snapshot = base.export_snapshot().unwrap();
    let mut left = GraphCore::from_snapshot(graph.clone(), 2, &snapshot).unwrap();
    let mut right = GraphCore::from_snapshot(graph.clone(), 3, &snapshot).unwrap();

    execute(
        &mut left,
        &graph,
        2,
        0,
        Command::SpliceQuerySource {
            owner: owner.clone(),
            index: 17,
            delete: 0,
            insert: " LIMIT 5".into(),
        },
    );
    execute(
        &mut right,
        &graph,
        3,
        0,
        Command::SetQueryDefaultView {
            owner,
            view_id: QueryViewId::new("list").unwrap(),
        },
    );

    let left_update = left.export_all().unwrap();
    let right_update = right.export_all().unwrap();
    left.import_remote(&right_update).unwrap();
    right.import_remote(&left_update).unwrap();

    for core in [&left, &right] {
        let page = core.snapshot().unwrap().pages.remove(0);
        let field = page.blocks[0]
            .properties
            .iter()
            .find(|field| field.key.as_str() == "builtin.query")
            .unwrap();
        let PropertyValue::Document(document) = &field.values[0] else {
            panic!("query document was not preserved")
        };
        assert_eq!(document.source, "SELECT * WHERE {} LIMIT 5");
        assert_eq!(document.default_view_id.as_str(), "list");
    }
    assert_eq!(left.fingerprint().unwrap(), right.fingerprint().unwrap());
}
