# Bunryu documentation

## Getting started

- [Introduction](1-getting-started/1-introduction.md): what it is, how it works, capacity and limits
- [Docker](1-getting-started/2-docker.md): try it in a container
- [Native install](1-getting-started/3-install.md): production install with systemd, firewall ports, SRT passphrase
- [Sizing a server](1-getting-started/4-sizing.md): measured CPU and RAM costs and example GCP machine sizes

## Usage

- [Publishing to a pipeline](2-usage/1-publishing.md): publish URLs and encoder settings
- [Outputs](2-usage/2-outputs.md): destinations, video encodings, audio tracks and shared encodes
- [Translation outputs](2-usage/3-translation.md) (beta): mixing interpreter audio over the source

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
