import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { randomUUID } from "crypto";

const app = express();
app.use(express.json());
app.use(express.static("public"));

const {
  RECALL_API_KEY,
  RECALL_REGION = "us-west-2",
  PORT = "3000",
} = process.env;

const PUBLIC_URL =
  process.env.PUBLIC_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://localhost:${PORT}`);

const WS_PUBLIC_URL = PUBLIC_URL.replace(/^https/, "wss").replace(
  /^http/,
  "ws"
);

const RECALL_BASE = `https://${RECALL_REGION}.recall.ai/api/v1`;

// In-memory session store
const sessions = new Map();
// WebSocket clients: sessionId → Set of bot page WebSocket connections
const videoRelayClients = new Map();
// Active speaker tracking: sessionId → { active: Set<participantId>, lastSpeaker: participantId | null }
const speakerState = new Map();

// ---------------------------------------------------------------------------
// Runway API helpers (per-user credentials)
// ---------------------------------------------------------------------------

async function runwayFetch(
  baseUrl,
  apiKey,
  path,
  { method = "GET", body, bearerToken } = {}
) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${bearerToken || apiKey}`,
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

// ---------------------------------------------------------------------------
// Recall.ai API helpers (shared server credential)
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

async function createRecallBot(meetingUrl, botName, botPageUrl, sessionId, meetingPassword) {
  const displayName = botName || "Runway Character";
  const body = {
      meeting_url: meetingUrl,
      bot_name: displayName,
      output_media: {
        camera: {
          kind: "webpage",
          config: { url: botPageUrl },
        },
      },
      chat: {
        on_bot_join: {
          send_to: "everyone",
          message: `Hello everyone, I'm ${displayName}, A Runway Character.`,
        },
      },
      variant: {
        zoom: "web_4_core",
        google_meet: "web_4_core",
        microsoft_teams: "web_4_core",
      },
      recording_config: {
        video_mixed_layout: "gallery_view_v2",
        video_separate_png: {},
        realtime_endpoints: [
          {
            type: "websocket",
            url: `${WS_PUBLIC_URL}/ws/recall-video/${sessionId}`,
            events: [
              "video_separate_png.data",
              "participant_events.speech_on",
              "participant_events.speech_off",
            ],
          },
        ],
      },
  };
  if (meetingPassword) {
    body.meeting_config = { zoom: { meeting_password: meetingPassword } };
  }
  return recallFetch("/bot/", { method: "POST", body });
}

async function deleteRecallBot(botId) {
  try {
    console.log(`[recall] Sending leave_call for bot ${botId}`);
    const result = await recallFetch(`/bot/${botId}/leave_call/`, { method: "POST" });
    console.log(`[recall] Bot ${botId} left the call`);
    return result;
  } catch (err) {
    console.error(`[recall] Failed to remove bot ${botId}:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Middleware: extract per-user Runway credentials from headers
// ---------------------------------------------------------------------------

function getRunwayCreds(req) {
  const apiKey = req.headers["x-runway-key"];
  const baseUrl = (
    req.headers["x-runway-base-url"] || "https://api.dev.runwayml.com"
  ).replace(/\/+$/, "");
  if (!apiKey) throw new Error("Runway API key is required");
  return { apiKey, baseUrl };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/api/avatars", async (req, res) => {
  try {
    const { apiKey, baseUrl } = getRunwayCreds(req);
    const data = await runwayFetch(baseUrl, apiKey, "/v1/avatars");
    const ready = data.data.filter((a) => a.status === "READY");
    res.json(ready);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/start", (req, res) => {
  let runway;
  try {
    runway = getRunwayCreds(req);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const { meetingUrl, avatarType, avatarId, botName, maxDuration, systemPrompt, meetingPassword } = req.body;

  if (!meetingUrl)
    return res.status(400).json({ error: "meetingUrl required" });
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
    runway,
    logs: [],
  };
  sessions.set(id, session);

  runSessionPipeline(session, avatar, meetingUrl, botName, maxDuration, systemPrompt, meetingPassword);

  res.json({ sessionId: id });
});

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

app.get("/api/sessions/:id/creds", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (!session.liveKit)
    return res.status(425).json({ error: "Not ready yet" });
  res.json(session.liveKit);
});

app.post("/api/sessions/:id/mute", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });

  const { muted } = req.body;
  session.muted = !!muted;

  // Send control message to the bot page via WebSocket relay
  const clients = videoRelayClients.get(req.params.id);
  if (clients) {
    const msg = JSON.stringify({ type: "control", action: "mute", muted: session.muted });
    for (const client of clients) {
      if (client.readyState === 1) client.send(msg);
    }
  }

  res.json({ muted: session.muted });
});

app.post("/api/sessions/:id/stop", async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });

  await stopSession(session);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// WebSocket server for video relay
// ---------------------------------------------------------------------------

const httpServer = createServer(app);
const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const pathname = url.pathname;

  // Route: /ws/recall-video/:sessionId  — Recall sends video frames here
  // Route: /ws/video-relay/:sessionId   — Bot page connects here to receive
  const recallMatch = pathname.match(/^\/ws\/recall-video\/([^/]+)$/);
  const relayMatch = pathname.match(/^\/ws\/video-relay\/([^/]+)$/);

  if (recallMatch || relayMatch) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      if (recallMatch) {
        handleRecallVideoConnection(ws, recallMatch[1]);
      } else {
        handleVideoRelayConnection(ws, relayMatch[1]);
      }
    });
  } else {
    socket.destroy();
  }
});

function getOrCreateSpeakerState(sessionId) {
  if (!speakerState.has(sessionId)) {
    speakerState.set(sessionId, { active: new Set(), lastSpeaker: null });
  }
  return speakerState.get(sessionId);
}

function handleRecallVideoConnection(ws, sessionId) {
  console.log(`[ws] Recall video connected for session ${sessionId.slice(0, 8)}`);

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const state = getOrCreateSpeakerState(sessionId);

      if (msg.event === "participant_events.speech_on") {
        const pid = msg.data?.data?.participant?.id;
        if (pid != null) {
          state.active.add(pid);
          state.lastSpeaker = pid;
        }
        return;
      }

      if (msg.event === "participant_events.speech_off") {
        const pid = msg.data?.data?.participant?.id;
        if (pid != null) state.active.delete(pid);
        return;
      }

      if (msg.event !== "video_separate_png.data") return;

      const frame = msg.data?.data;
      if (!frame?.buffer) return;

      const pid = frame.participant?.id;
      const shouldRelay =
        state.active.size === 0
          ? pid === state.lastSpeaker || state.lastSpeaker === null
          : state.active.has(pid);
      if (!shouldRelay) return;

      const relay = {
        participantId: pid,
        participantName: frame.participant?.name,
        type: frame.type,
        buffer: frame.buffer,
      };
      const relayStr = JSON.stringify(relay);

      const clients = videoRelayClients.get(sessionId);
      if (clients) {
        for (const client of clients) {
          if (client.readyState === 1) {
            client.send(relayStr);
          }
        }
      }
    } catch {
      // ignore malformed messages
    }
  });

  ws.on("close", () => {
    console.log(`[ws] Recall video disconnected for session ${sessionId.slice(0, 8)}`);
  });
}

function handleVideoRelayConnection(ws, sessionId) {
  console.log(`[ws] Bot page video relay connected for session ${sessionId.slice(0, 8)}`);

  if (!videoRelayClients.has(sessionId)) {
    videoRelayClients.set(sessionId, new Set());
  }
  videoRelayClients.get(sessionId).add(ws);

  ws.on("close", () => {
    const clients = videoRelayClients.get(sessionId);
    if (clients) {
      clients.delete(ws);
      if (clients.size === 0) videoRelayClients.delete(sessionId);
    }
    console.log(`[ws] Bot page video relay disconnected for session ${sessionId.slice(0, 8)}`);
  });
}

// ---------------------------------------------------------------------------
// Session pipeline
// ---------------------------------------------------------------------------

async function runSessionPipeline(
  session,
  avatar,
  meetingUrl,
  botName,
  maxDuration,
  systemPrompt,
  meetingPassword
) {
  const { apiKey, baseUrl } = session.runway;

  const log = (msg) => {
    const ts = new Date().toISOString().slice(11, 23);
    session.logs.push(`[${ts}] ${msg}`);
    console.log(`[${session.id.slice(0, 8)}] ${msg}`);
  };

  try {
    // If a systemPrompt (personality override) was provided, patch the custom
    // avatar before creating the session so the character uses the updated
    // personality for this meeting.
    if (systemPrompt && avatar.type === "custom" && avatar.avatarId) {
      log("Applying personality override to character...");
      try {
        await runwayFetch(baseUrl, apiKey, `/v1/avatars/${avatar.avatarId}`, {
          method: "PATCH",
          body: { personality: systemPrompt },
        });
        log("Personality updated — waiting for character to be ready...");

        // Poll until the avatar is READY again (PATCH triggers re-processing)
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          await sleep(2000);
          const a = await runwayFetch(baseUrl, apiKey, `/v1/avatars/${avatar.avatarId}`);
          if (a.status === "READY") { log("Character is ready"); break; }
          if (a.status === "FAILED") throw new Error(`Character processing failed: ${a.failure || ""}`);
        }
      } catch (patchErr) {
        // Non-fatal: log and continue with existing personality
        log(`Warning: could not apply personality override — ${patchErr.message}`);
      }
    } else if (systemPrompt && avatar.type !== "custom") {
      log("Note: personality override is only supported for custom characters — using preset defaults");
    }

    log("Creating Runway realtime session...");
    const created = await runwayFetch(
      baseUrl,
      apiKey,
      "/v1/realtime_sessions",
      {
        method: "POST",
        body: {
          model: "gwm1_avatars",
          avatar,
          maxDuration: maxDuration || 300,
        },
      }
    );
    session.runwaySessionId = created.id;
    log(`Runway session created: ${created.id}`);

    session.status = "polling";
    log("Waiting for avatar to be ready...");
    let sessionKey;
    for (let i = 0; i < 90; i++) {
      const s = await runwayFetch(
        baseUrl,
        apiKey,
        `/v1/realtime_sessions/${created.id}`
      );
      if (s.status === "READY") {
        sessionKey = s.sessionKey;
        break;
      }
      if (s.status === "FAILED" || s.status === "CANCELLED") {
        throw new Error(`Session ${s.status}: ${s.failure || ""}`);
      }
      await sleep(2000);
    }
    if (!sessionKey)
      throw new Error("Timed out waiting for session to be ready");
    log("Avatar is ready");

    session.status = "consuming";
    log("Getting LiveKit credentials...");
    const creds = await runwayFetch(
      baseUrl,
      apiKey,
      `/v1/realtime_sessions/${created.id}/consume`,
      { method: "POST", bearerToken: sessionKey }
    );
    session.liveKit = { url: creds.url, token: creds.token };
    log(`LiveKit room: ${creds.roomName}`);

    session.status = "bot_joining";
    const botPageUrl = `${PUBLIC_URL}/bot.html?session=${session.id}`;
    log(`Creating Recall bot → ${meetingUrl}`);
    log(`Video relay: ${WS_PUBLIC_URL}/ws/recall-video/${session.id}`);
    const bot = await createRecallBot(
      meetingUrl,
      botName,
      botPageUrl,
      session.id,
      meetingPassword
    );
    session.recallBotId = bot.id;
    log(`Recall bot created: ${bot.id}`);

    session.status = "active";
    log("Avatar is live in the meeting!");
  } catch (err) {
    session.status = "failed";
    session.error = err.message;
    log(`Error: ${err.message}`);
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

  if (session.runwaySessionId && session.runway) {
    log("Cancelling Runway session...");
    try {
      await runwayFetch(
        session.runway.baseUrl,
        session.runway.apiKey,
        `/v1/realtime_sessions/${session.runwaySessionId}`,
        { method: "DELETE" }
      );
    } catch {
      // best-effort
    }
  }

  // Clean up relay clients and speaker state
  videoRelayClients.delete(session.id);
  speakerState.delete(session.id);

  session.status = "ended";
  log("Session ended");
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

httpServer.listen(parseInt(PORT), () => {
  console.log(`\n  Calliope Meet server running on http://localhost:${PORT}`);
  console.log(`  Public URL: ${PUBLIC_URL}`);
  console.log(`  WebSocket URL: ${WS_PUBLIC_URL}`);
  console.log(`  Recall region: ${RECALL_REGION}\n`);
});
