// ─────────────────────────────────────────────────────────────────────────────
// GoodFeed — Background Service Worker (Manifest V3)
//
// Responsibilities:
//   • Receive "fetchTopTweets" messages from content.js
//   • Open a hidden search tab on x.com, wait for tweets to render, scrape them
//   • Cache results per query (5 min TTL) to avoid redundant tab opens
//   • Return structured tweet data back to the requesting content script
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// In-memory cache: query → { tweets: [], ts: Date.now() }
const cache   = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ── Message router ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'fetchTopTweets' && msg.query) {
    handleFetch(msg.query).then(sendResponse).catch(err => {
      console.error('[GoodFeed BG] fetch error:', err);
      sendResponse({ tweets: [] });
    });
    return true; // keep port open for async response
  }
});

// ── Core fetch logic ──────────────────────────────────────────────────────────
async function handleFetch(query) {
  const hit = cache.get(query);
  if (hit && (Date.now() - hit.ts) < CACHE_TTL) {
    return { tweets: hit.tweets };
  }

  const tweets = await scrapeSearchResults(query);
  cache.set(query, { tweets, ts: Date.now() });
  return { tweets };
}

// ── Search-tab scraping ───────────────────────────────────────────────────────
async function scrapeSearchResults(query) {
  const searchUrl =
    `https://x.com/search?q=${encodeURIComponent(query)}&f=live`;

  // Open a background tab (not focused, so user isn't disturbed)
  const tab = await chrome.tabs.create({ url: searchUrl, active: false });

  try {
    await waitForTabComplete(tab.id);
    // Give React a moment to hydrate the page after the network load finishes
    await sleep(1500);

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractTweets,   // runs inside the search tab's context
    });

    return Array.isArray(result) ? result : [];
  } catch (err) {
    console.error('[GoodFeed BG] scripting error:', err);
    return [];
  } finally {
    // Always close the search tab
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// ── Tab load helper ───────────────────────────────────────────────────────────
function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    // Guard against the tab already being complete before we attach
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

      // Safety timeout — if the tab never reports complete, resolve after 15 s
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
// extractTweets()
// !! This function is SERIALISED and runs inside the search tab's context. !!
// It must be completely self-contained — no closure variables from this file.
// ─────────────────────────────────────────────────────────────────────────────
function extractTweets() {
  return new Promise((resolve) => {
    const MAX_ATTEMPTS  = 20;   // × 600 ms = up to 12 s
    const POLL_INTERVAL = 600;
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
            // ── Tweet URL & username ────────────────────────────────────────
            const statusLink = article.querySelector('a[href*="/status/"]');
            const tweetUrl   = statusLink ? statusLink.href : null;
            if (!tweetUrl) return;

            const urlMatch = tweetUrl.match(
              /(?:x\.com|twitter\.com)\/([A-Za-z0-9_]+)\/status\/(\d+)/
            );
            if (!urlMatch) return;

            const username = urlMatch[1];
            const tweetId  = urlMatch[2];

            // ── Display name ────────────────────────────────────────────────
            // X renders: [data-testid="User-Name"] → div → div → span > span
            let displayName = username;
            const userNameBlock = article.querySelector('[data-testid="User-Name"]');
            if (userNameBlock) {
              // Try to find the first bold/primary text span that isn't @handle
              const spans = userNameBlock.querySelectorAll('span');
              for (const sp of spans) {
                const txt = sp.textContent.trim();
                if (txt && !txt.startsWith('@') && txt.length < 60) {
                  displayName = txt;
                  break;
                }
              }
            }

            // ── Tweet text ──────────────────────────────────────────────────
            const textEl = article.querySelector('[data-testid="tweetText"]');
            const text   = textEl ? (textEl.innerText || textEl.textContent || '').trim() : '';
            if (!text) return; // skip retweets / media-only tweets that have no text

            // ── Avatar ──────────────────────────────────────────────────────
            const avatarEl  = article.querySelector('img[src*="profile_images"]');
            const avatarUrl = avatarEl ? avatarEl.src : '';

            // ── Timestamp ───────────────────────────────────────────────────
            const timeEl   = article.querySelector('time');
            const timestamp = timeEl ? (timeEl.getAttribute('datetime') || '') : '';

            results.push({
              tweetUrl,
              tweetId,
              username,
              displayName,
              text,
              avatarUrl,
              timestamp,
            });
          } catch (_) {
            // Malformed tweet — skip silently
          }
        });

        resolve(results);
      } else {
        attempts++;
        setTimeout(poll, POLL_INTERVAL);
      }
    };

    // Short initial pause — lets React finish the first render pass
    setTimeout(poll, 1000);
  });
}
