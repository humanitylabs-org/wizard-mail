"""Mail's on-box store: stock Stalwart, with Gmail and Outlook imported into it (wizard-mail#35; on for everyone
since Mail 0.13.0, its switch `on-box-store` is gone).

Stalwart runs next to Mail as the stock image (service `wizard-mail-store` in runtipi/docker-compose.yml) and is
reachable only on the Wizard app network, never published: the box is only on the tailnet. Mail talks to it over JMAP
as the one owner mailbox, signing in with the store's own admin secret (a file Stalwart's start writes in Mail's /data
on its first start; never logged, never returned).

- Import: every connected Google and Microsoft account is copied in, folder by folder (Inbox, Archive, Sent, Trash),
  newest first, then the older mail page by page until all of it is in. Each copy is built from what the source app
  gives (`mail_get` with the HTML, and every file and inline picture through `mail_attachment`) and carries its
  account and provider id, so Reply, Archive, Delete and Send keep working on the provider, which stays the place
  that sends and receives mail (and keeps its own copy: importing deletes nothing there).
- Keeps syncing: every check reads the newest pages again, imports new mail and carries read state and folder moves
  over. What the owner does in Mail is written to the store at once too.
- Reading: once an account is fully imported, the owner's lists (without a search) and the reader come from the store.
  Until then, for searches, Drafts, agents (whose access level the source app enforces) and whenever the store does
  not answer, Mail reads Gmail and Outlook directly.
Stdlib only.
"""
import base64
import datetime
import email.policy
import email.utils
import hashlib
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from email.message import EmailMessage
from pathlib import Path

RETIRED_SWITCH = 'on-box-store'  # on for everyone since Mail 0.13.0; a saved state for it is cleared
DEFAULT_URL = 'http://wizard-mail-store:8080'
DEFAULT_SECRET = '/data/store/secret'
DOMAIN = 'mail.wizard.internal'
USER = 'owner'
STATE_FILE = 'store-sync.json'
FOLDERS = ('inbox', 'archive', 'sent', 'trash')     # imported; Drafts stay at the provider (they are sent from there)
EXCLUSIVE = ('inbox', 'archive', 'trash')           # a message is in one of these; Sent comes on top
TITLES = {'inbox': 'Inbox', 'archive': 'Archive', 'sent': 'Sent', 'trash': 'Trash'}
ID_HEADER = 'X-Wizard-Mail-Id'      # "<account key> <provider id>" on every copy
PART_HEADER = 'X-Wizard-Part'       # the provider's part id of a file the copy could not fetch (opened from there)
STORE_PART = 'wzs.'                 # part ids Mail hands out for files read from the store
HEAD_PAGES = 2                      # newest pages read again on every check
PAGE = 25
CHECK_S = 120                       # between checks once everything is in
BUSY_S = 3                          # between checks while older mail is still being imported
CHECK_BUDGET_S = 90                 # older mail imported per check, so new mail is never kept waiting long
MAX_RAW = 60 * 1024 * 1024   # one copy as uploaded (18-25 MB of files, base64)
MAX_FILE = 36 * 1024 * 1024
BLOB = re.compile(r'[A-Za-z0-9_-]{1,200}')
RECONCILE_S = 15 * 60                # how often a whole Inbox is compared with the provider's
RECONCILE_MAX = 5000                # messages compared at most (Inboxes bigger than this: the newest are)
LISTENERS_KEPT = ('http',)          # the plain JMAP listener on the app network; the rest are switched off


class StoreError(Exception):
    pass


def keyword(key, pid):
    """The keyword that finds a copy again (Stalwart does not search custom headers)."""
    return '$wz' + hashlib.sha256(f'{key}\n{pid}'.encode()).hexdigest()[:28]


def utc(value):
    try:
        moment = datetime.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except (TypeError, ValueError):
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=datetime.timezone.utc)
    return moment.astimezone(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


class Store:
    """The Stalwart JMAP API on the app network, as the owner's one mailbox."""

    def __init__(self, url=DEFAULT_URL, secret_file=DEFAULT_SECRET, timeout=30):
        self.url, self.secret_file, self.timeout = (url or DEFAULT_URL).rstrip('/'), secret_file or DEFAULT_SECRET, timeout
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.lock = threading.Lock()
        self.account = None
        self.boxes = {}   # (account key, folder) -> mailbox id

    # ---------- plumbing ----------
    def _secret(self):
        try:
            value = Path(self.secret_file).read_text().strip()
        except OSError:
            raise StoreError('The mail store has not started yet.') from None
        if not re.fullmatch(r'[0-9a-f]{32,128}', value):
            raise StoreError('The mail store has not started yet.')
        return value

    def _http(self, method, path, data=None, ctype='application/json', user=None, limit=MAX_RAW):
        login = user or f'{USER}@{DOMAIN}%admin'   # the store's admin, signed in as the owner's mailbox
        auth = base64.b64encode(f'{login}:{self._secret()}'.encode()).decode()
        request = urllib.request.Request(self.url + path, data=data, method=method,
                                         headers={'Authorization': 'Basic ' + auth, 'Content-Type': ctype, 'Accept': 'application/json'})
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                raw = response.read(limit + 1)
        except urllib.error.HTTPError as error:
            error.close()
            raise StoreError(f'The mail store answered {error.code}.') from None
        except (urllib.error.URLError, OSError, TimeoutError):
            raise StoreError('The mail store is not reachable.') from None
        if len(raw) > limit:
            raise StoreError('That is too big for the mail store.')
        return raw

    def _call(self, calls, admin=False):
        using = ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'] if admin else ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail']
        method_calls = []
        for i, (name, args) in enumerate(calls):
            if not admin:
                args = {'accountId': self.account, **args}
            method_calls.append([name, args, str(i)])
        raw = self._http('POST', '/jmap/', json.dumps({'using': using, 'methodCalls': method_calls}).encode(),
                         user='admin' if admin else None)
        try:
            answers = json.loads(raw)['methodResponses']
        except (ValueError, KeyError, TypeError):
            raise StoreError('The mail store gave an answer Mail could not read.') from None
        out = []
        for answer in answers:
            if not isinstance(answer, list) or len(answer) < 2 or answer[0] == 'error':
                raise StoreError('The mail store refused: ' + str((answer[1] if len(answer) > 1 else {}).get('type', 'error'))[:80])
            out.append(answer[1])
        return out

    # ---------- setting up ----------
    def ready(self):
        """Make sure the owner's mailbox exists (and only the JMAP listener is on); remember its account id."""
        with self.lock:
            if self.account:
                return self.account
            domains, accounts, listeners = self._call([('x:Domain/get', {'properties': ['name']}),
                                                       ('x:Account/get', {'properties': ['name', 'emailAddress']}),
                                                       ('x:NetworkListener/get', {'properties': ['name']})], admin=True)
            create = []
            domain = next((d['id'] for d in domains.get('list') or [] if d.get('name') == DOMAIN), None)
            if not domain:
                create.append(('x:Domain/set', {'create': {'d': {'name': DOMAIN}}}))
            if not any(a.get('emailAddress') == f'{USER}@{DOMAIN}' for a in accounts.get('list') or []):
                create.append(('x:Account/set', {'create': {'a': {'@type': 'User', 'name': USER, 'domainId': domain or '#d'}}}))
            extra = [x['id'] for x in listeners.get('list') or [] if x.get('name') not in LISTENERS_KEPT]
            if extra:   # SMTP, IMAP, POP3, Sieve and HTTPS are not needed: Mail is the only client (applies on restart)
                create.append(('x:NetworkListener/set', {'destroy': extra}))
            if create:
                for answer in self._call(create, admin=True):
                    if answer.get('notCreated') or answer.get('notDestroyed'):
                        raise StoreError('The mail store could not set up the mailbox.')
            session = json.loads(self._http('GET', '/jmap/session'))
            account = (session.get('primaryAccounts') or {}).get('urn:ietf:params:jmap:mail')
            if not isinstance(account, str) or not account:
                raise StoreError('The mail store has no mailbox yet.')
            self.account = account
            return account

    def mailbox(self, key, folder):
        """The store folder for one account's folder (`<account key>/<Folder>`), created on first use."""
        self.ready()
        with self.lock:
            if (key, folder) in self.boxes:
                return self.boxes[(key, folder)]
        found = self._call([('Mailbox/get', {'properties': ['name', 'parentId']})])[0].get('list') or []
        parent = next((m['id'] for m in found if m.get('name') == key and not m.get('parentId')), None)
        if not parent:
            answer = self._call([('Mailbox/set', {'create': {'p': {'name': key}}})])[0]
            parent = ((answer.get('created') or {}).get('p') or {}).get('id')
            if not parent:
                raise StoreError('The mail store could not make a folder.')
        boxes = {m['name']: m['id'] for m in found if m.get('parentId') == parent}
        missing = {f: {'name': TITLES[f], 'parentId': parent} for f in FOLDERS if TITLES[f] not in boxes}
        if missing:
            answer = self._call([('Mailbox/set', {'create': missing})])[0]
            for f, made in (answer.get('created') or {}).items():
                boxes[TITLES[f]] = made['id']
        with self.lock:
            for f in FOLDERS:
                if TITLES[f] in boxes:
                    self.boxes[(key, f)] = boxes[TITLES[f]]
            if (key, folder) not in self.boxes:
                raise StoreError('The mail store could not make a folder.')
            return self.boxes[(key, folder)]

    def folders_of(self, key, mailbox_ids):
        with self.lock:
            return [f for f in FOLDERS if self.boxes.get((key, f)) in (mailbox_ids or {})]

    # ---------- copies ----------
    def find(self, key, pids):
        """{provider id: {'id', 'folders', 'unread'}} for the given ids already in the store."""
        pids = list(dict.fromkeys(pids))
        if not pids:
            return {}
        for f in FOLDERS:
            self.mailbox(key, f)
        out = {}
        for start in range(0, len(pids), 100):
            chunk = pids[start:start + 100]
            words = {keyword(key, p): p for p in chunk}
            query, got = self._call([
                ('Email/query', {'filter': {'operator': 'OR', 'conditions': [{'hasKeyword': w} for w in words]}, 'limit': 500}),
                ('Email/get', {'#ids': {'resultOf': '0', 'name': 'Email/query', 'path': '/ids'},
                               'properties': ['keywords', 'mailboxIds']})])
            for item in got.get('list') or []:
                for w in (item.get('keywords') or {}):
                    if w in words:
                        out[words[w]] = {'id': item['id'], 'folders': self.folders_of(key, item.get('mailboxIds')),
                                         'unread': not (item.get('keywords') or {}).get('$seen')}
        return out

    def put(self, key, pid, raw, folders, unread, date=None):
        """Import one message (RFC 5322 bytes) into the account's folders; returns the store's id."""
        raw = f'{ID_HEADER}: {key} {pid}\r\n'.encode() + raw
        blob = json.loads(self._http('POST', f'/jmap/upload/{self.ready()}/', raw, 'message/rfc822')).get('blobId')
        if not isinstance(blob, str):
            raise StoreError('The mail store did not take the message.')
        keywords = {keyword(key, pid): True}
        if not unread:
            keywords['$seen'] = True
        entry = {'blobId': blob, 'mailboxIds': {self.mailbox(key, f): True for f in folders}, 'keywords': keywords}
        if utc(date):
            entry['receivedAt'] = utc(date)
        answer = self._call([('Email/import', {'emails': {'m': entry}})])[0]
        made = (answer.get('created') or {}).get('m')
        if not made:
            raise StoreError('The mail store did not take the message.')
        return made['id']

    def set_state(self, key, email_id, folders=None, unread=None):
        patch = {}
        if folders is not None:
            patch['mailboxIds'] = {self.mailbox(key, f): True for f in folders}
        if unread is not None:
            patch['keywords/$seen'] = None if unread else True
        if patch:
            self._call([('Email/set', {'update': {email_id: patch}})])

    def folder_state(self, key, folder):
        """{provider id: {'id', 'folders', 'unread'}} for every copy in one of the account's folders."""
        box, out, position = self.mailbox(key, folder), {}, 0
        while True:
            query, got = self._call([
                ('Email/query', {'filter': {'inMailbox': box}, 'position': position, 'limit': 500}),
                ('Email/get', {'#ids': {'resultOf': '0', 'name': 'Email/query', 'path': '/ids'},
                               'properties': ['keywords', 'mailboxIds', f'header:{ID_HEADER}:asText']})])
            for item in got.get('list') or []:
                tag_key, _, pid = str(item.get(f'header:{ID_HEADER}:asText') or '').strip().partition(' ')
                if pid and tag_key == key:
                    out[pid] = {'id': item['id'], 'folders': self.folders_of(key, item.get('mailboxIds')),
                                'unread': not (item.get('keywords') or {}).get('$seen')}
            ids = query.get('ids') or []
            if len(ids) < 500:
                return out
            position += len(ids)

    # ---------- reading ----------
    def list(self, keys, folder, position=0, limit=25, unread=False):
        """Newest first: ([summary], next position or None). folder 'all' = every imported folder."""
        boxes = [self.mailbox(k, f) for k in keys for f in (FOLDERS if folder == 'all' else (folder,))]
        where = {'inMailbox': boxes[0]} if len(boxes) == 1 else {'operator': 'OR', 'conditions': [{'inMailbox': b} for b in boxes]}
        if unread:
            where = {'operator': 'AND', 'conditions': [where, {'notKeyword': '$seen'}]}
        query, got = self._call([
            ('Email/query', {'filter': where, 'sort': [{'property': 'receivedAt', 'isAscending': False}],
                             'position': position, 'limit': limit + 1}),
            ('Email/get', {'#ids': {'resultOf': '0', 'name': 'Email/query', 'path': '/ids'},
                           'properties': ['from', 'to', 'cc', 'subject', 'receivedAt', 'preview', 'keywords', 'mailboxIds',
                                          'threadId', f'header:{ID_HEADER}:asText']})])
        order = {eid: i for i, eid in enumerate((query.get('ids') or [])[:limit])}
        rows = sorted((m for m in got.get('list') or [] if m.get('id') in order), key=lambda m: order[m['id']])
        out = [self._summary(m) for m in rows]
        more = len(query.get('ids') or []) > limit
        return [m for m in out if m], (position + limit if more else None)

    def _summary(self, m):
        tag = str(m.get(f'header:{ID_HEADER}:asText') or '').strip()
        key, _, pid = tag.partition(' ')
        if not pid:
            return None
        people = lambda xs: [{'name': x.get('name') or '', 'email': x.get('email') or ''} for x in xs or [] if isinstance(x, dict)]
        sender = people(m.get('from'))
        labels = [f.upper() for f in self.folders_of(key, m.get('mailboxIds'))]
        return {'id': pid, 'thread_id': m.get('threadId'), 'from': sender[0] if sender else {'name': '', 'email': ''},
                'to': people(m.get('to')), 'cc': people(m.get('cc')), 'subject': m.get('subject') or '',
                'date': m.get('receivedAt'), 'snippet': m.get('preview') or '',
                'unread': not (m.get('keywords') or {}).get('$seen'), 'labels': labels, 'store_account': key}

    def message(self, key, pid):
        """One copy as the source contract's mail_get message (format html), or None when it is not in the store."""
        hit = self.find(key, [pid]).get(pid)
        if not hit:
            return None
        props = ['from', 'to', 'cc', 'subject', 'receivedAt', 'preview', 'keywords', 'mailboxIds', 'threadId', 'messageId',
                 f'header:{ID_HEADER}:asText', 'bodyValues', 'htmlBody', 'textBody', 'attachments']
        got = self._call([('Email/get', {'ids': [hit['id']], 'properties': props, 'fetchHTMLBodyValues': True,
                                         'fetchTextBodyValues': True, 'maxBodyValueBytes': 0,
                                         'bodyProperties': ['partId', 'blobId', 'size', 'name', 'type', 'cid', 'disposition',
                                                            f'header:{PART_HEADER}:asText']})])[0]
        found = (got.get('list') or [None])[0]
        if not found:
            return None
        summary = self._summary(found) or {}
        values = found.get('bodyValues') or {}
        texts = lambda parts, kind: '\n'.join(values.get(p.get('partId'), {}).get('value', '') for p in parts or []
                                              if str(p.get('type') or '').startswith(kind) and p.get('partId') in values)
        files, inline = [], []
        seen = set()
        for p in (found.get('attachments') or []) + [p for p in found.get('htmlBody') or [] if not str(p.get('type') or '').startswith('text/')]:
            blob = p.get('blobId')
            if not blob or blob in seen:
                continue
            seen.add(blob)
            missing = p.get(f'header:{PART_HEADER}:asText')
            part = str(missing).strip() if missing else STORE_PART + blob
            entry = {'part': part, 'mime': str(p.get('type') or 'application/octet-stream').lower(), 'size': p.get('size') or 0,
                     'content_id': p.get('cid') or None, 'inline': p.get('disposition') == 'inline'}
            if p.get('name'):
                files.append({'name': p['name'], **entry})
            elif p.get('cid'):
                inline.append({k: entry[k] for k in ('part', 'mime', 'size', 'content_id')})
        ids = found.get('messageId') or []
        return {**summary, 'body_text': texts(found.get('textBody'), 'text/plain'), 'truncated': False,
                'body_html': texts(found.get('htmlBody'), 'text/html'), 'attachments': files[:50], 'inline_parts': inline[:50],
                'message_id_header': f'<{ids[0]}>' if ids else ''}

    def file(self, key, pid, part):
        """(name, mime, bytes) of a file in a copy; part is the STORE_PART id Mail handed out."""
        blob = part[len(STORE_PART):]
        if not part.startswith(STORE_PART) or not BLOB.fullmatch(blob):
            return None
        message = self.message(key, pid)
        entry = next((a for a in (message or {}).get('attachments', []) + (message or {}).get('inline_parts', [])
                      if a['part'] == part), None)
        if not entry:
            return None
        data = self._http('GET', f'/jmap/download/{self.ready()}/{blob}/file', limit=MAX_FILE)
        return entry.get('name') or 'file', entry['mime'], data


# ---------- the copy of one message, from a source app ----------
def _clean(value, limit=2000):
    return re.sub(r'[\r\n\x00]+', ' ', str(value or ''))[:limit]


def _address(person):
    if not isinstance(person, dict) or not person.get('email'):
        return None
    return email.utils.formataddr((_clean(person.get('name'), 200), _clean(person.get('email'), 320)))


def rebuild(message, fetch):
    """RFC 5322 bytes for a message from mail_get (format html). fetch(part) gives a file's bytes or None; a file
    that could not be fetched becomes a small note naming the provider's part, which Mail then opens from there."""
    out = EmailMessage(policy=email.policy.SMTP)
    sender = _address(message.get('from'))
    if sender:
        out['From'] = sender
    for header, field in (('To', 'to'), ('Cc', 'cc')):
        people = [a for a in map(_address, message.get(field) or []) if a]
        if people:
            out[header] = ', '.join(people)
    out['Subject'] = _clean(message.get('subject'), 1000)
    try:
        moment = datetime.datetime.fromisoformat(str(message.get('date')).replace('Z', '+00:00'))
        out['Date'] = email.utils.format_datetime(moment if moment.tzinfo else moment.replace(tzinfo=datetime.timezone.utc))
    except (TypeError, ValueError):
        pass
    mid = _clean(message.get('message_id_header'), 900).strip()
    if re.fullmatch(r'<[^<>\s]{1,900}>', mid):
        out['Message-ID'] = mid
    out.set_content(str(message.get('body_text') or ''))
    if message.get('body_html'):
        out.add_alternative(str(message['body_html']), subtype='html')
    files = [dict(a, inline=bool(a.get('inline'))) for a in message.get('attachments') or [] if isinstance(a, dict)]
    files += [dict(p, inline=True, name=None) for p in message.get('inline_parts') or [] if isinstance(p, dict)]
    for item in files:
        part = str(item.get('part') or '')
        mime = str(item.get('mime') or 'application/octet-stream').lower()
        maintype, _, subtype = mime.partition('/')
        if not re.fullmatch(r'[a-z0-9.+-]+', maintype or '') or not re.fullmatch(r'[a-z0-9.+-]+', subtype or ''):
            maintype, subtype = 'application', 'octet-stream'
        data = fetch(part) if part else None
        name = _clean(item.get('name'), 200) or None
        if data is None:
            out.add_attachment(f'This file stays at the provider (part {part}).'.encode(), maintype='application',
                               subtype='octet-stream', filename=name or 'file')
            added = out.get_payload()[-1]
            added[PART_HEADER] = _clean(part, 1000)
        else:
            out.add_attachment(data, maintype=maintype, subtype=subtype, filename=name,
                               disposition='inline' if item['inline'] else 'attachment')
            added = out.get_payload()[-1]
        if item.get('content_id'):
            added['Content-ID'] = '<' + _clean(item['content_id'], 900).strip('<>') + '>'
    return out.as_bytes()


class Sync:
    """Copies every connected account into the store and keeps it in step."""

    def __init__(self, mailbox, store, data_dir, clock=time.time, sleep=None):
        self.mailbox, self.store, self.clock = mailbox, store, clock
        self.path = Path(data_dir) / STATE_FILE
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.sleep = sleep or (lambda s: self.wake.wait(s))
        self.last = {}
        self.reconciled = {}   # account key -> when its whole Inbox was last compared with the provider's
        self.state = self._load()

    # ---- progress on the box: per account and folder, where the import of older mail stands ----
    def _load(self):
        try:
            state = json.loads(self.path.read_text())
        except (OSError, ValueError):
            state = {}
        if not isinstance(state, dict) or not isinstance(state.get('accounts'), dict):
            state = {'accounts': {}}
        return state

    def _save(self):
        tmp = self.path.with_name('.' + STATE_FILE + '.tmp')
        try:
            tmp.write_text(json.dumps(self.state))
            os.replace(tmp, self.path)
        except OSError:
            pass

    def _folder(self, key, folder):
        acct = self.state['accounts'].setdefault(key, {'folders': {}, 'imported': 0})
        return acct['folders'].setdefault(folder, {'token': None, 'started': False, 'done': False})

    def complete(self, key):
        """Is every imported folder of this account fully in the store? Only then does Mail read it from there."""
        with self.lock:
            acct = self.state['accounts'].get(key) or {}
            return all((acct.get('folders') or {}).get(f, {}).get('done') for f in FOLDERS)

    def status(self):
        with self.lock:
            accounts = {k: {'imported': a.get('imported', 0),
                            'complete': all((a.get('folders') or {}).get(f, {}).get('done') for f in FOLDERS)}
                        for k, a in self.state['accounts'].items()}
        return {'accounts': accounts, 'last': self.last}

    # ---- one check ----
    def check(self):
        import sources  # noqa: PLC0415 - the module that made this Sync's mailbox
        try:
            self.store.ready()
            targets = self.mailbox._targets('all', sources.OWNER)
        except StoreError as error:
            self.last = {'state': 'paused', 'reason': str(error), 'at': self.clock()}
            return False
        except sources.MailError as error:
            self.last = {'state': 'paused', 'reason': error.message, 'at': self.clock()}
            return False
        busy = False
        until = self.clock() + CHECK_BUDGET_S
        for source, address in targets:
            key = f'{source.id}:{address}'
            try:
                for folder in FOLDERS:
                    self._head(source, address, key, folder)
                for folder in FOLDERS:
                    busy = self._older(source, address, key, folder, until) or busy
                if self.clock() - self.reconciled.get(key, 0) >= RECONCILE_S:
                    self._reconcile(source, address, key)
                    self.reconciled[key] = self.clock()
            except StoreError as error:
                self.last = {'state': 'paused', 'reason': str(error), 'at': self.clock()}
                return False
            except sources.MailError as error:
                self.last = {'state': 'paused', 'account': key, 'reason': error.message, 'at': self.clock()}
                continue
            finally:
                with self.lock:
                    self._save()
        self.last = {'state': 'importing' if busy else 'ok', 'at': self.clock()}
        return busy

    def _page(self, source, address, folder, token=None):
        import sources  # noqa: PLC0415
        args = {'account': address, 'folder': folder, 'max': PAGE}
        if token:
            args['page_token'] = token
        value = source.tool('mail_search', args, sources.OWNER)
        rows = [m for m in value.get('messages') or [] if isinstance(m, dict) and isinstance(m.get('id'), str)]
        return rows, value.get('next_page_token') or None

    def _head(self, source, address, key, folder):
        """The newest pages: new mail in, read state and moves carried over."""
        token = None
        for _ in range(HEAD_PAGES):
            rows, token = self._page(source, address, folder, token)
            changed = self._absorb(source, address, key, folder, rows)
            if not token or not changed:
                break
        with self.lock:
            spot = self._folder(key, folder)
            if not spot['started']:
                spot['started'] = True

    def _older(self, source, address, key, folder, until):
        """Older mail, page by page from where the last check stopped. True while some is still left."""
        with self.lock:
            spot = dict(self._folder(key, folder))
        if spot['done']:
            return False
        token, first = spot['token'], spot['token'] is None
        while self.clock() < until:
            rows, nxt = self._page(source, address, folder, token)
            self._absorb(source, address, key, folder, rows)
            with self.lock:
                place = self._folder(key, folder)
                place['token'] = nxt
                place['done'] = not nxt
                self._save()
            if not nxt:
                return False
            token, first = nxt, False
        return True

    def _absorb(self, source, address, key, folder, rows):
        """Import what is new on this page, update what changed. Returns whether anything did."""
        known = self.store.find(key, [m['id'] for m in rows])
        changed = False
        for m in rows:
            pid, unread = m['id'], m.get('unread') is True
            have = known.get(pid)
            if have:
                folders = self._folders(have['folders'], folder)
                if folders != have['folders'] or have['unread'] != unread:
                    self.store.set_state(key, have['id'], folders if folders != have['folders'] else None,
                                         unread if have['unread'] != unread else None)
                    changed = True
                continue
            raw = self._raw(source, address, pid)
            if raw is None:
                continue
            self.store.put(key, pid, raw, [folder], unread, m.get('date'))
            changed = True
            with self.lock:
                acct = self.state['accounts'].setdefault(key, {'folders': {}, 'imported': 0})
                acct['imported'] = acct.get('imported', 0) + 1
        return changed

    def _reconcile(self, source, address, key):
        """Compare the whole Inbox with the provider's: mail archived or read elsewhere (Gmail on the web, the
        Outlook app) leaves the store's Inbox or turns read, also when it is older than the newest pages."""
        everything = self._ids(source, address, False)
        unread = self._ids(source, address, True)
        if everything is None or unread is None:
            return
        listed, complete = everything
        unread_ids, unread_complete = unread
        for pid, have in self.store.folder_state(key, 'inbox').items():
            folders, flag = None, None
            if complete and pid not in listed:
                folders = self._folders(have['folders'], 'archive')
            if unread_complete and have['unread'] != (pid in unread_ids) and (pid in listed or not complete):
                flag = pid in unread_ids
            if folders is not None or flag is not None:
                self.store.set_state(key, have['id'], folders, flag)

    def _ids(self, source, address, unread_only):
        """(set of the provider's Inbox ids, whether that is all of them), ids only where the source offers it."""
        import sources  # noqa: PLC0415
        bulk = self.mailbox._bulk(source, sources.OWNER)
        found, token = set(), None
        while len(found) < RECONCILE_MAX:
            args = {'account': address, 'folder': 'inbox', 'max': sources.IDS_PAGE if bulk else PAGE}
            if bulk:
                args['ids_only'] = True
            if unread_only:
                args['unread_only'] = True
            if token:
                args['page_token'] = token
            value = source.tool('mail_search', args, sources.OWNER)
            if bulk:
                found |= {i for i in value.get('ids') or [] if isinstance(i, str)}
            else:
                found |= {m['id'] for m in value.get('messages') or [] if isinstance(m, dict) and isinstance(m.get('id'), str)
                          and (not unread_only or m.get('unread') is True)}
            token = value.get('next_page_token')
            if not token:
                return found, True
        return found, False

    @staticmethod
    def _folders(now, seen_in):
        if seen_in in EXCLUSIVE:
            return sorted({seen_in} | ({'sent'} & set(now)))
        return sorted(set(now) | {seen_in})

    def _raw(self, source, address, pid):
        import sources  # noqa: PLC0415
        value = source.tool('mail_get', {'account': address, 'id': pid, 'format': 'html'}, sources.OWNER)
        message = value.get('message') if isinstance(value.get('message'), dict) else None
        if not message:
            return None

        def fetch(part):
            if not sources.PART.fullmatch(part):
                return None
            try:
                got = source.tool('mail_attachment', {'account': address, 'id': pid, 'part': part}, sources.OWNER, timeout=120,
                                  limit=sources.MAX_ATTACHMENT_ANSWER)
                found = got.get('attachment') if isinstance(got.get('attachment'), dict) else {}
                data = base64.b64decode(str(found.get('base64') or ''), validate=False)
                return data if data or found.get('size') == 0 else None
            except (sources.MailError, ValueError):
                return None
        return rebuild(message, fetch)

    # ---- what the owner does in Mail, written to the store at once ----
    def mirror(self, key, pid, flags):
        try:
            have = self.store.find(key, [pid]).get(pid)
            if not have:
                return
            folders = None
            if flags.get('trashed') is True:
                folders = self._folders(have['folders'], 'trash')
            elif flags.get('archived') is True:
                folders = self._folders(have['folders'], 'archive')
            elif flags.get('trashed') is False or flags.get('archived') is False:
                folders = self._folders(have['folders'], 'inbox')
            unread = (not flags['read']) if isinstance(flags.get('read'), bool) else None
            self.store.set_state(key, have['id'], folders, unread)
        except StoreError:
            pass   # the next check carries it over from the provider

    def run(self):
        while True:
            busy = False
            try:
                busy = self.check()
            except Exception as error:  # noqa: BLE001 - one bad check must not stop the next ones
                self.last = {'state': 'paused', 'reason': type(error).__name__, 'at': self.clock()}
            self.wake.clear()
            self.sleep(BUSY_S if busy else CHECK_S)


class View:
    """What Mailbox asks before going to the providers: can the store answer this for the owner?"""

    def __init__(self, store, sync):
        self.store, self.sync = store, sync

    def serves(self, keys):
        return bool(keys) and all(self.sync.complete(k) for k in keys)

    def list(self, keys, folder, position, limit, unread):
        """[(key, summary)], next position; None when the store cannot answer (Mail then asks the providers)."""
        if folder not in FOLDERS + ('all',) or not self.serves(keys):
            return None
        try:
            rows, nxt = self.store.list(keys, folder, position, limit, unread)
        except StoreError:
            return None
        return [(m.pop('store_account'), m) for m in rows], nxt

    def message(self, key, pid):
        if not self.serves([key]):
            return None
        try:
            found = self.store.message(key, pid)
        except StoreError:
            return None
        if found:
            found.pop('store_account', None)
        return found

    def file(self, key, pid, part):
        try:
            return self.store.file(key, pid, part)
        except StoreError:
            return None

    def mirror(self, items, flags):
        """The owner's change in Mail, written to the store in the background: items [(key, pid)]."""
        if not items:
            return

        def run():
            for key, pid in items:
                self.sync.mirror(key, pid, flags)
        threading.Thread(target=run, daemon=True).start()
