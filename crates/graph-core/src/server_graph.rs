//! Minimal causal document used by synchronization rooms.
//!
//! A server room does not execute editor commands, maintain local undo, cache
//! command results, or build query projections. Keeping only the Loro document
//! and graph identity makes that boundary structural instead of conventional.

use crate::{
    core::{CoreError, configure_inline_content, new_document},
    document::validate_causal_document,
};
use domain::GraphId;
use loro::{ExportMode, LoroDoc, VersionVector};

/// The document state required by a durable synchronization room.
pub struct ServerGraph {
    graph_id: GraphId,
    doc: LoroDoc,
}

/// An update imported and validated on an isolated candidate document.
///
/// The candidate is adopted only after the exact update bytes are durable.
#[must_use = "a prepared server update must be adopted after durable insertion or discarded"]
pub struct PreparedServerUpdate {
    graph: ServerGraph,
    snapshot_len: usize,
}

impl PreparedServerUpdate {
    pub fn snapshot_len(&self) -> usize {
        self.snapshot_len
    }

    pub fn into_graph(self) -> ServerGraph {
        self.graph
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

    /// Imports an untrusted update exactly once on a deep fork and returns an
    /// immutable candidate for durable-before-adopt room semantics.
    pub fn prepare_update(&self, update: &[u8]) -> Result<PreparedServerUpdate, CoreError> {
        let candidate = self.doc.fork();
        configure_inline_content(&candidate);
        candidate.set_peer_id(self.doc.peer_id())?;
        let status = candidate.import(update)?;
        if status.pending.is_some() {
            return Err(CoreError::MissingDependencies);
        }
        validate_causal_document(&candidate, &self.graph_id)?;

        let snapshot_len = candidate.export(ExportMode::Snapshot)?.len();
        Ok(PreparedServerUpdate {
            graph: Self {
                graph_id: self.graph_id.clone(),
                doc: candidate,
            },
            snapshot_len,
        })
    }
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

        let baseline_version = room.version_vector();
        let candidate = room.prepare_update(&update).unwrap();
        assert_eq!(room.version_vector(), baseline_version);
        assert_ne!(room.version_vector(), writer.version_vector());
        let measured_checkpoint_len = candidate.snapshot_len();
        room = candidate.into_graph();
        assert_eq!(room.version_vector(), writer.version_vector());
        assert_eq!(
            room.export_snapshot().unwrap().len(),
            measured_checkpoint_len
        );
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

        let room = ServerGraph::from_checkpoint(graph_id(), 14, &checkpoint).unwrap();
        let update = update_with_plan_state(&checkpoint, 15, &encoded);
        let baseline = room.version_vector();
        let accepted = room.prepare_update(&update).unwrap().into_graph();
        assert_eq!(room.version_vector(), baseline);
        assert_ne!(accepted.version_vector(), baseline);
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
    fn malformed_plan_update_is_rejected_before_adoption_and_after_recovery() {
        let checkpoint = query_checkpoint();
        let update = update_with_plan_state(&checkpoint, 30, "{");
        let room = ServerGraph::from_checkpoint(graph_id(), 31, &checkpoint).unwrap();
        let baseline = room.version_vector();
        assert!(room.prepare_update(&update).is_err());
        assert_eq!(room.version_vector(), baseline);

        let mut recovery = ServerGraph::from_checkpoint(graph_id(), 32, &checkpoint).unwrap();
        recovery.stage_recovery_update(&update).unwrap();
        assert!(recovery.finish_recovery().is_err());
    }
}
