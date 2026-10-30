# No database migrations and no legacy-format tolerance

Status: accepted

Bunryu has no migrations. A change to the schema or to a persisted format bumps `SCHEMA_VERSION`, and a database of another version is refused at startup (exit 78, which systemd does not restart) with an instruction to move `db.sqlite` aside and start fresh. The same applies in code: no fallback parsers for old data, no redirects or shims for old URLs, view names or config names. When a format changes, the old data is wiped rather than carried forward, and one-off migration scripts are deleted once they have run (the schema 2 to 3 and the restream-srs scripts were). Schema version 4 dropped the last two tolerances: a database that has tables but no version stamp is refused like one of another version, and a History record without a `kind` is no longer read as a crash.

This trades a manual wipe on upgrade for a smaller, more trustworthy codebase: every code path handles states the application can actually produce, and a database that does not match fails loudly at boot instead of misbehaving later. The cost falls on the operator, which is acceptable for a single-operator product whose live configuration is small and can be re-entered; revisit if it ever holds data that is expensive to re-create. Why exit 78 does not restart: [Failures that need an operator exit with status 78](../4-reference/3-design-decisions.md#failures-that-need-an-operator-exit-with-status-78-which-systemd-does-not-restart).

When code looks surprisingly permissive or unguarded, check `git log` for the change that removed the defence before adding it back.
