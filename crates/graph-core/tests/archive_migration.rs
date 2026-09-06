use domain::{GraphId, PropertyValue};
use graph_core::{CoreError, GraphCore, SCHEMA_VERSION};
use loro::{Container, ExportMode, LoroDoc, LoroMap, ValueOrContainer};

fn fixture() -> graph_archive::DecodedArchive {
    graph_archive::decode(include_bytes!(
        "../../../fixtures/graph-archive/schema-6.neoseq"
    ))
    .unwrap()
}

fn source_id() -> GraphId {
    GraphId::new("schema-six-fixture").unwrap()
}

fn child(parent: &LoroMap, key: &str) -> LoroMap {
    match parent.get(key).unwrap() {
        ValueOrContainer::Container(Container::Map(map)) => map,
        _ => panic!("expected map at {key}"),
    }
}

fn properties(doc: &LoroDoc) -> LoroMap {
    child(
        &child(&child(&doc.get_map("pages"), "migration-page"), "root"),
        "properties",
    )
}

#[test]
fn legacy_writer_fixture_preserves_content_properties_and_query_identity_on_copy() {
    let archive = fixture();
    let source = GraphCore::from_archive_snapshot(source_id(), 99, 6, &archive.snapshot).unwrap();
    let before = source.snapshot().unwrap();
    assert_eq!(before.schema_version, SCHEMA_VERSION);
    assert!(before.quarantined.is_empty(), "{:?}", before.quarantined);
    let page = before
        .pages
        .iter()
        .find(|page| page.id.as_str() == "migration-page")
        .unwrap();
    assert_eq!(page.title, "Schema six notes");
    assert!(page.properties.get("user.empty").unwrap().values.is_empty());
    assert!(
        page.properties
            .get("user.empty-set")
            .unwrap()
            .values
            .is_empty()
    );
    assert_eq!(
        page.properties.get("user.labels").unwrap().values,
        vec![
            PropertyValue::String("alpha".into()),
            PropertyValue::String("beta".into())
        ]
    );
    assert_eq!(page.blocks.len(), 1);
    let block = &page.blocks[0];
    assert!(block.markdown.starts_with("Portable note "));
    assert_eq!(block.page_references[0].page_id.as_str(), "reference-page");
    assert_eq!(block.children[0].markdown, "Nested note");
    assert_eq!(block.tags[0].as_str(), "migration-tag");
    assert_eq!(
        block.properties.get("user.number").unwrap().values,
        vec![PropertyValue::Number(3.5)]
    );
    assert_eq!(
        block.properties.get("user.flag").unwrap().values,
        vec![PropertyValue::Checkbox(true)]
    );
    assert_eq!(
        block.properties.get("user.default").unwrap().values,
        vec![PropertyValue::String("from tag".into())]
    );
    assert_eq!(before.tags[0].blocks[0].markdown, "Tag note");
    assert_eq!(
        before.tags[0].defaults.get("user.default").unwrap().values,
        vec![PropertyValue::String("from tag".into())]
    );

    for target in ["first-import", "second-import"] {
        let target = GraphId::new(target).unwrap();
        let bytes = source.export_clone_snapshot(target.clone(), 99).unwrap();
        let clone = GraphCore::from_snapshot(target.clone(), 99, &bytes).unwrap();
        let after = clone.snapshot().unwrap();
        assert_eq!(after.graph_id, target);
        assert_eq!(
            after.pages.iter().map(|p| &p.id).collect::<Vec<_>>(),
            before.pages.iter().map(|p| &p.id).collect::<Vec<_>>()
        );
        let copied = after.pages.iter().find(|p| p.id == page.id).unwrap();
        assert_eq!(copied.blocks[0].id, block.id);
        assert_eq!(copied.blocks[0].content, block.content);
        assert_eq!(copied.blocks[0].children, block.children);
        assert_eq!(after.page_directory, before.page_directory);
        let old_iri = query::entity_iri(&source_id(), "page", "reference-page")
            .unwrap()
            .to_string();
        let new_iri = query::entity_iri(&target, "page", "reference-page")
            .unwrap()
            .to_string();
        let encoded = serde_json::to_string(&after).unwrap();
        assert!(!encoded.contains(&old_iri));
        assert_eq!(
            encoded.matches(&new_iri).count(),
            5,
            "all property and default queries retain their source"
        );
        assert!(after.quarantined.is_empty());
    }
}

#[test]
fn compatibility_is_limited_to_archives_with_matching_supported_schemas() {
    let archive = fixture();
    assert!(matches!(
        GraphCore::from_snapshot(source_id(), 99, &archive.snapshot),
        Err(CoreError::UnsupportedSchema(6))
    ));
    for schema in [0, 5, 8, u32::MAX] {
        assert!(matches!(
            GraphCore::from_archive_snapshot(source_id(), 99, schema, &archive.snapshot),
            Err(CoreError::UnsupportedSchema(_))
        ));
    }
    assert!(
        GraphCore::from_archive_snapshot(source_id(), 99, SCHEMA_VERSION, &archive.snapshot)
            .is_err()
    );
    assert!(matches!(
        GraphCore::from_archive_snapshot(
            GraphId::new("wrong-source").unwrap(),
            99,
            6,
            &archive.snapshot
        ),
        Err(CoreError::SnapshotGraphMismatch)
    ));
    let current = GraphCore::new(source_id(), 99, "2026-09-01T00:00:00Z")
        .unwrap()
        .export_snapshot()
        .unwrap();
    assert!(GraphCore::from_archive_snapshot(source_id(), 99, 6, &current).is_err());
    assert!(GraphCore::from_archive_snapshot(source_id(), 99, SCHEMA_VERSION, &current).is_ok());
}

#[test]
fn malformed_legacy_slots_are_rejected_without_dropping_them() {
    let archive = fixture();
    for (slot, value) in [
        ("f:user.broken", "{}"),
        ("s:user.orphan", r#"{"type":"string","value":"orphan"}"#),
        ("s:user.empty", r#"{"type":"number","value":3}"#),
        ("unknown-slot", "unexpected"),
        (
            "r:user.labels:invalid-hash",
            r#"{"type":"string","value":"gamma"}"#,
        ),
    ] {
        let doc = LoroDoc::from_snapshot(&archive.snapshot).unwrap();
        doc.set_peer_id(99).unwrap();
        properties(&doc).insert(slot, value).unwrap();
        let bytes = doc.export(ExportMode::Snapshot).unwrap();
        assert!(
            GraphCore::from_archive_snapshot(source_id(), 99, 6, &bytes).is_err(),
            "accepted {slot}"
        );
    }
}

#[test]
fn collected_deleted_metadata_is_valid_but_live_metadata_is_required() {
    let archive = fixture();
    let doc = LoroDoc::from_snapshot(&archive.snapshot).unwrap();
    doc.set_peer_id(99).unwrap();
    let page = child(&doc.get_map("pages"), "migration-page");
    let ValueOrContainer::Container(Container::Tree(tree)) = page.get("outline").unwrap() else {
        panic!()
    };
    let deleted = tree
        .nodes()
        .into_iter()
        .find(|node| tree.is_node_deleted(node).unwrap())
        .unwrap();
    let metadata = tree.get_meta(deleted).unwrap();
    for key in metadata.keys().collect::<Vec<_>>() {
        metadata.delete(&key).unwrap();
    }
    let migrated = GraphCore::from_archive_snapshot(
        source_id(),
        99,
        6,
        &doc.export(ExportMode::Snapshot).unwrap(),
    )
    .unwrap();
    let current = LoroDoc::from_snapshot(&migrated.export_snapshot().unwrap()).unwrap();
    current.set_peer_id(100).unwrap();
    let ValueOrContainer::Container(Container::Tree(tree)) =
        child(&current.get_map("pages"), "migration-page")
            .get("outline")
            .unwrap()
    else {
        panic!()
    };
    tree.create(None).unwrap();
    assert!(
        GraphCore::from_snapshot(
            source_id(),
            100,
            &current.export(ExportMode::Snapshot).unwrap()
        )
        .is_err()
    );
}
