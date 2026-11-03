---
wizard: 0.2
id: wizard-mail
name: Mail
type: service
category: app
version: 0.3.0
icon: icon.png
summary: One inbox for the Google and Microsoft accounts on your Wizard. Connect from inside Mail; read, search, write and send.
tags: [communication, productivity]
license: GPL-3.0-only
source: https://github.com/oscarhenrycollins/wizard-mail
runtime:
  kind: runtipi
  config: runtipi/config.json
  compose: runtipi/docker-compose.yml
api:
  port: 18818
  path: /api
  spec: openapi.json
mcp:
  path: /mcp
  port: 18818
  transport: streamable-http
skill: skill/SKILL.md
view:
  path: /
  port: 18818
  source:
    path: web
    build: python3 app/build_view.py
    dist: web
provides: [mail]
system: false
uses: [mail-calendar, wizard-google, wizard-microsoft]
needs: []
health: /healthz
---

# Mail

Your email in Wizard: one inbox for every Google and Microsoft account you connect, or one account at a time.

- **Connect without leaving Mail.** Open Mail, tap Google or Microsoft, then Quick connect: one small window asks you to sign in to Composio (the first time; the key is saved by itself) and then to your mail account, and closes by itself. Or use your own Google or Microsoft app; its setup opens inside Mail.
- **Read safely.** Messages render in a locked frame without scripts; pictures from the internet stay hidden until you tap Show pictures, so senders cannot track when you open their mail.
- **Write, reply, forward.** Mail saves a draft in your mailbox, then sends it when you tap Send. Archive, delete (to Trash), mark unread, with Undo.
- **Mark all as read.** One button at the top of the list marks every unread message in what you are looking at (all inboxes or one account, Inbox or Archive, and your search) as read in Gmail or Outlook itself. Undo puts them back.
- **Phone and desktop.** One column on a phone; list and reader side by side, plus mailboxes, on a wide window.
- **Settings, like Messenger's.** Connected accounts as tiles (tap one to see or disconnect it, + to connect another) and Agent access: No access, Read-only or Draft only (recommended, the default).
- **For your agent:** `mail_accounts`, `mail_list`, `mail_read`, `mail_draft` and `mail_mark_all_read` over MCP at `/mcp` (box only). The agent can write drafts but cannot send: you send from Mail. The Google and Microsoft apps enforce this themselves (their `mail_send` refuses agents), so it holds even when an agent calls them directly.

Mail keeps no sign-ins and no copies of your mail. It asks the Google and Microsoft apps (contract `wizard.mail-calendar/1`), which hold the sign-ins.
