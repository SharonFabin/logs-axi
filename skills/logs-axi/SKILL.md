---
name: logs-axi
description: Read application logs from CloudWatch and SigNoz (dev or prod) with token-efficient TOON output - grouped errors, tail, search, one trace across services, services and fields discovery. Read-only, patient data redacted by default. Use for any "what is erroring / what happened to this request" log question run via CLI.
user-invocable: false
metadata:
  hermes:
    tags: [logs, observability, cloudwatch, signoz, debugging, incidents]
    category: devops
---

# logs-axi

An agent-ergonomic CLI over log sources. One shape for every source:

```
logs-axi <source> <env> <command> [flags]
logs-axi signoz dev errors --since 1h --service case
```

Sources: `cloudwatch`, `signoz`. Environments (`dev`, `prod`) come from
`~/.config/logs-axi/config.json` (see `config.example.json` in the package). Output is
[TOON](https://toonformat.dev/): rows are `a,b,c` under a `name[N]{cols}:` header,
followed by `help[N]:` lines with the next commands to run.

## Setup

- Install: `npm install -g github:SharonFabin/logs-axi`.
- Config: copy `config.example.json` to `~/.config/logs-axi/config.json` (or set `LOGS_AXI_CONFIG`).
- CloudWatch uses the AWS profile in the config; if it errors on credentials, run
  `aws sso login --profile Point360-Admin`.
- SigNoz is reached through an SSM port-forward (`terraform output -raw signoz_ui_command`
  in `infra/aws/environments/<env>`) and needs a viewer key in the env var the config
  names (`SIGNOZ_API_KEY_DEV`, `SIGNOZ_API_KEY_PROD`).
- Run `logs-axi` with no arguments to see what is configured.

## Workflow

1. Start with grouped errors - the cheapest overview (counts per message template,
   first/last seen, one id to follow):
   ```
   logs-axi cloudwatch prod errors --since 1h
   ```
2. Follow one occurrence across services with the `sample` id it printed:
   ```
   logs-axi cloudwatch prod trace <id>
   ```
3. Narrow with search or tail:
   ```
   logs-axi signoz dev search "payer lookup" --service case --level warn --since 2h
   logs-axi signoz dev tail --service pharmacy
   ```
4. Discover: `services` (who is logging, error/warn counts) and `fields` (which fields
   lines carry, with examples) before guessing names.

## Commands

```
tail                 latest lines, oldest first            default --since 15m --limit 50
search [text]        text (case-insensitive) / --level / --service   15m, 50
errors               error lines grouped by template        15m, --limit = groups (20)
trace <id>           every line with that trace/request/case/run id   24h, 200
services             line, error and warning counts per service       1h
fields               field names, how often seen, examples (sampled)  1h
```

Flags: `--since 15m|1h|2d` or `--from/--until <ISO>`, `--service <name>` (`case` and
`case-service` both match), `--level debug|info|warn|error|fatal` (that level and above),
`--limit <n>`, `--full` (do not cut long values), `--json`.

## Tips

- `logs-axi <source> <env>` with no command runs `errors`.
- Messages over 200 chars and field values over 80 are cut with `…[+N]`; add `--full`.
- `errors` scans the newest 1000 matching lines; when it says counts are lower bounds,
  narrow `--since` or add `--service`.
- CloudWatch `trace <id>` matches the id anywhere in the line (request, case, run ids).
  SigNoz `trace` matches a 32-hex trace id, otherwise the requestId/correlationId/caseId/runId attributes.
- Exit codes: 0 success (including empty results), 1 error, 2 usage error. Errors print
  to stdout as `error:` with fix-it help lines.

## Patient data

Redaction is ON by default: patient-data fields (names, DOB, contact details, insurance
numbers, drugs, room/bed) are dropped and name-like or identifier-like text is masked
as `[name]`, `[phone]`, `[dob]`, etc. Ids (case, resident, org uuids) and service names
stay. `--unredacted` turns it off and prints a warning: do not use it unless the human
explicitly asks, and never copy its output into tickets, chats, commits or prompts.
