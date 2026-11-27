"""Write runtipi/docker-compose.yml: one stdlib Python container with this app's source inlined (zlib + base64).
Run after every source edit; tests/test_package.py fails when the recipe is stale. (`wam package-inline` would
regenerate the template recipe and drop this app's environment, so this script owns the whole file.)"""
import base64
import json
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILES = sorted(['openapi.json'] + [f'app/{p.name}' for p in (ROOT / 'app').glob('*.py') if p.name != 'build_view.py']
               + [f'web/{p.name}' for p in (ROOT / 'web').iterdir() if p.suffix in ('.html', '.js', '.css', '.svg')])
IMAGE = 'python:3.12-alpine@sha256:1b668429b3511ab407d8e00648891631b0b1a4d7e15e3ca70f38ab5b91ad4ab4'
PORT = 18818
# The on-box mail store (wizard-mail#35): the stock Stalwart image, never published. Its start
# writes the store's admin secret (once) and its one-line config into Mail's /data/store, then runs Stalwart as is.
STORE_IMAGE = 'stalwartlabs/stalwart:v1.1.1-alpine@sha256:53ce86ed60f3730a031b09721b9b83b80e062f2f2095ea0e9b343bdd4ff6cc2e'
STORE_START = ('set -eu; S=/var/lib/wizard-mail/store; umask 077; mkdir -p "$$S/db"; '
               'if [ ! -s "$$S/secret" ]; then head -c 32 /dev/urandom | od -An -v -tx1 | tr -dc 0-9a-f > "$$S/.secret"; '
               'mv "$$S/.secret" "$$S/secret"; fi; '
               'printf \'{"@type":"RocksDb","path":"%s/db/"}\' "$$S" > "$$S/config.json"; '
               'STALWART_RECOVERY_ADMIN="admin:$$(cat "$$S/secret")"; export STALWART_RECOVERY_ADMIN; '
               'exec /usr/local/bin/stalwart --config "$$S/config.json"')
LOADER = ("import base64,json,pathlib,runpy,zlib\nroot=pathlib.Path('/tmp/wizard-app');root.mkdir(exist_ok=True)\n"
          "files=json.loads(zlib.decompress(base64.b64decode('{blob}')))\n"
          "for name,text in files.items():\n p=root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text)\n"
          "runpy.run_path(str(root/'app/server.py'),run_name='__main__')\n")
HEAD = f"""# Mail: one stdlib Python container; the app source is inlined below (refresh with `python3 tools/package.py`).
# Mail asks the Google and Microsoft apps over the Wizard app network. It also copies
# that mail into wizard-mail-store (stock Stalwart, on the app network only) and reads it from there.
services:
  wizard-mail:
    image: {IMAGE}
    pids_limit: 64
    user: 1000:1000
    cap_drop:
    - ALL
    security_opt:
    - no-new-privileges:true
    mem_limit: 256m
    read_only: true
    tmpfs:
    - /tmp:rw,nosuid,size=32m,uid=1000,gid=1000
    environment:
      PORT: '{PORT}'
      APP_PORT: ${{APP_PORT:-{PORT}}}
      BIND: 0.0.0.0
      PYTHONDONTWRITEBYTECODE: '1'
      WIZARD_SHELL_AUTH: ${{WIZARD_SHELL_AUTH:-tailscale-serve}}
      WIZARD_OWNER_LOGINS: ${{WIZARD_OWNER_LOGINS:-}}
      WIZARD_TRUSTED_HOSTS: ${{WIZARD_TRUSTED_HOSTS:-}}
      WIZARD_TRUSTED_ORIGINS: ${{WIZARD_TRUSTED_ORIGINS:-}}
      WIZARD_OWNER_TOKEN: ${{WIZARD_OWNER_TOKEN:-}}
      WIZARD_ADMIN_TOKEN: ${{WIZARD_ADMIN_TOKEN:-}}
      MAIL_SOURCES: ${{MAIL_SOURCES:-google=http://wizard-google:18812,microsoft=http://wizard-microsoft:18814}}
      MAIL_DATA: /data
      MAIL_AGENT_SERVICE: ${{MAIL_AGENT_SERVICE:-http://wizard-agent-service:8787}}
      MAIL_AGENT_INBOX_TOKEN: ${{MAIL_AGENT_INBOX_TOKEN:-}}
      MAIL_STORE_URL: http://wizard-mail-store:8080
      MAIL_STORE_SECRET_FILE: /data/store/secret
    volumes:
    - ${{APP_DATA_DIR}}/data:/data
    command:
    - python
    - -c
"""
TAIL = f"""    x-runtipi:
      is_main: true
      internal_port: {PORT}
  wizard-mail-store:
    image: {STORE_IMAGE}
    pids_limit: 256
    user: 1000:1000
    cap_drop:
    - ALL
    cap_add:
    - NET_BIND_SERVICE
    security_opt:
    - no-new-privileges:true
    mem_limit: 512m
    volumes:
    - ${{APP_DATA_DIR}}/data:/var/lib/wizard-mail
    entrypoint:
    - /bin/sh
    - -c
    command:
    - {json.dumps(STORE_START)}
x-runtipi:
  schema_version: 2
  overrides: []
"""


def build():
    files = {name: (ROOT / name).read_text() for name in FILES}
    blob = base64.b64encode(zlib.compress(json.dumps(files, sort_keys=True).encode(), 9)).decode()
    command = LOADER.replace('{blob}', blob)
    if len(command.encode()) > 120_000:
        sys.exit(f'inline command is {len(command)} bytes; Linux allows 128 KiB per argument')
    compile(command, 'loader', 'exec')
    return HEAD + '    - ' + json.dumps(command) + '\n' + TAIL


if __name__ == '__main__':
    text = build()
    (ROOT / 'runtipi' / 'docker-compose.yml').write_text(text)
    print('embedded', len(FILES), 'files,', len(text), 'bytes ->', 'runtipi/docker-compose.yml')
