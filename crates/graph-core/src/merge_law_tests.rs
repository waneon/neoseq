//! Executable merge laws for the domain projection over Loro.
//!
//! A command being valid on each replica does not imply that the merged state
//! is valid. These tests keep that distinction explicit: every scenario starts
//! from one causal ancestor, runs two locally accepted branch programs, and
//! observes both possible delivery orders from fresh replicas.

use crate::{CoreError, CoreExecution, GraphCore};
use domain::{
    BlockId, Cardinality, Command, CommandEnvelope, CommandId, DefaultQueryId, GraphConflict,
    GraphId, OutlineOwner, PageId, PropertyDocument, PropertyError, PropertyField, PropertyKey,
    PropertyOwner, PropertyType, PropertyValue, QueryDefinition, QueryOwner, QueryPlan, QueryView,
    QueryViewId, TagId, TextTarget,
};
use loro::{Container, ExportMode, LoroDoc, LoroMap, LoroValue, ValueOrContainer};
use query::IndexUnit;

const LEFT_PEER: u64 = 2;
const RIGHT_PEER: u64 = 3;
const LEFT_THEN_RIGHT_PEER: u64 = 4;
const RIGHT_THEN_LEFT_PEER: u64 = 5;

#[test]
fn concurrent_regular_child_creation_selects_one_whole_container() {
    let branch = |peer_id, shape: &str, single: bool| {
        let doc = LoroDoc::new();
        doc.set_peer_id(peer_id).unwrap();
        let field = doc
            .get_map("bag")
            .insert_container("user.shape", LoroMap::new())
            .unwrap();
        field.insert("shape", shape).unwrap();
        if single {
            field.insert("single", "left").unwrap();
        } else {
            field
                .insert_container("members", LoroMap::new())
                .unwrap()
                .insert("right", true)
                .unwrap();
        }
        doc.commit();
        doc.export(ExportMode::all_updates()).unwrap()
    };
    let left = branch(LEFT_PEER, "string-single", true);
    let right = branch(RIGHT_PEER, "number-set", false);
    let observe = |updates: [&[u8]; 2]| {
        let doc = LoroDoc::new();
        for update in updates {
            doc.import(update).unwrap();
        }
        let field = match doc.get_map("bag").get("user.shape") {
            Some(ValueOrContainer::Container(Container::Map(field))) => field,
            actual => panic!("field must resolve to one child map, got {actual:?}"),
        };
        let shape = match field.get("shape") {
            Some(ValueOrContainer::Value(LoroValue::String(shape))) => shape.to_string(),
            actual => panic!("selected field must contain its shape, got {actual:?}"),
        };
        (
            shape,
            field.get("single").is_some(),
            field.get("members").is_some(),
        )
    };

    let left_then_right = observe([&left, &right]);
    let right_then_left = observe([&right, &left]);
    assert_eq!(left_then_right, right_then_left);
    assert!(
        left_then_right == ("string-single".to_owned(), true, false)
            || left_then_right == ("number-set".to_owned(), false, true)
    );
}

struct MergeLawHarness {
    graph_id: GraphId,
    ancestor: Vec<u8>,
    ancestor_version: Vec<u8>,
}

impl MergeLawHarness {
    fn empty(graph_id: GraphId) -> Self {
        Self::with_ancestor(graph_id, |_| {})
    }

    fn with_ancestor<Build>(graph_id: GraphId, build: Build) -> Self
    where
        Build: FnOnce(&mut ReplicaBranch),
    {
        let core = GraphCore::new(graph_id.clone(), 1, "ancestor").unwrap();
        let mut ancestor = ReplicaBranch {
            graph_id,
            peer_id: 1,
            name: "ancestor",
            sequence: 0,
            core,
        };
        build(&mut ancestor);
        Self::from_ancestor(&ancestor.core)
    }

    fn from_ancestor(ancestor: &GraphCore) -> Self {
        Self {
            graph_id: ancestor.graph_id().clone(),
            ancestor: ancestor.export_snapshot().unwrap(),
            ancestor_version: ancestor.version_vector(),
        }
    }

    fn observe<Left, Right>(&self, left: Left, right: Right) -> MergeLawOutcome
    where
        Left: FnOnce(&mut ReplicaBranch),
        Right: FnOnce(&mut ReplicaBranch),
    {
        self.observe_via(MergePath::Remote, left, right)
    }

    fn observe_recovery<Left, Right>(&self, left: Left, right: Right) -> MergeLawOutcome
    where
        Left: FnOnce(&mut ReplicaBranch),
        Right: FnOnce(&mut ReplicaBranch),
    {
        self.observe_via(MergePath::Recovery, left, right)
    }

    fn observe_via<Left, Right>(&self, path: MergePath, left: Left, right: Right) -> MergeLawOutcome
    where
        Left: FnOnce(&mut ReplicaBranch),
        Right: FnOnce(&mut ReplicaBranch),
    {
        let mut left_branch = self.branch(LEFT_PEER, "left");
        let mut right_branch = self.branch(RIGHT_PEER, "right");
        left(&mut left_branch);
        right(&mut right_branch);

        let left_update = left_branch
            .core
            .export_updates_since(&self.ancestor_version)
            .unwrap();
        let right_update = right_branch
            .core
            .export_updates_since(&self.ancestor_version)
            .unwrap();

        let left_then_right = self.observe_order(
            LEFT_THEN_RIGHT_PEER,
            [
                (&left_update, Delivery::Left),
                (&right_update, Delivery::Right),
            ],
            path,
        );
        let right_then_left = self.observe_order(
            RIGHT_THEN_LEFT_PEER,
            [
                (&right_update, Delivery::Right),
                (&left_update, Delivery::Left),
            ],
            path,
        );

        match (&left_then_right, &right_then_left) {
            (
                OrderOutcome::Applied {
                    fingerprint: left_fingerprint,
                    frontier: left_frontier,
                    conflicts: left_conflicts,
                    quarantined: left_quarantined,
                    default_query_ids: left_default_query_ids,
                    default_query_views: left_default_query_views,
                    query_definitions: left_query_definitions,
                    page_properties: left_page_properties,
                },
                OrderOutcome::Applied {
                    fingerprint: right_fingerprint,
                    frontier: right_frontier,
                    conflicts: right_conflicts,
                    quarantined: right_quarantined,
                    default_query_ids: right_default_query_ids,
                    default_query_views: right_default_query_views,
                    query_definitions: right_query_definitions,
                    page_properties: right_page_properties,
                },
            ) if left_fingerprint == right_fingerprint
                && left_frontier == right_frontier
                && left_conflicts == right_conflicts
                && left_quarantined == right_quarantined
                && left_default_query_ids == right_default_query_ids
                && left_default_query_views == right_default_query_views
                && left_query_definitions == right_query_definitions
                && left_page_properties == right_page_properties =>
            {
                MergeLawOutcome::Converged {
                    fingerprint: left_fingerprint.clone(),
                    conflicts: left_conflicts.clone(),
                    quarantined: left_quarantined.clone(),
                    default_query_ids: left_default_query_ids.clone(),
                    default_query_views: left_default_query_views.clone(),
                    query_definitions: left_query_definitions.clone(),
                    page_properties: left_page_properties.clone(),
                }
            }
            (OrderOutcome::Applied { .. }, OrderOutcome::Applied { .. }) => {
                MergeLawOutcome::Diverged {
                    left_then_right,
                    right_then_left,
                }
            }
            _ => MergeLawOutcome::Rejected {
                left_then_right,
                right_then_left,
            },
        }
    }

    fn branch(&self, peer_id: u64, name: &'static str) -> ReplicaBranch {
        ReplicaBranch {
            graph_id: self.graph_id.clone(),
            peer_id,
            name,
            sequence: 0,
            core: GraphCore::from_snapshot(self.graph_id.clone(), peer_id, &self.ancestor).unwrap(),
        }
    }

    fn observe_order(
        &self,
        peer_id: u64,
        deliveries: [(&[u8], Delivery); 2],
        path: MergePath,
    ) -> OrderOutcome {
        let mut observer =
            GraphCore::from_snapshot(self.graph_id.clone(), peer_id, &self.ancestor).unwrap();
        let final_delivery = deliveries[1].1;
        for (update, delivery) in deliveries {
            if update.is_empty() {
                continue;
            }
            let result = match path {
                MergePath::Remote => observer.import_remote(update),
                MergePath::Recovery => observer.stage_recovery_update(update),
            };
            if let Err(error) = result {
                return OrderOutcome::Rejected {
                    delivery,
                    error: format!("{error:?}"),
                };
            }
        }
        if path == MergePath::Recovery
            && let Err(error) = observer.finish_recovery()
        {
            return OrderOutcome::Rejected {
                delivery: final_delivery,
                error: format!("{error:?}"),
            };
        }
        let snapshot = observer.snapshot().unwrap();
        assert_public_projections_agree(&observer, &snapshot);
        let summary = observer.summary().unwrap();
        assert_eq!(summary.conflicts, snapshot.conflicts);
        assert_eq!(summary.quarantined, snapshot.quarantined);
        let quarantined = summary.quarantined.clone();
        let default_query_views = summary
            .settings
            .default_queries
            .iter()
            .map(|query| {
                (
                    query.id.clone(),
                    query
                        .document
                        .views
                        .iter()
                        .map(|view| view.id.clone())
                        .collect(),
                    query.document.default_view_id.clone(),
                )
            })
            .collect();
        let query_definitions = summary
            .settings
            .default_queries
            .iter()
            .flat_map(|query| {
                query
                    .document
                    .views
                    .iter()
                    .map(|view| (query.id.clone(), view.id.clone(), view.definition.clone()))
            })
            .collect();
        let page_properties = snapshot
            .pages
            .iter()
            .map(|page| (page.id.clone(), page.properties.iter().cloned().collect()))
            .collect();
        OrderOutcome::Applied {
            fingerprint: observer.fingerprint().unwrap(),
            frontier: observer.frontier(),
            conflicts: summary.conflicts,
            quarantined,
            default_query_ids: summary
                .settings
                .default_queries
                .into_iter()
                .map(|query| query.id)
                .collect(),
            default_query_views,
            query_definitions,
            page_properties,
        }
    }
}

fn assert_public_projections_agree(core: &GraphCore, snapshot: &domain::GraphSnapshot) {
    for page in &snapshot.pages {
        assert_eq!(core.page_snapshot(&page.id).unwrap(), *page);
        assert_eq!(
            core.outline_snapshot(&OutlineOwner::Page {
                id: page.id.clone(),
            })
            .unwrap()
            .blocks,
            page.blocks
        );
    }
    for tag in &snapshot.tags {
        assert_eq!(
            core.outline_snapshot(&OutlineOwner::Tag { id: tag.id.clone() })
                .unwrap()
                .blocks,
            tag.blocks
        );
    }

    let mut indexed_pages = Vec::new();
    let mut indexed_tags = Vec::new();
    for unit in core.index_units().unwrap() {
        match unit.unwrap() {
            IndexUnit::Page(page) => indexed_pages.push(page),
            IndexUnit::Tag(tag) => indexed_tags.push(tag),
        }
    }
    assert_eq!(indexed_pages, snapshot.pages);
    assert_eq!(indexed_tags, snapshot.tags);
}

struct ReplicaBranch {
    graph_id: GraphId,
    peer_id: u64,
    name: &'static str,
    sequence: usize,
    core: GraphCore,
}

impl ReplicaBranch {
    fn execute(&mut self, command: Command) -> CoreExecution {
        self.try_execute(command).unwrap_or_else(|error| {
            panic!(
                "{} branch command {} must be locally valid: {error:?}",
                self.name,
                self.sequence - 1
            )
        })
    }

    fn try_execute(&mut self, command: Command) -> Result<CoreExecution, CoreError> {
        let sequence = self.sequence;
        self.sequence += 1;
        self.core.execute(
            CommandEnvelope {
                graph_id: self.graph_id.clone(),
                command_id: CommandId::new(format!(
                    "merge-law-{}-{}-{sequence}",
                    self.name, self.peer_id
                ))
                .unwrap(),
                command,
            },
            &format!("merge-law-{}-{sequence}", self.name),
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Delivery {
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MergePath {
    Remote,
    Recovery,
}

#[derive(Debug, PartialEq)]
enum OrderOutcome {
    Applied {
        fingerprint: String,
        frontier: String,
        conflicts: Vec<GraphConflict>,
        quarantined: Vec<String>,
        default_query_ids: Vec<DefaultQueryId>,
        default_query_views: Vec<(DefaultQueryId, Vec<QueryViewId>, QueryViewId)>,
        query_definitions: Vec<(DefaultQueryId, QueryViewId, QueryDefinition)>,
        page_properties: Vec<(PageId, Vec<PropertyField>)>,
    },
    Rejected {
        delivery: Delivery,
        error: String,
    },
}

#[derive(Debug, PartialEq)]
enum MergeLawOutcome {
    Converged {
        fingerprint: String,
        conflicts: Vec<GraphConflict>,
        quarantined: Vec<String>,
        default_query_ids: Vec<DefaultQueryId>,
        default_query_views: Vec<(DefaultQueryId, Vec<QueryViewId>, QueryViewId)>,
        query_definitions: Vec<(DefaultQueryId, QueryViewId, QueryDefinition)>,
        page_properties: Vec<(PageId, Vec<PropertyField>)>,
    },
    Rejected {
        left_then_right: OrderOutcome,
        right_then_left: OrderOutcome,
    },
    Diverged {
        left_then_right: OrderOutcome,
        right_then_left: OrderOutcome,
    },
}

impl MergeLawOutcome {
    fn assert_merge_closed(
        self,
        expected_conflicts: Vec<GraphConflict>,
        expected_default_query_ids: Vec<DefaultQueryId>,
    ) {
        match self {
            Self::Converged {
                conflicts,
                quarantined,
                default_query_ids,
                ..
            } if conflicts == expected_conflicts
                && quarantined.is_empty()
                && default_query_ids == expected_default_query_ids => {}
            actual => {
                panic!(
                    "merge law is not total and deterministic\nexpected conflicts: \
                     {expected_conflicts:#?}\nexpected default queries: \
                     {expected_default_query_ids:#?}\nactual: {actual:#?}"
                )
            }
        }
    }

    fn assert_merge_closed_with_query_views(
        self,
        expected_conflicts: Vec<GraphConflict>,
        expected_default_query_ids: Vec<DefaultQueryId>,
        expected_default_query_views: Vec<(DefaultQueryId, Vec<QueryViewId>, QueryViewId)>,
    ) {
        match self {
            Self::Converged {
                conflicts,
                quarantined,
                default_query_ids,
                default_query_views,
                ..
            } if conflicts == expected_conflicts
                && quarantined.is_empty()
                && default_query_ids == expected_default_query_ids
                && default_query_views == expected_default_query_views => {}
            actual => panic!(
                "merge law is not total with a deterministic query projection\nexpected \
                 conflicts: {expected_conflicts:#?}\nexpected default queries: \
                 {expected_default_query_ids:#?}\nexpected query views: \
                 {expected_default_query_views:#?}\nactual: {actual:#?}"
            ),
        }
    }

    fn into_query_definition(
        self,
        default_query_id: &DefaultQueryId,
        view_id: &QueryViewId,
    ) -> QueryDefinition {
        match self {
            Self::Converged {
                conflicts,
                quarantined,
                query_definitions,
                ..
            } if conflicts.is_empty() && quarantined.is_empty() => query_definitions
                .into_iter()
                .find_map(|(query_id, candidate_view_id, definition)| {
                    (query_id == *default_query_id && candidate_view_id == *view_id)
                        .then_some(definition)
                })
                .unwrap_or_else(|| {
                    panic!(
                        "converged projection omitted query definition {default_query_id}/{view_id}"
                    )
                }),
            actual => {
                panic!("query authority merge is not valid and deterministic\nactual: {actual:#?}")
            }
        }
    }

    fn assert_page_property_absent(self, page_id: &PageId, key: &PropertyKey) {
        assert!(self.into_page_property(page_id, key).is_none());
    }

    fn into_page_property(self, page_id: &PageId, key: &PropertyKey) -> Option<PropertyField> {
        match self {
            Self::Converged {
                conflicts,
                quarantined,
                page_properties,
                ..
            } if conflicts.is_empty() && quarantined.is_empty() => {
                let fields = page_properties
                    .into_iter()
                    .find_map(|(candidate, fields)| (candidate == *page_id).then_some(fields))
                    .unwrap_or_else(|| panic!("projection omitted page {page_id}"));
                fields.into_iter().find(|field| field.key == *key)
            }
            actual => panic!("property merge is not valid and deterministic\nactual: {actual:#?}"),
        }
    }
}

#[test]
fn independent_entity_creation_is_merge_closed() {
    let harness = MergeLawHarness::empty(GraphId::new("merge-law-independent-entities").unwrap());

    harness
        .observe(
            |left| {
                left.execute(Command::EnsurePage {
                    page_id: PageId::new("left-page").unwrap(),
                    title: "Left page".into(),
                });
                left.execute(Command::EnsureTag {
                    tag_id: TagId::new("left-tag").unwrap(),
                    name: "Left tag".into(),
                });
            },
            |right| {
                right.execute(Command::EnsurePage {
                    page_id: PageId::new("right-page").unwrap(),
                    title: "Right page".into(),
                });
                right.execute(Command::EnsureTag {
                    tag_id: TagId::new("right-tag").unwrap(),
                    name: "Right tag".into(),
                });
            },
        )
        .assert_merge_closed(Vec::new(), Vec::new());
}

#[test]
fn duplicate_page_name_is_merge_total_and_reported_as_data() {
    let harness = MergeLawHarness::empty(GraphId::new("merge-law-duplicate-page-name").unwrap());

    harness
        .observe(
            |left| {
                left.execute(Command::EnsurePage {
                    page_id: PageId::new("left-page").unwrap(),
                    title: "Shared name".into(),
                });
            },
            |right| {
                right.execute(Command::EnsurePage {
                    page_id: PageId::new("right-page").unwrap(),
                    title: " shared NAME ".into(),
                });
            },
        )
        .assert_merge_closed(
            vec![GraphConflict::DuplicateEntityName {
                canonical_name: "shared name".into(),
                entity_ids: vec![
                    PageId::new("left-page").unwrap(),
                    PageId::new("right-page").unwrap(),
                ],
            }],
            Vec::new(),
        );
}

#[test]
fn concurrent_page_title_growth_is_merge_total_and_reported_as_data() {
    let graph_id = GraphId::new("merge-law-page-title-limit").unwrap();
    let page_id = PageId::new("page").unwrap();
    let harness = MergeLawHarness::with_ancestor(graph_id, |ancestor| {
        ancestor.execute(Command::EnsurePage {
            page_id: page_id.clone(),
            title: "ancestor".into(),
        });
    });

    harness
        .observe(
            |left| {
                left.execute(Command::RenamePage {
                    page_id: page_id.clone(),
                    title: "l".repeat(1_024),
                });
            },
            |right| {
                right.execute(Command::RenamePage {
                    page_id: page_id.clone(),
                    title: "r".repeat(1_024),
                });
            },
        )
        .assert_merge_closed(
            vec![GraphConflict::TextLimitExceeded {
                target: TextTarget::PageTitle {
                    page_id: page_id.clone(),
                },
                actual_bytes: 2_048,
                limit: 1_024,
            }],
            Vec::new(),
        );

    harness
        .observe_recovery(
            |left| {
                left.execute(Command::RenamePage {
                    page_id: page_id.clone(),
                    title: "l".repeat(1_024),
                });
            },
            |right| {
                right.execute(Command::RenamePage {
                    page_id: page_id.clone(),
                    title: "r".repeat(1_024),
                });
            },
        )
        .assert_merge_closed(
            vec![GraphConflict::TextLimitExceeded {
                target: TextTarget::PageTitle { page_id },
                actual_bytes: 2_048,
                limit: 1_024,
            }],
            Vec::new(),
        );
}

#[test]
fn duplicate_tag_name_is_merge_total_and_reported_as_data() {
    let harness = MergeLawHarness::empty(GraphId::new("merge-law-duplicate-tag-name").unwrap());

    harness
        .observe(
            |left| {
                left.execute(Command::EnsureTag {
                    tag_id: TagId::new("left-tag").unwrap(),
                    name: "Shared tag".into(),
                });
            },
            |right| {
                right.execute(Command::EnsureTag {
                    tag_id: TagId::new("right-tag").unwrap(),
                    name: " shared TAG ".into(),
                });
            },
        )
        .assert_merge_closed(
            vec![GraphConflict::DuplicateEntityName {
                canonical_name: "shared tag".into(),
                entity_ids: vec![
                    PageId::new("left-tag").unwrap(),
                    PageId::new("right-tag").unwrap(),
                ],
            }],
            Vec::new(),
        );
}

fn block_text_harness() -> (MergeLawHarness, OutlineOwner, BlockId) {
    let graph_id = GraphId::new("merge-law-block-content-limit").unwrap();
    let page_id = PageId::new("page").unwrap();
    let owner = OutlineOwner::Page {
        id: page_id.clone(),
    };
    let core = GraphCore::new(graph_id.clone(), 1, "ancestor").unwrap();
    let mut ancestor = ReplicaBranch {
        graph_id,
        peer_id: 1,
        name: "ancestor",
        sequence: 0,
        core,
    };
    ancestor.execute(Command::EnsurePage {
        page_id,
        title: "Page".into(),
    });
    let block_id = ancestor
        .execute(Command::InsertBlock {
            owner: owner.clone(),
            parent: None,
            index: 0,
            markdown: "🦀".repeat(262_143),
        })
        .result
        .created_block
        .unwrap();
    (
        MergeLawHarness::from_ancestor(&ancestor.core),
        owner,
        block_id,
    )
}

fn page_property_harness(
    graph_id: &str,
    initialize: Command,
) -> (MergeLawHarness, PageId, PropertyOwner) {
    let page_id = PageId::new("page").unwrap();
    let owner = PropertyOwner::Page {
        id: page_id.clone(),
    };
    let harness = MergeLawHarness::with_ancestor(GraphId::new(graph_id).unwrap(), |ancestor| {
        ancestor.execute(Command::EnsurePage {
            page_id: page_id.clone(),
            title: "Page".into(),
        });
        ancestor.execute(initialize);
    });
    (harness, page_id, owner)
}

fn assert_property_remove_wins(
    harness: &MergeLawHarness,
    page_id: &PageId,
    owner: &PropertyOwner,
    key: &PropertyKey,
    concurrent_write: &Command,
) {
    for path in [MergePath::Remote, MergePath::Recovery] {
        harness
            .observe_via(
                path,
                |left| {
                    left.execute(Command::RemoveProperty {
                        owner: owner.clone(),
                        key: key.clone(),
                    });
                },
                |right| {
                    right.execute(concurrent_write.clone());
                },
            )
            .assert_page_property_absent(page_id, key);
    }
}

#[test]
fn property_removal_wins_over_a_concurrent_single_value_write() {
    let key = PropertyKey::new("user.status").unwrap();
    let page_id = PageId::new("page").unwrap();
    let owner = PropertyOwner::Page {
        id: page_id.clone(),
    };
    let (harness, page_id, owner) = page_property_harness(
        "merge-law-remove-single-property",
        Command::SetProperty {
            owner: owner.clone(),
            key: key.clone(),
            value: PropertyValue::String("ancestor".into()),
        },
    );

    assert_property_remove_wins(
        &harness,
        &page_id,
        &owner,
        &key,
        &Command::SetProperty {
            owner: owner.clone(),
            key: key.clone(),
            value: PropertyValue::String("concurrent".into()),
        },
    );
}

#[test]
fn property_removal_wins_over_a_concurrent_set_member_write() {
    let key = PropertyKey::new("user.labels").unwrap();
    let page_id = PageId::new("page").unwrap();
    let owner = PropertyOwner::Page {
        id: page_id.clone(),
    };
    let (harness, page_id, owner) = page_property_harness(
        "merge-law-remove-set-property",
        Command::AddRepeatedProperty {
            owner: owner.clone(),
            key: key.clone(),
            value: PropertyValue::String("ancestor".into()),
        },
    );

    assert_property_remove_wins(
        &harness,
        &page_id,
        &owner,
        &key,
        &Command::AddRepeatedProperty {
            owner: owner.clone(),
            key: key.clone(),
            value: PropertyValue::String("concurrent".into()),
        },
    );
}

#[test]
fn query_property_removal_wins_over_a_concurrent_source_edit() {
    let key = PropertyKey::new(domain::QUERY_PROPERTY_KEY).unwrap();
    let page_id = PageId::new("page").unwrap();
    let query_owner = QueryOwner::Page {
        id: page_id.clone(),
    };
    let view_id = QueryViewId::new("all").unwrap();
    let (harness, page_id, property_owner) = page_property_harness(
        "merge-law-remove-query-property",
        Command::SetQuerySource {
            owner: query_owner.clone(),
            view_id: view_id.clone(),
            source: "SELECT ?item WHERE {}".into(),
        },
    );

    assert_property_remove_wins(
        &harness,
        &page_id,
        &property_owner,
        &key,
        &Command::SetQuerySource {
            owner: query_owner,
            view_id,
            source: "SELECT ?item WHERE { ?item ?p ?o }".into(),
        },
    );
}

#[test]
fn recreating_a_removed_property_discards_concurrent_orphan_values() {
    let key = PropertyKey::new("user.status").unwrap();
    let page_id = PageId::new("page").unwrap();
    let owner = PropertyOwner::Page {
        id: page_id.clone(),
    };
    let (harness, _, _) = page_property_harness(
        "merge-law-recreate-removed-property",
        Command::SetProperty {
            owner: owner.clone(),
            key: key.clone(),
            value: PropertyValue::String("ancestor".into()),
        },
    );
    let mut left = harness.branch(LEFT_PEER, "left-recreate");
    let mut right = harness.branch(RIGHT_PEER, "right-recreate");
    left.execute(Command::RemoveProperty {
        owner: owner.clone(),
        key: key.clone(),
    });
    right.execute(Command::SetProperty {
        owner: owner.clone(),
        key: key.clone(),
        value: PropertyValue::String("orphan".into()),
    });
    let left_update = left
        .core
        .export_updates_since(&harness.ancestor_version)
        .unwrap();
    let right_update = right
        .core
        .export_updates_since(&harness.ancestor_version)
        .unwrap();
    let read_field = |core: &GraphCore| {
        core.snapshot()
            .unwrap()
            .pages
            .into_iter()
            .find(|page| page.id == page_id)
            .and_then(|page| page.properties.get(key.as_str()).cloned())
    };

    for path in [MergePath::Remote, MergePath::Recovery] {
        for (peer_id, updates) in [
            (LEFT_THEN_RIGHT_PEER, [&left_update[..], &right_update[..]]),
            (RIGHT_THEN_LEFT_PEER, [&right_update[..], &left_update[..]]),
        ] {
            let mut core =
                GraphCore::from_snapshot(harness.graph_id.clone(), peer_id, &harness.ancestor)
                    .unwrap();
            for update in updates {
                match path {
                    MergePath::Remote => core.import_remote(update).unwrap(),
                    MergePath::Recovery => core.stage_recovery_update(update).unwrap(),
                }
            }
            if path == MergePath::Recovery {
                core.finish_recovery().unwrap();
            }
            assert!(read_field(&core).is_none());
            assert!(core.snapshot().unwrap().quarantined.is_empty());

            let mut branch = ReplicaBranch {
                graph_id: harness.graph_id.clone(),
                peer_id,
                name: "recreate-observer",
                sequence: 0,
                core,
            };
            branch.execute(Command::SetProperty {
                owner: owner.clone(),
                key: key.clone(),
                value: PropertyValue::String("recreated".into()),
            });
            assert_eq!(
                read_field(&branch.core).unwrap().values,
                [PropertyValue::String("recreated".into())]
            );

            branch.execute(Command::Undo);
            assert!(read_field(&branch.core).is_none());
            branch.execute(Command::Redo);
            assert_eq!(
                read_field(&branch.core).unwrap().values,
                [PropertyValue::String("recreated".into())]
            );
            assert!(branch.core.snapshot().unwrap().quarantined.is_empty());
        }
    }
}

fn property_field(
    key: &PropertyKey,
    value_type: PropertyType,
    cardinality: Cardinality,
    values: Vec<PropertyValue>,
) -> PropertyField {
    PropertyField {
        key: key.clone(),
        value_type,
        cardinality,
        values,
    }
}

#[test]
fn concurrent_first_property_types_select_one_coherent_generation() {
    let graph_id = GraphId::new("merge-law-property-type-generation").unwrap();
    let page_id = PageId::new("page").unwrap();
    let owner = PropertyOwner::Page {
        id: page_id.clone(),
    };
    let key = PropertyKey::new("user.shape").unwrap();
    let harness = MergeLawHarness::with_ancestor(graph_id, |ancestor| {
        ancestor.execute(Command::EnsurePage {
            page_id: page_id.clone(),
            title: "Page".into(),
        });
    });
    let candidates = [
        property_field(
            &key,
            PropertyType::String,
            Cardinality::Single,
            vec![PropertyValue::String("string".into())],
        ),
        property_field(
            &key,
            PropertyType::Number,
            Cardinality::Single,
            vec![PropertyValue::Number(42.0)],
        ),
    ];

    for path in [MergePath::Remote, MergePath::Recovery] {
        let selected = harness
            .observe_via(
                path,
                |left| {
                    left.execute(Command::SetProperty {
                        owner: owner.clone(),
                        key: key.clone(),
                        value: PropertyValue::String("string".into()),
                    });
                },
                |right| {
                    right.execute(Command::SetProperty {
                        owner: owner.clone(),
                        key: key.clone(),
                        value: PropertyValue::Number(42.0),
                    });
                },
            )
            .into_page_property(&page_id, &key)
            .expect("one concurrent field generation must win");
        assert!(
            candidates.contains(&selected),
            "hybrid field: {selected:#?}"
        );
    }
}

#[test]
fn concurrent_first_property_cardinalities_select_one_coherent_generation() {
    let graph_id = GraphId::new("merge-law-property-cardinality-generation").unwrap();
    let page_id = PageId::new("page").unwrap();
    let owner = PropertyOwner::Page {
        id: page_id.clone(),
    };
    let key = PropertyKey::new("user.shape").unwrap();
    let harness = MergeLawHarness::with_ancestor(graph_id, |ancestor| {
        ancestor.execute(Command::EnsurePage {
            page_id: page_id.clone(),
            title: "Page".into(),
        });
    });
    let candidates = [
        property_field(
            &key,
            PropertyType::String,
            Cardinality::Single,
            vec![PropertyValue::String("single".into())],
        ),
        property_field(
            &key,
            PropertyType::String,
            Cardinality::Set,
            vec![PropertyValue::String("set".into())],
        ),
    ];

    for path in [MergePath::Remote, MergePath::Recovery] {
        let selected = harness
            .observe_via(
                path,
                |left| {
                    left.execute(Command::SetProperty {
                        owner: owner.clone(),
                        key: key.clone(),
                        value: PropertyValue::String("single".into()),
                    });
                },
                |right| {
                    right.execute(Command::AddRepeatedProperty {
                        owner: owner.clone(),
                        key: key.clone(),
                        value: PropertyValue::String("set".into()),
                    });
                },
            )
            .into_page_property(&page_id, &key)
            .expect("one concurrent field generation must win");
        assert!(
            candidates.contains(&selected),
            "hybrid field: {selected:#?}"
        );
    }
}

#[test]
fn concurrent_same_shape_first_creations_do_not_merge_initial_members() {
    let graph_id = GraphId::new("merge-law-property-first-generation").unwrap();
    let page_id = PageId::new("page").unwrap();
    let owner = PropertyOwner::Page {
        id: page_id.clone(),
    };
    let key = PropertyKey::new("user.labels").unwrap();
    let harness = MergeLawHarness::with_ancestor(graph_id, |ancestor| {
        ancestor.execute(Command::EnsurePage {
            page_id: page_id.clone(),
            title: "Page".into(),
        });
    });

    for path in [MergePath::Remote, MergePath::Recovery] {
        let selected = harness
            .observe_via(
                path,
                |left| {
                    left.execute(Command::AddRepeatedProperty {
                        owner: owner.clone(),
                        key: key.clone(),
                        value: PropertyValue::String("left".into()),
                    });
                },
                |right| {
                    right.execute(Command::AddRepeatedProperty {
                        owner: owner.clone(),
                        key: key.clone(),
                        value: PropertyValue::String("right".into()),
                    });
                },
            )
            .into_page_property(&page_id, &key)
            .expect("one concurrent field generation must win");
        assert_eq!(selected.cardinality, Cardinality::Set);
        assert!(
            selected.values == [PropertyValue::String("left".into())]
                || selected.values == [PropertyValue::String("right".into())],
            "first creations must not cross-merge generations: {selected:#?}"
        );
    }
}

#[test]
fn concurrent_set_edits_merge_after_the_generation_is_shared() {
    let page_id = PageId::new("page").unwrap();
    let owner = PropertyOwner::Page {
        id: page_id.clone(),
    };
    let key = PropertyKey::new("user.labels").unwrap();
    let (harness, _, _) = page_property_harness(
        "merge-law-property-shared-generation",
        Command::AddRepeatedProperty {
            owner: owner.clone(),
            key: key.clone(),
            value: PropertyValue::String("ancestor".into()),
        },
    );

    for path in [MergePath::Remote, MergePath::Recovery] {
        let selected = harness
            .observe_via(
                path,
                |left| {
                    left.execute(Command::AddRepeatedProperty {
                        owner: owner.clone(),
                        key: key.clone(),
                        value: PropertyValue::String("left".into()),
                    });
                },
                |right| {
                    right.execute(Command::AddRepeatedProperty {
                        owner: owner.clone(),
                        key: key.clone(),
                        value: PropertyValue::String("right".into()),
                    });
                },
            )
            .into_page_property(&page_id, &key)
            .expect("shared field generation must remain present");
        assert_eq!(
            selected,
            property_field(
                &key,
                PropertyType::String,
                Cardinality::Set,
                vec![
                    PropertyValue::String("ancestor".into()),
                    PropertyValue::String("left".into()),
                    PropertyValue::String("right".into()),
                ],
            )
        );
    }
}

#[test]
fn concurrent_block_content_growth_is_merge_total_and_reported_as_data() {
    let (harness, owner, block_id) = block_text_harness();

    harness
        .observe(
            |left| {
                left.execute(Command::SpliceMarkdown {
                    owner: owner.clone(),
                    block_id: block_id.clone(),
                    index: 0,
                    delete: 0,
                    insert: "🦀".into(),
                });
            },
            |right| {
                right.execute(Command::SpliceMarkdown {
                    owner: owner.clone(),
                    block_id: block_id.clone(),
                    index: 262_143,
                    delete: 0,
                    insert: "🦀".into(),
                });
            },
        )
        .assert_merge_closed(
            vec![GraphConflict::TextLimitExceeded {
                target: TextTarget::BlockContent {
                    owner: owner.clone(),
                    block_id: block_id.clone(),
                },
                actual_bytes: 1_048_580,
                limit: 1_048_576,
            }],
            Vec::new(),
        );

    harness
        .observe_recovery(
            |left| {
                left.execute(Command::SpliceMarkdown {
                    owner: owner.clone(),
                    block_id: block_id.clone(),
                    index: 0,
                    delete: 0,
                    insert: "🦀".into(),
                });
            },
            |right| {
                right.execute(Command::SpliceMarkdown {
                    owner: owner.clone(),
                    block_id: block_id.clone(),
                    index: 262_143,
                    delete: 0,
                    insert: "🦀".into(),
                });
            },
        )
        .assert_merge_closed(
            vec![GraphConflict::TextLimitExceeded {
                target: TextTarget::BlockContent { owner, block_id },
                actual_bytes: 1_048_580,
                limit: 1_048_576,
            }],
            Vec::new(),
        );
}

fn default_query(id: &str) -> Command {
    default_query_with_document(
        id,
        PropertyDocument::default_query("SELECT ?item WHERE {}".into()),
    )
}

fn default_query_with_document(id: &str, document: PropertyDocument) -> Command {
    Command::CreateDefaultQuery {
        default_query_id: DefaultQueryId::new(id).unwrap(),
        title: id.into(),
        document,
    }
}

fn query_view(id: &str, position: u32) -> QueryView {
    let mut view = PropertyDocument::default_query("SELECT ?item WHERE {}".into())
        .views
        .remove(0);
    view.id = QueryViewId::new(id).unwrap();
    view.name = id.into();
    view.position = position;
    view
}

fn query_document(view_count: usize) -> (PropertyDocument, Vec<QueryViewId>) {
    assert!(view_count > 0);
    let views = (0..view_count)
        .map(|index| query_view(&format!("view-common-{index:02}"), index as u32))
        .collect::<Vec<_>>();
    let ids = views.iter().map(|view| view.id.clone()).collect();
    let document = PropertyDocument {
        schema: domain::QUERY_DOCUMENT_SCHEMA.into(),
        version: domain::QUERY_DOCUMENT_VERSION,
        default_view_id: views[0].id.clone(),
        views,
    };
    (document, ids)
}

fn query_plan(subject: &str) -> QueryPlan {
    QueryPlan {
        version: domain::QUERY_PLAN_VERSION,
        payload: serde_json::json!({
            "version": domain::QUERY_PLAN_VERSION,
            "grain": "entity",
            "subject": subject,
            "where": {
                "kind": "group",
                "id": "root",
                "match": "all",
                "children": [],
            },
            "columns": [{
                "id": "subject",
                "source": { "kind": "subject" },
            }],
            "limit": 100,
        })
        .to_string(),
    }
}

fn query_authority_harness(
    graph_id: GraphId,
) -> (MergeLawHarness, DefaultQueryId, QueryOwner, QueryViewId) {
    let default_query_id = DefaultQueryId::new("query-authority").unwrap();
    let view_id = QueryViewId::new("all").unwrap();
    let owner = QueryOwner::GraphDefault {
        default_query_id: default_query_id.clone(),
    };
    let harness = MergeLawHarness::with_ancestor(graph_id, |ancestor| {
        ancestor.execute(default_query(default_query_id.as_str()));
    });
    (harness, default_query_id, owner, view_id)
}

fn map_child(parent: &LoroMap, key: &str) -> LoroMap {
    match parent.get(key) {
        Some(ValueOrContainer::Container(Container::Map(map))) => map,
        _ => panic!("expected map child {key}"),
    }
}

fn legacy_query_authority_harness(
    graph_id: GraphId,
    legacy_plan: &QueryPlan,
) -> (MergeLawHarness, DefaultQueryId, QueryOwner, QueryViewId) {
    let (current, default_query_id, owner, view_id) = query_authority_harness(graph_id.clone());
    let doc = LoroDoc::from_snapshot(&current.ancestor).unwrap();
    doc.set_peer_id(41).unwrap();
    let settings = doc.get_map("graph_settings");
    let queries = map_child(&settings, "default_queries");
    let query = map_child(&queries, default_query_id.as_str());
    let document = map_child(&query, "document");
    let views = map_child(&document, "views");
    let view = map_child(&views, view_id.as_str());
    let definition = map_child(&view, "definition");
    definition.delete("plan_state").unwrap();
    definition
        .insert("plan_version", i64::from(legacy_plan.version))
        .unwrap();
    definition
        .insert("plan", legacy_plan.payload.as_str())
        .unwrap();
    doc.commit();
    let snapshot = doc.export(ExportMode::Snapshot).unwrap();
    let ancestor = GraphCore::from_snapshot(graph_id, 1, &snapshot).unwrap();
    let projected = ancestor.summary().unwrap().settings.default_queries[0]
        .document
        .views[0]
        .definition
        .clone();
    assert_eq!(projected.plan.as_ref(), Some(legacy_plan));
    assert_eq!(
        projected.source,
        query::derive_plan_source(legacy_plan).unwrap()
    );
    (
        MergeLawHarness::from_ancestor(&ancestor),
        default_query_id,
        owner,
        view_id,
    )
}

fn assert_projected_query_authority(
    definition: &QueryDefinition,
    raw_source: &str,
    candidate_plans: &[QueryPlan],
) {
    match &definition.plan {
        Some(plan) => {
            assert!(candidate_plans.contains(plan));
            assert_eq!(definition.source, query::derive_plan_source(plan).unwrap());
        }
        None => {
            assert_eq!(definition.source, raw_source);
            assert!(!definition.source.contains("q_p"));
            assert!(
                !definition
                    .source
                    .starts_with(query::DERIVED_SOURCE_PROVENANCE)
            );
        }
    }
}

#[test]
fn concurrent_query_plan_sets_are_one_atomic_register() {
    let (harness, default_query_id, owner, view_id) =
        query_authority_harness(GraphId::new("merge-law-query-plan-set-set").unwrap());
    let left_plan = query_plan("block");
    let right_plan = query_plan("page");
    let run = |path: MergePath| {
        let left_plan = left_plan.clone();
        let right_plan = right_plan.clone();
        let outcome = match path {
            MergePath::Remote => harness.observe(
                |left| {
                    left.execute(Command::SetQueryPlan {
                        owner: owner.clone(),
                        view_id: view_id.clone(),
                        plan: left_plan,
                    });
                },
                |right| {
                    right.execute(Command::SetQueryPlan {
                        owner: owner.clone(),
                        view_id: view_id.clone(),
                        plan: right_plan,
                    });
                },
            ),
            MergePath::Recovery => harness.observe_recovery(
                |left| {
                    left.execute(Command::SetQueryPlan {
                        owner: owner.clone(),
                        view_id: view_id.clone(),
                        plan: left_plan,
                    });
                },
                |right| {
                    right.execute(Command::SetQueryPlan {
                        owner: owner.clone(),
                        view_id: view_id.clone(),
                        plan: right_plan,
                    });
                },
            ),
        };
        outcome.into_query_definition(&default_query_id, &view_id)
    };

    let remote = run(MergePath::Remote);
    let recovery = run(MergePath::Recovery);
    assert_eq!(remote, recovery);
    let winner = remote.plan.as_ref().expect("one complete plan must win");
    assert!([&left_plan, &right_plan].contains(&winner));
    assert_eq!(remote.source, query::derive_plan_source(winner).unwrap());
}

#[test]
fn concurrent_raw_source_and_query_plan_keep_one_authority() {
    let (harness, default_query_id, owner, view_id) =
        query_authority_harness(GraphId::new("merge-law-query-plan-raw-built").unwrap());
    let raw_source = "SELECT ?raw WHERE { ?raw a <urn:Raw> }";
    let built_plan = query_plan("block");
    let run = |path: MergePath| {
        let outcome = match path {
            MergePath::Remote => harness.observe(
                |left| {
                    left.execute(Command::SetQuerySource {
                        owner: owner.clone(),
                        view_id: view_id.clone(),
                        source: raw_source.into(),
                    });
                },
                |right| {
                    right.execute(Command::SetQueryPlan {
                        owner: owner.clone(),
                        view_id: view_id.clone(),
                        plan: built_plan.clone(),
                    });
                },
            ),
            MergePath::Recovery => harness.observe_recovery(
                |left| {
                    left.execute(Command::SetQuerySource {
                        owner: owner.clone(),
                        view_id: view_id.clone(),
                        source: raw_source.into(),
                    });
                },
                |right| {
                    right.execute(Command::SetQueryPlan {
                        owner: owner.clone(),
                        view_id: view_id.clone(),
                        plan: built_plan.clone(),
                    });
                },
            ),
        };
        outcome.into_query_definition(&default_query_id, &view_id)
    };

    let remote = run(MergePath::Remote);
    let recovery = run(MergePath::Recovery);
    assert_eq!(remote, recovery);
    assert_projected_query_authority(&remote, raw_source, std::slice::from_ref(&built_plan));
}

#[test]
fn legacy_query_plan_pair_yields_to_the_first_atomic_authority_write() {
    let legacy_plan = query_plan("page");
    let (harness, default_query_id, owner, view_id) = legacy_query_authority_harness(
        GraphId::new("merge-law-query-plan-legacy-adapter").unwrap(),
        &legacy_plan,
    );
    let raw_source = "SELECT ?legacy_ejected WHERE { ?legacy_ejected a <urn:Raw> }";
    let next_plan = query_plan("block");
    let run = |path: MergePath| {
        let outcome = match path {
            MergePath::Remote => harness.observe(
                |left| {
                    left.execute(Command::SetQuerySource {
                        owner: owner.clone(),
                        view_id: view_id.clone(),
                        source: raw_source.into(),
                    });
                },
                |right| {
                    right.execute(Command::SetQueryPlan {
                        owner: owner.clone(),
                        view_id: view_id.clone(),
                        plan: next_plan.clone(),
                    });
                },
            ),
            MergePath::Recovery => harness.observe_recovery(
                |left| {
                    left.execute(Command::SetQuerySource {
                        owner: owner.clone(),
                        view_id: view_id.clone(),
                        source: raw_source.into(),
                    });
                },
                |right| {
                    right.execute(Command::SetQueryPlan {
                        owner: owner.clone(),
                        view_id: view_id.clone(),
                        plan: next_plan.clone(),
                    });
                },
            ),
        };
        outcome.into_query_definition(&default_query_id, &view_id)
    };

    let remote = run(MergePath::Remote);
    let recovery = run(MergePath::Recovery);
    assert_eq!(remote, recovery);
    assert_projected_query_authority(&remote, raw_source, std::slice::from_ref(&next_plan));
}

fn seven_default_queries(graph_id: GraphId) -> (MergeLawHarness, Vec<DefaultQueryId>) {
    let common_ids = (0..7)
        .map(|index| DefaultQueryId::new(format!("query-common-{index}")).unwrap())
        .collect::<Vec<_>>();
    let harness = MergeLawHarness::with_ancestor(graph_id, |ancestor| {
        for id in &common_ids {
            ancestor.execute(default_query(id.as_str()));
        }
    });
    (harness, common_ids)
}

#[test]
fn concurrent_default_query_creation_is_merge_total_with_bounded_projection() {
    let graph_id = GraphId::new("merge-law-default-query-overflow").unwrap();
    let (harness, common_ids) = seven_default_queries(graph_id);
    let left_id = DefaultQueryId::new("query-left").unwrap();
    let right_id = DefaultQueryId::new("query-right").unwrap();
    let mut visible_ids = common_ids;
    visible_ids.push(left_id.clone());

    harness
        .observe(
            |left| {
                left.execute(default_query(left_id.as_str()));
            },
            |right| {
                right.execute(default_query(right_id.as_str()));
            },
        )
        .assert_merge_closed(
            vec![GraphConflict::DefaultQueryOverflow {
                overflow_ids: vec![right_id],
            }],
            visible_ids,
        );
}

#[test]
fn deleting_a_visible_default_query_promotes_the_preserved_overflow_entry() {
    let graph_id = GraphId::new("merge-law-default-query-promotion").unwrap();
    let (harness, common_ids) = seven_default_queries(graph_id);
    let left_id = DefaultQueryId::new("query-left").unwrap();
    let right_id = DefaultQueryId::new("query-right").unwrap();
    let mut left = harness.branch(LEFT_PEER, "left-promotion");
    let mut right = harness.branch(RIGHT_PEER, "right-promotion");
    left.execute(default_query(left_id.as_str()));
    right.execute(default_query(right_id.as_str()));
    let right_update = right
        .core
        .export_updates_since(&harness.ancestor_version)
        .unwrap();
    left.core.import_remote(&right_update).unwrap();

    let overflow = left.core.summary().unwrap();
    assert_eq!(
        overflow.conflicts,
        vec![GraphConflict::DefaultQueryOverflow {
            overflow_ids: vec![right_id.clone()],
        }]
    );

    left.execute(Command::DeleteDefaultQuery {
        default_query_id: common_ids[0].clone(),
    });
    let resolved = left.core.summary().unwrap();
    let mut expected_ids = common_ids[1..].to_vec();
    expected_ids.extend([left_id, right_id]);
    assert_eq!(
        resolved
            .settings
            .default_queries
            .into_iter()
            .map(|query| query.id)
            .collect::<Vec<_>>(),
        expected_ids
    );
    assert!(resolved.conflicts.is_empty());
}

#[test]
fn local_default_query_creation_remains_bounded() {
    let graph_id = GraphId::new("merge-law-local-default-query-cap").unwrap();
    let harness = MergeLawHarness::empty(graph_id);
    let mut branch = harness.branch(LEFT_PEER, "local-cap");
    for index in 0..8 {
        branch.execute(default_query(&format!("query-{index}")));
    }

    let error = branch
        .try_execute(default_query("query-over-limit"))
        .unwrap_err();
    assert!(matches!(
        error,
        CoreError::InvalidHierarchy(message)
            if message == "graph already has the maximum number of default queries"
    ));
}

fn query_view_harness(
    graph_id: GraphId,
    view_count: usize,
) -> (
    MergeLawHarness,
    DefaultQueryId,
    QueryOwner,
    Vec<QueryViewId>,
) {
    let default_query_id = DefaultQueryId::new("query-document").unwrap();
    let owner = QueryOwner::GraphDefault {
        default_query_id: default_query_id.clone(),
    };
    let (document, view_ids) = query_document(view_count);
    let harness = MergeLawHarness::with_ancestor(graph_id, |ancestor| {
        ancestor.execute(default_query_with_document(
            default_query_id.as_str(),
            document,
        ));
    });
    (harness, default_query_id, owner, view_ids)
}

fn page_query_view_harness(graph_id: GraphId, view_count: usize) -> (MergeLawHarness, QueryOwner) {
    assert!(view_count > 0);
    let page_id = PageId::new("query-page").unwrap();
    let owner = QueryOwner::Page {
        id: page_id.clone(),
    };
    let harness = MergeLawHarness::with_ancestor(graph_id, |ancestor| {
        ancestor.execute(Command::EnsurePage {
            page_id,
            title: "Query page".into(),
        });
        ancestor.execute(Command::SetQuerySource {
            owner: owner.clone(),
            view_id: QueryViewId::new("all").unwrap(),
            source: "SELECT ?item WHERE {}".into(),
        });
        for index in 1..view_count {
            ancestor.execute(Command::PutQueryView {
                owner: owner.clone(),
                view: query_view(&format!("view-common-{index:02}"), index as u32),
            });
        }
    });
    (harness, owner)
}

#[test]
fn concurrent_query_view_creation_is_merge_total_with_bounded_projection() {
    let graph_id = GraphId::new("merge-law-query-view-overflow").unwrap();
    let (harness, default_query_id, owner, common_ids) = query_view_harness(graph_id, 31);
    let left_id = QueryViewId::new("view-left").unwrap();
    let right_id = QueryViewId::new("view-right").unwrap();
    let mut visible_ids = common_ids;
    visible_ids.push(left_id.clone());
    let visible_default_id = visible_ids[0].clone();

    harness
        .observe(
            |left| {
                left.execute(Command::PutQueryView {
                    owner: owner.clone(),
                    view: query_view(left_id.as_str(), 31),
                });
            },
            |right| {
                right.execute(Command::PutQueryView {
                    owner: owner.clone(),
                    view: query_view(right_id.as_str(), 31),
                });
            },
        )
        .assert_merge_closed_with_query_views(
            vec![GraphConflict::QueryViewOverflow {
                owner,
                overflow_ids: vec![right_id],
            }],
            vec![default_query_id.clone()],
            vec![(default_query_id, visible_ids, visible_default_id)],
        );
}

#[test]
fn page_query_view_overflow_reports_its_property_owner() {
    let graph_id = GraphId::new("merge-law-page-query-view-overflow").unwrap();
    let (harness, owner) = page_query_view_harness(graph_id, 31);
    let left_id = QueryViewId::new("view-left").unwrap();
    let right_id = QueryViewId::new("view-right").unwrap();

    harness
        .observe(
            |left| {
                left.execute(Command::PutQueryView {
                    owner: owner.clone(),
                    view: query_view(left_id.as_str(), 31),
                });
            },
            |right| {
                right.execute(Command::PutQueryView {
                    owner: owner.clone(),
                    view: query_view(right_id.as_str(), 31),
                });
            },
        )
        .assert_merge_closed(
            vec![GraphConflict::QueryViewOverflow {
                owner,
                overflow_ids: vec![right_id],
            }],
            Vec::new(),
        );
}

#[test]
fn deleting_a_visible_query_view_promotes_the_preserved_overflow_entry() {
    let graph_id = GraphId::new("merge-law-query-view-promotion").unwrap();
    let (harness, default_query_id, owner, common_ids) = query_view_harness(graph_id, 31);
    let left_id = QueryViewId::new("view-left").unwrap();
    let right_id = QueryViewId::new("view-right").unwrap();
    let mut left = harness.branch(LEFT_PEER, "left-view-promotion");
    let mut right = harness.branch(RIGHT_PEER, "right-view-promotion");
    left.execute(Command::PutQueryView {
        owner: owner.clone(),
        view: query_view(left_id.as_str(), 31),
    });
    right.execute(Command::PutQueryView {
        owner: owner.clone(),
        view: query_view(right_id.as_str(), 31),
    });
    let left_update = left
        .core
        .export_updates_since(&harness.ancestor_version)
        .unwrap();
    let right_update = right
        .core
        .export_updates_since(&harness.ancestor_version)
        .unwrap();
    left.core.import_remote(&right_update).unwrap();
    right.core.import_remote(&left_update).unwrap();

    assert_eq!(
        left.core.summary().unwrap().conflicts,
        vec![GraphConflict::QueryViewOverflow {
            owner: owner.clone(),
            overflow_ids: vec![right_id.clone()],
        }]
    );
    assert_eq!(left.core.summary().unwrap(), right.core.summary().unwrap());

    left.execute(Command::RemoveQueryView {
        owner: owner.clone(),
        view_id: common_ids[0].clone(),
    });
    right.execute(Command::RemoveQueryView {
        owner,
        view_id: common_ids[0].clone(),
    });
    let resolved = left.core.summary().unwrap();
    let reverse_resolved = right.core.summary().unwrap();
    let query = resolved
        .settings
        .default_queries
        .iter()
        .find(|query| query.id == default_query_id)
        .unwrap();
    let mut expected_ids = common_ids[1..].to_vec();
    expected_ids.extend([left_id, right_id]);
    assert_eq!(
        query
            .document
            .views
            .iter()
            .map(|view| view.id.clone())
            .collect::<Vec<_>>(),
        expected_ids
    );
    assert_eq!(query.document.default_view_id, common_ids[1]);
    assert!(resolved.conflicts.is_empty());
    assert_eq!(resolved, reverse_resolved);
}

#[test]
fn local_query_view_creation_remains_bounded() {
    let graph_id = GraphId::new("merge-law-local-query-view-cap").unwrap();
    let (harness, _, owner, _) = query_view_harness(graph_id, 32);
    let mut branch = harness.branch(LEFT_PEER, "local-view-cap");

    let error = branch
        .try_execute(Command::PutQueryView {
            owner,
            view: query_view("view-over-limit", 32),
        })
        .unwrap_err();
    assert!(matches!(
        error,
        CoreError::Property(PropertyError::InvalidDocument(message))
            if message == "query document must contain between 1 and 32 views"
    ));
}

#[test]
fn concurrent_default_selection_and_view_removal_is_merge_total() {
    let graph_id = GraphId::new("merge-law-query-default-deleted").unwrap();
    let (harness, default_query_id, owner, view_ids) = query_view_harness(graph_id, 2);
    let requested_view_id = view_ids[1].clone();
    let fallback_view_id = view_ids[0].clone();

    harness
        .observe(
            |left| {
                left.execute(Command::SetQueryDefaultView {
                    owner: owner.clone(),
                    view_id: requested_view_id.clone(),
                });
            },
            |right| {
                right.execute(Command::RemoveQueryView {
                    owner: owner.clone(),
                    view_id: requested_view_id.clone(),
                });
            },
        )
        .assert_merge_closed_with_query_views(
            vec![GraphConflict::QueryDefaultViewUnavailable {
                owner,
                requested_view_id,
                fallback_view_id: fallback_view_id.clone(),
            }],
            vec![default_query_id.clone()],
            vec![(
                default_query_id,
                vec![fallback_view_id.clone()],
                fallback_view_id,
            )],
        );
}

#[test]
fn concurrent_removal_of_all_query_views_uses_a_conflicted_synthetic_fallback() {
    let graph_id = GraphId::new("merge-law-all-query-views-deleted").unwrap();
    let (harness, default_query_id, owner, view_ids) = query_view_harness(graph_id, 2);
    let requested_view_id = view_ids[1].clone();
    let fallback_view_id = QueryViewId::new("all").unwrap();

    harness
        .observe(
            |left| {
                left.execute(Command::RemoveQueryView {
                    owner: owner.clone(),
                    view_id: view_ids[0].clone(),
                });
            },
            |right| {
                right.execute(Command::RemoveQueryView {
                    owner: owner.clone(),
                    view_id: view_ids[1].clone(),
                });
            },
        )
        .assert_merge_closed_with_query_views(
            vec![GraphConflict::QueryDefaultViewUnavailable {
                owner,
                requested_view_id,
                fallback_view_id: fallback_view_id.clone(),
            }],
            vec![default_query_id.clone()],
            vec![(
                default_query_id,
                vec![fallback_view_id.clone()],
                fallback_view_id,
            )],
        );
}

#[test]
fn concurrent_query_source_growth_is_merge_total_and_reported_as_data() {
    let graph_id = GraphId::new("merge-law-query-source-limit").unwrap();
    let default_query_id = DefaultQueryId::new("query-document").unwrap();
    let owner = QueryOwner::GraphDefault {
        default_query_id: default_query_id.clone(),
    };
    let document = PropertyDocument::default_query("x".repeat(65_534));
    let harness = MergeLawHarness::with_ancestor(graph_id, |ancestor| {
        ancestor.execute(default_query_with_document(
            default_query_id.as_str(),
            document,
        ));
    });
    let view_id = QueryViewId::new("all").unwrap();

    // Each branch reaches the accepted 65,536-byte boundary. LoroText retains
    // both insertions, so the merged source is preserved at 65,538 bytes while
    // projection names the budget violation instead of rejecting either peer.
    harness
        .observe(
            |left| {
                left.execute(Command::SpliceQuerySource {
                    owner: owner.clone(),
                    view_id: view_id.clone(),
                    index: 0,
                    delete: 0,
                    insert: "LL".into(),
                });
            },
            |right| {
                right.execute(Command::SpliceQuerySource {
                    owner: owner.clone(),
                    view_id: view_id.clone(),
                    index: 65_534,
                    delete: 0,
                    insert: "RR".into(),
                });
            },
        )
        .assert_merge_closed(
            vec![GraphConflict::TextLimitExceeded {
                target: TextTarget::QuerySource {
                    owner: owner.clone(),
                    view_id: view_id.clone(),
                },
                actual_bytes: 65_538,
                limit: 65_536,
            }],
            vec![default_query_id.clone()],
        );

    harness
        .observe_recovery(
            |left| {
                left.execute(Command::SpliceQuerySource {
                    owner: owner.clone(),
                    view_id: view_id.clone(),
                    index: 0,
                    delete: 0,
                    insert: "LL".into(),
                });
            },
            |right| {
                right.execute(Command::SpliceQuerySource {
                    owner: owner.clone(),
                    view_id: view_id.clone(),
                    index: 65_534,
                    delete: 0,
                    insert: "RR".into(),
                });
            },
        )
        .assert_merge_closed(
            vec![GraphConflict::TextLimitExceeded {
                target: TextTarget::QuerySource { owner, view_id },
                actual_bytes: 65_538,
                limit: 65_536,
            }],
            vec![default_query_id],
        );
}

#[test]
fn local_query_source_growth_remains_bounded() {
    let graph_id = GraphId::new("merge-law-local-query-source-limit").unwrap();
    let default_query_id = DefaultQueryId::new("query-document").unwrap();
    let owner = QueryOwner::GraphDefault {
        default_query_id: default_query_id.clone(),
    };
    let document = PropertyDocument::default_query("x".repeat(65_536));
    let harness = MergeLawHarness::with_ancestor(graph_id, |ancestor| {
        ancestor.execute(default_query_with_document(
            default_query_id.as_str(),
            document,
        ));
    });
    let mut branch = harness.branch(LEFT_PEER, "local-query-source-limit");

    let error = branch
        .try_execute(Command::SpliceQuerySource {
            owner,
            view_id: QueryViewId::new("all").unwrap(),
            index: 65_536,
            delete: 0,
            insert: "x".into(),
        })
        .unwrap_err();
    assert!(matches!(error, CoreError::TextTooLong));
}
