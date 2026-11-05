'use strict';

// Platform IDs are case-sensitive; tracking parameters are not identity.
function overseasVideoKey(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(host)) {
      const id = host === 'youtu.be' ? url.pathname.split('/')[1]
        : url.pathname === '/watch' ? url.searchParams.get('v')
          : url.pathname.match(/^\/(?:shorts|embed)\/([^/]+)/)?.[1];
      if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) return `youtube:${id}`;
    }
    if (['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(host)) {
      const id = url.pathname.match(/^\/[^/]+\/status\/(\d+)(?:\/|$)/)?.[1];
      if (id) return `x:${id}`;
    }
  } catch (_) { /* Existing validation reports malformed links. */ }
  return '';
}

module.exports = { overseasVideoKey };
