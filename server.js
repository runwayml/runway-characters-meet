import "dotenv/config";
import express from "express";
import { randomUUID } from "crypto";

const app = express();
app.use(express.json());
app.use(express.static("public"));

const {
  RUNWAY_API_KEY,
  RUNWAY_BASE_URL = "https://api.dev.runwayml.com",
  RECALL_API_KEY,
  RECALL_REGION = "us-west-2",
  PUBLIC_URL = "http://localhost:3000",
  PORT = "3000",
} = process.env;

const RECALL_BASE = `https://${RECALL_REGION}.recall.ai/api/v1`;

// In-memory session store
const sessions = new Map();

// ---------------------------------------------------------------------------
// Runway API helpers
// ---------------------------------------------------------------------------

async function runwayFetch(path, { method = "GET", body, bearerToken } = {}) {
  const res = await fetch(`${RUNWAY_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${bearerToken || RUNWAY_API_KEY}`,
      "X-Runway-Version": "2024-11-06",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (method === "DELETE" && res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      `Runway ${method} ${path} → ${res.status}: ${JSON.stringify(data)}`
    );
  }
  return data;
}

async function createRunwaySession(avatar, maxDuration = 120) {
  return runwayFetch("/v1/realtime_sessions", {
    method: "POST",
    body: { model: "gwm1_avatars", avatar, maxDuration },
  });
}

async function pollRunwaySession(id) {
  for (let i = 0; i < 90; i++) {
    const s = await runwayFetch(`/v1/realtime_sessions/${id}`);
    if (s.status === "READY") return s.sessionKey;
    if (s.status === "FAILED" || s.status === "CANCELLED") {
      throw new Error(`Session ${s.status}: ${s.failure || ""}`);
    }
    await sleep(2000);
  }
  throw new Error("Timed out waiting for session to be ready");
}

async function consumeRunwaySession(id, sessionKey) {
  return runwayFetch(`/v1/realtime_sessions/${id}/consume`, {
    method: "POST",
    bearerToken: sessionKey,
  });
}

async function cancelRunwaySession(id) {
  try {
    await runwayFetch(`/v1/realtime_sessions/${id}`, { method: "DELETE" });
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Recall.ai API helpers
// ---------------------------------------------------------------------------

async function recallFetch(path, { method = "GET", body } = {}) {
  const res = await fetch(`${RECALL_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Token ${RECALL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      `Recall ${method} ${path} → ${res.status}: ${JSON.stringify(data)}`
    );
  }
  return data;
}

async function createRecallBot(meetingUrl, botName, botPageUrl) {
  return recallFetch("/bot/", {
    method: "POST",
    body: {
      meeting_url: meetingUrl,
      bot_name: botName || "Calliope Avatar",
      output_media: {
        camera: {
          kind: "webpage",
          config: { url: botPageUrl },
        },
      },
    },
  });
}

async function deleteRecallBot(botId) {
  try {
    await recallFetch(`/bot/${botId}/leave_call/`, { method: "POST" });
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// List Runway avatars
app.get("/api/avatars", async (_req, res) => {
  try {
    const data = await runwayFetch("/v1/avatars");
    const ready = data.data.filter((a) => a.status === "READY");
    res.json(ready);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start a session: create Runway session + Recall bot (async, returns immediately)
app.post("/api/start", (req, res) => {
  const { meetingUrl, avatarType, avatarId, botName, maxDuration } = req.body;

  if (!meetingUrl) return res.status(400).json({ error: "meetingUrl required" });
  if (!avatarId) return res.status(400).json({ error: "avatarId required" });

  const avatar =
    avatarType === "preset"
      ? { type: "runway-preset", presetId: avatarId }
      : { type: "custom", avatarId };

  const id = randomUUID();
  const session = {
    id,
    status: "creating",
    error: null,
    runwaySessionId: null,
    recallBotId: null,
    liveKit: null,
    meetingUrl,
    logs: [],
  };
  sessions.set(id, session);

  // Run the async pipeline
  runSessionPipeline(session, avatar, meetingUrl, botName, maxDuration);

  res.json({ sessionId: id });
});

// Get session status (polled by the control panel)
app.get("/api/sessions/:id", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json({
    status: session.status,
    error: session.error,
    logs: session.logs,
    runwaySessionId: session.runwaySessionId,
    recallBotId: session.recallBotId,
  });
});

// Get LiveKit creds (called by the bot page)
app.get("/api/sessions/:id/creds", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (!session.liveKit) return res.status(425).json({ error: "Not ready yet" });
  res.json(session.liveKit);
});

// Stop a session
app.post("/api/sessions/:id/stop", async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });

  await stopSession(session);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Session pipeline
// ---------------------------------------------------------------------------

async function runSessionPipeline(session, avatar, meetingUrl, botName, maxDuration) {
  const log = (msg) => {
    const ts = new Date().toISOString().slice(11, 23);
    session.logs.push(`[${ts}] ${msg}`);
    console.log(`[${session.id.slice(0, 8)}] ${msg}`);
  };

  try {
    // 1. Create Runway session
    log("Creating Runway realtime session...");
    const created = await createRunwaySession(avatar, maxDuration || 120);
    session.runwaySessionId = created.id;
    log(`Runway session created: ${created.id}`);

    // 2. Poll until ready
    session.status = "polling";
    log("Waiting for avatar to be ready...");
    const sessionKey = await pollRunwaySession(created.id);
    log("Avatar is ready");

    // 3. Consume to get LiveKit creds
    session.status = "consuming";
    log("Getting LiveKit credentials...");
    const creds = await consumeRunwaySession(created.id, sessionKey);
    session.liveKit = { url: creds.url, token: creds.token };
    log(`LiveKit room: ${creds.roomName}`);

    // 4. Create Recall bot
    session.status = "bot_joining";
    const botPageUrl = `${PUBLIC_URL}/bot.html?session=${session.id}`;
    log(`Creating Recall bot → ${meetingUrl}`);
    log(`Bot page: ${botPageUrl}`);
    const bot = await createRecallBot(meetingUrl, botName, botPageUrl);
    session.recallBotId = bot.id;
    log(`Recall bot created: ${bot.id}`);

    session.status = "active";
    log("Avatar is live in the meeting!");
  } catch (err) {
    session.status = "failed";
    session.error = err.message;
    const log2 = (msg) => {
      const ts = new Date().toISOString().slice(11, 23);
      session.logs.push(`[${ts}] ${msg}`);
    };
    log2(`Error: ${err.message}`);
  }
}

async function stopSession(session) {
  const log = (msg) => {
    const ts = new Date().toISOString().slice(11, 23);
    session.logs.push(`[${ts}] ${msg}`);
    console.log(`[${session.id.slice(0, 8)}] ${msg}`);
  };

  log("Stopping session...");

  if (session.recallBotId) {
    log("Removing Recall bot from meeting...");
    await deleteRecallBot(session.recallBotId);
  }

  if (session.runwaySessionId) {
    log("Cancelling Runway session...");
    await cancelRunwaySession(session.runwaySessionId);
  }

  session.status = "ended";
  log("Session ended");
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

app.listen(parseInt(PORT), () => {
  console.log(`\n  Calliope Meet server running on http://localhost:${PORT}`);
  console.log(`  Public URL: ${PUBLIC_URL}`);
  console.log(`  Recall region: ${RECALL_REGION}\n`);
});
