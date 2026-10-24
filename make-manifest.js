// Собирает manifest.json из папок files/ (всё, что копируется в папку игры) и forge/ (installer .jar)
// Запуск: npm run manifest (репозиторий берётся из src/config.js)
//
// Кроме списка файлов здесь же проверяется то, что чаще всего ломает сборку у игроков:
// две версии одного мода, файл крупнее лимита GitHub и пустая папка модов.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
let cfg = {}; try { cfg = require('./src/config'); } catch {}
const repo = process.env.GITHUB_REPOSITORY || process.argv[2] || cfg.repo;
const branch = process.env.GITHUB_REF_NAME || process.argv[3] || cfg.branch || 'main';
if (!repo) { console.error('Укажи репозиторий: npm run manifest -- логин/репо main'); process.exit(1); }
const base = `https://raw.githubusercontent.com/${repo}/${branch}/`;
const sha1 = f => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
const walk = d => !fs.existsSync(d) ? [] : fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const MB = 1048576;
const mb = n => (n / MB).toFixed(1) + ' МБ';

const FILES_DIR = path.join(__dirname, 'files');
console.log('Ищу файлы сборки в: ' + FILES_DIR);
const files = walk(FILES_DIR).filter(f => !f.endsWith('.gitkeep')).map(f => {
  const rel = path.relative(FILES_DIR, f).split(path.sep).join('/');
  return { path: rel, url: base + 'files/' + encodeURI(rel), sha1: sha1(f), size: fs.statSync(f).size };
});

// ---------- проверки, которые экономят вечер поддержки ----------
const warn = [];
const mods = files.filter(f => f.path.startsWith('mods/'));

// две версии одного мода в папке - самая частая причина «игра не запускается»
// Имя мода - это всё до первой «служебной» части: номера версии, слова forge, mc1.20.1 и так
// далее. Резать по шаблону конца строки оказалось мало: «embeddium-0.3.25+mc1.20.1.jar» и
// «embeddium-0.3.31+mc1.20.1.jar» так не сходились, и две версии одного мода проходили молча.
const STOP = new Set(['forge', 'fabric', 'neoforge', 'quilt', 'mc', 'minecraft', 'universal', 'all']);
const modKey = name => {
  const parts = name.toLowerCase().replace(/\.jar$/, '').split(/[-_+ ]+/);
  const keep = [];
  for (const p of parts) {
    if (!p) continue;
    if (/^v?\d/.test(p) || STOP.has(p) || /^mc\d/.test(p)) break;   // пошла версия - дальше не имя
    keep.push(p);
  }
  return keep.join(' ') || parts[0] || name;
};
const byName = new Map();
for (const f of mods) {
  const key = modKey(path.basename(f.path));
  byName.set(key, [...(byName.get(key) || []), path.basename(f.path)]);
}
for (const [, list] of byName) {
  if (list.length > 1) warn.push('Похоже на две версии одного мода: ' + list.join(' и '));
}

// GitHub не принимает файлы больше 100 МБ, а на 50 МБ уже ругается предупреждением
for (const f of files) {
  if (f.size > 95 * MB) warn.push(`${f.path} весит ${mb(f.size)} — GitHub такой файл не примет (предел 100 МБ)`);
  else if (f.size > 50 * MB) warn.push(`${f.path} весит ${mb(f.size)} — загрузка у игроков будет долгой`);
}

// имена с пробелами и кириллицей работают, но ломаются у части игроков в пути загрузки
for (const f of files) {
  if (/[^\x20-\x7e]/.test(f.path)) warn.push(`${f.path} — в имени есть нелатинские символы, лучше переименовать`);
  else if (/\s/.test(f.path)) warn.push(`${f.path} — в имени есть пробелы, лучше заменить на _`);
}

const fj = walk(path.join(__dirname, 'forge')).find(f => f.endsWith('.jar'));
const forge = fj ? { url: base + 'forge/' + encodeURI(path.basename(fj)), sha1: sha1(fj), size: fs.statSync(fj).size } : null;

// Дата сборки меняется, только если поменялся сам состав файлов. Иначе каждый запуск давал бы
// новый манифест и лишний коммит, а лаунчер показывал бы «вышло обновление» там, где ничего нет.
const OUT = path.join(__dirname, 'manifest.json');
let version = new Date().toISOString();
try {
  const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const same = JSON.stringify(prev.files) === JSON.stringify(files)
    && JSON.stringify(prev.forge || null) === JSON.stringify(forge);
  if (same && prev.version) version = prev.version;
} catch {}

const manifest = {
  version,
  forge,
  news: fs.existsSync(path.join(__dirname, 'news.json')) ? JSON.parse(fs.readFileSync(path.join(__dirname, 'news.json'), 'utf8')) : [],  // необязательный news.json: [{"title":"","text":"","date":""}]
  // из этих папок у игроков удаляется всё, чего нет в манифесте: так уходят старые версии модов
  // и дополнений. pointblank - папка расширений Point Blank, туда кладётся пак Counter-Strike
  clean: ['mods', 'pointblank'],
  files
};
fs.writeFileSync(OUT, JSON.stringify(manifest, null, 1));

const packs = files.filter(f => f.path.startsWith('pointblank/'));
const total = files.reduce((a, f) => a + f.size, 0);
console.log(`manifest.json: ${files.length} файлов, ${mb(total)}`);
console.log(`  моды: ${mods.length} · дополнения Point Blank: ${packs.length} · forge: ${fj ? 'да' : 'нет'}`);
if (warn.length) {
  console.log('\nОбратите внимание:');
  for (const w of warn) console.log('  • ' + w);
}
if (!mods.length) {
  console.log('\n!!! МОДЫ НЕ НАЙДЕНЫ. Положи .jar файлы строго в папку:\n    ' + path.join(FILES_DIR, 'mods')
    + '\n    (рядом с update-mods.bat должна лежать папка files, а в ней mods)');
}
