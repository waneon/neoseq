//! Native core and SQLite persistence adapters.

pub mod core_port;
pub mod repository;

pub use core_port::NativeCorePort;
pub use repository::{
    FaultPoint, SQLITE_SCHEMA_VERSION, SqliteGraphRepository, SqliteRepositoryError,
};

#[cfg(test)]
mod core_port_tests;
#[cfg(test)]
mod persistence_tests;

use anyhow::{Context, Result, ensure};
use graph_core::{SpikePeer, fixture_snapshot, replay_semantic_hash};
use rusqlite::{Connection, params};
use std::path::Path;

pub fn core_basic_scenario_json() -> Result<String> {
    Ok(graph_core::scenario::basic_scenario_json()?)
}

pub fn sqlite_round_trip(path: &Path) -> Result<(String, usize, String)> {
    let snapshot = fixture_snapshot()?;
    let peer = SpikePeer::new(41)?;
    peer.edit("uncheckpointed-update|")?;
    let expected = peer.hash()?;
    let pending_update = peer.export_all()?;

    {
        let connection = Connection::open(path)?;
        let journal_mode: String =
            connection.pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))?;
        ensure!(
            journal_mode.eq_ignore_ascii_case("wal"),
            "SQLite WAL was not enabled"
        );
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS spike_snapshot (
                graph_id TEXT PRIMARY KEY,
                payload BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS spike_update (
                graph_id TEXT NOT NULL,
                sequence INTEGER NOT NULL,
                payload BLOB NOT NULL,
                PRIMARY KEY (graph_id, sequence)
            );",
        )?;
        connection.execute(
            "INSERT INTO spike_snapshot(graph_id, payload) VALUES (?1, ?2)
             ON CONFLICT(graph_id) DO UPDATE SET payload = excluded.payload",
            params!["step-1", snapshot],
        )?;
        connection.execute("DELETE FROM spike_update WHERE graph_id = ?1", ["step-1"])?;
        connection.execute(
            "INSERT INTO spike_update(graph_id, sequence, payload) VALUES (?1, ?2, ?3)",
            params!["step-1", 1_i64, pending_update],
        )?;
    }

    let connection = Connection::open(path)?;
    let restored: Vec<u8> = connection
        .query_row(
            "SELECT payload FROM spike_snapshot WHERE graph_id = ?1",
            ["step-1"],
            |row| row.get(0),
        )
        .context("reload persisted Loro snapshot")?;
    let (pending, replayed_updates) = {
        let mut statement = connection
            .prepare("SELECT payload FROM spike_update WHERE graph_id = ?1 ORDER BY sequence")?;
        let updates = statement.query_map(["step-1"], |row| row.get::<_, Vec<u8>>(0))?;
        let mut pending = Vec::new();
        let mut replayed = 0;
        for update in updates {
            pending.push(update?);
            replayed += 1;
        }
        (pending, replayed)
    };
    let actual = replay_semantic_hash(&restored, &pending)?;
    ensure!(actual == expected, "SQLite round-trip hash mismatch");
    Ok((actual, replayed_updates, "wal".to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlite_reopens_the_same_snapshot() {
        let path = std::env::temp_dir().join(format!(
            "neoseq-step1-{}-{}.db",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let result = sqlite_round_trip(&path);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        result.unwrap();
    }
}
