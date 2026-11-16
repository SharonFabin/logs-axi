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
  Run `logs-axi signoz dev search --service ehr-service --level error "<words from a template>"` for the raw lines
```

## Install and configure

```bash
npm install -g github:SharonFabin/logs-axi
config_file="${LOGS_AXI_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/logs-axi/config.json}"
mkdir -p "$(dirname "$config_file")" && cp "$(npm root -g)/logs-axi/config.example.json" "$config_file"
logs-axi signoz login   # SigNoz viewer key: hidden prompt, stored per user
logs-axi                # shows what is configured
```

The config (`$LOGS_AXI_CONFIG` when nonempty, else `$XDG_CONFIG_HOME/logs-axi/config.json`
when `XDG_CONFIG_HOME` is nonempty, else `~/.config/logs-axi/config.json`) maps
`sources.<source>.<env>` to that source's settings. The example ships placeholder
values to replace with your own: CloudWatch log groups `/my-app/dev` and `/my-app/prod`
in us-east-1 through the `my-profile` AWS profile, and SigNoz on `localhost` (one port
per environment). No secrets live in it:

| source | settings | credentials |
|---|---|---|
| `cloudwatch` | `region`, `logGroups[]`, `profile` | the AWS profile (`aws sso login --profile ...`) |
| `signoz` | `endpoint` | a viewer API key; see [SigNoz login](#signoz-login) |

If your SigNoz has no public endpoint, forward it to localhost first (for example with
an SSM or `kubectl` port-forward); the example uses 3301 for dev and 3302 for prod.

### SigNoz login

`logs-axi signoz login` prompts for the viewer API key with hidden input (nothing is
echoed, in Linux, macOS and Windows terminals alike) and stores it per user. It never
takes the key as an argument and never prints it. `--env prod` stores a key for one
environment only; without it the key serves every environment. Piped input works too:
`aws ssm get-parameter --profile my-profile --with-decryption --name /my-app/dev/SIGNOZ_VIEWER_KEY --query Parameter.Value --output text | logs-axi signoz login --env dev`.

| OS | credentials file |
|---|---|
| Linux, macOS | `$XDG_CONFIG_HOME/logs-axi/credentials`, else `~/.config/logs-axi/credentials` (file `0600`, directory `0700`) |
| Windows | `%APPDATA%\logs-axi\credentials` (protected by the profile's ACLs) |

SigNoz commands use `$LOGS_AXI_SIGNOZ_KEY` when nonempty, else the file's key for that
environment, else its all-environments key. With neither, they print a one-line hint to
run `logs-axi signoz login`. No OS keychain integration.

Credential updates replace the file atomically, preserving existing keys if writing
the replacement fails. If the file contains invalid JSON, login replaces it with only
the newly entered key; run login again for any other environment or default keys.

**Live status (v1):** the CloudWatch adapter is verified read-only against dev and prod.
The SigNoz adapter is untested against a live server, pending a viewer API key: its
request and response shapes follow SigNoz's v5 `query_range` contract (as used by the
official SigNoz MCP server) and are covered by recorded-shape tests only (a live dev
server answers 401 to an invalid key, as expected). To try it: make the endpoint
reachable (see above), run `logs-axi signoz login --env dev` with a viewer key, then
`logs-axi signoz dev services`.

## Commands

| command | what | defaults |
|---|---|---|
| `tail` | latest lines, oldest first | `--since 15m --limit 50` |
| `search [text]` | case-insensitive text in the raw log body, `--level`, `--service`, time range | `15m`, `50` |
| `errors` | error lines grouped by normalized message template: count, first/last seen, one id to follow | `15m`, 20 groups from up to 1000 lines |
| `trace <id>` | latest lines carrying one trace/request/correlation/case/run id, across services | `24h`, `200` |
| `services` | line, error and warning counts per service | `1h` |
| `fields` | field names in a 200-line sample, how often seen, examples | `1h` |

Flags: `--since 30s|15m|1h|2d|1w`, `--from/--until <ISO>`, `--service <name>` (`case`
also matches `case-service`), `--level <lvl>` (that level and above), `--limit <n>`,
`--full` (messages over 200 chars and values over 80 are cut with `…[+N]` otherwise),
`--json`, `--unredacted`. `logs-axi <source> <env>` alone runs `errors`.

Flags vary by command. Run `logs-axi <source> <env> <command> --help` for its
supported flags.

CloudWatch `trace` matches the ID anywhere in the raw log line. SigNoz matches
structured `traceId`, `trace_id`, `requestId`, `correlationId`, `caseId` and `runId`
values from JSON bodies or attributes, plus native `trace_id` for 32-hex IDs.
Both sources match 32-hex IDs case-insensitively; other IDs are case-sensitive,
with substring matching on CloudWatch and exact matching on SigNoz.

Queries scan at most 10,000 candidate rows, with service counts calculated from normalized rows.
When that cap prevents filling a query, or service counts reach the cap, output includes
`partial: true` and a warning that counts are lower bounds. Separately, `errors` warns
when its 1000-line sample fills. Narrow `--since` to improve coverage. Redacted search
hints use a placeholder for the search text.

Exit codes: 0 success (empty results included), 1 error, 2 usage error. Errors print to
stdout as `error:` plus help lines that say how to fix them.

## Redaction

On by default (`src/lib/redact.ts`):

- **Fields** that hold patient data are dropped at any depth: names (`residentName`,
  `prescriber`, `firstName`, ...), DOB, SSN/MRN, phone, email, address, member/policy/Rx
  numbers, NPI, drugs, diagnoses, allergies, room/bed. Ids (`caseId`, `residentId`,
  uuids), counts and service names stay. The output says how many fields were dropped.
- **Free text** (messages and non-structural field keys and string values) is masked:
  emails, phones, dashed SSNs, labelled nine-digit SSNs or social-security numbers,
  DOBs, MRNs, member/Rx numbers, rooms, titled names (`Dr [name]`),
  labelled names (`resident: [name]`), `Last, First`, and runs of capitalized words that
  are not common log vocabulary. Structural string fields such as service names and trace/request IDs
  are preserved. JSON objects and arrays embedded in messages and non-structural
  string values are recursively redacted.
- With redaction enabled, `errors` shows templates computed after masking, never raw payloads.

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
