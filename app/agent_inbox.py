"""Mail watcher for the agent inbox (owner switch `agent-inbox-events`, off by default; wizard-mail#26).

Mail is the first app watcher of the Agent Service's alert rules (wizard-agent-service#552): each new incoming mail is
posted once as a candidate event to `POST /wizard/v1/agent-inbox/events`, where the Service decides what reaches
Alerts and what waits for the next sweep. Only the subject, the sender and a short snippet leave Mail, never the body.

- New means: unread in an inbox and first seen after the switch went on. Turning the switch on takes the mail
  already waiting as seen (no flood of old mail); mail older than MAX_AGE_S is never posted.
- The same message posted again is the same record at the Service (source app + item), so a retry is safe.
- 404 (the owner's `wizard/agent-inbox` switch is off), a refusal or an unreachable Service: post nothing more
  until the next check; the unposted mail is tried again then.
Stdlib only.
"""
import datetime
import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

SWITCH = 'agent-inbox-events'
EVENTS_PATH = '/wizard/v1/agent-inbox/events'
DEFAULT_SERVICE = 'http://wizard-agent-service:8787'
CHECK_S = 120          # how often Mail looks for new mail (its unread snapshot refreshes every minute)
MAX_AGE_S = 2 * 86400  # older mail is never a candidate event
SEEN_MAX = 2000        # message keys remembered, newest last
SNIPPET_MAX = 200
STATE_FILE = 'agent-inbox.json'
PAYMENT_FAILED = re.compile(
    r'payment\s+(?:has\s+|was\s+)?(?:failed|declined|unsuccessful|could\s+not\s+be\s+processed)|failed\s+payment|'
    r'payment\s+failure|card\s+(?:was\s+|has\s+been\s+)?declined|unable\s+to\s+(?:process|charge)\s+your\s+(?:payment|card)',
    re.IGNORECASE)


def _clip(value, limit):
    return re.sub(r'\s+', ' ', str(value or '')).strip()[:limit]


def _epoch(value):
    try:
        return datetime.datetime.fromisoformat(str(value).replace('Z', '+00:00')).timestamp()
    except (TypeError, ValueError):
        return None


def message_key(m):
    return f"{m.get('account')}:{m.get('id')}"


def event_for(m):
    """The candidate event for one unread message (subject, sender and a short snippet; never the body)."""
    sender = m.get('from') if isinstance(m.get('from'), dict) else {}
    subject = _clip(m.get('subject'), 200) or '(no subject)'
    snippet = _clip(m.get('snippet') or m.get('preview'), SNIPPET_MAX)
    kind = 'payment_failed' if PAYMENT_FAILED.search(f'{subject}\n{snippet}') else 'mail'
    link = ('/wizard-mail/#msg=' + urllib.parse.quote(str(m.get('account')), safe='') + ':'
            + urllib.parse.quote(str(m.get('id')), safe=''))
    return {'type': kind, 'source': {'app': 'wizard-mail', 'item': message_key(m)[:300]},
            'sender': {'name': _clip(sender.get('name'), 120), 'email': _clip(sender.get('email'), 200)},
            'title': subject, 'ask': snippet or subject, 'link': link, 'privacy_class': 'private'}


class Watcher:
    def __init__(self, mailbox, data_dir, on, service=DEFAULT_SERVICE, token='', clock=time.time, post=None):
        self.mailbox, self.on, self.clock = mailbox, on, clock
        self.path = Path(data_dir) / STATE_FILE
        self.url = (service or DEFAULT_SERVICE).rstrip('/') + EVENTS_PATH
        self.token = token
        self.post = post or self._post
        self.lock = threading.Lock()
        self.last = {}

    # ---- state on the box: whether the watcher is armed, and the message keys already handled ----
    def _load(self):
        try:
            state = json.loads(self.path.read_text())
        except (OSError, ValueError):
            state = {}
        state = state if isinstance(state, dict) else {}
        seen = [k for k in state.get('seen') or [] if isinstance(k, str)]
        return {'armed': state.get('armed') is True, 'seen': seen}

    def _save(self, state):
        state['seen'] = state['seen'][-SEEN_MAX:]
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_name('.' + STATE_FILE + '.tmp')
            tmp.write_text(json.dumps(state))
            tmp.replace(self.path)
        except OSError:
            pass  # read-only or full data volume: the next check tries again (the Service dedupes repeats)

    def _post(self, event):
        headers = {'Content-Type': 'application/json', 'Accept': 'application/json'}
        if self.token:
            headers['Authorization'] = f'Bearer {self.token}'
        request = urllib.request.Request(self.url, json.dumps(event).encode(), headers, method='POST')
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status
        except urllib.error.HTTPError as error:
            return error.code
        except (OSError, ValueError):
            return 0  # unreachable

    def check(self):
        """One look for new mail. Returns what happened (also kept in self.last)."""
        with self.lock:
            state = self._load()
            if not self.on():
                if state['armed']:  # off again: the next switch-on starts from the mail waiting then
                    state['armed'] = False
                    self._save(state)
                self.last = {'state': 'off'}
                return self.last
            try:
                messages, _more = self.mailbox.unread(wait=30)
            except Exception:  # noqa: BLE001 - sources down or still loading: try at the next check
                self.last = {'state': 'no_mail_yet'}
                return self.last
            seen = set(state['seen'])
            if not state['armed']:
                state['seen'] += [message_key(m) for m in messages if message_key(m) not in seen]
                state['armed'] = True
                self._save(state)
                self.last = {'state': 'armed', 'waiting': len(messages)}
                return self.last
            posted, paused = 0, None
            now = self.clock()
            for m in reversed(messages):  # oldest first
                key = message_key(m)
                if key in seen:
                    continue
                at = _epoch(m.get('date'))
                if at is not None and now - at > MAX_AGE_S:
                    state['seen'].append(key)
                    seen.add(key)
                    continue
                status = self.post(event_for(m))
                if 200 <= status < 300 or status in (400, 413, 422):
                    # Taken, or an event the Service will never take: don't send it again.
                    state['seen'].append(key)
                    seen.add(key)
                    posted += 200 <= status < 300
                    continue
                paused = 'agent_inbox_off' if status == 404 else 'unreachable' if status == 0 else f'refused_{status}'
                break  # post nothing more until the next check
            self._save(state)
            self.last = {'state': 'paused' if paused else 'ok', 'posted': posted, **({'reason': paused} if paused else {})}
            return self.last

    def run(self, every=CHECK_S, stop=None):
        stop = stop or threading.Event()
        while not stop.wait(every):
            try:
                self.check()
            except Exception:  # noqa: BLE001 - the watcher never takes Mail down
                pass
