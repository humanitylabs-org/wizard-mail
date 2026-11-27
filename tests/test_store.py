"""On-box mail store tests (wizard-mail#35, on for everyone). Stalwart is a fake (labelled) speaking the small part
of JMAP Mail uses over real HTTP; the Google app is the fake from test_mail. Nothing talks to Google or Microsoft."""
import base64
import email
import email.policy
import itertools
import json
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'app'))
sys.path.insert(0, str(ROOT / 'tests'))
sys.path.insert(0, str(ROOT / 'tools'))
import server  # noqa: E402
import sources  # noqa: E402
import store  # noqa: E402
from test_mail import FakeSource, accounts  # noqa: E402

SECRET = 'ab' * 32
OWNER_LOGIN = f'{store.USER}@{store.DOMAIN}%admin'


class FakeStalwart:
    """Fake Stalwart: the session, upload/download, Mailbox/Email get/set/query/import and the admin objects."""

    def __init__(self):
        self.blobs, self.emails, self.boxes = {}, {}, {}
        self.domains, self.accounts = [], []
        self.listeners = [{'id': f'l{i}', 'name': n} for i, n in enumerate(['smtp', 'imaps', 'https', 'http'])]
        self.ids = itertools.count(1)
        self.calls, self.down = [], False
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def who(self):
                raw = self.headers.get('Authorization', '')
                login, _, secret = base64.b64decode(raw.split(' ', 1)[-1]).decode().partition(':')
                return login if secret == SECRET else None

            def reply(self, status, value, ctype='application/json'):
                raw = value if isinstance(value, bytes) else json.dumps(value).encode()
                self.send_response(status)
                self.send_header('Content-Type', ctype)
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                login = self.who()
                if fake.down or not login:
                    return self.reply(503 if fake.down else 401, {})
                if self.path == '/jmap/session':
                    ok = login == OWNER_LOGIN and fake.accounts
                    return self.reply(200, {'primaryAccounts': {'urn:ietf:params:jmap:mail': 'acc'} if ok else {}})
                if self.path.startswith('/jmap/download/acc/'):
                    blob = self.path.split('/')[4]
                    return self.reply(200, fake.blobs[blob], 'application/octet-stream') if blob in fake.blobs else self.reply(404, {})
                self.reply(404, {})

            def do_POST(self):
                login = self.who()
                data = self.rfile.read(int(self.headers['Content-Length']))
                if fake.down or not login:
                    return self.reply(503 if fake.down else 401, {})
                if self.path == '/jmap/upload/acc/':
                    blob = f'B{next(fake.ids)}'
                    fake.blobs[blob] = data
                    return self.reply(200, {'blobId': blob})
                body = json.loads(data)
                out = []
                for name, args, tag in body['methodCalls']:
                    fake.calls.append((login, name))
                    if name.startswith('x:') != (login == 'admin') or (name.startswith('x:') and 'urn:stalwart:jmap' not in body['using']):
                        out.append(['error', {'type': 'forbidden'}, tag])
                        continue
                    out.append([name, fake.method(name, args, out), tag])
                self.reply(200, {'methodResponses': out})

        self.srv = ThreadingHTTPServer(('127.0.0.1', 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = f'http://127.0.0.1:{self.srv.server_address[1]}'

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()

    # ---- JMAP methods ----
    def method(self, name, a, earlier):
        if '#ids' in a:
            a = {**a, 'ids': earlier[int(a['#ids']['resultOf'])][1]['ids']}
        kind, _, verb = name.partition('/')
        if kind in ('x:Domain', 'x:Account', 'x:NetworkListener'):
            table = {'x:Domain': self.domains, 'x:Account': self.accounts, 'x:NetworkListener': self.listeners}[kind]
            if verb == 'get':
                return {'list': table}
            made = {}
            for cid, obj in (a.get('create') or {}).items():
                obj = {**obj, 'id': f'o{next(self.ids)}'}
                if kind == 'x:Account':
                    obj['emailAddress'] = f"{obj['name']}@{store.DOMAIN}"
                table.append(obj)
                made[cid] = {'id': obj['id']}
            table[:] = [o for o in table if o['id'] not in (a.get('destroy') or [])]
            return {'created': made, 'destroyed': a.get('destroy') or []}
        if name == 'Mailbox/get':
            return {'list': [dict(b, id=i) for i, b in self.boxes.items()]}
        if name == 'Mailbox/set':
            made = {}
            for cid, obj in a['create'].items():
                mid = f'm{next(self.ids)}'
                parent = obj.get('parentId')
                self.boxes[mid] = {'name': obj['name'], 'parentId': made[parent[1:]]['id'] if parent and parent.startswith('#') else parent}
                made[cid] = {'id': mid}
            return {'created': made}
        if name == 'Email/import':
            made = {}
            for cid, e in a['emails'].items():
                eid = f'e{next(self.ids)}'
                msg = email.message_from_bytes(self.blobs[e['blobId']], policy=email.policy.default)
                self.emails[eid] = {'msg': msg, 'mailboxIds': dict(e['mailboxIds']), 'keywords': dict(e['keywords']),
                                    'receivedAt': e.get('receivedAt') or '2026-01-01T00:00:00Z', 'raw': self.blobs[e['blobId']]}
                made[cid] = {'id': eid}
            return {'created': made}
        if name == 'Email/set':
            for eid, patch in a['update'].items():
                e = self.emails[eid]
                if 'mailboxIds' in patch:
                    e['mailboxIds'] = dict(patch['mailboxIds'])
                if 'keywords/$seen' in patch:
                    if patch['keywords/$seen']:
                        e['keywords']['$seen'] = True
                    else:
                        e['keywords'].pop('$seen', None)
            return {'updated': {eid: None for eid in a['update']}}
        if name == 'Email/query':
            ids = [eid for eid, e in self.emails.items() if self.match(e, a.get('filter') or {})]
            if a.get('sort'):
                ids.sort(key=lambda eid: self.emails[eid]['receivedAt'], reverse=True)
            start = a.get('position') or 0
            return {'ids': ids[start:start + (a.get('limit') or 5000)]}
        if name == 'Email/get':
            return {'list': [self.view(eid, a) for eid in a['ids'] if eid in self.emails]}
        raise AssertionError(name)

    def match(self, e, f):
        if 'operator' in f:
            hits = [self.match(e, c) for c in f['conditions']]
            return any(hits) if f['operator'] == 'OR' else all(hits)
        if 'inMailbox' in f:
            return f['inMailbox'] in e['mailboxIds']
        if 'hasKeyword' in f:
            return f['hasKeyword'] in e['keywords']
        if 'notKeyword' in f:
            return f['notKeyword'] not in e['keywords']
        raise AssertionError(f)

    def view(self, eid, a):
        e, msg = self.emails[eid], self.emails[eid]['msg']
        addr = lambda h: [{'name': x.display_name or None, 'email': x.addr_spec} for x in (msg[h].addresses if msg[h] else [])]
        out = {'id': eid, 'from': addr('From'), 'to': addr('To'), 'cc': addr('Cc') or None, 'subject': msg['Subject'],
               'receivedAt': e['receivedAt'], 'keywords': e['keywords'], 'mailboxIds': e['mailboxIds'], 'threadId': 't' + eid,
               'messageId': [msg['Message-ID'].strip('<>')] if msg['Message-ID'] else None,
               f'header:{store.ID_HEADER}:asText': msg[store.ID_HEADER]}
        text, html, files, values = [], [], [], {}
        for n, part in enumerate(msg.walk()):
            if part.is_multipart():
                continue
            pid, ctype = str(n), part.get_content_type()
            blob = f'{eid}p{n}'
            self.blobs[blob] = part.get_payload(decode=True) or b''
            entry = {'partId': pid, 'blobId': blob, 'size': len(self.blobs[blob]), 'name': part.get_filename(), 'type': ctype,
                     'cid': (part['Content-ID'] or '').strip('<>') or None, 'disposition': part.get_content_disposition(),
                     f'header:{store.PART_HEADER}:asText': part[store.PART_HEADER]}
            if ctype in ('text/plain', 'text/html') and part.get_content_disposition() != 'attachment':
                values[pid] = {'value': part.get_content()}
                (text if ctype == 'text/plain' else html).append(entry)
            elif entry['name']:
                files.append(entry)
            else:
                html.append(entry)
        out.update({'textBody': text, 'htmlBody': html, 'attachments': files, 'bodyValues': values,
                    'preview': (values.get(text[0]['partId'], {}).get('value', '') if text else '')[:256]})
        return {k: v for k, v in out.items() if k == 'id' or k in a.get('properties', out)}


class StoreSource(FakeSource):
    """A Google app with real folders: ids per folder, read state and moves the test changes."""

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.folders = {'inbox': [f'i{n}' for n in range(30)], 'archive': ['a0', 'a1'], 'sent': ['s0'], 'trash': []}
        self.unread = {f'i{n}' for n in range(0, 30, 3)}
        self.pdf_fails = False

    def tool(self, name, a):
        if name == 'mail_search' and a.get('folder') in self.folders:
            ids = self.folders[a['folder']]
            if a.get('unread_only'):
                ids = [i for i in ids if i in self.unread]
            start = int(a.get('page_token') or 0)
            page = ids[start:start + a['max']]
            nxt = str(start + a['max']) if start + a['max'] < len(ids) else None
            if a.get('ids_only'):
                return {'ids': page, 'next_page_token': nxt}
            day = lambda i: f'2026-11-{1 + (len(ids) - ids.index(i)) % 28:02d}T{ids.index(i) % 24:02d}:00:00+00:00'
            return {'folder': a['folder'], 'next_page_token': nxt,
                    'messages': [{'id': i, 'thread_id': 't', 'from': {'name': 'Anna', 'email': 'anna@example.com'}, 'to': [],
                                  'cc': [], 'subject': f'Subject {i}', 'date': day(i), 'snippet': 'Hi', 'unread': i in self.unread,
                                  'labels': []} for i in page]}
        if name == 'mail_get' and a['id'] == 'i0':
            found = super().tool('mail_get', {**a, 'id': 'photo1'})
            found['message']['id'] = 'i0'
            return found
        if name == 'mail_attachment' and a['part'] == '2' and getattr(self, 'pdf_fails', False):
            return {'error': 'nope'}
        if name == 'mail_get':
            body = {'id': a['id'], 'from': {'name': 'Anna', 'email': 'anna@example.com'}, 'to': [{'name': 'Me', 'email': a['account']}],
                    'cc': [], 'subject': f'Subject {a["id"]}', 'date': '2026-11-03T01:00:00+00:00', 'body_text': f'Text of {a["id"]}',
                    'attachments': [], 'message_id_header': f'<{a["id"]}@example.com>'}
            if a.get('format') == 'html':
                body['body_html'] = f'<p>HTML of {a["id"]}</p>'
            return {'message': body, 'untrusted': 'data'}
        if name == 'mail_update':
            if a.get('archived'):
                self.folders['inbox'].remove(a['id'])
                self.folders['archive'].insert(0, a['id'])
            if 'read' in a:
                (self.unread.discard if a['read'] else self.unread.add)(a['id'])
        return super().tool(name, a)


class StoreBase(unittest.TestCase):
    KEY = 'google:me@gmail.com'

    def setUp(self):
        self.g = StoreSource('google', accounts(('me@gmail.com', 'active', ['gmail'])))
        self.stw = FakeStalwart()
        self.dir = Path(tempfile.mkdtemp())
        (self.dir / 'secret').write_text(SECRET + '\n')
        grants = self.dir / 'grants.json'
        grants.write_text(json.dumps({'outgoing': {'wizard-google': self.g.grant}}))
        self.box = sources.Mailbox({'google': self.g.base}, grants_file=str(grants))
        self.store = store.Store(self.stw.url, str(self.dir / 'secret'))
        self.sync = store.Sync(self.box, self.store, self.dir)
        self.box.store_view = store.View(self.store, self.sync)

    def tearDown(self):
        self.g.close()
        self.stw.close()

    def import_all(self):
        for _ in range(20):
            if not self.sync.check():
                break
        self.box._changed()

    def searches(self):
        return [c for c in self.g.calls if c[1] == 'mail_search']

    def ids(self, folder, key=None, unread=False):
        out, cursor = [], None
        while True:
            page = self.box.list(key or self.KEY, folder, cursor=cursor, caller=sources.OWNER, unread=unread)
            out += [m['id'] for m in page['messages']]
            cursor = page['cursor']
            if not cursor:
                return out, page


class StoreTests(StoreBase):
    def test_before_the_first_check_reads_providers_and_touches_no_store(self):
        page = self.box.list(self.KEY, 'inbox', caller=sources.OWNER)
        self.assertNotIn('store', page)
        self.assertEqual(self.stw.calls, [])
        self.assertEqual(self.sync.status(), {'accounts': {}, 'last': {}})

    def test_import_sets_up_one_mailbox_and_turns_off_the_other_listeners(self):
        self.import_all()
        self.assertEqual([a['emailAddress'] for a in self.stw.accounts], [f'owner@{store.DOMAIN}'])
        self.assertEqual([x['name'] for x in self.stw.listeners], ['http'])
        names = sorted(b['name'] for b in self.stw.boxes.values())
        self.assertEqual(names, sorted([self.KEY, 'Inbox', 'Archive', 'Sent', 'Trash']))
        self.assertEqual(len(self.stw.emails), 33)    # 30 inbox, 2 archive, 1 sent: everything, once
        self.assertTrue(self.sync.complete(self.KEY))
        self.assertEqual(self.sync.status()['accounts'][self.KEY], {'imported': 33, 'complete': True})
        before = len(self.stw.emails)
        self.sync.check()
        self.assertEqual(len(self.stw.emails), before)   # a second check imports nothing twice

    def test_owner_lists_and_reads_from_the_store_once_imported(self):
        self.import_all()
        asked = len(self.searches())
        inbox, page = self.ids('inbox')
        self.assertTrue(page['store'])
        self.assertEqual(sorted(inbox), sorted(self.g.folders['inbox']))
        self.assertEqual(len(self.searches()), asked)     # no provider search for the list
        unread, _ = self.ids('inbox', unread=True)
        self.assertEqual(sorted(unread), sorted(self.g.unread))
        self.assertEqual(self.ids('archive')[0], ['a0', 'a1'])
        self.assertEqual(len(self.ids('all')[0]), 33)
        first = self.box.list('all', 'inbox', caller=sources.OWNER)['messages'][0]
        self.assertEqual((first['account'], first['source'], first['account_email']), (self.KEY, 'google', 'me@gmail.com'))
        calls = len(self.g.calls)
        read = self.box.read(self.KEY, 'i5', caller=sources.OWNER)
        self.assertEqual(len(self.g.calls), calls)        # the reader too
        self.assertEqual(read['message']['body_text'].strip(), 'Text of i5')
        self.assertIn('HTML of i5', read['html'])
        self.assertEqual(read['message']['message_id_header'], '<i5@example.com>')

    def test_photos_and_files_come_with_the_copy(self):
        self.import_all()
        read = self.box.read(self.KEY, 'i0', caller=sources.OWNER)
        files = {a['name']: a for a in read['message']['attachments']}
        self.assertEqual(set(files), {'IMG_7215.jpeg', 'notes.pdf'})
        self.assertEqual(files['IMG_7215.jpeg']['content_id'], 'ph@1')
        self.assertEqual([p['content_id'] for p in read['message']['inline_parts']], ['logo'])
        self.assertIn('data-cid="ph@1"', read['html'])
        calls = len(self.g.calls)
        self.assertEqual(self.box.attachment(self.KEY, 'i0', files['notes.pdf']['part'], sources.OWNER),
                         ('notes.pdf', 'application/pdf', b'%PDF'))
        self.assertEqual(self.box.attachment(self.KEY, 'i0', read['message']['inline_parts'][0]['part'], sources.OWNER)[2], b'PNG')
        self.assertEqual(len(self.g.calls), calls)        # opened from the box
        with self.assertRaises(sources.MailError):
            self.box.attachment(self.KEY, 'i0', 'wzs.nothere', sources.OWNER)

    def test_a_file_that_could_not_be_copied_opens_from_the_provider(self):
        self.g.pdf_fails = True
        self.import_all()
        read = self.box.read(self.KEY, 'i0', caller=sources.OWNER)
        pdf = next(a for a in read['message']['attachments'] if a['name'] == 'notes.pdf')
        self.assertEqual(pdf['part'], '2')   # the provider's part: Mail fetches it from there
        self.g.pdf_fails = False
        self.assertEqual(self.box.attachment(self.KEY, 'i0', '2', sources.OWNER), ('notes.pdf', 'application/pdf', b'%PDF'))

    def test_agents_searches_and_drafts_stay_direct(self):
        self.import_all()
        asked = len(self.searches())
        self.box.list(self.KEY, 'inbox', caller=sources.agent('main'))
        self.box.list(self.KEY, 'inbox', 'from:anna', caller=sources.OWNER)
        self.box.list(self.KEY, 'drafts', caller=sources.OWNER)
        self.assertEqual(len(self.searches()), asked + 3)
        calls = len(self.g.calls)
        self.box.text(self.KEY, 'i5', sources.agent('main'))
        self.assertEqual(self.g.calls[calls][1], 'mail_get')   # the source app applies the owner's agent level

    def test_not_fully_imported_or_store_down_reads_direct(self):
        page = self.box.list(self.KEY, 'inbox', caller=sources.OWNER)
        self.assertNotIn('store', page)          # nothing imported yet
        self.import_all()
        self.stw.down = True
        self.box._changed()
        page = self.box.list(self.KEY, 'inbox', caller=sources.OWNER)
        self.assertNotIn('store', page)          # the store does not answer: Gmail directly, nothing breaks
        self.assertEqual(self.box.read(self.KEY, 'i5', caller=sources.OWNER)['message']['body_text'], 'Text of i5')
        self.assertFalse(self.sync.check())
        self.assertEqual(self.sync.status()['last']['state'], 'paused')

    def test_keeps_syncing_new_mail_read_state_and_moves(self):
        self.import_all()
        self.g.folders['inbox'].insert(0, 'i99')
        self.g.unread.add('i99')
        self.g.unread.discard('i0')
        self.g.folders['inbox'].remove('i1')
        self.g.folders['trash'].insert(0, 'i1')
        self.sync.check()
        self.box._changed()
        inbox, _ = self.ids('inbox')
        self.assertIn('i99', inbox)
        self.assertNotIn('i1', inbox)
        self.assertEqual(self.ids('trash')[0], ['i1'])
        self.assertNotIn('i0', self.ids('inbox', unread=True)[0])

    def test_whole_inbox_compared_now_and_then(self):
        self.import_all()
        old = self.g.folders['inbox'][-1]          # far past the newest pages
        self.g.folders['inbox'].remove(old)        # archived on Gmail's website
        self.g.unread.discard('i27')               # read on the phone
        self.sync.reconciled.clear()
        self.sync.check()
        self.box._changed()
        self.assertNotIn(old, self.ids('inbox')[0])
        self.assertIn(old, self.ids('archive')[0])
        self.assertNotIn('i27', self.ids('inbox', unread=True)[0])

    def test_what_the_owner_does_in_mail_reaches_the_store_at_once(self):
        self.import_all()
        self.box.update(self.KEY, 'i6', {'archived': True}, sources.OWNER)
        self.box.update(self.KEY, 'i3', {'read': True}, sources.OWNER)
        got = {}
        for _ in range(50):
            got = self.store.find(self.KEY, ['i6', 'i3'])
            if got['i6']['folders'] == ['archive'] and not got['i3']['unread']:
                break
            time.sleep(0.05)
        self.assertEqual(got['i6']['folders'], ['archive'])
        self.assertFalse(got['i3']['unread'])

    def test_rebuilt_copy_is_a_valid_message(self):
        raw = store.rebuild({'from': {'name': 'A\r\nBcc: x@evil.example', 'email': 'a@example.com'}, 'to': [{'name': '', 'email': 'b@example.com'}],
                             'subject': 'Hi\nthere', 'date': '2026-11-03T01:00:00+00:00', 'body_text': 'Plain', 'body_html': '<p>Rich</p>',
                             'message_id_header': '<x@example.com>',
                             'attachments': [{'name': 'a.txt', 'mime': 'text/plain', 'part': '1'}, {'name': 'b.bin', 'mime': 'bad mime', 'part': '2'}]},
                            lambda part: b'file one' if part == '1' else None)
        msg = email.message_from_bytes(raw, policy=email.policy.default)
        self.assertIsNone(msg['Bcc'])
        self.assertEqual((msg['Subject'], msg['Message-ID']), ('Hi there', '<x@example.com>'))
        files = {p.get_filename(): p for p in msg.iter_attachments()}
        self.assertEqual(files['a.txt'].get_payload(decode=True), b'file one')
        self.assertEqual(files['b.bin'][store.PART_HEADER], '2')


class StoreHttpTests(StoreBase):
    def test_on_for_everyone_without_a_switch(self):
        (self.dir / 'switches.json').write_text(json.dumps({store.RETIRED_SWITCH: False, 'drafts-waiting': True}))
        config = server.Config({'PORT': '0', 'MAIL_SOURCES': f'google={self.g.base}', 'MAIL_DATA': str(self.dir),
                                'MAIL_STORE_URL': self.stw.url, 'MAIL_STORE_SECRET_FILE': str(self.dir / 'secret')})
        app = server.App(config)
        self.assertIsInstance(app.mailbox.store_view, store.View)
        self.assertNotIn(store.RETIRED_SWITCH, [s['id'] for s in server.switches_doc(config)['switches']])
        self.assertEqual(json.loads((self.dir / 'switches.json').read_text()), {'drafts-waiting': True})
        self.assertNotIn('switch', app.sync.status())
        for _ in range(20):    # a stored off is gone: the store imports and serves the owner's lists
            if not app.sync.check():
                break
        app.mailbox._changed()
        self.assertTrue(app.mailbox.list(self.KEY, 'inbox', caller=sources.OWNER).get('store'))


class StoreRecipeTests(unittest.TestCase):
    def test_stock_stalwart_on_the_app_network_only(self):
        import package
        text = package.build()
        self.assertIn('  wizard-mail-store:\n    image: stalwartlabs/stalwart:v1.1.1-alpine@sha256:', text)
        part = text.split('  wizard-mail-store:\n', 1)[1]
        self.assertNotIn('ports:', part)
        self.assertNotIn('is_main', part)
        self.assertIn('cap_add:\n    - NET_BIND_SERVICE\n    security_opt', part)
        self.assertIn('- ${APP_DATA_DIR}/data:/var/lib/wizard-mail', part)
        self.assertIn('MAIL_STORE_SECRET_FILE: /data/store/secret', text)


if __name__ == '__main__':
    unittest.main()
