const express = require("express");
const router = express.Router();
const path = require("path");
const crypto = require("crypto");
const { isConfigured: isQbitConfigured, ensureTorrentReady, getPlayableLocalFile, streamTorrentFile } = require("../providers/qbittorrent");
const { ENV, CACHE_VERSION, STREAM_CACHE_VERSION, TORRENT_DOWNLOAD_TIMEOUT_MS, PUBLIC_TRACKERS, BAD_RE, BAD_EXT_RE, QB_EXTRA_SLOTS, MIN_STREAM_SEEDS, STREMTHRU_PROXY_TIMEOUT_MS } = require("../constants");
const { rc, redis, saveQbitJob, loadQbitJob } = require("../cache");
const { decodeUserCfg, resolvePrefs } = require("../configStore");
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
const { decodeXmlEntities } = require("../jackettSearch"); // Fallback for some strings

const streamWaiters = new Map();
const {
  base32ToHex, extractInfoHash, extractInfoBuf, decodeBencode, extractTorrentFiles,
  pickEpisodeFile, normalizeTorrentLink, torrentFailureKeys, torrentDownloadRecentlyFailed,
  markTorrentDownloadFailed, infoHashQueueKey, InfoHashQueue, infoHashQueue, resolveInfoHash
} = require("../torrentUtils");
const {
  jackettFetchIndexers, fetchIndexerPrivacyMap, jackettSearch, buildQueries, resolveSearchIndexers, parseStreamId
} = require("../jackettSearch");
const {
  getPreferredRssIndexers, loadRssItemsForType, rssCatalogMetaId, getRssItemToken,
  parseRssMetaId, parseRssItemId, extractSeriesFeedMarker, extractAnimeFeedMarker,
  buildRssVideos, findRssItemByToken, matchRssItemsByMarker
} = require("../rssHelpers");
const { fetchStremThruStoreLinks, buildMagnet, resolveDebridStream } = require("../debrid");
const { fetchTmdbMeta, getImdbIdFromTmdb } = require("../metadata");
const { enrichWithTorrentData, enrichJackettResults, EXTRA_TRACKERS, extractTrackers, injectTrackers } = require("../torrentEnrich");


router.get("/internal/:userConfig/stream/:type/:id.json", async (req, res) => {
  try {
    const { userConfig, type, id } = req.params;
    // Carrega prefs mas força modo P2P puro (sem debrid/StremThru) para ser upstream
    const rawPrefs = await resolvePrefs(userConfig);
    const prefs = { ...rawPrefs, debrid: false, stConfig: null, enableP2P: true };
    delete prefs.debridConfig;
    delete prefs.stConfig;

    const parsed = await parseStreamId(type, id);
    if (!parsed) return res.json({ streams: [] });

    const plan = await buildQueries(type, id);
    const indexers = await resolveSearchIndexers(prefs, parsed.isAnime);
    const results  = await jackettSearch({ parsed, queries: plan.queries, search: plan.search }, indexers, prefs);
    const reqCtx = { hasTimedOut: false };
    if (results._incomplete) reqCtx.hasTimedOut = true;

    const priorityLang = prefs.priorityLang ?? "pt-br";
    const candidates = results
      .filter(r => r?.InfoHash || r?.MagnetUri || r?.Link)
      .filter(r => {
        const isPrio = isPriorityIndexerResult(r, prefs);
        if (isPrio) r._priorityIndexer = true;
        return isPrio || !prefs.skipBadReleases || !BAD_RE.test(r.Title || "");
      })
      .filter(r => r._priorityIndexer || type !== "movie" || !looksLikeEpisodeRelease(r.Title || ""))
      .filter(r => {
        if (r._priorityIndexer) return true;
        if (prefs.keywordBoost && matchesKeywordBoost(r.Title || "", prefs.keywordBoost)) return true;
        if (!prefs.onlyDubbed || !priorityLang) return true;
        const langs = getLangs(r.Title || "", parsed.isAnime);
        return langs.some(l => l.code === priorityLang);
      })
      .sort((a, b) =>
        (((b._priorityIndexer ? 1 : 0) * 5000000) + score(b, prefs.weights, parsed.isAnime, priorityLang)) -
        (((a._priorityIndexer ? 1 : 0) * 5000000) + score(a, prefs.weights, parsed.isAnime, priorityLang))
      )
      .slice(0, prefs.maxResults || 20);

    // Resolve infohashes (ou preserva link .torrent para o StremThru caso falhe)
    const withHashes = (await (async () => {
      const results2 = new Array(candidates.length).fill(null);
      const CONC = 8;
      let idx = 0;
      async function worker() {
        while (idx < candidates.length) {
          const i = idx++;
          const cand = candidates[i];
          const resolved = await resolveInfoHash(cand, { ...reqCtx, fastOnly: true });
          if (resolved?.infoHash) {
            results2[i] = { ...cand, _resolved: resolved };
          } else if (cand.MagnetUri || cand.Link) {
            // Se falhou em resolver (ex: fastOnly) mas tem link, mantém para o StremThru
            results2[i] = { ...cand, _resolved: { infoHash: null, url: cand.MagnetUri || cand.Link } };
          }
        }
      }
      await Promise.all(Array.from({ length: CONC }, worker));
      return results2;
    })()).filter(Boolean);

    const maxOut = prefs.maxResults || 20;
    const streams = withHashes.slice(0, maxOut).map(r => {
      const resolved = r._resolved;
      const indexerName = r._indexerName || r.Tracker || r.TrackerId || r.Indexer || "Unknown";
      const { name, description, resLabel } = formatStream(r, indexerName, parsed.isAnime, prefs, true, {});
      // Envia addonName na linha 2: StremThru prepend "⚡ [TB] " na linha 1
      // Resultado final: "⚡ [TB] \nProwJack\n🔵 FHD" → Stremio exibe ⚡[TB] / ProwJack / FHD
      const addonName = prefs.addonName || "ProwJack";
        
        const fallbackTitle = (r.Title && !r.Title.includes('\\n')) ? r.Title : "";
        const displayFileName = r._scrapStream?._filename || fallbackTitle;
        const filenameLine = displayFileName ? `📄 ${displayFileName}` : "";
        const isPrivateTracker = isPrivateTrackerCandidate(r, resolved);

        const streamObj = {
          name: `\n${addonName}\n${resLabel || "Links"}`,
          description: [description, filenameLine, isPrivateTracker ? "🔒 Tracker Privado" : ""].filter(Boolean).join("\n"),
          behaviorHints: { notWebReady: false },
        };

      const stStores = prefs.stConfig?.stores || [];

if (resolved.infoHash) {


        let trackerList = [];


        if (resolved.buffer) trackerList = extractTrackers(resolved.buffer);


        else if (r.MagnetUri) {


          for (const m of (r.MagnetUri.matchAll(/[&?]tr=([^&]+)/g) || [])) {


            try { trackerList.push(decodeURIComponent(m[1])); } catch {}


          }


        }


        const sources = (trackerList.length ? trackerList : EXTRA_TRACKERS)


          .map(t => `tracker:${t}`).concat(`dht:${resolved.infoHash}`);


        


        streamObj.infoHash = resolved.infoHash;


        streamObj.sources = sources;


        streamObj.behaviorHints.bingeGroup = `prowjack|${resolved.infoHash}`;


      } else {
        return null;
      }
      return streamObj;
    }).filter(Boolean);

    console.log(`[Internal] ${type}/${id}: ${streams.length} streams P2P para StremThru`);
    if (reqCtx.hasTimedOut) {
      res.set("Cache-Control", "public, max-age=5, s-maxage=5");
    } else {
      res.set("Cache-Control", "public, max-age=60, s-maxage=300");
    }
    res.json({ streams });

    // Resolve no background para caches futuros sem saturar o Prowlarr/tracker.
    const queued = infoHashQueue.enqueueMany(candidates, maxOut * 2);
    if (queued) console.log(`[InfoHashQueue] ${queued} itens enfileirados pela rota interna`);
  } catch (err) {
    console.error(`[Internal] Erro: ${err.message}`);
    res.json({ streams: [] });
  }
});

router.get("/:userConfig/stream/:type/:id.json", async (req, res) => {
  const prefs = await resolvePrefs(req.params.userConfig);
  const isStremThruMode = !!prefs.stConfig;
  const qbitCreds = null;
  const qbitEnabledForPrefs = isQbitEnabledForPrefs(prefs, qbitCreds);
  const { type, id } = req.params;
  console.log(`\n=========================================`);
  console.log(`NOVA BUSCA: [${type}] ${id}`);

  const isDebridMode = prefs.debrid && prefs.debridConfig &&
    (prefs.debridConfig.torboxKey || prefs.debridConfig.rdKey);

  if (isDebridMode) {
    console.log(`[DEBRID] Modo ativo: ${prefs.debridConfig.mode.toUpperCase()} — P2P desabilitado`);
  }

  // Cache de streams resolvidos — retorno instantâneo se já processado antes
  const streamCacheKey = `streams:${STREAM_CACHE_VERSION}:${req.params.userConfig}:${type}:${id}`;
  const cachedStreams = await rc.get(streamCacheKey).catch(() => null);
  if (cachedStreams) {
    try {
      const parsed = JSON.parse(cachedStreams);
      if (Array.isArray(parsed) && parsed.length > 0) {
        console.log(`[Stream Cache HIT] ${parsed.length} streams para ${id}`);
        console.log(`=========================================\n`);
        return res.json({ streams: parsed });
      }
    } catch {}
  }
  // Lock atômico: se já existe uma Promise em andamento para este cache key,
  // aguarda ela resolver em vez de disparar nova busca (elimina a race condition).
  if (streamWaiters.has(streamCacheKey)) {
    console.log(`[Stream In-flight] aguardando resultado existente para ${id}`);
    try {
      const inflightStreams = await Promise.race([
        streamWaiters.get(streamCacheKey),
        new Promise(resolve => setTimeout(() => resolve([]), 120000)),
      ]);
      if (Array.isArray(inflightStreams) && inflightStreams.length > 0) {
        console.log(`[Stream In-flight HIT] ${inflightStreams.length} streams para ${id}`);
        console.log(`=========================================\n`);
        return res.json({ streams: inflightStreams });
      }
    } catch {}
    console.log(`[Stream In-flight] timeout; retornando vazio temporario para ${id}`);
    console.log(`=========================================\n`);
    return res.json({ streams: [] });
  }

  // Cria a Promise de lock ANTES de qualquer await — garante atomicidade
  let _resolveLock;
  const lockPromise = new Promise(resolve => { _resolveLock = resolve; });
  streamWaiters.set(streamCacheKey, lockPromise);
  // releaseLock: resolve a Promise com os streams finais e remove o lock
  const releaseLock = (streams = []) => {
    _resolveLock(streams);
    streamWaiters.delete(streamCacheKey);
  };
  const _t0 = Date.now();
  const reqCtx = { hasTimedOut: false };

  try {
    const { parsed, displayTitle, aliases = [], queries, episode, year, search } = await buildQueries(type, id);
    const requestedImdbId = normalizeImdbId(search?.imdbId || parsed?.metaId);

    // streamMeta: usado pelo formatStream em todo o fluxo (incluindo fallback StremThru)
    const streamMeta = {
      title: displayTitle,
      year,
      formattedSeasons: (type === "series" && parsed.season != null)
        ? `S${String(parsed.season).padStart(2, "0")}${parsed.episode != null ? `E${String(parsed.episode).padStart(2, "0")}` : ""}`
        : "",
    };

    const enabledCats = Array.isArray(prefs.categories) && prefs.categories.length ? prefs.categories : ["movie", "series"];
    if (parsed.isAnime && !enabledCats.includes("anime"))                       { releaseLock(); return res.json({ streams: [] }); }
    if (!parsed.isAnime && type === "series" && !enabledCats.includes("series")) { releaseLock(); return res.json({ streams: [] }); }
    if (type === "movie" && !enabledCats.includes("movie"))                      { releaseLock(); return res.json({ streams: [] }); }

    if (isStremThruMode) {
      const _stStart = Date.now();
      const maxOut = prefs.maxResults || 20;
      const proxyManifestUrl = buildStremThruProxyManifestUrl(req, prefs, req.params.userConfig);
      const addonName = prefs.addonName || "ProwJack";
      // Roda StremThru (resolve debrid) e Jackett em PARALELO — igual ao IndexaBR
      // StremThru chama /internal/:userConfig/stream que busca no Jackett e retorna P2P
      // O StremThru então resolve os hashes P2P via debrid e retorna links diretos
      const indexersForFallback = await resolveSearchIndexers(prefs, parsed.isAnime);
      const fastPath = await getRssFastPathResults(parsed, prefs, type);
      const fallbackPromise = fastPath ? Promise.resolve(fastPath) : jackettSearch({ parsed, queries, search }, indexersForFallback, prefs);
      const [proxyStreams, jackettResults] = await Promise.all([
        proxyManifestUrl
          ? fetchScrapStreams(proxyManifestUrl, type, id, { timeout: STREMTHRU_PROXY_TIMEOUT_MS, label: "STREMTHRU", preserveBadges: true, prefs })
          : Promise.resolve([]),
        fallbackPromise,
      ]);
      if (jackettResults._incomplete) reqCtx.hasTimedOut = true;
      console.log(`[PERF] stremthru=${Date.now() - _stStart}ms`);
      console.log(`[STREMTHRU] ${proxyStreams.length} streams do proxy | ${jackettResults.length} do Jackett`);

      // Constrói streams finais combinando os dois resultados
      const combined = [];

      // Streams do StremThru: somente streams COM url = debrid efetivamente resolvido.
      // Quando StremThru não tem o torrent em cache, passa os streams P2P brutos do
      // addon interno (infoHash/sources sem url). Esses NÃO são debrid — são descartados
      // aqui para que o fallback on-demand abaixo os trate corretamente.
      const stStreams = proxyStreams
        .filter(s => !!s.url)  // apenas url = debrid resolvido; infoHash/sources = P2P raw descartado
        .map(s => {
          let desc = s.description || s.title || "";
          const filename = s.behaviorHints?.filename;
          if (filename && !desc.includes(filename)) {
            desc += `\n📂 ${filename}`;
          }
          const cleanName = (s.name || "")
            .split("\n")
            .map(l => l.trim())
            .filter(Boolean)
            .join("\n");
          return {
            ...s,
            name: cleanName || s.name,
            description: desc.trim(),
            sources: undefined,
            title: undefined,
            _filename: undefined,
            _sourceType: "debrid",
            _stremThruProxy: true,
            _cached: true,
          };
        });
      combined.push(...stStreams);

      // 2) Fallback para complementar o StremThru proxy:
      // Se StremThru não retornou nada, processa todos (fallback completo).
      // Se StremThru retornou streams, o proxy funcionou, mas ignorou trackers privados sem magnet (pq o internal esconde eles).
      // Então filtramos para processar APENAS o que o proxy ignorou!
      const needsFullFallback = stStreams.length === 0;

      const _stPriorityLang = prefs.priorityLang ?? "pt-br";
      const _stCandidates = jackettResults
        .filter(r => r?.InfoHash || r?.MagnetUri || r?.Link)
        .filter(r => {
           if (!needsFullFallback) {
              const hasHash = !!(r.InfoHash || r.MagnetUri);
              if (hasHash) return false; // Se tem hash, o proxy do StremThru já analisou
           }
           return true;
        })
        .filter(r => {
            const isPrio = isPriorityIndexerResult(r, prefs);
            if (isPrio) r._priorityIndexer = true;
            return isPrio || !prefs.skipBadReleases || !BAD_RE.test(r.Title || "");
          })
          .filter(r => r._priorityIndexer || type !== "movie" || !looksLikeEpisodeRelease(r.Title || ""))
          .filter(r => {
            if (r._priorityIndexer) return true;
            if (prefs.keywordBoost && matchesKeywordBoost(r.Title || "", prefs.keywordBoost)) return true;
            if (!prefs.onlyDubbed || !_stPriorityLang) return true;
            const langs = getLangs(r.Title || "", parsed.isAnime);
            return langs.some(l => l.code === _stPriorityLang);
          })
          .sort((a, b) =>
            (((b._priorityIndexer ? 1 : 0) * 5000000) + score(b, prefs.weights, parsed.isAnime, _stPriorityLang)) -
            (((a._priorityIndexer ? 1 : 0) * 5000000) + score(a, prefs.weights, parsed.isAnime, _stPriorityLang))
          )
          .slice(0, maxOut * 3);

        const _stWithHashes = (await (async () => {
          const _res = new Array(_stCandidates.length).fill(null);
          const CONC = 8;
          let _idx = 0;
          async function _worker() {
            while (_idx < _stCandidates.length) {
              const i = _idx++;
              const resolved = await resolveInfoHash(_stCandidates[i], { ...reqCtx, fastOnly: true });
              // Aceita mesmo sem infoHash se houver Link (trackers privados)
              if (resolved?.infoHash || _stCandidates[i].Link) {
                _res[i] = { ..._stCandidates[i], _resolved: resolved || { infoHash: null, files: null, buffer: null } };
              }
            }
          }
          await Promise.all(Array.from({ length: CONC }, _worker));
          return _res;
        })()).filter(Boolean);

        let stPrivateCandidates = 0;
        let stQbitCandidates = 0;
        const qbitCreds = null;
        const p2pStreamsNested = await Promise.all(_stWithHashes.slice(0, maxOut).map(async r => {
          const resolved = r._resolved;
          const indexerName = r._indexerName || r.Tracker || r.TrackerId || r.Indexer || "Unknown";
          const { name, description, resLabel } = formatStream(r, indexerName, parsed.isAnime, prefs, true, streamMeta);
          let trackerList = [];
          if (resolved.buffer) trackerList = extractTrackers(resolved.buffer);
          else if (r.MagnetUri) {
            for (const m of (r.MagnetUri.matchAll(/[&?]tr=([^&]+)/g) || [])) {
              try { trackerList.push(decodeURIComponent(m[1])); } catch {}
            }
          }
          const sources = (trackerList.length ? trackerList : EXTRA_TRACKERS)
            .map(t => `tracker:${t}`).concat(`dht:${resolved.infoHash}`);
            
          const isPrivateTracker = isPrivateTrackerCandidate(r, resolved);
          if (isPrivateTracker) stPrivateCandidates++;
          const fallbackTitle = (r.Title && !r.Title.includes('\n')) ? r.Title : "";
          const displayFileName = r._scrapStream?._filename || fallbackTitle;
          const filenameLine = displayFileName ? `📂 ${displayFileName}` : "";
            
          const p2pName = name;
          // No modo StremThru, envolve como on-demand debrid em vez de P2P puro
          const stStores = prefs.stConfig?.stores || [];
          const hasDebrid = stStores.length > 0;
          const storeCodeMap2 = { torbox: "torbox", realdebrid: "realdebrid" };
          const publicBase = getPublicBase(req);
          const seasonParam  = parsed.season  != null ? `&season=${parsed.season}`   : "";
          const episodeParam = (parsed.episode ?? episode) != null ? `&episode=${parsed.episode ?? episode}` : "";
          const animeParam   = parsed.isAnime ? "&anime=1" : "";

          // Hash efetivo: infoHash resolvido ou extraído do magnet
          const magnetHash = !resolved?.infoHash && r.MagnetUri
            ? (r.MagnetUri.match(/btih:([a-fA-F0-9]{40})/i)?.[1] || null)?.toLowerCase()
            : null;
          const effectiveHash = resolved?.infoHash || magnetHash;
          const effectiveMagnet = buildMagnet(effectiveHash, r.MagnetUri, r.Title);
          const debridLink = r.Link && !r.Link.startsWith("magnet:") ? r.Link : null;

          // Regra central: debrid ativo → NUNCA exibir P2P.
          // on-demand debrid: usa infoHash, hash do magnet, ou link .torrent (nessa ordem).
          const onDemandStreams = hasDebrid
            ? (() => {
                let debridHash = effectiveHash;
                let extraLink  = debridLink;
                let bingeKey;

                if (debridHash) {
                  bingeKey = `prowjack|st-ondemand|${debridHash}`;
                } else if (extraLink) {
                  debridHash = crypto.createHash("sha1").update(extraLink).digest("hex");
                  bingeKey = `prowjack|st-ondemand-link|${debridHash}`;
                } else {
                  return null; // sem hash nem link utilizável → descarta
                }

                const linkQs = extraLink ? `&link=${encodeURIComponent(extraLink)}` : "";
                return stStores.map(store => {
                  const provider = storeCodeMap2[store.c] || store.c;
                  const tag = store.c === "torbox" ? "[TB]" : store.c === "realdebrid" ? "[RD]" : `[${store.c.toUpperCase()}]`;
                  return {
                    name: `${prefs.addonName || "ProwJack"}\n⬇️ ${resLabel || "Links"} ${tag}`,
                    description: [description, filenameLine, isPrivateTracker ? "🔒 Tracker Privado" : ""].filter(Boolean).join("\n"),
                    url: `${publicBase}/${req.params.userConfig}/debrid-add/stremthru-${provider}/${debridHash}?magnet=${encodeURIComponent(effectiveMagnet)}${linkQs}${seasonParam}${episodeParam}${animeParam}`,
                    _sourceType: "debrid",
                    _priorityIndexer: !!r._priorityIndexer,
                    behaviorHints: { filename: displayFileName, notWebReady: true, bingeGroup: bingeKey },
                  };
                });
              })()
            : null; // sem debrid → P2P abaixo

          // P2P: APENAS quando não há debrid configurado (hasDebrid=false).
          // Com debrid ativo (nativo ou StremThru), nunca exibir P2P.
          const p2pStream = hasDebrid ? null : (effectiveHash ? {
            name: p2pName,
            description: [description, filenameLine, isPrivateTracker ? "🔒 Tracker Privado" : ""].filter(Boolean).join("\n"),
            infoHash: effectiveHash,
            sources,
            _sourceType: "p2p", _priorityIndexer: !!r._priorityIndexer,
            behaviorHints: { filename: displayFileName, notWebReady: false, bingeGroup: `prowjack|${effectiveHash}` },
          } : null);

          const streams = onDemandStreams || [p2pStream].filter(Boolean);

          const qbitEnabledForPrefs = shouldOfferQbitForResult(prefs, isPrivateTracker, qbitCreds) && resolved?.infoHash;
          if (qbitEnabledForPrefs) stQbitCandidates++;
          if (qbitEnabledForPrefs) {
            let torrentB64 = null;
            if (resolved.buffer) {
              try { torrentB64 = injectTrackers(resolved.buffer).toString("base64"); }
              catch { torrentB64 = resolved.buffer.toString("base64"); }
            }
            const jobToken = await saveQbitJob({
              infoHash: resolved.infoHash,
              link:     (r.Link && !r.Link.startsWith("magnet:")) ? r.Link : null,
              magnet:   buildMagnet(resolved.infoHash, r.MagnetUri, r.Title),
              fileIdx:  null, fileName: null, torrentB64,
            });
            
            const qbitName = `${prefs.addonName || "ProwJack"}\n⬇️ ${resLabel || "Links"} [QB]`;
            const qbitStream = {
              name: qbitName,
              description: [description, filenameLine, isPrivateTracker ? "🔒 Tracker Privado" : ""].filter(Boolean).join("\n"),
              url:   `${publicBase}/${req.params.userConfig}/qbit/${jobToken}`,
              indexer: renameIndexer(indexerName),
              _sourceType: "http", _priorityIndexer: !!r._priorityIndexer,
              behaviorHints: { filename: displayFileName, bingeGroup: `prowjack|qbit|${resolved.infoHash}`, notWebReady: false },
            };
            streams.push(qbitStream);
          }
          return streams;
        }));
        
        const p2pStreams = p2pStreamsNested.flat().filter(Boolean);
        console.log(`[QB] StremThru candidatos com hash=${_stWithHashes.length} privados=${stPrivateCandidates} elegiveis=${stQbitCandidates} qbit=${isQbitEnabledForPrefs(prefs, qbitCreds) ? "on" : "off"} modo=${prefs.qbitMode}`);
        combined.push(...p2pStreams);

      // 3) QB como complemento QUANDO o StremThru JÁ retornou debrid
      // O bloco P2P acima agora roda sempre, mas filtra apenas o que o proxy ignorou.
      // Porém, ele gerou streams [QB] para os trackers privados.

      // ser gerados para que o usuário possa baixar via qBittorrent mesmo com debrid ativo.
      if (stStreams.length > 0 && isQbitEnabledForPrefs(prefs, qbitCreds)) {
        const stQbExtraSlotsNow = prefs.qbExtraSlots ?? QB_EXTRA_SLOTS;
        if (stQbExtraSlotsNow > 0) {
          const _stQbPriorityLang = prefs.priorityLang ?? "pt-br";
          const _stQbCandidates = jackettResults
            .filter(r => r?.InfoHash || r?.MagnetUri || r?.Link)
            .filter(r => {
              if (prefs.qbitMode === "private") return !r.MagnetUri && r.Link;
              return true;
            })
            .filter(r => {
              const isPrio = isPriorityIndexerResult(r, prefs);
              if (isPrio) r._priorityIndexer = true;
              return isPrio || !prefs.skipBadReleases || !BAD_RE.test(r.Title || "");
            })
            .filter(r => r._priorityIndexer || type !== "movie" || !looksLikeEpisodeRelease(r.Title || ""))
            .filter(r => {
              if (r._priorityIndexer) return true;
              if (prefs.keywordBoost && matchesKeywordBoost(r.Title || "", prefs.keywordBoost)) return true;
              if (!prefs.onlyDubbed || !_stQbPriorityLang) return true;
              const langs = getLangs(r.Title || "", parsed.isAnime);
              return langs.some(l => l.code === _stQbPriorityLang);
            })
            .sort((a, b) =>
              (((b._priorityIndexer ? 1 : 0) * 5000000) + score(b, prefs.weights, parsed.isAnime, _stQbPriorityLang)) -
              (((a._priorityIndexer ? 1 : 0) * 5000000) + score(a, prefs.weights, parsed.isAnime, _stQbPriorityLang))
            )
            .slice(0, stQbExtraSlotsNow * 3);

          // Resolve apenas os infoHashes (fast-only) para os candidatos QB
          const _stQbResolved = new Array(_stQbCandidates.length).fill(null);
          const QB_CONC = 4;
          let _qbIdx = 0;
          async function _qbWorker() {
            while (_qbIdx < _stQbCandidates.length) {
              const i = _qbIdx++;
              const resolved = await resolveInfoHash(_stQbCandidates[i], { ...reqCtx, fastOnly: true });
              if (resolved?.infoHash) {
                _stQbResolved[i] = { ..._stQbCandidates[i], _resolved: resolved };
              }
            }
          }
          await Promise.all(Array.from({ length: QB_CONC }, _qbWorker));
          const _stQbWithHashes = _stQbResolved.filter(Boolean);

          let stQbAddedCount = 0;
          const publicBase = getPublicBase(req);
          for (const r of _stQbWithHashes) {
            if (stQbAddedCount >= stQbExtraSlotsNow) break;
            const resolved = r._resolved;
            const isPrivateTracker = isPrivateTrackerCandidate(r, resolved);
            // Respeita qbitMode: "private" → só trackers privados; "always" → todos
            if (!shouldOfferQbitForResult(prefs, isPrivateTracker, qbitCreds)) continue;
            const indexerName = r._indexerName || r.Tracker || r.TrackerId || r.Indexer || "Unknown";
            const { description, resLabel } = formatStream(r, indexerName, parsed.isAnime, prefs, true, streamMeta);
            const fallbackTitle = (r.Title && !r.Title.includes('\n')) ? r.Title : "";
            const displayFileName = r._scrapStream?._filename || fallbackTitle;
            const filenameLine = displayFileName ? `📂 ${displayFileName}` : "";

            let torrentB64 = null;
            if (resolved.buffer) {
              try { torrentB64 = injectTrackers(resolved.buffer).toString("base64"); }
              catch { torrentB64 = resolved.buffer.toString("base64"); }
            }
            const jobToken = await saveQbitJob({
              infoHash: resolved.infoHash,
              link:     (r.Link && !r.Link.startsWith("magnet:")) ? r.Link : null,
              magnet:   buildMagnet(resolved.infoHash, r.MagnetUri, r.Title),
              fileIdx:  null, fileName: null, torrentB64,
            });

            combined.push({
              name: `${prefs.addonName || "ProwJack"}\n⬇️ ${resLabel || "Links"} [QB]`,
              description: [description, filenameLine, isPrivateTracker ? "🔒 Tracker Privado" : ""].filter(Boolean).join("\n"),
              url: `${publicBase}/${req.params.userConfig}/qbit/${jobToken}`,
              indexer: renameIndexer(indexerName),
              _sourceType: "http",
              _priorityIndexer: !!r._priorityIndexer,
              behaviorHints: { filename: displayFileName, bingeGroup: `prowjack|qbit|${resolved.infoHash}`, notWebReady: false },
            });
            stQbAddedCount++;
          }
          console.log(`[QB] StremThru+debrid: ${stQbAddedCount}/${_stQbWithHashes.length} streams [QB] adicionados (modo=${prefs.qbitMode} slots=${stQbExtraSlotsNow})`);
        }
      }

      // Ordena: debrid primeiro, depois P2P
      combined.sort((a, b) => {
        const da = a._cached ? 0 : (a._sourceType === "debrid" ? 1 : 2);
        const db = b._cached ? 0 : (b._sourceType === "debrid" ? 1 : 2);
        if (da !== db) return da - db;
        if (a._priorityIndexer && !b._priorityIndexer) return -1;
        if (!a._priorityIndexer && b._priorityIndexer) return 1;
        return 0;
      });

      const isQbStream = s => s?._sourceType === "http" && typeof s.url === "string" && s.url.includes("/qbit/");
      let normalPool = combined.filter(s => !isQbStream(s));
      const limitedNormal = normalPool.slice(0, maxOut);
      
      const stQbExtraSlots = prefs.qbExtraSlots ?? QB_EXTRA_SLOTS;
      const normalKeys = new Set(limitedNormal.map(s => s.infoHash || s.behaviorHints?.bingeGroup || s.url).filter(Boolean));
      const qbExtra = combined
        .filter(isQbStream)
        .filter(s => {
          const key = s.infoHash || s.behaviorHints?.bingeGroup || s.url;
          return !key || !normalKeys.has(key);
        })
        .slice(0, stQbExtraSlots);
      if (qbExtra.length) console.log(`[QB] ${qbExtra.length} streams [QB] adicionados no modo StremThru (QB_EXTRA_SLOTS=${stQbExtraSlots})`);

      const finalStreamsCombined = [...limitedNormal, ...qbExtra];
      const qbitCount = finalStreamsCombined.filter(isQbStream).length;

      // Remove campos internos antes de enviar ao Stremio
      const finalStreams = finalStreamsCombined.map(s => {
        delete s._cached; delete s._sourceType; delete s._scrapSource;
        delete s._stremThruProxy; delete s._title; delete s._seeders;
        delete s._sizeGb; delete s._sizeBytes; delete s._priorityIndexer;
        return s;
      });

      if (finalStreams.length > 0) {
        const ttl = reqCtx.hasTimedOut ? 5 : 10800;
        await rc.set(streamCacheKey, JSON.stringify(finalStreams), ttl).catch(() => {});
      }
      const finalShape = finalStreams.slice(0, 5).map(s => ({
        name: String(s.name || "").replace(/\n/g, " | ").slice(0, 80),
        url: !!s.url,
        externalUrl: !!s.externalUrl,
        infoHash: !!s.infoHash,
      }));
      console.log(`[STREMTHRU] Enviando ${finalStreams.length} streams totais`);
        console.log(`=========================================
`);
      releaseLock(finalStreams);

      // Inicia resolução em background para popular o cache para a próxima busca
      // sem abrir dezenas de downloads .torrent simultâneos no Prowlarr/tracker.
      const queued = infoHashQueue.enqueueMany(jackettResults, 40);
      if (queued) console.log(`[InfoHashQueue] ${queued} itens enfileirados pelo fallback StremThru`);

      return res.json({ streams: finalStreams });
    }


    const indexers     = await resolveSearchIndexers(prefs, parsed.isAnime);

    // Fast-path: tenta encontrar resultados no cache RSS antes de buscar nos indexers
    let results = [];
    let rssMatchedResults = [];
    const rssType = parsed.rssType || (parsed.isAnime ? "anime" : type === "movie" ? "movie" : "series");
    let usedRssFastPath = false;
    const isOwnRssCatalogItem = parsed.source === "rssmovie" || parsed.source === "rssitem";
    const preferredRssIndexers = Array.isArray(prefs.rssIndexers) && prefs.rssIndexers.length
      ? prefs.rssIndexers
      : (Array.isArray(prefs.indexers) && prefs.indexers.length && !prefs.indexers.includes("all") ? prefs.indexers : null);
    const bypassRssFilters = parsed.source === "rssitem" || !!preferredRssIndexers?.length;

    if (parsed.source === "rssmovie") {
      // Filme do catálogo RSS — busca só no cache RSS, sem jackettSearch
      const rssHits = await loadRssItemsForType(prefs, "movie");
      const matched = rssHits.filter(r => normalizeImdbId(r.ImdbId) === normalizeImdbId(parsed.metaId));
      if (matched.length) {
        results = matched.map((item, idx) => ({ ...item, _metaIdMatch: true, _titleMatchScore: 1, _rssPreferred: true, _rssOrder: idx }));
        usedRssFastPath = true;
        console.log(`[RSS Fast-path] ${results.length} resultados do cache RSS para ${parsed.metaId}`);
      } else {
        releaseLock();
        return res.json({ streams: [] });
      }
    } else if (parsed.source === "rssitem" && parsed.rssToken) {
      const rssHits = await loadRssItemsForType(prefs, parsed.rssType || rssType);
      const exactItem = findRssItemByToken(rssHits, parsed.rssToken);
      if (exactItem) {
        results = [{ ...exactItem, _metaIdMatch: true, _titleMatchScore: 1, _rssPreferred: true, _rssOrder: 0 }];
        usedRssFastPath = true;
      } else {
        releaseLock();
        return res.json({ streams: [] });
      }
    } else if (parsed.source === "rssitem") {
      const rssHits = await loadRssItemsForType(prefs, parsed.rssType || rssType);
      const requestedEpisode = parsed.episode ?? 0;
      const exactItems = matchRssItemsByMarker(
        rssHits,
        parsed.rssType || rssType,
        parsed.metaId,
        parsed.season ?? 1,
        requestedEpisode
      );
      if (exactItems.length) {
        results = exactItems.map((item, idx) => ({ ...item, _metaIdMatch: true, _titleMatchScore: 1, _rssPreferred: true, _rssOrder: idx }));
        usedRssFastPath = true;
      } else {
        releaseLock();
        return res.json({ streams: [] });
      }
    } else if (requestedImdbId || aliases.length) {
      const allowedRss = preferredRssIndexers;
      const rssPattern = allowedRss
        ? null // busca por chaves específicas abaixo
        : `rss:${CACHE_VERSION}:*:${rssType}:*`;
      const rssKeys = allowedRss
        ? await Promise.all(allowedRss.map(ix => rc.keys(`rss:${CACHE_VERSION}:${ix}:${rssType}:*`))).then(a => a.flat())
        : await rc.keys(rssPattern);
      if (rssKeys.length > 0) {
        const rssHits = (await Promise.all(
          rssKeys.map(async key => {
            try { const raw = await rc.get(key); return raw ? JSON.parse(raw) : []; }
            catch { return []; }
          })
        )).flat();

        const matched = rssHits
          .map((r, idx) => {
            const resultImdbId = normalizeImdbId(r.ImdbId);
            const byImdb = !!(requestedImdbId && resultImdbId && resultImdbId === requestedImdbId);
            const titleScore = titleMatchScore(r.Title || "", [displayTitle, ...aliases]);
            const relaxedScore = relaxedTitleMatchScore(r.Title || "", [displayTitle, ...aliases]);
            const effectiveScore = Math.max(titleScore, (parsed.isAnime || type === "series") ? relaxedScore * 0.85 : 0);
            const minAliasScore = parsed.isAnime ? 0.45 : type === "series" ? 0.5 : 0.6;
            const byAlias = effectiveScore >= minAliasScore;
            if (!byImdb && !byAlias) return null;
            return {
              ...r,
              _metaIdMatch: byImdb,
              _titleMatchScore: effectiveScore,
              _rssPreferred: bypassRssFilters,
              _rssOrder: idx,
            };
          })
          .filter(Boolean);

        if (matched.length > 0) {
          console.log(`[RSS Fast-path] ${matched.length} resultados do cache RSS para ${requestedImdbId || displayTitle}`);
          rssMatchedResults = matched;
        }
      }
    }

    // Busca scrap sempre, integrando os resultados na pipeline do ProwJack
    const scrapResults = ENV.scrapManifests.length > 0
      ? await Promise.all(ENV.scrapManifests.map(async (m, idx) => {
          const streams = await fetchScrapStreams(m, type, id, { prefs });
          console.log(`[SCRAP ${idx}] ${m.slice(0, 60)}... → ${streams.length} streams`);
          let scrapName = "Scrap Externo";
          try {
            const host = new URL(m).hostname;
            const parts = host.split('.');
            let rawName = parts.length >= 2 ? (parts[0] === 'www' || parts[0] === 'api' ? parts[1] : parts[0]) : host;
            scrapName = rawName.charAt(0).toUpperCase() + rawName.slice(1);
          } catch {}
          return streams.map(s => ({ ...s, _scrapName: scrapName }));
        }))
      : [];

    if (!isOwnRssCatalogItem) {
      // Busca Jackett
      const _tSearch = Date.now();
      const jackettResults = await jackettSearch({ parsed, queries, search }, indexers, prefs);
      if (jackettResults._incomplete) reqCtx.hasTimedOut = true;
      console.log(`[PERF] search=${Date.now() - _tSearch}ms (${jackettResults.length} resultados)`);
      results = [...rssMatchedResults, ...jackettResults];
      if (rssMatchedResults.length) {
        console.log(`[RSS + Live] ${rssMatchedResults.length} resultados RSS combinados com ${jackettResults.length} resultados ao vivo`);
      }
    }
    
    // Converte streams do scrap para formato de candidatos Jackett-like
    const scrapStreams = scrapResults.flat();
    const usenetCount = scrapStreams.filter(s => s.externalUrl && !s.url).length;
    const torrentCount = scrapStreams.filter(s => s.url || s.infoHash).length;
    console.log(`[SCRAP] Recebidos ${scrapStreams.length} streams de ${ENV.scrapManifests.length} addon(s) externo(s) (${torrentCount} torrent, ${usenetCount} usenet)`);
    
    const scrapCandidates = scrapStreams.map(s => {
      const titleText = s._title || [s.title, s.name, s.description, s.behaviorHints?.filename].filter(Boolean).join("\n") || "Scrap Stream";
      const fname = s._filename || s.behaviorHints?.filename || "";
      const hash = s.infoHash || (s.url && s.url.match(/btih:([a-f0-9]{40})/i)?.[1]) || null;
      const streamUrl = s.url || s.externalUrl || null;
      
      return {
        Title: titleText,
        InfoHash: hash,
        MagnetUri: hash ? `magnet:?xt=urn:btih:${hash}` : null,
        Link: streamUrl || 'scrap-stream',
        Size: s._sizeBytes || s.behaviorHints?.videoSize || 0,
        Seeders: s._seeders || 0,
        _scrapStream: s,
        _scrapSource: true,
        _indexerName: s._scrapName || 'Scrap Externo',
        Tracker: s._scrapName || 'Scrap Externo',
        TrackerId: 'scrap',
        Indexer: s._scrapName || 'Scrap Externo'
      };
    });
    
    console.log(`[SCRAP] Convertidos ${scrapCandidates.length} candidatos (${scrapCandidates.filter(c => c.InfoHash).length} com hash, ${scrapCandidates.filter(c => c._scrapStream.url || c._scrapStream.externalUrl).length} com url/usenet)`);
    
    // Adiciona candidatos do scrap ao results
    results = [...results, ...scrapCandidates];
    const priorityLang = prefs.priorityLang ?? "pt-br";

    console.log(`Filtros ativos: onlyDubbed=${prefs.onlyDubbed}, priorityLang=${priorityLang}, keywordBoost=${prefs.keywordBoost ? 'SIM' : 'NÃO'}, priorityIndexers=[${(prefs.priorityIndexers||[]).join(",")}], maxPerIndexer=${prefs.maxResultsPerIndexer||0}`);

    const candidates = (bypassRssFilters && usedRssFastPath
      ? results
          .filter(r => r?.InfoHash || r?.MagnetUri || r?.Link)
          .filter(r => {
            if (parsed.source === "rssitem") return true;
            if (parsed.isAnime) return animeEpisodeMatches(r.Title || "", episode);
            if (type === "series") return seriesEpisodeMatches(r.Title || "", parsed.season, parsed.episode);
            return true;
          })
          .map(r => {
            r._originalScore = 1_000_000 - (r._rssOrder || 0);
            return r;
          })
      : results
          .filter(r => r?.InfoHash || r?.MagnetUri || r?.Link)
          .filter(r => {
            const isPrio = isPriorityIndexerResult(r, prefs);
            if (isPrio) r._priorityIndexer = true;
            return isPrio || !prefs.skipBadReleases || !BAD_RE.test(r.Title || "");
          })
          .filter(r => r._priorityIndexer || type !== "movie" || !looksLikeEpisodeRelease(r.Title || ""))
          .filter(r => {
            if (r._priorityIndexer) return true;
            if (parsed.isAnime) return animeEpisodeMatches(r.Title || "", episode);
            if (type === "series") {
              // Resultados de busca estruturada (tvsearch com season/ep) já foram filtrados
              // pelo indexador — não descartar por falta de marcador no título.
              // Mas ainda verifica se o título não é claramente de outra temporada/episódio.
              if (r._structuredMatch) {
                const rank = episodeMatchRank(r.Title || "", parsed.season, parsed.episode);
                // rank=0 significa que o título tem marcador de OUTRA temporada/episódio — descartar
                // rank>=2: season-only, complete pack da temporada certa, ou episódio exato — aceitar
                // rank=1: complete pack sem marcador de temporada — aceitar (pack genérico)
                return rank !== 0;
              }
              // Resultados com ImdbId correspondente: ainda verifica episódio para evitar
              // retornar S05E05 quando pediu S05E07
              const resultImdbId = getResultImdbId(r);
              if (requestedImdbId && resultImdbId && resultImdbId === requestedImdbId) {
                return seriesEpisodeMatches(r.Title || "", parsed.season, parsed.episode);
              }
              return seriesEpisodeMatches(r.Title || "", parsed.season, parsed.episode);
            }
            return true;
          })
          .filter(r => {
            if (r._priorityIndexer) {
              r._titleMatchScore = Math.max(r._titleMatchScore || 0, 1);
              return true;
            }
            if (prefs.keywordBoost && matchesKeywordBoost(r.Title || "", prefs.keywordBoost)) {
              r._titleMatchScore = 1; r._keywordMatch = true; return true;
            }
            if (!prefs.onlyDubbed || !priorityLang) return true;
            const langs   = getLangs(r.Title || "", parsed.isAnime);
            const hasLang = priorityLang ? langs.some(l => l.code === priorityLang) : false;
            return hasLang;
          })
          .filter(r => {
            if (r._priorityIndexer) return true;
            if (r._keywordMatch || r._metaIdMatch) return true;
            const resultImdbId = getResultImdbId(r);
            if (requestedImdbId && resultImdbId && resultImdbId === requestedImdbId) {
              // ImdbId bate: ainda verifica episódio para séries
              if (type === "series") {
                if (!seriesEpisodeMatches(r.Title || "", parsed.season, parsed.episode)) return false;
              }
              r._titleMatchScore = Math.max(r._titleMatchScore || 0, 1);
              r._metaIdMatch = true; return true;
            }
            const langs   = getLangs(r.Title || "", parsed.isAnime);
            const hasLang = priorityLang ? langs.some(l => l.code === priorityLang) : false;

            const sc           = titleMatchScore(r.Title || "", [displayTitle, ...aliases]);
            const relaxedScore = relaxedTitleMatchScore(r.Title || "", [displayTitle, ...aliases]);
            const episodeRank  = parsed.isAnime ? animeEpisodeMatchRank(r.Title || "", episode) : episodeMatchRank(r.Title || "", parsed.season, parsed.episode);
            const minScore     = parsed.isAnime ? 0.34 : (type === "series" && episodeRank >= 2 ? 0.2 : 0.45);
            const finalScore   = Math.max(sc, type === "series" ? relaxedScore * 0.8 : 0);
            if (hasLang && finalScore >= 0.1) r._titleMatchScore = Math.max(r._titleMatchScore || 0, 1);
            r._titleMatchScore = Math.max(r._titleMatchScore || 0, finalScore);
            return finalScore >= minScore || (hasLang && finalScore >= 0.1);
          })
          .filter(r => { if (r._priorityIndexer) return true; if (type !== "movie" || !year) return true; const ry = extractReleaseYear(r.Title || ""); return !ry || Math.abs(ry - year) <= 1; })
          .map(r => {
            const t       = r.Title || "";
            const langs   = getLangs(t, parsed.isAnime);
            const hasLang = priorityLang ? langs.some(l => l.code === priorityLang) : false;
            const isMulti = /(multi)[-.\\s]?(audio)?/i.test(t);
            const langPriority = hasLang ? 3 : (prefs.keywordBoost && matchesKeywordBoost(t, prefs.keywordBoost) ? 2 : (isMulti ? 1 : 0));
            r._originalScore = ((r._priorityIndexer ? 1 : 0) * 5000000) +
              (langPriority * 100000) +
              ((r._metaIdMatch    ? 1 : 0) * 40000) +
              ((r._structuredMatch ? 1 : 0) * 20000) +
              (parsed.isAnime ? animeEpisodeMatchRank(r.Title || "", episode) : episodeMatchRank(r.Title || "", parsed.season, parsed.episode)) * 10000 +
              (r._titleMatchScore || 0) * 1000 +
              score(r, prefs.weights, parsed.isAnime, priorityLang);
            return r;
          })
          .sort((a, b) => b._originalScore - a._originalScore));

    console.log(`Resultados: ${results.length} brutos → ${candidates.length} após filtros (idioma, título, ano)`);
    if (prefs.keywordBoost) {
      const withKeywords = candidates.filter(r => matchesKeywordBoost(r.Title || "", prefs.keywordBoost));
      console.log(`Keywords: ${withKeywords.length}/${candidates.length} releases com boost`);
    }

    // maxResultsPerIndexer é aplicado aqui apenas para limitar candidatos enviados ao cache check.
    // O limite real por indexer na lista final é aplicado após a ordenação dos streams (abaixo).
    const filteredCandidates = candidates;

    const maxOut              = prefs.maxResults || 20;

    const candidateHasKeyword = r => !!(prefs.keywordBoost && matchesKeywordBoost(r.Title || "", prefs.keywordBoost));
    const candidateHasPriorityLang = r => {
      const t = r.Title || "";
      const langs = getLangs(t, parsed.isAnime);
      return !!(
        (priorityLang && langs.some(l => l.code === priorityLang)) ||
        ((priorityLang === "pt-br" && /(dublado|dubbed.*pt|pt[-_. ]?br|\bpor\b|\bpt\b|portugu[eê]s|portuguese|brazilian)/i.test(t)))
      );
    };

    const cacheCheckCandidates = (() => {
      if (!isDebridMode || prefs.stConfig) {
        const priority = filteredCandidates.filter(r => r._priorityIndexer || candidateHasPriorityLang(r) || candidateHasKeyword(r) || r._scrapSource);
        const regular = filteredCandidates.filter(r => !r._priorityIndexer && !candidateHasPriorityLang(r) && !candidateHasKeyword(r) && !r._scrapSource).slice(0, Math.max(maxOut * 3, 80));
        return [...priority, ...regular];
      }
      const direct = filteredCandidates.filter(hasDirectInfoHash);
      const httpOnly = filteredCandidates.filter(r => !hasDirectInfoHash(r));
      const priorityDirect = direct.filter(r => r._priorityIndexer || candidateHasPriorityLang(r) || candidateHasKeyword(r) || r._scrapSource);
      const regularDirect = direct.filter(r => !r._priorityIndexer && !candidateHasPriorityLang(r) && !candidateHasKeyword(r) && !r._scrapSource);
      const priorityHttp = httpOnly.filter(r => r._priorityIndexer || r._keywordMatch || candidateHasPriorityLang(r) || candidateHasKeyword(r) || r._scrapSource).slice(0, 15);
      const regularHttp = httpOnly.filter(r => !r._priorityIndexer && !r._keywordMatch && !candidateHasPriorityLang(r) && !candidateHasKeyword(r) && !r._scrapSource).slice(0, Math.max(4, Math.ceil(maxOut / 3)));
      const directLimit = Math.max(maxOut * 3, 80);
      const selected = [...priorityDirect, ...regularDirect.slice(0, directLimit), ...priorityHttp, ...regularHttp];
      const seen = new Set();
      return selected.filter(r => {
        const key = r.InfoHash || r.MagnetUri || r.Link || r.Guid || r.Title;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    })();
    const topCandidates = cacheCheckCandidates;
    const directCount = topCandidates.filter(hasDirectInfoHash).length;
    console.log(`Extraindo InfoHashes de ${topCandidates.length} candidatos (${directCount} diretos, ${topCandidates.length - directCount} via .torrent)...`);

    const withHashes = (await (async () => {
      const results = new Array(topCandidates.length).fill(null);
      const CONCURRENCY = 10;
      let idx = 0;
      async function worker() {
        while (idx < topCandidates.length) {
          const i = idx++;
          const candidate = topCandidates[i];
          
          // Candidatos do scrap não precisam de resolveInfoHash — já têm URL de streaming
          if (candidate._scrapSource) {
            results[i] = { ...candidate, _resolved: { infoHash: candidate.InfoHash || null, files: [] } };
            continue;
          }
          
          const resolved = await resolveInfoHash(candidate, reqCtx);
          results[i] = resolved?.infoHash ? { ...candidate, _resolved: resolved } : null;
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      return results;
    })()).filter(Boolean);

    let rdCacheMap = {};
    let tbCacheMap = {};

    if (isDebridMode && !prefs.stConfig && withHashes.length > 0) {
      const _tDebrid = Date.now();
      const { mode, torboxKey, rdKey } = prefs.debridConfig;
      const { rdBatchCheckCache, torboxBatchCheckCache } = require("../debrid");

      const privateHashes = new Set(
        withHashes.filter(r => !r.MagnetUri && r._resolved?.buffer).map(r => r._resolved.infoHash)
      );
      const bufferMap = {};
      for (const r of withHashes) {
        if (r._resolved?.buffer) bufferMap[r._resolved.infoHash] = r._resolved.buffer;
      }

      // Pré-filtra hashes excluídos pelo RD antes do cache check para reduzir chamadas à API
      const rdExcludedHashes = new Set(
        (mode === "realdebrid" || mode === "dual")
          ? withHashes
              .filter(r => isRdExcludedResult(r, prefs, r._indexerName || r.Tracker || r.TrackerId || r.Indexer || ""))
              .map(r => r._resolved.infoHash)
          : []
      );
      if (rdExcludedHashes.size) console.log(`[RD Exclude] ${rdExcludedHashes.size} hashes excluídos antes do cache check`);

      const allHashes = [...new Set(
        withHashes
          .filter(r => mode === "torbox" || !rdExcludedHashes.has(r._resolved.infoHash))
          .map(r => String(r._resolved.infoHash || "").toLowerCase())
          .filter(Boolean)
      )];
      // Para TorBox no modo dual, inclui todos (RD excluído não afeta TB)
      const allHashesForTB = [...new Set(withHashes.map(r => String(r._resolved.infoHash || "").toLowerCase()).filter(Boolean))];

      const [rdResult, tbResult] = await Promise.all([
        (mode === "realdebrid" || mode === "dual") && rdKey && allHashes.length
          ? rdBatchCheckCache(allHashes, rdKey, bufferMap, privateHashes) : Promise.resolve({}),
        (mode === "torbox"     || mode === "dual") && torboxKey
          ? torboxBatchCheckCache(allHashesForTB, torboxKey, privateHashes) : Promise.resolve({}),
      ]);
      rdCacheMap = rdResult;
      tbCacheMap = tbResult;

      const debridCached = new Set();
      withHashes.forEach(r => {
        r._isCached = false;
        const h = String(r._resolved.infoHash || "").toLowerCase();
        if ((mode === "realdebrid" || mode === "dual") && rdCacheMap[h]?.rd?.length > 0) {
          r._isCached = true; debridCached.add(h);
        }
        if ((mode === "torbox" || mode === "dual") && tbCacheMap[h] && typeof tbCacheMap[h] === 'object' && tbCacheMap[h] !== false) {
          r._isCached = true; debridCached.add(h);
        }
      });
      console.log(`[DEBRID] cached=${debridCached.size} uncached=${withHashes.length - debridCached.size}`);
      console.log(`[PERF] debrid=${Date.now() - _tDebrid}ms`);
    } else if (prefs.stConfig && withHashes.length > 0) {
      console.log(`[STREMTHRU] Executando cache check nativo via API do StremThru...`);
      const _tDebrid = Date.now();
      const allHashesST = [...new Set(withHashes.map(r => String(r._resolved?.infoHash || "").toLowerCase()).filter(Boolean))];
      const stCacheMap = {};
      const axios = require("axios");

      for (const store of prefs.stConfig.stores) {
        const chunked = [];
        for (let i = 0; i < allHashesST.length; i += 5) chunked.push(allHashesST.slice(i, i + 5));

        for (const chunk of chunked) {
          await Promise.all(chunk.map(async hash => {
             try {
                const checkRes = await axios.get(`${prefs.stConfig.url}/v0/store/magnets/check?magnet=${hash}`, {
                   headers: { "X-StremThru-Store-Name": store.c, "X-StremThru-Store-Authorization": `Bearer ${store.t}` },
                   validateStatus: () => true, timeout: 6000
                });
                if (checkRes.status === 200 && checkRes.data?.data?.items) {
                   const torrent = checkRes.data.data.items.find(t => t.hash?.toLowerCase() === hash);
                   if (torrent && (torrent.status === "downloaded" || (torrent.files && torrent.files.length > 0))) {
                      stCacheMap[hash] = true;
                   }
                }
             } catch (e) {}
          }));
        }
      }

      let cachedCount = 0;
      for (const r of withHashes) {
         if (r._resolved?.infoHash && stCacheMap[r._resolved.infoHash.toLowerCase()]) {
            r._isCached = true;
            cachedCount++;
         }
      }
      console.log(`[STREMTHRU] Cache check concluído em ${Date.now() - _tDebrid}ms. Cacheados: ${cachedCount}`);
    }

    const availabilityFiltered = (() => {
      const filtered = withHashes.filter(r => {
        const cached = r._isCached === true || r._scrapStream?._cached === true;
        return cached || visibleSeedCount(r) >= MIN_STREAM_SEEDS;
      });
      if (filtered.length < withHashes.length) {
        console.log(`[Seeds] ${withHashes.length - filtered.length} candidato(s) abaixo de MIN_STREAM_SEEDS=${MIN_STREAM_SEEDS} removidos por não estarem em cache`);
      }
      return filtered;
    })();

    const dedupedWithHashes = (bypassRssFilters || prefs.dedupe === false)
      ? availabilityFiltered
      : dedupeWithCachePriority(availabilityFiltered, isDebridMode && !prefs.stConfig);
    if (!bypassRssFilters && prefs.dedupe !== false && dedupedWithHashes.length < withHashes.length) {
      const removed = withHashes.length - dedupedWithHashes.length;
      console.log(`[DEDUP] ${withHashes.length} → ${dedupedWithHashes.length} candidatos (-${removed} duplicatas, preferiu público cacheado)`);
    }
    const candidateCacheRank = r => r._isCached ? 0 : 1;
    const candidateLangRank = r => candidateHasPriorityLang(r) ? 0 : 1;
    const candidateKeywordRank = r => candidateHasKeyword(r) ? 0 : 1;
    const candidateResScore = r => { const rr = first(RESOLUTION, r.Title || ""); return rr ? rr.score : 0; };
    const candidateQualScore = r => { const q = first(QUALITY, r.Title || ""); return q ? q.score : 0; };
    const sortedCandidates = dedupedWithHashes
      .slice()
      .sort((a, b) => {
        const dc = candidateCacheRank(a) - candidateCacheRank(b); if (dc !== 0) return dc;
        const dpi = (b._priorityIndexer ? 1 : 0) - (a._priorityIndexer ? 1 : 0); if (dpi !== 0) return dpi;
        const dz = (b.Size || 0) - (a.Size || 0); if (dz !== 0) return dz;
        const dq = candidateQualScore(b) - candidateQualScore(a); if (dq !== 0) return dq;
        const dr = candidateResScore(b) - candidateResScore(a); if (dr !== 0) return dr;
        const dl = candidateLangRank(a) - candidateLangRank(b); if (dl !== 0) return dl;
        const dk = candidateKeywordRank(a) - candidateKeywordRank(b); if (dk !== 0) return dk;
        return (b.Seeders || 0) - (a.Seeders || 0);
      });
    const streamCandidateLimit = Math.max(maxOut * 3, 80);
    const priorityCandidates = sortedCandidates.filter(r => candidateHasPriorityLang(r) || candidateHasKeyword(r));
    const regularCandidates = sortedCandidates.filter(r => !candidateHasPriorityLang(r) && !candidateHasKeyword(r));
    const regularLimit = Math.max(0, streamCandidateLimit - priorityCandidates.length);
    const streamCandidates = [...priorityCandidates, ...regularCandidates.slice(0, regularLimit)];
    if (dedupedWithHashes.length > streamCandidates.length) {
      console.log(`[LIMIT] resolvendo ${streamCandidates.length}/${dedupedWithHashes.length} candidatos (${priorityCandidates.length} idioma/keyword preservados)`);
    }

    // streamMeta definido antes do bloco StremThru (linha ~2812)

    const resolvedAll = await Promise.all(
      streamCandidates.map(async r => {
        try {
          // Scrap sem infoHash (link direto/usenet) já vem resolvido pelo addon externo.
          if (r._scrapSource && r._scrapStream && !r._resolved?.infoHash) {
            return r._scrapStream;
          }
          
          const resolved     = r._resolved;
          const indexerName  = r._indexerName || r.Tracker || r.TrackerId || r.Indexer || "Unknown";
          const rdExcluded   = isRdExcludedResult(r, prefs, indexerName);
          // Scrap com infoHash: formata usando a formatação nativa do addon (Scrap Externo)
          const { name, description: descNoSeeds, resLabel } = formatStream(r, indexerName, parsed.isAnime, prefs, false, streamMeta);
          const { description } = formatStream(r, indexerName, parsed.isAnime, prefs, true, streamMeta);
          const matchedFile  = (type === "series" || parsed.isAnime)
            ? pickEpisodeFile(resolved.files, parsed.season, parsed.episode ?? episode, parsed.isAnime)
            : null;
          if ((type === "series" || parsed.isAnime) && resolved.files?.length && !matchedFile) {
            console.log(`[WARN] pickEpisodeFile: nenhum arquivo encontrado para S${parsed.season}E${parsed.episode ?? episode} em "${r.Title?.slice(0,60)}"`);
          } else if (matchedFile) {
            console.log(`[FILE] Arquivo selecionado: "${matchedFile.name}" (idx=${matchedFile.idx}) para S${parsed.season}E${parsed.episode ?? episode}`);
          }
          const displayFile = matchedFile || (Array.isArray(resolved.files) && resolved.files.length
            ? resolved.files
                .filter(f => /\.(mkv|mp4|avi|ts|m2ts|mov|wmv)$/i.test(f.name || ""))
                .sort((a, b) => (b.size || 0) - (a.size || 0))[0]
              || resolved.files.slice().sort((a, b) => (b.size || 0) - (a.size || 0))[0]
            : null);
          const fallbackTitle = (r.Title && !r.Title.includes('\n')) ? r.Title : "";
          const displayFileName = displayFile?.name || r._scrapStream?._filename || fallbackTitle;
          const filenameLine = displayFileName ? `📂 ${displayFileName}` : "";
          // Descarta streams cujo arquivo selecionado não é reproduzível (iso, rar, zip, etc.)
          if (displayFile?.name && BAD_EXT_RE.test(displayFile.name)) return null;
          const magnet      = buildMagnet(resolved.infoHash, r.MagnetUri, r.Title);
          const publicBase  = getPublicBase(req);
          const localPlayable = !isDebridMode && qbitEnabledForPrefs
            ? await getPlayableLocalFile(resolved.infoHash, matchedFile?.idx ?? null, matchedFile?.name || null, qbitCreds).catch(() => null)
            : null;

          // Tracker privado = resultado por link .torrent sem MagnetUri, mesmo quando o buffer veio do cache.
          const isPrivateTracker = isPrivateTrackerCandidate(r, resolved);

          let qbitStreamPromise = null;
          const buildQbitStream = async () => {
            if (qbitStreamPromise) return qbitStreamPromise;
            qbitStreamPromise = (async () => {
            // FIX: salva o buffer .torrent já baixado no job (evita re-download que pode falhar)
            // para trackers privados sem MagnetUri o re-download frequentemente falha por expiração
            // de sessão do Jackett. O buffer é enriquecido com trackers extras antes de salvar.
            let torrentB64 = null;
            if (resolved.buffer) {
              try {
                torrentB64 = injectTrackers(resolved.buffer).toString("base64");
              } catch {
                torrentB64 = resolved.buffer.toString("base64");
              }
            }
            const jobToken = await saveQbitJob({
              infoHash: resolved.infoHash,
              link:     (r.Link && !r.Link.startsWith("magnet:")) ? r.Link : null,
              magnet,
              fileIdx:  matchedFile?.idx  ?? null,
              fileName: matchedFile?.name || null,
              torrentB64,
            });
            const qbitName = localPlayable
              ? `${prefs.addonName || "ProwJack"}\n⚡️ ${resLabel || "Links"} [QB]`
              : `${prefs.addonName || "ProwJack"}\n⬇️ ${resLabel || "Links"} [QB]`;
            return {
              name: qbitName,
              description: [description, filenameLine, isPrivateTracker ? "🔒 Tracker Privado" : ""].filter(Boolean).join("\n"),
              url:   `${publicBase}/${req.params.userConfig}/qbit/${jobToken}`,
              indexer: renameIndexer(indexerName),
              _cached: !!localPlayable,
              _sourceType: "http",
              _priorityIndexer: !!r._priorityIndexer,
              behaviorHints: {
                filename:   displayFileName,
                videoSize:  displayFile?.size,
                bingeGroup: `prowjack|qbit|${resolved.infoHash}`,
                notWebReady: false,
              },
            };
            })();
            return qbitStreamPromise;
          };

          if (isDebridMode) {
            const debridMode = prefs.debridConfig?.mode;
            // No modo realdebrid puro, bloqueia o torrent inteiro se excluído
            if (rdExcluded && debridMode === "realdebrid") {
              console.log(`[RD Exclude] ${r.Title?.slice(0, 80)} (${indexerName})`);
              return null;
            }
            // No modo torbox puro, rdExcluded não deve ter efeito algum
            // No modo dual, rdExcluded só filtra o stream RD (dentro do resultsArray.filter abaixo)
            const debridData = await resolveDebridStream(
              resolved.infoHash,
              magnet,
              r.Title,
              parsed.season,
              parsed.episode ?? episode,
              parsed.isAnime,
              prefs.debridConfig,
              resolved.files,
              rdCacheMap[resolved.infoHash],
              tbCacheMap[resolved.infoHash],
              resolved.buffer
            );

            if (!debridData) {
              // Tracker privado sem cache no debrid: oferecer qBit se habilitado
              if (shouldOfferQbitForResult(prefs, isPrivateTracker, qbitCreds) && resolved.buffer) {
                return buildQbitStream();
              }
              return null;
            }
            const resultsArray = debridData.multi ? debridData.multi : [debridData];

            return Promise.all(resultsArray.filter(resObj => {
              if (rdExcluded && resObj.provider === "Real-Debrid") {
                console.log(`[RD Exclude] ${r.Title?.slice(0, 80)} (${indexerName})`);
                return false;
              }
              return true;
            }).map(async resObj => {
              const addonName    = prefs.addonName || "ProwJack";
              const resLabelStr  = resLabel || "Links";
              const isDual       = prefs.debridConfig?.mode === "dual";
              const providerTag  = resObj.provider === "TorBox" ? "[TB]" : "[RD]";

              if (resObj.url && !resObj.queued) {
                const debridFilename = resObj.filename || displayFileName;
                const streamName = `${addonName}\n⚡️ ${resLabelStr} ${providerTag}`;
                return {
                  name: streamName,
                  description: [descNoSeeds, debridFilename ? `📂 ${debridFilename}` : ""].filter(Boolean).join("\n"),
                  url:     resObj.url,
                  _cached: true,
                  _sourceType: "debrid",
                  _priorityIndexer: !!r._priorityIndexer,
                  behaviorHints: {
                    filename:   debridFilename || displayFileName,
                    videoSize:  displayFile?.size,
                    bingeGroup: `prowjack|debrid|${resolved.infoHash}`,
                    notWebReady: false,
                  },
                };
              }

              if (resObj.queued) {
                const provider   = (resObj.provider || "Debrid").toLowerCase().replace(/[^a-z]/g, "");
                const hostUrl    = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers['x-forwarded-host'] || req.get('host')}`;
                const linkParam   = r.Link ? `&link=${encodeURIComponent(r.Link)}` : "";
                const fileParam   = resObj.fileId != null ? `&file_id=${encodeURIComponent(resObj.fileId)}` : "";
                const cachedParam = resObj.cached ? "&cached=1" : "";
                const seasonParam  = parsed.season  != null ? `&season=${parsed.season}`   : "";
                const episodeParam = (parsed.episode ?? episode) != null ? `&episode=${parsed.episode ?? episode}` : "";
                const animeParam   = parsed.isAnime ? "&anime=1" : "";
                const addUrl     = `${hostUrl}/${req.params.userConfig}/debrid-add/${provider}/${resolved.infoHash}?magnet=${encodeURIComponent(magnet)}${linkParam}${fileParam}${cachedParam}${seasonParam}${episodeParam}${animeParam}`;
                const cacheEmoji = resObj.cached ? "⚡️" : "⬇️";
                const streamName = `${addonName}\n${cacheEmoji} ${resLabelStr} ${providerTag}`;

                const debridOption = {
                  name: streamName,
                  description: [description, filenameLine].filter(Boolean).join("\n"),
                  url:     addUrl,
                  _cached: !!resObj.cached,
                  _sourceType: "debrid",
                  _priorityIndexer: !!r._priorityIndexer,
                  behaviorHints: { filename: displayFileName, videoSize: displayFile?.size, notWebReady: true },
                };

                if (shouldOfferQbitForResult(prefs, isPrivateTracker, qbitCreds)) {
                  const qbitOption = await buildQbitStream();
                  return [debridOption, qbitOption];
                }

                return debridOption;
              }
              return null;
            })).then(items => items.filter(Boolean));
          }

          // ── Modo P2P (sem debrid) ──────────────────────────────────────
          const shouldOfferQbit = shouldOfferQbitForResult(prefs, isPrivateTracker, qbitCreds);

          if (shouldOfferQbit && (localPlayable || r.Link || magnet)) {
            const qbitStream = await buildQbitStream();

            if (isPrivateTracker && !r.MagnetUri) {
              if (!resolved.infoHash) return qbitStream;
              const sources = EXTRA_TRACKERS.map(t => `tracker:${t}`).concat(`dht:${resolved.infoHash}`);
              const p2pPrivate = {
                name, description: [description, filenameLine].filter(Boolean).join("\n"),
                infoHash: resolved.infoHash, sources,
                _sourceType: "p2p", _priorityIndexer: !!r._priorityIndexer,
                behaviorHints: { filename: displayFileName, bingeGroup: `prowjack|${resolved.infoHash}` },
              };
              if (matchedFile?.idx != null) p2pPrivate.fileIdx = matchedFile.idx;
              return [qbitStream, p2pPrivate];
            }

            let _qbitTrackers = [];
            if (resolved.buffer) {
              _qbitTrackers = extractTrackers(resolved.buffer);
            } else if (r.MagnetUri) {
              for (const m of (r.MagnetUri.matchAll(/[&?]tr=([^&]+)/g) || [])) {
                try { _qbitTrackers.push(decodeURIComponent(m[1])); } catch {}
              }
            }
            const _qbitAllTrackers = _qbitTrackers.length ? _qbitTrackers : EXTRA_TRACKERS;
            const sources = _qbitAllTrackers.map(t => `tracker:${t}`).concat(`dht:${resolved.infoHash}`);
            if (!resolved.infoHash) return qbitStream;

            const p2pStream = {
              name,
              description: [description, filenameLine].filter(Boolean).join("\n"),
              infoHash: resolved.infoHash,
              sources,
              _sourceType: "p2p",
              _priorityIndexer: !!r._priorityIndexer,
              behaviorHints: {
                filename:   displayFileName,
                videoSize:  displayFile?.size || undefined,
                bingeGroup: parsed.isAnime ? `prowjack|anime|${displayTitle}` : `prowjack|${resolved.infoHash}`,
              },
            };
            if (matchedFile?.idx != null) p2pStream.fileIdx = matchedFile.idx;
            return [qbitStream, p2pStream];
          }

          // Tracker privado sem MagnetUri e sem P2P habilitado
          if (isPrivateTracker && !r.MagnetUri && !prefs.enableP2P) return null;

          // P2P nativo: só retorna se P2P habilitado, sem debrid nativo e sem proxy StremThru.
          if (prefs.enableP2P !== false && !isDebridMode && !prefs.stConfig) {
            if (!resolved.infoHash) return null;

            // Formato exato do Torrentio (referência oficial):
            // sources = trackers.map(t => `tracker:${t}`).concat(`dht:${infoHash}`)
            let trackerList = [];
            if (resolved.buffer) {
              trackerList = extractTrackers(resolved.buffer);
            } else if (r.MagnetUri) {
              for (const m of (r.MagnetUri.matchAll(/[&?]tr=([^&]+)/g) || [])) {
                try { trackerList.push(decodeURIComponent(m[1])); } catch {}
              }
            }
            const allTrackers = trackerList.length ? trackerList : EXTRA_TRACKERS;
            const sources = allTrackers.map(t => `tracker:${t}`).concat(`dht:${resolved.infoHash}`);

            const stream = {
              name,
              description: [description, filenameLine].filter(Boolean).join("\n"),
              infoHash: resolved.infoHash,
              sources,
              _sourceType: "p2p",
              _priorityIndexer: !!r._priorityIndexer,
              behaviorHints: {
                filename:   displayFileName,
                videoSize:  displayFile?.size || undefined,
                bingeGroup: parsed.isAnime ? `prowjack|anime|${displayTitle}` : `prowjack|${resolved.infoHash}`,
              },
            };

            if (matchedFile?.idx != null) stream.fileIdx = matchedFile.idx;

            return stream;
          }

          // StremThru sem proxy manifest legado: retorna magnet/infoHash para o wrapper externo.
          // Configurações novas usam proxyManifestUrl e são injetadas abaixo como streams externos,
          // mantendo a URL própria do ProwJack instalada no Stremio.
          if (prefs.stConfig && !prefs.stConfig.proxyManifestUrl) {
            const sources = r.MagnetUri
              ? [r.MagnetUri]
              : (resolved.infoHash ? [buildMagnet(resolved.infoHash, null, r.Title)] : []);
            if (!sources.length) return null;
            
            const storeCodeMap = { torbox: "TB", realdebrid: "RD" };
            const desc = [description, filenameLine].filter(Boolean).join("\n");
            const bh   = { filename: displayFileName, videoSize: displayFile?.size, bingeGroup: `prowjack|${resolved.infoHash}`, notWebReady: true };
            return prefs.stConfig.stores.map(s => {
              const tag = storeCodeMap[s.c] || s.c.toUpperCase();
              return { name: `${name.split("\n")[0]}\n⬇️ ${resLabel || "Links"} [${tag}]`, description: desc, url: sources[0], _sourceType: "debrid", _priorityIndexer: !!r._priorityIndexer, behaviorHints: bh };
            });
          }

          return null;
        } catch { return null; }
      })
    );

    const allStreams = resolvedAll.flat(2).filter(Boolean);


    resolvedAll.forEach((streamOrArr, i) => {
      const r = streamCandidates[i];
      if (!r) return;
      const items = Array.isArray(streamOrArr) ? streamOrArr.flat() : [streamOrArr];
      for (const s of items) {
        if (!s) continue;
        s._originalScore = r._originalScore || 0;
        s._title   = r.Title   || "";
        s._seeders = r.Seeders || 0;
        s._sizeGb  = (r.Size   || 0) / 1e9;
        // Garante que _priorityIndexer do resultado Jackett seja propagado para o stream
        if (r._priorityIndexer && !s._priorityIndexer) s._priorityIndexer = true;
        // Propaga _isCached do resultado para _cached do stream (campos distintos)
        if (r._isCached && s._cached == null) s._cached = true;
        // Chave do indexer para maxResultsPerIndexer na ordenação final
        s._indexerKey = String(r.TrackerId || r.Tracker || r._indexerName || r.Indexer || "unknown").toLowerCase();
      }
    });

    const dedupedStreams = prefs.dedupe === false ? allStreams : (() => {
      const out = [];
      const seenQbit = new Set();
      // Dedup scrap vs Jackett: scrap tem prioridade por infoHash idêntico OU tamanho similar (±5%)
      const scrapHashes = new Set(allStreams.filter(s => s._scrapSource && s.infoHash).map(s => s.infoHash.toLowerCase()));
      const scrapSizes  = allStreams.filter(s => s._scrapSource && (s._sizeBytes > 0)).map(s => s._sizeBytes);
      const jackettHashes = new Set(allStreams.filter(s => !s._scrapSource && s.infoHash).map(s => s.infoHash.toLowerCase()));
      const isSimilarSize = (a, b) => a > 0 && b > 0 && Math.abs(a - b) / Math.max(a, b) < 0.05;
      for (const s of allStreams) {
        // Scrap: marca _cached=true se mesmo hash que Jackett
        if (s._scrapSource && s.infoHash && jackettHashes.has(s.infoHash.toLowerCase())) {
          s._cached = true;
        }
        // Jackett: remove se scrap cobre mesmo hash OU tamanho similar
        if (!s._scrapSource) {
          const hash = s.infoHash?.toLowerCase();
          const size = s.behaviorHints?.videoSize || s._sizeBytes || 0;
          if (hash && scrapHashes.has(hash)) continue;
          if (size > 0 && scrapSizes.some(ss => isSimilarSize(ss, size))) continue;
        }
        const isQbit = s?._sourceType === "http" && typeof s.url === "string" && s.url.includes("/qbit/");
        if (isQbit) {
          const key = `${s.behaviorHints?.bingeGroup || ""}|${s.behaviorHints?.filename || ""}`;
          if (seenQbit.has(key)) continue;
          seenQbit.add(key);
        }
        out.push(s);
      }
      return out;
    })();

    const _sourceRank = (s) => {
      if (s?._sourceType === "http")   return 2;
      if (s?._sourceType === "debrid") return 0;
      if (s?._sourceType === "p2p")    return 1;
      return 3;
    };

    const _resScore  = (s) => { const r = first(RESOLUTION, s._title || ""); return r ? r.score  : 0; };
    const _qualScore = (s) => { const q = first(QUALITY,    s._title || ""); return q ? q.score  : 0; };

    const _hasKeyword = (s) => !!(prefs.keywordBoost && matchesKeywordBoost([s._title, s.description, s.name, s.behaviorHints?.filename].filter(Boolean).join(" "), prefs.keywordBoost));
    const _hasPriorityLang = (s) => {
      const t = [s._title, s.description, s.name, s.behaviorHints?.filename].filter(Boolean).join(" ");
      const langs = getLangs(t, parsed.isAnime);
      return !!(
        (priorityLang && langs.some(l => l.code === priorityLang)) ||
        ((priorityLang === "pt-br" && /(dublado|dubbed.*pt|pt[-_. ]?br|\bpor\b|\bpt\b|portugu[eê]s|portuguese|brazilian)/i.test(t)))
      );
    };
    const _isMulti = (s) => /(multi|dual)[-.\\s]?(audio)?/i.test(s._title || "");
    const _sizeScore = (s) => {
      const size = Number(s._sizeGb || 0);
      return size > 0 ? size : 0;
    };

    const _httpRank = (s) => s?._sourceType === "http" ? 1 : 0;
    const _cacheRank = (s) => s._cached ? 0 : 1;
    const _langRank = (s) => _hasPriorityLang(s) ? 0 : 1;
    const _keywordRank = (s) => _hasKeyword(s) ? 0 : 1;
    const _priorityIndexerRank = (s) => s._priorityIndexer ? 0 : 1;

    dedupedStreams.sort((a, b) => {
      const dh = _httpRank(a) - _httpRank(b); if (dh !== 0) return dh;
      const dc = _cacheRank(a) - _cacheRank(b); if (dc !== 0) return dc;
      const dpi = _priorityIndexerRank(a) - _priorityIndexerRank(b); if (dpi !== 0) return dpi;
      const dz = _sizeScore(b) - _sizeScore(a); if (dz !== 0) return dz;
      const dq = _qualScore(b) - _qualScore(a); if (dq !== 0) return dq;
      const dr = _resScore(b)  - _resScore(a);  if (dr !== 0) return dr;
      const dl = _langRank(a) - _langRank(b); if (dl !== 0) return dl;
      const dk = _keywordRank(a) - _keywordRank(b); if (dk !== 0) return dk;
      const dsr = _sourceRank(a) - _sourceRank(b); if (dsr !== 0) return dsr;
      return (b._seeders || 0) - (a._seeders || 0);
    });

    const finalStreams = (() => {
      const isQbStream = s => s?._sourceType === "http" && typeof s.url === "string" && s.url.includes("/qbit/");

      const applyCoverage = (pool, limit) => {
        const selected = [];
        const seen = new Set();
        const keyOf = s => s.infoHash || s.url || s.externalUrl || s.behaviorHints?.bingeGroup || s.description || s.name;
        const add = s => {
          if (!s || selected.length >= limit) return;
          const key = keyOf(s);
          if (key && seen.has(key)) return;
          if (key) seen.add(key);
          selected.push(s);
        };

        for (const s of pool) {
          if (_hasPriorityLang(s) || _hasKeyword(s)) add(s);
        }
        for (const s of pool) add(s);
        return selected;
      };

      let normalPool = dedupedStreams.filter(s => !isQbStream(s));
      if (!bypassRssFilters && prefs.maxResultsPerIndexer > 0) {
        const applyPerIndexerLimit = pool => {
          const countByIndexer = new Map();
          return pool.filter(s => {
            const key = s._indexerKey || "unknown";
            const n = (countByIndexer.get(key) || 0) + 1;
            countByIndexer.set(key, n);
            return n <= prefs.maxResultsPerIndexer;
          });
        };
        const priorityPool = applyPerIndexerLimit(normalPool.filter(s => _hasPriorityLang(s) || _hasKeyword(s)));
        const priorityKeys = new Set(priorityPool.map(s => s.infoHash || s.url || s.externalUrl || s.behaviorHints?.bingeGroup || s.description || s.name).filter(Boolean));
        const regularPool = applyPerIndexerLimit(normalPool.filter(s => {
          const key = s.infoHash || s.url || s.externalUrl || s.behaviorHints?.bingeGroup || s.description || s.name;
          return !_hasPriorityLang(s) && !_hasKeyword(s) && (!key || !priorityKeys.has(key));
        }));
        normalPool = [...priorityPool, ...regularPool];
      }

      const limitedNormal = applyCoverage(normalPool, maxOut);
      if (QB_EXTRA_SLOTS <= 0) return limitedNormal;

      const normalKeys = new Set(limitedNormal.map(s => s.infoHash || s.behaviorHints?.bingeGroup || s.url).filter(Boolean));
      const qbExtra = dedupedStreams
        .filter(isQbStream)
        .filter(s => {
          const key = s.infoHash || s.behaviorHints?.bingeGroup || s.url;
          return !key || !normalKeys.has(key);
        })
        .slice(0, QB_EXTRA_SLOTS);

      if (qbExtra.length) console.log(`[QB] ${qbExtra.length} streams [QB] adicionados como slots extras (QB_EXTRA_SLOTS=${QB_EXTRA_SLOTS})`);
      return [...limitedNormal, ...qbExtra];
    })();
    if (dedupedStreams.length > 0) {
      const top = dedupedStreams.slice(0, Math.min(5, dedupedStreams.length));
      console.log(`[ORDEM] top${top.length}: ` + top.map(s => `[cache=${s._cached?1:0} prio=${s._priorityIndexer?1:0} lang=${_hasPriorityLang(s)?1:0} key=${_hasKeyword(s)?1:0} prioRank=${_priorityIndexerRank(s)} size=${_sizeScore(s).toFixed(1)} res=${_resScore(s).toFixed(1)} qb=${s._sourceType==="http"?1:0} ix=${s._indexerKey||"?"}] ${(s._title||"").slice(0,40)}`).join(" | "));
    }
    finalStreams.forEach(s => {
      delete s._cached;
      delete s._originalScore;
      delete s._title;
      delete s._seeders;
      delete s._sizeGb;
      delete s._priorityIndexer;
      delete s._indexerKey;
      delete s._sourceType;
      delete s._scrapSource;
      delete s._stremThruProxy;
      delete s._sizeBytes;
      delete s.indexer; // Campo não usado pelo Stremio
    });

    if (finalStreams.length > 0) {
      const topFinal = finalStreams.slice(0, Math.min(5, finalStreams.length))
        .map(s => `${(s.name || "").split("\n")[0]} => ${(s.behaviorHints?.filename || s.title || s.description || "").slice(0, 60)}`);
      console.log(`[FINAL] top${topFinal.length}: ${topFinal.join(" | ")}`);
    }

    if (isDebridMode) {
      const cached = finalStreams.filter(s => s.externalUrl || (s.url && !s.url.includes('/debrid-add/'))).length;
      const queued = finalStreams.filter(s => s.url &&  s.url.includes('/debrid-add/')).length;
      console.log(`[DEBRID] Streams listados: ${cached} ⚡️ cached + ${queued} ⬇️ on-demand`);
    } else {
      console.log(`Magnets listados: Enviando ${finalStreams.length} torrents!`);
    }
    console.log(`=========================================\n`);
    // Salva streams resolvidos no cache (TTL 3h) — só se tiver resultados
    if (finalStreams.length > 0) {
      const ttl = reqCtx.hasTimedOut ? 5 : 10800; // 5 segundos se incompleto, 3 horas se completo
      rc.set(streamCacheKey, JSON.stringify(finalStreams), ttl).catch(() => {});
    }
    console.log(`[DEBUG] Provider retornou: ${results.length} | Candidatos: ${candidates.length} | Com hash: ${withHashes.length} | Dedupe: ${dedupedWithHashes.length} | Final: ${finalStreams.length}`);
    console.log(`[PERF] total=${Date.now() - _t0}ms`);
    releaseLock(finalStreams);
    res.json({ streams: finalStreams });
  } catch (err) {
    console.log(`Erro no processamento: ${err.message}`);
    releaseLock([]);
    res.json({ streams: [] });
  }
});

module.exports = router;
