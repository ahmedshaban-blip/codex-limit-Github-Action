// scheduler.js — runs Codex CLI once; if usage-limited, waits for the reset and runs once more.
// Requirements: Node.js 20+
// Configure CODEX_PATH and CODEX_PROJECT below, or set environment variables.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

const CONFIG = {
  codexPath:
    process.env.CODEX_PATH ||
    String.raw`C:\Users\USERNAME\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe`,
  projectPath: process.env.CODEX_PROJECT || String.raw`H:\codex limit`,
  model: "gpt-6-luna",
  reasoningEffort: "low",
  prompt: "are you ready? answer with yes or no.",
  timezone: "Africa/Cairo", // Must match the timezone used by the CLI's reset message.
  timeoutMs: 30 * 60 * 1000,
  outputDir: path.join(__dirname, "codex-results"),
};

const STATE_FILE = path.join(CONFIG.outputDir, "state.json");
let running = false;
let state = {
  rateLimited: false,
  pausedUntil: null,
  resetUnknown: false,
  lastRun: null,
};

function codexCommand() {
  const location = path.resolve(CONFIG.codexPath);
  if (!fs.existsSync(location)) {
    throw new Error(
      `Codex path does not exist: ${location}\nSet CODEX_PATH to your actual Codex path.`,
    );
  }

  const ext = path.extname(location).toLowerCase();
  const npmShim =
    process.platform === "win32" &&
    path.basename(location).toLowerCase() === "codex";
  if ([".cmd", ".bat", ".ps1"].includes(ext) || npmShim) {
    // Avoid Windows cmd.exe entirely: launch npm's JS entry point via Node.
    const entry = path.join(
      path.dirname(location),
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    );
    if (!fs.existsSync(entry)) {
      throw new Error(
        `Found ${location}, but not ${entry}.\n` +
          "Set CODEX_PATH to the installed @openai/codex/bin/codex.js or native codex.exe instead.",
      );
    }
    return { executable: process.execPath, prefixArgs: [entry] };
  }
  if (ext === ".js" || ext === ".mjs") {
    return { executable: process.execPath, prefixArgs: [location] };
  }
  return { executable: location, prefixArgs: [] }; // Native codex.exe or Unix binary.
}

async function saveState() {
  await fsp.mkdir(CONFIG.outputDir, { recursive: true });
  const temp = `${STATE_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(state, null, 2), "utf8");
  await fsp.rename(temp, STATE_FILE);
}

async function loadState() {
  try {
    state = { ...state, ...JSON.parse(await fsp.readFile(STATE_FILE, "utf8")) };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function formatReset(epoch) {
  return (
    new Intl.DateTimeFormat("en-US", {
      timeZone: CONFIG.timezone,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(epoch)) + ` (${CONFIG.timezone})`
  );
}

// Find the next occurrence of HH:mm in the specified IANA timezone.
// Searching real UTC minutes handles midnight rollover and daylight-saving changes.
function nextWallClockTime(hour, minute, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const first = Math.floor(Date.now() / 60_000) * 60_000 + 60_000;
  for (let i = 0; i < 48 * 60; i++) {
    const candidate = first + i * 60_000;
    const parts = Object.fromEntries(
      fmt.formatToParts(candidate).map(({ type, value }) => [type, value]),
    );
    if (Number(parts.hour) === hour && Number(parts.minute) === minute)
      return candidate;
  }
  return null;
}

function parseResetTime(text) {
  // Prefer an explicit timestamp if Codex emits one in JSONL.
  const explicit = [
    ...text.matchAll(
      /"(?:resetsAt|resets_at|resetAt|reset_at)"\s*:\s*(?:"([^"]+)"|(\d{10,13}))/gi,
    ),
  ];
  for (const found of explicit) {
    const raw = found[1] ?? found[2];
    const stamp = /^\d{10,13}$/.test(raw)
      ? Number(raw) * (raw.length === 10 ? 1000 : 1)
      : Date.parse(raw);
    if (Number.isFinite(stamp) && stamp > Date.now()) return stamp;
  }

  // Example: "try again at 6:18 AM" (date/timezone not included).
  const clock = text.match(/try again at\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!clock) return null;
  const hour12 = Number(clock[1]);
  const minute = Number(clock[2]);
  if (hour12 < 1 || hour12 > 12 || minute < 0 || minute > 59) return null;
  const hour = (hour12 % 12) + (clock[3].toUpperCase() === "PM" ? 12 : 0);
  return nextWallClockTime(hour, minute, CONFIG.timezone);
}

function isUsageLimited(text) {
  return /you[’']?ve hit your usage limit|usage limit reached|rate.?limit.exceeded|rate limit exceeded|too many requests|quota exceeded|out of credits/i.test(
    text,
  );
}

async function notify(message) {
  console.log(`[NOTICE] ${message}`);
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: message }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) console.error(`Telegram error: HTTP ${response.status}`);
  } catch (error) {
    console.error("Telegram notification failed:", error.message);
  }
}

function keepTail(oldText, chunk, maxLength = 256_000) {
  const combined = oldText + chunk.toString("utf8");
  return combined.length > maxLength ? combined.slice(-maxLength) : combined;
}

async function runCodex({ force = false } = {}) {
  if (running) {
    console.log("Previous run is still active. Skipping overlap.");
    return "skipped";
  }
  if (
    !force &&
    state.pausedUntil &&
    Date.now() < Date.parse(state.pausedUntil)
  ) {
    console.log(
      `Usage-limited until ${formatReset(Date.parse(state.pausedUntil))}. Skipping.`,
    );
    return "skipped";
  }

  running = true;
  const startedAt = new Date().toISOString();
  const runId = `${startedAt.replace(/[:.]/g, "-")}-${process.pid}`;
  const dir = path.join(CONFIG.outputDir, runId);

  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, "prompt.txt"), CONFIG.prompt, "utf8");
    const replyFile = path.join(dir, "reply.md");
    const stdoutFile = path.join(dir, "events.jsonl");
    const stderrFile = path.join(dir, "stderr.log");

    const { executable, prefixArgs } = codexCommand();
    const args = [
      ...prefixArgs,
      "exec",
      "--skip-git-repo-check",
      "--json",
      "--sandbox",
      "read-only",
      "-m",
      CONFIG.model,
      "-c",
      `model_reasoning_effort=${CONFIG.reasoningEffort}`,
      "--output-last-message",
      replyFile,
      "-", // Read the prompt from stdin to avoid command-line quoting issues.
    ];

    console.log(
      `[${startedAt}] Starting Codex: ${CONFIG.model} (${CONFIG.reasoningEffort})`,
    );
    const eventsStream = fs.createWriteStream(stdoutFile);
    const errorStream = fs.createWriteStream(stderrFile);
    let stdoutTail = "";
    let stderrTail = "";
    let spawnError = null;
    let timedOut = false;

    const result = await new Promise((resolve) => {
      let child;
      try {
        child = spawn(executable, args, {
          cwd: CONFIG.projectPath,
          shell: false, // Important: never need cmd.exe.
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          env: process.env,
        });
      } catch (error) {
        spawnError = error;
        resolve({ code: null, signal: null });
        return;
      }

      child.stdout.on("data", (chunk) => {
        eventsStream.write(chunk);
        stdoutTail = keepTail(stdoutTail, chunk);
      });
      child.stderr.on("data", (chunk) => {
        errorStream.write(chunk);
        stderrTail = keepTail(stderrTail, chunk);
      });
      child.stdin.on("error", () => {}); // Child may exit before consuming the prompt.
      child.stdin.end(CONFIG.prompt);

      child.on("error", (error) => {
        spawnError = error;
      });
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null)
            child.kill("SIGKILL");
        }, 5000).unref();
      }, CONFIG.timeoutMs);
      child.on("close", (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    });

    await Promise.all([
      new Promise((resolve) => eventsStream.end(resolve)),
      new Promise((resolve) => errorStream.end(resolve)),
    ]);

    if (spawnError) stderrTail += `\n${spawnError.message}`;
    const combined = stdoutTail + "\n" + stderrTail;
    const limited = isUsageLimited(combined);
    let status = "success";
    let resetAt = null;

    if (limited) {
      status = "rate_limited";
      resetAt = parseResetTime(combined);
      const previousReset = state.pausedUntil;
      const wasLimited = state.rateLimited;
      state.rateLimited = true;
      state.resetUnknown = !resetAt;
      state.pausedUntil = resetAt ? new Date(resetAt).toISOString() : null;
      if (!wasLimited || previousReset !== state.pausedUntil) {
        await notify(
          resetAt
            ? `Codex usage limit reached. Expected reset: ${formatReset(resetAt)}. The job will retry at that exact reset time.`
            : "Codex usage limit reached, but no reliable reset time was provided. The job will retry once a reset time is detected.",
        );
      }
    } else if (timedOut) {
      status = "timeout";
    } else if (spawnError || result.code !== 0) {
      status = "failed";
    } else {
      if (state.rateLimited) {
        await notify(
          "Codex is available again: the scheduled execution succeeded.",
        );
      }
      state.rateLimited = false;
      state.resetUnknown = false;
      state.pausedUntil = null;
    }

    // Codex only creates the last-message file if it produced a final response.
    const reply = await fsp.readFile(replyFile, "utf8").catch(() => "");
    if (!reply)
      await fsp.writeFile(replyFile, "(No final Codex reply was produced.)\n");

    const summary = {
      id: runId,
      status,
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: result.code,
      signal: result.signal,
      error: spawnError?.message || null,
      resetAt: resetAt ? new Date(resetAt).toISOString() : null,
      project: CONFIG.projectPath,
      model: CONFIG.model,
      reasoningEffort: CONFIG.reasoningEffort,
      prompt: CONFIG.prompt,
      replyFile,
    };
    await fsp.writeFile(
      path.join(dir, "result.json"),
      JSON.stringify(summary, null, 2),
    );
    state.lastRun = { id: runId, status, finishedAt: summary.finishedAt };
    await saveState();
    console.log(`Codex finished: ${status}. Results: ${dir}`);
    return status;
  } catch (error) {
    console.error("Scheduler failed:", error);
    state.lastRun = {
      id: runId,
      status: "scheduler_error",
      finishedAt: new Date().toISOString(),
    };
    await saveState();
    await notify(`Codex scheduler failed: ${error.message}`);
    return "scheduler_error";
  } finally {
    running = false;
  }
}

async function main() {
  await fsp.mkdir(CONFIG.outputDir, { recursive: true });
  await loadState();

  if (process.argv.includes("--status")) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  if (!fs.existsSync(CONFIG.projectPath)) {
    throw new Error(`Project directory does not exist: ${CONFIG.projectPath}`);
  }
  codexCommand(); // Fail at startup if the configured launcher cannot be resolved.

  // Probe run. If it hits the limit with a known reset time, sleep until one
  // minute after that exact reset timestamp, run once more, then exit.
  let status = await runCodex({ force: process.argv.includes("--force") });
  if (status === "rate_limited" && state.pausedUntil) {
    const wakeAt = Date.parse(state.pausedUntil) + 60_000;
    console.log(
      `Usage limit resets at ${formatReset(Date.parse(state.pausedUntil))}. Retrying at the exact reset time: ${formatReset(wakeAt)}.`,
    );
    notify(
      `Codex usage limit reached. Expected reset: ${formatReset(
        Date.parse(state.pausedUntil),
      )}. The job will retry at that exact reset time.`,
    );
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, wakeAt - Date.now())),
    );
    status = await runCodex({ force: true });
  }

  if (!["success", "skipped"].includes(status)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
