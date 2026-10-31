"""Make other people's HTML mail safe to show.

Mail HTML is untrusted. Wizard Mail shows it in a sandboxed frame with no scripts and a strict content policy, and
cleans it here first (defence in depth): no scripts, frames, forms, event handlers or javascript: links; remote images
and CSS backgrounds are removed unless the owner asked to show images for that message. Stdlib only.
"""
import html
import re
from html.parser import HTMLParser

DROP_WITH_CONTENT = {'script', 'noscript', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'svg',
                     'math', 'title', 'head', 'xml', 'audio', 'video', 'canvas', 'select', 'textarea', 'button'}
ALLOWED = {'a', 'abbr', 'address', 'article', 'b', 'bdi', 'bdo', 'big', 'blockquote', 'br', 'caption', 'center', 'cite', 'code',
           'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'font', 'footer',
           'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'main', 'mark', 'nav', 'ol', 'p',
           'pre', 'q', 's', 'samp', 'section', 'small', 'span', 'strike', 'strong', 'style', 'sub', 'summary', 'sup', 'table',
           'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'tt', 'u', 'ul', 'var', 'wbr', 'picture'}
VOID = {'br', 'col', 'hr', 'img', 'wbr'}
ATTRS = {'align', 'alt', 'bgcolor', 'border', 'cellpadding', 'cellspacing', 'color', 'colspan', 'dir', 'face', 'height', 'href',
         'lang', 'rowspan', 'size', 'span', 'src', 'start', 'style', 'title', 'type', 'valign', 'width', 'class', 'id', 'nowrap',
         'role', 'summary', 'abbr', 'scope', 'headers', 'datetime', 'open'}
BAD_CSS = re.compile(r'url\s*\(|expression\s*\(|javascript:|vbscript:|behavior\s*:|-moz-binding|@import|\\', re.I)
URL_IN_CSS = re.compile(r'url\s*\(\s*([\'"]?)(.*?)\1\s*\)', re.I | re.S)
SAFE_LINK = re.compile(r'^(https?:|mailto:|tel:|#)', re.I)
MAX_OUT = 600_000


def _clean_style_value(value, images):
    value = value.replace('\x00', '')
    if images:
        # Keep https backgrounds when the owner chose to show images; anything else in url() goes.
        value = URL_IN_CSS.sub(lambda m: m.group(0) if m.group(2).strip().lower().startswith('https://') else 'none', value)
        rest = URL_IN_CSS.sub('', value)
        return '' if BAD_CSS.search(rest) else value
    value = URL_IN_CSS.sub('none', value)
    return '' if BAD_CSS.search(value) else value


def _clean_css_block(text, images):
    text = re.sub(r'@import[^;]*;?', '', text, flags=re.I)
    text = re.sub(r'@font-face\s*{[^}]*}', '', text, flags=re.I)
    text = re.sub(r'expression\s*\(|javascript:|vbscript:|behavior\s*:|-moz-binding', '', text, flags=re.I)
    if images:
        text = URL_IN_CSS.sub(lambda m: m.group(0) if m.group(2).strip().lower().startswith('https://') else 'none', text)
    else:
        text = URL_IN_CSS.sub('none', text)
    return text.replace('<', '').replace('\\', '')


class _Cleaner(HTMLParser):
    def __init__(self, images):
        super().__init__(convert_charrefs=True)
        self.images, self.out, self.skip, self.blocked, self.in_style = images, [], 0, 0, False
        self.open = []

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if self.skip:
            if tag in DROP_WITH_CONTENT and tag not in VOID:
                self.skip += 1
            return
        if tag in DROP_WITH_CONTENT:
            self.skip = 1
            return
        if tag not in ALLOWED:
            return
        kept = []
        for name, value in attrs:
            name = (name or '').lower()
            value = value or ''
            if name not in ATTRS or name.startswith('on'):
                continue
            if name == 'href':
                if not SAFE_LINK.match(value.strip()):
                    continue
            elif name == 'src':
                if tag != 'img':
                    continue
                src = value.strip()
                if src.lower().startswith('data:image/') and len(src) < 200_000:
                    pass
                elif self.images and src.lower().startswith('https://'):
                    pass
                else:
                    if src:
                        self.blocked += 1
                    continue
            elif name == 'style':
                value = _clean_style_value(value, self.images)
                if not value:
                    continue
            kept.append((name, value))
        if tag == 'img' and not any(n == 'src' for n, _ in kept):
            alt = next((v for n, v in kept if n == 'alt'), '')
            if alt:
                self.out.append(f'<span class="wm-alt">{html.escape(alt[:200])}</span>')
            return
        if tag == 'a':
            kept.append(('rel', 'noopener noreferrer'))
            kept.append(('target', '_blank'))
        text = ''.join(f' {n}="{html.escape(v, quote=True)}"' for n, v in kept)
        self.out.append(f'<{tag}{text}>')
        if tag == 'style':
            self.in_style = True
        if tag not in VOID:
            self.open.append(tag)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag.lower() not in VOID and tag.lower() in ALLOWED and self.open and self.open[-1] == tag.lower():
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        tag = tag.lower()
        if self.skip:
            if tag in DROP_WITH_CONTENT:
                self.skip -= 1
            return
        if tag not in ALLOWED or tag in VOID or tag not in self.open:
            return
        while self.open:
            last = self.open.pop()
            self.out.append(f'</{last}>')
            if last == 'style':
                self.in_style = False
            if last == tag:
                break

    def handle_data(self, data):
        if self.skip:
            return
        if self.in_style:
            self.out.append(_clean_css_block(data, self.images))
        else:
            self.out.append(html.escape(data, quote=False))

    def handle_comment(self, data):
        pass

    def handle_decl(self, decl):
        pass

    def handle_pi(self, data):
        pass

    def unknown_decl(self, data):
        pass


def clean(raw, images=False):
    """(safe_html, blocked_remote_images). Empty input gives ('', 0)."""
    if not isinstance(raw, str) or not raw.strip():
        return '', 0
    parser = _Cleaner(images)
    try:
        parser.feed(raw[:2_000_000])
        parser.close()
    except Exception:  # noqa: BLE001 - a malformed message shows as text instead
        return '', 0
    while parser.open:
        parser.out.append(f'</{parser.open.pop()}>')
    out = ''.join(parser.out)
    return (out if len(out) <= MAX_OUT else ''), parser.blocked
