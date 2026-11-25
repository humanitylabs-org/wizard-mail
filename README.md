# Wizard Mail

One inbox for the Google and Microsoft accounts connected on a Wizard. See `wizard.md` for what it does.

- `app/server.py` owner page + API + MCP (stdlib), `app/sources.py` talks to the source apps' box-only
  `wizard.mail-calendar/1` API, `app/sanitize.py` cleans HTML mail, `web/` the view on the Wizard kit,
  `web/connect.js` the in-app connect sheet (also used by Calendar).
- Tests: `python3 -m unittest discover -s tests` (fake source apps; nothing talks to Google, Microsoft or Composio).
- After any source edit: `python3 tools/package.py` (the Runtipi recipe inlines the source).

Badge and Wizard inbox: Mail's icon shows how many unread emails wait in your inboxes (the newest 50 at most), and `GET /wizard-mail/api/inbox` lists those same emails so Wizard can show them as a badge or as items in Chats. Opening an item opens that email in Mail; reading it removes it.


Mark all as read: the button centred at the top of the list (`POST /api/mark-all-read {account, folder, q}`, Undo = `POST /api/mark-read {items, read: false}`; MCP `mail_mark_all_read`) marks every unread message in the shown scope read at the provider, at most 500 per tap. Where the source app offers the bulk tools (wizard.mail-calendar 1.3: `mail_search ids_only` and `mail_update_bulk`, Gmail batchModify) that is one ids-only search per 500 and one bulk call per account per 1000 ids, for Mark all and its Undo; other sources (Outlook today) get one `mail_update` per message, 8 side by side. The button runs it in the background (`background: true` answers 202 with a job; `GET /api/mark-all-read?job=<id>` gives `{state, phase, done, total, result}`) and shows "Marking 120 of 500…".

Phone-first (0.4.0): on narrow windows Write, Search and Refresh sit in a bottom bar (Search turns it into the search field; ✕ or Back closes it), an open message has Reply, Archive and Delete in a bottom bar, the list shows the newest mail at the bottom and opens there (Load more on top; new mail never moves the list while you are scrolled up), swipe a row left to Archive or right to mark it read/unread (Undo in the toast; the reader's buttons do the same), and pull the list down to refresh. Inbox and Unread show the unread count from the badge list ('50+' when there is more). Wide windows stay newest-first from the top.

Agent inbox watcher (on for everyone since 0.12.0, its switch `agent-inbox-events` is gone; wizard-mail#26, wizard-agent-service#552): every 2 minutes Mail posts each new unread inbox email once to the Agent Service, `POST $MAIL_AGENT_SERVICE/wizard/v1/agent-inbox/events` (default `http://wizard-agent-service:8787`; optional `MAIL_AGENT_INBOX_TOKEN` sent as a Bearer app credential) with `{type: mail|payment_failed, source: {app: wizard-mail, item: <account>:<id>}, sender, title: subject, ask: snippet, link: /wizard-mail/#msg=..., privacy_class: private}`. Never the body. The watcher's first check takes the mail already waiting as seen, and mail older than two days is never posted. A 404 (the owner's `wizard/agent-inbox` is off), a refusal or an unreachable Service pauses posting until the next check, which tries the same mail again (the Service dedupes on source app + item). Handled keys live in `/data/agent-inbox.json`; `GET /api/agent-inbox` (owner) shows the last check.

Drafts waiting (0.5.2; since 0.5.3 behind the owner switch `drafts-waiting`, off by default, `GET/POST /api/switches`, wizard.app-switches/1, state in `/data/switches.json`): drafts an agent saves with `mail_draft` (or he saved himself) no longer hide in Drafts. Drafts shows a count in the side list and the folder chips, and the Inbox opens with a small "Drafts waiting for you" strip on top: who each goes to, its subject and account, and "by your agent" on the ones an agent wrote through Mail since it started (Mail keeps no data, so that mark is lost on a restart; the draft still shows). One tap opens a draft to edit and send; the strip's header opens Drafts. `GET /api/drafts?account=` (owner only) is the same request as the Drafts folder's first page and shares its cache.

Attachments (0.5.0): compose has an Attach chip (file picker, several files, or drop files on the sheet); each file shows as a chip with its size and ✕. Editing a draft changes that same draft in place (`draft_id`, from the source's `mail_get`) and keeps its files as removable chips; Forward carries the original's files (`attachments_from`). `POST /api/draft` and MCP `mail_draft` take `attachments: [{name, mime?, base64}]`, `draft_id`, `remove_attachments`, `attachments_from` (contract 1.2 in the Google/Microsoft apps' `docs/mail-calendar-contract.md`); at most 10 files and 18 MB together (Outlook: 3 MB per file), refused plainly above that (`files_too_big`). Mail's request cap is 26 MB for `/api/draft` and `/mcp` only. An older source app that would ignore the files gets `source_too_old` ("Update the Google app") instead of a draft without them.

Reply in chat (0.4.2): an open email has a Reply in chat chip (0.4.3: in the row under the sender beside Mark unread, at every width, so the phone bottom bar stays Reply / Archive / Delete) that opens an unsent Chats draft with the email attached through the shared `WizardApp.nav.openContextDraft` (shown only on shells that have it). The context comes with `GET /api/message` as `context` {id, title, message}, so the tap needs no fetch. It is called Reply in chat, not Reply, because Reply already answers the sender by email.

On-box store (owner switch `on-box-store`, off by default; wizard-mail#35, `app/store.py`): the recipe runs the stock
Stalwart image as `wizard-mail-store` next to Mail, on the app network only (no published port; its start turns off
every listener but plain JMAP on :8080 after the first setup). Its start writes the store's admin secret once to
`/data/store/secret` (in Mail's data dir, which both containers mount; Mail only reads it) and its RocksDB under
`/data/store/db`. With the switch on, Mail signs in as the one owner mailbox (`owner@mail.wizard.internal`, through
the admin as master user) and copies each connected account into `<account key>/Inbox|Archive|Sent|Trash`: the newest
two pages of each folder on every check (new mail, read state, moves), the older mail page by page from where it
stopped (progress in `/data/store-sync.json`), and every 15 minutes the whole Inbox is compared with the provider's
(ids only where offered) so mail archived or read elsewhere follows. Copies are rebuilt from `mail_get` (HTML) plus
every file and inline picture (`mail_attachment`); a file that could not be fetched becomes a note naming the
provider part, which the reader then opens from the provider. Each copy carries `X-Wizard-Mail-Id: <account> <id>`
and a `$wz…` keyword (to find it again), so every action keeps going to the provider by its own id; Mail writes the
owner's archive/delete/read to the store at once. Once an account is fully copied, the owner's lists without a search
(not Drafts), the reader and its files come from the store; searches, Drafts, agents (their access level is enforced
by the source app), the unread badge and any time the store does not answer go to the providers as before.
`GET /api/store` (owner) shows each account's progress and the last check.
