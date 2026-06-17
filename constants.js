const ENV = {
  jackettUrl:      (process.env.JACKETT_URL || "http://localhost:9117").replace(/\/+$/, ""),
  apiKey:          (process.env.JACKETT_API_KEY || "").trim(),
  redisUrl:        (process.env.REDIS_URL || "redis://127.0.0.1:6379").trim(),
  port:            parseInt(process.env.PORT || "7014", 10),
  addonPublicUrl:  (process.env.ADDON_PUBLIC_URL || "").trim().replace(/\/+$/, ""),
  accessToken:     (process.env.ACCESS_TOKEN || "").trim(),
  scrapManifests:  (process.env.SCRAP_MANIFEST_URLS || "").split(",").map(s => s.trim()).filter(Boolean),
  stremThruUrl:    (process.env.STREMTHRU_URL || "").trim().replace(/\/+$/, ""),
  rssUpdateIntervalMinutes: parseInt(process.env.RSS_UPDATE_INTERVAL_MINUTES || "30", 10),
  qbitConfig: {
    url:      (process.env.QBIT_URL || "").trim().replace(/\/+$/, ""),
    username: (process.env.QBIT_USERNAME || "").trim(),
    password: (process.env.QBIT_PASSWORD || "").trim(),
    saveDir:  (process.env.QBIT_SAVE_DIR || "").trim()
  }
};

const CACHE_VERSION = "v12-native-debrid";
const STREAM_CACHE_VERSION = "v46-st-clean-sources";
const TORRENT_DOWNLOAD_TIMEOUT_MS = 15000;

const PUBLIC_TRACKERS = ["1337x", "thepiratebay", "eztv", "yts", "torrentgalaxy", "rutracker", "nyaasi", "nyaa", "nyaa.si", "limetorrents", "torlock", "kickass", "demonoid", "rarbg", "bitsearch", "solidtorrents", "magnetdl", "bt4g", "idope", "extratorrent", "comando", "bludv", "lapumia", "ondebaixa", "thepiratafilmes", "baixar", "torrentdosfilmes", "betor", "bitmagnet", "knaben", "stremthru", "torrentio"];
const BAD_RE = /\b(cam|hdcam|camrip|workprint)\b/i;
const BAD_EXT_RE = /\.(iso|r\d{2}|zip|rar|7z|tar|gz|zipx|arj|txt|nfo|jpg|png|pdf|exe|bat|cmd|scr|msi|ps1|vbs|js|jar|com|pif|reg|dll|sys|lnk|url)$/i;

const TORRENT_FAILURE_TTL = 3600000;
const STREMTHRU_PROXY_TIMEOUT_MS = 15000;
const QB_EXTRA_SLOTS = 5;
const MIN_STREAM_SEEDS = 1;

module.exports = {
  ENV,
  CACHE_VERSION,
  STREAM_CACHE_VERSION,
  TORRENT_DOWNLOAD_TIMEOUT_MS,
  TORRENT_FAILURE_TTL,
  STREMTHRU_PROXY_TIMEOUT_MS,
  QB_EXTRA_SLOTS,
  MIN_STREAM_SEEDS,
  PUBLIC_TRACKERS,
  BAD_RE,
  BAD_EXT_RE
};
