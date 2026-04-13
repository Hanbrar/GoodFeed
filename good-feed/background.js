'use strict';

const CACHE_TTL = 5 * 60 * 1000;
const RESULT_TARGET = 15;
const MIN_PROGRESS_RESULTS = 10;
const MAX_STREAM_ATTEMPTS = 18;
const STREAM_DELAY_MS = 850;
const STORAGE_PREFIX = 'goodFeedCache:';

const memoryCache = new Map();
const inflightFetches = new Map();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg?.query) return;

  const mode = msg.mode || 'recent';

  if (msg.action === 'fetchTopTweets') {
    fetchTopTweets(msg.query, mode)
      .then(sendResponse)
      .catch((err) => {
        console.error('[GoodFeed BG]', err);
        sendResponse({ tweets: [], done: true });
      });
    return true;
  }

  if (msg.action === 'prefetchTweets') {
    prefetchTweets(msg.query, mode)
      .then(sendResponse)
      .catch((err) => {
        console.error('[GoodFeed BG]', err);
        sendResponse({ tweets: [], done: false });
      });
    return true;
  }
});

async function fetchTopTweets(query, mode) {
  const key = getCacheKey(query, mode);
  const cached = await getCachedEntry(key);

  if (cached && isFresh(cached) && cached.done) {
    return { tweets: cached.tweets, done: true, cached: true };
  }

  const tweets = await ensureFetchJob(query, mode);
  return { tweets, done: true };
}

async function prefetchTweets(query, mode) {
  const key = getCacheKey(query, mode);
  const cached = await getCachedEntry(key);

  if (cached && isFresh(cached)) {
    await broadcastTweets(query, mode, cached.tweets, !!cached.done);
    if (!cached.done) ensureFetchJob(query, mode);
    return { tweets: cached.tweets, done: !!cached.done, cached: true };
  }

  ensureFetchJob(query, mode);
  return { tweets: [], done: false, started: true };
}

function ensureFetchJob(query, mode) {
  const key = getCacheKey(query, mode);
  if (inflightFetches.has(key)) {
    return inflightFetches.get(key);
  }

  const job = streamSearchResults(query, mode)
    .catch((err) => {
      console.error('[GoodFeed BG]', err);
      return [];
    })
    .finally(() => {
      inflightFetches.delete(key);
    });

  inflightFetches.set(key, job);
  return job;
}

async function streamSearchResults(query, mode) {
  const suffix = mode === 'trending' ? '' : '&f=live';
  const url = `https://x.com/search?q=${encodeURIComponent(query)}${suffix}`;

  const tab = await chrome.tabs.create({ url, active: false });
  const collected = new Map();
  let bestTweets = [];
  let lastSignature = '';
  let stableRounds = 0;

  try {
    await waitForTabComplete(tab.id);
    await sleep(1800);

    for (let attempt = 0; attempt < MAX_STREAM_ATTEMPTS; attempt++) {
      await nudgeSearchTimeline(tab.id, attempt);
      await sleep(attempt === 0 ? 500 : STREAM_DELAY_MS);

      const snapshot = await snapshotTweets(tab.id, mode);
      mergeSnapshot(collected, snapshot.tweets || []);

      const nextTweets = materializeTweets(collected, mode).slice(0, RESULT_TARGET);
      const nextSignature = getTweetsSignature(nextTweets);

      if (nextTweets.length && nextSignature !== lastSignature) {
        bestTweets = nextTweets;
        lastSignature = nextSignature;
        stableRounds = 0;
        await cacheAndBroadcast(query, mode, bestTweets, false);
      } else {
        stableRounds += 1;
      }

      const enoughTweets = nextTweets.length >= RESULT_TARGET;
      const enoughProgress = nextTweets.length >= MIN_PROGRESS_RESULTS;
      const enoughArticles = (snapshot.articleCount || 0) >= RESULT_TARGET;
      if (
        enoughTweets ||
        (enoughArticles && enoughProgress && stableRounds >= 1) ||
        (attempt >= 6 && enoughProgress && stableRounds >= 2)
      ) {
        break;
      }
    }
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }

  await cacheAndBroadcast(query, mode, bestTweets, true);
  return bestTweets;
}

function mergeSnapshot(collected, tweets) {
  for (const tweet of tweets) {
    if (!tweet?.tweetId) continue;

    const existing = collected.get(tweet.tweetId);
    if (!existing) {
      collected.set(tweet.tweetId, {
        ...tweet,
        firstSeenOrder: collected.size,
      });
      continue;
    }

    collected.set(tweet.tweetId, {
      ...existing,
      ...tweet,
      firstSeenOrder: existing.firstSeenOrder,
    });
  }
}

function materializeTweets(collected, mode) {
  const tweets = Array.from(collected.values());
  if (mode === 'trending') {
    tweets.sort((a, b) => {
      if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
      return (a.firstSeenOrder || 0) - (b.firstSeenOrder || 0);
    });
  } else {
    tweets.sort((a, b) => (a.firstSeenOrder || 0) - (b.firstSeenOrder || 0));
  }

  return tweets.map((tweet) => ({
    html: tweet.html,
    tweetUrl: tweet.tweetUrl,
    tweetId: tweet.tweetId,
    username: tweet.username,
    timestamp: tweet.timestamp,
    likeNum: tweet.likeNum,
    repostNum: tweet.repostNum,
    score: tweet.score || 0,
  }));
}

async function snapshotTweets(tabId, mode) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractTweetsSnapshot,
    args: [mode, RESULT_TARGET],
  });

  if (!result || typeof result !== 'object') {
    return { tweets: [], articleCount: 0 };
  }

  return {
    tweets: Array.isArray(result.tweets) ? result.tweets : [],
    articleCount: Number(result.articleCount) || 0,
  };
}

async function nudgeSearchTimeline(tabId, attempt) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: scrollSearchTimeline,
    args: [attempt],
  });
}

async function cacheAndBroadcast(query, mode, tweets, done) {
  const key = getCacheKey(query, mode);
  const entry = { tweets, ts: Date.now(), done };
  memoryCache.set(key, entry);
  await setStorage({ [key]: entry });
  await broadcastTweets(query, mode, tweets, done);
}

async function broadcastTweets(query, mode, tweets, done) {
  const tabs = await chrome.tabs.query({
    url: ['https://x.com/*', 'https://twitter.com/*'],
  });

  await Promise.all(tabs.map((tab) =>
    chrome.tabs.sendMessage(tab.id, {
      action: 'streamTweets',
      query,
      mode,
      tweets,
      done,
    }).catch(() => {})
  ));
}

async function getCachedEntry(key) {
  const hit = memoryCache.get(key);
  if (hit) return hit;

  const stored = await getStorage(key);
  const entry = stored[key];
  if (entry) memoryCache.set(key, entry);
  return entry || null;
}

function isFresh(entry) {
  return !!entry && (Date.now() - entry.ts) < CACHE_TTL;
}

function getCacheKey(query, mode) {
  return `${STORAGE_PREFIX}${mode}:${encodeURIComponent((query || '').trim().toLowerCase())}`;
}

function getTweetsSignature(tweets) {
  return tweets.map((tweet) => `${tweet.tweetId}:${tweet.timestamp || ''}`).join('|');
}

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }

      if (tab.status === 'complete') {
        resolve();
        return;
      }

      const listener = (updatedTabId, info) => {
        if (updatedTabId !== tabId || info.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      };

      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 15000);
    });
  });
}

function getStorage(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function setStorage(items) {
  return new Promise((resolve) => chrome.storage.local.set(items, resolve));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scrollSearchTimeline(attempt) {
  const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  const targetIndex = Math.min(articles.length - 1, Math.max(0, attempt * 2 + 2));
  const target = articles[targetIndex];

  if (target) {
    target.scrollIntoView({ block: 'center' });
  } else {
    window.scrollTo(0, document.documentElement.scrollHeight);
  }

  window.scrollBy(0, Math.max(window.innerHeight, 900));
}

function extractTweetsSnapshot(mode, maxResults) {
  const MAX_CANDIDATES = Math.max(maxResults * 2, 30);

  function parseCount(str) {
    if (!str) return 0;
    const normalized = str.toString().replace(/,/g, '').trim().toUpperCase();
    const match = normalized.match(/^([\d.]+)([KMB]?)$/);
    if (!match) return parseInt(normalized, 10) || 0;

    let value = parseFloat(match[1]);
    if (match[2] === 'K') value *= 1e3;
    if (match[2] === 'M') value *= 1e6;
    if (match[2] === 'B') value *= 1e9;
    return Math.round(value);
  }

  function getEngagement(article) {
    const group = article.querySelector('[role="group"]');
    const label = group?.getAttribute('aria-label') || '';
    let likeNum = 0;
    let repostNum = 0;

    if (label) {
      const likeMatch = label.match(/([\d,.KMB]+)\s+Like/i);
      const repostMatch = label.match(/([\d,.KMB]+)\s+(?:repost|Retweet)/i);
      if (likeMatch) likeNum = parseCount(likeMatch[1]);
      if (repostMatch) repostNum = parseCount(repostMatch[1]);
    } else {
      likeNum = readCountButton(article, 'like');
      repostNum = readCountButton(article, 'retweet');
    }

    return { likeNum, repostNum };
  }

  function readCountButton(article, testId) {
    const button = article.querySelector(`[data-testid="${testId}"]`);
    if (!button) return 0;

    for (const span of button.querySelectorAll('span')) {
      const text = (span.textContent || '').trim();
      if (text && /^\d[\d,.KMB]*$/i.test(text)) {
        return parseCount(text);
      }
    }

    return 0;
  }

  function isRealUrl(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url) && !url.startsWith('blob:') && !url.startsWith('data:');
  }

  function firstRealUrl(values) {
    for (const value of values) {
      if (isRealUrl(value)) return value;
    }
    return '';
  }

  function extractUrlFromSrcset(srcset) {
    if (!srcset) return '';
    return firstRealUrl(
      srcset
        .split(',')
        .map((part) => part.trim().split(/\s+/)[0])
    );
  }

  function getReactMediaUrl(node, matcher) {
    const reactKey = Object.keys(node).find((key) =>
      key.startsWith('__reactProps') || key.startsWith('__reactFiber')
    );
    if (!reactKey) return '';

    const visited = new Set();
    const queue = [node[reactKey]];
    while (queue.length) {
      const value = queue.shift();
      if (!value || typeof value !== 'object' || visited.has(value)) continue;
      visited.add(value);

      for (const child of Object.values(value)) {
        if (typeof child === 'string' && matcher(child)) {
          return child;
        }
        if (child && typeof child === 'object') {
          queue.push(child);
        }
      }
    }

    return '';
  }

  function findDataUrl(node, matcher) {
    for (const attr of Array.from(node.attributes || [])) {
      if (matcher(attr.value)) return attr.value;
    }
    return '';
  }

  function repairImage(img) {
    const nextSrc = firstRealUrl([
      img.getAttribute('src'),
      img.currentSrc,
      extractUrlFromSrcset(img.getAttribute('srcset') || ''),
      findDataUrl(img, isRealUrl),
      getReactMediaUrl(img, isRealUrl),
    ]);

    if (nextSrc) {
      img.setAttribute('src', nextSrc);
      img.src = nextSrc;
    }

    const nextSrcset = img.getAttribute('srcset') || '';
    if (nextSrcset) img.setAttribute('srcset', nextSrcset);
    img.loading = 'eager';
    img.decoding = 'async';
  }

  function repairVideo(video) {
    const posterMatcher = (value) => isRealUrl(value) && /twimg\.com/i.test(value);
    const sourceMatcher = (value) => isRealUrl(value) && /(twimg\.com|video\.twimg\.com)/i.test(value);

    const poster = firstRealUrl([
      video.getAttribute('poster'),
      video.poster,
      findDataUrl(video, posterMatcher),
      getReactMediaUrl(video, posterMatcher),
    ]);

    if (poster) {
      video.setAttribute('poster', poster);
      video.poster = poster;
    }

    const videoSrc = firstRealUrl([
      video.getAttribute('src'),
      video.currentSrc,
      findDataUrl(video, sourceMatcher),
      getReactMediaUrl(video, sourceMatcher),
    ]);

    if (videoSrc) {
      video.setAttribute('src', videoSrc);
    }

    video.preload = 'metadata';
    video.setAttribute('playsinline', '');

    for (const source of video.querySelectorAll('source')) {
      const sourceUrl = firstRealUrl([
        source.getAttribute('src'),
        findDataUrl(source, sourceMatcher),
        getReactMediaUrl(source, sourceMatcher),
        videoSrc,
      ]);
      if (sourceUrl) source.setAttribute('src', sourceUrl);
    }
  }

  function normalizeMedia(article) {
    article.querySelectorAll('img').forEach(repairImage);
    article.querySelectorAll('video').forEach(repairVideo);
  }

  const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  const candidates = [];
  const seenTweetIds = new Set();

  articles.forEach((article, index) => {
    if (index >= MAX_CANDIDATES) return;

    try {
      const statusLink = article.querySelector('a[href*="/status/"]');
      const tweetUrl = statusLink?.href;
      if (!tweetUrl) return;

      const urlMatch = tweetUrl.match(/(?:x\.com|twitter\.com)\/([A-Za-z0-9_]+)\/status\/(\d+)/);
      if (!urlMatch) return;

      const tweetId = urlMatch[2];
      if (seenTweetIds.has(tweetId)) return;
      seenTweetIds.add(tweetId);

      const textEl = article.querySelector('[data-testid="tweetText"]');
      const text = textEl ? (textEl.innerText || textEl.textContent || '').trim() : '';
      const hasMedia = !!article.querySelector(
        '[data-testid="tweetPhoto"], [data-testid="videoComponent"], [data-testid="card.wrapper"], video, img'
      );
      if (!text && !hasMedia) return;

      normalizeMedia(article);

      const { likeNum, repostNum } = getEngagement(article);
      const timeEl = article.querySelector('time');
      const timestamp = timeEl?.getAttribute('datetime') || '';
      const score = likeNum + repostNum * 2.5;

      candidates.push({
        html: article.outerHTML,
        tweetUrl,
        tweetId,
        username: urlMatch[1],
        timestamp,
        likeNum,
        repostNum,
        score,
        domIndex: index,
      });
    } catch (_) {
      // Ignore malformed tweets in the search feed.
    }
  });

  if (mode === 'trending') {
    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.domIndex - b.domIndex;
    });
  }

  return {
    articleCount: articles.length,
    tweets: candidates.slice(0, maxResults),
  };
}
