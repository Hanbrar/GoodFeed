// ─────────────────────────────────────────────────────────────────────────────
// GoodFeed — Content Script
//
// Core approach:
//   • background.js scrapes real tweet articles from x.com search and sends
//     their outerHTML back here.
//   • We parse those HTML strings with <template> (safe, no script execution)
//     and importNode them into the current document.
//   • The result: pixel-perfect native X tweets injected into the For You feed.
//     No fake CSS cards. No badges. Indistinguishable from regular feed tweets.
//   • We add a single click-handler so the tweet body navigates correctly
//     (X's React onClick handlers don't survive cloning).
//   • A MutationObserver re-injects if React's reconciler overwrites our nodes.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  let cachedTweets   = [];
  let cachedIntent   = '';
  let cachedMode     = '';
  let feedObserver   = null;
  let removalWatcher = null;
  let isFetching     = false;

  // ── Boot ────────────────────────────────────────────────────────────────────
  patchHistoryForSPA();
  window.addEventListener('locationchange', onNavigation);
  window.addEventListener('popstate',       onNavigation);
  init();

  async function init() {
    const { intent, active, mode } = await getStorage(['intent', 'active', 'mode']);
    if (active && intent && isHomePage()) {
      await activateFeed(intent, mode || 'recent');
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
    await sleep(400);
    const { intent, active, mode } = await getStorage(['intent', 'active', 'mode']);
    if (active && intent && isHomePage()) {
      await activateFeed(intent, mode || 'recent');
    } else {
      cleanup();
    }
  }

  // ── Fetch + inject pipeline ─────────────────────────────────────────────────
  async function activateFeed(intent, mode) {
    if (cachedTweets.length && cachedIntent === intent && cachedMode === mode) {
      waitForFeedAndInject(cachedTweets);
      return;
    }

    if (isFetching) return;
    isFetching = true;

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'fetchTopTweets',
        query:  intent,
        mode,
      });

      if (response?.tweets?.length) {
        cachedTweets = response.tweets;
        cachedIntent = intent;
        cachedMode   = mode;
        waitForFeedAndInject(response.tweets);
      }
    } catch (err) {
      console.error('[GoodFeed]', err);
    } finally {
      isFetching = false;
    }
  }

  // ── Feed detection ──────────────────────────────────────────────────────────
  function waitForFeedAndInject(tweets) {
    const feed = getFeedContainer();
    if (feed) {
      injectTweets(feed, tweets);
      watchForRemoval(feed, tweets);
      return;
    }

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

  // ── Injection ───────────────────────────────────────────────────────────────
  function injectTweets(container, tweets) {
    // Clean up any previous injection
    document.querySelectorAll('.goodfeed-wrapper').forEach(el => el.remove());

    const firstArticle = container.querySelector('article[data-testid="tweet"]');
    if (!firstArticle) {
      // Retry once the feed finishes rendering
      setTimeout(() => {
        const art = container.querySelector('article[data-testid="tweet"]');
        if (art) doInject(art, tweets);
      }, 1200);
      return;
    }

    doInject(firstArticle, tweets);
  }

  function doInject(firstArticle, tweets) {
    // X's feed structure: timeline > cell > article
    // We want to insert our block at the timeline level, before the first cell.
    const cell     = firstArticle.parentNode;          // the cell div
    const timeline = cell?.parentNode;                 // the timeline / feed div

    // Decide insertion point: prefer timeline level, fall back to cell level
    const insertParent = timeline || cell || firstArticle.parentNode;
    const insertBefore = timeline ? cell : firstArticle;

    if (!insertParent) return;

    // Invisible wrapper — display:contents makes the wrapper itself a no-op in
    // layout, so our cloned tweets appear as direct children of the timeline.
    const wrapper = document.createElement('div');
    wrapper.className = 'goodfeed-wrapper';

    let injected = 0;
    for (const tweet of tweets.slice(0, 10)) {
      if (!tweet.html) continue;

      const node = cloneFromHtml(tweet.html);
      if (!node) continue;

      // Ensure images that were lazy in the search tab load eagerly here
      fixClonedImages(node);

      // The parsed node could be an <article> or a <div> wrapping an <article>
      const article = node.matches('article') ? node : node.querySelector('article');

      if (article) {
        makeTweetClickable(article, tweet.tweetUrl);
      }

      wrapper.appendChild(node);
      injected++;
    }

    if (injected > 0) {
      insertParent.insertBefore(wrapper, insertBefore);
    }
  }

  // ── Real DOM cloning ────────────────────────────────────────────────────────
  // Parse the HTML string using <template> (inert — no scripts execute, no
  // resources load prematurely) then importNode into the live document so that
  // X's already-loaded stylesheets apply correctly.
  function cloneFromHtml(htmlStr) {
    const t = document.createElement('template');
    t.innerHTML = htmlStr.trim();
    const el = t.content.firstElementChild;
    if (!el) return null;
    // importNode(node, deep=true) adopts the element into the current document.
    return document.importNode(el, true);
  }

  // Ensure images inside a cloned tweet actually load.
  // The search tab is inactive so X's IntersectionObserver never fires — images
  // may still have empty or data-URI src when we capture outerHTML. We fix them
  // here in the visible For You tab where loading will succeed immediately.
  function fixClonedImages(node) {
    node.querySelectorAll('img').forEach(img => {
      img.loading  = 'eager';
      img.decoding = 'async';
      const src = img.getAttribute('src') || '';
      if (!src || src.startsWith('data:')) {
        // X always supplies srcset for media — pick the first real URL
        const srcset = img.getAttribute('srcset') || '';
        if (srcset) {
          const url = srcset.split(',').map(s => s.trim().split(/\s+/)[0])
            .find(u => u && !u.startsWith('data:'));
          if (url) img.src = url;
        }
      }
    });
  }

  // X's React onClick handlers don't survive cloning.
  // Re-attach: clicking anywhere on the article (that isn't an <a> tag) opens
  // the tweet, matching X's native behaviour exactly.
  function makeTweetClickable(article, tweetUrl) {
    if (!tweetUrl) return;
    article.style.cursor = 'pointer';
    article.addEventListener('click', (e) => {
      // Let real <a> links (handles, timestamp, URLs in text) behave natively
      if (e.target.closest('a')) return;
      if (e.ctrlKey || e.metaKey) {
        window.open(tweetUrl, '_blank', 'noopener noreferrer');
      } else {
        window.location.href = tweetUrl;
      }
    });
  }

  // ── Removal watcher (React re-render resilience) ────────────────────────────
  function watchForRemoval(container, tweets) {
    if (removalWatcher) removalWatcher.disconnect();

    removalWatcher = new MutationObserver(() => {
      if (!document.querySelector('.goodfeed-wrapper')) {
        setTimeout(() => injectTweets(container, tweets), 600);
      }
    });

    removalWatcher.observe(container, { childList: true, subtree: true });
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────────
  function cleanup() {
    document.querySelectorAll('.goodfeed-wrapper').forEach(el => el.remove());
    if (feedObserver)   { feedObserver.disconnect();   feedObserver   = null; }
    if (removalWatcher) { removalWatcher.disconnect(); removalWatcher = null; }
  }

  // ── Popup messages ───────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action !== 'updateIntent') return;
    cachedTweets = [];
    cachedIntent = '';
    cachedMode   = '';
    if (msg.active && msg.intent && isHomePage()) {
      activateFeed(msg.intent, msg.mode || 'recent');
    } else {
      cleanup();
    }
  });

  // ── Utilities ────────────────────────────────────────────────────────────────
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
})();
