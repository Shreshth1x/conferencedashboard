# Conference Desk

A conference outreach workspace for Oasis Simulations. The home screen shows upcoming events, outreach progress, sends, replies, and remaining contacts. Open an event to see the ranked roster, draft messages, or queue the next batch.

## Run

Requires Node.js 22.12+.

```sh
npm ci
npm run build
npm start
```

Open [Conference Desk](http://127.0.0.1:4173). The server binds to loopback. The dashboard opens without a login. For development, run `npm run dev`.

The workspace and saved connections live in the ignored `.data/` folder. If `.data/import-conferences.json` exists, a fresh workspace starts with that historical import. Back up this folder locally if you want to preserve conference data and pending sends. It contains contact data and connection secrets.

## Hosted workspace

Open [Conference Desk on GitHub Pages](https://shreshth1x.github.io/conferencedashboard/). Sign in with the workspace owner's Google account, then connect each sending inbox in **Connections**. Choose a sender when you preview a batch. Approved emails stay assigned to that inbox.

GitHub Pages serves the frontend. The existing Supabase project hosts the private API, encrypted mailbox connections, and send queue. Supabase Cron checks for due work every minute and calls the Edge Function, so the dashboard and Mac can be closed. Gmail test accounts may need to reconnect after seven days. The hosted workspace starts with its own data. The local version still uses the local workspace unless explicitly configured for PostgreSQL.

The Pages workflow builds the static interface from `main`. Deploy backend changes with `supabase functions deploy desk --project-ref <project-ref> --use-api` after applying migrations. Configure `DESK_SITE_URL`, `DESK_OWNER_EMAIL`, the Gmail OAuth settings, and a stable `CONFERENCE_SECRETS_KEY` as Edge secrets. Set the same worker token in `DESK_CRON_SECRET` and Vault's `desk_cron_secret`. Add the Supabase URL in Vault under `desk_project_url`.

The hosted app includes Exa public search links and roster import. Save an Autumn API key in **Connections** to discover or enrich contacts. Hosted Apollo uses its server-side MCP with a master key and keeps the per-batch credit approval. ChatGPT-backed draft polish runs in the local app.

## From an event to an email batch

1. Click **Add conference**, enter the event name and edition or its public link, then click **Find attendees**. The crawler checks public rosters, programs, and speaker pages. For a wider search, open **Research & sources → Expand with Autumn** and optionally describe the roles and evidence you want it to prioritize. Discovered contacts are added and ranked automatically.
2. Import a CSV, TSV, or pasted list when the public pages lack a roster. A `Name` column is enough. Add `Title`, `Company`, `Email`, `Attendance`, `LinkedIn`, and `Source URL` when available. Review uncertain addresses in the contact editor.
3. Review the green direct fits and yellow potential introducers. The default ICP starts with commissioning delivery and field readiness. Update the rules from **Your ICP**. Apollo and Autumn enrichment are explicit actions under **Research & sources**.
4. Click **Write drafts** to review text locally, or **Populate Gmail drafts** to prepare eligible text and open it in Gmail. The writer adapts the opener to the available evidence and uses a conditional meeting ask for unconfirmed attendees. **Polish with Codex** optionally revises the personalization paragraph using the local ChatGPT-backed Codex login.
5. Click **Schedule next batch** from the dashboard or send queue. Select conferences, choose 5–10 emails, and review each recipient, conference, draft, and time. The preview works before Gmail is connected. Confirm from the connected inbox to book the slots. The **Schedule** button on a conference plans only for that event.

Direct fits go first, then potential introducers. Within each fit group, the planner rotates conferences and chooses the strongest eligible match for a shared recipient. It keeps confirmed slots fixed and fills open morning and afternoon slots starting the next Chicago calendar day. The same inbox has at least five minutes between sends. Existing outreach, queued sends, and Gmail drafts can reserve a recipient across events.

The hosted queue runs through Supabase. When using the local dashboard, keep the server running and the Mac awake through scheduled sends. A send more than 15 minutes past its slot is held for review. The worker checks for prior Gmail outreach, reconciles known sends, and holds ambiguous attempts. **Sync Gmail** checks tracked threads for direct replies. In **Send queue**, use **Pending & held**, **Sent**, and **Replies** to find the conference, sender, recipient, actual timestamp, and Gmail conversation. Cancel a pending send there to free its slot and recipient for a future batch.

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
