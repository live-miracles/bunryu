---
name: write-fail-report
description: Write or update an incident write-up in fail-reports/ and make sure no secrets, destination URLs or customer IPs reach the public repo. Use when the user asks for a fail report / incident report / post-mortem, or after an investigation whose findings should be kept. Also use its redaction checklist before committing any log excerpt.
---

# Write a fail report

`fail-reports/` is committed to a **public** GitHub repo. Real logs are full of
things that must not be published, so redact first and verify before staging.

## File

`fail-reports/YYYY-MM-DD-short-kebab-title.md` (date of the incident). Look at
the newest report for tone; match it. Keep it factual and as short as the
incident allows.

## Structure

```markdown
# Incident: <one-line symptom and cause, plain words>

- **Date:** YYYY-MM-DD (times below are IST, UTC+05:30)
- **Component:** <ingest / output ffmpeg / relay / dashboard / host ...>
- **Trigger:** <what started it>
- **Impact:** <who/what was affected, for how long; what was NOT affected>

## Summary
## Timeline
| Time (IST) | Event |  (host-local times; say so if you mix in UTC)
## Evidence
<short, redacted excerpts: journal lines, diagnostics events, counts; name the
source (unit, file, query) so it can be re-run>
## Root cause chain / Why the input (or output) is the source
## Findings and follow-ups
<numbered; mark each done / open; what is outside this repo>
## Status
<what is implemented, what is verified, what remains open>
```

Rules for the content:

- Separate **facts** (seen in logs/DB/code) from **inferences** and **unknowns**.
  Say what you could not verify (e.g. viewer-visible impact on the platform).
- State the deployed version the evidence came from; the VM often lags `master`.
- Link the fix by commit or file path, and add tests/guards it introduced.
- Update the docs (`docs/`, usually `docs/3-operations/4-reliability.md` or
  `5-known-issues.md`) / `AGENTS.md` when the incident changes documented behaviour.

## Redaction (required)

Replace, keeping the useful non-secret part:

| Found in logs | Write |
|---|---|
| Stream key `key01_abc...` | `key01_<redacted>` |
| SRT passphrase, `passphrase=...` | `<redacted-srt-passphrase>` |
| Destination RTMP/SRT URL with a key (`rtmp://a.rtmp.youtube.com/live2/<key>`) | bare hostname only, e.g. `a.rtmp.youtube.com` |
| Encoder / customer / viewer IPs, `ip:port` | `<redacted-ip>` |
| Cookies, tokens, `Authorization`, dashboard password, cloudflared token | omit |

Before staging, scan the new file and the diff:

```bash
f=fail-reports/<file>.md
grep -nE 'rtmps?://|srt://|passphrase|streamid|stream_key|key[0-9]+_|token|password|Authorization' "$f"
grep -nE '([0-9]{1,3}\.){3}[0-9]{1,3}|[0-9a-f]{0,4}(:[0-9a-f]{0,4}){3,}' "$f"   # IPv4 / IPv6
```

Each hit must be a deliberate, redacted placeholder (hostnames of destinations
and `10.x` internal VM addresses are fine; encoder/customer addresses are not).
Excerpts pasted from journald or diagnostics are the usual leak - re-read them
line by line.

If a real secret was committed or pushed anyway, treat it as compromised:
rotate it, and don't rely on rewriting history.

## Then

Run `npm run format:check` (Markdown is formatted by Prettier) and show the user
the report before committing. See `AGENTS.md` for the pre-commit checks.
