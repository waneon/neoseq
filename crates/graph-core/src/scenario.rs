use crate::{CoreError, GraphCore};
use domain::{
    BlockId, Command, CommandEnvelope, CommandId, EntityId, GraphId, LocalDate, PageId,
    PropertyKey, PropertyValue, TagId,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use thiserror::Error;

type TranslatedCommand = (Command, Option<(String, PageId)>, Option<String>);

#[derive(Debug, Error)]
pub enum ScenarioError {
    #[error("scenario YAML is invalid: {0}")]
    Yaml(#[from] serde_yaml::Error),
    #[error("scenario JSON encoding failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Core(#[from] CoreError),
    #[error("unknown block alias: {0}")]
    UnknownBlock(String),
    #[error("invalid scenario value: {0}")]
    Invalid(String),
}

#[derive(Debug, Deserialize)]
pub struct Scenario {
    pub graph_id: GraphId,
    #[serde(default = "default_peer")]
    pub peer_id: u64,
    #[serde(default)]
    pub commands: Vec<ScenarioCommand>,
    #[serde(default)]
    pub peers: Vec<PeerBranch>,
}

fn default_peer() -> u64 {
    1
}

#[derive(Debug, Deserialize)]
pub struct PeerBranch {
    pub peer_id: u64,
    #[serde(default)]
    pub commands: Vec<ScenarioCommand>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum ScenarioCommand {
    EnsurePage {
        page_id: PageId,
        title: String,
    },
    EnsureJournal {
        date: LocalDate,
        #[serde(default)]
        as_id: Option<String>,
    },
    RenamePage {
        page_id: PageId,
        title: String,
    },
    DeletePage {
        page_id: PageId,
    },
    RestorePage {
        page_id: PageId,
    },
    EnsureTag {
        tag_id: TagId,
        name: String,
    },
    InsertBlock {
        as_id: String,
        page_id: PageId,
        #[serde(default)]
        parent: Option<String>,
        #[serde(default)]
        index: usize,
        #[serde(default)]
        markdown: String,
    },
    EditMarkdown {
        block: String,
        markdown: String,
    },
    SpliceMarkdown {
        block: String,
        index: usize,
        #[serde(default)]
        delete: usize,
        #[serde(default)]
        insert: String,
    },
    MoveBlock {
        block: String,
        page_id: PageId,
        #[serde(default)]
        parent: Option<String>,
        #[serde(default)]
        index: usize,
    },
    IndentBlock {
        block: String,
    },
    OutdentBlock {
        block: String,
    },
    DeleteBlock {
        block: String,
    },
    SetProperty {
        entity: String,
        key: PropertyKey,
        value: PropertyValue,
    },
    RemoveProperty {
        entity: String,
        key: PropertyKey,
    },
    AddRepeatedProperty {
        entity: String,
        key: PropertyKey,
        value: PropertyValue,
    },
    RemoveRepeatedProperty {
        entity: String,
        key: PropertyKey,
        value: PropertyValue,
    },
    SetTagDefault {
        tag_id: TagId,
        key: PropertyKey,
        value: PropertyValue,
    },
    AddTag {
        block: String,
        tag_id: TagId,
    },
    Undo,
    Redo,
}

#[derive(Debug, Clone, Serialize)]
struct ScenarioEvent {
    peer_id: u64,
    command_id: String,
    semantic: String,
    changed: bool,
    created_page: Option<PageId>,
    created_block: Option<BlockId>,
    created_tag: Option<TagId>,
}

#[derive(Debug, Serialize)]
struct PeerResult {
    peer_id: u64,
    fingerprint: String,
}

#[derive(Debug, Serialize)]
struct ScenarioOutput {
    schema: u32,
    graph: domain::GraphSnapshot,
    fingerprint: String,
    converged: bool,
    peers: Vec<PeerResult>,
    events: Vec<ScenarioEvent>,
}

pub fn run_scenario_str(source: &str) -> Result<String, ScenarioError> {
    let scenario: Scenario = serde_yaml::from_str(source)?;
    let mut aliases = BTreeMap::new();
    let mut events = Vec::new();
    let mut base = GraphCore::new(
        scenario.graph_id.clone(),
        scenario.peer_id,
        "scenario-000000",
    )?;
    run_commands(
        &mut base,
        scenario.peer_id,
        &scenario.commands,
        &mut aliases,
        &mut events,
    )?;

    if scenario.peers.is_empty() {
        let fingerprint = base.fingerprint()?;
        let output = ScenarioOutput {
            schema: 3,
            graph: base.snapshot()?,
            fingerprint: fingerprint.clone(),
            converged: true,
            peers: vec![PeerResult {
                peer_id: scenario.peer_id,
                fingerprint,
            }],
            events,
        };
        return Ok(serde_json::to_string_pretty(&output)?);
    }

    let snapshot = base.export_snapshot()?;
    let mut peers = Vec::new();
    for branch in &scenario.peers {
        let mut peer =
            GraphCore::from_snapshot(scenario.graph_id.clone(), branch.peer_id, &snapshot)?;
        let mut branch_aliases = aliases.clone();
        run_commands(
            &mut peer,
            branch.peer_id,
            &branch.commands,
            &mut branch_aliases,
            &mut events,
        )?;
        peers.push((branch.peer_id, peer));
    }

    let updates: Vec<Vec<u8>> = peers
        .iter()
        .map(|(_, peer)| peer.export_all())
        .collect::<Result<_, _>>()?;
    for (peer_id, peer) in &mut peers {
        for update in updates.iter().rev() {
            peer.import_remote(update)?;
            peer.import_remote(update)?;
        }
        events.push(ScenarioEvent {
            peer_id: *peer_id,
            command_id: "remote-import-reordered-and-duplicated".into(),
            semantic: "RemoteImported".into(),
            changed: true,
            created_page: None,
            created_block: None,
            created_tag: None,
        });
    }

    let peer_results: Vec<PeerResult> = peers
        .iter()
        .map(|(peer_id, peer)| {
            Ok(PeerResult {
                peer_id: *peer_id,
                fingerprint: peer.fingerprint()?,
            })
        })
        .collect::<Result<_, CoreError>>()?;
    let converged = peer_results
        .windows(2)
        .all(|pair| pair[0].fingerprint == pair[1].fingerprint);
    let (fingerprint, graph) = {
        let peer = &peers[0].1;
        (peer.fingerprint()?, peer.snapshot()?)
    };
    let output = ScenarioOutput {
        schema: 3,
        graph,
        fingerprint,
        converged,
        peers: peer_results,
        events,
    };
    Ok(serde_json::to_string_pretty(&output)?)
}

pub fn basic_scenario_json() -> Result<String, ScenarioError> {
    run_scenario_str(include_str!("../../../fixtures/core/basic.yaml"))
}

fn run_commands(
    core: &mut GraphCore,
    peer_id: u64,
    commands: &[ScenarioCommand],
    aliases: &mut BTreeMap<String, (PageId, BlockId)>,
    events: &mut Vec<ScenarioEvent>,
) -> Result<(), ScenarioError> {
    for (index, scenario_command) in commands.iter().enumerate() {
        let (command, block_alias, journal_alias) = translate(scenario_command, aliases)?;
        let command_id = format!("peer-{peer_id}-command-{index}");
        let execution = core.execute(
            CommandEnvelope {
                graph_id: core.graph_id().clone(),
                command_id: CommandId::new(&command_id)
                    .map_err(|error| ScenarioError::Invalid(error.to_string()))?,
                command,
            },
            &format!("scenario-{peer_id:04}-{index:06}"),
        )?;
        if let (Some((alias, page_id)), Some(block)) =
            (block_alias, execution.result.created_block.clone())
        {
            aliases.insert(alias, (page_id, block));
        }
        if let (Some(_alias), Some(_page)) = (journal_alias, execution.result.created_page.clone())
        {
            // Journal IDs are deterministic and already visible in the result;
            // the alias is accepted for fixture readability but page commands use IDs.
        }
        events.push(ScenarioEvent {
            peer_id,
            command_id,
            semantic: execution.semantic,
            changed: execution.result.changed,
            created_page: execution.result.created_page,
            created_block: execution.result.created_block,
            created_tag: execution.result.created_tag,
        });
    }
    Ok(())
}

fn translate(
    input: &ScenarioCommand,
    aliases: &BTreeMap<String, (PageId, BlockId)>,
) -> Result<TranslatedCommand, ScenarioError> {
    let block = |alias: &str| {
        aliases
            .get(alias)
            .cloned()
            .ok_or_else(|| ScenarioError::UnknownBlock(alias.to_owned()))
    };
    let entity = |raw: &str| -> Result<EntityId, ScenarioError> {
        if let Some(id) = raw.strip_prefix("page:") {
            Ok(EntityId::Page {
                id: PageId::new(id).map_err(|error| ScenarioError::Invalid(error.to_string()))?,
            })
        } else if let Some(alias) = raw.strip_prefix("block:") {
            let (page_id, id) = block(alias)?;
            Ok(EntityId::Block { page_id, id })
        } else {
            Err(ScenarioError::Invalid(format!(
                "entity must start with page: or block:: {raw}"
            )))
        }
    };
    let result = match input {
        ScenarioCommand::EnsurePage { page_id, title } => (
            Command::EnsurePage {
                page_id: page_id.clone(),
                title: title.clone(),
            },
            None,
            None,
        ),
        ScenarioCommand::EnsureJournal { date, as_id } => (
            Command::EnsureJournal { date: date.clone() },
            None,
            as_id.clone(),
        ),
        ScenarioCommand::RenamePage { page_id, title } => (
            Command::RenamePage {
                page_id: page_id.clone(),
                title: title.clone(),
            },
            None,
            None,
        ),
        ScenarioCommand::DeletePage { page_id } => (
            Command::DeletePage {
                page_id: page_id.clone(),
            },
            None,
            None,
        ),
        ScenarioCommand::RestorePage { page_id } => (
            Command::RestorePage {
                page_id: page_id.clone(),
            },
            None,
            None,
        ),
        ScenarioCommand::EnsureTag { tag_id, name } => (
            Command::EnsureTag {
                tag_id: tag_id.clone(),
                name: name.clone(),
            },
            None,
            None,
        ),
        ScenarioCommand::InsertBlock {
            as_id,
            page_id,
            parent,
            index,
            markdown,
        } => (
            Command::InsertBlock {
                page_id: page_id.clone(),
                parent: parent.as_deref().map(block).transpose()?.map(|(_, id)| id),
                index: *index,
                markdown: markdown.clone(),
            },
            Some((as_id.clone(), page_id.clone())),
            None,
        ),
        ScenarioCommand::EditMarkdown {
            block: id,
            markdown,
        } => (
            {
                let (page_id, block_id) = block(id)?;
                Command::EditMarkdown {
                    page_id,
                    block_id,
                    markdown: markdown.clone(),
                }
            },
            None,
            None,
        ),
        ScenarioCommand::SpliceMarkdown {
            block: id,
            index,
            delete,
            insert,
        } => (
            {
                let (page_id, block_id) = block(id)?;
                Command::SpliceMarkdown {
                    page_id,
                    block_id,
                    index: *index,
                    delete: *delete,
                    insert: insert.clone(),
                }
            },
            None,
            None,
        ),
        ScenarioCommand::MoveBlock {
            block: id,
            page_id,
            parent,
            index,
        } => (
            Command::MoveBlock {
                block_id: block(id)?.1,
                page_id: page_id.clone(),
                parent: parent.as_deref().map(block).transpose()?.map(|(_, id)| id),
                index: *index,
            },
            None,
            None,
        ),
        ScenarioCommand::IndentBlock { block: id } => (
            {
                let (page_id, block_id) = block(id)?;
                Command::IndentBlock { page_id, block_id }
            },
            None,
            None,
        ),
        ScenarioCommand::OutdentBlock { block: id } => (
            {
                let (page_id, block_id) = block(id)?;
                Command::OutdentBlock { page_id, block_id }
            },
            None,
            None,
        ),
        ScenarioCommand::DeleteBlock { block: id } => (
            {
                let (page_id, block_id) = block(id)?;
                Command::DeleteBlock { page_id, block_id }
            },
            None,
            None,
        ),
        ScenarioCommand::SetProperty {
            entity: raw,
            key,
            value,
        } => (
            Command::SetProperty {
                entity: entity(raw)?,
                key: key.clone(),
                value: value.clone(),
            },
            None,
            None,
        ),
        ScenarioCommand::RemoveProperty { entity: raw, key } => (
            Command::RemoveProperty {
                entity: entity(raw)?,
                key: key.clone(),
            },
            None,
            None,
        ),
        ScenarioCommand::AddRepeatedProperty {
            entity: raw,
            key,
            value,
        } => (
            Command::AddRepeatedProperty {
                entity: entity(raw)?,
                key: key.clone(),
                value: value.clone(),
            },
            None,
            None,
        ),
        ScenarioCommand::RemoveRepeatedProperty {
            entity: raw,
            key,
            value,
        } => (
            Command::RemoveRepeatedProperty {
                entity: entity(raw)?,
                key: key.clone(),
                value: value.clone(),
            },
            None,
            None,
        ),
        ScenarioCommand::SetTagDefault { tag_id, key, value } => (
            Command::SetTagDefault {
                tag_id: tag_id.clone(),
                key: key.clone(),
                value: value.clone(),
            },
            None,
            None,
        ),
        ScenarioCommand::AddTag { block: id, tag_id } => (
            {
                let (page_id, block_id) = block(id)?;
                Command::AddTag {
                    entity: EntityId::Block {
                        page_id,
                        id: block_id,
                    },
                    tag_id: tag_id.clone(),
                }
            },
            None,
            None,
        ),
        ScenarioCommand::Undo => (Command::Undo, None, None),
        ScenarioCommand::Redo => (Command::Redo, None, None),
    };
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_basic_scenario_runs_and_converges() {
        let output = basic_scenario_json().unwrap();
        let value: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(value["converged"], true);
        assert!(value["events"].as_array().unwrap().len() > 10);
    }
}
