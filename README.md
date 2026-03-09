# Calliope Meet

Send a Runway avatar to any Zoom, Google Meet, or Teams meeting as a separate participant. The avatar hears what people say and responds with real-time video and audio.

Uses [Recall.ai](https://www.recall.ai/) to join meetings and [Runway's Realtime Avatars API](https://docs.dev.runwayml.com/api/#tag/Realtime-Sessions) (GWM-1 Avatars) for the avatar.

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
- A [Runway API key](https://app.runwayml.com/settings/api-keys)
- A [Recall.ai API key](https://www.recall.ai/)
- [ngrok](https://ngrok.com/) (or any tunneling tool) for local development

## Quick Start

```sh
# Clone and install
cd calliope-meet
npm install

# Set up environment
cp .env.example .env
# Edit .env with your API keys

# Start ngrok tunnel (in a separate terminal)
ngrok http 3000

# Copy the ngrok URL and set it as PUBLIC_URL in .env
# e.g. PUBLIC_URL=https://abc123.ngrok-free.app

# Start the server
npm start
```

Open http://localhost:3000, paste a meeting URL, pick an avatar, and click **Send Avatar to Meeting**.

## Environment Variables

| Variable | Description |
|---|---|
| `RUNWAY_API_KEY` | Your Runway API key |
| `RUNWAY_BASE_URL` | Runway API base URL (default: `https://api.dev.runwayml.com`) |
| `RECALL_API_KEY` | Your Recall.ai API key |
| `RECALL_REGION` | Recall.ai region (default: `us-west-2`) |
| `PUBLIC_URL` | Public URL where the server is reachable (ngrok URL for local dev) |
| `PORT` | Server port (default: `3000`) |

## Project Structure

```
calliope-meet/
├── server.js           # Express server — Runway & Recall API orchestration
├── public/
│   ├── index.html      # Control panel UI
│   └── bot.html        # Webpage rendered by Recall's bot (LiveKit + avatar)
├── .env.example
└── package.json
```

## Architecture

1. **Control panel** (`index.html`) — User enters a meeting URL and selects an avatar
2. **Server** (`server.js`) — Creates a Runway realtime session, polls until ready, consumes to get LiveKit credentials, then creates a Recall.ai bot pointing to `bot.html`
3. **Bot page** (`bot.html`) — Loaded by Recall's bot inside the meeting. Connects to the LiveKit room, captures meeting audio via `getUserMedia()` and publishes it so the avatar can hear participants. Renders the avatar's video and plays its audio, which Recall streams back into the meeting.
