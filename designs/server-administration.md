# Server Administration Design

## Purpose and Boundary

The Admin Web app is the private operational surface for one sync server. It
manages who may authenticate and which sessions remain valid. It does not read
notes, edit graphs, or confer graph ownership.

The app is built and deployed independently from the Neoseq writing client, and
implements the shared visual foundation itself rather than importing the
client's. It shares the product's restraint, its semantic colour, type, depth and
motion roles across light and dark modes, its keyboard reachability, and its
plain-language feedback, but its subject is an account directory rather than a
document.

## Invariants

- A username is the human-facing handle; the immutable account ID is secondary
  operational metadata and never an input for ordinary actions.
- Server administrator privilege and per-graph owner/editor/viewer membership
  remain visibly and semantically distinct.
- Account creation, activation state, global privilege, credential reset, and
  session revocation each have one explicit control and one authoritative result.
- Disabling an account, removing administrator privilege, resetting a password,
  or revoking sessions states its consequence before committing.
- Passwords are write-only. A reset replaces the verifier, is never displayed
  afterward, and ends existing sessions.
- The last active administrator cannot be disabled or demoted. The directory
  withholds those two verbs from that account and says why, rather than offering
  them and then refusing; the server remains the authority.
- An Admin session is short and memory-only. Reloading or closing the app returns
  the operator to login rather than persisting administrative authority in Web
  storage.
- Appearance mode and language are browser-local presentation preferences. They
  are reachable before authentication, because an operator who cannot read the
  login form must not have to sign in to fix that, and they never reach the
  server.

## Information and Interaction

The account directory is the primary surface. Search narrows it without changing
server state. Each row presents username first, then active state and global
role. The opaque account ID remains available through the administration API for
diagnosis but is not part of the ordinary interface.

Creation is a bounded form above the directory because it changes the set being
read. Routine row actions stay with their account. Destructive or authority-
reducing actions require confirmation, show pending state on their owner, and
refresh from the server after commit rather than maintaining a durable optimistic
copy.

Healthy state is quiet. Authentication, validation, concurrency protection, and
last-administrator failures are reported in the surface that initiated them: the
login form, the creation panel, the row that committed a change, or the
confirmation that asked the question. A conflict is named by the surface that
raised it, because the same status carries different meanings to a creation and
to an amendment.

Desktop density may collapse into wrapped actions on narrow screens, but account
identity, state, and every verb remain available without hover.
