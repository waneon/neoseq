import wasm from "../target/step1-wasm-node/neoseq_core.js";

process.stdout.write(wasm.core_basic_scenario_json());
