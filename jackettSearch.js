"use strict";
const crypto = require("crypto");
const axios  = require("axios");
const { rc } = require("./cache");
const { 
  normTitle, 
  uniq, 
  normalizeImdbId, 
  extractReleaseYear, 
  dedupeResults 
} = require("./scoring");

const ENV = {
  jackettUrl: (process.env.JACKETT_URL || "http://localhost:9117").replace(/\/+$/, ""),
  apiKey:     (process.env.JACKETT_API_KEY || "").trim(),
};

const CACHE_VERSION = 5;

async function jackettFetchIndexers(url, key) {
  const jUrl = (url || ENV.jackettUrl).replace(/\/+$/, "");
  const jKey = key || ENV.apiKey;
  try {
    const params = { t: "indexers", configured: "true" };
    if (jKey) params.apikey = jKey;
    const res = await axios.get(`${jUrl}/api/v2.0/indexers/all/results/torznab/api`, {
      params, timeout: 8000,
      responseType: "text", validateStatus: () => true,
    });
    if (res.status < 400 && typeof res.data === "string") {
      const indexers = [];
      for (const m of res.data.matchAll(/<indexer\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/indexer>/gi)) {
        const id = m[1];
        if (!id || id === "all") continue;
        const titleMatch = m[2].match(/<title>([^<]+)<\/title>/i);
        const name = titleMatch ? decodeXmlEntities(titleMatch[1].trim()) : id;
        indexers.push({ id, name });
      }
      if (indexers.length) return indexers;
    }
  } catch {}
  // Fallback Prowlarr
  try {
    const res = await axios.get(`${jUrl}/api/v1/indexer`, {
      params: { apikey: jKey }, timeout: 8000, validateStatus: () => true,
    });
    if (res.status < 400 && Array.isArray(res.data)) {
      return res.data.map(ix => ({ id: String(ix.id || "").trim(), name: String(ix.name || "").trim() })).filter(ix => ix.id);
    }
  } catch {}
  return [];
}

async function fetchIndexerPrivacyMap(url, key) {
  const jUrl = (url || ENV.jackettUrl).replace(/\/+$/, "");
  const jKey = key || ENV.apiKey;
  try {
    const res = await axios.get(`${jUrl}/api/v1/indexer`, {
      params: { apikey: jKey }, timeout: 8000, validateStatus: () => true,
    });
    if (res.status < 400 && Array.isArray(res.data)) {
      const out = new Map();
      for (const ix of res.data) {
        const id = String(ix.id || "").trim();
        if (!id) continue;
        out.set(id, {
          private: ix.privacy === "private" || ix.privacy === "semiPrivate",
          privacy: ix.privacy || null,
        });
      }
      return out;
    }
  } catch {}
  return new Map();
}

function decodeXmlEntities(str = "") {
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g,  "&")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&apos;/g, "'");
}

function xmlTagValue(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? decodeXmlEntities(m[1].trim()) : null;
}

function parseTorznabResults(xml, indexer) {
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  return items.map(item => {
    const attrs = {};
    const matches = item.matchAll(/<(?:torznab:)?attr\s+name="([^"]+)"\s+value="([^"]*)"\s*\/?/gi);
    for (const m of matches) attrs[m[1].toLowerCase()] = decodeXmlEntities(m[2]);

    const enclosure = item.match(/<enclosure\b[^>]*url="([^"]+)"[^>]*length="([^"]*)"/i);
    const magnetUri = attrs.magneturl || null;
    const link      = magnetUri ? magnetUri : (xmlTagValue(item, "link") || enclosure?.[1] || null);
    const size      = attrs.size ? parseInt(attrs.size, 10) : (enclosure?.[2] ? parseInt(enclosure[2], 10) : 0);
    const seedersParsed = attrs.seeders != null ? parseInt(attrs.seeders, 10) : null;
    const seedersRaw = Number.isFinite(seedersParsed) ? seedersParsed : null;
    const seeders    = seedersRaw ?? 0;

    return {
      Title:       xmlTagValue(item, "title") || "",
      Guid:        xmlTagValue(item, "guid")  || link || magnetUri || "",
      Link:        link,
      MagnetUri:   magnetUri,
      Size:        Number.isFinite(size) ? size : 0,
      Seeders:     Number.isFinite(seeders) ? seeders : 0,
      _displaySeeds: seedersRaw ?? 0,
      InfoHash:    attrs.infohash ? attrs.infohash.toLowerCase() : null,
      Tracker:     indexer,
      TrackerId:   indexer,
      ImdbId:      normalizeImdbId(attrs.imdbid || attrs.imdb || attrs.imdbidnum || attrs.imdbnum),
      PublishDate: xmlTagValue(item, "pubDate") || null,
      _structuredMatch: true,
    };
  }).filter(r => r.Title && (r.Link || r.MagnetUri || r.Guid));
}

function normalizeProwlarrInfoHash(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (/^[0-9a-f]{40}$/.test(value)) return value;
  if (/^[0-9a-f]{80}$/.test(value)) {
    try {
      const ascii = Buffer.from(value, "hex").toString("utf8").trim().toLowerCase();
      if (/^[0-9a-f]{40}$/.test(ascii)) return ascii;
    } catch {}
  }
  return null;
}

function parseProwlarrResults(items, indexer) {
  return (Array.isArray(items) ? items : []).map(item => {
    const seedersParsed = item.seeders != null ? Number(item.seeders) : null;
    const seedersRaw = Number.isFinite(seedersParsed) ? seedersParsed : null;
    return {
      Title:     item.title || "",
      Guid:      item.guid || item.downloadUrl || item.magnetUrl || "",
      Link:      item.downloadUrl || item.magnetUrl || (item.guid?.startsWith("http") ? item.guid : null) || null,
      MagnetUri: item.magnetUrl && item.magnetUrl.startsWith("magnet:") ? item.magnetUrl : null,
      Size:      Number(item.size) || 0,
      Seeders:   seedersRaw ?? 0,
      _displaySeeds: seedersRaw ?? 0,
      InfoHash:  normalizeProwlarrInfoHash(item.infoHash),
      Tracker:   item.indexer || indexer,
      TrackerId: String(item.indexerId || indexer || "").trim(),
      ImdbId:    normalizeImdbId(item.imdbId),
      PublishDate: item.publishDate || null,
      _structuredMatch: false,
    };
  }).filter(r => r.Title && (r.Link || r.MagnetUri || r.Guid));
}

async function prowlarrSearch(query, indexer, limit = 50, jUrl, jKey, timeout = 15000) {
  const res = await axios.get(`${jUrl}/api/v1/search`, {
    params: { apikey: jKey, query, type: "search", indexerIds: indexer, limit, offset: 0, categories: [2000, 5000] },
    timeout,
    validateStatus: () => true,
  });
  if (res.status === 429) throw Object.assign(new Error("Rate limited"), { response: res });
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
  return parseProwlarrResults(res.data, indexer);
}

async function prowlarrStructuredSearch(search, indexer, jUrl, jKey, timeout = 15000) {
  if (!search?.mode || !search?.imdbId) return [];
  const params = {
    apikey: jKey,
    query: search.title || "",
    type: search.mode === "movie" ? "movie" : "tvsearch",
    indexerIds: indexer,
    limit: 50,
    offset: 0,
    categories: search.mode === "movie" ? [2000] : [5000],
  };
  if (search.imdbId) params.imdbId = search.imdbId.replace(/^tt/i, "");
  if (search.season  != null) params.season  = search.season;
  if (search.episode != null) params.episode = search.episode;
  const res = await axios.get(`${jUrl}/api/v1/search`, {
    params, timeout, validateStatus: () => true,
  });
  if (res.status === 429) throw Object.assign(new Error("Rate limited"), { response: res });
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
  return parseProwlarrResults(res.data, indexer).map(r => ({ ...r, _structuredMatch: true }));
}

async function jackettTextSearch(query, indexer, timeout, jUrl, jKey) {
  const params = { Query: query, Category: [2000, 5000] };
  if (jKey) params.apikey = jKey;
  const res = await axios.get(
    `${jUrl}/api/v2.0/indexers/${indexer}/results`,
    { params, timeout, validateStatus: () => true }
  );
  if (res.status === 404 || res.status === 401) return prowlarrSearch(query, indexer, 50, jUrl, jKey, timeout);
  if (res.status === 429) throw Object.assign(new Error("Rate limited"), { response: res });
  if (res.status >= 400)  throw new Error(`HTTP ${res.status}`);
  return (res.data?.Results || []).map(r => ({ ...r, _structuredMatch: false }));
}

async function jackettStructuredSearch(search, indexer, timeout, jUrl, jKey) {
  if (!search?.mode || !search?.imdbId) return [];
  const params = { apikey: jKey, t: search.mode, imdbid: search.imdbId, q: search.title, cat: search.mode === "movie" ? "2000" : "5000" };
  if (search.year)    params.year   = search.year;
  if (search.season  != null) params.season = search.season;
  if (search.episode != null) params.ep     = search.episode;

  const res = await axios.get(
    `${jUrl}/api/v2.0/indexers/${indexer}/results/torznab/api`,
    { params, timeout, responseType: "text", validateStatus: () => true }
  );
  if (res.status === 404) return [];
  if (res.status === 429) throw Object.assign(new Error("Rate limited"), { response: res });
  if (res.status >= 400)  throw new Error(`HTTP ${res.status}`);
  return parseTorznabResults(String(res.data || ""), indexer);
}

const activeSearches = new Map();

async function setRateLimit(indexer, retryAfterHeader) {
  const parsed = parseInt(retryAfterHeader || "", 10);
  const ttl    = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 3600) : 90;
  await rc.set(`rl:${indexer}`, "1", ttl);
}

async function isRateLimited(indexer) {
  return !!(await rc.get(`rl:${indexer}`));
}

async function jackettSearchOneIndexer(indexer, plan, timeout, fastTimeout, jUrl, jKey) {
  if (await isRateLimited(indexer)) return [];
  
  const searchKey = `${indexer.url || indexer}|${JSON.stringify(plan.queries)}|${JSON.stringify(plan.search || {})}`;
  let searchPromise = activeSearches.get(searchKey);
  if (!searchPromise) {
    searchPromise = (async () => {
      const t0 = Date.now();
      const isProwlarr = /^\d+$/.test(String(indexer));
      try {
        let results = [];
        if (!isProwlarr && plan.search && !plan.parsed?.isAnime) {
          try {
            results = await jackettStructuredSearch(plan.search, indexer, timeout, jUrl, jKey);
          } catch (err) {
            console.log(`  ${indexer}: erro na busca estruturada: ${err.message}`);
            if (err.response?.status === 429) throw err;
          }
        }
        if (results.length === 0 && isProwlarr && plan.search && !plan.parsed?.isAnime) {
          try {
            results = await prowlarrStructuredSearch(plan.search, indexer, jUrl, jKey, timeout);
          } catch (err) {
            console.log(`  ${indexer}: erro na busca estruturada Prowlarr: ${err.message}`);
            if (err.response?.status === 429) throw err;
          }
        }
        if (results.length === 0) {
          for (const query of plan.queries) {
            try {
              const textResults = isProwlarr
                ? await prowlarrSearch(query, indexer, 50, jUrl, jKey, timeout)
                : await jackettTextSearch(query, indexer, timeout, jUrl, jKey);
              results.push(...textResults);
              if (results.length > 0) break;
            } catch (err) {
              console.log(`  ${indexer}: erro na busca por texto "${query}": ${err.message}`);
              if (err.response?.status === 429) throw err;
            }
          }
        }
        const ms   = Date.now() - t0;
        await trackMetrics(indexer, ms, results.length, true);
        const mode = results.some(r => r._structuredMatch) ? "estruturado" : "texto";
        console.log(`  ${indexer}: ${results.length} resultados (${ms}ms, ${mode})`);
        return results;
      } catch (err) {
        const ms = Date.now() - t0;
        console.log(`  ${indexer}: ERRO FATAL: ${err.message} (${ms}ms)`);
        if (err.response?.status === 429) await setRateLimit(indexer, err.response?.headers?.["retry-after"]);
        if (err.code === "ECONNABORTED" && timeout === fastTimeout)
          console.log(`  ${indexer}: timeout lento de ${ms}ms (indo para background)`);
        return [];
      }
    })();
    activeSearches.set(searchKey, searchPromise);
  }
  return searchPromise;
}

async function trackMetrics(indexer, ms, count, ok) {
  const key = `metrics:${indexer}`;
  const raw = await rc.get(key);
  const m   = raw ? JSON.parse(raw) : { calls: 0, totalMs: 0, totalResults: 0, failures: 0 };
  m.calls++; m.totalMs += ms; m.totalResults += count;
  if (!ok) m.failures++;
  m.avgMs       = Math.round(m.totalMs      / m.calls);
  m.avgResults  = Math.round(m.totalResults / m.calls);
  m.successRate = Math.round(((m.calls - m.failures) / m.calls) * 100);
  m.lastCall    = new Date().toISOString();
  await rc.set(key, JSON.stringify(m), 86400);
}

async function jackettSearch(plan, indexers, prefs) {
  const t0 = Date.now();
  const jUrl      = (prefs?.jackett?.url || ENV.jackettUrl).replace(/\/+$/, "");
  const jKey      = prefs?.jackett?.key  || ENV.apiKey;
  const queryList = uniq(Array.isArray(plan?.queries) ? plan.queries : [plan?.queries].filter(Boolean));
  const sourceHash = crypto.createHash("sha256").update(`${jUrl}\n${jKey}`).digest("hex").slice(0, 16);
  const cacheKey  = `search:${CACHE_VERSION}:${Buffer.from(JSON.stringify({
    queryList,
    search: plan?.search || null,
    parsed: plan?.parsed || null,
    sourceHash,
    indexers,
    dedupe: prefs.dedupe !== false,
  })).toString("base64url")}`;
  const cached    = await rc.get(cacheKey);
  if (cached) {
    console.log(`Cache HIT para buscas: ${JSON.stringify(queryList)}`);
    return JSON.parse(cached);
  }
  const FAST_TIMEOUT = (prefs?.slowThreshold > 0 ? prefs.slowThreshold : 8000);
  const SLOW_TIMEOUT = 50000;
  console.log(`Jackett iniciando busca: "${queryList[0] || plan?.search?.title || "sem titulo"}" em [${indexers.length} indexers]`);
  console.log(`Fase rapida: aguardando respostas... (${FAST_TIMEOUT}ms max)`);

  const resultsByIndexer = new Map();
  let fastPhaseActive = true;

  const searchPromises = indexers.map(async (indexer) => {
    try {
      const res = await jackettSearchOneIndexer(indexer, plan, SLOW_TIMEOUT, FAST_TIMEOUT, jUrl, jKey);
      if (fastPhaseActive) {
        resultsByIndexer.set(indexer, res);
      }
      return res;
    } catch {
      return [];
    }
  });

  await Promise.race([
    Promise.all(searchPromises),
    new Promise(resolve => setTimeout(resolve, FAST_TIMEOUT))
  ]);

  fastPhaseActive = false;
  const fastFlat    = [...resultsByIndexer.values()].flat();
  const fastDeduped = prefs.dedupe !== false ? dedupeResults(fastFlat) : fastFlat;
  if (resultsByIndexer.size < indexers.length) {
    fastDeduped._incomplete = true;
  }
  const t1 = Date.now();
  console.log(`[Scrape] Conclusão da janela rápida em ${t1 - t0}ms: ${fastFlat.length} brutos -> ${fastDeduped.length} ${prefs.dedupe !== false ? 'deduplicados' : 'resultados'}`);

  Promise.all(searchPromises).then(async (allResults) => {
    try {
      const slowFlat    = allResults.flat();
      const slowDeduped = prefs.dedupe !== false ? dedupeResults(slowFlat) : slowFlat;
      const t2 = Date.now();
      if (slowDeduped.length > fastDeduped.length) {
        console.log(`[Background] Conclusão total do scrape em ${t2 - t0}ms. Cache atualizado: ${fastDeduped.length} -> ${slowDeduped.length}`);
        if (slowDeduped.length > 0) await rc.set(cacheKey, JSON.stringify(slowDeduped), 10800);
      } else {
        if (fastDeduped.length > 0) await rc.set(cacheKey, JSON.stringify(fastDeduped), 10800);
      }
    } catch {}
  }).catch(() => {});

  return fastDeduped;
}

async function getCinemetaTitle(type, imdbId) {
  try {
    const res    = await axios.get(
      `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`,
      { timeout: 5000 }
    );
    const meta    = res.data?.meta;
    const genres  = (meta?.genres   || []).map(g => g.toLowerCase());
    const country = (meta?.country  || "").toLowerCase();
    const lang    = (meta?.language || "").toLowerCase();
    const isAnime =
      genres.includes("anime") ||
      (genres.includes("animation") && (country.includes("japan") || country.includes("jp"))) ||
      (genres.includes("animation") && (lang.includes("japanese") || lang.includes("japan") || lang === "ja"));
    return {
      title  : meta?.name || imdbId,
      aliases: uniq([meta?.name, meta?.originalName, ...(meta?.aliases || [])]).map(normTitle),
      imdbId : meta?.imdb_id || meta?.id || imdbId,
      year   : extractReleaseYear(meta?.year || meta?.releaseInfo || meta?.released || ""),
      isAnime,
    };
  } catch {
    return { title: imdbId, aliases: [normTitle(imdbId)], imdbId, year: null, isAnime: false };
  }
}

async function getKitsuMeta(kitsuId) {
  try {
    const res   = await axios.get(
      `https://kitsu.io/api/edge/anime/${kitsuId}`,
      { timeout: 5000, headers: { Accept: "application/vnd.api+json" } }
    );
    const attrs   = res.data?.data?.attributes || {};
    const aliases = uniq([
      attrs.titles?.ja_jp,
      attrs.titles?.en_jp,
      attrs.canonicalTitle,
      attrs.titles?.en,
      attrs.slug?.replace(/-/g, " "),
    ]).map(normTitle);
    return { title: aliases[0] || String(kitsuId), aliases };
  } catch {
    return { title: String(kitsuId), aliases: [String(kitsuId)] };
  }
}

// Dependência de parseStreamId em parseRssItemId -> Vamos precisar das funçōes de rssHelpers aqui também ou importar?
// Exportadas de rssHelpers.js: parseRssItemId. 
// Vamos definir aqui para não haver cycle, ou colocar no module próprio.
const { parseRssItemId } = require("./rssHelpers");

function parseStreamId(type, id) {
  if (!id || typeof id !== "string") return { source: "imdb", isAnime: false, metaId: "unknown", season: null, episode: null, type };
  const rssItem = parseRssItemId(id);
  if (rssItem) {
    return {
      source: "rssitem",
      isAnime: rssItem.catalogType === "anime",
      metaId: rssItem.metaId,
      season: rssItem.season,
      episode: rssItem.episode,
      rssToken: rssItem.token,
      rssType: rssItem.catalogType,
      type,
    };
  }
  if (id.startsWith("rssmovie:")) {
    return { source: "rssmovie", isAnime: false, metaId: id.slice("rssmovie:".length), season: null, episode: null, type };
  }
  if (id.startsWith("rssmeta:") || id.startsWith("prowjack:")) {
    const parts = id.split(":");
    const metaId = parts.slice(2).join(":");
    return { source: "rssmovie", isAnime: false, metaId, season: null, episode: null, type };
  }
  if (id.startsWith("kitsu:")) {
    const parts   = id.split(":");
    const season  = parts[2] ? parseInt(parts[2], 10) : null;
    const episode = parts[3] ? parseInt(parts[3], 10) : null;
    return {
      source : "kitsu",
      isAnime: true,
      kitsuId: parts[1] || "unknown",
      season : Number.isFinite(season)  ? season  : null,
      episode: Number.isFinite(episode) ? episode : null,
      type,
    };
  }
  if (type === "series" && id.includes(":")) {
    const [metaId, s, e] = id.split(":");
    const season  = parseInt(s, 10);
    const episode = parseInt(e, 10);
    return {
      source:  "imdb",
      isAnime: false,
      metaId:  metaId || "unknown",
      season:  Number.isFinite(season)  ? season  : null,
      episode: Number.isFinite(episode) ? episode : null,
      type,
    };
  }
  return { source: "imdb", isAnime: false, metaId: id, season: null, episode: null, type };
}

async function buildQueries(type, id) {
  const parsed = parseStreamId(type, id);
  if (parsed.isAnime) {
    const meta = await getKitsuMeta(parsed.kitsuId);
    const ep   = parsed.episode;
    const queries = ep != null
      ? uniq(meta.aliases.flatMap(t => [
          `${t} - ${String(ep).padStart(2, "0")}`,
          `${t} ${ep}`,
        ]))
      : uniq(meta.aliases);
    return {
      parsed, displayTitle: meta.title, aliases: meta.aliases, queries, episode: ep, search: null, year: null,
    };
  }
  const meta = await getCinemetaTitle(type, parsed.metaId);
  if (meta.isAnime) {
    parsed.isAnime = true;
    console.log(`[Cinemeta] Anime detectado: "${meta.title}" — usando indexers e filtros de anime`);
  }
  let queries;
  let episode = null;
  if (parsed.isAnime && parsed.season != null && parsed.episode != null) {
    episode = parsed.episode;
    queries = uniq(meta.aliases.flatMap(t => [
      `${t} - ${String(episode).padStart(2, "0")}`,
      `${t} ${episode}`,
      `${t} S${String(parsed.season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`,
    ]));
  } else if (type === "series" && parsed.season != null && parsed.episode != null) {
    const sStr = String(parsed.season).padStart(2, "0");
    const eStr = String(parsed.episode).padStart(2, "0");
    queries = uniq([
      `${meta.title} S${sStr}E${eStr}`,
      ...meta.aliases.slice(0, 2).map(a => `${a} S${sStr}E${eStr}`),
      `${meta.title} S${sStr}`,
      meta.title,
    ]);
  } else {
    queries = [meta.title];
  }
  return {
    parsed, displayTitle: meta.title, aliases: meta.aliases, queries: uniq(queries.map(normTitle)),
    episode, year: meta.year, search: parsed.isAnime ? null : {
      mode   : type === "movie" ? "movie" : "tvsearch",
      imdbId : meta.imdbId, title: meta.title, year: meta.year, season: parsed.season, episode: parsed.episode,
    },
  };
}

const ANIME_ONLY_IDS = new Set([
  "nyaasi", "animetosho", "animez", "nekobt",
  "animebytes", "anidex", "tokyotosho", "animeworld",
]);
function isAnimeOnly(id) {
  if (!id) return false;
  const norm = id.toLowerCase().replace(/[-_\s]/g, "");
  for (const known of ANIME_ONLY_IDS) {
    if (norm === known || norm.startsWith(known)) return true;
  }
  return false;
}
let _ixCache   = null;
let _ixCacheAt = 0;
async function getCachedIndexers(jUrl, jKey) {
  const cacheKey = `${jUrl}:${jKey}`;
  if (_ixCache && _ixCache.key === cacheKey && Date.now() - _ixCacheAt < 300_000) return _ixCache.data;
  try {
    const data = await jackettFetchIndexers(jUrl, jKey);
    _ixCache   = { key: cacheKey, data };
    _ixCacheAt = Date.now();
    return data;
  } catch {
    return _ixCache?.data || [];
  }
}
async function resolveSearchIndexers(prefs, isAnime) {
  const jUrl     = (prefs?.jackett?.url || ENV.jackettUrl).replace(/\/+$/, "");
  const jKey     = prefs?.jackett?.key || ENV.apiKey;

  const rawSelected = Array.isArray(prefs.indexers) ? prefs.indexers : String(prefs.indexers || "").split(",");
  let selected = rawSelected.map(s => String(s || "").trim()).filter(Boolean);
  
  if (selected.length > 1 && selected.includes("all")) {
    selected = selected.filter(s => s !== "all");
  }
  const useAll = !selected.length || selected.includes("all");

  const allNumeric = selected.every(s => /^\d+$/.test(s));
  if (!useAll && allNumeric) {
    return selected;
  }

  const allList  = await getCachedIndexers(jUrl, jKey);
  const pool     = useAll ? allList.map(ix => ix.id) : selected;
  if (isAnime) {
    const animePool = pool.filter(id => isAnimeOnly(id));
    if (animePool.length > 0) return animePool;
    return pool;
  }
  const generalPool = pool.filter(id => !isAnimeOnly(id));
  return generalPool.length > 0 ? generalPool : pool;
}

module.exports = { parseStreamId,
  jackettFetchIndexers,
  fetchIndexerPrivacyMap,
  jackettSearch,
  buildQueries,
  resolveSearchIndexers
};
