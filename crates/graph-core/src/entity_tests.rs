use super::*;
use domain::{CommandId, EntityKind};

fn run(core: &mut GraphCore, command: Command) -> CoreExecution {
    let id = format!("command-{:?}", core.doc.oplog_vv());
    core.execute(
        CommandEnvelope {
            graph_id: core.graph_id().clone(),
            command_id: CommandId::new(id).unwrap(),
            command,
        },
        "2026-09-28T00:00:00Z",
    )
    .unwrap()
}
fn new() -> GraphCore {
    GraphCore::new(GraphId::new("entities").unwrap(), 1, "2026-09-28T00:00:00Z").unwrap()
}
fn id(value: &str) -> PageId {
    PageId::new(value).unwrap()
}
fn tag(value: &str) -> TagId {
    TagId::new(value).unwrap()
}
fn page(core: &mut GraphCore, value: &str, title: &str) {
    run(
        core,
        Command::EnsurePage {
            page_id: id(value),
            title: title.into(),
        },
    );
}
fn convert(core: &mut GraphCore, value: &str, kind: EntityKind) -> CoreExecution {
    run(
        core,
        Command::SetEntityKind {
            id: id(value),
            kind,
        },
    )
}

#[test]
fn conversion_preserves_document_blocks_references_memberships_defaults_and_undo() {
    let mut core = new();
    page(&mut core, "env", "env");
    page(&mut core, "notes", "Notes");
    let block = run(
        &mut core,
        Command::InsertBlock {
            owner: OutlineOwner::Page { id: id("env") },
            parent: None,
            index: 0,
            markdown: "Environment notes".into(),
        },
    )
    .result
    .created_block
    .unwrap();
    let referent = run(
        &mut core,
        Command::InsertBlock {
            owner: OutlineOwner::Page { id: id("notes") },
            parent: None,
            index: 0,
            markdown: String::new(),
        },
    )
    .result
    .created_block
    .unwrap();
    run(
        &mut core,
        Command::SpliceBlockContent {
            owner: OutlineOwner::Page { id: id("notes") },
            block_id: referent.clone(),
            index: 0,
            delete: 0,
            insert: vec![InlineContent::PageReference { page_id: id("env") }],
        },
    );
    convert(&mut core, "env", EntityKind::Tag);
    let snapshot = core.snapshot().unwrap();
    assert_eq!(snapshot.tags[0].id.as_str(), "env");
    assert_eq!(snapshot.tags[0].blocks[0].id, block);
    assert_eq!(snapshot.pages[0].blocks[0].markdown, "[[env]]");
    let owner = PropertyOwner::TagDefault { tag_id: tag("env") };
    run(
        &mut core,
        Command::SetProperty {
            owner,
            key: key("user.context"),
            value: PropertyValue::String("shell".into()),
        },
    );
    let entity = EntityId::Block {
        owner: OutlineOwner::Page { id: id("notes") },
        id: referent,
    };
    run(
        &mut core,
        Command::AddTag {
            entity: entity.clone(),
            tag_id: tag("env"),
        },
    );
    convert(&mut core, "env", EntityKind::Page);
    let snapshot = core.snapshot().unwrap();
    assert!(snapshot.tags.is_empty());
    let notes = snapshot
        .pages
        .iter()
        .find(|page| page.id == id("notes"))
        .unwrap();
    assert_eq!(notes.blocks[0].tags, [tag("env")]);
    assert_eq!(
        notes.blocks[0]
            .properties
            .get("user.context")
            .unwrap()
            .values,
        [PropertyValue::String("shell".into())]
    );
    assert_eq!(
        snapshot
            .pages
            .iter()
            .find(|page| page.id == id("env"))
            .unwrap()
            .blocks[0]
            .id,
        block
    );
    assert!(
        core.prepare_transition(&Command::AddTag {
            entity,
            tag_id: tag("env")
        })
        .is_err()
    );
    run(&mut core, Command::Undo);
    assert_eq!(
        core.snapshot().unwrap().tags[0]
            .defaults
            .get("user.context")
            .unwrap()
            .values,
        [PropertyValue::String("shell".into())]
    );
    run(&mut core, Command::Redo);
    assert!(core.snapshot().unwrap().tags.is_empty());
    convert(&mut core, "env", EntityKind::Tag);
    assert_eq!(core.snapshot().unwrap().tags[0].blocks[0].id, block);
    let reopened =
        GraphCore::from_snapshot(core.graph_id().clone(), 2, &core.export_snapshot().unwrap())
            .unwrap();
    assert_eq!(reopened.snapshot().unwrap(), core.snapshot().unwrap());
}

#[test]
fn names_are_shared_and_concurrent_cross_kind_collisions_are_preserved() {
    let mut left = new();
    let mut right =
        GraphCore::from_snapshot(left.graph_id().clone(), 2, &left.export_snapshot().unwrap())
            .unwrap();
    page(&mut left, "page", "  Env  ");
    assert!(
        left.prepare_transition(&Command::EnsureTag {
            tag_id: tag("another"),
            name: "ENV".into()
        })
        .is_err()
    );
    run(
        &mut right,
        Command::EnsureTag {
            tag_id: tag("tag"),
            name: "env".into(),
        },
    );
    let update = left.export_updates_since(&right.version_vector()).unwrap();
    let other = right.export_updates_since(&left.version_vector()).unwrap();
    left.import_remote(&other).unwrap();
    right.import_remote(&update).unwrap();
    assert_eq!(left.snapshot().unwrap(), right.snapshot().unwrap());
    let snapshot = left.snapshot().unwrap();
    assert_eq!(snapshot.pages.len(), 1);
    assert_eq!(snapshot.tags.len(), 1);
    assert!(snapshot.conflicts.iter().any(|conflict| matches!(conflict, GraphConflict::DuplicateEntityName { canonical_name, .. } if canonical_name == "env")));
    run(
        &mut left,
        Command::RenameTag {
            tag_id: tag("tag"),
            name: "Environment".into(),
        },
    );
    assert!(left.snapshot().unwrap().conflicts.is_empty());
}

#[test]
fn conversion_merges_with_offline_edits_using_the_old_outline_owner() {
    let mut left = new();
    page(&mut left, "env", "env");
    let owner = OutlineOwner::Page { id: id("env") };
    let block = run(
        &mut left,
        Command::InsertBlock {
            owner: owner.clone(),
            parent: None,
            index: 0,
            markdown: "Before".into(),
        },
    )
    .result
    .created_block
    .unwrap();
    let mut right =
        GraphCore::from_snapshot(left.graph_id().clone(), 2, &left.export_snapshot().unwrap())
            .unwrap();
    let converted = convert(&mut left, "env", EntityKind::Tag);
    let edited = run(
        &mut right,
        Command::EditMarkdown {
            owner: owner.clone(),
            block_id: block.clone(),
            markdown: "Offline edit".into(),
        },
    );
    left.import_remote(&edited.update).unwrap();
    right.import_remote(&converted.update).unwrap();
    assert_eq!(left.snapshot().unwrap(), right.snapshot().unwrap());
    assert_eq!(
        left.snapshot().unwrap().tags[0].blocks[0].markdown,
        "Offline edit"
    );
    run(
        &mut right,
        Command::EditMarkdown {
            owner,
            block_id: block,
            markdown: "Still writable".into(),
        },
    );
    assert_eq!(
        right.snapshot().unwrap().tags[0].blocks[0].markdown,
        "Still writable"
    );
}

#[test]
fn legacy_tag_converts_in_place_without_recreating_its_tree() {
    let core = new();
    let record = core
        .doc
        .get_map("tags")
        .ensure_mergeable_map("legacy")
        .unwrap();
    record.insert("name", "Legacy").unwrap();
    record.ensure_mergeable_map("defaults").unwrap();
    initialize_lifecycle(&record.ensure_mergeable_map("properties").unwrap(), "t0").unwrap();
    record
        .ensure_mergeable_tree("outline")
        .unwrap()
        .enable_fractional_index(0);
    core.doc
        .get_map("meta")
        .insert("schema_version", 7_i64)
        .unwrap();
    core.doc.commit();
    let mut core =
        GraphCore::from_snapshot(core.graph_id().clone(), 2, &core.export_snapshot().unwrap())
            .unwrap();
    let block = run(
        &mut core,
        Command::InsertBlock {
            owner: OutlineOwner::Tag { id: tag("legacy") },
            parent: None,
            index: 0,
            markdown: "Legacy text".into(),
        },
    )
    .result
    .created_block
    .unwrap();
    let container = core.require_tag(&tag("legacy")).unwrap().id();
    convert(&mut core, "legacy", EntityKind::Page);
    assert_eq!(core.require_page(&id("legacy")).unwrap().id(), container);
    assert_eq!(core.snapshot().unwrap().pages[0].blocks[0].id, block);
    core.finish_recovery().unwrap();
    convert(&mut core, "legacy", EntityKind::Tag);
    assert_eq!(
        core.snapshot().unwrap().tags[0].blocks[0].markdown,
        "Legacy text"
    );
}
