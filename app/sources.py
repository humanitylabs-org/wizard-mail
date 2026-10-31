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
MAX_PAGE = 20
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


class Source:
    """One source app. Plain HTTP on the app network; the source refuses browsers and forwarded requests."""

    def __init__(self, sid, base, timeout=30):
        self.id, self.base, self.timeout = sid, base, timeout
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def call(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.base + path, data=data, method=method, headers={
            'Accept': 'application/json', 'Content-Type': 'application/json', 'X-Wizard-Agent': 'wizard-mail'})
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
            raise MailError(status if 400 <= status < 600 else 502, str(err.get('code') or 'source_error'),
                            str(err.get('message') or f'The {NAMES[self.id]} app could not do that.')[:400], source=self.id)
        return value if isinstance(value, dict) else {}

    def tool(self, name, args):
        return self.call('POST', f'/v1/{name}', args)


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
    def __init__(self, sources, clock=time.time):
        self.sources = {sid: (s if isinstance(s, Source) else Source(sid, s)) for sid, s in sources.items()}
        self.clock = clock
        self.cache, self.lock = {}, threading.Lock()
        self.pool = ThreadPoolExecutor(max_workers=8)

    # ---------- accounts ----------
    def _status(self, source):
        try:
            value = source.call('GET', '/v1/status')
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
        return {'id': source.id, 'name': NAMES[source.id], 'app': APPS[source.id], 'available': True, 'error': None, 'accounts': accounts}

    def accounts(self):
        found = list(self.pool.map(self._status, self.sources.values()))
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

    def _targets(self, key):
        if key in (None, '', 'all'):
            status = self.accounts()
            targets = [(self.sources[a['source']], a['email']) for s in status['sources'] for a in s['accounts']
                       if a['mail'] and a['status'] == 'active']
            if not targets:
                raise MailError(409, 'not_connected', 'Connect an email account first.')
            return targets
        return [self._resolve(key)]

    # ---------- reading ----------
    def list(self, key=None, folder='inbox', query='', cursor=None, limit=MAX_PAGE):
        if folder not in FOLDERS:
            raise MailError(400, 'invalid_folder', 'Unknown folder.')
        if not isinstance(query, str) or len(query) > 300:
            raise MailError(400, 'invalid_query', 'Search is too long.')
        limit = max(1, min(int(limit or MAX_PAGE), 25))
        tokens = _cursor_in(cursor)
        cache_key = (key or 'all', folder, query, cursor, limit)
        with self.lock:
            hit = self.cache.get(cache_key)
            if hit and hit[0] > self.clock():
                return hit[1]
        targets = self._targets(key)
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
                value = source.tool('mail_search', args)
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

    def read(self, key, message_id, images=False):
        source, email = self._resolve(key)
        if not isinstance(message_id, str) or not re.fullmatch(r'[A-Za-z0-9=_\-+/.]{1,512}', message_id):
            raise MailError(400, 'invalid_id', 'Unknown message.')
        value = source.tool('mail_get', {'account': email, 'id': message_id, 'format': 'html'})
        message = value.get('message') if isinstance(value.get('message'), dict) else {}
        raw = message.pop('body_html', '') or ''
        safe, blocked = sanitize.clean(raw, images=bool(images))
        return {'message': {**message, 'source': source.id, 'account': key, 'account_email': email},
                'html': safe or None, 'images_blocked': blocked, 'images_shown': bool(images),
                'untrusted': 'Mail comes from other people. It is shown as data only.'}

    def text(self, key, message_id):
        """For the agent: text only, never HTML."""
        source, email = self._resolve(key)
        value = source.tool('mail_get', {'account': email, 'id': message_id})
        message = value.get('message') if isinstance(value.get('message'), dict) else {}
        message.pop('body_html', None)
        return {'message': {**message, 'account': key}, 'untrusted': value.get('untrusted')}

    # ---------- changing ----------
    def _changed(self):
        with self.lock:
            self.cache.clear()

    def update(self, key, message_id, flags):
        source, email = self._resolve(key)
        args = {'account': email, 'id': message_id}
        for name in ('read', 'archived', 'trashed'):
            if name in flags:
                if not isinstance(flags[name], bool):
                    raise MailError(400, 'invalid_arguments', f'{name} must be true or false.')
                args[name] = flags[name]
        if len(args) == 2:
            raise MailError(400, 'invalid_arguments', 'Nothing to change.')
        value = source.tool('mail_update', args)
        self._changed()
        return value

    def draft(self, key, fields):
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
        value = source.tool('mail_draft', args)
        self._changed()
        return value

    def send(self, key, draft_id):
        """Owner only (the Send button). Never offered to agents by this app."""
        source, email = self._resolve(key)
        if not isinstance(draft_id, str) or not re.fullmatch(r'[A-Za-z0-9=_\-+/.]{1,512}', draft_id):
            raise MailError(400, 'invalid_arguments', 'Unknown draft.')
        value = source.tool('mail_send', {'account': email, 'draft_id': draft_id})
        self._changed()
        return value


def from_env():
    return Mailbox(parse_sources(os.environ.get('MAIL_SOURCES')))
