# AITuber Content Autopilot V3 — Existing Videos

This version does NOT generate new AITuber videos.

It works with videos already present in the AITuber account:

1. List existing videos
2. Detect completed videos
3. Request MP4 export
4. Poll export status
5. Get a fresh signed MP4 download URL
6. Show connected channels
7. Provide a publication API proxy

## Render environment variable

Keep your existing Render variable:

AITUBER_API_KEY = your existing AITuber API key

Do not put the API key in this repository.

## Important

AITuber's current API documentation says video generation spends credits, while MP4 export itself is free. Downloading requires the account to have had a paid plan at least once.

Publishing/scheduling requires an active Creator-or-higher plan and at least one connected channel.

## Deploy

Replace server.js and package.json in the existing Render/GitHub project, then deploy.

No new API key is required.
