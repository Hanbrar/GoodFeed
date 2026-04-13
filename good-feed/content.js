// ─────────────────────────────────────────────────────────────────────────────
// GoodFeed — Content Script
// Injected into every x.com / twitter.com page.
// Responsibilities:
//   1. On load (and every SPA navigation) check if we are on the home feed.
//   2. Request top tweets from background.js for the active intent.
//   3. Wait for the For You feed to render, then inject tweet cards.
//   4. Re-inject if X's React re-renders wipe out our cards.
//   5. Listen for popup messages (intent change / toggle).
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  let cachedTweets   = [];   // tweets for the current intent (in-memory cache)
  let cachedIntent   = '';
  let feedObserver   = null; // watches for feed container to appear
  let removalWatcher = null; // watches for our cards being removed by React
  let isFetching     = false;

  // ── Entry point ─────────────────────────────────────────────────────────────
  patchHistoryForSPA();
  window.addEventListener('locationchange', onNavigation);
  window.addEventListener('popstate',       onNavigation);

  init();

  async function init() {
    const { intent, active } = await getStorage(['intent', 'active']);
    if (active && intent && isHomePage()) {
      await activateFeed(intent);
    }
  }

  // ── SPA navigation ──────────────────────────────────────────────────────────
  function patchHistoryForSPA() {
    const orig = history.pushState.bind(history);
    history.pushState = (...args) => {
      orig(...args);
      window.dispatchEvent(new Event('locationchange'));
    };
  }

  async function onNavigation() {
    await sleep(400); // let React finish painting the new route
    const { intent, active } = await getStorage(['intent', 'active']);
    if (active && intent && isHomePage()) {
      await activateFeed(intent);
    } else {
      cleanup();
    }
  }

  // ── Feed activation ─────────────────────────────────────────────────────────
  async function activateFeed(intent) {
    // Return immediately from cache if the intent hasn't changed
    if (cachedTweets.length && cachedIntent === intent) {
      waitForFeedAndInject(cachedTweets);
      return;
    }

    if (isFetching) return;
    isFetching = true;

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'fetchTopTweets',
        query: intent
      });

      if (response?.tweets?.length) {
        cachedTweets  = response.tweets;
        cachedIntent  = intent;
        waitForFeedAndInject(response.tweets);
      }
    } catch (err) {
      console.error('[GoodFeed] Failed to fetch tweets:', err);
    } finally {
      isFetching = false;
    }
  }

  // ── Feed detection & injection ───────────────────────────────────────────────
  function waitForFeedAndInject(tweets) {
    const feed = getFeedContainer();
    if (feed) {
      injectTweets(feed, tweets);
      watchForRemoval(feed, tweets);
      return;
    }

    // Feed not in DOM yet — observe until it appears
    if (feedObserver) feedObserver.disconnect();
    feedObserver = new MutationObserver(() => {
      const f = getFeedContainer();
      if (f) {
        feedObserver.disconnect();
        feedObserver = null;
        injectTweets(f, tweets);
        watchForRemoval(f, tweets);
      }
    });
    feedObserver.observe(document.body, { childList: true, subtree: true });
  }

  function getFeedContainer() {
    return (
      document.querySelector('[data-testid="primaryColumn"]') ||
      document.querySelector('main[role="main"]')
    );
  }

  function injectTweets(container, tweets) {
    // Remove any previous injection
    document.querySelectorAll('.goodfeed-wrapper').forEach(el => el.remove());

    // Find the first rendered tweet article — if not there yet, retry shortly
    const firstArticle = container.querySelector('article[data-testid="tweet"]');
    if (!firstArticle) {
      setTimeout(() => {
        const art = container.querySelector('article[data-testid="tweet"]');
        if (art) doInject(art, tweets);
      }, 1200);
      return;
    }

    doInject(firstArticle, tweets);
  }

  function doInject(firstArticle, tweets) {
    const parent = firstArticle.parentNode;
    if (!parent) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'goodfeed-wrapper';

    tweets.slice(0, 5).forEach(tweet => {
      wrapper.appendChild(buildCard(tweet));
    });

    parent.insertBefore(wrapper, firstArticle);
  }

  // ── Removal watcher (handles React re-renders) ───────────────────────────────
  function watchForRemoval(container, tweets) {
    if (removalWatcher) removalWatcher.disconnect();

    removalWatcher = new MutationObserver(() => {
      if (!document.querySelector('.goodfeed-wrapper')) {
        // Cards got wiped — re-inject after a short delay
        setTimeout(() => injectTweets(container, tweets), 600);
      }
    });

    removalWatcher.observe(container, { childList: true, subtree: true });
  }

  // ── Card builder ─────────────────────────────────────────────────────────────
  function buildCard(tweet) {
    const card = document.createElement('div');
    card.className = 'goodfeed-card';

    // Badge
    const badge = document.createElement('div');
    badge.className   = 'goodfeed-badge';
    badge.textContent = '✦ Good Feed';
    card.appendChild(badge);

    // Clickable link wrapper
    const link = document.createElement('a');
    link.className = 'goodfeed-card-link';
    if (isSafeXUrl(tweet.tweetUrl)) {
      link.href   = tweet.tweetUrl;
      link.target = '_blank';
      link.rel    = 'noopener noreferrer';
    }
    card.appendChild(link);

    // Inner flex row
    const inner = document.createElement('div');
    inner.className = 'goodfeed-card-inner';
    link.appendChild(inner);

    // Avatar
    const avatarCol = document.createElement('div');
    avatarCol.className = 'goodfeed-avatar-col';
    if (tweet.avatarUrl && isSafeImgUrl(tweet.avatarUrl)) {
      const img = document.createElement('img');
      img.className         = 'goodfeed-avatar';
      img.src               = tweet.avatarUrl;
      img.alt               = tweet.displayName || tweet.username || '';
      img.referrerPolicy    = 'no-referrer';
      img.onerror           = () => { img.replaceWith(avatarPlaceholder(tweet)); };
      avatarCol.appendChild(img);
    } else {
      avatarCol.appendChild(avatarPlaceholder(tweet));
    }
    inner.appendChild(avatarCol);

    // Content column
    const contentCol = document.createElement('div');
    contentCol.className = 'goodfeed-content-col';
    inner.appendChild(contentCol);

    // Header row
    const header = document.createElement('div');
    header.className = 'goodfeed-tweet-header';

    const nameSpan = document.createElement('span');
    nameSpan.className   = 'goodfeed-display-name';
    nameSpan.textContent = tweet.displayName || tweet.username || 'User';
    header.appendChild(nameSpan);

    if (tweet.username) {
      const handleSpan = document.createElement('span');
      handleSpan.className   = 'goodfeed-username';
      handleSpan.textContent = `@${tweet.username}`;
      header.appendChild(handleSpan);
    }

    if (tweet.timestamp) {
      const sep = document.createElement('span');
      sep.className   = 'goodfeed-sep';
      sep.textContent = '·';
      header.appendChild(sep);

      const time = document.createElement('span');
      time.className   = 'goodfeed-time';
      time.textContent = formatRelativeTime(tweet.timestamp);
      header.appendChild(time);
    }

    contentCol.appendChild(header);

    // Tweet text
    const textEl = document.createElement('div');
    textEl.className   = 'goodfeed-tweet-text';
    textEl.textContent = tweet.text || '';
    contentCol.appendChild(textEl);

    return card;
  }

  function avatarPlaceholder(tweet) {
    const div = document.createElement('div');
    div.className   = 'goodfeed-avatar-placeholder';
    div.textContent = (tweet.displayName || tweet.username || 'U')[0].toUpperCase();
    return div;
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────────
  function cleanup() {
    document.querySelectorAll('.goodfeed-wrapper').forEach(el => el.remove());
    if (feedObserver)   { feedObserver.disconnect();   feedObserver   = null; }
    if (removalWatcher) { removalWatcher.disconnect(); removalWatcher = null; }
  }

  // ── Popup message listener ───────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action !== 'updateIntent') return;

    cachedTweets = []; // force re-fetch on intent change
    cachedIntent = '';

    if (msg.active && msg.intent && isHomePage()) {
      activateFeed(msg.intent);
    } else {
      cleanup();
    }
  });

  // ── Utility helpers ──────────────────────────────────────────────────────────
  function isHomePage() {
    const p = window.location.pathname;
    return p === '/' || p === '/home';
  }

  function getStorage(keys) {
    return new Promise(resolve => chrome.storage.local.get(keys, resolve));
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function isSafeXUrl(url) {
    if (!url) return false;
    try {
      const u = new URL(url);
      return u.hostname === 'x.com' || u.hostname === 'twitter.com';
    } catch { return false; }
  }

  function isSafeImgUrl(url) {
    if (!url) return false;
    try {
      const u = new URL(url);
      return (
        u.hostname.endsWith('.twimg.com') ||
        u.hostname === 'pbs.twimg.com' ||
        u.hostname === 'abs.twimg.com'
      );
    } catch { return false; }
  }

  function formatRelativeTime(iso) {
    if (!iso) return '';
    try {
      const diff = Date.now() - new Date(iso).getTime();
      const m = Math.floor(diff / 60000);
      if (m < 1)  return 'just now';
      if (m < 60) return `${m}m`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}h`;
      const d = Math.floor(h / 24);
      if (d < 7)  return `${d}d`;
      return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch { return ''; }
  }
})();
