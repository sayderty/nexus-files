// Собирает manifest.json из папок files/ (всё, что копируется в папку игры) и forge/ (installer .jar)
// Запускается автоматически GitHub Action при каждом push. Локально: npm run manifest -- логин/репо main
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const repo = process.env.GITHUB_REPOSITORY || process.argv[2];
const branch = process.env.GITHUB_REF_NAME || process.argv[3] || 'main';
if (!repo) { console.error('Укажи репозиторий: npm run manifest -- логин/репо main'); process.exit(1); }
const base = `https://raw.githubusercontent.com/${repo}/${branch}/`;
const sha1 = f => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
const walk = d => !fs.existsSync(d) ? [] : fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);

const files = walk('files').filter(f => !f.endsWith('.gitkeep')).map(f => {
  const rel = path.relative('files', f).split(path.sep).join('/');
  return { path: rel, url: base + 'files/' + encodeURI(rel), sha1: sha1(f), size: fs.statSync(f).size };
});
const fj = walk('forge').find(f => f.endsWith('.jar'));
const manifest = {
  version: new Date().toISOString(),
  forge: fj ? { url: base + 'forge/' + encodeURI(path.basename(fj)), sha1: sha1(fj), size: fs.statSync(fj).size } : null,
  clean: ['mods'],           // из этих папок лишние файлы удаляются у игроков
  files
};
fs.writeFileSync('manifest.json', JSON.stringify(manifest, null, 1));
console.log(`manifest.json: ${files.length} файлов, forge: ${fj ? 'да' : 'нет'}`);
