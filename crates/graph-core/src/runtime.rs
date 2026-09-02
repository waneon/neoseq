use crate::{AppendReceipt, CoreError, GraphChangeSet, GraphCore, StorageErrorKind};
use domain::{
    CommandEnvelope, CommandResult, GraphSnapshot, GraphSummary, OutlineOwner, OutlineSnapshot,
};
use query::{GraphIndex, QueryError, QueryRequest, QueryResult};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventSource {
    Local,
    Remote,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GraphEventKind {
    Semantic {
        name: String,
        command_id: String,
    },
    SavedLocally {
        local_sequence: u64,
        checksum: String,
    },
    RemoteImported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphEvent {
    pub cursor: u64,
    pub source: EventSource,
    pub kind: GraphEventKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum EventBatch {
    Events {
        events: Vec<GraphEvent>,
        next_cursor: u64,
    },
    ResyncRequired {
        oldest_cursor: u64,
        latest_cursor: u64,
    },
}

pub use crate::persistence::GraphRepository;

pub trait Clock {
    fn now(&mut self) -> String;
}

#[derive(Debug, Clone)]
pub struct InMemoryClock {
    prefix: String,
    tick: u64,
}

impl InMemoryClock {
    pub fn new(prefix: impl Into<String>) -> Self {
        Self {
            prefix: prefix.into(),
            tick: 0,
        }
    }
}

impl Clock for InMemoryClock {
    fn now(&mut self) -> String {
        let value = format!("{}-{:06}", self.prefix, self.tick);
        self.tick += 1;
        value
    }
}

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error(transparent)]
    Core(#[from] CoreError),
    #[error(transparent)]
    Query(#[from] QueryError),
    #[error("graph has an update that is not saved locally: {message}")]
    DirtyUnsaved {
        kind: StorageErrorKind,
        message: String,
    },
    #[error("event capacity must be positive")]
    ZeroEventCapacity,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RuntimeExecution {
    pub result: CommandResult,
    pub persistence: RuntimePersistence,
}

/// Durable effect of one successful runtime command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimePersistence {
    Appended(AppendReceipt),
    /// A duplicate or semantic no-op produced no bytes that needed persistence.
    Unchanged,
}

/// Single-owner message loop for one graph. Platform adapters enqueue the four
/// operations exposed here; `&mut self` is the serialization boundary on both
/// native and Wasm targets.
pub struct GraphRuntime<R: GraphRepository, C: Clock> {
    core: GraphCore,
    index: GraphIndex,
    repository: R,
    clock: C,
    events: VecDeque<GraphEvent>,
    event_capacity: usize,
    next_cursor: u64,
    pending: Option<PendingWrite>,
}

struct PendingWrite {
    update: Vec<u8>,
    created_at: String,
    source: EventSource,
    semantic: String,
    command_id: Option<String>,
}

impl<R: GraphRepository, C: Clock> GraphRuntime<R, C> {
    pub fn from_core(
        core: GraphCore,
        repository: R,
        clock: C,
        event_capacity: usize,
    ) -> Result<Self, RuntimeError> {
        if event_capacity == 0 {
            return Err(RuntimeError::ZeroEventCapacity);
        }
        let index = GraphIndex::from_units(
            core.graph_id().clone(),
            core.frontier(),
            core.index_units()?,
        )?;
        Ok(Self {
            core,
            index,
            repository,
            clock,
            events: VecDeque::new(),
            event_capacity,
            next_cursor: 1,
            pending: None,
        })
    }

    pub fn execute(&mut self, command: CommandEnvelope) -> Result<RuntimeExecution, RuntimeError> {
        self.require_clean()?;
        let now = self.clock.now();
        let command_id = command.command_id.to_string();
        let execution = self.core.execute(command, &now)?;
        apply_index_changes(&self.core, &mut self.index, &execution.changes)?;
        let persistence = if !execution.duplicate && !execution.update.is_empty() {
            self.pending = Some(PendingWrite {
                update: execution.update,
                created_at: now,
                source: EventSource::Local,
                semantic: execution.semantic,
                command_id: Some(command_id),
            });
            RuntimePersistence::Appended(self.persist_pending()?)
        } else {
            RuntimePersistence::Unchanged
        };
        Ok(RuntimeExecution {
            result: execution.result,
            persistence,
        })
    }

    pub fn import_remote(&mut self, update: &[u8]) -> Result<(), RuntimeError> {
        self.require_clean()?;
        let changes = self.core.import_remote_with_changes(update)?;
        apply_index_changes(&self.core, &mut self.index, &changes)?;
        self.pending = Some(PendingWrite {
            update: update.to_vec(),
            created_at: self.clock.now(),
            source: EventSource::Remote,
            semantic: "RemoteImported".to_owned(),
            command_id: None,
        });
        self.persist_pending().map(|_| ())
    }

    pub fn read(&self) -> Result<GraphSnapshot, RuntimeError> {
        Ok(self.core.snapshot()?)
    }

    pub fn read_summary(&self) -> Result<GraphSummary, RuntimeError> {
        Ok(self.core.summary()?)
    }

    pub fn read_outline(&self, owner: &OutlineOwner) -> Result<OutlineSnapshot, RuntimeError> {
        Ok(self.core.outline_snapshot(owner)?)
    }

    pub fn query(&self, request: QueryRequest) -> Result<QueryResult, RuntimeError> {
        self.require_clean()?;
        Ok(self.index.execute(request)?)
    }

    pub fn subscribe(&self, after_cursor: u64) -> EventBatch {
        let latest = self.next_cursor.saturating_sub(1);
        let oldest = self
            .events
            .front()
            .map_or(self.next_cursor, |event| event.cursor);
        if after_cursor.saturating_add(1) < oldest {
            return EventBatch::ResyncRequired {
                oldest_cursor: oldest,
                latest_cursor: latest,
            };
        }
        let events = self
            .events
            .iter()
            .filter(|event| event.cursor > after_cursor)
            .cloned()
            .collect();
        EventBatch::Events {
            events,
            next_cursor: latest,
        }
    }

    pub fn core(&self) -> &GraphCore {
        &self.core
    }

    pub fn repository(&self) -> &R {
        &self.repository
    }

    pub fn repository_mut(&mut self) -> &mut R {
        &mut self.repository
    }

    pub fn is_dirty_unsaved(&self) -> bool {
        self.pending.is_some()
    }

    pub fn retry_pending(&mut self) -> Result<(), RuntimeError> {
        if self.pending.is_none() {
            return Ok(());
        }
        self.persist_pending().map(|_| ())
    }

    pub fn close(self) -> Result<(R, C), RuntimeError> {
        if self.pending.is_some() {
            return Err(RuntimeError::DirtyUnsaved {
                kind: StorageErrorKind::Other,
                message: "close rejected until the pending update is durable".to_owned(),
            });
        }
        Ok((self.repository, self.clock))
    }

    fn require_clean(&self) -> Result<(), RuntimeError> {
        if self.pending.is_some() {
            Err(RuntimeError::DirtyUnsaved {
                kind: StorageErrorKind::Other,
                message: "retry the pending update before another mutation".to_owned(),
            })
        } else {
            Ok(())
        }
    }

    fn persist_pending(&mut self) -> Result<AppendReceipt, RuntimeError> {
        let pending = self.pending.as_ref().expect("pending write checked above");
        let receipt = self
            .repository
            .append_update(&pending.update, &pending.created_at)
            .map_err(|error| RuntimeError::DirtyUnsaved {
                kind: R::error_kind(&error),
                message: error.to_string(),
            })?;
        let pending = self
            .pending
            .take()
            .expect("pending write remains available");
        match pending.source {
            EventSource::Local => self.push(
                EventSource::Local,
                GraphEventKind::Semantic {
                    name: pending.semantic,
                    command_id: pending.command_id.unwrap_or_default(),
                },
            ),
            EventSource::Remote => {
                self.push(EventSource::Remote, GraphEventKind::RemoteImported);
            }
        }
        self.push(
            pending.source,
            GraphEventKind::SavedLocally {
                local_sequence: receipt.local_sequence,
                checksum: receipt.checksum.clone(),
            },
        );
        Ok(receipt)
    }

    fn push(&mut self, source: EventSource, kind: GraphEventKind) {
        self.events.push_back(GraphEvent {
            cursor: self.next_cursor,
            source,
            kind,
        });
        self.next_cursor += 1;
        while self.events.len() > self.event_capacity {
            self.events.pop_front();
        }
    }
}

/// Advances a disposable query index to the core's current committed revision.
/// Both native and Wasm adapters use this single fallback policy.
pub fn apply_index_changes(
    core: &GraphCore,
    index: &mut GraphIndex,
    changes: &GraphChangeSet,
) -> Result<(), RuntimeError> {
    match core.index_delta(changes)? {
        Some(delta) => {
            if index.apply_delta(delta).is_err() {
                index.rebuild_from_units(
                    core.graph_id().clone(),
                    core.frontier(),
                    core.index_units()?,
                )?;
            }
        }
        None => {
            index.rebuild_from_units(
                core.graph_id().clone(),
                core.frontier(),
                core.index_units()?,
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AppendReceipt, checksum};
    use domain::{Command, CommandId, GraphId, PageId};

    #[derive(Debug, Clone)]
    struct InMemoryUpdate {
        local_sequence: u64,
        checksum: String,
    }

    #[derive(Debug, Default)]
    struct InMemoryRepository {
        updates: Vec<InMemoryUpdate>,
    }

    #[derive(Debug, Error)]
    #[error("in-memory repository is infallible")]
    struct InMemoryRepositoryError;

    impl GraphRepository for InMemoryRepository {
        type Error = InMemoryRepositoryError;
        fn append_update(
            &mut self,
            update: &[u8],
            _created_at: &str,
        ) -> Result<AppendReceipt, Self::Error> {
            let digest = checksum(update);
            if let Some(existing) = self.updates.iter().find(|record| record.checksum == digest) {
                return Ok(AppendReceipt {
                    local_sequence: existing.local_sequence,
                    checksum: digest,
                });
            }
            let local_sequence = self.updates.len() as u64 + 1;
            self.updates.push(InMemoryUpdate {
                local_sequence,
                checksum: digest.clone(),
            });
            Ok(AppendReceipt {
                local_sequence,
                checksum: digest,
            })
        }
    }

    fn new_runtime<R: GraphRepository>(
        graph: &GraphId,
        repository: R,
        event_capacity: usize,
    ) -> GraphRuntime<R, InMemoryClock> {
        let mut clock = InMemoryClock::new("tick");
        let core = GraphCore::new(graph.clone(), 1, &clock.now()).unwrap();
        GraphRuntime::from_core(core, repository, clock, event_capacity).unwrap()
    }

    fn envelope(graph: &GraphId, number: usize) -> CommandEnvelope {
        CommandEnvelope {
            graph_id: graph.clone(),
            command_id: CommandId::new(format!("command-{number}")).unwrap(),
            command: Command::EnsurePage {
                page_id: PageId::new(format!("page-{number}")).unwrap(),
                title: format!("Page {number}"),
            },
        }
    }

    #[test]
    fn model_runtime_serializes_and_bounds_events() {
        let graph = GraphId::new("runtime").unwrap();
        let mut runtime = new_runtime(&graph, InMemoryRepository::default(), 2);
        for number in 0..3 {
            let execution = runtime.execute(envelope(&graph, number)).unwrap();
            let RuntimePersistence::Appended(receipt) = execution.persistence else {
                panic!("new page command must append an update");
            };
            assert_eq!(receipt.local_sequence, number as u64 + 1);
        }
        assert_eq!(runtime.repository().updates.len(), 3);
        assert!(matches!(
            runtime.subscribe(0),
            EventBatch::ResyncRequired {
                oldest_cursor: 5,
                latest_cursor: 6
            }
        ));
        assert!(matches!(runtime.subscribe(4), EventBatch::Events { .. }));
        let EventBatch::Events { events, .. } = runtime.subscribe(4) else {
            panic!("expected retained events");
        };
        assert!(matches!(events[0].kind, GraphEventKind::Semantic { .. }));
        assert!(matches!(
            events[1].kind,
            GraphEventKind::SavedLocally {
                local_sequence: 3,
                ..
            }
        ));
    }

    #[test]
    fn runtime_queries_publish_the_page_delta_after_an_edit() {
        let graph = GraphId::new("runtime-query").unwrap();
        let page_id = PageId::new("home").unwrap();
        let mut runtime = new_runtime(&graph, InMemoryRepository::default(), 8);
        runtime
            .execute(CommandEnvelope {
                graph_id: graph.clone(),
                command_id: CommandId::new("page").unwrap(),
                command: Command::EnsurePage {
                    page_id: page_id.clone(),
                    title: "Home".into(),
                },
            })
            .unwrap();
        let block_id = runtime
            .execute(CommandEnvelope {
                graph_id: graph.clone(),
                command_id: CommandId::new("block").unwrap(),
                command: Command::InsertBlock {
                    owner: OutlineOwner::Page {
                        id: page_id.clone(),
                    },
                    parent: None,
                    index: 0,
                    markdown: "before".into(),
                },
            })
            .unwrap()
            .result
            .created_block
            .unwrap();
        runtime
            .execute(CommandEnvelope {
                graph_id: graph,
                command_id: CommandId::new("edit").unwrap(),
                command: Command::EditMarkdown {
                    owner: OutlineOwner::Page { id: page_id },
                    block_id,
                    markdown: "after".into(),
                },
            })
            .unwrap();

        let result = runtime
            .query(QueryRequest {
                language: query::QUERY_LANGUAGE.into(),
                source: format!("ASK {{ ?block <{}content> \"after\" }}", query::NEO_NS),
                bindings: Default::default(),
                budget: Default::default(),
            })
            .unwrap();
        assert!(matches!(result, QueryResult::Ask { value: true, .. }));
    }

    #[derive(Debug, Error)]
    #[error("injected append failure")]
    struct InjectedFailure;

    #[derive(Default)]
    struct FailingRepository {
        fail: bool,
        records: Vec<Vec<u8>>,
    }

    impl GraphRepository for FailingRepository {
        type Error = InjectedFailure;

        fn error_kind(_error: &Self::Error) -> StorageErrorKind {
            StorageErrorKind::Busy
        }

        fn append_update(
            &mut self,
            update: &[u8],
            _created_at: &str,
        ) -> Result<AppendReceipt, Self::Error> {
            if self.fail {
                return Err(InjectedFailure);
            }
            self.records.push(update.to_vec());
            Ok(AppendReceipt {
                local_sequence: self.records.len() as u64,
                checksum: checksum(update),
            })
        }
    }

    #[test]
    fn persistence_saved_event_follows_append_and_dirty_bytes_can_retry() {
        let graph = GraphId::new("runtime-failure").unwrap();
        let mut runtime = new_runtime(
            &graph,
            FailingRepository {
                fail: true,
                records: Vec::new(),
            },
            8,
        );
        assert!(matches!(
            runtime.execute(envelope(&graph, 1)),
            Err(RuntimeError::DirtyUnsaved {
                kind: StorageErrorKind::Busy,
                ..
            })
        ));
        assert!(runtime.is_dirty_unsaved());
        assert!(matches!(
            runtime.subscribe(0),
            EventBatch::Events { ref events, .. } if events.is_empty()
        ));
        assert!(matches!(
            runtime.execute(envelope(&graph, 2)),
            Err(RuntimeError::DirtyUnsaved { .. })
        ));
        runtime.repository_mut().fail = false;
        runtime.retry_pending().unwrap();
        assert!(!runtime.is_dirty_unsaved());
        assert_eq!(runtime.repository().records.len(), 1);
        let EventBatch::Events { events, .. } = runtime.subscribe(0) else {
            panic!("events expected after durable retry");
        };
        assert!(matches!(events[0].kind, GraphEventKind::Semantic { .. }));
        assert!(matches!(
            events[1].kind,
            GraphEventKind::SavedLocally { .. }
        ));
    }
}
