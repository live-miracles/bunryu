# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root (single-context repo).
- **`docs/4-reference/3-design-decisions.md`**: this repo records its decisions here (why SRS, FFmpeg and Goryu are used as they are, what was rejected, the evidence, when to revisit) instead of a `docs/adr/` folder. Read the entries that touch the area you're about to work in. Add new decisions there, not in a separate ADR folder.

If `GLOSSARY.md` doesn't exist, **proceed silently**. Don't flag its absence; don't suggest creating it upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates it lazily when terms actually get resolved.

## File structure

```
/
├── GLOSSARY.md
├── docs/4-reference/3-design-decisions.md   ← decisions (the ADR equivalent)
└── src/
```

`docs/` is published documentation checked by CI: every page must be linked from `docs/README.md`, and it is written for users and developers only. Keep agent configuration out of it; it lives in `agent-docs/`.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag decision conflicts

If your output contradicts an entry in `docs/4-reference/3-design-decisions.md`, surface it explicitly rather than silently overriding:

> _Contradicts the "One FFmpeg process per output" decision, but worth reopening because…_
