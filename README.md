# Wizard Mail

One inbox for the Google and Microsoft accounts connected on a Wizard. See `wizard.md` for what it does.

- `app/server.py` owner page + API + MCP (stdlib), `app/sources.py` talks to the source apps' box-only
  `wizard.mail-calendar/1` API, `app/sanitize.py` cleans HTML mail, `web/` the view on the Wizard kit,
  `web/connect.js` the in-app connect sheet (also used by Calendar).
- Tests: `python3 -m unittest discover -s tests` (fake source apps; nothing talks to Google, Microsoft or Composio).
- After any source edit: `python3 tools/package.py` (the Runtipi recipe inlines the source).

Badge and Wizard inbox: Mail's icon shows how many unread emails wait in your inboxes (the newest 50 at most), and `GET /wizard-mail/api/inbox` lists those same emails so Wizard can show them as a badge or as items in Chats. Opening an item opens that email in Mail; reading it removes it.
