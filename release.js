// ====== Выдать обновление игрокам: собрать manifest.json и отправить его на GitHub ======
//
// Запускается из update-mods.bat. Вся работа и все сообщения живут здесь, а не в .bat, и вот
// почему: командная строка Windows читает .bat в своей кодировке и по своим переносам строк.
// Стоит файлу оказаться с переносами в стиле Unix или в неожиданной кодировке - и cmd начинает
// рвать русские строки на куски, пытаясь выполнить их как команды: 'level' is not recognized,
// 'ИБКА.' is not recognized. Node такой беды не знает, поэтому .bat сведён к четырём строкам
// латиницей, а всё остальное - тут.
const { spawnSync } = require('child_process');
const fs = require('fs'), path = require('path');

const here = __dirname;
// Запускаем без shell. С ним Windows склеивает команду в одну строку без кавычек, и путь
// «C:\Program Files\nodejs\node.exe» обрывается на пробеле: остаётся «C:\Program».
// Без shell аргументы передаются как есть, а git и node Windows находит по PATH сама.
const run = (cmd, args, opt = {}) =>
  spawnSync(cmd, args, { cwd: here, stdio: 'inherit', ...opt });
const quiet = (cmd, args) =>
  spawnSync(cmd, args, { cwd: here, encoding: 'utf8' });

/** Команда отработала успешно? При отсутствии программы status равен null, а не числу. */
const ok = r => r && !r.error && r.status === 0;

const line = s => console.log(s);
const fail = s => { console.log('\n' + s); process.exitCode = 1; };

line('=== Nexus: выдача обновления игрокам ===\n');

// 1. папки, без которых манифесту нечего собирать
for (const d of ['files/mods', 'files/pointblank']) {
  const p = path.join(here, d);
  if (!fs.existsSync(p)) { fs.mkdirSync(p, { recursive: true }); line('Создана папка ' + d); }
}

// 2. манифест: список файлов с отпечатками, по нему лаунчер и понимает, что обновилось
const man = run(process.execPath, [path.join(here, 'make-manifest.js')]);
if (!ok(man)) {
  return fail('Не удалось собрать manifest.json. Скопируйте текст выше и пришлите мне.');
}

// 3. Git: без него манифест останется лежать на этом компьютере
const git = quiet('git', ['--version']);
if (!ok(git)) {
  line('\nmanifest.json собран, но Git на компьютере не найден.');
  line('Поставьте его с git-scm.com и запустите этот файл снова,');
  line('либо отправьте вручную: GitHub Desktop -> Commit to main -> Push origin.');
  return;
}

// 4. связь с репозиторием. Её легко потерять: если распаковать лаунчер в новую папку, скрытая
// папка .git остаётся в старой, и отправлять оказывается некуда. Подключаем заново сами.
let cfg = {};
try { cfg = require('./src/config'); } catch {}
const branch = cfg.branch || 'main';

if (!fs.existsSync(path.join(here, '.git'))) {
  if (!cfg.repo) {
    line('\nmanifest.json собран, но эта папка не связана с репозиторием,');
    line('и в src/config.js не указан repo. Впишите туда "логин/репозиторий" и запустите снова.');
    return;
  }
  line(`\nПапка ещё не связана с репозиторием - подключаю к ${cfg.repo} (ветка ${branch}).`);
  run('git', ['init', '-b', branch]);
  run('git', ['remote', 'add', 'origin', `https://github.com/${cfg.repo}.git`]);
  // Подтягиваем историю репозитория, не трогая файлы на диске: иначе отправка уйдёт в отказ.
  // Именно run, а не quiet: GitHub в этот момент может попросить вход в браузере, а молчаливая
  // команда спросить не может - и репозиторий с историей ошибочно считается пустым.
  line('Проверяю, что уже лежит в репозитории (может потребоваться вход в браузере)…');
  if (ok(run('git', ['fetch', 'origin', branch]))) {
    run('git', ['reset', '--soft', 'FETCH_HEAD']);
    line('История репозитория подхвачена, файлы на диске не тронуты.');
  } else {
    line('Репозиторий пока пуст или недоступен - отправим как первую загрузку.');
  }
}

// Свежий Git не знает, кем подписывать изменения, и отказывается делать коммит:
// «Author identity unknown». Прописываем подпись только для этой папки (без --global),
// чтобы не трогать остальные проекты на компьютере.
if (!ok(quiet('git', ['config', 'user.email']))) {
  // владелец из «логин/репозиторий»; если там что-то необычное - подпись всё равно нужна
  const owner = (String(cfg.repo || '').split('/').filter(Boolean)[0] || 'nexus')
    .replace(/[^A-Za-z0-9._-]/g, '') || 'nexus';
  run('git', ['config', 'user.name', owner]);
  run('git', ['config', 'user.email', `${owner}@users.noreply.github.com`]);
  line(`\nПодпись для коммитов не была задана - поставил ${owner} <${owner}@users.noreply.github.com>.`);
  line('Поменять: git config user.name "Имя" и git config user.email "почта" в этой папке.');
}

run('git', ['add', '-A']);
const staged = quiet('git', ['diff', '--cached', '--name-status']);
const changed = String(staged.stdout || '').trim().split('\n').filter(Boolean)
  .map(l => { const [st, ...rest] = l.split('\t'); return { st: st[0], file: rest.join(' ') }; });
if (!changed.length) {
  line('\nИзменений нет - отправлять нечего. Сборка у игроков уже свежая.');
  return;
}

// показываем удаления отдельно: по ним видно, если случайно пропали нужные моды
const mark = { A: '+ добавлен ', M: '~ изменён  ', D: '- УДАЛЁН   ' };
const gone = changed.filter(c => c.st === 'D');
line(`\nК отправке ${changed.length} файлов:`);
for (const c of changed.slice(0, 15)) line('  ' + (mark[c.st] || '  ' + c.st + '        ') + c.file);
if (changed.length > 15) line(`  и ещё ${changed.length - 15}`);
if (gone.length) {
  line(`\nВнимание: ${gone.length} файлов удаляется из репозитория.`);
  line('Если среди них нужные моды - закройте окно, верните файлы в files\\mods и запустите снова.');
}

const stamp = new Date().toLocaleString('ru-RU');
if (!ok(run('git', ['commit', '-m', 'Обновление сборки ' + stamp]))) {
  return fail('Не удалось сохранить изменения в Git. Скопируйте текст выше и пришлите мне.');
}
// у свежесозданной ветки нет привязки к удалённой - тогда указываем её явно
const tracked = ok(quiet('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']));
const pushArgs = tracked ? ['push'] : ['push', '-u', 'origin', branch];

if (!ok(run('git', pushArgs))) {
  // Отказ «fetch first»: в репозитории есть изменения, которых нет у нас. Так бывает, когда
  // папку подключили заново, а историю подтянуть не вышло. Чиним сами: берём историю
  // репозитория, ставим поверх неё своё состояние папки и отправляем ещё раз.
  line('\nОтправку отклонили: в репозитории есть то, чего нет здесь.');
  line('Беру его историю и накладываю на неё содержимое этой папки…');

  if (!ok(run('git', ['fetch', 'origin', branch]))) {
    return fail('Не удалось прочитать репозиторий. Проверьте интернет и вход в GitHub,\n'
      + 'затем запустите этот файл ещё раз.');
  }
  run('git', ['reset', '--soft', `origin/${branch}`]);
  run('git', ['add', '-A']);

  const after = quiet('git', ['diff', '--cached', '--name-status']);
  const rows = String(after.stdout || '').trim().split('\n').filter(Boolean)
    .map(l => { const [st, ...rest] = l.split('\t'); return { st: st[0], file: rest.join(' ') }; });
  const drop = rows.filter(r => r.st === 'D');
  if (drop.length) {
    line(`\nИз репозитория пропадёт ${drop.length} файлов - их нет в этой папке:`);
    for (const d of drop.slice(0, 10)) line('  - ' + d.file);
    if (drop.length > 10) line(`  и ещё ${drop.length - 10}`);
  }
  if (!rows.length) {
    line('\nСодержимое совпало с репозиторием - отправлять нечего.');
    return;
  }
  if (!ok(run('git', ['commit', '-m', 'Обновление сборки ' + stamp]))) {
    return fail('Не удалось сохранить изменения. Скопируйте текст выше и пришлите мне.');
  }
  if (!ok(run('git', ['push', '-u', 'origin', branch]))) {
    return fail('Не удалось отправить на GitHub.\n'
      + 'Чаще всего это вход в аккаунт или нет связи. Попробуйте ещё раз\n'
      + 'или отправьте через GitHub Desktop: Push origin.');
  }
}

line('\nГОТОВО. Игроки получат обновление при следующем запуске лаунчера');
line('или сразу - кнопкой "Обновить сборку" на вкладке "Сборка".');
line('\nЕсли меняли моды или дополнение Point Blank - положите те же файлы');
line('на сервер через панель хостинга, иначе игроков будет выкидывать при входе.');
