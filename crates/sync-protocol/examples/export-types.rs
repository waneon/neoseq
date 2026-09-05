use std::collections::BTreeMap;
use ts_rs::{Config, TS, TypeVisitor};

struct Declarations {
    config: Config,
    types: BTreeMap<String, String>,
}

impl TypeVisitor for Declarations {
    fn visit<T: TS + 'static + ?Sized>(&mut self) {
        if T::output_path().is_none() {
            return;
        }
        let name = T::ident(&self.config);
        if self.types.contains_key(&name) {
            return;
        }
        self.types.insert(name, T::decl(&self.config));
        T::visit_dependencies(self);
    }
}

fn main() {
    let mut declarations = Declarations {
        // Wasm and Worker JSON use JavaScript numbers, including sequence counters.
        config: Config::new().with_large_int("number"),
        types: BTreeMap::new(),
    };
    declarations.visit::<domain::GraphSnapshot>();
    declarations.visit::<domain::GraphSummary>();
    declarations.visit::<domain::OutlineSnapshot>();
    declarations.visit::<domain::CommandEnvelope>();
    declarations.visit::<domain::CommandResult>();
    declarations.visit::<domain::GraphChanges>();
    declarations.visit::<sync_protocol::Message>();
    println!(
        "// @generated from Rust serialization types by scripts/generate-contracts.mjs; do not edit."
    );
    for declaration in declarations.types.values() {
        println!("export {declaration}");
    }
}
