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
npm install -g logs-axi   # the config copy below reads the example from this global install
config_file="${LOGS_AXI_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/logs-axi/config.json}"
mkdir -p "$(dirname "$config_file")" && cp "$(npm root -g)/logs-axi/config.example.json" "$config_file"
logs-axi signoz login   # SigNoz viewer key: hidden prompt, stored per user
logs-axi                # shows what is configured
```

To run without a global install, use `npx -y logs-axi ...`; copy `config.example.json`
from this repository instead of `$(npm root -g)`.

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

Find your deployment's actual profiles, log groups, endpoints and viewer-key
parameter names in your organization's private infrastructure code.

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

The SigNoz adapter uses the read-only v5 `query_range` API. After configuring the
endpoint and viewer key, run `logs-axi signoz dev services` to check access.

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

SigNoz uses the resource's `service.name` for labels, filters, and counts. Empty
and missing names appear as `-` and match `--service -`. Severity comes from the
native `severity_number` when it is an integer from 1 to 24 and falls back to
`severity_text` otherwise. OpenTelemetry TRACE maps to `debug`.

SigNoz uses the string body as the message, including JSON text. Non-string bodies
produce an empty message. Error templates use that message, and `fields` samples
log attributes.

CloudWatch `trace` matches the ID as a substring of the raw log line. SigNoz matches
exact values in the string attributes `traceId`, `trace_id`, `requestId`,
`correlationId`, `caseId` and `runId`. It also searches native `trace_id` for
nonzero 32-digit hexadecimal IDs. Both sources match 32-digit hexadecimal IDs
case-insensitively. Other IDs are case-sensitive. To find an ID in a SigNoz log
message, use `logs-axi signoz <env> search <id>`.

SigNoz applies filters on the server before limiting results. CloudWatch can
inspect up to 10,000 candidate rows and reports `partial: true` if it hits that
cap before filling the requested result. On both sources, `services` counts up
to 10,000 normalized rows and reports `partial: true` when that sample fills.
The accompanying warning marks counts as lower bounds. The `errors` command
also warns when its 1000-line sample fills. Narrow `--since` to improve coverage.
Redacted search hints use a placeholder for the search text.

Exit codes: 0 success (empty results included), 1 error, 2 usage error. Errors print to
stdout as `error:` plus help lines that say how to fix them. SigNoz query failures
may include a provider error identifier or a numeric ClickHouse error code.

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
  are not common log vocabulary. Operational ID scalar values are preserved;
  objects and arrays under those keys are still recursively redacted. JSON objects
  and arrays embedded in messages and string values are recursively redacted.
  Incomplete JSON fragments are masked conservatively, including descendants of
  protected containers.
- With redaction enabled, `errors` shows templates computed after masking, never raw payloads.

`--unredacted` turns this off and puts a warning first in the output. It is never the
default. The heuristics err toward over-masking; an all-lowercase name in prose is the
known gap.

## Bench

`npm run bench` prints per-command token counts and totals for raw API responses
and logs-axi output. It runs offline with synthetic logs and stub transports and
uses o200k_base as a stand-in for Claude's tokenizer.

## Adding a source

Write `src/sources/<name>.ts` exporting a `SourceFactory` (`src/core/types.ts`): validate
its env config, implement `query(LogQuery)` and `serviceCounts(range)`, and normalize
provider rows to `LogRecord`. Register it with one line in `src/sources/index.ts`. Every
command, redaction, templating and output format then works for it unchanged.

## Development

```bash
npm install
npm test          # vitest; synthetic fixtures only, no network
npm run typecheck
npm run bench
npm run dev -- cloudwatch dev errors
```

Agents: see `skills/logs-axi/SKILL.md`. Contributing: see [CONTRIBUTING.md](CONTRIBUTING.md).

## Releasing

release-please opens a release PR from conventional commits; merging it tags the release
and the workflow publishes the package with `npm publish` (OIDC trusted publishing,
provenance, no npm token). Merging the release PR is the approval: there is no separate
2FA step on npmjs.com.

If the release SHA check fails, confirm the version is absent from npm. Delete the
GitHub release and its tag, replace `autorelease: tagged` with `autorelease: pending`
on the merged release PR, and re-run the workflow for the release commit.

## License

MIT, see [LICENSE](LICENSE).
