const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'public', 'configure.html');
let html = fs.readFileSync(file, 'utf8');

// 1. Theme update - richer colors, gradients, and fonts
html = html.replace(
  /:root\{([\s\S]*?)--r:10px;--r2:14px;--shadow:0 4px 24px rgba\(0,0,0,\.35\);\n\}/,
  `:root{
  --bg:#070709;--sur:#101115;--sur2:#16181d;--bord:#262833;--bord2:#353846;
  --accent:#6366f1;--accent2:#818cf8;--accent-glow:rgba(99,102,241,.25);
  --green:#10b981;--red:#ef4444;--amber:#f59e0b;
  --text:#f8fafc;--dim:#94a3b8;--muted:#0b0c0f;
  --tb:#fb923c;--tb-dim:#7c3a0e;--tb-bg:rgba(251,146,60,.08);
  --rd:#c084fc;--rd-dim:#6b21a8;--rd-bg:rgba(192,132,252,.08);
  --mono:'JetBrains Mono',monospace;--sans:'Inter',sans-serif;
  --r:12px;--r2:16px;--shadow:0 8px 32px rgba(0,0,0,.4);
}`
);

// 2. Body background update (more subtle and elegant radial)
html = html.replace(
  `body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 80% 40% at 50% -10%,rgba(108,143,255,.07),transparent);pointer-events:none;z-index:0}`,
  `body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 80% 50% at 50% -20%,rgba(99,102,241,.15),transparent);pointer-events:none;z-index:0}`
);

// 3. Header CSS tweaks
html = html.replace(
  `header{width:100%;max-width:960px;display:flex;align-items:center;justify-content:space-between;padding:20px 24px;border-bottom:1px solid var(--bord);position:relative;z-index:1}`,
  `header{width:100%;max-width:960px;display:flex;align-items:center;justify-content:space-between;padding:24px;border-bottom:1px solid rgba(255,255,255,0.03);position:relative;z-index:1;background:linear-gradient(to bottom, rgba(16,17,21,0.8), transparent);backdrop-filter:blur(12px);}`
);

// 4. Update Header HTML (Link to config, remove version, add github)
html = html.replace(
  /<header>[\s\S]*?<\/header>/,
  `<header>
  <a href="/configure" style="text-decoration:none; color:inherit;">
    <div class="logo">
      <div class="logo-mark">⚡</div>
      <div>
        <span class="logo-text">Prow<span>Jack</span></span>
        <div style="font-size:11px;color:var(--dim);margin-top:2px">Jackett &bull; Prowlarr &bull; Stremio</div>
      </div>
    </div>
  </a>
  <div style="display:flex; align-items:center; gap:16px;">
    <a href="https://github.com/viniciusss100/prowjack" target="_blank" title="GitHub" style="color:var(--dim); transition:0.2s; display:flex; align-items:center;">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/></svg>
    </a>
    <div class="status-row">
      <span><span class="dot wait" id="d-jackett"></span><span id="l-jackett" style="display:none;">Jackett</span></span>
      <span><span class="dot wait" id="d-redis"></span><span id="l-redis" style="display:none;">Redis</span></span>
    </div>
  </div>
</header>`
);

fs.writeFileSync(file, html);
console.log("UI HTML updated");
