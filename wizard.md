---
wizard: 0.2
id: wizard-mail
name: Mail
type: service
category: app
version: 0.8.0
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
uses: [mail-calendar, wizard-google, wizard-microsoft, connected-accounts]
needs: []
health: /healthz
switches:
  contract: wizard.app-switches/1
  path: /api/switches
---

# Mail

Your email in Wizard: one inbox for every Google and Microsoft account you connect, or one account at a time.

- **Connect without leaving Mail.** Open Mail, tap Google or Microsoft, then Quick connect: one small window asks you to sign in to Composio (the first time; the key is saved by itself) and then to your mail account, and closes by itself. Or use your own Google or Microsoft app; its setup opens inside Mail.
- **Read safely.** Messages render in a locked frame without scripts; pictures from the internet stay hidden until you tap Show pictures, so senders cannot track when you open their mail.
- **Write, reply, forward.** Mail saves a draft in your mailbox, then sends it when you tap Send. Archive, delete (to Trash), mark unread, with Undo.
- **Reply in chat.** On an open email, Reply in chat opens a new, unsent Chats draft with that email attached (sender, date, subject and the start of its text), so you can ask your agent about it. Nothing is sent; it is named apart from Reply, which answers the sender by email.
- **Google through Connected accounts** (switch, off by default: Tracker Try it, `connected-accounts-google`). Gmail uses the Google app and accounts in Connected accounts: one Google app, one sign-in, no Composio. Connecting Google in Mail points you there; tap Allow next to Mail on the account (Connected accounts' `gmail-for-mail` switch on).
- **Connect Gmail from inside Mail** (switch, off by default: Tracker Try it, `connect-gmail-in-mail`; wizard-connectors#21). Connect your email → Google opens one sheet: Continue to Google, tap Allow on Google's screen, and the Gmail shows up. It goes through your Google app in Connected accounts (0.4.0 or later), which turns its Gmail for Mail on by itself; no other switch. Quick connect and your own Google app stay under Other ways.
- **Tell your agent about new mail** (switch, off by default: Tracker Try it, `agent-inbox-events`; wizard-mail#26). Each new email goes to your agent's inbox as a short note (sender, subject, one line of text, never the whole email), where the Agent Service's alert rules decide what reaches Alerts and what waits for the next sweep. Needs the agent inbox (`wizard/agent-inbox`) on.
- **Drafts waiting for you** (switch, off by default: Tracker Try it, `drafts-waiting`). A Drafts count in the side list and a strip on top of the Inbox with the drafts your agent wrote.
- **Mark all as read.** One button at the top of the list marks every unread message in what you are looking at (all inboxes or one account, Inbox or Archive, and your search) as read in Gmail or Outlook itself. Undo puts them back.
- **Phone and desktop.** One column on a phone; list and reader side by side, plus mailboxes, on a wide window.
- **Settings, like Messenger's.** Connected accounts as tiles (tap one to see or disconnect it, + to connect another) and Agent access: No access, Read-only or Draft only (recommended, the default).
- **Attachments.** Attach files when you write, reply or forward (Forward brings the original's files along); each file shows as a chip you can remove. Editing a draft keeps its attachments. Up to 10 files, 18 MB together (Outlook accounts: 3 MB per file for now).
- **For your agent:** `mail_accounts`, `mail_list`, `mail_read`, `mail_draft` (with attachments, or changing a draft in place) and `mail_mark_all_read` over MCP at `/mcp` (box only). The agent can write drafts but cannot send: you send from Mail. The Google and Microsoft apps enforce this themselves (their `mail_send` refuses agents), so it holds even when an agent calls them directly.

Mail keeps no sign-ins and no copies of your mail. It asks the Google and Microsoft apps (contract `wizard.mail-calendar/1`), which hold the sign-ins.
