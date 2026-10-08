# Codex Retry Scheduler

A Node.js scheduler that runs the Codex CLI, detects usage-limit warnings, reads the reset time from the Codex output, and retries at the exact reset moment.

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white" alt="Node.js 20+" />
  <img src="https://img.shields.io/badge/Env-Native%20Node%20.%20env-4B5563" alt="Native .env" />
  <img src="https://img.shields.io/badge/Retry-Exact%20reset%20time-6A5AE0" alt="Exact reset retry" />
</p>

## Overview

This project is designed for a simple automation workflow:

- launch Codex once
- detect when usage is exhausted
- parse the reset clock from Codex output
- wait until that precise time
- run again automatically

It also keeps detailed result logs in a local output folder and can notify you through Telegram when a rate limit is hit or when service availability returns.

A useful advanced idea for this workflow is a lightweight "warm-up" prompt: because Codex does not always start counting the limit window until your first prompt is sent, you can intentionally send a tiny, cheap request first to start the quota timer. Then your serious work can later make better use of the reset window with less wasted waiting time.

## Features

- Native `.env` loading via Node's built-in `--env-file` support
- Triggered retry using the actual reset timestamp, not a generic hourly loop
- Lightweight warm-up prompt strategy to start the usage window intentionally
- Safe handling of CLI spawn errors and timeouts
- Local save of prompts, raw events, stderr, replies, and summary JSON
- Telegram alerts for rate-limit and recovery events
- Works with a project directory and Codex path configured through environment variables

## Quick start

1. Create your local environment file from the example:

```bash
copy .env.example .env
```

2. Fill in your values:

```env
CODEX_PATH=C:\Users\YourUser\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe
CODEX_PROJECT=H:\codex limit
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

3. Run the scheduler:

```bash
npm start
```

Alternative direct run:

```bash
node --env-file=.env codex-scheduler.js
```

## Scripts

The project includes these npm commands:

```json
"scripts": {
  "start": "node --env-file=.env codex-scheduler.js",
  "dev": "node --env-file=.env codex-scheduler.js",
  "status": "node --env-file=.env codex-scheduler.js --status",
  "test": "echo \"Error: no test specified\" && exit 1"
}
```

## Retry behavior

When Codex says you hit the usage limit, the scheduler checks for values such as:

- an explicit reset timestamp in JSON output
- a message like `try again at 6:18 AM`

Then it waits until the calculated reset time and performs one retry. The message looks like:

```text
Usage limit resets at Oct 8, 2026, 6:18 AM (Africa/Cairo). Retrying at the exact reset time: Oct 8, 2026, 6:19 AM (Africa/Cairo).
```

### Warm-up prompt strategy

A good improvement to this flow is to prime the quota window with a very cheap request such as:

```text
are you ready? answer with yes or no.
```

This is intentionally lightweight and helps the scheduler start the limit clock at a known time, instead of letting it begin only when a larger task arrives later. The idea is simple: if you know a real task will be sent shortly after, a small warm-up can reduce the delay between the moment you become active and the moment the reset window becomes useful again.

## Why this matters

If Codex does not start counting until the first prompt, then the exact timing of that first request changes the effective reset schedule. A warm-up prompt makes that timing deliberate and predictable, which is especially useful when you want to be ready for a larger task shortly after a break or a long idle period.

## Files and output

Each run is stored under the `codex-results` folder, with a separate directory for each execution. Inside each run folder, you will find:

- `prompt.txt`
- `events.jsonl`
- `stderr.log`
- `reply.md`
- `result.json`

The scheduler also stores overall state in `codex-results/state.json`.

## Telegram notifications

If `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are present, the scheduler sends a notice when:

- the usage limit is reached
- the reset time is detected
- Codex is available again after recovery

## Requirements

- Node.js 20+
- A valid Codex executable path in `CODEX_PATH`
- A working project directory in `CODEX_PROJECT`

## Notes

- `timezone` should match the timezone described by the Codex usage-limit response for accurate scheduling.
- The script exits with a non-zero status if the process fails after retrying from a usage limit.

---

Built for reliable Codex retry scheduling with exact reset timing.
