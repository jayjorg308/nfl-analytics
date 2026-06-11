# Documentation map

This project uses several documents with distinct, non-overlapping roles:

- `db/schema.ts` — the schema as it actually IS. Drizzle TS code is
  the canonical implementation reference.
- `docs/schema-design.md` — why the schema is shaped this way. Design
  rationale and cross-references to ADRs.
- `docs/parquet-mapping.md` — source-system specifics for nflverse
  parquet → Postgres ingestion.
- `docs/adr/*` — architectural decisions, one ADR per decision.
- `CONTEXT.md` — domain language and product framing.

When in doubt: implementation questions go to Drizzle, "why" questions
go to schema-design.md or the ADRs, source-system questions go to
parquet-mapping.md, vocabulary questions go to CONTEXT.md.