# Runway Characters Meet

Send a Runway avatar to any Zoom, Google Meet, or Teams meeting as a separate participant. The avatar hears what people say and responds with real-time video and audio.

Uses [Recall.ai](https://www.recall.ai/) to join meetings and [Runway's Realtime Avatars API](https://docs.dev.runwayml.com/api/#tag/Realtime-Sessions) (GWM-1 Avatars) for the avatar.

Demo: https://runway-characters-meet-production.up.railway.app/

## How It Works

```
Zoom / Meet / Teams
  ↕  Recall.ai bot joins as a participant
Recall bot runs a webpage (bot.html)
  ├─ Meeting audio → getUserMedia() → published to LiveKit room
  ├─ Runway avatar hears the meeting audio, generates response
  ├─ Avatar video → LiveKit → rendered on the page → bot's camera feed
  └─ Avatar audio → LiveKit → played on the page → bot's mic feed
```

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- A [Recall.ai API key](https://www.recall.ai/)
- A [Runway API key](https://app.runwayml.com/settings/api-keys) (each user enters their own in the UI)

## Local Development

```sh
npm install

cp .env.example .env
# Edit .env — add your Recall.ai API key

# Start a tunnel (separate terminal)
npx cloudflared tunnel --url http://localhost:3000

# Set PUBLIC_URL in .env to the tunnel URL
# e.g. PUBLIC_URL=https://my-tunnel-abc123.trycloudflare.com

npm start
```

Open http://localhost:3000, enter your Runway API key, paste a meeting URL, pick an avatar, and go.

## Deploy to Railway

The easiest way to share with colleagues. Only the Recall.ai key lives on the server — each user enters their own Runway API key in the browser.

1. Push to GitHub
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
3. Set environment variables in Railway's dashboard:
   - `RECALL_API_KEY` — your Recall.ai API key
   - `RECALL_REGION` — `us-west-2` (or your region)
   - No need to set `PUBLIC_URL` — Railway is auto-detected
   - No need to set `PORT` — Railway sets it automatically
4. Deploy. Railway gives you a public URL like `calliope-meet-production.up.railway.app`
5. Share the URL with colleagues — they just need their own Runway API key

## Environment Variables

| Variable | Where | Description |
|---|---|---|
| `RECALL_API_KEY` | Server `.env` | Recall.ai API key (shared) |
| `RECALL_REGION` | Server `.env` | Recall.ai region (default: `us-west-2`) |
| `PUBLIC_URL` | Server `.env` | How Recall reaches this server (auto-detected on Railway) |
| `PORT` | Server `.env` | Server port (default: `3000`, auto-set on Railway) |
| Runway API Key | Browser UI | Each user enters their own — saved in localStorage |

## Project Structure

```
calliope-meet/
├── server.js           # Express server — Runway & Recall API orchestration
├── public/
│   ├── index.html      # Control panel UI (users enter Runway key here)
│   └── bot.html        # Webpage rendered by Recall's bot (LiveKit + avatar)
├── .env.example
└── package.json
```

## Cost

- **Recall.ai**: ~$0.60/hour per bot (4-core variant for smooth audio)
- **Runway**: Standard realtime session pricing (billed to each user's own API key)
