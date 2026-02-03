import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import express from "express";
import httpProxy from "http-proxy";
import * as tar from "tar";

// Railway commonly sets PORT=8080 for HTTP services.
const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const STATE_DIR =
  process.env.OPENCLAW_STATE_DIR?.trim() ||
  path.join(os.homedir(), ".openclaw");
const WORKSPACE_DIR =
  process.env.OPENCLAW_WORKSPACE_DIR?.trim() ||
  path.join(STATE_DIR, "workspace");

// Protect /setup with a user-provided password.
const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();

// Debug logging helper
const DEBUG = process.env.OPENCLAW_TEMPLATE_DEBUG?.toLowerCase() === "true";
function debug(...args) {
  if (DEBUG) console.log(...args);
}

// Gateway admin token (protects Openclaw gateway + Control UI).
// Must be stable across restarts. If not provided via env, persist it in the state dir.
function resolveGatewayToken() {
  console.log(`[token] ========== SERVER STARTUP TOKEN RESOLUTION ==========`);
  const envTok = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  console.log(`[token] ENV OPENCLAW_GATEWAY_TOKEN exists: ${!!process.env.OPENCLAW_GATEWAY_TOKEN}`);
  console.log(`[token] ENV value length: ${process.env.OPENCLAW_GATEWAY_TOKEN?.length || 0}`);
  console.log(`[token] After trim length: ${envTok?.length || 0}`);

  if (envTok) {
    console.log(`[token] ✓ Using token from OPENCLAW_GATEWAY_TOKEN env variable`);
    console.log(`[token]   First 16 chars: ${envTok.slice(0, 16)}...`);
    console.log(`[token]   Full token: ${envTok}`);
    return envTok;
  }

  console.log(`[token] Env variable not available, checking persisted file...`);
  const tokenPath = path.join(STATE_DIR, "gateway.token");
  console.log(`[token] Token file path: ${tokenPath}`);

  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) {
      console.log(`[token] ✓ Using token from persisted file`);
      console.log(`[token]   First 16 chars: ${existing.slice(0, 8)}...`);
      return existing;
    }
  } catch (err) {
    console.log(`[token] Could not read persisted file: ${err.message}`);
  }

  const generated = crypto.randomBytes(32).toString("hex");
  console.log(`[token] ⚠️  Generating new random token (${generated.slice(0, 8)}...)`);
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
    console.log(`[token] Persisted new token to ${tokenPath}`);
  } catch (err) {
    console.warn(`[token] Could not persist token: ${err}`);
  }
  return generated;
}

const OPENCLAW_GATEWAY_TOKEN = resolveGatewayToken();
process.env.OPENCLAW_GATEWAY_TOKEN = OPENCLAW_GATEWAY_TOKEN;
console.log(`[token] Final resolved token: ${OPENCLAW_GATEWAY_TOKEN.slice(0, 16)}... (len: ${OPENCLAW_GATEWAY_TOKEN.length})`);
console.log(`[token] ========== TOKEN RESOLUTION COMPLETE ==========\n`);

// Run config fix on startup BEFORE any gateway operations
detectAndFixCorruptedConfig();

// Where the gateway will listen internally (we proxy to it).
const INTERNAL_GATEWAY_PORT = Number.parseInt(
  process.env.INTERNAL_GATEWAY_PORT ?? "18789",
  10,
);
const INTERNAL_GATEWAY_HOST = process.env.INTERNAL_GATEWAY_HOST ?? "127.0.0.1";
const GATEWAY_TARGET = `http://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;

// Always run the built-from-source CLI entry directly to avoid PATH/global-install mismatches.
const OPENCLAW_ENTRY =
  process.env.OPENCLAW_ENTRY?.trim() || "/openclaw/dist/entry.js";
const OPENCLAW_NODE = process.env.OPENCLAW_NODE?.trim() || "node";

function clawArgs(args) {
  return [OPENCLAW_ENTRY, ...args];
}

function configPath() {
  return (
    process.env.OPENCLAW_CONFIG_PATH?.trim() ||
    path.join(STATE_DIR, "openclaw.json")
  );
}

// Detect and fix corrupted config files on startup
function detectAndFixCorruptedConfig() {
  console.log(`[config-fix] ========== STARTING CONFIG CHECK ==========`);

  // The actual config path used by OpenClaw (based on error logs)
  const clawdbotDir = "/data/.clawdbot";
  const clawdbotConfig = path.join(clawdbotDir, "moltbot.json");
  const standardConfig = configPath();

  console.log(`[config-fix] Checking for corrupted configs...`);
  console.log(`[config-fix]   Clawdbot config: ${clawdbotConfig}`);
  console.log(`[config-fix]   Standard config: ${standardConfig}`);

  let fixed = false;

  // Fix corrupted config by removing invalid keys that fail OpenClaw schema validation
  // Based on official docs: https://docs.openclaw.ai/gateway/configuration
  if (fs.existsSync(clawdbotConfig)) {
    try {
      const content = fs.readFileSync(clawdbotConfig, "utf8");
      const config = JSON.parse(content);

      // Debug: log what we found
      console.log(`[config-fix] Config parsed, keys:`, Object.keys(config));
      if (config.agents) {
        console.log(`[config-fix] agents keys:`, Object.keys(config.agents));
        if (config.agents.list) {
          console.log(`[config-fix] agents.list length:`, config.agents.list.length);
        }
      }

      // Fix 1: Remove auth.profiles (causes validation errors in some contexts)
      if (config.auth?.profiles) {
        console.log(`[config-fix] Found problematic auth.profiles section`);
        console.log(`[config-fix] Removing auth.profiles to fix schema validation...`);

        delete config.auth.profiles;
        if (Object.keys(config.auth).length === 0) {
          delete config.auth;
        }

        fixed = true;
      }

      // Fix 2: Remove invalid "provider" keys from agents.list entries
      // Per OpenClaw schema, agents.list[] entries should NOT have a "provider" key
      // Valid keys: id, default, name, workspace, agentDir, model, identity, groupChat, sandbox, tools, subagents
      if (config.agents?.list && Array.isArray(config.agents.list)) {
        console.log(`[config-fix] Checking ${config.agents.list.length} agents.list entries for invalid keys...`);
        for (let i = 0; i < config.agents.list.length; i++) {
          const agent = config.agents.list[i];
          const keys = Object.keys(agent || {});
          console.log(`[config-fix] agents.list[${i}] keys:`, keys);
          if (agent?.provider) {
            console.log(`[config-fix] Found invalid "provider" key in agents.list[${i}]`);
            console.log(`[config-fix] Removing "provider" key (not valid in agents.list per schema)...`);
            delete config.agents.list[i].provider;
            fixed = true;
          }
        }
      }

      // Fix 3: If agents.list exists but is causing issues, remove it entirely
      // (agents.defaults is sufficient for single-agent setups)
      if (config.agents?.list && config.agents.list.length > 0) {
        // Check if any entry has invalid keys
        const hasInvalidKeys = config.agents.list.some(agent =>
          agent && Object.keys(agent).some(key =>
            !['id', 'default', 'name', 'workspace', 'agentDir', 'model',
              'identity', 'groupChat', 'sandbox', 'tools', 'subagents',
              'heartbeat', 'humanDelay', 'allowAgents', 'tools'].includes(key)
          )
        );

        if (hasInvalidKeys) {
          console.log(`[config-fix] agents.list contains invalid keys, removing entire array...`);
          delete config.agents.list;
          fixed = true;
        }
      }

      // Fix 4: Migrate Signal channel from external daemon to embedded signal-cli
      // This fixes the Railway volume sharing limitation that prevented media attachments
      if (config.channels?.signal) {
        const signalChannel = config.channels.signal;
        console.log(`[config-fix] Signal channel config:`, JSON.stringify(signalChannel, (k, v) => k === 'token' ? '***' : v));
        const hasHttpUrl = signalChannel.httpUrl && signalChannel.httpUrl.includes('signal-cli-native.railway.internal');

        if (hasHttpUrl) {
          console.log(`[config-fix] Found external signal-cli daemon configuration (httpUrl: ${signalChannel.httpUrl})`);
          console.log(`[config-fix] Migrating to embedded signal-cli with autoStart: true...`);

          // Remove httpUrl to use embedded signal-cli
          delete signalChannel.httpUrl;

          // Ensure autoStart is enabled
          signalChannel.autoStart = true;

          console.log(`[config-fix] ✓ Signal channel migrated to embedded mode (autoStart: true)`);
          fixed = true;
        }
      }

      // Write the fixed config back if we made changes
      if (fixed) {
        fs.writeFileSync(clawdbotConfig, JSON.stringify(config, null, 2), "utf8");
        console.log(`[config-fix] ✓ Wrote fixed config to ${clawdbotConfig}`);
      } else {
        console.log(`[config-fix] No fixes needed - config appears valid`);
      }
    } catch (err) {
      console.error(`[config-fix] Error checking config: ${err.message}`);
    }
  }

  // Check if clawdbot config exists and is corrupted (JSON parse error)
  if (fs.existsSync(clawdbotConfig)) {
    try {
      const content = fs.readFileSync(clawdbotConfig, "utf8");
      JSON.parse(content); // Try to parse
      console.log(`[config-fix] ✓ Clawdbot config is valid JSON`);
    } catch (err) {
      console.error(`[config-fix] ✗ Clawdbot config is corrupted: ${err.message}`);
      console.log(`[config-fix] Attempting to fix corrupted config...`);

      // Create a minimal valid config WITHOUT auth.profiles (causes agents.list errors)
      const minimalConfig = {
        gateway: {
          port: 18789,
          mode: "local",
          bind: "loopback",
          auth: {
            mode: "token",
            token: OPENCLAW_GATEWAY_TOKEN
          },
          controlUi: {
            allowInsecureAuth: true
          }
        },
        agents: {
          defaults: {
            model: {
              primary: "zai/glm-4.7"
            },
            models: {
              "zai/glm-4.7": {
                alias: "GLM"
              }
            },
            workspace: "/data/workspace",
            contextPruning: {
              mode: "cache-ttl",
              ttl: "1h"
            },
            compaction: {
              mode: "safeguard"
            },
            heartbeat: {
              every: "30m"
            },
            maxConcurrent: 4,
            subagents: {
              maxConcurrent: 8
            }
          }
        }
      };

      try {
        fs.mkdirSync(clawdbotDir, { recursive: true });
        fs.writeFileSync(clawdbotConfig, JSON.stringify(minimalConfig, null, 2), "utf8");
        console.log(`[config-fix] ✓ Fixed corrupted config at ${clawdbotConfig}`);
        fixed = true;
      } catch (writeErr) {
        console.error(`[config-fix] ✗ Failed to write fixed config: ${writeErr.message}`);
      }
    }
  } else {
    console.log(`[config-fix] No clawdbot config found at ${clawdbotConfig}`);
  }

  // Also check standard config
  if (fs.existsSync(standardConfig)) {
    try {
      const content = fs.readFileSync(standardConfig, "utf8");
      JSON.parse(content);
      console.log(`[config-fix] ✓ Standard config is valid JSON`);
    } catch (err) {
      console.error(`[config-fix] ✗ Standard config is corrupted: ${err.message}`);
      // Delete corrupted standard config so it gets regenerated
      try {
        fs.rmSync(standardConfig, { force: true });
        console.log(`[config-fix] ✓ Deleted corrupted standard config`);
        fixed = true;
      } catch (rmErr) {
        console.error(`[config-fix] ✗ Failed to delete: ${rmErr.message}`);
      }
    }
  }

  console.log(`[config-fix] ========== CONFIG CHECK COMPLETE (fixed: ${fixed}) ==========`);
  return fixed;
}

function isConfigured() {
  try {
    return fs.existsSync(configPath());
  } catch {
    return false;
  }
}

let gatewayProc = null;
let gatewayStarting = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForGatewayReady(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const start = Date.now();
  const endpoints = ["/openclaw", "/openclaw", "/", "/health"];
  
  while (Date.now() - start < timeoutMs) {
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(`${GATEWAY_TARGET}${endpoint}`, { method: "GET" });
        // Any HTTP response means the port is open.
        if (res) {
          console.log(`[gateway] ready at ${endpoint}`);
          return true;
        }
      } catch (err) {
        // not ready, try next endpoint
      }
    }
    await sleep(250);
  }
  console.error(`[gateway] failed to become ready after ${timeoutMs}ms`);
  return false;
}

async function startGateway() {
  if (gatewayProc) return;
  if (!isConfigured()) throw new Error("Gateway cannot start: not configured");

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  // Sync wrapper token to openclaw.json before every gateway start.
  // This ensures the gateway's config-file token matches what the wrapper injects via proxy.
  console.log(`[gateway] ========== GATEWAY START TOKEN SYNC ==========`);
  console.log(`[gateway] Syncing wrapper token to config: ${OPENCLAW_GATEWAY_TOKEN.slice(0, 16)}... (len: ${OPENCLAW_GATEWAY_TOKEN.length})`);

  const syncResult = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["config", "set", "gateway.auth.token", OPENCLAW_GATEWAY_TOKEN]),
  );

  console.log(`[gateway] Sync result: exit code ${syncResult.code}`);
  if (syncResult.output?.trim()) {
    console.log(`[gateway] Sync output: ${syncResult.output}`);
  }

  if (syncResult.code !== 0) {
    console.error(`[gateway] ⚠️  WARNING: Token sync failed with code ${syncResult.code}`);
  }

  // Verify sync succeeded
  try {
    const config = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    const configToken = config?.gateway?.auth?.token;

    console.log(`[gateway] Token verification:`);
    console.log(`[gateway]   Wrapper: ${OPENCLAW_GATEWAY_TOKEN.slice(0, 16)}... (len: ${OPENCLAW_GATEWAY_TOKEN.length})`);
    console.log(`[gateway]   Config:  ${configToken?.slice(0, 16)}... (len: ${configToken?.length || 0})`);

    if (configToken !== OPENCLAW_GATEWAY_TOKEN) {
      console.error(`[gateway] ✗ Token mismatch detected!`);
      console.error(`[gateway]   Full wrapper: ${OPENCLAW_GATEWAY_TOKEN}`);
      console.error(`[gateway]   Full config:  ${configToken || 'null'}`);
      throw new Error(
        `Token mismatch: wrapper has ${OPENCLAW_GATEWAY_TOKEN.slice(0, 16)}... but config has ${(configToken || 'null')?.slice?.(0, 16)}...`
      );
    }
    console.log(`[gateway] ✓ Token verification PASSED`);
  } catch (err) {
    console.error(`[gateway] ERROR: Token verification failed: ${err}`);
    throw err; // Don't start gateway with mismatched token
  }

  console.log(`[gateway] ========== TOKEN SYNC COMPLETE ==========`);

  const args = [
    "gateway",
    "run",
    "--bind",
    "loopback",
    "--port",
    String(INTERNAL_GATEWAY_PORT),
    "--auth",
    "token",
    "--token",
    OPENCLAW_GATEWAY_TOKEN,
  ];

  gatewayProc = childProcess.spawn(OPENCLAW_NODE, clawArgs(args), {
    stdio: "inherit",
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
    },
  });

  console.log(`[gateway] starting with command: ${OPENCLAW_NODE} ${clawArgs(args).join(" ")}`);
  console.log(`[gateway] STATE_DIR: ${STATE_DIR}`);
  console.log(`[gateway] WORKSPACE_DIR: ${WORKSPACE_DIR}`);
  console.log(`[gateway] config path: ${configPath()}`);

  gatewayProc.on("error", (err) => {
    console.error(`[gateway] spawn error: ${String(err)}`);
    gatewayProc = null;
  });

  gatewayProc.on("exit", (code, signal) => {
    console.error(`[gateway] exited code=${code} signal=${signal}`);
    gatewayProc = null;
  });
}

async function ensureGatewayRunning() {
  if (!isConfigured()) return { ok: false, reason: "not configured" };
  if (gatewayProc) return { ok: true };
  if (!gatewayStarting) {
    gatewayStarting = (async () => {
      await startGateway();
      const ready = await waitForGatewayReady({ timeoutMs: 20_000 });
      if (!ready) {
        throw new Error("Gateway did not become ready in time");
      }
    })().finally(() => {
      gatewayStarting = null;
    });
  }
  await gatewayStarting;
  return { ok: true };
}

async function restartGateway() {
  console.log("[gateway] Restarting gateway...");

  // Kill gateway process tracked by wrapper
  if (gatewayProc) {
    console.log("[gateway] Killing wrapper-managed gateway process");
    try {
      gatewayProc.kill("SIGTERM");
    } catch {
      // ignore
    }
    gatewayProc = null;
  }

  // Also kill any other gateway processes (e.g., started by onboard command)
  // by finding processes listening on the gateway port
  console.log(`[gateway] Killing any other gateway processes on port ${INTERNAL_GATEWAY_PORT}`);
  try {
    const killResult = await runCmd("pkill", ["-f", "openclaw-gateway"]);
    console.log(`[gateway] pkill result: exit code ${killResult.code}`);
  } catch (err) {
    console.log(`[gateway] pkill failed: ${err.message}`);
  }

  // Give processes time to exit and release the port
  await sleep(1500);

  return ensureGatewayRunning();
}

function requireSetupAuth(req, res, next) {
  if (!SETUP_PASSWORD) {
    return res
      .status(500)
      .type("text/plain")
      .send(
        "SETUP_PASSWORD is not set. Set it in Railway Variables before using /setup.",
      );
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="Openclaw Setup"');
    return res.status(401).send("Auth required");
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  if (password !== SETUP_PASSWORD) {
    res.set("WWW-Authenticate", 'Basic realm="Openclaw Setup"');
    return res.status(401).send("Invalid password");
  }
  return next();
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// Minimal health endpoint for Railway.
app.get("/setup/healthz", (_req, res) => res.json({ ok: true }));

// Temporary Signal link page (no auth for quick access)
app.get("/setup/signal-link", (_req, res) => {
  res.set("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Signal Link</title>
  <style>
    body { font-family: sans-serif; text-align: center; padding: 20px; background: #1a1a1a; color: #fff; }
    #qrcode { margin: 20px auto; display: block; background: white; padding: 20px; border-radius: 10px; }
    .status { margin: 10px 0; font-size: 18px; }
    .waiting { color: #ffa500; }
    .success { color: #4ade80; }
    .error { color: #ef4444; }
    #linktext { word-break: break-all; background: #333; padding: 10px; border-radius: 5px; font-family: monospace; font-size: 11px; }
    #restartBtn { display: none; margin: 20px auto; padding: 15px 30px; font-size: 16px; background: #4ade80; color: #000; border: none; border-radius: 8px; cursor: pointer; }
    #restartBtn:hover { background: #22c55e; }
  </style>
</head>
<body>
  <h1>🔗 Signal Device Link</h1>
  <p class="status waiting" id="status">Connecting to Signal...</p>
  <div id="qrcode"></div>
  <p id="linktext" style="display:none;"></p>
  <p>Open Signal → Settings → Linked Devices → Link New Device → Scan QR Code</p>
  <button id="restartBtn" onclick="restartGateway()">🔄 Restart Gateway to Apply</button>
  <div id="logs" style="text-align: left; max-width: 600px; margin: 20px auto; font-family: monospace; font-size: 12px; color: #888;"></div>

  <script>
    const status = document.getElementById('status');
    const logs = document.getElementById('logs');
    const qrdiv = document.getElementById('qrcode');
    const linktext = document.getElementById('linktext');
    const restartBtn = document.getElementById('restartBtn');
    let qrGenerated = false;

    const evtSource = new EventSource('/setup/api/signal-link');

    evtSource.addEventListener('link_url', (e) => {
      if (qrGenerated) return;
      qrGenerated = true;
      const url = e.data;
      status.textContent = '✅ QR Code ready! Scan now within 5 minutes.';
      status.className = 'status success';
      logs.textContent = 'Link URL generated\\n';
      linktext.textContent = url;
      linktext.style.display = 'block';

      // Use Google Charts QR Code API (reliable, no JS library needed)
      const apiUrl = 'https://chart.googleapis.com/chart?cht=qr&chs=300x300&chl=' + encodeURIComponent(url);
      qrdiv.innerHTML = '<img src="' + apiUrl + '" alt="QR Code" style="display:block;margin:0 auto;">';
    });

    evtSource.addEventListener('associated', (e) => {
      status.textContent = '✅ Account associated! Click Restart button below.';
      status.className = 'status success';
      logs.textContent += '\\n✅ ' + e.data + '\\n';
      restartBtn.style.display = 'block';
    });

    evtSource.addEventListener('success', (e) => {
      status.textContent = '✅ Signal account linked! Click Restart button.';
      status.className = 'status success';
      logs.textContent += '\\n✅ ' + e.data + '\\n';
      restartBtn.style.display = 'block';
    });

    evtSource.addEventListener('log', (e) => {
      logs.textContent += e.data + '\\n';
    });

    evtSource.addEventListener('closed', (e) => {
      status.textContent = '⏱️ Link process ended.';
      status.className = 'status waiting';
    });

    evtSource.addEventListener('timeout', (e) => {
      status.textContent = '⏱️ Timeout. Refresh to try again.';
      status.className = 'status error';
    });

    evtSource.addEventListener('error', (e) => {
      status.textContent = '❌ Error: ' + e.data;
      status.className = 'status error';
    });

    evtSource.onerror = () => {
      if (!qrGenerated) {
        status.textContent = '❌ Connection lost. Refresh to try again.';
        status.className = 'status error';
      }
    };

    async function restartGateway() {
      restartBtn.disabled = true;
      restartBtn.textContent = '⏳ Restarting...';
      status.textContent = '⏳ Restarting gateway...';

      try {
        const res = await fetch('/setup/api/signal-restart', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          status.textContent = '✅ Gateway restarted! Signal should now be working.';
          status.className = 'status success';
          restartBtn.textContent = '✅ Done';
        } else {
          status.textContent = '❌ Restart failed: ' + data.error;
          status.className = 'status error';
          restartBtn.disabled = false;
          restartBtn.textContent = '🔄 Try Again';
        }
      } catch (err) {
        status.textContent = '❌ Error: ' + err.message;
        status.className = 'status error';
        restartBtn.disabled = false;
        restartBtn.textContent = '🔄 Try Again';
      }
    }
  </script>
</body>
</html>`);
});

// Serve static files for setup wizard
app.get("/setup/app.js", requireSetupAuth, (_req, res) => {
  res.type("application/javascript");
  res.sendFile(path.join(process.cwd(), "src", "public", "setup-app.js"));
});

app.get("/setup/styles.css", requireSetupAuth, (_req, res) => {
  res.type("text/css");
  res.sendFile(path.join(process.cwd(), "src", "public", "styles.css"));
});

app.get("/setup", requireSetupAuth, (_req, res) => {
  res.sendFile(path.join(process.cwd(), "src", "public", "setup.html"));
});

app.get("/setup/api/status", requireSetupAuth, async (_req, res) => {
  const version = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const channelsHelp = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["channels", "add", "--help"]),
  );

  // We reuse Openclaw's own auth-choice grouping logic indirectly by hardcoding the same group defs.
  // This is intentionally minimal; later we can parse the CLI help output to stay perfectly in sync.
  const authGroups = [
    {
      value: "openai",
      label: "OpenAI",
      hint: "Codex OAuth + API key",
      options: [
        { value: "codex-cli", label: "OpenAI Codex OAuth (Codex CLI)" },
        { value: "openai-codex", label: "OpenAI Codex (ChatGPT OAuth)" },
        { value: "openai-api-key", label: "OpenAI API key" },
      ],
    },
    {
      value: "anthropic",
      label: "Anthropic",
      hint: "Claude Code CLI + API key",
      options: [
        { value: "claude-cli", label: "Anthropic token (Claude Code CLI)" },
        { value: "token", label: "Anthropic token (paste setup-token)" },
        { value: "apiKey", label: "Anthropic API key" },
      ],
    },
    {
      value: "google",
      label: "Google",
      hint: "Gemini API key + OAuth",
      options: [
        { value: "gemini-api-key", label: "Google Gemini API key" },
        { value: "google-antigravity", label: "Google Antigravity OAuth" },
        { value: "google-gemini-cli", label: "Google Gemini CLI OAuth" },
      ],
    },
    {
      value: "openrouter",
      label: "OpenRouter",
      hint: "API key",
      options: [{ value: "openrouter-api-key", label: "OpenRouter API key" }],
    },
    {
      value: "ai-gateway",
      label: "Vercel AI Gateway",
      hint: "API key",
      options: [
        { value: "ai-gateway-api-key", label: "Vercel AI Gateway API key" },
      ],
    },
    {
      value: "moonshot",
      label: "Moonshot AI",
      hint: "Kimi K2 + Kimi Code",
      options: [
        { value: "moonshot-api-key", label: "Moonshot AI API key" },
        { value: "kimi-code-api-key", label: "Kimi Code API key" },
      ],
    },
    {
      value: "zai",
      label: "Z.AI (GLM 4.7)",
      hint: "API key",
      options: [{ value: "zai-api-key", label: "Z.AI (GLM 4.7) API key" }],
    },
    {
      value: "minimax",
      label: "MiniMax",
      hint: "M2.1 (recommended)",
      options: [
        { value: "minimax-api", label: "MiniMax M2.1" },
        { value: "minimax-api-lightning", label: "MiniMax M2.1 Lightning" },
      ],
    },
    {
      value: "qwen",
      label: "Qwen",
      hint: "OAuth",
      options: [{ value: "qwen-portal", label: "Qwen OAuth" }],
    },
    {
      value: "copilot",
      label: "Copilot",
      hint: "GitHub + local proxy",
      options: [
        {
          value: "github-copilot",
          label: "GitHub Copilot (GitHub device login)",
        },
        { value: "copilot-proxy", label: "Copilot Proxy (local)" },
      ],
    },
    {
      value: "synthetic",
      label: "Synthetic",
      hint: "Anthropic-compatible (multi-model)",
      options: [{ value: "synthetic-api-key", label: "Synthetic API key" }],
    },
    {
      value: "opencode-zen",
      label: "OpenCode Zen",
      hint: "API key",
      options: [
        { value: "opencode-zen", label: "OpenCode Zen (multi-model proxy)" },
      ],
    },
  ];

  res.json({
    configured: isConfigured(),
    gatewayTarget: GATEWAY_TARGET,
    openclawVersion: version.output.trim(),
    channelsAddHelp: channelsHelp.output,
    authGroups,
  });
});

function buildOnboardArgs(payload) {
  const args = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--json",
    "--no-install-daemon",
    "--skip-health",
    "--workspace",
    WORKSPACE_DIR,
    // The wrapper owns public networking; keep the gateway internal.
    "--gateway-bind",
    "loopback",
    "--gateway-port",
    String(INTERNAL_GATEWAY_PORT),
    "--gateway-auth",
    "token",
    "--gateway-token",
    OPENCLAW_GATEWAY_TOKEN,
    "--flow",
    payload.flow || "quickstart",
  ];

  if (payload.authChoice) {
    args.push("--auth-choice", payload.authChoice);

    // Map secret to correct flag for common choices.
    const secret = (payload.authSecret || "").trim();
    const map = {
      "openai-api-key": "--openai-api-key",
      apiKey: "--anthropic-api-key",
      "openrouter-api-key": "--openrouter-api-key",
      "ai-gateway-api-key": "--ai-gateway-api-key",
      "moonshot-api-key": "--moonshot-api-key",
      "kimi-code-api-key": "--kimi-code-api-key",
      "gemini-api-key": "--gemini-api-key",
      "zai-api-key": "--zai-api-key",
      "minimax-api": "--minimax-api-key",
      "minimax-api-lightning": "--minimax-api-key",
      "synthetic-api-key": "--synthetic-api-key",
      "opencode-zen": "--opencode-zen-api-key",
    };
    const flag = map[payload.authChoice];
    if (flag && secret) {
      args.push(flag, secret);
    }

    if (payload.authChoice === "token" && secret) {
      // This is the Anthropics setup-token flow.
      args.push("--token-provider", "anthropic", "--token", secret);
    }
  }

  return args;
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const proc = childProcess.spawn(cmd, args, {
      ...opts,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: STATE_DIR,
        OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
      },
    });

    let out = "";
    proc.stdout?.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr?.on("data", (d) => (out += d.toString("utf8")));

    proc.on("error", (err) => {
      out += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: 127, output: out });
    });

    proc.on("close", (code) => resolve({ code: code ?? 0, output: out }));
  });
}

app.post("/setup/api/run", requireSetupAuth, async (req, res) => {
  try {
    if (isConfigured()) {
      await ensureGatewayRunning();
      return res.json({
        ok: true,
        output:
          "Already configured.\nUse Reset setup if you want to rerun onboarding.\n",
      });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    const payload = req.body || {};
    const onboardArgs = buildOnboardArgs(payload);

    // DIAGNOSTIC: Log token we're passing to onboard
    console.log(`[onboard] ========== TOKEN DIAGNOSTIC START ==========`);
    console.log(`[onboard] Wrapper token (from env/file/generated): ${OPENCLAW_GATEWAY_TOKEN.slice(0, 16)}... (length: ${OPENCLAW_GATEWAY_TOKEN.length})`);
    console.log(`[onboard] Onboard command args include: --gateway-token ${OPENCLAW_GATEWAY_TOKEN.slice(0, 16)}...`);
    console.log(`[onboard] Full onboard command: node ${clawArgs(onboardArgs).join(' ').replace(OPENCLAW_GATEWAY_TOKEN, OPENCLAW_GATEWAY_TOKEN.slice(0, 16) + '...')}`);

    const onboard = await runCmd(OPENCLAW_NODE, clawArgs(onboardArgs));

    let extra = "";

    const ok = onboard.code === 0 && isConfigured();

    // DIAGNOSTIC: Check what token onboard actually wrote to config
    if (ok) {
      try {
        const configAfterOnboard = JSON.parse(fs.readFileSync(configPath(), "utf8"));
        const tokenAfterOnboard = configAfterOnboard?.gateway?.auth?.token;
        console.log(`[onboard] Token in config AFTER onboard: ${tokenAfterOnboard?.slice(0, 16)}... (length: ${tokenAfterOnboard?.length || 0})`);
        console.log(`[onboard] Token match: ${tokenAfterOnboard === OPENCLAW_GATEWAY_TOKEN ? '✓ MATCHES' : '✗ MISMATCH!'}`);
        if (tokenAfterOnboard !== OPENCLAW_GATEWAY_TOKEN) {
          console.log(`[onboard] ⚠️  PROBLEM: onboard command ignored --gateway-token flag and wrote its own token!`);
          extra += `\n[WARNING] onboard wrote different token than expected\n`;
          extra += `  Expected: ${OPENCLAW_GATEWAY_TOKEN.slice(0, 16)}...\n`;
          extra += `  Got:      ${tokenAfterOnboard?.slice(0, 16)}...\n`;
        }
      } catch (err) {
        console.error(`[onboard] Could not check config after onboard: ${err}`);
      }
    }

    // Optional channel setup (only after successful onboarding, and only if the installed CLI supports it).
    if (ok) {
      // Ensure gateway token is written into config so the browser UI can authenticate reliably.
      // (We also enforce loopback bind since the wrapper proxies externally.)
      console.log(`[onboard] Now syncing wrapper token to config (${OPENCLAW_GATEWAY_TOKEN.slice(0, 8)}...)`);

      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.mode", "local"]));
      await runCmd(
        OPENCLAW_NODE,
        clawArgs(["config", "set", "gateway.auth.mode", "token"]),
      );

      const setTokenResult = await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "config",
          "set",
          "gateway.auth.token",
          OPENCLAW_GATEWAY_TOKEN,
        ]),
      );

      console.log(`[onboard] config set gateway.auth.token result: exit code ${setTokenResult.code}`);
      if (setTokenResult.output?.trim()) {
        console.log(`[onboard] config set output: ${setTokenResult.output}`);
      }

      if (setTokenResult.code !== 0) {
        console.error(`[onboard] ⚠️  WARNING: config set gateway.auth.token failed with code ${setTokenResult.code}`);
        extra += `\n[WARNING] Failed to set gateway token in config: ${setTokenResult.output}\n`;
      }

      // Verify the token was actually written to config
      try {
        const configContent = fs.readFileSync(configPath(), "utf8");
        const config = JSON.parse(configContent);
        const configToken = config?.gateway?.auth?.token;

        console.log(`[onboard] Token verification after sync:`);
        console.log(`[onboard]   Wrapper token: ${OPENCLAW_GATEWAY_TOKEN.slice(0, 16)}... (len: ${OPENCLAW_GATEWAY_TOKEN.length})`);
        console.log(`[onboard]   Config token:  ${configToken?.slice(0, 16)}... (len: ${configToken?.length || 0})`);

        if (configToken !== OPENCLAW_GATEWAY_TOKEN) {
          console.error(`[onboard] ✗ ERROR: Token mismatch after config set!`);
          console.error(`[onboard]   Full wrapper token: ${OPENCLAW_GATEWAY_TOKEN}`);
          console.error(`[onboard]   Full config token:  ${configToken || 'null'}`);
          extra += `\n[ERROR] Token verification failed! Config has different token than wrapper.\n`;
          extra += `  Wrapper: ${OPENCLAW_GATEWAY_TOKEN.slice(0, 16)}...\n`;
          extra += `  Config:  ${configToken?.slice(0, 16)}...\n`;
        } else {
          console.log(`[onboard] ✓ Token verification PASSED - tokens match!`);
          extra += `\n[onboard] ✓ Gateway token synced successfully\n`;
        }
      } catch (err) {
        console.error(`[onboard] ERROR: Could not verify token in config: ${err}`);
        extra += `\n[ERROR] Could not verify token: ${String(err)}\n`;
      }

      console.log(`[onboard] ========== TOKEN DIAGNOSTIC END ==========`);

      await runCmd(
        OPENCLAW_NODE,
        clawArgs(["config", "set", "gateway.bind", "loopback"]),
      );
      await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "config",
          "set",
          "gateway.port",
          String(INTERNAL_GATEWAY_PORT),
        ]),
      );
      // Allow Control UI access without device pairing (fixes error 1008: pairing required)
      await runCmd(
        OPENCLAW_NODE,
        clawArgs(["config", "set", "gateway.controlUi.allowInsecureAuth", "true"]),
      );

      const channelsHelp = await runCmd(
        OPENCLAW_NODE,
        clawArgs(["channels", "add", "--help"]),
      );
      const helpText = channelsHelp.output || "";

      const supports = (name) => helpText.includes(name);

      if (payload.telegramToken?.trim()) {
        if (!supports("telegram")) {
          extra +=
            "\n[telegram] skipped (this openclaw build does not list telegram in `channels add --help`)\n";
        } else {
          // Avoid `channels add` here (it has proven flaky across builds); write config directly.
          const token = payload.telegramToken.trim();
          const cfgObj = {
            enabled: true,
            dmPolicy: "pairing",
            botToken: token,
            groupPolicy: "allowlist",
            streamMode: "partial",
          };
          const set = await runCmd(
            OPENCLAW_NODE,
            clawArgs([
              "config",
              "set",
              "--json",
              "channels.telegram",
              JSON.stringify(cfgObj),
            ]),
          );
          const get = await runCmd(
            OPENCLAW_NODE,
            clawArgs(["config", "get", "channels.telegram"]),
          );
          extra += `\n[telegram config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
          extra += `\n[telegram verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
        }
      }

      if (payload.discordToken?.trim()) {
        if (!supports("discord")) {
          extra +=
            "\n[discord] skipped (this openclaw build does not list discord in `channels add --help`)\n";
        } else {
          const token = payload.discordToken.trim();
          const cfgObj = {
            enabled: true,
            token,
            groupPolicy: "allowlist",
            dm: {
              policy: "pairing",
            },
          };
          const set = await runCmd(
            OPENCLAW_NODE,
            clawArgs([
              "config",
              "set",
              "--json",
              "channels.discord",
              JSON.stringify(cfgObj),
            ]),
          );
          const get = await runCmd(
            OPENCLAW_NODE,
            clawArgs(["config", "get", "channels.discord"]),
          );
          extra += `\n[discord config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
          extra += `\n[discord verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
        }
      }

      if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
        if (!supports("slack")) {
          extra +=
            "\n[slack] skipped (this openclaw build does not list slack in `channels add --help`)\n";
        } else {
          const cfgObj = {
            enabled: true,
            botToken: payload.slackBotToken?.trim() || undefined,
            appToken: payload.slackAppToken?.trim() || undefined,
          };
          const set = await runCmd(
            OPENCLAW_NODE,
            clawArgs([
              "config",
              "set",
              "--json",
              "channels.slack",
              JSON.stringify(cfgObj),
            ]),
          );
          const get = await runCmd(
            OPENCLAW_NODE,
            clawArgs(["config", "get", "channels.slack"]),
          );
          extra += `\n[slack config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
          extra += `\n[slack verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
        }
      }

      // Apply changes immediately.
      await restartGateway();
    }

    return res.status(ok ? 200 : 500).json({
      ok,
      output: `${onboard.output}${extra}`,
    });
  } catch (err) {
    console.error("[/setup/api/run] error:", err);
    return res
      .status(500)
      .json({ ok: false, output: `Internal error: ${String(err)}` });
  }
});

app.get("/setup/api/debug", requireSetupAuth, async (_req, res) => {
  const v = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const help = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["channels", "add", "--help"]),
  );
  res.json({
    wrapper: {
      node: process.version,
      port: PORT,
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
      configPath: configPath(),
      gatewayTokenFromEnv: Boolean(process.env.OPENCLAW_GATEWAY_TOKEN?.trim()),
      gatewayTokenPersisted: fs.existsSync(
        path.join(STATE_DIR, "gateway.token"),
      ),
      railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    },
    openclaw: {
      entry: OPENCLAW_ENTRY,
      node: OPENCLAW_NODE,
      version: v.output.trim(),
      channelsAddHelpIncludesTelegram: help.output.includes("telegram"),
    },
  });
});

app.post("/setup/api/pairing/approve", requireSetupAuth, async (req, res) => {
  const { channel, code } = req.body || {};
  if (!channel || !code) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing channel or code" });
  }
  const r = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["pairing", "approve", String(channel), String(code)]),
  );
  return res
    .status(r.code === 0 ? 200 : 500)
    .json({ ok: r.code === 0, output: r.output });
});

app.post("/setup/api/reset", requireSetupAuth, async (_req, res) => {
  // Minimal reset: delete the config file so /setup can rerun.
  // Keep credentials/sessions/workspace by default.
  try {
    fs.rmSync(configPath(), { force: true });
    res
      .type("text/plain")
      .send("OK - deleted config file. You can rerun setup now.");
  } catch (err) {
    res.status(500).type("text/plain").send(String(err));
  }
});

// Temporary endpoint to generate Signal link QR code in the running service
// Uses SSE to keep connection alive while link process runs
// Note: Auth temporarily disabled for quick access
app.get("/setup/api/signal-link", async (_req, res) => {
  console.log(`[signal-link] Starting SSE link endpoint...`);

  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Ensure signal-cli data directory exists
  const signalDataDir = "/data/.local/share/signal-cli";
  try {
    fs.mkdirSync(signalDataDir, { recursive: true });
    console.log(`[signal-link] Created data directory: ${signalDataDir}`);
  } catch (err) {
    console.log(`[signal-link] Data directory exists or error: ${err.message}`);
  }

  // Start signal-cli link process with explicit data directory
  const linkProc = childProcess.spawn("signal-cli", ["--config", signalDataDir, "link", "-n", "OpenClaw"], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      XDG_DATA_HOME: '/data',
    }
  });

  let sentUrl = false;
  let associated = false;

  linkProc.stdout.on("data", (data) => {
    const text = data.toString();
    console.log(`[signal-link] stdout:`, text.trim());

    // Check for link URL
    const match = text.match(/(sgnl:\/\/linkdevice\?[^\s\n]+)/);
    if (match && !sentUrl) {
      sentUrl = true;
      res.write(`event: link_url\n`);
      res.write(`data: ${match[1]}\n\n`);
      console.log(`[signal-link] Sent link URL to client`);
    }

    // Check for successful association
    if (text.includes("Associated with:") && !associated) {
      associated = true;
      res.write(`event: associated\n`);
      res.write(`data: ${text.trim()}\n\n`);
      console.log(`[signal-link] Account associated successfully!`);

      // Keep process alive a bit longer to ensure data is written
      setTimeout(() => {
        if (!linkProc.killed) {
          console.log(`[signal-link] Association complete, terminating process`);
          linkProc.kill();
        }
      }, 5000);
    }

    // Forward any other output
    if (text.trim()) {
      res.write(`event: log\n`);
      res.write(`data: ${text.trim()}\n\n`);
    }
  });

  linkProc.stderr.on("data", (data) => {
    const text = data.toString();
    console.log(`[signal-link] stderr:`, text.trim());

    // Check for association on stderr too
    if (text.includes("Associated with:") && !associated) {
      associated = true;
      res.write(`event: associated\n`);
      res.write(`data: Account associated!\n\n`);
      console.log(`[signal-link] Account associated successfully!`);
    }

    res.write(`event: log\n`);
    res.write(`data: ${text.trim()}\n\n`);
  });

  linkProc.on("close", (code) => {
    console.log(`[signal-link] Process exited with code ${code}`);
    if (associated) {
      res.write(`event: success\n`);
      res.write(`data: Signal account linked! Restarting gateway...\n\n`);
    } else {
      res.write(`event: closed\n`);
      res.write(`data: Process exited (code: ${code})\n\n`);
    }
    res.end();
  });

  linkProc.on("error", (err) => {
    console.error(`[signal-link] Process error:`, err);
    res.write(`event: error\n`);
    res.write(`data: ${err.message}\n\n`);
    res.end();
  });

  // Keep alive for 5 minutes
  const keepAlive = setInterval(() => {
    res.write(`: keep-alive\n\n`);
  }, 30000);

  // Cleanup after timeout
  setTimeout(() => {
    clearInterval(keepAlive);
    if (!linkProc.killed) {
      console.log(`[signal-link] Timeout, killing process`);
      linkProc.kill();
    }
    if (!res.writableEnded) {
      res.write(`event: timeout\n`);
      res.write(`data: Timeout - please try again\n\n`);
      res.end();
    }
  }, 5 * 60 * 1000);

  res.on("close", () => {
    clearInterval(keepAlive);
    if (!linkProc.killed) linkProc.kill();
  });
});

// Test network connectivity to Signal servers
app.get("/setup/api/signal-test", async (_req, res) => {
  try {
    const https = await import('https');
    const results = {};

    const testUrl = (url) => new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ url, status: 'TIMEOUT' }), 10000);
      https.get(url, (resp) => {
        clearTimeout(timer);
        resolve({ url, status: resp.statusCode || 'CONNECTED' });
      }).on('error', (err) => {
        clearTimeout(timer);
        resolve({ url, status: 'ERROR: ' + err.message });
      });
    });

    results.signal = await testUrl('https://textsecure-service.whispersystems.org');
    results.google = await testUrl('https://www.google.com');

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Endpoint to restart gateway after Signal linking
app.post("/setup/api/signal-restart", async (_req, res) => {
  try {
    console.log(`[signal-restart] Restarting gateway to pick up Signal registration...`);

    // Kill and restart the gateway
    await restartGateway();

    // Wait a bit for the Signal channel to initialize
    await sleep(5000);

    res.json({ ok: true, message: "Gateway restarted. Check Signal channel status." });
  } catch (err) {
    console.error(`[signal-restart] Error:`, err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.get("/setup/export", requireSetupAuth, async (_req, res) => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  res.setHeader("content-type", "application/gzip");
  res.setHeader(
    "content-disposition",
    `attachment; filename="openclaw-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz"`,
  );

  // Prefer exporting from a common /data root so archives are easy to inspect and restore.
  // This preserves dotfiles like /data/.openclaw/openclaw.json.
  const stateAbs = path.resolve(STATE_DIR);
  const workspaceAbs = path.resolve(WORKSPACE_DIR);

  const dataRoot = "/data";
  const underData = (p) => p === dataRoot || p.startsWith(dataRoot + path.sep);

  let cwd = "/";
  let paths = [stateAbs, workspaceAbs].map((p) => p.replace(/^\//, ""));

  if (underData(stateAbs) && underData(workspaceAbs)) {
    cwd = dataRoot;
    // We export relative to /data so the archive contains: .openclaw/... and workspace/...
    paths = [
      path.relative(dataRoot, stateAbs) || ".",
      path.relative(dataRoot, workspaceAbs) || ".",
    ];
  }

  const stream = tar.c(
    {
      gzip: true,
      portable: true,
      noMtime: true,
      cwd,
      onwarn: () => {},
    },
    paths,
  );

  stream.on("error", (err) => {
    console.error("[export]", err);
    if (!res.headersSent) res.status(500);
    res.end(String(err));
  });

  stream.pipe(res);
});

// Proxy everything else to the gateway.
const proxy = httpProxy.createProxyServer({
  target: GATEWAY_TARGET,
  ws: true,
  xfwd: true,
});

proxy.on("error", (err, _req, _res) => {
  console.error("[proxy]", err);
});

// Inject auth token into HTTP proxy requests
proxy.on("proxyReq", (proxyReq, req, res) => {
  console.log(`[proxy] HTTP ${req.method} ${req.url} - injecting token: ${OPENCLAW_GATEWAY_TOKEN.slice(0, 16)}...`);
  proxyReq.setHeader("Authorization", `Bearer ${OPENCLAW_GATEWAY_TOKEN}`);
});

// Log WebSocket upgrade proxy events (token is injected via headers option in server.on("upgrade"))
proxy.on("proxyReqWs", (proxyReq, req, socket, options, head) => {
  console.log(`[proxy-event] WebSocket proxyReqWs event fired for ${req.url}`);
  console.log(`[proxy-event] Headers:`, JSON.stringify(proxyReq.getHeaders()));
});

app.use(async (req, res) => {
  // If not configured, force users to /setup for any non-setup routes.
  if (!isConfigured() && !req.path.startsWith("/setup")) {
    return res.redirect("/setup");
  }

  if (isConfigured()) {
    try {
      await ensureGatewayRunning();
    } catch (err) {
      return res
        .status(503)
        .type("text/plain")
        .send(`Gateway not ready: ${String(err)}`);
    }
  }

  // Proxy to gateway (auth token injected via proxyReq event)
  return proxy.web(req, res, { target: GATEWAY_TARGET });
});

// Create HTTP server from Express app
const server = app.listen(PORT, () => {
  console.log(`[wrapper] listening on port ${PORT}`);
  console.log(`[wrapper] setup wizard: http://localhost:${PORT}/setup`);
  console.log(`[wrapper] configured: ${isConfigured()}`);
});

// Handle WebSocket upgrades
server.on("upgrade", async (req, socket, head) => {
  if (!isConfigured()) {
    socket.destroy();
    return;
  }
  try {
    await ensureGatewayRunning();
  } catch {
    socket.destroy();
    return;
  }

  // Inject auth token via headers option (req.headers modification doesn't work for WS)
  console.log(`[ws-upgrade] Proxying WebSocket upgrade with token: ${OPENCLAW_GATEWAY_TOKEN.slice(0, 16)}...`);

  proxy.ws(req, socket, head, {
    target: GATEWAY_TARGET,
    headers: {
      Authorization: `Bearer ${OPENCLAW_GATEWAY_TOKEN}`,
    },
  });
});

process.on("SIGTERM", () => {
  // Best-effort shutdown
  try {
    if (gatewayProc) gatewayProc.kill("SIGTERM");
  } catch {
    // ignore
  }
  process.exit(0);
});
