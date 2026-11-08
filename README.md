# Conference Desk

A local conference outreach workspace for Oasis Simulations. The home screen shows upcoming events, outreach progress, sends, replies, and remaining contacts. Open an event to see the ranked roster, draft messages, or queue the next batch.

## Run

Requires Node.js 22.12+.

```sh
npm ci
npm run build
npm start
```

Open [Conference Desk](http://127.0.0.1:4173). The server binds to loopback. The dashboard opens without a login. For development, run `npm run dev`.

The workspace and saved connections live in the ignored `.data/` folder. If `.data/import-conferences.json` exists, a fresh workspace starts with that historical import. Back up this folder locally if you want to preserve conference data and pending sends. It contains contact data and connection secrets.

## Host a private workspace

Run one Node process on a VM with a service manager such as systemd. Build with `npm ci` and `npm run build`, then run `npm start` as an unprivileged user. The process listens on `127.0.0.1:4173`. Use an authenticated SSH tunnel to reach the dashboard from your browser. Keep the dashboard port off public ingress because the dashboard can read your roster and operate your mailbox.

Set `CONFERENCE_DATA_DIR` to a private directory on persistent disk. To use Supabase instead, apply the SQL migration in `supabase/migrations/`, set `CONFERENCE_DATABASE_URL` to a direct or session-pooler connection URI, and set `CONFERENCE_SECRETS_KEY` to 32 random bytes encoded as base64. Keep the same key in the host’s secret store between deployments. If the database requires a separate trusted root, set `CONFERENCE_DATABASE_CA` to its PEM certificate. The database connection holds a lock so only one worker can use a workspace. The migration keeps the state table outside the public API and the server encrypts saved connector credentials.

Start a hosted instance with an empty data directory to set up connections from scratch. If moving a workspace, stop the original worker before importing data with scheduled sends. Apply connector secrets on the host and authorize Gmail and Apollo from that instance. Local Codex credentials are separate from the hosted process.

## From an event to an email batch

1. Click **Add conference**, enter the event name and edition or its public link, then click **Find attendees**. The crawler checks public rosters, programs, and speaker pages. For a wider search, open **Research & sources → Expand with Autumn** and optionally describe the roles and evidence you want it to prioritize. Discovered contacts are added and ranked automatically.
2. Import a CSV, TSV, or pasted list when the public pages lack a roster. A `Name` column is enough. Add `Title`, `Company`, `Email`, `Attendance`, `LinkedIn`, and `Source URL` when available. Review uncertain addresses in the contact editor.
3. Review the green direct fits and yellow potential introducers. The default ICP starts with commissioning delivery and field readiness. Update the rules from **Your ICP**. Apollo and Autumn enrichment are explicit actions under **Research & sources**.
4. Click **Write drafts** to review text locally, or **Populate Gmail drafts** to prepare eligible text and open it in Gmail. The writer adapts the opener to the available evidence and uses a conditional meeting ask for unconfirmed attendees. **Polish with Codex** optionally revises the personalization paragraph using the local ChatGPT-backed Codex login.
5. Click **Schedule next batch** from the dashboard or send queue. Select conferences, choose 5–10 emails, and review each recipient, conference, draft, and time. The preview works before Gmail is connected. Confirm from the connected inbox to book the slots. The **Schedule** button on a conference plans only for that event.

Direct fits go first, then potential introducers. Within each fit group, the planner rotates conferences and chooses the strongest eligible match for a shared recipient. It keeps confirmed slots fixed and fills open morning and afternoon slots starting the next Chicago calendar day. The same inbox has at least five minutes between sends. Existing outreach, queued sends, and Gmail drafts can reserve a recipient across events.

Keep the server running and the Mac awake through scheduled sends. The app uses a local persistent queue for delivery through Gmail. A send more than 15 minutes past its slot is held for review. The worker checks for prior Gmail outreach, reconciles known sends, and holds ambiguous attempts. **Sync Gmail** checks tracked threads for direct replies. In **Send queue**, use **Pending & held**, **Sent**, and **Replies** to find the conference, sender, recipient, actual timestamp, and Gmail conversation. Cancel a pending send there to free its slot and recipient for a future batch.

## Connections

- **Gmail.** Enable Gmail API in Google Cloud and create a Web application OAuth client. Copy `.env.example` to `.env`, set the client ID and client secret, and register the exact local redirect URI from Connections. Restart and click **Connect Gmail**. Add your mailbox as a test user if the OAuth app is in Testing. Testing-mode authorization for Gmail expires after seven days. [Google's setup guide](https://developers.google.com/workspace/gmail/api/auth/web-server)
- **Apollo, Autumn, and Exa.** Conference Desk checks the local Codex MCP servers on startup. Open **Connections** to check their status. Use **Connect with MCP** for Apollo, approve access in the provider tab, then click **Check MCP connection**. Exa can search through its public MCP endpoint and Autumn uses the local Codex configuration. You can save an API key under **API key fallback**. Provider credits are separate from Codex.
- **Apollo waterfall.** In an active conference, open **Research & sources → Review Apollo enrichment**. When the Apollo MCP account has work-email waterfall enabled, the review starts at one eligible contact. Check the names and credit guidance, choose up to ten contacts, then approve the lookup. Apollo publishes typical usage of 1–4 credits per contact. Some configurations can use 20 or more, including charges from vendors that find no email. The MCP server offers no guaranteed pre-run quote. Results and any reported usage appear under **Apollo waterfall results**. Verified work emails are added to eligible roster contacts. **Refresh results** only reads approved requests. [Apollo credit pricing](https://docs.apollo.io/docs/api-pricing) · [Result polling](https://docs.apollo.io/reference/poll-webhook-result)
- **Codex.** Run `codex login` and choose ChatGPT to use your subscription for optional draft polish. Then click **Check local sign-in** in Connections. The research bridge calls provider tools directly through Codex App Server. [Codex authentication](https://learn.chatgpt.com/docs/auth) · [Codex App Server](https://learn.chatgpt.com/docs/app-server)

Public pages often list speakers without publishing general attendees. The app keeps those categories separate and records where each discovered name came from. Import a roster you have access to when the organizer's list is gated, embedded in images, or available only as a document.

## Checks

```sh
npm test
npx playwright install chromium
npx playwright test
```

On a Mac with Chrome installed, run `PLAYWRIGHT_CHANNEL=chrome npx playwright test` to use it directly. The browser test creates a disposable local workspace.
