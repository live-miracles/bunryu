# Bunryu documentation

## Getting started

- [Introduction](1-getting-started/1-introduction.md): what it is, how it works, capacity and limits
- [Docker](1-getting-started/2-docker.md): try it in a container
- [Native install](1-getting-started/3-install.md): production install with systemd, firewall ports, SRT passphrase
- [Sizing a server](1-getting-started/4-sizing.md): measured CPU and RAM costs and example GCP machine sizes
- [Comparison with alternatives](1-getting-started/5-comparison.md): how Bunryu differs from Restreamer, SRS and MediaMTX, and when not to use it

## Usage

- [Publishing to a pipeline](2-usage/1-publishing.md): publish URLs and encoder settings
- [Outputs](2-usage/2-outputs.md): destinations, video encodings, audio tracks and shared encodes

## Operations

- [Security](3-operations/1-security.md): authentication, hardening, ingest protection
- [Remote access](3-operations/2-remote-access.md): Cloudflare Tunnel for the dashboard
- [Configuration](3-operations/3-configuration.md): `bunryu.json`, diagnostics, environment overrides
- [Reliability](3-operations/4-reliability.md): watchdogs and how failures are detected and recovered
- [Known issues](3-operations/5-known-issues.md)

## Reference

- [REST API](4-reference/1-api.md)
- [Development](4-reference/2-development.md)
- [Design decisions](4-reference/3-design-decisions.md): why Bunryu uses SRS, FFmpeg per output and Goryu the way it does, and what was tried and rejected

## Decision records

Short records of decisions that are hard to reverse and surprising without context, including refactors that were considered and rejected. The longer ones, with their measurements, are in [Design decisions](4-reference/3-design-decisions.md).

- [0001 Output FFmpeg management favours robustness over performance](adr/0001-robustness-before-performance-in-output-management.md)
- [0002 An output is retired in one call before its row is deleted](adr/0002-retire-an-output-in-one-call.md)
- [0003 No database migrations and no legacy-format tolerance](adr/0003-no-migrations-and-no-legacy-tolerance.md)
- [0004 The FFmpeg warning and progress monitor stays inside `outputs.ts`](adr/0004-warning-monitor-stays-in-outputs.md)
- [0005 `inputState` stays separate from the health poll](adr/0005-input-state-stays-separate-from-the-health-poll.md)

## For coding agents

How the engineering skills and coding agents work in this repository.

- [Domain docs](agents/domain.md): the glossary, decision records and how to use them
- [Issue tracker](agents/issue-tracker.md): GitHub Issues conventions
- [Triage labels](agents/triage-labels.md): the label vocabulary
