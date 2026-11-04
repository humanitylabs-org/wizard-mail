# Wizard Mail

One inbox for the Google and Microsoft accounts connected on a Wizard. See `wizard.md` for what it does.

- `app/server.py` owner page + API + MCP (stdlib), `app/sources.py` talks to the source apps' box-only
  `wizard.mail-calendar/1` API, `app/sanitize.py` cleans HTML mail, `web/` the view on the Wizard kit,
  `web/connect.js` the in-app connect sheet (also used by Calendar).
- Tests: `python3 -m unittest discover -s tests` (fake source apps; nothing talks to Google, Microsoft or Composio).
- After any source edit: `python3 tools/package.py` (the Runtipi recipe inlines the source).

Badge and Wizard inbox: Mail's icon shows how many unread emails wait in your inboxes (the newest 50 at most), and `GET /wizard-mail/api/inbox` lists those same emails so Wizard can show them as a badge or as items in Chats. Opening an item opens that email in Mail; reading it removes it.


Mark all as read: the button centred at the top of the list (`POST /api/mark-all-read {account, folder, q}`, Undo = `POST /api/mark-read {items, read: false}`; MCP `mail_mark_all_read`) marks every unread message in the shown scope read at the provider through the source apps' `mail_update`, side by side, at most 500 per tap.

Phone-first (0.4.0): on narrow windows Write, Search and Refresh sit in a bottom bar (Search turns it into the search field; ✕ or Back closes it), an open message has Reply, Archive and Delete in a bottom bar, the list shows the newest mail at the bottom and opens there (Load more on top; new mail never moves the list while you are scrolled up), swipe a row left to Archive or right to mark it read/unread (Undo in the toast; the reader's buttons do the same), and pull the list down to refresh. Inbox and Unread show the unread count from the badge list ('50+' when there is more). Wide windows stay newest-first from the top.

Reply in chat (0.4.2): an open email has a Reply in chat chip (0.4.3: in the row under the sender beside Mark unread, at every width, so the phone bottom bar stays Reply / Archive / Delete) that opens an unsent Chats draft with the email attached through the shared `WizardApp.nav.openContextDraft` (shown only on shells that have it). The context comes with `GET /api/message` as `context` {id, title, message}, so the tap needs no fetch. It is called Reply in chat, not Reply, because Reply already answers the sender by email.
