// ====== Обновление сборки: проверка файлов и загрузка с запасными зеркалами ======
//
// Чем это отличается от прежней проверки «скачал — сверил — упал»:
//
// 1. Ссылки с отпечатком. GitHub раздаёт файлы через кеш, и сразу после загрузки новой версии
//    мода часть игроков ещё какое-то время получает старые байты. Манифест при этом уже новый,
//    sha1 не сходится - и лаунчер объявлял файл «повреждённым», сколько бы раз его ни качал.
//    Теперь к каждой ссылке дописывается отпечаток содержимого: меняется файл - меняется ссылка,
//    и кешу нечего отдать взамен.
// 2. Зеркала. Если GitHub отвечает ошибкой, молчит или отдаёт не то, файл берётся с jsDelivr или
//    githack - это те же файлы того же репозитория, только через другую сеть доставки.
// 3. Память о проверенных файлах. Считать sha1 всей сборки при каждом запуске - это читать сотни
//    мегабайт с диска. Отпечатки запоминаются вместе с размером и временем изменения файла и
//    пересчитываются только у тех, что поменялись.
// 4. Понятные отказы. Занятый файл, нехватка места и обрыв связи различаются и объясняются
//    словами, а не кодом ошибки.
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const MB = 1048576;
/** Выше этого размера jsDelivr файлы не раздаёт - туда и не обращаемся. */
const JSDELIVR_LIMIT = 20 * MB;
/** Сколько файлов качаем одновременно. Больше - GitHub начинает придерживать соединения. */
const PARALLEL = 3;
/** Сколько раз пробуем один файл, перебирая зеркала. */
const ATTEMPTS = 4;

function createUpdater(ctx) {
  const { root, cfg, log, progress, download, safe, walk } = ctx;
  const CACHE_FILE = path.join(root, 'launcher-hashes.json');

  // ---------- память об отпечатках ----------
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) || {}; } catch { cache = {}; }
  let cacheDirty = false;
  const saveCache = () => {
    if (!cacheDirty) return;
    try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); cacheDirty = false; } catch { }
  };

  const sha1File = f => new Promise(res => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(f).on('data', d => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', () => res(null));
  });

  /** Отпечаток файла. Пересчитываем только если размер или время изменения не те, что помним. */
  async function hashOf(file) {
    let st;
    try { st = fs.statSync(file); } catch { return null; }
    const key = file;
    const known = cache[key];
    if (known && known.size === st.size && known.mtime === Math.round(st.mtimeMs)) return known.sha1;
    const sum = await sha1File(file);
    if (sum) { cache[key] = { size: st.size, mtime: Math.round(st.mtimeMs), sha1: sum }; cacheDirty = true; }
    return sum;
  }

  /** Забыть отпечаток - после того как файл перезаписан. */
  const forget = file => { if (cache[file]) { delete cache[file]; cacheDirty = true; } };

  // ---------- где взять файл ----------
  /**
   * Ссылки на один файл по порядку надёжности.
   * Первая - прямая, с отпечатком в запросе; дальше две сети доставки на случай, если GitHub
   * недоступен (у части игроков он открывается через раз).
   */
  function sources(f) {
    const stamp = (f.sha1 || '').slice(0, 10) || Date.now().toString(36);
    const rel = f.path.split('/').map(encodeURIComponent).join('/');
    const out = [`${f.url}${f.url.includes('?') ? '&' : '?'}v=${stamp}`];
    const repo = cfg.repo, branch = cfg.branch || 'main';
    if (repo) {
      if ((f.size || 0) < JSDELIVR_LIMIT) out.push(`https://cdn.jsdelivr.net/gh/${repo}@${branch}/files/${rel}`);
      out.push(`https://raw.githack.com/${repo}/${branch}/files/${rel}`);
    }
    return out;
  }

  // ---------- проверка ----------
  /**
   * Что не так со сборкой: чего не хватает, что побилось, что лишнее.
   * onStep зовётся по ходу - чтобы в окне было видно, что лаунчер не завис на большой сборке.
   */
  async function verify(m, onStep) {
    const missing = [], corrupt = [], want = new Set();
    let i = 0;
    for (const f of m.files) {
      const dest = safe(f.path);
      want.add(dest);
      if (!fs.existsSync(dest)) missing.push(f);
      else if ((await hashOf(dest)) !== f.sha1) corrupt.push(f);
      if (onStep && ++i % 10 === 0) onStep(i, m.files.length);
    }
    const extra = [];
    for (const dir of m.clean || []) {
      for (const f of walk(safe(dir))) {
        if (!want.has(f) && !f.endsWith('.part')) extra.push(f);
      }
    }
    saveCache();
    return { missing, corrupt, extra, total: m.files.length };
  }

  // ---------- загрузка одного файла ----------
  const human = n => n >= MB ? (n / MB).toFixed(1) + ' МБ' : Math.max(1, Math.round(n / 1024)) + ' КБ';

  /**
   * Заменить файл, переждав, если он занят.
   * На Windows открытый игрой .jar переименованием не перебить: система отвечает EBUSY.
   * Несколько коротких пауз спасают, когда игра как раз закрывается; если нет - говорим прямо,
   * что нужно выйти из Minecraft, а не показываем код ошибки.
   */
  async function replaceFile(tmp, dest) {
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, dest); return; } catch (e) {
        const busy = e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES';
        if (!busy || i >= 5) {
          if (busy) throw new Error(`Файл занят: ${path.basename(dest)}. Закройте Minecraft и повторите обновление.`);
          throw e;
        }
        await new Promise(r => setTimeout(r, 300));
      }
    }
  }

  /**
   * Скачать файл, перебирая зеркала, пока отпечаток не сойдётся.
   * Сначала пробуем прямую ссылку, дальше - зеркала; несовпадение отпечатка считается такой же
   * неудачей, как обрыв связи, и ведёт к следующему источнику, а не к отказу.
   */
  async function fetchOne(f, onBytes) {
    const dest = safe(f.path);
    const urls = sources(f);
    const errors = [];
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const url = urls[Math.min(attempt, urls.length - 1)];
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const tmp = dest + '.part';
        fs.rmSync(tmp, { force: true });
        await download(url, tmp, onBytes);
        if (f.sha1) {
          const got = await sha1File(tmp);
          if (got !== f.sha1) {
            fs.rmSync(tmp, { force: true });
            throw new Error(`отпечаток не совпал (${String(got).slice(0, 8)} вместо ${f.sha1.slice(0, 8)})`);
          }
        }
        forget(dest);
        await replaceFile(tmp, dest);
        await hashOf(dest);                       // сразу запомним - при следующем запуске не считать
        log(`обновлён ${f.path} (${human(f.size || 0)}) через ${new URL(url).host}`);
        return;
      } catch (e) {
        errors.push(`${new URL(url).host}: ${e.message}`);
        log(`ошибка загрузки ${f.path} — ${e.message}`);
        if (attempt < ATTEMPTS - 1) await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    throw new Error(`Не удалось скачать ${path.basename(f.path)}.\n` + errors.join('\n'));
  }

  // ---------- место на диске ----------
  function checkSpace(bytes) {
    try {
      const st = fs.statfsSync(root);
      const free = st.bavail * st.bsize;
      if (free < bytes + 300 * MB) {
        throw new Error(`Мало места на диске: нужно ${human(bytes)}, свободно ${human(free)}. `
          + 'Освободите место и повторите.');
      }
    } catch (e) { if (/Мало места/.test(e.message)) throw e; }   // statfs не везде есть - тогда просто пропускаем
  }

  // ---------- полная синхронизация ----------
  /**
   * Привести сборку к манифесту. Возвращает отчёт: что добавлено, обновлено и удалено -
   * его показывает окно, чтобы игрок видел, что именно поменялось.
   */
  async function sync(m) {
    progress('Проверка файлов сборки…', 2);
    const v = await verify(m, (i, n) => progress(`Проверка файлов: ${i} из ${n}`, 2 + i / n * 8));

    const jobs = [...v.missing, ...v.corrupt];
    const bytes = jobs.reduce((s, f) => s + (f.size || 0), 0);
    if (!jobs.length && !v.extra.length) {
      progress('Сборка в порядке', 100);
      return { added: [], updated: [], removed: [], bytes: 0 };
    }
    if (bytes) checkSpace(bytes);

    const t0 = Date.now();
    let done = 0, i = 0;
    const tick = name => {
      const sec = Math.max(0.3, (Date.now() - t0) / 1000);
      const speed = done / sec;
      const left = Math.max(0, bytes - done);
      const eta = speed > 0 ? Math.round(left / speed) : 0;
      const pct = bytes ? 10 + done / bytes * 88 : 98;
      progress(`${name} · ${human(done)} из ${human(bytes)} · ${human(speed)}/с`
        + (eta > 2 ? ` · осталось ~${eta < 60 ? eta + ' с' : Math.ceil(eta / 60) + ' мин'}` : ''), pct);
    };

    const worker = async () => {
      while (i < jobs.length) {
        const f = jobs[i++];
        const name = path.basename(f.path);
        tick(name);
        await fetchOne(f, n => { done += n; tick(name); });
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, jobs.length) }, worker));

    const removed = [];
    for (const f of v.extra) {
      try { fs.rmSync(f, { force: true }); forget(f); removed.push(path.basename(f)); log(`удалён лишний ${f}`); }
      catch (e) { log(`не удалось удалить ${f}: ${e.message}`); }
    }
    saveCache();
    progress('Сборка обновлена', 100);
    return {
      added: v.missing.map(f => path.basename(f.path)),
      updated: v.corrupt.map(f => path.basename(f.path)),
      removed, bytes
    };
  }

  /** Убрать недокачанные хвосты, оставшиеся от прерванного обновления. */
  function cleanParts(dirs) {
    for (const d of dirs || []) {
      for (const f of walk(safe(d))) if (f.endsWith('.part')) fs.rmSync(f, { force: true });
    }
  }

  return { verify, sync, hashOf, sources, cleanParts, saveCache, human };
}

module.exports = { createUpdater };
