// ─────────────────────────────────────────────────────────────────────────────
// GoodFeed — Background Service Worker (Manifest V3)
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const cache   = new Map(); // `${query}:${mode}` → { tweets, ts }
const CACHE_TTL = 5 * 60 * 1000;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'fetchTopTweets' && msg.query) {
    const mode = msg.mode || 'recent';
    handleFetch(msg.query, mode)
      .then(sendResponse)
      .catch(() => sendResponse({ tweets: [] }));
    return true;
  }
});

async function handleFetch(query, mode) {
  const key = `${query}:${mode}`;
  const hit = cache.get(key);
  if (hit && (Date.now() - hit.ts) < CACHE_TTL) return { tweets: hit.tweets };

  const tweets = await scrapeSearchResults(query, mode);
  cache.set(key, { tweets, ts: Date.now() });
  return { tweets };
}

async function scrapeSearchResults(query, mode) {
  // Recent → &f=live (chronological). Trending → default Top search (X's own ranking).
  const suffix = mode === 'trending' ? '' : '&f=live';
  const url    = `https://x.com/search?q=${encodeURIComponent(query)}${suffix}`;

  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForTabComplete(tab.id);
    await sleep(1800); // React hydration buffer

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func:   extractTweets,
      args:   [mode],
    });

    return Array.isArray(result) ? result : [];
  } catch (err) {
    console.error('[GoodFeed BG]', err);
    return [];
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) { reject(chrome.runtime.lastError); return; }
      if (tab.status === 'complete') { resolve(); return; }
      const fn = (id, info) => {
        if (id !== tabId || info.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(fn);
        resolve();
      };
      chrome.tabs.onUpdated.addListener(fn);
      setTimeout(() => { chrome.tabs.onUpdated.removeListener(fn); resolve(); }, 15000);
    });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────────────────────
// extractTweets — runs serialised inside the search tab. Must be self-contained.
//
// Strategy (PageRank-for-X):
//   1. Poll until ≥3 real tweet articles are in the DOM.
//   2. Collect up to 15 candidates with engagement metrics.
//   3. Score each tweet: likes + (reposts × 2.5) — reposts are a stronger
//      quality signal than likes (analogous to citation weight in PageRank).
//   4. For Trending mode: sort by score descending.
//   5. For Recent mode: stable order (X's own live chronological ranking).
//   6. Capture the tweet's full outerHTML so the receiving tab can clone the
//      real X DOM node — no fake CSS cards, pixel-perfect native appearance.
// ─────────────────────────────────────────────────────────────────────────────
function extractTweets(mode) {
  // ── inline helpers (no closure from outer scope) ───────────────────────────
  function parseCount(str) {
    if (!str) return 0;
    const s = str.toString().replace(/,/g, '').trim().toUpperCase();
    const m = s.match(/^([\d.]+)([KMB]?)$/);
    if (!m) return parseInt(s, 10) || 0;
    let n = parseFloat(m[1]);
    if (m[2] === 'K') n *= 1e3;
    if (m[2] === 'M') n *= 1e6;
    if (m[2] === 'B') n *= 1e9;
    return Math.round(n);
  }

  function getEngagement(article) {
    // Primary: role="group" aria-label contains all counts in plain text
    // e.g. "23 replies, 14 reposts, 182 Likes, 14 bookmarks, 891 views"
    const group = article.querySelector('[role="group"]');
    const label = group?.getAttribute('aria-label') || '';
    let likeNum = 0, repostNum = 0;

    if (label) {
      const lm = label.match(/([\d,]+)\s+Like/i);
      const rm = label.match(/([\d,]+)\s+(?:repost|Retweet)/i);
      if (lm) likeNum   = parseCount(lm[1]);
      if (rm) repostNum = parseCount(rm[1]);
    } else {
      // Fallback: scrape count spans from action buttons
      const tryBtn = (tid) => {
        const btn = article.querySelector(`[data-testid="${tid}"]`);
        if (!btn) return 0;
        for (const sp of btn.querySelectorAll('span')) {
          const t = sp.textContent.trim();
          if (t && /^\d[\d,KMB.]*$/i.test(t)) return parseCount(t);
        }
        return 0;
      };
      likeNum   = tryBtn('like');
      repostNum = tryBtn('retweet');
    }

    return { likeNum, repostNum };
  }

  // ── polling loop ───────────────────────────────────────────────────────────
  return new Promise((resolve) => {
    const MAX_CANDIDATES = 15;
    const MAX_RESULTS    = 8;
    const MIN_TWEETS     = 3;
    const MAX_ATTEMPTS   = 20;
    const POLL_MS        = 600;
    let attempts = 0;

    const poll = () => {
      const articles = document.querySelectorAll('article[data-testid="tweet"]');

      if (articles.length >= MIN_TWEETS || attempts >= MAX_ATTEMPTS) {
        const candidates = [];

        articles.forEach((article, idx) => {
          if (idx >= MAX_CANDIDATES) return;
          try {
            // ── tweet URL ───────────────────────────────────────────────────
            const statusLink = article.querySelector('a[href*="/status/"]');
            const tweetUrl   = statusLink?.href;
            if (!tweetUrl) return;

            const urlMatch = tweetUrl.match(
              /(?:x\.com|twitter\.com)\/([A-Za-z0-9_]+)\/status\/(\d+)/
            );
            if (!urlMatch) return;

            // ── tweet text must exist (skip media-only / RT-only articles) ─
            const textEl = article.querySelector('[data-testid="tweetText"]');
            const text   = textEl ? (textEl.innerText || textEl.textContent || '').trim() : '';
            if (!text) return;

            // ── engagement ──────────────────────────────────────────────────
            const { likeNum, repostNum } = getEngagement(article);

            // ── timestamp ───────────────────────────────────────────────────
            const timeEl   = article.querySelector('time');
            const timestamp = timeEl?.getAttribute('datetime') || '';

            // ── PageRank-style score: reposts weighted 2.5× over likes ─────
            const score = likeNum + repostNum * 2.5;

            candidates.push({
              article,   // live DOM reference — used for outerHTML capture
              tweetUrl:  urlMatch[0].startsWith('http') ? tweetUrl : `https://${urlMatch[0]}`,
              tweetId:   urlMatch[2],
              username:  urlMatch[1],
              timestamp,
              likeNum,
              repostNum,
              score,
            });
          } catch (_) { /* skip malformed */ }
        });

        // Sort for Trending (leave stable for Recent)
        if (mode === 'trending') {
          candidates.sort((a, b) => b.score - a.score);
        }

        // Capture outerHTML now (after sort) so we send the best ones first
        const results = candidates.slice(0, MAX_RESULTS).map(c => ({
          html:       c.article.outerHTML,
          tweetUrl:   c.tweetUrl,
          tweetId:    c.tweetId,
          username:   c.username,
          timestamp:  c.timestamp,
          likeNum:    c.likeNum,
          repostNum:  c.repostNum,
        }));

        resolve(results);
      } else {
        attempts++;
        setTimeout(poll, POLL_MS);
      }
    };

    setTimeout(poll, 1000); // initial React hydration pause
  });
}
