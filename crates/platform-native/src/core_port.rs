use crate::{FaultPoint, SqliteGraphRepository, SqliteRepositoryError};
use domain::{
    CORE_PORT_VERSION, CloseGraphRequest, CloseGraphResponse, CommandEnvelope, CorePortError,
    CorePortErrorCode, ExecuteRequest, ExecuteResponse, GraphId, GraphLocationDto,
    OpenGraphRequest, OpenGraphResponse, ReadRequest, ReadResponse, RecoveryDto, SaveStatusDto,
    StorageCapabilitiesDto, SubscribeRequest, SubscribeResponse,
};
use graph_core::{
    EventBatch, GraphLocation, GraphLocator, GraphRuntime, InMemoryClock, LocalGraphRepository,
    RuntimeError, recover_graph,
};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

type NativeRuntime = GraphRuntime<SqliteGraphRepository, InMemoryClock>;

pub struct NativeCorePort {
    database_path: PathBuf,
    runtimes: BTreeMap<String, NativeRuntime>,
    event_capacity: usize,
    tick: u64,
}

impl NativeCorePort {
    pub fn new(database_path: impl Into<PathBuf>, event_capacity: usize) -> Self {
        Self {
            database_path: database_path.into(),
            runtimes: BTreeMap::new(),
            event_capacity,
            tick: 0,
        }
    }

    pub fn database_path(&self) -> &Path {
        &self.database_path
    }

    pub fn open_graph(
        &mut self,
        request: OpenGraphRequest,
    ) -> Result<OpenGraphResponse, CorePortError> {
        if request.contract_version != CORE_PORT_VERSION {
            return Err(port_error(
                CorePortErrorCode::UnsupportedContract,
                "unsupported CorePort contract version",
                false,
            ));
        }
        if !matches!(request.locator.location, GraphLocationDto::Local) {
            return Err(port_error(
                CorePortErrorCode::InvalidRequest,
                "only local graph locators are supported",
                false,
            ));
        }
        let graph_id = GraphId::new(&request.locator.graph_id).map_err(|error| {
            port_error(CorePortErrorCode::InvalidRequest, &error.to_string(), false)
        })?;
        let handle = format!("local:{}", graph_id.as_str());
        if self.runtimes.contains_key(&handle) {
            return Err(port_error(
                CorePortErrorCode::GraphAlreadyOpen,
                "graph is already open in this CorePort",
                false,
            ));
        }
        let opened_at = self.now();
        let mut repository = SqliteGraphRepository::open(
            &self.database_path,
            GraphLocator {
                graph_id: graph_id.clone(),
                location: GraphLocation::Local,
            },
            &opened_at,
        )
        .map_err(map_storage_error)?;
        let recovered_at = self.now();
        let (core, recovery) =
            recover_graph(&mut repository, graph_id, request.peer_id, &recovered_at)
                .map_err(|error| map_recovery_error(&error.to_string()))?;
        if repository
            .checkpoints_descending()
            .map_err(map_storage_error)?
            .is_empty()
        {
            let checkpointed_at = self.now();
            repository
                .save_checkpoint(
                    &core.export_snapshot().map_err(map_core_error)?,
                    0,
                    &checkpointed_at,
                )
                .map_err(map_storage_error)?;
        }
        let snapshot = serde_json::to_value(core.snapshot().map_err(map_core_error)?)
            .map_err(map_json_error)?;
        let capabilities = repository.capabilities();
        let runtime = GraphRuntime::from_core(
            core,
            repository,
            InMemoryClock::new("native-core-port"),
            self.event_capacity,
        )
        .map_err(map_runtime_error)?;
        self.runtimes.insert(handle.clone(), runtime);
        Ok(OpenGraphResponse {
            graph_handle: handle,
            snapshot,
            capabilities: StorageCapabilitiesDto {
                durable: capabilities.durable,
                persisted: capabilities.persisted,
                quota_bytes: capabilities.quota_bytes,
                usage_bytes: capabilities.usage_bytes,
            },
            recovery: RecoveryDto {
                checkpoint_sequence: recovery.checkpoint_sequence,
                replayed_updates: recovery.replayed_updates as u32,
                quarantined_records: recovery.quarantined_records,
            },
        })
    }

    pub fn execute(&mut self, request: ExecuteRequest) -> Result<ExecuteResponse, CorePortError> {
        if request.timeout_ms == 0 {
            return Err(port_error(
                CorePortErrorCode::CommandTimeout,
                "command deadline elapsed before dispatch",
                true,
            ));
        }
        let command: CommandEnvelope =
            serde_json::from_value(request.command).map_err(map_json_error)?;
        let runtime = self.runtime_mut(&request.graph_handle)?;
        let result = runtime.execute(command).map_err(map_runtime_error)?;
        let metadata = runtime
            .repository_mut()
            .metadata()
            .map_err(map_storage_error)?;
        let local_sequence = metadata.next_sequence.saturating_sub(1);
        let checksum = runtime
            .repository_mut()
            .updates_after(local_sequence.saturating_sub(1))
            .map_err(map_storage_error)?
            .last()
            .map_or_else(String::new, |record| record.checksum.clone());
        Ok(ExecuteResponse {
            result: serde_json::to_value(result).map_err(map_json_error)?,
            save_status: SaveStatusDto::SavedLocally {
                local_sequence,
                checksum,
            },
        })
    }

    pub fn read(&mut self, request: ReadRequest) -> Result<ReadResponse, CorePortError> {
        let snapshot = self
            .runtime_mut(&request.graph_handle)?
            .read()
            .map_err(map_runtime_error)?;
        Ok(ReadResponse {
            snapshot: serde_json::to_value(snapshot).map_err(map_json_error)?,
        })
    }

    pub fn subscribe(
        &mut self,
        request: SubscribeRequest,
    ) -> Result<SubscribeResponse, CorePortError> {
        match self
            .runtime_mut(&request.graph_handle)?
            .subscribe(request.after_cursor)
        {
            EventBatch::Events {
                events,
                next_cursor,
            } => Ok(SubscribeResponse {
                events: events
                    .into_iter()
                    .map(serde_json::to_value)
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(map_json_error)?,
                next_cursor,
                resync_required: false,
            }),
            EventBatch::ResyncRequired { latest_cursor, .. } => Ok(SubscribeResponse {
                events: Vec::new(),
                next_cursor: latest_cursor,
                resync_required: true,
            }),
        }
    }

    pub fn close_graph(
        &mut self,
        request: CloseGraphRequest,
    ) -> Result<CloseGraphResponse, CorePortError> {
        if self
            .runtimes
            .get(&request.graph_handle)
            .ok_or_else(graph_not_open)?
            .is_dirty_unsaved()
        {
            return Err(port_error(
                CorePortErrorCode::DirtyUnsaved,
                "close rejected while an update is not durable",
                true,
            ));
        }
        let mut runtime = self
            .runtimes
            .remove(&request.graph_handle)
            .ok_or_else(graph_not_open)?;
        let metadata = runtime
            .repository_mut()
            .metadata()
            .map_err(map_storage_error)?;
        let through = metadata.next_sequence.saturating_sub(1);
        let snapshot = runtime.core().export_snapshot().map_err(map_core_error)?;
        let now = self.now();
        runtime
            .repository_mut()
            .save_checkpoint(&snapshot, through, &now)
            .map_err(map_storage_error)?;
        runtime
            .repository_mut()
            .mark_compacted(through)
            .map_err(map_storage_error)?;
        runtime.close().map_err(map_runtime_error)?;
        Ok(CloseGraphResponse { closed: true })
    }

    pub fn inject_fault(
        &mut self,
        graph_handle: &str,
        fault: FaultPoint,
    ) -> Result<(), CorePortError> {
        self.runtime_mut(graph_handle)?
            .repository_mut()
            .inject_once(fault);
        Ok(())
    }

    pub fn retry_pending(&mut self, graph_handle: &str) -> Result<(), CorePortError> {
        self.runtime_mut(graph_handle)?
            .retry_pending()
            .map_err(map_runtime_error)
    }

    fn runtime_mut(&mut self, handle: &str) -> Result<&mut NativeRuntime, CorePortError> {
        self.runtimes.get_mut(handle).ok_or_else(graph_not_open)
    }

    fn now(&mut self) -> String {
        let value = format!("2026-08-03T12:30:{:02}Z", self.tick % 60);
        self.tick += 1;
        value
    }
}

fn graph_not_open() -> CorePortError {
    port_error(
        CorePortErrorCode::GraphNotOpen,
        "graph handle is not open",
        false,
    )
}

fn map_runtime_error(error: RuntimeError) -> CorePortError {
    match error {
        RuntimeError::DirtyUnsaved(message) => {
            let code = if message.to_ascii_lowercase().contains("busy") {
                CorePortErrorCode::StorageBusy
            } else if message.to_ascii_lowercase().contains("full") {
                CorePortErrorCode::StorageFull
            } else {
                CorePortErrorCode::DirtyUnsaved
            };
            port_error(code, &message, true)
        }
        RuntimeError::Core(error) => map_core_error(error),
        RuntimeError::Repository(message) => {
            port_error(CorePortErrorCode::Internal, &message, true)
        }
        RuntimeError::ZeroEventCapacity => port_error(
            CorePortErrorCode::InvalidRequest,
            "event capacity must be positive",
            false,
        ),
    }
}

fn map_core_error(error: graph_core::CoreError) -> CorePortError {
    let code = match error {
        graph_core::CoreError::WrongGraph { .. } => CorePortErrorCode::WrongGraph,
        graph_core::CoreError::UnsupportedSchema(_) => CorePortErrorCode::UnsupportedSchema,
        _ => CorePortErrorCode::InvalidRequest,
    };
    port_error(code, &error.to_string(), false)
}

fn map_storage_error(error: SqliteRepositoryError) -> CorePortError {
    let (code, retryable) = match error {
        SqliteRepositoryError::Busy => (CorePortErrorCode::StorageBusy, true),
        SqliteRepositoryError::DiskFull => (CorePortErrorCode::StorageFull, true),
        SqliteRepositoryError::Corrupt(_) => (CorePortErrorCode::StorageCorrupt, false),
        SqliteRepositoryError::RemoteUnavailable => (CorePortErrorCode::InvalidRequest, false),
        SqliteRepositoryError::NotFound => (CorePortErrorCode::GraphNotOpen, false),
        SqliteRepositoryError::Injected(_) | SqliteRepositoryError::Sqlite(_) => {
            (CorePortErrorCode::Internal, true)
        }
    };
    port_error(code, &error.to_string(), retryable)
}

fn map_recovery_error(message: &str) -> CorePortError {
    let code = if message.contains("unsupported schema") {
        CorePortErrorCode::UnsupportedSchema
    } else if message.contains("corrupt") || message.contains("none are valid") {
        CorePortErrorCode::StorageCorrupt
    } else {
        CorePortErrorCode::Internal
    };
    port_error(code, message, false)
}

fn map_json_error(error: serde_json::Error) -> CorePortError {
    port_error(CorePortErrorCode::InvalidRequest, &error.to_string(), false)
}

fn port_error(code: CorePortErrorCode, message: &str, retryable: bool) -> CorePortError {
    CorePortError {
        code,
        message: message.to_owned(),
        retryable,
    }
}
