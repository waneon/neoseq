//! Minimal causal document used by synchronization rooms.
//!
//! A server room does not execute editor commands, maintain local undo, cache
//! command results, or build query projections. Keeping only the Loro document
//! and graph identity makes that boundary structural instead of conventional.

use crate::{
    core::{CoreError, configure_inline_content, new_document},
    document::{CausalChanges, validate_causal_changes, validate_causal_document},
};
use domain::GraphId;
use loro::{ExportMode, LoroDoc, VersionVector};
use std::sync::{Arc, Mutex};

/// The document state required by a durable synchronization room.
pub struct ServerGraph {
    graph_id: GraphId,
    doc: LoroDoc,
}

/// A deep copy; it costs a snapshot round trip of the whole document.
impl Clone for ServerGraph {
    fn clone(&self) -> Self {
        let doc = self.doc.fork();
        configure_inline_content(&doc);
        doc.set_peer_id(self.doc.peer_id())
            .expect("a fork accepts its origin's peer ID");
        Self {
            graph_id: self.graph_id.clone(),
            doc,
        }
    }
}

impl ServerGraph {
    pub fn new(graph_id: GraphId, peer_id: u64, now: &str) -> Result<Self, CoreError> {
        let doc = new_document(&graph_id, peer_id, now)?;
        Ok(Self { graph_id, doc })
    }

    /// Opens and validates a server-owned checkpoint without constructing an
    /// interactive `GraphCore` and its undo/idempotency state.
    pub fn from_checkpoint(
        graph_id: GraphId,
        peer_id: u64,
        checkpoint: &[u8],
    ) -> Result<Self, CoreError> {
        let doc = LoroDoc::from_snapshot(checkpoint)?;
        configure_inline_content(&doc);
        doc.set_peer_id(peer_id)?;
        validate_causal_document(&doc, &graph_id)?;
        Ok(Self { graph_id, doc })
    }

    /// Imports one durable Tail record. The caller owns the disposable room
    /// under reconstruction and validates the complete state once afterward.
    pub fn stage_recovery_update(&mut self, update: &[u8]) -> Result<(), CoreError> {
        let status = self.doc.import(update)?;
        if status.pending.is_some() {
            return Err(CoreError::MissingDependencies);
        }
        Ok(())
    }

    pub fn finish_recovery(&self) -> Result<(), CoreError> {
        validate_causal_document(&self.doc, &self.graph_id)
    }

    pub fn graph_id(&self) -> &GraphId {
        &self.graph_id
    }

    pub fn version_vector(&self) -> Vec<u8> {
        self.doc.oplog_vv().encode()
    }

    pub fn validate_version_vector(encoded: &[u8]) -> Result<(), CoreError> {
        VersionVector::decode(encoded)?;
        Ok(())
    }

    pub fn export_updates_since(&self, encoded: &[u8]) -> Result<Vec<u8>, CoreError> {
        let version = VersionVector::decode(encoded)?;
        Ok(self.doc.export(ExportMode::updates(&version))?)
    }

    pub fn export_gc_checkpoint(&self) -> Result<Vec<u8>, CoreError> {
        let frontiers = self.doc.oplog_frontiers();
        Ok(self.doc.export(ExportMode::shallow_snapshot(&frontiers))?)
    }

    pub fn export_snapshot(&self) -> Result<Vec<u8>, CoreError> {
        Ok(self.doc.export(ExportMode::Snapshot)?)
    }

    /// Imports an untrusted update and validates only what it changed; the
    /// graph was valid before it, so admission cost follows the update rather
    /// than the graph. Loro cannot retract imported operations: after an error
    /// this graph may hold rejected state and must be discarded.
    pub fn admit_update(&mut self, update: &[u8]) -> Result<(), CoreError> {
        let changes = import_recording(&self.doc, update)?;
        validate_causal_changes(&self.doc, &self.graph_id, &changes)
    }
}

/// Imports an update and records which containers it changed.
fn import_recording(doc: &LoroDoc, update: &[u8]) -> Result<CausalChanges, CoreError> {
    let changes = Arc::new(Mutex::new(CausalChanges::default()));
    let recorder = Arc::clone(&changes);
    let subscription = doc.subscribe_root(Arc::new(move |event| {
        recorder
            .lock()
            .expect("change recorder is not poisoned")
            .record(&event);
    }));
    let status = doc.import(update)?;
    subscription.unsubscribe();
    if status.pending.is_some() {
        return Err(CoreError::MissingDependencies);
    }
    Ok(std::mem::take(
        &mut *changes.lock().expect("change recorder is not poisoned"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        GraphCore,
        document::{QUERY_PLAN_STATE_VERSION, StoredPlanState},
    };
    use domain::{
        Command, CommandEnvelope, CommandId, PageId, QUERY_DOCUMENT_SCHEMA, QUERY_DOCUMENT_VERSION,
        QUERY_LANGUAGE, QUERY_PLAN_LIMIT, QueryPlan,
    };
    use loro::{Container, LoroMap, ValueOrContainer};

    fn graph_id() -> GraphId {
        GraphId::new("server-graph-test").unwrap()
    }

    fn query_document(doc: &LoroDoc) -> LoroMap {
        let settings = doc.get_map("graph_settings");
        let queries = settings.ensure_mergeable_map("default_queries").unwrap();
        let entry = queries.ensure_mergeable_map("saved").unwrap();
        entry.insert("deleted", false).unwrap();
        entry.insert("title", "Saved").unwrap();
        entry.insert("position", 0_i64).unwrap();
        let document = entry.ensure_mergeable_map("document").unwrap();
        document.insert("schema", QUERY_DOCUMENT_SCHEMA).unwrap();
        document
            .insert("version", i64::from(QUERY_DOCUMENT_VERSION))
            .unwrap();
        document.insert("default_view_id", "all").unwrap();
        let view = document
            .ensure_mergeable_map("views")
            .unwrap()
            .ensure_mergeable_map("all")
            .unwrap();
        view.insert("deleted", false).unwrap();
        view.insert("name", "All").unwrap();
        view.insert("kind", "table").unwrap();
        view.insert("position", 0_i64).unwrap();
        view.insert("columns", "[]").unwrap();
        view.insert("options", "{}").unwrap();
        let definition = view.ensure_mergeable_map("definition").unwrap();
        definition.insert("language", QUERY_LANGUAGE).unwrap();
        definition.ensure_mergeable_text("source").unwrap();
        definition
            .insert(
                "plan_state",
                serde_json::to_string(&StoredPlanState::Raw).unwrap(),
            )
            .unwrap();
        document
    }

    fn query_definition(doc: &LoroDoc) -> LoroMap {
        let ValueOrContainer::Container(Container::Map(queries)) = doc
            .get_map("graph_settings")
            .get("default_queries")
            .unwrap()
        else {
            panic!("default queries are not a map")
        };
        let ValueOrContainer::Container(Container::Map(entry)) = queries.get("saved").unwrap()
        else {
            panic!("saved query is not a map")
        };
        let ValueOrContainer::Container(Container::Map(document)) = entry.get("document").unwrap()
        else {
            panic!("query document is not a map")
        };
        let ValueOrContainer::Container(Container::Map(views)) = document.get("views").unwrap()
        else {
            panic!("query views are not a map")
        };
        let ValueOrContainer::Container(Container::Map(view)) = views.get("all").unwrap() else {
            panic!("query view is not a map")
        };
        let ValueOrContainer::Container(Container::Map(definition)) =
            view.get("definition").unwrap()
        else {
            panic!("query definition is not a map")
        };
        definition
    }

    fn query_checkpoint() -> Vec<u8> {
        let doc = new_document(&graph_id(), 11, "t0").unwrap();
        query_document(&doc);
        doc.commit();
        doc.export(ExportMode::Snapshot).unwrap()
    }

    fn snapshot_with_plan_state(checkpoint: &[u8], peer_id: u64, encoded: &str) -> Vec<u8> {
        let doc = LoroDoc::from_snapshot(checkpoint).unwrap();
        configure_inline_content(&doc);
        doc.set_peer_id(peer_id).unwrap();
        query_definition(&doc)
            .insert("plan_state", encoded)
            .unwrap();
        doc.commit();
        doc.export(ExportMode::Snapshot).unwrap()
    }

    fn update_with_plan_state(checkpoint: &[u8], peer_id: u64, encoded: &str) -> Vec<u8> {
        let doc = LoroDoc::from_snapshot(checkpoint).unwrap();
        configure_inline_content(&doc);
        doc.set_peer_id(peer_id).unwrap();
        let baseline = doc.oplog_vv();
        query_definition(&doc)
            .insert("plan_state", encoded)
            .unwrap();
        doc.commit();
        doc.export(ExportMode::updates(&baseline)).unwrap()
    }

    fn assert_checkpoint_rejected(checkpoint: &[u8]) {
        assert!(ServerGraph::from_checkpoint(graph_id(), 99, checkpoint).is_err());
    }

    #[test]
    fn prepared_update_is_adopted_without_interactive_state() {
        let graph_id = graph_id();
        let mut writer = GraphCore::new(graph_id.clone(), 1, "t0").unwrap();
        let checkpoint = writer.export_gc_checkpoint().unwrap();
        let mut room = ServerGraph::from_checkpoint(graph_id.clone(), 2, &checkpoint).unwrap();

        let update = writer
            .execute(
                CommandEnvelope {
                    graph_id: graph_id.clone(),
                    command_id: CommandId::new("create-page").unwrap(),
                    command: Command::EnsurePage {
                        page_id: PageId::new("page").unwrap(),
                        title: "Page".into(),
                    },
                },
                "t1",
            )
            .unwrap()
            .update;

        assert_ne!(room.version_vector(), writer.version_vector());
        room.admit_update(&update).unwrap();
        assert_eq!(room.version_vector(), writer.version_vector());
    }

    #[test]
    fn opaque_future_query_plan_round_trips_through_server_boundaries() {
        let checkpoint = query_checkpoint();
        let future = QueryPlan {
            version: domain::QUERY_PLAN_VERSION + 1,
            payload: r#"{"future":true}"#.into(),
        };
        future.validate().unwrap();
        let encoded = serde_json::to_string(&StoredPlanState::Built {
            version: QUERY_PLAN_STATE_VERSION,
            plan: future,
        })
        .unwrap();

        let future_checkpoint = snapshot_with_plan_state(&checkpoint, 12, &encoded);
        let opened = ServerGraph::from_checkpoint(graph_id(), 13, &future_checkpoint).unwrap();
        let reopened = LoroDoc::from_snapshot(&opened.export_snapshot().unwrap()).unwrap();
        assert_eq!(
            query_definition(&reopened)
                .get("plan_state")
                .and_then(|value| match value {
                    ValueOrContainer::Value(loro::LoroValue::String(value)) => {
                        Some((*value).clone())
                    }
                    _ => None,
                }),
            Some(encoded.clone())
        );

        let mut room = ServerGraph::from_checkpoint(graph_id(), 14, &checkpoint).unwrap();
        let update = update_with_plan_state(&checkpoint, 15, &encoded);
        let baseline = room.version_vector();
        room.admit_update(&update).unwrap();
        assert_ne!(room.version_vector(), baseline);
    }

    #[test]
    fn malformed_and_oversized_plan_envelopes_are_rejected() {
        let checkpoint = query_checkpoint();
        let wrong_storage_version = serde_json::to_string(&StoredPlanState::Built {
            version: QUERY_PLAN_STATE_VERSION + 1,
            plan: QueryPlan {
                version: domain::QUERY_PLAN_VERSION + 1,
                payload: "{}".into(),
            },
        })
        .unwrap();
        let oversized = serde_json::to_string(&StoredPlanState::Built {
            version: QUERY_PLAN_STATE_VERSION,
            plan: QueryPlan {
                version: domain::QUERY_PLAN_VERSION + 1,
                payload: format!(r#"{{"value":"{}"}}"#, "x".repeat(QUERY_PLAN_LIMIT)),
            },
        })
        .unwrap();

        for (peer_id, encoded) in [
            (20, "{".to_owned()),
            (21, wrong_storage_version),
            (22, oversized),
        ] {
            assert_checkpoint_rejected(&snapshot_with_plan_state(&checkpoint, peer_id, &encoded));
        }
    }

    #[test]
    fn malformed_plan_update_is_rejected_on_admission_and_after_recovery() {
        let checkpoint = query_checkpoint();
        let update = update_with_plan_state(&checkpoint, 30, "{");
        let mut room = ServerGraph::from_checkpoint(graph_id(), 31, &checkpoint).unwrap();
        assert!(room.admit_update(&update).is_err());

        let mut recovery = ServerGraph::from_checkpoint(graph_id(), 32, &checkpoint).unwrap();
        recovery.stage_recovery_update(&update).unwrap();
        assert!(recovery.finish_recovery().is_err());
    }

    mod change_scoped_admission {
        use super::super::import_recording;
        use super::*;
        use crate::document::{PAGE_REFERENCE_CHAR, PAGE_REFERENCE_MARK};
        use domain::{
            BlockId, EntityId, EntityKind, InlineContent, LocalDate, OutlineItem, OutlineOwner,
            PropertyKey, PropertyOwner, PropertyValue, TagId,
        };
        use loro::{LoroText, LoroTree, TreeParentId};

        struct Session {
            writer: GraphCore,
            room: ServerGraph,
            sequence: u32,
        }

        impl Session {
            fn new() -> Self {
                let writer = GraphCore::new(graph_id(), 1, "t0").unwrap();
                let checkpoint = writer.export_gc_checkpoint().unwrap();
                let room = ServerGraph::from_checkpoint(graph_id(), 2, &checkpoint).unwrap();
                Self {
                    writer,
                    room,
                    sequence: 0,
                }
            }

            /// Runs a command, admits its update, and checks the admitted state
            /// against the whole-document contract.
            fn run(&mut self, command: Command) -> (bool, usize, usize, usize) {
                self.sequence += 1;
                let update = self
                    .writer
                    .execute(
                        CommandEnvelope {
                            graph_id: graph_id(),
                            command_id: CommandId::new(format!("c{}", self.sequence)).unwrap(),
                            command,
                        },
                        "t1",
                    )
                    .unwrap()
                    .update;
                let probe = self.room.doc.fork();
                let scope = import_recording(&probe, &update).unwrap().scope();
                self.room.admit_update(&update).unwrap();
                validate_causal_document(&self.room.doc, &graph_id()).unwrap();
                scope
            }

            fn page(&self) -> LoroMap {
                match self.room.doc.get_map("entities").get("page") {
                    Some(ValueOrContainer::Container(Container::Map(record))) => record,
                    _ => panic!("page record is missing"),
                }
            }

            /// A raw update from another replica, and whether a full
            /// validation of its result would accept it.
            fn forge(&self, edit: impl FnOnce(&LoroDoc)) -> (Vec<u8>, bool) {
                let doc = self.room.doc.fork();
                configure_inline_content(&doc);
                doc.set_peer_id(99).unwrap();
                let baseline = doc.oplog_vv();
                edit(&doc);
                doc.commit();
                let update = doc.export(ExportMode::updates(&baseline)).unwrap();
                let full = validate_causal_document(&doc, &graph_id()).is_ok();
                (update, full)
            }
        }

        fn outline(record: &LoroMap) -> LoroTree {
            match record.get("outline") {
                Some(ValueOrContainer::Container(Container::Tree(tree))) => tree,
                _ => panic!("outline is missing"),
            }
        }

        fn first_block(record: &LoroMap) -> LoroMap {
            let tree = outline(record);
            tree.get_meta(tree.roots()[0]).unwrap()
        }

        fn child_map(map: &LoroMap, key: &str) -> LoroMap {
            match map.get(key) {
                Some(ValueOrContainer::Container(Container::Map(map))) => map,
                _ => panic!("{key} is missing"),
            }
        }

        fn child_text(map: &LoroMap, key: &str) -> LoroText {
            match map.get(key) {
                Some(ValueOrContainer::Container(Container::Text(text))) => text,
                _ => panic!("{key} is missing"),
            }
        }

        fn seeded() -> (Session, OutlineOwner, BlockId) {
            let mut session = Session::new();
            let page = PageId::new("page").unwrap();
            let owner = OutlineOwner::Page { id: page.clone() };
            session.run(Command::EnsurePage {
                page_id: page.clone(),
                title: "Page".into(),
            });
            session.run(Command::InsertOutline {
                owner: owner.clone(),
                parent: None,
                index: 0,
                replace: None,
                items: (0..4)
                    .map(|index| OutlineItem {
                        depth: usize::from(index > 1),
                        markdown: format!("block {index}"),
                    })
                    .collect(),
            });
            let block = session.writer.page_snapshot(&page).unwrap().blocks[0]
                .id
                .clone();
            (session, owner, block)
        }

        #[test]
        fn ordinary_edits_validate_only_what_they_touch() {
            let (mut session, owner, block) = seeded();
            let page = PageId::new("page").unwrap();

            // Typing is one block.
            assert_eq!(
                session.run(Command::SpliceMarkdown {
                    owner: owner.clone(),
                    block_id: block.clone(),
                    index: 0,
                    delete: 0,
                    insert: "x".into(),
                }),
                (false, 0, 0, 1)
            );

            session.run(Command::EnsurePage {
                page_id: PageId::new("other").unwrap(),
                title: "Other".into(),
            });
            session.run(Command::SpliceBlockContent {
                owner: owner.clone(),
                block_id: block.clone(),
                index: 0,
                delete: 0,
                insert: vec![InlineContent::PageReference {
                    page_id: PageId::new("other").unwrap(),
                }],
            });
            session.run(Command::SetProperty {
                owner: PropertyOwner::Block {
                    owner: owner.clone(),
                    id: block.clone(),
                },
                key: PropertyKey::new("builtin.task-status").unwrap(),
                value: PropertyValue::String("todo".into()),
            });
            let tag = TagId::new("tag").unwrap();
            session.run(Command::EnsureTag {
                tag_id: tag.clone(),
                name: "Tag".into(),
            });
            session.run(Command::AddTag {
                entity: EntityId::Block {
                    owner: owner.clone(),
                    id: block.clone(),
                },
                tag_id: tag,
            });
            let second = session.writer.page_snapshot(&page).unwrap().blocks[1]
                .id
                .clone();
            session.run(Command::IndentBlocks {
                owner: owner.clone(),
                block_ids: vec![second.clone()],
            });
            session.run(Command::DeleteBlocks {
                owner,
                block_ids: vec![second],
            });
            session.run(Command::RenamePage {
                page_id: page,
                title: "Renamed".into(),
            });
            session.run(Command::EnsureJournal {
                date: LocalDate::new("2026-10-12").unwrap(),
            });
            session.run(Command::SetEntityKind {
                id: PageId::new("other").unwrap(),
                kind: EntityKind::Tag,
            });
        }

        #[test]
        fn malformed_updates_are_rejected_as_a_full_validation_would() {
            let (session, _, _) = seeded();
            type Edit = Box<dyn FnOnce(&LoroDoc, &LoroMap)>;
            let cases: Vec<(&str, Edit)> = vec![
                (
                    "document in a second home",
                    Box::new(|doc, _| {
                        doc.get_map("pages")
                            .insert_container("page", LoroMap::new())
                            .unwrap();
                    }),
                ),
                (
                    "dangling page reference",
                    Box::new(|_, page| {
                        let content = child_text(&first_block(page), "content");
                        content.insert(0, &PAGE_REFERENCE_CHAR.to_string()).unwrap();
                        content
                            .mark(0..1, PAGE_REFERENCE_MARK, "missing-page")
                            .unwrap();
                    }),
                ),
                (
                    "malformed block property",
                    Box::new(|_, page| {
                        let properties = child_map(&first_block(page), "properties");
                        let field = properties
                            .insert_container("user.broken", LoroMap::new())
                            .unwrap();
                        field.insert("shape", "not json").unwrap();
                    }),
                ),
                (
                    "block without content",
                    Box::new(|_, page| {
                        let tree = outline(page);
                        let node = tree.create(TreeParentId::Root).unwrap();
                        tree.get_meta(node).unwrap().insert("stray", true).unwrap();
                    }),
                ),
                (
                    "reserved atom in a title",
                    Box::new(|_, page| {
                        let title = child_text(&child_map(page, "root"), "content");
                        title.insert(0, &PAGE_REFERENCE_CHAR.to_string()).unwrap();
                    }),
                ),
                (
                    "another graph's identity",
                    Box::new(|doc, _| {
                        doc.get_map("meta").insert("graph_id", "elsewhere").unwrap();
                    }),
                ),
                (
                    "document without a root",
                    Box::new(|doc, _| {
                        doc.get_map("entities")
                            .insert_container("broken", LoroMap::new())
                            .unwrap();
                    }),
                ),
                (
                    "document in two homes",
                    Box::new(|doc, _| {
                        doc.get_map("pages")
                            .insert_container("page", LoroMap::new())
                            .unwrap();
                    }),
                ),
                (
                    "removed document",
                    Box::new(|doc, _| {
                        doc.get_map("entities").delete("page").unwrap();
                    }),
                ),
                (
                    "invalid lifecycle on a block",
                    Box::new(|_, page| {
                        child_map(&first_block(page), "properties")
                            .delete("builtin.created-at")
                            .unwrap();
                    }),
                ),
            ];
            for (name, edit) in cases {
                let page = session.page();
                let (update, full) = session.forge(move |doc| {
                    let record = match doc.get_map("entities").get("page") {
                        Some(ValueOrContainer::Container(Container::Map(record))) => record,
                        _ => panic!("page record is missing"),
                    };
                    drop(page);
                    edit(doc, &record);
                });
                // A rejection leaves its operations behind; each case gets its own room.
                let mut room = session.room.clone();
                let accepted = room.admit_update(&update).is_ok();
                assert_eq!(
                    accepted, full,
                    "{name}: change-scoped admission disagrees with full validation"
                );
                let scope = import_recording(&session.room.doc.fork(), &update)
                    .unwrap()
                    .scope();
                match name {
                    // Removing a document is outside every unit; the whole
                    // document decides, and nothing references this one.
                    "removed document" => assert!(scope.0 && accepted, "{name}"),
                    _ => assert!(!scope.0 && !accepted, "{name}: {scope:?}"),
                }
            }
        }
    }
}
