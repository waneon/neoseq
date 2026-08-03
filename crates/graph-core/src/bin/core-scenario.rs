use anyhow::{Context, Result};

fn main() -> Result<()> {
    let path = std::env::args()
        .nth(1)
        .context("usage: core-scenario <scenario.yaml>")?;
    let source = std::fs::read_to_string(&path).with_context(|| format!("read {path}"))?;
    println!("{}", graph_core::scenario::run_scenario_str(&source)?);
    Ok(())
}
