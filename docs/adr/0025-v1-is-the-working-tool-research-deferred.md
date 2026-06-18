# v1 is the working tool; the research/portfolio dimension is the post-v1 sandbox

This ADR records one upstream decision — **what v1 is for** — and the two downstream
consequences it drove on 2026-06-18: the MOV-ELO methodology piece was **cut**, and v1
ship criterion #2 ("one substantive published investigation") was **deferred to
post-v1**. Both were already being applied across the docs when this record was written;
this ADR exists to make the *reasoning* durable in one place, because the reasoning — not
either consequence on its own — is what a future reader will most want to find. The cut
and the deferral look like two separate scope trims; they are the same decision applied
twice.

## The decision: what v1 is for (the load-bearing part)

**v1's purpose is a working analytical tool for the author's friend group** — the weekly
research workflow (slate → game → player → prop) that replaces the old Google Sheets,
backed by real ingested data. That is the current priority and the thing whose completion
defines v1.

**The substantive-publish / experiment / portfolio dimension is real and intended, but it
is a post-v1 sandbox that grows out of the working tool — not a gate on shipping it.**
Once the tool exists and is producing real data weekly, it *enables* investigations worth
publishing; the investigations are an outgrowth of having the tool, not a precondition for
releasing it. Sequencing the portfolio surface behind the tool is therefore the correct
order of operations for v1 specifically, even though ADR-0005 frames the project as a
portfolio piece overall and ADR-0010 ships "research in parallel" as a principle. Those
remain true at the project level; this ADR narrows the *v1 ship bar* to the tool.

This reframing is deliberate sequencing, not abandonment. Neither the methodology piece
nor the publish criterion was dropped for lack of effort or value — both were placed in
the phase they belong to: after the tool the author and friends actually use is shipped.

## Consequence 1 — the MOV-ELO methodology piece is cut

The bundled Slice-3 publication at `/research/elo-methodology` (Slice-3 decision #11,
snapshot-mode per ADR-0007) is not written, and no user-facing explainer replaces it.
Beyond the "what v1 is for" call above, the piece-specific rationale:

1. **The ELO is user-facing infrastructure, not a portfolio piece.** It powers the tool's
   ratings and SOS columns; it is consumed, not read about.
2. **The target audience (the friend group) already understands ELO.** A methodology
   explainer addressed to them explains something they don't need explained.
3. **The calculation is exhaustively documented** in ADR-0014 (formula, constants, chain
   init, regression, playoff/tie handling), ADR-0021 (playoff `teamWeekStats` shape), and
   ADR-0022 (tie correction, the verified-against-538 HFA-in-MOV finding, the deliberate
   tie-handling deviation). Those ADRs **stand as the methodology documentation in the
   piece's place** — the content exists; only the publication vehicle is cut.

Recorded as a dated update in ADR-0010; dangling `/research/elo-methodology` references
cleared from CLAUDE.md, README, the `elo.py` `[MOV-HFA]` comment, and ADRs
0014/0015/0020/0022.

## Consequence 2 — ship criterion #2 deferred to post-v1

ADR-0012 criterion #2 lost its planned vehicle when the piece was cut. Rather than
re-point it reactively at a replacement investigation (premature — there is no chosen
subject worth publishing yet, and ADR-0010 says the next publish lands at a *natural break
point* when real material exists) or abandon it (which would quietly lower the project's
portfolio ambition rather than re-sequence it):

- **Criterion #2 comes off the v1 ship checklist.** v1 ships against criteria 1 and 3–6.
- **It is preserved as a post-v1 intention.** The subject is chosen later, when there is
  real material worth investigating — not assigned now to keep a checkbox alive.
- **The numbering in ADR-0012 is left unchanged** so existing cross-references — notably
  "ship criterion #4" cited in ADR-0014 and ADR-0022 for the hand-verification — keep
  pointing at the right criterion.

## What this does not change, and what it tears out

- **ADR-0005 (portfolio framing) and ADR-0010 (research-in-parallel principle) stand.** The
  portfolio dimension is deferred for v1's *ship bar*, not deleted from the project.
- **The ELO methodology is fully preserved** in ADRs 0014/0021/0022 — the cut removes a
  publication, not the engineering or its documentation.
- **Deferring #2 tears out nothing that exists.** Verified 2026-06-18: there is **no MDX /
  snapshot pipeline in the codebase** — no `@next/mdx`/`next-mdx-remote`/`contentlayer`
  dependency, no `content/research/` directory, no `/research` route. ADR-0007's authoring
  pipeline is entirely on paper. So the deferral moves an **unbuilt** pipeline plus an
  **unwritten** piece to the post-v1 phase they belong in; it does not undo any shipped
  work.

## Cross-references

- ADR-0010 — v1 build sequence; carries the dated cut note for the methodology piece and
  the "research in parallel" principle this ADR narrows for the v1 ship bar.
- ADR-0012 — v1 ship criteria; criterion #2 marked deferred-to-post-v1 in place, pointing
  here for the reasoning.
- ADR-0005 — three-tier auth / portfolio framing (unchanged; the portfolio dimension is
  re-sequenced, not removed).
- ADR-0007 — investigation authoring (MDX + freshness); the on-paper pipeline now deferred
  to post-v1 with the piece.
- ADR-0014 / ADR-0021 / ADR-0022 — the ELO methodology documentation that stands in the
  cut piece's place.
