//! One document identity and name space. Legacy storage homes are immutable:
//! reading them in place preserves Loro tree/container IDs and offline history.
use crate::core::CoreError;
use domain::{EntityKind, OutlineOwner, PageId, TagId};
use loro::{Container, LoroDoc, LoroMap, ValueOrContainer};

pub(crate) fn root(record: &LoroMap) -> LoroMap {
    match record.get("root") {
        Some(ValueOrContainer::Container(Container::Map(root))) => root,
        _ => record.clone(), // schema 7 tag
    }
}

pub(crate) fn kind(record: &LoroMap) -> EntityKind {
    match record.get("kind") {
        Some(ValueOrContainer::Value(loro::LoroValue::String(value)))
            if value.as_ref() == "tag" =>
        {
            EntityKind::Tag
        }
        Some(ValueOrContainer::Value(loro::LoroValue::String(value)))
            if value.as_ref() == "page" =>
        {
            EntityKind::Page
        }
        _ if record.get("root").is_none() => EntityKind::Tag,
        _ => EntityKind::Page,
    }
}

pub(crate) fn name(record: &LoroMap) -> Option<String> {
    match root(record).get("content") {
        Some(ValueOrContainer::Container(Container::Text(text))) => Some(text.to_string()),
        _ => match record.get("name") {
            Some(ValueOrContainer::Value(loro::LoroValue::String(value))) => {
                Some(value.to_string())
            }
            _ => None,
        },
    }
}

pub(crate) fn set_name(record: &LoroMap, name: &str) -> Result<(), CoreError> {
    if record.get("root").is_none() {
        record.insert("name", name)?;
    } else {
        let text = root(record).ensure_mergeable_text("content")?;
        text.delete(0, text.len_unicode())?;
        text.insert(0, name)?;
    }
    Ok(())
}

pub(crate) fn owner(id: &str, record: &LoroMap) -> OutlineOwner {
    match kind(record) {
        EntityKind::Page => OutlineOwner::Page {
            id: PageId::new(id).expect("validated entity ID"),
        },
        EntityKind::Tag => OutlineOwner::Tag {
            id: TagId::new(id).expect("validated entity ID"),
        },
    }
}

pub(crate) struct Entities<'a> {
    doc: &'a LoroDoc,
    tags_only: bool,
}
pub(crate) fn all(doc: &LoroDoc) -> Entities<'_> {
    Entities {
        doc,
        tags_only: false,
    }
}
pub(crate) fn tags(doc: &LoroDoc) -> Entities<'_> {
    Entities {
        doc,
        tags_only: true,
    }
}
impl Entities<'_> {
    // Lookup is kind-independent: old routes, references and in-flight commands
    // retain their identity across a conversion. Admission checks kind separately.
    pub(crate) fn get(&self, id: &str) -> Option<ValueOrContainer> {
        ["entities", "pages", "tags"]
            .into_iter()
            .find_map(|home| self.doc.get_map(home).get(id))
    }
    pub(crate) fn for_each(&self, mut visit: impl FnMut(&str, ValueOrContainer)) {
        for home in ["entities", "pages", "tags"] {
            self.doc.get_map(home).for_each(|id, value| {
                if self.tags_only {
                    let ValueOrContainer::Container(Container::Map(record)) = &value else {
                        return;
                    };
                    if kind(record) != EntityKind::Tag {
                        return;
                    }
                }
                visit(id, value);
            });
        }
    }
    pub(crate) fn keys(&self) -> std::vec::IntoIter<String> {
        let mut keys = Vec::new();
        self.for_each(|id, _| keys.push(id.to_owned()));
        keys.into_iter()
    }
}
