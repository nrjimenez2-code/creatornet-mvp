const fs = require('node:fs'); const path = require('node:path');
const root = path.join(__dirname, '..');
const matrix = JSON.parse(fs.readFileSync(path.join(root, 'docs/ios/feature-parity.json'), 'utf8'));
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
const route = file => '/' + path.relative(path.join(root, 'app'), path.dirname(file)).split(path.sep).filter(part => part !== '.' && !/^\(.*\)$/.test(part)).join('/');
const pages = walk(path.join(root, 'app')).filter(file => file.endsWith(path.sep + 'page.tsx')).map(route);
const errors = [];
for (const filename of ['feedMediaManifest.json', 'feedAdaptiveManifest.json']) {
  const shared = path.join(root, 'packages/shared/src', filename);
  const website = path.join(root, 'lib', filename);
  if (!fs.existsSync(shared) || !fs.existsSync(website) || fs.readFileSync(shared, 'utf8') !== fs.readFileSync(website, 'utf8')) errors.push('Shared media manifest differs from website: ' + filename);
}
for (const filename of fs.readdirSync(path.join(root, 'apps/ios/native')).filter(name => name.endsWith('.swift'))) {
  const canonical = path.join(root, 'apps/ios/native', filename);
  const target = path.join(root, 'apps/ios/ios/App/App', filename);
  if (!fs.existsSync(target) || fs.readFileSync(canonical, 'utf8') !== fs.readFileSync(target, 'utf8')) errors.push('Native target differs from adapter source: ' + filename);
}
if (!fs.readFileSync(path.join(root, 'apps/ios/ios/App/App/SceneDelegate.swift'), 'utf8').includes('rootViewController = CreatorNetViewController()')) errors.push('Active scene does not instantiate the native adapter bridge.');
for (const page of pages) if (!matrix.items.some(item => item.websiteRoute === page)) errors.push('Website route missing from parity scope: ' + page);
const seen = new Set();
for (const item of matrix.items) {
  if (seen.has(item.id)) errors.push('Duplicate item: ' + item.id); seen.add(item.id);
  for (const field of ['websiteBehavior', 'appImplementation', 'dependency', 'acceptanceEvidence']) if (!item[field]) errors.push(item.id + ': missing ' + field);
  if (!Array.isArray(item.roles) || !item.roles.length || !Array.isArray(item.acceptanceCases) || !item.acceptanceCases.length) errors.push(item.id + ': missing roles/acceptance cases');
  if (process.argv.includes('--ready') && (item.appState !== 'accepted' || !item.acceptanceEvidence.device || !item.acceptanceEvidence.revision || !item.acceptanceEvidence.build)) errors.push(item.id + ': not accepted on the candidate physical iPhone build');
}
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log(`Parity scope recorded: ${pages.length} website pages, ${matrix.items.length} required items. Accepted: ${matrix.items.filter(item => item.appState === 'accepted').length}.`);
