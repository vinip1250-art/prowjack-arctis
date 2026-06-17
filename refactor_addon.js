const fs = require('fs');
const acorn = require('acorn');

let code = fs.readFileSync('addon.js', 'utf8');

// The functions and variables we extracted
const helpersToExtract = new Set([
  'getPublicBase',
  'buildStremThruProxyManifestUrl',
  'isQbitEnabledForPrefs',
  'shouldOfferQbitForResult',
  'getRequestAccessToken',
  'hasAdminAccess',
  'requireAdminAccess',
  'getRssFastPathResults',
  'sendConfigurePage',
  'fetchScrapStreams',
  'isPrivateTrackerCandidate',
  'checkRateLimit',
  'resolvePrefs',
  'saveQbitJob',
  'loadQbitJob'
]);

const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: 'script' });
let nodesToRemove = [];

for (const node of ast.body) {
  if (node.type === 'FunctionDeclaration' && node.id && helpersToExtract.has(node.id.name)) {
    nodesToRemove.push(node);
  } else if (node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression') {
    const callee = node.expression.callee;
    if (callee.type === 'MemberExpression' && callee.object.name === 'app' && (callee.property.name === 'get' || callee.property.name === 'post')) {
      nodesToRemove.push(node);
    }
  } else if (node.type === 'VariableDeclaration') {
    let shouldRemove = false;
    for (const decl of node.declarations) {
      if (decl.id && decl.id.type === 'Identifier') {
        if (['rateLimitStore', 'RATE_LIMIT_WINDOW', 'RATE_LIMIT_THRESHOLD', 'PUBLIC_TRACKERS', 'BAD_RE', 'BAD_EXT_RE'].includes(decl.id.name)) {
           shouldRemove = true;
        }
      }
    }
    if (shouldRemove) {
        nodesToRemove.push(node);
    }
  }
}

nodesToRemove.sort((a, b) => b.start - a.start);
for (const node of nodesToRemove) {
  code = code.slice(0, node.start) + code.slice(node.end);
}

// Now insert imports at the top
const routeImports = `
app.use("/", require("./routes/api"));
app.use("/", require("./routes/manifest"));
app.use("/", require("./routes/configure"));
app.use("/", require("./routes/catalog"));
app.use("/", require("./routes/qbit"));
app.use("/", require("./routes/stream"));
`;
code = code.replace('app.listen(ENV.port', routeImports + '\napp.listen(ENV.port');

// Add helper import
code = code.replace('const app = express();', 'const app = express();\nconst { checkRateLimit } = require("./routeHelpers");');

fs.writeFileSync('addon.js', code);
console.log('Cleaned addon.js perfectly!');
