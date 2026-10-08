// Read-only static inventory. Framework entry points and operational tools are roots;
// absence from this graph is a review candidate, never automatic deletion authority.
import ts from 'typescript';
import path from 'node:path';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';

const root = process.cwd();
const slash = p => p.replaceAll('\\', '/');
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
    .map(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))).flat();
}
const files = (await Promise.all(['src', 'tools', 'public'].map(walk))).flat().filter(f => /\.[cm]?[jt]sx?$/.test(f));
const options = ts.readConfigFile('tsconfig.json', ts.sys.readFile).config;
const compiler = ts.parseJsonConfigFileContent(options, ts.sys, root).options;
const nodes = new Map(), packages = new Set();
for (const file of files) {
  const text = await readFile(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const specs = [], tables = new Set(), rpcs = new Set();
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specs.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require') specs.push(node.arguments[0].text);
      if (ts.isPropertyAccessExpression(node.expression)) {
        if (node.expression.name.text === 'from') tables.add(node.arguments[0].text);
        if (node.expression.name.text === 'rpc') rpcs.add(node.arguments[0].text);
        if (node.expression.getText(source) === 'vi.mock') specs.push(node.arguments[0].text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  const key = slash(path.relative(root, file));
  nodes.set(key, { file, specs, tables: [...tables], rpcs: [...rpcs], edges: [], unresolved: [] });
}
for (const node of nodes.values()) for (const spec of node.specs) {
  if (!spec.startsWith('.') && !spec.startsWith('@/') && !spec.startsWith('node:')) packages.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
  if (!spec.startsWith('.') && !spec.startsWith('@/')) continue;
  const resolved = ts.resolveModuleName(spec, path.resolve(node.file), compiler, ts.sys).resolvedModule;
  const target = resolved ? slash(path.relative(root, resolved.resolvedFileName)) : null;
  if (target && nodes.has(target)) node.edges.push(target);
  else if (!/\.(?:css|json|svg|png|jpg)$/.test(spec)) node.unresolved.push(spec);
}
const appRoots = [...nodes.keys()].filter(f => /^src\/app\/.*\/(?:page|layout|route|loading|error|not-found|template|default|global-error)\.[jt]sx?$/.test(f)
  || /^src\/app\/(?:page|layout|robots|sitemap|manifest|opengraph-image|twitter-image)\.[jt]sx?$/.test(f)
  || /^src\/(?:proxy|instrumentation|instrumentation-client)\.[jt]s$/.test(f) || f.startsWith('public/'));
function reachable(roots) {
  const seen = new Set(), pending = [...roots];
  while (pending.length) { const f = pending.pop(); if (seen.has(f)) continue; seen.add(f); pending.push(...(nodes.get(f)?.edges || [])); }
  return seen;
}
const runtime = reachable(appRoots), operations = reachable([...nodes.keys()].filter(f => f.startsWith('tools/')));
const tests = reachable([...nodes.keys()].filter(f => /\.test\.[cm]?[jt]sx?$/.test(f)));
const report = {
  generatedAt: new Date().toISOString(), filesScanned: nodes.size, routeRoots: appRoots.sort(),
  unreachable: [...nodes.keys()].filter(f => f.startsWith('src/') && !runtime.has(f) && !operations.has(f) && !tests.has(f)),
  testOnly: [...nodes.keys()].filter(f => f.startsWith('src/') && !/\.test\./.test(f) && !runtime.has(f) && !operations.has(f) && tests.has(f)),
  operationalOnly: [...nodes.keys()].filter(f => f.startsWith('src/') && !runtime.has(f) && operations.has(f)),
  unresolved: [...nodes].flatMap(([file,n]) => n.unresolved.map(spec => ({ file, spec }))),
  packageImports: [...packages].sort(),
  databaseReferences: [...nodes].filter(([,n]) => n.tables.length || n.rpcs.length).map(([file,n]) => ({ file, runtime: runtime.has(file), tables: n.tables, rpcs: n.rpcs })),
};
await mkdir('scratch/codebase-audit', { recursive: true });
await writeFile('scratch/codebase-audit/static.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, routeRoots: undefined, databaseReferences: undefined }, null, 2));
