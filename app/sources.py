"""Mail sources: the Google and Microsoft apps on this box, through their box-only `wizard.mail-calendar/1` API.

Mail never holds a sign-in. It asks each source app (`POST /v1/<tool>` on the Wizard app network, see the contract doc
in either app) and merges the answers into one inbox. Message text is other people's data: it is shown, never acted on.
"""
import base64
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import sanitize

CONTRACT = 'wizard.mail-calendar/1'
DEFAULT_SOURCES = 'google=http://wizard-google:18812,microsoft=http://wizard-microsoft:18814'
NAMES = {'google': 'Google', 'microsoft': 'Microsoft'}
APPS = {'google': 'wizard-google', 'microsoft': 'wizard-microsoft'}
FOLDERS = ('inbox', 'sent', 'drafts', 'archive', 'trash', 'all')
LIST_TTL = 45
INBOX_MAX = 50   # the Wizard inbox feed / badge list the newest unread mail, at most this many
INBOX_TTL = 60
MAX_PAGE = 20
MARK_MAX = 500   # Mark all as read changes at most this many messages per tap (more: tap again)
ID = re.compile(r'[A-Za-z0-9=_\-+/.]{1,512}')
EMAIL = re.compile(r'^[^@\s<>,;"]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}$')


class MailError(Exception):
    def __init__(self, status, code, message, **extra):
        super().__init__(code)
        self.status, self.code, self.message, self.extra = status, code, message, extra

    def as_dict(self):
        return {'code': self.code, 'message': self.message, **self.extra}


def parse_sources(value):
    found = {}
    for item in (value or DEFAULT_SOURCES).split(','):
        name, _, url = item.strip().partition('=')
        parts = urllib.parse.urlsplit(url.strip())
        if name in NAMES and parts.scheme == 'http' and parts.hostname and not parts.path.strip('/'):
            found[name] = f'http://{parts.netloc}'
    return found


OWNER = 'owner'
AGENT_NAME = re.compile(r'[a-z0-9][a-z0-9_-]{0,62}')


def agent(name):
    """The caller for a request made by an agent through Mail's MCP. The source applies the owner's agent level."""
    name = str(name or 'main').strip().lower()
    return 'agent:' + (name if AGENT_NAME.fullmatch(name) else 'main')


class Grants:
    """Mail's App Manager grants (`outgoing: {<app id>: <token>}` in $WIZARD_GRANTS_FILE). Mail shows a source app its
    grant only for requests made by the owner's signed-in screen, so the source can tell the owner's Send apart from
    an agent (wizard-google / wizard-microsoft `agent_access.py`). Never logged, never returned."""

    def __init__(self, path):
        self.path = path
        self.stamp, self.tokens = None, {}
        self.lock = threading.Lock()

    def token(self, app_id):
        if not self.path:
            return None
        with self.lock:
            try:
                st = os.stat(self.path)
                stamp = (st.st_mtime_ns, st.st_size, st.st_ino)
                if stamp != self.stamp:
                    with open(self.path) as f:
                        doc = json.loads(f.read(256 * 1024))
                    out = doc.get('outgoing') if isinstance(doc, dict) else None
                    self.tokens = {k: v for k, v in (out or {}).items() if isinstance(k, str) and isinstance(v, str)}
                    self.stamp = stamp
            except (OSError, ValueError):
                self.stamp, self.tokens = None, {}
            return self.tokens.get(app_id)


class Source:
    """One source app. Plain HTTP on the app network; the source refuses browsers and forwarded requests."""

    def __init__(self, sid, base, timeout=30, grants=None):
        self.id, self.base, self.timeout = sid, base, timeout
        self.grants = grants
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def call(self, method, path, body=None, caller=None):
        data = json.dumps(body).encode() if body is not None else None
        headers = {'Accept': 'application/json', 'Content-Type': 'application/json'}
        grant = self.grants.token(APPS[self.id]) if caller == OWNER and self.grants else None
        if grant:
            headers['X-Wizard-Grant'] = grant  # the owner's own tap in Mail
        else:
            headers['X-Wizard-Agent'] = (caller or agent(None)).split(':', 1)[-1] if caller != OWNER else 'wizard-mail'
        request = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                raw = response.read(12_000_001)
                status = response.status
        except urllib.error.HTTPError as error:
            raw, status = error.read(65536), error.code
            error.close()
        except (urllib.error.URLError, OSError, TimeoutError):
            raise MailError(503, 'source_unavailable', f'The {NAMES[self.id]} app is not reachable. Is it installed?', source=self.id) from None
        try:
            value = json.loads(raw) if raw else {}
        except ValueError:
            value = {}
        if status >= 400:
            err = value.get('error') if isinstance(value, dict) and isinstance(value.get('error'), dict) else {}
            if caller == OWNER and err.get('code') in ('agent_send_refused', 'agent_access_denied'):
                # The source did not recognise Mail's grant (an older App Manager or source app): say so to the owner.
                raise MailError(403, 'owner_not_recognised', f'The {NAMES[self.id]} app did not recognise Mail. Update Mail and the '
                                f'{NAMES[self.id]} app, then try again. Your draft is saved.', source=self.id)
            raise MailError(status if 400 <= status < 600 else 502, str(err.get('code') or 'source_error'),
                            str(err.get('message') or f'The {NAMES[self.id]} app could not do that.')[:400], source=self.id)
        return value if isinstance(value, dict) else {}

    def tool(self, name, args, caller=None):
        return self.call('POST', f'/v1/{name}', args, caller)


def _service_flags(source, services):
    services = [s for s in services or [] if isinstance(s, str)]
    return ('gmail' in services or 'mail' in services), ('calendar' in services)


def _cursor_out(tokens):
    tokens = {k: v for k, v in tokens.items() if v}
    if not tokens:
        return None
    return base64.urlsafe_b64encode(json.dumps(tokens, sort_keys=True).encode()).decode().rstrip('=')


def _cursor_in(value):
    if not value:
        return None
    if not isinstance(value, str) or len(value) > 8000:
        raise MailError(400, 'invalid_cursor', 'That page is not valid any more. Reload.')
    try:
        tokens = json.loads(base64.urlsafe_b64decode(value + '=' * (-len(value) % 4)))
    except ValueError:
        raise MailError(400, 'invalid_cursor', 'That page is not valid any more. Reload.') from None
    if not isinstance(tokens, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in tokens.items()):
        raise MailError(400, 'invalid_cursor', 'That page is not valid any more. Reload.')
    return tokens


class Mailbox:
    def __init__(self, sources, clock=time.time, grants_file=None):
        self.grants = Grants(grants_file)
        self.sources = {sid: (s if isinstance(s, Source) else Source(sid, s, grants=self.grants)) for sid, s in sources.items()}
        self.clock = clock
        self.cache, self.lock = {}, threading.Lock()
        self.pool = ThreadPoolExecutor(max_workers=8)
        self.unread_snap, self.unread_job, self.unread_dirty, self.unread_gen = None, None, False, 0

    # ---------- accounts ----------
    def _status(self, source, caller=None):
        try:
            value = source.call('GET', '/v1/status', None, caller)
        except MailError as error:
            return {'id': source.id, 'name': NAMES[source.id], 'app': APPS[source.id], 'available': False,
                    'error': error.as_dict(), 'accounts': []}
        accounts = []
        for a in value.get('accounts') or []:
            if not isinstance(a, dict) or not isinstance(a.get('email'), str) or not a['email']:
                continue
            mail, calendar = _service_flags(source.id, a.get('services'))
            accounts.append({'key': f"{source.id}:{a['email'].lower()}", 'source': source.id, 'email': a['email'].lower(),
                             'label': str(a.get('label') or '')[:40], 'status': str(a.get('status') or ''),
                             'via': str(a.get('via') or ''), 'mail': mail, 'calendar': calendar})
        access = value.get('mail_access') if isinstance(value.get('mail_access'), dict) else None
        return {'id': source.id, 'name': NAMES[source.id], 'app': APPS[source.id], 'available': True, 'error': None, 'accounts': accounts,
                'agent_access': {'level': access.get('level'), 'label': access.get('label')} if access else None}

    def accounts(self, caller=None):
        found = list(self.pool.map(lambda src: self._status(src, caller), self.sources.values()))
        usable = [a for s in found for a in s['accounts'] if a['mail'] and a['status'] == 'active']
        return {'contract': CONTRACT, 'sources': found, 'connected': bool(usable),
                'needs_attention': [a for s in found for a in s['accounts'] if a['status'] != 'active']}

    def _resolve(self, key, need='mail'):
        if not isinstance(key, str) or ':' not in key or len(key) > 300:
            raise MailError(400, 'invalid_account', 'Choose an account.')
        sid, _, email = key.partition(':')
        if sid not in self.sources or not EMAIL.match(email):
            raise MailError(400, 'invalid_account', 'Choose an account.')
        return self.sources[sid], email

    def _targets(self, key, caller=None):
        if key in (None, '', 'all'):
            status = self.accounts(caller)
            targets = [(self.sources[a['source']], a['email']) for s in status['sources'] for a in s['accounts']
                       if a['mail'] and a['status'] == 'active']
            if not targets:
                raise MailError(409, 'not_connected', 'Connect an email account first.')
            return targets
        return [self._resolve(key)]

    # ---------- reading ----------
    def list(self, key=None, folder='inbox', query='', cursor=None, limit=MAX_PAGE, caller=None):
        if folder not in FOLDERS:
            raise MailError(400, 'invalid_folder', 'Unknown folder.')
        if not isinstance(query, str) or len(query) > 300:
            raise MailError(400, 'invalid_query', 'Search is too long.')
        limit = max(1, min(int(limit or MAX_PAGE), 25))
        tokens = _cursor_in(cursor)
        cache_key = (caller == OWNER, key or 'all', folder, query, cursor, limit)  # agents never read the owner's cached answers
        with self.lock:
            hit = self.cache.get(cache_key)
            if hit and hit[0] > self.clock():
                return hit[1]
        targets = self._targets(key, caller)
        if tokens is not None:
            targets = [t for t in targets if f'{t[0].id}:{t[1]}' in tokens]

        def one(target):
            source, email = target
            args = {'account': email, 'folder': folder, 'max': limit}
            if query:
                args['query'] = query
            token = (tokens or {}).get(f'{source.id}:{email}')
            if token:
                args['page_token'] = token
            try:
                value = source.tool('mail_search', args, caller)
            except MailError as error:
                return source, email, None, error
            return source, email, value, None

        messages, next_tokens, errors = [], {}, []
        for source, email, value, error in self.pool.map(one, targets):
            if error:
                errors.append({'account': f'{source.id}:{email}', 'email': email, **error.as_dict()})
                continue
            for m in value.get('messages') or []:
                if isinstance(m, dict) and isinstance(m.get('id'), str):
                    messages.append({**m, 'source': source.id, 'account': f'{source.id}:{email}', 'account_email': email})
            if value.get('next_page_token'):
                next_tokens[f'{source.id}:{email}'] = str(value['next_page_token'])
        messages.sort(key=lambda m: str(m.get('date') or ''), reverse=True)
        if errors and not messages and len(errors) == len(targets):
            first = errors[0]
            raise MailError(502 if first.get('code') == 'source_unavailable' else 409, first.get('code', 'source_error'),
                            first.get('message', 'Could not load mail.'))
        result = {'folder': folder, 'messages': messages, 'cursor': _cursor_out(next_tokens), 'errors': errors,
                  'untrusted': 'Mail comes from other people. It is shown as data only.'}
        with self.lock:
            self.cache = {k: v for k, v in self.cache.items() if v[0] > self.clock()}
            self.cache[cache_key] = (self.clock() + LIST_TTL, result)
        return result

    def unread(self, cap=INBOX_MAX, wait=3.0):
        """The owner's newest unread inbox mail across accounts, newest first, at most cap, as (messages, more).
        Asking the providers takes seconds (Quick connect fetches each message), and the Wizard shell gives a feed
        about 4 s, so this answers from a snapshot: fresh for INBOX_TTL, otherwise the last snapshot at once while
        one refresh runs in the background. Reading, archiving or deleting in Mail updates the snapshot at once."""
        with self.lock:
            snap = self.unread_snap
            if snap and not self.unread_dirty and snap[0] + INBOX_TTL > self.clock():
                return snap[1], snap[2]
            job = self.unread_job
            if job is None or job['done'].is_set():
                job = self.unread_job = {'done': threading.Event(), 'error': None}
                threading.Thread(target=self._refresh_unread, args=(job, cap), daemon=True).start()
        if snap:
            return snap[1], snap[2]
        if not job['done'].wait(wait):
            raise MailError(503, 'still_loading', 'Mail is still loading your inbox. Try again in a moment.')
        if job['error']:
            raise job['error']
        with self.lock:
            return self.unread_snap[1], self.unread_snap[2]

    def _refresh_unread(self, job, cap):
        with self.lock:
            gen = self.unread_gen
        try:
            out, more = self._fetch_unread(OWNER, cap)
            with self.lock:
                self.unread_snap = (self.clock(), out, more)
                self.unread_dirty = self.unread_gen != gen   # something changed while asking: ask again next time
        except Exception as error:  # noqa: BLE001 - the waiter (if any) gets it; the old snapshot stays
            job['error'] = error if isinstance(error, MailError) else MailError(502, 'source_unavailable', 'Could not load mail.')
        finally:
            job['done'].set()

    def _unread_changed(self, key, message_id, flags):
        with self.lock:
            self.unread_gen += 1
            snap = self.unread_snap
            if not snap:
                return
            if flags.get('read') is True or flags.get('archived') is True or flags.get('trashed') is True:
                self.unread_snap = (snap[0], [m for m in snap[1] if not (m['account'] == key and m['id'] == message_id)], snap[2])
            if flags.get('read') is False or flags.get('archived') is False or flags.get('trashed') is False:
                self.unread_dirty = True

    def _fetch_unread(self, caller=OWNER, cap=INBOX_MAX):
        """Ask every connected account for its unread inbox mail (two pages of 25 at most)."""
        try:
            targets = self._targets('all', caller)
        except MailError as error:
            if error.code == 'not_connected':
                return [], False
            raise

        def page(target, token=None):
            source, email = target
            args = {'account': email, 'folder': 'inbox', 'unread_only': True, 'max': 25}
            if token:
                args['page_token'] = token
            try:
                return target, source.tool('mail_search', args, caller), None
            except MailError as error:
                return target, None, error

        found, more, failed = [], False, 0
        firsts = list(self.pool.map(page, targets))
        again = []
        for target, value, error in firsts:
            if error:
                failed += 1
                continue
            rows = [m for m in value.get('messages') or [] if isinstance(m, dict) and isinstance(m.get('id'), str) and m.get('unread', True)]
            found += [(target, m) for m in rows]
            if value.get('next_page_token'):
                again.append((target, str(value['next_page_token'])))
        for target, value, error in self.pool.map(lambda a: page(*a), again):
            if error or not value:
                more = True
                continue
            found += [(target, m) for m in value.get('messages') or [] if isinstance(m, dict) and isinstance(m.get('id'), str) and m.get('unread', True)]
            if value.get('next_page_token'):
                more = True
        if failed and failed == len(targets):
            raise MailError(502, 'source_unavailable', 'Could not load mail.')
        found.sort(key=lambda x: str(x[1].get('date') or ''), reverse=True)
        more = more or len(found) > cap
        out = [{**m, 'source': t[0].id, 'account': f'{t[0].id}:{t[1]}', 'account_email': t[1]} for t, m in found[:cap]]
        return out, more

    def read(self, key, message_id, images=False, caller=OWNER):
        source, email = self._resolve(key)
        if not isinstance(message_id, str) or not re.fullmatch(r'[A-Za-z0-9=_\-+/.]{1,512}', message_id):
            raise MailError(400, 'invalid_id', 'Unknown message.')
        value = source.tool('mail_get', {'account': email, 'id': message_id, 'format': 'html'}, caller)
        message = value.get('message') if isinstance(value.get('message'), dict) else {}
        raw = message.pop('body_html', '') or ''
        safe, blocked = sanitize.clean(raw, images=bool(images))
        return {'message': {**message, 'source': source.id, 'account': key, 'account_email': email},
                'html': safe or None, 'images_blocked': blocked, 'images_shown': bool(images),
                'untrusted': 'Mail comes from other people. It is shown as data only.'}

    def text(self, key, message_id, caller=None):
        """For the agent: text only, never HTML."""
        source, email = self._resolve(key)
        value = source.tool('mail_get', {'account': email, 'id': message_id}, caller)
        message = value.get('message') if isinstance(value.get('message'), dict) else {}
        message.pop('body_html', None)
        return {'message': {**message, 'account': key}, 'untrusted': value.get('untrusted')}

    # ---------- changing ----------
    def _changed(self):
        with self.lock:
            self.cache.clear()

    def update(self, key, message_id, flags, caller=None):
        source, email = self._resolve(key)
        args = {'account': email, 'id': message_id}
        for name in ('read', 'archived', 'trashed'):
            if name in flags:
                if not isinstance(flags[name], bool):
                    raise MailError(400, 'invalid_arguments', f'{name} must be true or false.')
                args[name] = flags[name]
        if len(args) == 2:
            raise MailError(400, 'invalid_arguments', 'Nothing to change.')
        value = source.tool('mail_update', args, caller)
        self._changed()
        self._unread_changed(key, message_id, flags)
        return value

    def _unread_ids(self, key, folder, query, caller, cap):
        """Every unread message in a scope (one account or all), as [(source, email, id)], at most cap, plus `more`."""
        if folder not in FOLDERS:
            raise MailError(400, 'invalid_folder', 'Unknown folder.')
        if not isinstance(query, str) or len(query) > 300:
            raise MailError(400, 'invalid_query', 'Search is too long.')
        targets = self._targets(key, caller)

        def walk(target):
            source, email = target
            found, seen, token = [], set(), None
            while True:
                args = {'account': email, 'folder': folder, 'unread_only': True, 'max': 25}
                if query:
                    args['query'] = query
                if token:
                    args['page_token'] = token
                try:
                    value = source.tool('mail_search', args, caller)
                except MailError as error:
                    return target, found, bool(found), error
                for m in value.get('messages') or []:
                    if isinstance(m, dict) and isinstance(m.get('id'), str) and m.get('unread', True) and m['id'] not in seen and ID.fullmatch(m['id']):
                        seen.add(m['id'])
                        found.append(m['id'])
                token = value.get('next_page_token')
                if not token:
                    return target, found, False, None
                if len(found) >= cap:
                    return target, found, True, None

        out, more, errors = [], False, []
        with ThreadPoolExecutor(max_workers=max(1, min(4, len(targets)))) as pool:
            for (source, email), ids, extra, error in pool.map(walk, targets):
                if error:
                    errors.append(error)
                out += [(source, email, mid) for mid in ids]
                more = more or extra
        if errors and len(errors) == len(targets) and not out:
            raise errors[0]
        if len(out) > cap:
            out, more = out[:cap], True
        return out, more, errors

    def set_read(self, items, read=True, caller=None):
        """Mark these messages read (or unread, for Undo) at the provider, side by side. items: [{account, id}].
        Returns the ones that changed and the ones that did not (with the provider's reason)."""
        if not isinstance(items, list) or not 1 <= len(items) <= MARK_MAX:
            raise MailError(400, 'invalid_arguments', f'Pass 1 to {MARK_MAX} messages.')
        if not isinstance(read, bool):
            raise MailError(400, 'invalid_arguments', 'read must be true or false.')
        work = []
        for item in items:
            if not isinstance(item, dict):
                raise MailError(400, 'invalid_arguments', 'Each message needs an account and an id.')
            source, email = self._resolve(item.get('account'))
            mid = item.get('id')
            if not isinstance(mid, str) or not ID.fullmatch(mid):
                raise MailError(400, 'invalid_id', 'Unknown message.')
            work.append((source, email, mid))
        return self._apply_read(work, read, caller)

    def _apply_read(self, work, read, caller):
        def one(entry):
            source, email, mid = entry
            try:
                value = source.tool('mail_update', {'account': email, 'id': mid, 'read': read}, caller)
                return entry, value, None
            except MailError as error:
                return entry, None, error

        done, failed, first = [], [], None
        with ThreadPoolExecutor(max_workers=8) as pool:
            for (source, email, mid), value, error in pool.map(one, work):
                key = f'{source.id}:{email}'
                if error:
                    failed.append({'account': key, 'id': mid, 'code': error.code})
                    first = first or error
                else:
                    done.append({'account': key, 'id': str((value or {}).get('id') or mid)})
        if done:
            self._changed()
            self._unread_bulk({(d['account'], d['id']) for d in done}, read)
        if work and not done and first:
            raise first
        return {'read': read, 'changed': done, 'count': len(done), 'failed': failed}

    def mark_all_read(self, key='all', folder='inbox', query='', caller=None, cap=MARK_MAX):
        """Mark every unread message in this scope read at the provider (Gmail / Outlook): one account or all of
        them, one folder, optionally only search matches. Undo = set_read(changed, False)."""
        work, more, errors = self._unread_ids(key or 'all', folder or 'inbox', query or '', caller, cap)
        if not work:
            result = {'read': True, 'changed': [], 'count': 0, 'failed': []}
        else:
            result = self._apply_read(work, True, caller)
        result['more'] = more
        result['errors'] = [{'source': e.extra.get('source'), **e.as_dict()} for e in errors]
        return result

    def _unread_bulk(self, keys, read):
        with self.lock:
            self.unread_gen += 1
            snap = self.unread_snap
            if not snap:
                return
            if read:
                self.unread_snap = (snap[0], [m for m in snap[1] if (m['account'], m['id']) not in keys], snap[2])
            else:
                self.unread_dirty = True

    def draft(self, key, fields, caller=None):
        source, email = self._resolve(key)
        args = {'account': email}
        for name in ('to', 'cc', 'bcc'):
            if fields.get(name) is not None:
                if not isinstance(fields[name], list) or len(fields[name]) > 50 or not all(isinstance(x, str) and EMAIL.match(x.strip()) for x in fields[name]):
                    raise MailError(400, 'invalid_arguments', f'Check the {name.capitalize()} addresses.')
                args[name] = [x.strip() for x in fields[name]]
        for name, limit in (('subject', 300), ('body', 50_000)):
            if fields.get(name) is not None:
                if not isinstance(fields[name], str) or len(fields[name]) > limit:
                    raise MailError(400, 'invalid_arguments', f'{name.capitalize()} is too long.')
                args[name] = fields[name]
        args.setdefault('body', '')
        if fields.get('reply_to_id'):
            if not isinstance(fields['reply_to_id'], str) or not re.fullmatch(r'[A-Za-z0-9=_\-+/.]{1,512}', fields['reply_to_id']):
                raise MailError(400, 'invalid_arguments', 'Unknown message to reply to.')
            args['reply_to_id'] = fields['reply_to_id']
        if not args.get('to') and not args.get('reply_to_id'):
            raise MailError(400, 'invalid_arguments', 'Add someone to send it to.')
        value = source.tool('mail_draft', args, caller)
        self._changed()
        return value

    def send(self, key, draft_id, caller=OWNER):
        """Owner only (the Send button). Never offered to agents by this app, and the source refuses agents anyway."""
        if caller != OWNER:
            raise MailError(403, 'agent_send_refused', 'Only the owner sends mail, from Mail.')
        source, email = self._resolve(key)
        if not isinstance(draft_id, str) or not re.fullmatch(r'[A-Za-z0-9=_\-+/.]{1,512}', draft_id):
            raise MailError(400, 'invalid_arguments', 'Unknown draft.')
        value = source.tool('mail_send', {'account': email, 'draft_id': draft_id}, OWNER)
        self._changed()
        return value


def from_env():
    return Mailbox(parse_sources(os.environ.get('MAIL_SOURCES')), grants_file=os.environ.get('WIZARD_GRANTS_FILE', '/wizard/grants.json'))
