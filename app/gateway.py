"""The Agent Service gateway's grant, read from Mail's own App Manager grants file.

A byte-for-byte copy of `GatewayGrant` in wizard-google / wizard-microsoft `app/agent_access.py` (itself Messenger's
`wizard_agents.py` GatewayGrant): keep them the same. Only the gateway's grant makes an agent's name count in Mail.
"""
import hashlib
import hmac
import json
import os
import re
import stat
import threading
import time
from pathlib import Path

GATEWAY = 'host:agent-service'
SHA256_HEX = re.compile(r'[0-9a-f]{64}')
KEY_RE = re.compile(r'[A-Za-z0-9_.~+/=-]{16,512}')
MAX_GRANTS_FILE = 256 * 1024


class GatewayGrant:
    """The Agent Service gateway's grant (wizard-messenger `wizard_agents.py` GatewayGrant, same file rules): the
    `from: host:agent-service` rows of this app's grants file (only key hashes, never keys), re-read when it changes.

    `state()` is 'missing' (no grants file), 'none' (a good file without the gateway's row: an App Manager that does not
    write it yet), 'rows' or 'bad' (unreadable, oversized, not a regular file or malformed). 'rows' and 'bad' mean the
    gateway is the only way in for agents; a bad file therefore fails closed instead of reopening bare calls.
    """

    def __init__(self, path=None, clock=time.time_ns):
        self.path = Path(path) if path else None
        self.stamp = None
        self.cached = ('missing', ())
        self.lock = threading.Lock()
        self.clock = clock

    def _read(self):
        try:
            fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            return None, ('missing', ())
        try:
            st = os.fstat(fd)
            stamp = (st.st_mtime_ns, st.st_ctime_ns, st.st_size, st.st_ino)  # ctime: utime cannot fake it
            if stamp == self.stamp:
                return stamp, self.cached
            if not stat.S_ISREG(st.st_mode) or st.st_size > MAX_GRANTS_FILE:
                return stamp, ('bad', ())
            data = b''
            while len(data) <= MAX_GRANTS_FILE:
                chunk = os.read(fd, MAX_GRANTS_FILE + 1 - len(data))
                if not chunk:
                    break
                data += chunk
            if len(data) > MAX_GRANTS_FILE:
                return stamp, ('bad', ())
        finally:
            os.close(fd)
        try:
            doc = json.loads(data)
        except ValueError:
            return stamp, ('bad', ())
        rows = doc.get('incoming') if isinstance(doc, dict) else None
        if not isinstance(rows, list):
            return stamp, ('bad', ())
        hashes = tuple(row['sha256'] for row in rows if isinstance(row, dict) and row.get('from') == GATEWAY
                       and isinstance(row.get('sha256'), str) and SHA256_HEX.fullmatch(row['sha256']))
        return stamp, ('rows' if hashes else 'none', hashes)

    def current(self):
        if not self.path:
            return ('missing', ())
        with self.lock:
            try:
                stamp, value = self._read()
            except Exception:  # noqa: BLE001  unreadable or pathological: fail closed
                self.stamp, self.cached = None, ('bad', ())
                return self.cached
            # A stamp younger than 2 s is not trusted: an in-place rewrite within one mtime tick keeps inode and size.
            self.stamp = stamp if stamp and self.clock() - max(stamp[0], stamp[1]) > 2_000_000_000 else None
            self.cached = value
            return value

    def state(self):
        return self.current()[0]

    def matches(self, grant):
        if not isinstance(grant, str) or not KEY_RE.fullmatch(grant):
            return False
        hashes = self.current()[1]
        if not hashes:
            return False
        digest = hashlib.sha256(grant.encode()).hexdigest().encode()
        return any(hmac.compare_digest(digest, h.encode()) for h in hashes)
