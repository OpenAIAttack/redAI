# redAI migrations — reference → versioned mapping

`db/001_reference_schema.sql` stays the **design contract** (the canonical, human-readable
DDL for spec `1.0.0-draft.1`). The files here are the **executable, ordered** migrations the
runner (`@redai/db` → `packages/db/src/migrate.ts`, CLI `packages/db/src/cli/migrate.ts`)
applies against a real server. They are byte-derived from the reference so the two never drift.

| Migration | Reference lines | Contents |
|---|---|---|
| `0001_init_schema.sql` | `db/001_reference_schema.sql` 6–713 | All tables, `CHECK`/`UNIQUE`/composite `FOREIGN KEY` constraints, partial-unique and query indexes, and the deferred/added constraints (`ALTER TABLE … ADD CONSTRAINT`). |
| `0002_triggers_and_events.sql` | `db/001_reference_schema.sql` 715–754 | Immutable-row triggers (`scope_versions`, `finding_versions`, finalized `artifacts`) and the `redai_append_event(...)` commit-ordered event-counter helper. |

The reference file's outer `BEGIN;`/`COMMIT;` (lines 4 and 760) are intentionally **not**
copied: the runner wraps **each** migration file in its own transaction, so a partial file can
never leave a half-applied schema.

## Runner contract (no ORM auto-sync/drop)

- Tracking table `schema_migrations(version, checksum, applied_at)` is created if absent.
- Files are applied in lexical `version` order; a file already recorded is skipped.
- Each applied file's SHA-256 is stored. If a **recorded** migration's on-disk checksum later
  changes, the runner **fails loudly** (drift guard) rather than silently re-applying.
- Each file runs as one multi-statement `query` inside one transaction (function bodies with
  embedded `;` are preserved — no statement splitting).
- The application never issues `DROP`/synchronize on boot; schema change is migrations-only.

## PostgreSQL version

Verified on **PostgreSQL 16.13** (the reference environment; see `docs/implementation-decisions.md`
D04). `SPEC_LOCK.json` target major is **18**; nothing is marked verified on 18 until a pinned 18
server exists. Migrations avoid PG17/18-only syntax. Everything used here
(`gen_random_uuid()` core function ≥13, `GENERATED ALWAYS AS … STORED` ≥12,
`DEFERRABLE INITIALLY DEFERRED` FKs, partial unique indexes) is valid on 16 and 18.

## Rollback / backup strategy

Migrations are **additive and forward-only** in normal operation (per `docs/05-data-model.md` §7:
additive-before-code, bounded backfill, cleanup in a later release; never drop a field with an
active run). There is no automatic `down`:

1. **Backup before any destructive migration.** Take a `pg_dump` (or filesystem/base backup) of
   the target database immediately before applying a migration that drops or rewrites data. The
   documented recovery path is *restore the pre-migration dump*, not an in-place `down` script.
2. **Fresh init rollback.** For `0001`/`0002` on a database that only contains redAI's own schema,
   rollback is `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` (or drop-and-recreate the
   database) followed by re-running the earlier migration set. This is safe **only** on a
   throwaway/test database — never in production with owner data.
3. **Corrective migrations.** In production, an unwanted change is undone by authoring a **new**
   higher-numbered migration that reverses it, keeping `schema_migrations` history intact.

The integration suite exercises fresh-apply + ordered upgrade on disposable databases
(`redai_t02_<n>`), each created and dropped by the test.

## Invariants the DB enforces vs. invariants the application must enforce

What the schema (these migrations) enforces on its own:

- **Ownership closure (INV-001).** Composite `(child, project_id, workspace_id)` FKs reject a
  child that references a parent in another project. (`composite-fk.test.ts`.)
- **One active run per chat (INV-002).** Partial unique index `one_active_run_per_chat` over the
  eight active states. (`active-run.test.ts`.)
- **Immutable authority/evidence (INV-003, INV-007).** `BEFORE UPDATE` triggers reject edits to
  `scope_versions`, `finding_versions`, and payload columns of a finalized (`ready`/`deleting`/
  `deleted`) artifact. (`immutability.test.ts`.)
- **Event consistency (INV-009).** `redai_append_event` allocates a commit-ordered, gap-free
  per-workspace cursor under a row lock held to COMMIT. (`event-counter.test.ts`.)
- Singletons/uniqueness: `one_inbox`, `one_coordinator`, `one_pending_approval`,
  `one_unsettled_attempt_per_call`, plus the many `UNIQUE`/`CHECK` constraints in `0001`.

What the DB **cannot** enforce and the application layer (create-run / model-boundary / approve /
finalize / cancel transactions) MUST enforce — these are integration-test obligations for later
tasks, not schema guarantees (echoing the trailing note in `db/001_reference_schema.sql`):

- **`max_active_runs_workspace` = 2 and `max_active_runs_chat` = 1 workspace-wide caps beyond the
  single-chat rule.** The index caps a chat at one active run; the *workspace* cap of 2 concurrent
  active runs is checked in the create-run transaction (demonstrated un-enforced by the DB in
  `active-run.test.ts`).
- **Live grant / epoch / worker-status checks at dispatch and renewal (INV-003, INV-010).** A run's
  `scope_version_id`/`grant_id` FK proves the grant existed, not that it is still `active` with a
  matching `policy_epoch`. Every dispatch must re-read the live grant.
- **Durable-before-effect ordering (INV-004).** The event + attempt + input digest must be
  committed before worker dispatch; only the transaction wrapper + call sequencing guarantee this.
- **Single authoritative result / fencing (INV-005, INV-006).** `task_attempts` uniqueness on
  `(tool_call_id, fencing_token)` and the deferred `current_attempt` FK constrain shape, but which
  attempt is authoritative, duplicate-ACK vs. conflict, and replay decisions are application logic.
- **Budget totals (INV-008).** `budget_reservations`/`usage_entries` store rows; the shared-ledger
  sum vs. `runs.budget_limit_micro_usd`, and holding unreconciled unknowns at non-zero, are computed
  in the model-boundary transaction.
- **Parent depth / child count (`max_children`, `max_child_depth`).** The `CHECK` bounds `depth` to
  0/1 and role/parent shape, but the *count* of children per coordinator is enforced by the agent
  runtime.
- **Verified-evidence gate, cursor/payload JSON schemas, worker capacity.** Validated in the domain
  and API layers before persist.

These application invariants are owned by later tasks (create-run T-run, events T03, grants T12,
budget/worker tasks) and are intentionally out of scope for T02's schema, which provides the
constraints/triggers/counter they build on.
