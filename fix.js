const fs = require('fs');

// 1. Fix app.listen newline
let addonCode = fs.readFileSync('addon.js', 'utf8');
addonCode = addonCode.replace(/\\napp\.listen/, '\napp.listen');

// 2. Remove rateLimit config from addon.js and remove checkRateLimit import if it was there
addonCode = addonCode.replace(/const rateLimitStore = new Map\(\);\nconst RATE_LIMIT_WINDOW = 60000;\nconst RATE_LIMIT_THRESHOLD = 100;\n/, '');

// 3. Import checkRateLimit from routeHelpers
addonCode = addonCode.replace('const app = express();', 'const app = express();\nconst { checkRateLimit } = require("./routeHelpers");');

// 4. Remove leftover constants in addon.js
addonCode = addonCode.replace(/const PUBLIC_TRACKERS = \[.*?\];\n/s, '');
addonCode = addonCode.replace(/const BAD_RE = .*?;\n/, '');
addonCode = addonCode.replace(/const BAD_EXT_RE = .*?;\n/, '');

fs.writeFileSync('addon.js', addonCode);

// 5. Add rate limit config to routeHelpers.js
let routeHelpersCode = fs.readFileSync('routeHelpers.js', 'utf8');
const limitConfig = `
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_THRESHOLD = 100;
`;
routeHelpersCode = routeHelpersCode.replace('const memoryStore = {', limitConfig + '\nconst memoryStore = {');
fs.writeFileSync('routeHelpers.js', routeHelpersCode);

// 6. Fix provider imports from the extraction in the routes (which caused errors before)
const files = ['api.js', 'manifest.js', 'configure.js', 'catalog.js', 'qbit.js', 'stream.js'];
for (const f of files) {
  const p = 'routes/' + f;
  let code = fs.readFileSync(p, 'utf8');
  code = code.replace(/const \{ torboxAddMagnet, torboxGetInfo, torboxRequestDownload, torboxGetDownloadLink \} = require\("\.\.\/providers\/torbox"\);\n/g, '');
  code = code.replace(/const \{ rdAddMagnet, rdSelectFiles, rdGetItem, rdUnrestrictLink \} = require\("\.\.\/providers\/realdebrid"\);\n/g, '');
  code = code.replace(/const \{ qbitAddMagnet \} = require\("\.\.\/providers\/qbittorrent"\);\n/g, '');
  fs.writeFileSync(p, code);
}

console.log('Fixed all integration issues!');
