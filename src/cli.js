"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const HOME = os.homedir();
const CODEX_DIR = process.env.CODEX_SWITCHER_CODEX_DIR || path.join(HOME, ".codex");
const AUTH_PATH = process.env.CODEX_SWITCHER_AUTH_PATH || path.join(CODEX_DIR, "auth.json");
const STORE_DIR = process.env.CODEX_SWITCHER_STORE_DIR || path.join(HOME, ".codex-keyring");
const CODEX_BIN = process.env.CODEX_SWITCHER_CODEX_BIN || "codex";
const ACCOUNTS_DIR = path.join(STORE_DIR, "accounts");
const STATE_PATH = path.join(STORE_DIR, "state.json");

const QUOTA_PATTERNS = [
  /quota/i,
  /usage limit/i,
  /rate limit/i,
  /too many requests/i,
  /limit reached/i,
  /token limit/i,
  /exceeded your current usage/i,
  /insufficient_quota/i,
];

function fatal(message, code = 1) {
  console.error(`Error: ${message}`);
  process.exit(code);
}

function ensureStore() {
  fs.mkdirSync(ACCOUNTS_DIR, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(STATE_PATH)) {
    const initial = {
      version: 1,
      activeAlias: null,
      accountOrder: [],
      accounts: {},
    };
    writeJson(STATE_PATH, initial, 0o600);
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value, mode = 0o600) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", {
    mode,
  });
}

function readState() {
  ensureStore();
  return readJson(STATE_PATH);
}

function saveState(state) {
  writeJson(STATE_PATH, state, 0o600);
}

function currentAuthExists() {
  return fs.existsSync(AUTH_PATH);
}

function readCurrentAuth() {
  if (!currentAuthExists()) {
    fatal(`Missing Codex auth file at ${AUTH_PATH}`);
  }
  return readJson(AUTH_PATH);
}

function authHash(authObject) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(authObject))
    .digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function decodeJwtPayload(token) {
  if (!token || typeof token !== "string") {
    return null;
  }
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function extractEmailFromAuth(authObject) {
  const payload = decodeJwtPayload(authObject?.tokens?.id_token);
  return payload?.email || null;
}

function extractAccountId(authObject) {
  return authObject?.tokens?.account_id || authObject?.account_id || null;
}

function safeAccountId(authObject) {
  const accountId = extractAccountId(authObject) || "";
  if (!accountId) {
    return "unknown";
  }
  return `${accountId.slice(0, 8)}...`;
}

function accountSnapshotPath(alias) {
  return path.join(ACCOUNTS_DIR, `${alias}.auth.json`);
}

function ensureAlias(alias) {
  if (!alias || !/^[a-zA-Z0-9._-]+$/.test(alias)) {
    fatal("Alias must match [a-zA-Z0-9._-]+");
  }
}

function getAccount(state, alias) {
  const account = state.accounts[alias];
  if (!account) {
    fatal(`Unknown account alias: ${alias}`);
  }
  return account;
}

function identifyAliasForAuth(state, authObject) {
  const currentHash = authHash(authObject);
  const currentAccountId = extractAccountId(authObject);
  const currentEmail = extractEmailFromAuth(authObject);

  if (currentAccountId) {
    for (const alias of Object.keys(state.accounts)) {
      const account = state.accounts[alias];
      if (account.accountId && account.accountId === currentAccountId) {
        return alias;
      }
    }
  }

  if (currentEmail) {
    for (const alias of Object.keys(state.accounts)) {
      const account = state.accounts[alias];
      if (account.email && account.email === currentEmail) {
        return alias;
      }
    }
  }

  for (const alias of Object.keys(state.accounts)) {
    const account = state.accounts[alias];
    if (account.authHash === currentHash) {
      return alias;
    }
  }

  return null;
}

function refreshAccountSnapshot(state, alias, authObject, options = {}) {
  const account = getAccount(state, alias);
  account.authMode = authObject.auth_mode || account.authMode || "unknown";
  account.email = extractEmailFromAuth(authObject) || account.email || null;
  account.accountId = extractAccountId(authObject) || account.accountId || null;
  account.accountIdShort = safeAccountId(authObject);
  account.authHash = authHash(authObject);
  account.lastSeenAt = nowIso();

  if (options.updateLastUsed) {
    account.lastUsedAt = nowIso();
  }

  if (account.snapshotPath) {
    copyFileStrict(AUTH_PATH, account.snapshotPath);
  }
}

function detectActiveAlias(state, authObject = null) {
  if (!currentAuthExists()) {
    return null;
  }
  return identifyAliasForAuth(state, authObject || readCurrentAuth());
}

function syncActiveAlias(state) {
  if (!currentAuthExists()) {
    state.activeAlias = null;
    saveState(state);
    return state.activeAlias;
  }

  const currentAuth = readCurrentAuth();
  const activeAlias = identifyAliasForAuth(state, currentAuth);
  state.activeAlias = activeAlias;

  if (activeAlias) {
    refreshAccountSnapshot(state, activeAlias, currentAuth);
  }

  saveState(state);
  return state.activeAlias;
}

function copyFileStrict(source, destination) {
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, 0o600);
}

function addCurrentAccount(alias, sourcePath = AUTH_PATH) {
  ensureAlias(alias);
  ensureStore();
  const state = readState();
  if (state.accounts[alias]) {
    fatal(`Alias already exists: ${alias}`);
  }
  if (!fs.existsSync(sourcePath)) {
    fatal(`Missing auth source file: ${sourcePath}`);
  }
  const authObject = readJson(sourcePath);
  const snapshotPath = accountSnapshotPath(alias);
  copyFileStrict(sourcePath, snapshotPath);

  state.accounts[alias] = {
    alias,
    authMode: authObject.auth_mode || "unknown",
    email: extractEmailFromAuth(authObject),
    accountId: extractAccountId(authObject),
    accountIdShort: safeAccountId(authObject),
    authHash: authHash(authObject),
    snapshotPath,
    status: "unknown",
    remainingTokens: null,
    resetAt: null,
    note: null,
    createdAt: nowIso(),
    lastSeenAt: nowIso(),
    lastUsedAt: null,
    lastExhaustedAt: null,
  };
  state.accountOrder.push(alias);
  state.activeAlias = detectActiveAlias(state, authObject);
  saveState(state);
  console.log(`Added account '${alias}' (${state.accounts[alias].accountIdShort})`);
}

async function addAccountWithLogin(alias, options = {}) {
  const sourcePath = options.from || AUTH_PATH;
  if (options.from) {
    fatal("--login cannot be combined with --from");
  }

  ensureAlias(alias);
  const state = readState();
  if (state.accounts[alias]) {
    fatal(`Alias already exists: ${alias}`);
  }

  await runInteractiveCommand(CODEX_BIN, ["logout"], {
    allowFailure: true,
    stepLabel: "Logging out of current Codex account",
  });

  const loginArgs = ["login"];
  if (options["device-auth"]) {
    loginArgs.push("--device-auth");
  }
  await runInteractiveCommand(CODEX_BIN, loginArgs, {
    stepLabel: "Starting Codex login flow",
  });

  addCurrentAccount(alias, sourcePath);
}

function listAccounts() {
  const state = readState();
  const activeAlias = syncActiveAlias(state);
  const aliases = state.accountOrder.filter((alias) => state.accounts[alias]);
  if (aliases.length === 0) {
    console.log("No accounts saved.");
    return;
  }

  let stateChanged = false;
  const rows = aliases.map((alias) => {
    const account = state.accounts[alias];
    if (!account.email && account.snapshotPath && fs.existsSync(account.snapshotPath)) {
      const snapshotAuth = readJson(account.snapshotPath);
      const snapshotEmail = extractEmailFromAuth(snapshotAuth);
      if (snapshotEmail) {
        account.email = snapshotEmail;
        stateChanged = true;
      }
    }
    return {
      Active: alias === activeAlias ? "*" : "",
      Alias: alias,
      Email: account.email || "unknown",
      Status: account.status || "unknown",
      Remaining:
        typeof account.remainingTokens === "number" ? String(account.remainingTokens) : "unknown",
      Reset: account.resetAt || "unknown",
      Account: account.accountIdShort || "unknown",
      "Last Used": account.lastUsedAt || "never",
      Note: account.note || "",
    };
  });

  printTable(rows, [
    "Active",
    "Alias",
    "Email",
    "Status",
    "Remaining",
    "Reset",
    "Account",
    "Last Used",
    "Note",
  ]);

  if (stateChanged) {
    saveState(state);
  }
}

function printTable(rows, columns) {
  const widths = {};
  for (const column of columns) {
    widths[column] = column.length;
  }

  for (const row of rows) {
    for (const column of columns) {
      const value = String(row[column] ?? "");
      widths[column] = Math.max(widths[column], value.length);
    }
  }

  const separator = `+-${columns.map((column) => "-".repeat(widths[column])).join("-+-")}-+`;
  const renderRow = (row) =>
    `| ${columns.map((column) => String(row[column] ?? "").padEnd(widths[column], " ")).join(" | ")} |`;

  console.log(separator);
  console.log(renderRow(Object.fromEntries(columns.map((column) => [column, column]))));
  console.log(separator);
  for (const row of rows) {
    console.log(renderRow(row));
  }
  console.log(separator);
}

function showStatus() {
  const state = readState();
  const activeAlias = syncActiveAlias(state);
  const auth = currentAuthExists() ? readCurrentAuth() : null;
  console.log(`codex_auth_present=${Boolean(auth)}`);
  console.log(`active_alias=${activeAlias || "unmanaged"}`);
  if (auth) {
    console.log(`auth_mode=${auth.auth_mode || "unknown"}`);
    console.log(`current_account=${safeAccountId(auth)}`);
  }
  console.log(`saved_accounts=${state.accountOrder.filter((alias) => state.accounts[alias]).length}`);
}

function writeAuthFromAlias(alias, reason = "manual-switch") {
  const state = readState();
  const account = getAccount(state, alias);
  if (!fs.existsSync(account.snapshotPath)) {
    fatal(`Missing snapshot for alias ${alias}: ${account.snapshotPath}`);
  }
  copyFileStrict(account.snapshotPath, AUTH_PATH);
  state.activeAlias = alias;
  account.lastSwitchReason = reason;
  refreshAccountSnapshot(state, alias, readCurrentAuth(), { updateLastUsed: true });
  saveState(state);
  console.log(`Switched active Codex auth to '${alias}'`);
}

function chooseNextAlias(state, fromAlias) {
  const aliases = state.accountOrder.filter((alias) => state.accounts[alias]);
  if (aliases.length === 0) {
    return null;
  }
  const startIndex = Math.max(aliases.indexOf(fromAlias), -1);
  const ordered = aliases
    .slice(startIndex + 1)
    .concat(aliases.slice(0, startIndex + 1));

  for (const alias of ordered) {
    const account = state.accounts[alias];
    if (!account) {
      continue;
    }
    if (alias === fromAlias) {
      continue;
    }
    if (account.status === "exhausted" && !isResetDue(account.resetAt)) {
      continue;
    }
    return alias;
  }
  return null;
}

function isResetDue(resetAt) {
  if (!resetAt) {
    return false;
  }
  const resetTs = Date.parse(resetAt);
  return Number.isFinite(resetTs) && resetTs <= Date.now();
}

function rotateToNext(reason = "rotate") {
  const state = readState();
  const activeAlias = syncActiveAlias(state);
  const nextAlias = chooseNextAlias(state, activeAlias);
  if (!nextAlias) {
    fatal("No fallback account is available.");
  }
  writeAuthFromAlias(nextAlias, reason);
}

function removeAlias(alias) {
  const state = readState();
  const account = getAccount(state, alias);
  if (fs.existsSync(account.snapshotPath)) {
    fs.unlinkSync(account.snapshotPath);
  }
  delete state.accounts[alias];
  state.accountOrder = state.accountOrder.filter((item) => item !== alias);
  if (state.activeAlias === alias) {
    state.activeAlias = detectActiveAlias(state);
  }
  saveState(state);
  console.log(`Removed account '${alias}'`);
}

function updateAlias(alias, patch) {
  const state = readState();
  const account = getAccount(state, alias);
  Object.assign(account, patch, { lastSeenAt: nowIso() });
  saveState(state);
  console.log(`Updated account '${alias}'`);
}

function markExhausted(alias, resetAt) {
  const state = readState();
  const account = getAccount(state, alias);
  account.status = "exhausted";
  account.lastExhaustedAt = nowIso();
  if (resetAt) {
    account.resetAt = resetAt;
  }
  saveState(state);
  console.log(`Marked '${alias}' as exhausted`);
}

function markReady(alias) {
  const state = readState();
  const account = getAccount(state, alias);
  account.status = "ready";
  account.lastSeenAt = nowIso();
  saveState(state);
  console.log(`Marked '${alias}' as ready`);
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const [key, inlineValue] = token.slice(2).split("=", 2);
    const nextToken = argv[index + 1];
    const hasSeparateValue = inlineValue === undefined && nextToken !== undefined && !nextToken.startsWith("--");
    const value = inlineValue !== undefined ? inlineValue : hasSeparateValue ? nextToken : true;
    options[key] = value;
    if (hasSeparateValue) {
      index += 1;
    }
  }
  return options;
}

function printHelp() {
  console.log(`ckr - Codex keyring (local, best-effort)

Commands:
  add <alias>                Save current ~/.codex/auth.json as a named account
  list                       List stored accounts and metadata
  status                     Show current active account
  use <alias>                Switch ~/.codex/auth.json to a saved account
  next                       Rotate to the next available account
  remove <alias>             Delete a saved account snapshot
  mark-exhausted <alias>     Mark account exhausted; optional --reset-at ISO_TIMESTAMP
  mark-ready <alias>         Mark account ready again
  set <alias> [options]      Update metadata: --status --remaining --reset-at --note
  run -- <command...>        Run a command and auto-switch on quota-like failure
  doctor                     Validate local paths and print storage locations

Notes:
  - remaining/reset are metadata only unless you update them yourself.
  - auto-switch is best-effort and works best for new Codex sessions or codex exec.
`);
}

function doctor() {
  ensureStore();
  console.log(`codex_bin=${CODEX_BIN}`);
  console.log(`codex_dir=${CODEX_DIR}`);
  console.log(`auth_path=${AUTH_PATH}`);
  console.log(`auth_exists=${currentAuthExists()}`);
  console.log(`store_dir=${STORE_DIR}`);
  console.log(`state_path=${STATE_PATH}`);
}

function parseRunArgs(argv) {
  const delimiterIndex = argv.indexOf("--");
  if (delimiterIndex === -1 || delimiterIndex === argv.length - 1) {
    fatal("run requires a command after --");
  }
  return argv.slice(delimiterIndex + 1);
}

function isQuotaFailure(bufferText) {
  return QUOTA_PATTERNS.some((pattern) => pattern.test(bufferText));
}

function withActiveAlias(state) {
  const activeAlias = detectActiveAlias(state);
  state.activeAlias = activeAlias;
  saveState(state);
  return activeAlias;
}

async function runWithFailover(commandArgs) {
  const maxAttempts = 10;
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt += 1;
    const state = readState();
    const activeAlias = withActiveAlias(state);
    if (!activeAlias) {
      fatal("Current auth is not managed by ckr. Run 'ckr add <alias>' for the current account first.");
    }

    console.error(`Running with account '${activeAlias}' (attempt ${attempt})`);
    const result = await spawnAndMirror(commandArgs);
    if (result.exitCode === 0 && !result.quotaDetected) {
      return;
    }

    if (!result.quotaDetected) {
      process.exit(result.exitCode || 1);
    }

    const latestState = readState();
    const account = getAccount(latestState, activeAlias);
    account.status = "exhausted";
    account.lastExhaustedAt = nowIso();
    saveState(latestState);
    const nextAlias = chooseNextAlias(latestState, activeAlias);
    if (!nextAlias) {
      fatal(`Quota hit on '${activeAlias}', and no fallback account is available.`);
    }

    writeAuthFromAlias(nextAlias, "quota-failover");
  }

  fatal("Stopped after too many retry attempts.");
}

function spawnAndMirror(commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(commandArgs[0], commandArgs.slice(1), {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["inherit", "pipe", "pipe"],
    });

    let combined = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      combined += text;
      process.stdout.write(chunk);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      combined += text;
      process.stderr.write(chunk);
    });

    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        exitCode,
        quotaDetected: isQuotaFailure(combined),
      });
    });
  });
}

function runInteractiveCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    if (options.stepLabel) {
      console.error(options.stepLabel);
    }

    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0 || options.allowFailure) {
        resolve(exitCode);
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${exitCode}`));
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  switch (command) {
    case "add":
      {
        const options = parseOptions(argv.slice(2));
        if (options.login !== undefined) {
          await addAccountWithLogin(argv[1], options);
          return;
        }
        addCurrentAccount(argv[1], options.from || AUTH_PATH);
      }
      return;
    case "list":
      listAccounts();
      return;
    case "status":
      showStatus();
      return;
    case "use":
      writeAuthFromAlias(argv[1]);
      return;
    case "next":
      rotateToNext();
      return;
    case "remove":
      removeAlias(argv[1]);
      return;
    case "mark-exhausted": {
      const options = parseOptions(argv.slice(2));
      markExhausted(argv[1], options["reset-at"]);
      return;
    }
    case "mark-ready":
      markReady(argv[1]);
      return;
    case "set": {
      const alias = argv[1];
      const options = parseOptions(argv.slice(2));
      const patch = {};
      if (options.status) {
        patch.status = options.status;
      }
      if (options.remaining !== undefined) {
        const remaining = Number(options.remaining);
        patch.remainingTokens = Number.isFinite(remaining) ? remaining : null;
      }
      if (options["reset-at"] !== undefined) {
        patch.resetAt = options["reset-at"] || null;
      }
      if (options.note !== undefined) {
        patch.note = options.note || null;
      }
      updateAlias(alias, patch);
      return;
    }
    case "run": {
      const commandArgs = parseRunArgs(argv);
      await runWithFailover(commandArgs);
      return;
    }
    case "doctor":
      doctor();
      return;
    default:
      fatal(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  fatal(error instanceof Error ? error.message : String(error));
});
