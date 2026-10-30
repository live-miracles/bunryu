# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root (single-context repo).
- **`docs/adr/`**: short records of decisions that are hard to reverse, surprising without context and the result of a real trade-off, including refactors that were considered and rejected. Read the ones that touch the area you're about to work in.
- **`docs/4-reference/3-design-decisions.md`**: the longer, evidence-heavy record of why SRS, FFmpeg and Goryu are used as they are, what was tried and rejected, the measurements and when to revisit. A decision that is mostly evidence goes here; one that is mostly a rule or a boundary goes in an ADR. Say each thing once and link to the other.

Add a term to `GLOSSARY.md` when one is resolved, with the `/domain-modeling` skill's format (`_Avoid_` lists the synonyms to drop).

## File structure

```
/
├── GLOSSARY.md
├── docs/
│   ├── adr/                                 ← short decision records
│   ├── agents/                              ← these files
│   └── 4-reference/3-design-decisions.md    ← decisions with their evidence
└── src/
```

`docs/` is published documentation checked by CI: every page must be linked from `docs/README.md`, so a new page under `docs/adr/` or `docs/agents/` needs its line there too.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag decision conflicts

If your output contradicts an ADR or an entry in `docs/4-reference/3-design-decisions.md`, surface it explicitly rather than silently overriding:

> _Contradicts the "One FFmpeg process per output" decision, but worth reopening because…_
