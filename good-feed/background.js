// ─────────────────────────────────────────────────────────────────────────────
// GoodFeed — Background Service Worker (Manifest V3)
//
// Responsibilities:
//   • Receive "fetchTopTweets" messages from content.js
//   • Open a hidden search tab on x.com, wait for tweets to render, scrape them
//   • Cache results per (query + mode) pair — 5 min TTL
//   • Return structured tweet data (with engagement counts) back to content.js
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// In-memory cache keyed by `${query}:${mode}`
const cache   = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ── Message router ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'fetchTopTweets' && msg.query) {
    const mode = msg.mode || 'recent';
    handleFetch(msg.query, mode)
      .then(sendResponse)
      .catch(err => {
        console.error('[GoodFeed BG] fetch error:', err);
        sendResponse({ tweets: [] });
      });
    return true; // keep message port open for async response
  }
});

// ── Core fetch logic ──────────────────────────────────────────────────────────
async function handleFetch(query, mode) {
  const cacheKey = `${query}:${mode}`;
  const hit = cache.get(cacheKey);
  if (hit && (Date.now() - hit.ts) < CACHE_TTL) {
    return { tweets: hit.tweets };
  }

  const tweets = await scrapeSearchResults(query, mode);
  cache.set(cacheKey, { tweets, ts: Date.now() });
  return { tweets };
}

// ── Search-tab scraping ───────────────────────────────────────────────────────
async function scrapeSearchResults(query, mode) {
  // Recent  → &f=live  (chronological)
  // Trending → no suffix (X's "Top" ranking), then we re-sort by engagement
  const suffix = mode === 'trending' ? '' : '&f=live';
  const searchUrl = `https://x.com/search?q=${encodeURIComponent(query)}${suffix}`;

  const tab = await chrome.tabs.create({ url: searchUrl, active: false });

  try {
    await waitForTabComplete(tab.id);
    // Give React a moment to hydrate after network load
    await sleep(1500);

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractTweets,
      args: [mode],      // passed as the first argument to extractTweets()
    });

    return Array.isArray(result) ? result : [];
  } catch (err) {
    console.error('[GoodFeed BG] scripting error:', err);
    return [];
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// ── Tab load helper ───────────────────────────────────────────────────────────
function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) { reject(chrome.runtime.lastError); return; }
      if (tab.status === 'complete') { resolve(); return; }

      const onUpdated = (id, info) => {
        if (id !== tabId) return;
        if (info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(onUpdated);

      // Safety timeout — resolve after 15 s regardless
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }, 15000);
    });
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// extractTweets(mode)
// !! Serialised and executed inside the search tab's context. Self-contained. !!
// ─────────────────────────────────────────────────────────────────────────────
function extractTweets(mode) {
  // ── Helpers (must be defined inline — no closure from background.js) ────────
  function parseCount(str) {
    if (!str) return 0;
    const s = str.toString().replace(/,/g, '').trim().toUpperCase();
    const m = s.match(/^([\d.]+)([KMB]?)$/);
    if (!m) return parseInt(s, 10) || 0;
    let n = parseFloat(m[1]);
    if (m[2] === 'K') n *= 1000;
    if (m[2] === 'M') n *= 1_000_000;
    if (m[2] === 'B') n *= 1_000_000_000;
    return Math.round(n);
  }

  function getAvatarUrl(article) {
    // Method 1 — look for an <img> whose src already contains the CDN path
    const directImg = article.querySelector('img[src*="profile_images"]');
    if (directImg && directImg.src && !directImg.src.startsWith('data:')) {
      return directImg.src;
    }

    // Method 2 — walk every <img> inside the tweet's avatar container
    const avatarContainer =
      article.querySelector('[data-testid="Tweet-User-Avatar"]') ||
      article.querySelector('[data-testid="UserAvatar-Container"]');

    const imgPool = avatarContainer
      ? avatarContainer.querySelectorAll('img')
      : article.querySelectorAll('img');

    for (const img of imgPool) {
      // Prefer src
      if (img.src && !img.src.startsWith('data:') && img.src.includes('twimg.com')) {
        return img.src;
      }
      // Fall back to srcset (first candidate)
      if (img.srcset) {
        const first = img.srcset.split(',')[0].trim().split(/\s+/)[0];
        if (first && !first.startsWith('data:') && first.includes('twimg.com')) {
          return first;
        }
      }
    }

    return '';
  }

  function getEngagement(article) {
    // Most reliable: the action group's aria-label contains all counts
    // e.g. "31 replies, 14 reposts, 182 Likes, 14 bookmarks, 891 views"
    const group = article.querySelector('[role="group"]');
    const label = group ? group.getAttribute('aria-label') || '' : '';

    let likeStr = '0', repostStr = '0';

    if (label) {
      const likeM   = label.match(/([\d,]+)\s+Like/i);
      const repostM = label.match(/([\d,]+)\s+(?:repost|Retweet)/i);
      if (likeM)   likeStr   = likeM[1].replace(/,/g, '');
      if (repostM) repostStr = repostM[1].replace(/,/g, '');
    } else {
      // Fallback: scrape visible count spans from the action buttons
      const tryButton = (testId) => {
        const btn = article.querySelector(`[data-testid="${testId}"]`);
        if (!btn) return '0';
        for (const sp of btn.querySelectorAll('span')) {
          const t = sp.textContent.trim();
          if (t && /^\d[\d,KMB.]*$/i.test(t)) return t;
        }
        return '0';
      };
      likeStr   = tryButton('like');
      repostStr = tryButton('retweet');
    }

    return {
      likeStr,
      repostStr,
      likeNum:   parseCount(likeStr),
      repostNum: parseCount(repostStr),
    };
  }

  // ── Main polling loop ───────────────────────────────────────────────────────
  return new Promise((resolve) => {
    const MAX_ATTEMPTS  = 20;
    const POLL_INTERVAL = 600;  // ms
    const MIN_TWEETS    = 3;
    const MAX_RESULTS   = 10;
    let attempts = 0;

    const poll = () => {
      const articles = document.querySelectorAll('article[data-testid="tweet"]');

      if (articles.length >= MIN_TWEETS || attempts >= MAX_ATTEMPTS) {
        const results = [];

        articles.forEach((article, idx) => {
          if (idx >= MAX_RESULTS) return;
          try {
            // ── Tweet URL & IDs ───────────────────────────────────────────────
            const statusLink = article.querySelector('a[href*="/status/"]');
            const tweetUrl   = statusLink ? statusLink.href : null;
            if (!tweetUrl) return;

            const urlMatch = tweetUrl.match(
              /(?:x\.com|twitter\.com)\/([A-Za-z0-9_]+)\/status\/(\d+)/
            );
            if (!urlMatch) return;

            const username = urlMatch[1];
            const tweetId  = urlMatch[2];

            // ── Display name ──────────────────────────────────────────────────
            let displayName = username;
            const nameBlock = article.querySelector('[data-testid="User-Name"]');
            if (nameBlock) {
              for (const sp of nameBlock.querySelectorAll('span')) {
                const txt = sp.textContent.trim();
                if (txt && !txt.startsWith('@') && txt.length < 60) {
                  displayName = txt;
                  break;
                }
              }
            }

            // ── Tweet text ────────────────────────────────────────────────────
            const textEl = article.querySelector('[data-testid="tweetText"]');
            const text   = textEl
              ? (textEl.innerText || textEl.textContent || '').trim()
              : '';
            if (!text) return; // skip media-only / pure-retweet articles

            // ── Avatar ────────────────────────────────────────────────────────
            const avatarUrl = getAvatarUrl(article);

            // ── Timestamp ─────────────────────────────────────────────────────
            const timeEl    = article.querySelector('time');
            const timestamp = timeEl ? (timeEl.getAttribute('datetime') || '') : '';

            // ── Engagement ────────────────────────────────────────────────────
            const { likeStr, repostStr, likeNum, repostNum } = getEngagement(article);

            results.push({
              tweetUrl,
              tweetId,
              username,
              displayName,
              text,
              avatarUrl,
              timestamp,
              likeStr,
              repostStr,
              likeNum,
              repostNum,
            });
          } catch (_) { /* skip malformed tweet */ }
        });

        // Trending mode: sort by combined engagement score descending
        if (mode === 'trending') {
          results.sort((a, b) =>
            (b.likeNum + b.repostNum) - (a.likeNum + a.repostNum)
          );
        }

        resolve(results);
      } else {
        attempts++;
        setTimeout(poll, POLL_INTERVAL);
      }
    };

    setTimeout(poll, 1000); // initial pause for React first render
  });
}
