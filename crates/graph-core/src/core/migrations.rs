use super::*;

type Prepared = Box<dyn PreparedMigration>;
type Prepare = fn(&LoroDoc) -> Result<Prepared, CoreError>;

trait PreparedMigration {
    fn apply(self: Box<Self>, doc: &LoroDoc) -> Result<(), CoreError>;
}

struct Migration {
    id: &'static str,
    from: u32,
    to: u32,
    minimum_writer_schema: u32,
    prepare: Prepare,
}

static MIGRATIONS: &[Migration] = &[
    Migration {
        id: LIFECYCLE_MIGRATION_ID,
        from: MIN_MIGRATABLE_SCHEMA_VERSION,
        to: LIFECYCLE_SCHEMA_VERSION,
        minimum_writer_schema: LIFECYCLE_SCHEMA_VERSION,
        prepare: lifecycle_metadata::prepare,
    },
    Migration {
        id: TAG_OUTLINES_MIGRATION_ID,
        from: LIFECYCLE_SCHEMA_VERSION,
        to: TAG_OUTLINES_SCHEMA_VERSION,
        minimum_writer_schema: TAG_OUTLINES_SCHEMA_VERSION,
        prepare: tag_outlines::prepare,
    },
    Migration {
        id: GRAPH_SETTINGS_MIGRATION_ID,
        from: TAG_OUTLINES_SCHEMA_VERSION,
        to: GRAPH_SETTINGS_DOCUMENT_SCHEMA_VERSION,
        minimum_writer_schema: GRAPH_SETTINGS_DOCUMENT_SCHEMA_VERSION,
        prepare: graph_settings::prepare,
    },
    Migration {
        id: QUERY_VIEWS_MIGRATION_ID,
        from: GRAPH_SETTINGS_DOCUMENT_SCHEMA_VERSION,
        to: QUERY_VIEWS_SCHEMA_VERSION,
        minimum_writer_schema: QUERY_VIEWS_SCHEMA_VERSION,
        prepare: independent_query_views::prepare,
    },
    Migration {
        id: INLINE_PAGE_REFERENCES_MIGRATION_ID,
        from: QUERY_VIEWS_SCHEMA_VERSION,
        to: INLINE_PAGE_REFERENCES_SCHEMA_VERSION,
        minimum_writer_schema: MINIMUM_WRITER_SCHEMA,
        prepare: inline_page_references::prepare,
    },
];

pub(super) fn migrate_document(doc: &LoroDoc) -> Result<MigrationReport, CoreError> {
    let meta = doc.get_map("meta");
    let stored = map_i64(&meta, "schema_version").unwrap_or(0);
    let source_schema = u32::try_from(stored).map_err(|_| CoreError::UnsupportedSchema(stored))?;
    if !(MIN_MIGRATABLE_SCHEMA_VERSION..=SCHEMA_VERSION).contains(&source_schema) {
        return Err(CoreError::UnsupportedSchema(stored));
    }

    let before = doc.oplog_vv();
    let mut schema = source_schema;
    let mut applied_migrations = Vec::new();

    while schema < SCHEMA_VERSION {
        let migration = MIGRATIONS
            .iter()
            .find(|migration| migration.from == schema)
            .ok_or(CoreError::UnsupportedSchema(i64::from(schema)))?;
        let prepared = (migration.prepare)(doc)?;
        doc.set_next_commit_origin("system:migration");
        doc.set_next_commit_message(migration.id);
        prepared.apply(doc)?;
        record_migration(&meta, migration)?;
        doc.commit();

        applied_migrations.push(migration.id.to_owned());
        schema = migration.to;
    }

    let update = if applied_migrations.is_empty() {
        Vec::new()
    } else {
        doc.export(ExportMode::updates(&before))?
    };
    Ok(MigrationReport {
        source_schema,
        target_schema: SCHEMA_VERSION,
        applied_migrations,
        update,
    })
}

fn record_migration(meta: &LoroMap, migration: &Migration) -> Result<(), CoreError> {
    let applied = migration_map(meta)?;
    if map_i64(&applied, migration.id) != Some(i64::from(migration.to)) {
        applied.insert(migration.id, i64::from(migration.to))?;
    }
    meta.insert(
        "minimum_writer_schema",
        i64::from(migration.minimum_writer_schema),
    )?;
    meta.insert("schema_version", i64::from(migration.to))?;
    Ok(())
}

fn migration_map(meta: &LoroMap) -> Result<LoroMap, CoreError> {
    match meta.get("applied_migrations") {
        Some(value) => value_into_map(value).ok_or(CoreError::InvalidSchemaMetadata(
            "applied_migrations must be a map",
        )),
        None => Ok(meta.ensure_mergeable_map("applied_migrations")?),
    }
}

mod lifecycle_metadata {
    use super::*;

    pub(super) fn prepare(_doc: &LoroDoc) -> Result<Prepared, CoreError> {
        Ok(Box::new(Plan))
    }

    struct Plan;

    impl PreparedMigration for Plan {
        fn apply(self: Box<Self>, _doc: &LoroDoc) -> Result<(), CoreError> {
            Ok(())
        }
    }
}

mod tag_outlines {
    use super::*;

    pub(super) fn prepare(doc: &LoroDoc) -> Result<Prepared, CoreError> {
        let mut missing = Vec::new();
        let mut invalid = None;
        doc.get_map("tags").for_each(|raw_id, value| {
            let Some(tag) = value_into_map(value) else {
                return;
            };
            match tag.get("outline") {
                None => missing.push(tag),
                Some(value) => {
                    if value_into_tree(value).is_none() {
                        invalid = Some(raw_id.to_owned());
                    }
                }
            }
        });
        if let Some(tag_id) = invalid {
            return Err(CoreError::InvalidHierarchy(format!(
                "tag outline is invalid: {tag_id}"
            )));
        }
        Ok(Box::new(Plan { missing }))
    }

    struct Plan {
        missing: Vec<LoroMap>,
    }

    impl PreparedMigration for Plan {
        fn apply(self: Box<Self>, _doc: &LoroDoc) -> Result<(), CoreError> {
            for tag in self.missing {
                let outline = tag.ensure_mergeable_tree("outline")?;
                outline.enable_fractional_index(0);
            }
            Ok(())
        }
    }
}

mod graph_settings {
    use super::*;

    pub(super) fn prepare(doc: &LoroDoc) -> Result<Prepared, CoreError> {
        validate_tag_outlines(doc)?;
        Ok(Box::new(Plan))
    }

    struct Plan;

    impl PreparedMigration for Plan {
        fn apply(self: Box<Self>, doc: &LoroDoc) -> Result<(), CoreError> {
            let settings = doc.get_map("graph_settings");
            settings.insert("schema_version", i64::from(GRAPH_SETTINGS_SCHEMA_VERSION))?;
            let _ = settings.ensure_mergeable_map("default_queries")?;
            Ok(())
        }
    }
}

mod independent_query_views {
    use super::*;

    pub(super) fn prepare(doc: &LoroDoc) -> Result<Prepared, CoreError> {
        validate_tag_outlines(doc)?;
        stored_default_queries(doc)?;

        let mut documents = Vec::new();
        for document in query_document_maps(doc) {
            match map_i64(&document, "version") {
                Some(1) => {
                    decode_legacy_query_document(&document).map_err(CoreError::InvalidHierarchy)?;
                    let definition = read_query_definition(&document, "query document")
                        .map_err(CoreError::InvalidHierarchy)?;
                    let views =
                        document
                            .get("views")
                            .and_then(value_into_map)
                            .ok_or_else(|| {
                                CoreError::InvalidHierarchy(
                                    "query document views are missing".to_owned(),
                                )
                            })?;
                    let mut stored_views = Vec::new();
                    views.for_each(|_, value| {
                        if let Some(view) = value_into_map(value) {
                            stored_views.push(view);
                        }
                    });
                    documents.push(QueryDocumentPlan {
                        document,
                        definition,
                        views: stored_views,
                    });
                }
                _ => {
                    decode_query_document(&document).map_err(CoreError::InvalidHierarchy)?;
                }
            }
        }
        Ok(Box::new(Plan { documents }))
    }

    fn decode_legacy_query_document(document: &LoroMap) -> Result<PropertyDocument, String> {
        let schema = map_string(document, "schema")
            .ok_or_else(|| "query document schema is missing".to_owned())?;
        let version = map_i64(document, "version")
            .and_then(|value| u32::try_from(value).ok())
            .ok_or_else(|| "query document version is invalid".to_owned())?;
        if schema != QUERY_DOCUMENT_SCHEMA || version != 1 {
            return Err(format!("unsupported query document {schema} v{version}"));
        }
        let definition = read_query_definition(document, "query document")?;
        decode_query_document_with(document, schema, QUERY_DOCUMENT_VERSION, |_, _| {
            Ok(definition.clone())
        })
    }

    struct Plan {
        documents: Vec<QueryDocumentPlan>,
    }

    struct QueryDocumentPlan {
        document: LoroMap,
        definition: QueryDefinition,
        views: Vec<LoroMap>,
    }

    impl PreparedMigration for Plan {
        fn apply(self: Box<Self>, _doc: &LoroDoc) -> Result<(), CoreError> {
            for prepared in self.documents {
                for view in prepared.views {
                    write_query_definition(
                        &view.ensure_mergeable_map("definition")?,
                        &prepared.definition,
                    )?;
                }
                prepared
                    .document
                    .insert("version", i64::from(QUERY_DOCUMENT_VERSION))?;
                for field in ["language", "source", "plan_version", "plan"] {
                    if prepared.document.get(field).is_some() {
                        prepared.document.delete(field)?;
                    }
                }
            }
            Ok(())
        }
    }
}

mod inline_page_references {
    use super::*;

    pub(super) fn prepare(doc: &LoroDoc) -> Result<Prepared, CoreError> {
        validate_tag_outlines(doc)?;
        validate_current_query_documents(doc)?;
        Ok(Box::new(Plan))
    }

    struct Plan;

    impl PreparedMigration for Plan {
        fn apply(self: Box<Self>, _doc: &LoroDoc) -> Result<(), CoreError> {
            // Existing `[[text]]` remains authored Markdown. Only an explicit
            // page completion creates a semantic reference atom.
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn registry_is_a_single_contiguous_path_to_current_schema() {
        let mut expected = MIN_MIGRATABLE_SCHEMA_VERSION;
        let mut ids = BTreeSet::new();
        for migration in MIGRATIONS {
            assert_eq!(migration.from, expected);
            assert!(migration.to > migration.from);
            assert!(ids.insert(migration.id));
            expected = migration.to;
        }
        assert_eq!(expected, SCHEMA_VERSION);
    }
}
