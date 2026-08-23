use super::{CoreError, GraphCore, MAX_STRUCTURAL_TARGETS};
use domain::{BlockId, BlockSnapshot, OutlineOwner};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone)]
pub(super) struct OutlinePlan {
    pub(super) before: OutlineState,
    pub(super) roots: Vec<BlockId>,
}

#[derive(Debug, Clone)]
pub(super) struct OutlineState {
    pub(super) parents: BTreeMap<BlockId, Option<BlockId>>,
    pub(super) children: BTreeMap<Option<BlockId>, Vec<BlockId>>,
    document_order: Vec<BlockId>,
}

impl OutlineState {
    fn from_blocks(blocks: &[BlockSnapshot]) -> Self {
        let mut state = Self {
            parents: BTreeMap::new(),
            children: BTreeMap::new(),
            document_order: Vec::new(),
        };
        state.add_blocks(blocks, None);
        state
    }

    fn add_blocks(&mut self, blocks: &[BlockSnapshot], parent: Option<BlockId>) {
        let ids = blocks
            .iter()
            .map(|block| block.id.clone())
            .collect::<Vec<_>>();
        self.children.insert(parent.clone(), ids);
        for block in blocks {
            self.parents.insert(block.id.clone(), parent.clone());
            self.document_order.push(block.id.clone());
            self.add_blocks(&block.children, Some(block.id.clone()));
        }
    }

    fn roots(&self, requested: &[BlockId]) -> Result<Vec<BlockId>, CoreError> {
        if requested.is_empty() {
            return Err(CoreError::InvalidHierarchy(
                "structural command requires at least one block".into(),
            ));
        }
        if requested.len() > MAX_STRUCTURAL_TARGETS {
            return Err(CoreError::InvalidHierarchy(
                "structural command exceeds the block target limit".into(),
            ));
        }
        let requested = requested.iter().cloned().collect::<BTreeSet<_>>();
        for block_id in &requested {
            if !self.parents.contains_key(block_id) {
                return Err(CoreError::BlockNotFound(block_id.clone()));
            }
        }

        Ok(self
            .document_order
            .iter()
            .filter(|block_id| {
                requested.contains(*block_id) && !self.has_requested_ancestor(block_id, &requested)
            })
            .cloned()
            .collect())
    }

    fn has_requested_ancestor(&self, block_id: &BlockId, requested: &BTreeSet<BlockId>) -> bool {
        let mut parent = self.parents.get(block_id).cloned().flatten();
        while let Some(current) = parent {
            if requested.contains(&current) {
                return true;
            }
            parent = self.parents.get(&current).cloned().flatten();
        }
        false
    }

    fn move_group(
        &mut self,
        roots: &[BlockId],
        parent: Option<BlockId>,
        index: usize,
    ) -> Result<(), CoreError> {
        if let Some(parent_id) = &parent
            && !self.parents.contains_key(parent_id)
        {
            return Err(CoreError::BlockNotFound(parent_id.clone()));
        }
        let root_set = roots.iter().cloned().collect::<BTreeSet<_>>();
        let stationary = self
            .children
            .get(&parent)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|id| !root_set.contains(id))
            .collect::<Vec<_>>();
        let mut anchor = index
            .min(stationary.len())
            .checked_sub(1)
            .map(|position| stationary[position].clone());

        for root in roots {
            let destination = match &anchor {
                Some(anchor_id) => self
                    .children
                    .get(&parent)
                    .and_then(|siblings| siblings.iter().position(|id| id == anchor_id))
                    .map(|position| position + 1)
                    .ok_or_else(|| {
                        CoreError::InvalidHierarchy("move anchor is not a target sibling".into())
                    })?,
                None => 0,
            };
            self.move_one(root, parent.clone(), destination)?;
            anchor = Some(root.clone());
        }
        Ok(())
    }

    fn indent(&mut self, block_id: &BlockId) -> Result<(), CoreError> {
        let parent = self
            .parents
            .get(block_id)
            .cloned()
            .ok_or_else(|| CoreError::BlockNotFound(block_id.clone()))?;
        let siblings = self.children.get(&parent).cloned().unwrap_or_default();
        let position = siblings
            .iter()
            .position(|id| id == block_id)
            .ok_or_else(|| CoreError::BlockNotFound(block_id.clone()))?;
        if position == 0 {
            return Err(CoreError::InvalidHierarchy(
                "first sibling cannot be indented".into(),
            ));
        }
        self.move_one(block_id, Some(siblings[position - 1].clone()), usize::MAX)
    }

    fn outdent(&mut self, block_id: &BlockId) -> Result<(), CoreError> {
        let parent = self
            .parents
            .get(block_id)
            .cloned()
            .flatten()
            .ok_or_else(|| CoreError::InvalidHierarchy("root block cannot be outdented".into()))?;
        let grandparent = self
            .parents
            .get(&parent)
            .cloned()
            .ok_or_else(|| CoreError::InvalidHierarchy("missing grandparent".into()))?;
        let position = self
            .children
            .get(&grandparent)
            .and_then(|siblings| siblings.iter().position(|id| id == &parent))
            .ok_or_else(|| CoreError::InvalidHierarchy("missing parent sibling".into()))?;
        self.move_one(block_id, grandparent, position + 1)
    }

    fn move_one(
        &mut self,
        block_id: &BlockId,
        parent: Option<BlockId>,
        index: usize,
    ) -> Result<(), CoreError> {
        if parent.as_ref() == Some(block_id)
            || parent
                .as_ref()
                .is_some_and(|candidate| self.is_descendant(candidate, block_id))
        {
            return Err(CoreError::InvalidHierarchy(
                "move would create a cycle".into(),
            ));
        }
        let old_parent = self
            .parents
            .get(block_id)
            .cloned()
            .ok_or_else(|| CoreError::BlockNotFound(block_id.clone()))?;
        let old_siblings = self
            .children
            .get_mut(&old_parent)
            .ok_or_else(|| CoreError::BlockNotFound(block_id.clone()))?;
        let old_position = old_siblings
            .iter()
            .position(|id| id == block_id)
            .ok_or_else(|| CoreError::BlockNotFound(block_id.clone()))?;
        old_siblings.remove(old_position);

        let destination = self.children.entry(parent.clone()).or_default();
        destination.insert(index.min(destination.len()), block_id.clone());
        self.parents.insert(block_id.clone(), parent);
        Ok(())
    }

    fn is_descendant(&self, candidate: &BlockId, ancestor: &BlockId) -> bool {
        let mut current = Some(candidate.clone());
        while let Some(block_id) = current {
            if &block_id == ancestor {
                return true;
            }
            current = self.parents.get(&block_id).cloned().flatten();
        }
        false
    }
}

impl GraphCore {
    pub(super) fn outline_state(&self, owner: &OutlineOwner) -> Result<OutlineState, CoreError> {
        Ok(OutlineState::from_blocks(
            &self.outline_snapshot(owner)?.blocks,
        ))
    }

    pub(super) fn plan_move_blocks(
        &self,
        owner: &OutlineOwner,
        block_ids: &[BlockId],
        parent: Option<&BlockId>,
        index: usize,
    ) -> Result<OutlinePlan, CoreError> {
        let before = self.outline_state(owner)?;
        let roots = before.roots(block_ids)?;
        let mut after = before.clone();
        after.move_group(&roots, parent.cloned(), index)?;
        Ok(OutlinePlan { before, roots })
    }

    pub(super) fn plan_indent_blocks(
        &self,
        owner: &OutlineOwner,
        block_ids: &[BlockId],
    ) -> Result<OutlinePlan, CoreError> {
        let before = self.outline_state(owner)?;
        let roots = before.roots(block_ids)?;
        let mut after = before.clone();
        for block_id in &roots {
            after.indent(block_id)?;
        }
        Ok(OutlinePlan { before, roots })
    }

    pub(super) fn plan_outdent_blocks(
        &self,
        owner: &OutlineOwner,
        block_ids: &[BlockId],
    ) -> Result<OutlinePlan, CoreError> {
        let before = self.outline_state(owner)?;
        let mut roots = before.roots(block_ids)?;
        let mut after = before.clone();
        roots.reverse();
        for block_id in &roots {
            after.outdent(block_id)?;
        }
        Ok(OutlinePlan { before, roots })
    }

    pub(super) fn plan_delete_blocks(
        &self,
        owner: &OutlineOwner,
        block_ids: &[BlockId],
    ) -> Result<OutlinePlan, CoreError> {
        let before = self.outline_state(owner)?;
        Ok(OutlinePlan {
            roots: before.roots(block_ids)?,
            before,
        })
    }
}
