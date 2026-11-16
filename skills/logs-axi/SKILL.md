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
the config file (see [config locations](../../README.md#install-and-configure) and
`config.example.json` in the package). Output is
[TOON](https://toonformat.dev/): rows are `a,b,c` under a `name[N]{cols}:` header,
followed by `help[N]:` lines with the next commands to run.

## Setup

- Install: `npm install -g github:SharonFabin/logs-axi`.
- Config: follow [Install and configure](../../README.md#install-and-configure) for file locations and setup.
- CloudWatch uses the AWS profile in the config; if it errors on credentials, run
  `aws sso login --profile Point360-Admin`.
- SigNoz is reached through an SSM port-forward (`terraform output -raw signoz_ui_command`
  in `infra/aws/environments/<env>`) and needs a viewer API key: `$LOGS_AXI_SIGNOZ_KEY`,
  else the per-user credentials file. If a command says `no SigNoz API key`, ask the human
  to run `logs-axi signoz login` (or `logs-axi signoz login --env prod`) themselves: it
  prompts with hidden input. Never ask for the key in chat, never pass it as an argument,
  and never print or read the credentials file.
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

See the [command and flag reference](../../README.md#commands) for commands, defaults,
matching rules and sampling limits. Run `logs-axi <source> <env> <command> --help`
for its supported flags.

## Tips

- `logs-axi <source> <env>` with no command runs `errors`.
- Messages over 200 chars and field values over 80 are cut with `…[+N]`; add `--full`.
- When `errors` says counts are lower bounds, narrow `--since` or add `--service`;
  see [query and sampling limits](../../README.md#commands).
- Trace matching differs by source; see [trace matching](../../README.md#commands).
- Exit codes: 0 success (including empty results), 1 error, 2 usage error. Errors print
  to stdout as `error:` with fix-it help lines.

## Patient data

Redaction is ON by default: patient-data fields (names, DOB, contact details, insurance
numbers, drugs, room/bed) are dropped and name-like or identifier-like text is masked
as `[name]`, `[phone]`, `[dob]`, etc. Ids (case, resident, org uuids) and service names
stay. `--unredacted` turns it off and prints a warning: do not use it unless the human
explicitly asks, and never copy its output into tickets, chats, commits or prompts.
