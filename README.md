# logs-axi

Agent-ergonomic, token-efficient log CLI over SigNoz, CloudWatch and future sources.
Read-only, patient-data redaction on by default, [TOON](https://toonformat.dev/) output
with next-step hints - built like [linear-axi](https://github.com/SharonFabin/linear-axi).

```
logs-axi <source> <env> <command> [flags]

logs-axi cloudwatch prod errors --since 1h
logs-axi signoz dev search "payer lookup" --service case --level warn
logs-axi cloudwatch dev trace 29e2495e-47e4-4c27-86af-8be5ef7c1f7f
```

```
range: last 1h
date: 2026-11-16
scanned: 48
groups[3]{count,service,first,last,template,sample}:
  13,ehr-service,"14:01:03","14:14:32","resident match failed: Resident [name] not found in roster",8b441761f73c78f742d40a3a454503f4
  10,pharmacy-service,"14:00:45","14:12:58","order sync failed: Prescriber [name] rejected order <n>",c5e42acaa9c97db9247dc94a257dca67
  9,case-service,"14:00:12","14:14:10","payer lookup failed: upstream <n> after <n>ms",d50bd85bb2d7b2cd5cad44c6d624a749
help[2]:
  Run `logs-axi signoz dev trace 8b441761f73c78f742d40a3a454503f4` to see one occurrence in context
  Run `logs-axi signoz dev search --service ehr-service --level error --text "<words from a template>"` for the raw lines
```

## Install and configure

```bash
npm install -g github:SharonFabin/logs-axi
mkdir -p ~/.config/logs-axi && cp "$(npm root -g)/logs-axi/config.example.json" ~/.config/logs-axi/config.json
logs-axi            # shows what is configured
```

The config (`$LOGS_AXI_CONFIG`, else `~/.config/logs-axi/config.json`) maps
`sources.<source>.<env>` to that source's settings. The example ships the Point360
values: CloudWatch log groups `/point360/dev` and `/point360/prod` in us-east-1 through
the `Point360-Admin` profile, and SigNoz on the local end of each environment's SSM
port-forward. No secrets live in it:

| source | settings | credentials |
|---|---|---|
| `cloudwatch` | `region`, `logGroups[]`, `profile` | the AWS profile (`aws sso login --profile ...`) |
| `signoz` | `endpoint`, `apiKeyEnv` (or `apiKey`) | a viewer API key in the env var `apiKeyEnv` names, default `SIGNOZ_API_KEY` |

SigNoz has no public port: run `terraform output -raw signoz_ui_command` in
`infra/aws/environments/<env>` of the monorepo to forward it (dev on 3301, prod on 3302
in the example).

## Commands

| command | what | defaults |
|---|---|---|
| `tail` | latest lines, oldest first | `--since 15m --limit 50` |
| `search [text]` | case-insensitive text, `--level`, `--service`, time range | `15m`, `50` |
| `errors` | error lines grouped by normalized message template: count, first/last seen, one id to follow | `15m`, 20 groups from up to 1000 lines |
| `trace <id>` | every line carrying one trace/request/case/run id, across services | `24h`, `200` |
| `services` | line, error and warning counts per service | `1h` |
| `fields` | field names in a 200-line sample, how often seen, examples | `1h` |

Flags: `--since 30s|15m|1h|2d|1w`, `--from/--until <ISO>`, `--service <name>` (`case`
also matches `case-service`), `--level <lvl>` (that level and above), `--limit <n>`,
`--full` (messages over 200 chars and values over 80 are cut with `…[+N]` otherwise),
`--json`, `--unredacted`. `logs-axi <source> <env>` alone runs `errors`.

Exit codes: 0 success (empty results included), 1 error, 2 usage error. Errors print to
stdout as `error:` plus help lines that say how to fix them.

## Redaction

On by default (`src/lib/redact.ts`):

- **Fields** that hold patient data are dropped at any depth: names (`residentName`,
  `prescriber`, `firstName`, ...), DOB, SSN/MRN, phone, email, address, member/policy/Rx
  numbers, NPI, drugs, diagnoses, allergies, room/bed. Ids (`caseId`, `residentId`,
  uuids), counts and service names stay. The output says how many fields were dropped.
- **Free text** (the message and every remaining string) is masked: emails, phones, SSNs,
  DOBs, MRNs, member/Rx numbers, rooms, titled names (`Dr [name]`), labelled names
  (`resident: [name]`), `Last, First`, and runs of capitalized words that are not common
  log vocabulary.
- `errors` shows templates computed after masking, never raw payloads.

`--unredacted` turns this off and puts a warning first in the output. It is never the
default. The heuristics err toward over-masking; an all-lowercase name in prose is the
known gap.

## Bench

`npm run bench` compares output tokens for the same queries: the raw API response (what
an SDK call, curl or the SigNoz MCP returns) against logs-axi's output. Offline, on a
synthetic 2000-line corpus through recorded-shape stubs; tokens via o200k_base as a
stand-in for Claude's tokenizer.

| query | source | raw API tokens | logs-axi tokens | smaller by |
|---|---|---:|---:|---:|
| tail (50 lines) | cloudwatch | 13,003 | 5,137 | 2.5x |
| tail (50 lines) | signoz | 13,840 | 6,250 | 2.2x |
| search text+level | cloudwatch | 10,841 | 3,142 | 3.5x |
| search text+level | signoz | 11,683 | 4,271 | 2.7x |
| errors (grouped) | cloudwatch | 96,064 | 473 | 203.1x |
| errors (grouped) | signoz | 104,078 | 451 | 230.8x |
| trace one id | cloudwatch | 307 | 98 | 3.1x |
| trace one id | signoz | 302 | 98 | 3.1x |
| services | cloudwatch | 339 | 107 | 3.2x |
| services | signoz | 181 | 107 | 1.7x |
| fields | cloudwatch | 51,468 | 600 | 85.8x |
| fields | signoz | 54,988 | 600 | 91.6x |
| **total** | | **357,094** | **21,334** | **16.7x** |

## Adding a source

Write `src/sources/<name>.ts` exporting a `SourceFactory` (`src/core/types.ts`): validate
its env config, implement `query(LogQuery)` and `serviceCounts(range)`, normalize rows
with `parseLine`. Register it with one line in `src/sources/index.ts`. Every command,
redaction, templating and output format then works for it unchanged.

## Development

```bash
npm install
npm test          # vitest; synthetic fixtures only, no network
npm run typecheck
npm run bench
npm run dev -- cloudwatch dev errors
```

Agents: see `skills/logs-axi/SKILL.md`.
