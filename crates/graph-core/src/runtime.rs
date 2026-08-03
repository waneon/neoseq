use crate::{CoreError, GraphCore};
use domain::{CommandEnvelope, CommandResult, GraphId, GraphSnapshot};
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
    Semantic { name: String, command_id: String },
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

pub trait GraphRepository {
    type Error: std::error::Error + Send + Sync + 'static;
    fn append_update(&mut self, update: Vec<u8>) -> Result<(), Self::Error>;
}

#[derive(Debug, Default)]
pub struct InMemoryRepository {
    updates: Vec<Vec<u8>>,
}

impl InMemoryRepository {
    pub fn updates(&self) -> &[Vec<u8>] {
        &self.updates
    }
}

#[derive(Debug, Error)]
#[error("in-memory repository is infallible")]
pub struct InMemoryRepositoryError;

impl GraphRepository for InMemoryRepository {
    type Error = InMemoryRepositoryError;
    fn append_update(&mut self, update: Vec<u8>) -> Result<(), Self::Error> {
        if !update.is_empty() {
            self.updates.push(update);
        }
        Ok(())
    }
}

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
    #[error("repository append failed: {0}")]
    Repository(String),
    #[error("event capacity must be positive")]
    ZeroEventCapacity,
}

/// Single-owner message loop for one graph. Platform adapters enqueue the four
/// operations exposed here; `&mut self` is the serialization boundary on both
/// native and Wasm targets.
pub struct GraphRuntime<R: GraphRepository, C: Clock> {
    core: GraphCore,
    repository: R,
    clock: C,
    events: VecDeque<GraphEvent>,
    event_capacity: usize,
    next_cursor: u64,
}

impl<R: GraphRepository, C: Clock> GraphRuntime<R, C> {
    pub fn new(
        graph_id: GraphId,
        peer_id: u64,
        mut repository: R,
        mut clock: C,
        event_capacity: usize,
    ) -> Result<Self, RuntimeError> {
        if event_capacity == 0 {
            return Err(RuntimeError::ZeroEventCapacity);
        }
        let core = GraphCore::new(graph_id, peer_id, &clock.now())?;
        // Initialization is represented by a checkpoint in later persistence
        // stages, so no product update is appended here.
        let _ = &mut repository;
        Ok(Self {
            core,
            repository,
            clock,
            events: VecDeque::new(),
            event_capacity,
            next_cursor: 1,
        })
    }

    pub fn from_snapshot(
        graph_id: GraphId,
        peer_id: u64,
        snapshot: &[u8],
        repository: R,
        clock: C,
        event_capacity: usize,
    ) -> Result<Self, RuntimeError> {
        if event_capacity == 0 {
            return Err(RuntimeError::ZeroEventCapacity);
        }
        Ok(Self {
            core: GraphCore::from_snapshot(graph_id, peer_id, snapshot)?,
            repository,
            clock,
            events: VecDeque::new(),
            event_capacity,
            next_cursor: 1,
        })
    }

    pub fn execute(&mut self, command: CommandEnvelope) -> Result<CommandResult, RuntimeError> {
        let now = self.clock.now();
        let command_id = command.command_id.to_string();
        let execution = self.core.execute(command, &now)?;
        if !execution.duplicate {
            self.repository
                .append_update(execution.update)
                .map_err(|error| RuntimeError::Repository(error.to_string()))?;
            self.push(
                EventSource::Local,
                GraphEventKind::Semantic {
                    name: execution.semantic,
                    command_id,
                },
            );
        }
        Ok(execution.result)
    }

    pub fn import_remote(&mut self, update: &[u8]) -> Result<(), RuntimeError> {
        self.core.import_remote(update)?;
        self.repository
            .append_update(update.to_vec())
            .map_err(|error| RuntimeError::Repository(error.to_string()))?;
        self.push(EventSource::Remote, GraphEventKind::RemoteImported);
        Ok(())
    }

    pub fn read(&self) -> Result<GraphSnapshot, RuntimeError> {
        Ok(self.core.snapshot()?)
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

#[cfg(test)]
mod tests {
    use super::*;
    use domain::{Command, CommandId, PageId};

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
        let mut runtime = GraphRuntime::new(
            graph.clone(),
            1,
            InMemoryRepository::default(),
            InMemoryClock::new("tick"),
            2,
        )
        .unwrap();
        for number in 0..3 {
            runtime.execute(envelope(&graph, number)).unwrap();
        }
        assert_eq!(runtime.repository().updates().len(), 3);
        assert!(matches!(
            runtime.subscribe(0),
            EventBatch::ResyncRequired {
                oldest_cursor: 2,
                latest_cursor: 3
            }
        ));
        assert!(matches!(runtime.subscribe(1), EventBatch::Events { .. }));
    }
}
