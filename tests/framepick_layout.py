"""Framepick test layout.

The suite runs unchanged against two layouts:

* 橘生梦厂仓库：站点就是仓库根目录，服务在 ``/``
* standalone server (after the split): site served at ``/``, files at the root

Override with ``FRAMEPICK_BASE_PATH`` (default ``/``) and
``FRAMEPICK_SITE_ROOT`` (directory holding ``index.html``).
"""
import os
import re
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]

_segment = os.environ.get('FRAMEPICK_BASE_PATH', '/').strip('/')
BASE_PATH = f'/{_segment}/' if _segment else '/'
SITE_ROOT = Path(os.environ.get('FRAMEPICK_SITE_ROOT', ROOT)).resolve()

# 站点形态由 site-mode.js 决定：ranking 只留编选与片库，cinema 才展示观影、账号与订单。
_MODE_FILE = SITE_ROOT / 'site-mode.js'
SITE_MODE = 'cinema'
if _MODE_FILE.exists():
    _match = re.search(r"FRAMEPICK_SITE_MODE\s*=\s*'([a-z]+)'", _MODE_FILE.read_text())
    if _match:
        SITE_MODE = _match.group(1)


def url(path=''):
    """Absolute site path for a page-relative query string such as ``?film=xianggu``."""
    return BASE_PATH + path.lstrip('/')


# Directory a plain static server must serve so that BASE_PATH resolves to SITE_ROOT.
SITE_SERVE_ROOT = ROOT if BASE_PATH != '/' else SITE_ROOT


def is_index(target):
    """Playwright route predicate matching the Framepick index in the current layout."""
    return urlparse(target).path in (BASE_PATH, BASE_PATH + 'index.html')


def site_file(url_path):
    """Local file for a site URL path such as ``/reel/framepick.js`` or ``/framepick.js``."""
    return SITE_SERVE_ROOT / urlparse(url_path).path.lstrip('/')
