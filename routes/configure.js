const express = require("express");
const router = express.Router();
const path = require("path");
const crypto = require("crypto");
const { ENV, CACHE_VERSION, STREAM_CACHE_VERSION, TORRENT_DOWNLOAD_TIMEOUT_MS } = require("../constants");
const { rc, redis, saveQbitJob, loadQbitJob } = require("../cache");
const { decodeUserCfg } = require("../configStore");
const { normalizePrefs, sanitizeUserPrefs, clampNumber, defaultPrefs } = require("../prefs");
const {
  getPublicBase,
  buildStremThruProxyManifestUrl,
  isQbitEnabledForPrefs,
  shouldOfferQbitForResult,
  getRequestAccessToken,
  hasAdminAccess,
  requireAdminAccess,
  getRssFastPathResults,
  sendConfigurePage,
  fetchScrapStreams,
  isPrivateTrackerCandidate,
  checkRateLimit
} = require("../routeHelpers");
const {
  RESOLUTION, QUALITY, CODEC, AUDIO, VISUAL, LANG,
  TITLE_CLEANUP_REGEX, STOPWORDS,
  first, matchAll, uniq, normTitle,
  getLangs, score,
  normalizeTitleTokens, escapedWordRegex,
  titleMatchScore, relaxedTitleMatchScore,
  extractReleaseYear, normalizeImdbId, getResultImdbId,
  looksLikeEpisodeRelease, isCompletePack,
  parseEpisodeRanges, hasAnyEpisodeMarker,
  episodeMatchRank, animeEpisodeMatchRank,
  seriesEpisodeMatches, animeEpisodeMatches,
  normalizeForDedupe, dedupeResults, dedupeWithCachePriority,
  extractGroup, fmtBytes,
  renameIndexer, stripSourceBadges,
  visibleSeedCount, matchesKeywordBoost,
  splitFilterTerms, textHasAnyTerm,
  resultIndexerText, isPriorityIndexerResult, isRdExcludedResult,
  hasDirectInfoHash, formatStream
} = require("../scoring");
const {
  base32ToHex, extractInfoHash, extractInfoBuf, decodeBencode, extractTorrentFiles,
  pickEpisodeFile, normalizeTorrentLink, torrentFailureKeys, torrentDownloadRecentlyFailed,
  markTorrentDownloadFailed, infoHashQueueKey, InfoHashQueue, infoHashQueue, resolveInfoHash
} = require("../torrentUtils");
const {
  jackettFetchIndexers, fetchIndexerPrivacyMap, jackettSearch, buildQueries, resolveSearchIndexers
} = require("../jackettSearch");
const {
  getPreferredRssIndexers, loadRssItemsForType, rssCatalogMetaId, getRssItemToken,
  parseRssMetaId, parseRssItemId, extractSeriesFeedMarker, extractAnimeFeedMarker,
  buildRssVideos, findRssItemByToken, matchRssItemsByMarker
} = require("../rssHelpers");
const { fetchStremThruStoreLinks } = require("../debrid");
const { fetchTmdbMeta, getImdbIdFromTmdb } = require("../metadata");
const { enrichWithTorrentData, enrichJackettResults } = require("../torrentEnrich");


router.get("/configure", (_, res) => sendConfigurePage(res));

router.get("/:userConfig/configure", (_, res) => sendConfigurePage(res));

router.get("/", (_, res) => res.redirect("/configure"));

module.exports = router;
