(function () {
  'use strict';

  const CACHE_TTL = 5 * 60 * 1000;
  const MAX_RENDERED_TWEETS = 15;
  const STORAGE_PREFIX = 'goodFeedCache:';

  let cachedTweets = [];
  let cachedIntent = '';
  let cachedMode = '';
  let feedObserver = null;
  let removalWatcher = null;
  let activationToken = 0;

  patchHistoryForSPA();
  window.addEventListener('locationchange', onNavigation);
  window.addEventListener('popstate', onNavigation);
  init();

  async function init() {
    const { intent, active, mode } = await getStorage(['intent', 'active', 'mode']);
    if (active && intent && isHomePage()) {
      await activateFeed(intent, mode || 'recent');
    }
  }

  function patchHistoryForSPA() {
    patchHistoryMethod('pushState');
    patchHistoryMethod('replaceState');
  }

  function patchHistoryMethod(methodName) {
    const original = history[methodName];
    if (typeof original !== 'function' || original.__goodFeedPatched) return;

    const wrapped = function (...args) {
      const result = original.apply(this, args);
      window.dispatchEvent(new Event('locationchange'));
      return result;
    };

    wrapped.__goodFeedPatched = true;
    history[methodName] = wrapped;
  }

  async function onNavigation() {
    await sleep(300);
    const { intent, active, mode } = await getStorage(['intent', 'active', 'mode']);
    if (active && intent && isHomePage()) {
      await activateFeed(intent, mode || 'recent');
    } else {
      cleanup();
    }
  }

  async function activateFeed(intent, mode) {
    const feedChanged = cachedIntent !== intent || cachedMode !== mode;
    cachedIntent = intent;
    cachedMode = mode;

    if (feedChanged) {
      if (feedObserver) {
        feedObserver.disconnect();
        feedObserver = null;
      }
      if (removalWatcher) {
        removalWatcher.disconnect();
        removalWatcher = null;
      }
      cachedTweets = [];
      removeInjectedTweets();
    }

    const cacheEntry = await getFeedCache(intent, mode);
    if (cacheEntry?.tweets?.length) {
      cachedTweets = cacheEntry.tweets;
      waitForFeedAndInject(cachedTweets);
    }

    const token = ++activationToken;
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'prefetchTweets',
        query: intent,
        mode,
      });

      if (token !== activationToken) return;
      if (response?.tweets?.length) {
        cachedTweets = response.tweets;
        waitForFeedAndInject(response.tweets);
      }
    } catch (err) {
      console.error('[GoodFeed]', err);
    }
  }

  function waitForFeedAndInject(tweets) {
    if (!tweets?.length || !isHomePage()) return;

    const primaryColumn = getPrimaryColumn();
    const anchor = primaryColumn && getReferenceCell(primaryColumn);
    if (anchor) {
      injectTweets(anchor, tweets);
      watchForRemoval(primaryColumn, tweets);
      return;
    }

    if (feedObserver) feedObserver.disconnect();
    feedObserver = new MutationObserver(() => {
      const column = getPrimaryColumn();
      const nextAnchor = column && getReferenceCell(column);
      if (!nextAnchor) return;

      feedObserver.disconnect();
      feedObserver = null;
      injectTweets(nextAnchor, tweets);
      watchForRemoval(column, tweets);
    });

    feedObserver.observe(primaryColumn || document.body, {
      childList: true,
      subtree: true,
    });
  }

  function getPrimaryColumn() {
    return document.querySelector('[data-testid="primaryColumn"]');
  }

  function getReferenceCell(primaryColumn) {
    if (!primaryColumn) return null;

    const article = primaryColumn.querySelector(
      'article[data-testid="tweet"]:not([data-goodfeed-clone="true"])'
    );
    if (!article) return null;

    const cell = article.closest('[data-testid="cellInnerDiv"]') || article.parentElement;
    const parent = cell?.parentNode;
    if (!cell || !parent) return null;

    return { article, cell, parent };
  }

  function injectTweets(anchor, tweets) {
    removeInjectedTweets();

    const fragment = document.createDocumentFragment();
    let injectedCount = 0;

    for (const tweet of tweets.slice(0, MAX_RENDERED_TWEETS)) {
      const cell = buildInjectedCell(anchor.cell, tweet);
      if (!cell) continue;
      fragment.appendChild(cell);
      injectedCount += 1;
    }

    if (injectedCount > 0) {
      anchor.parent.insertBefore(fragment, anchor.cell);
    }
  }

  function buildInjectedCell(templateCell, tweet) {
    if (!tweet?.html) return null;

    const article = cloneTweetArticle(tweet.html);
    if (!article) return null;

    repairClonedMedia(article);
    makeTweetClickable(article, tweet.tweetUrl);
    article.dataset.goodfeedClone = 'true';

    const cell = templateCell.cloneNode(true);
    cell.dataset.goodfeedInjected = 'true';

    // X's timeline is a virtualized list: each cellInnerDiv carries inline
    // styles like `position: absolute; top: 1234px; transform: translateY(...)`
    // that place it in a precomputed slot. If we keep those, every injected
    // cell lands at the SAME absolute position and stacks on top of the
    // others. Wipe positioning-related inline styles so our cells flow
    // naturally inside the document fragment we insert before the anchor.
    cell.style.position = '';
    cell.style.top = '';
    cell.style.left = '';
    cell.style.right = '';
    cell.style.bottom = '';
    cell.style.transform = '';
    cell.style.height = '';
    cell.style.minHeight = '';
    cell.removeAttribute('aria-rowindex');

    const existingArticle = cell.querySelector('article[data-testid="tweet"]');
    if (existingArticle) {
      existingArticle.replaceWith(article);
    } else {
      cell.appendChild(article);
    }

    return cell;
  }

  function cloneTweetArticle(htmlString) {
    const template = document.createElement('template');
    template.innerHTML = (htmlString || '').trim();
    const root = template.content.firstElementChild;
    if (!root) return null;

    const imported = document.importNode(root, true);
    if (imported.matches?.('article[data-testid="tweet"]')) {
      return imported;
    }

    return imported.querySelector?.('article[data-testid="tweet"]') || null;
  }

  function repairClonedMedia(node) {
    node.querySelectorAll('img').forEach((img) => {
      const nextSrc = firstRealUrl([
        img.getAttribute('src'),
        img.currentSrc,
        extractUrlFromSrcset(img.getAttribute('srcset') || ''),
        findDataUrl(img),
      ]);

      if (nextSrc) {
        img.setAttribute('src', nextSrc);
        img.src = nextSrc;
      }

      img.loading = 'eager';
      img.decoding = 'async';
    });

    node.querySelectorAll('video').forEach((video) => {
      const poster = firstRealUrl([
        video.getAttribute('poster'),
        video.poster,
        findDataUrl(video, /twimg\.com/i),
      ]);

      if (poster) {
        video.setAttribute('poster', poster);
        video.poster = poster;
      }

      const sourceUrl = firstRealUrl([
        video.getAttribute('src'),
        video.currentSrc,
        findDataUrl(video, /(twimg\.com|video\.twimg\.com)/i),
      ]);

      if (sourceUrl) {
        video.setAttribute('src', sourceUrl);
      }

      video.preload = 'metadata';
      video.setAttribute('playsinline', '');

      video.querySelectorAll('source').forEach((source) => {
        const nextSource = firstRealUrl([
          source.getAttribute('src'),
          findDataUrl(source, /(twimg\.com|video\.twimg\.com)/i),
          sourceUrl,
        ]);
        if (nextSource) source.setAttribute('src', nextSource);
      });

      try {
        video.load();
      } catch (_) {
        // Ignore media load failures for cloned nodes.
      }
    });
  }

  function firstRealUrl(values) {
    for (const value of values) {
      if (isRealUrl(value)) return value;
    }
    return '';
  }

  function isRealUrl(value) {
    return typeof value === 'string' &&
      /^https?:\/\//i.test(value) &&
      !value.startsWith('blob:') &&
      !value.startsWith('data:');
  }

  function extractUrlFromSrcset(srcset) {
    if (!srcset) return '';
    return firstRealUrl(
      srcset
        .split(',')
        .map((part) => part.trim().split(/\s+/)[0])
    );
  }

  function findDataUrl(node, pattern) {
    for (const attr of Array.from(node.attributes || [])) {
      if (!isRealUrl(attr.value)) continue;
      if (!pattern || pattern.test(attr.value)) return attr.value;
    }
    return '';
  }

  function makeTweetClickable(article, tweetUrl) {
    if (!tweetUrl) return;

    article.style.cursor = 'pointer';
    article.addEventListener('click', (event) => {
      if (event.target.closest('a')) return;

      if (event.ctrlKey || event.metaKey) {
        window.open(tweetUrl, '_blank', 'noopener,noreferrer');
      } else {
        window.location.href = tweetUrl;
      }
    });
  }

  function watchForRemoval(primaryColumn, tweets) {
    if (removalWatcher) removalWatcher.disconnect();

    removalWatcher = new MutationObserver(() => {
      if (!isHomePage()) return;
      if (document.querySelector('[data-goodfeed-injected="true"]')) return;

      const liveColumn = getPrimaryColumn();
      const anchor = getReferenceCell(liveColumn || primaryColumn);
      if (!anchor) return;

      setTimeout(() => {
        if (document.querySelector('[data-goodfeed-injected="true"]')) return;

        const nextColumn = getPrimaryColumn() || primaryColumn;
        const nextAnchor = getReferenceCell(nextColumn);
        if (nextAnchor) injectTweets(nextAnchor, tweets);
      }, 500);
    });

    removalWatcher.observe(primaryColumn, {
      childList: true,
      subtree: true,
    });
  }

  function removeInjectedTweets() {
    document.querySelectorAll('[data-goodfeed-injected="true"], .goodfeed-wrapper')
      .forEach((element) => element.remove());
  }

  function cleanup() {
    activationToken += 1;
    removeInjectedTweets();
    if (feedObserver) {
      feedObserver.disconnect();
      feedObserver = null;
    }
    if (removalWatcher) {
      removalWatcher.disconnect();
      removalWatcher = null;
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'updateIntent') {
      if (msg.active && msg.intent && isHomePage()) {
        activateFeed(msg.intent, msg.mode || 'recent');
      } else {
        cachedTweets = [];
        cachedIntent = '';
        cachedMode = '';
        cleanup();
      }
      return;
    }

    if (msg.action !== 'streamTweets') return;
    if (!isHomePage()) return;
    if (msg.query !== cachedIntent) return;
    if ((msg.mode || 'recent') !== cachedMode) return;

    cachedTweets = Array.isArray(msg.tweets) ? msg.tweets : [];
    if (cachedTweets.length) {
      waitForFeedAndInject(cachedTweets);
    } else if (msg.done) {
      removeInjectedTweets();
    }
  });

  async function getFeedCache(intent, mode) {
    const key = getCacheKey(intent, mode);
    const entry = (await getStorage(key))[key];
    if (!entry) return null;
    if ((Date.now() - entry.ts) >= CACHE_TTL) return null;
    return entry;
  }

  function getCacheKey(intent, mode) {
    return `${STORAGE_PREFIX}${mode}:${encodeURIComponent((intent || '').trim().toLowerCase())}`;
  }

  function isHomePage() {
    const path = window.location.pathname;
    return path === '/' || path === '/home';
  }

  function getStorage(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
