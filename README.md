# Runway Characters Meet

Send a [Runway Character](https://runwayml.com/product/characters) to any Zoom, Google Meet, or Microsoft Teams meeting as a separate participant. The character hears what people say and responds with real-time video and audio.

## Try the Demo

**[runway-characters-meet-production.up.railway.app](https://runway-characters-meet-production.up.railway.app/)**

1. **Get a Runway API key** — sign up at [dev.runwayml.com](https://dev.runwayml.com), go to the **Manage** tab, and click **New API key**. You get 600 free credits (about 30 minutes of video).
2. **Paste your API key** into the app.
3. **Paste a meeting URL** — any Zoom, Google Meet, or Microsoft Teams link.
4. **Pick a character** from the preset list (or enter a custom character ID).
5. **Click "Send Character to Meeting"** — the character will join as a participant in about 30 seconds.

Once live, the character listens to the meeting audio and responds in real time. You can mute or end the session from the control panel.

## How It Works

```
Zoom / Meet / Teams
  ↕  Recall.ai bot joins as a participant
Recall bot runs a webpage (bot.html)
  ├─ Meeting audio → getUserMedia() → published to LiveKit room
  ├─ Runway character hears the meeting audio, generates response
  ├─ Character video → LiveKit → rendered on the page → bot's camera feed
  └─ Character audio → LiveKit → played on the page → bot's mic feed
```

Uses [Recall.ai](https://www.recall.ai/) to join meetings and [Runway's Characters API](https://docs.dev.runwayml.com/api/#tag/Realtime-Sessions) for the character.

## Run Locally

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- A [Recall.ai API key](https://www.recall.ai/)
- A [Runway API key](https://dev.runwayml.com) (each user enters their own in the UI)

### Setup

```sh
# Install dependencies
npm install

# Create your env file
cp .env.example .env
# Edit .env — add your Recall.ai API key

# Start a tunnel so Recall can reach your local server (separate terminal)
npx cloudflared tunnel --url http://localhost:3000

# Copy the tunnel URL and set PUBLIC_URL in .env
# e.g. PUBLIC_URL=https://my-tunnel-abc123.trycloudflare.com

# Start the server
npm start
```

Open [http://localhost:3000](http://localhost:3000), enter your Runway API key, paste a meeting URL, pick a character, and go.

## Deploy to Railway

The easiest way to share with others. Only the Recall.ai key lives on the server — each user enters their own Runway API key in the browser.

1. Push to GitHub
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
3. Set environment variables in Railway's dashboard:
   - `RECALL_API_KEY` — your Recall.ai API key
   - `RECALL_REGION` — `us-west-2` (or your region)
   - No need to set `PUBLIC_URL` — Railway is auto-detected
   - No need to set `PORT` — Railway sets it automatically
4. Deploy. Railway gives you a public URL.
5. Share the URL — users just need their own Runway API key.

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
│   └── bot.html        # Webpage rendered by Recall's bot (LiveKit + character)
├── .env.example
└── package.json
```

## Cost

- **Runway**: 600 free credits on sign-up (~30 min of video). Standard realtime session pricing after that (billed to each user's own API key).
- **Recall.ai**: ~$0.60/hour per bot (4-core variant for smooth audio).
