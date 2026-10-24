const { app, BrowserWindow, ipcMain, shell, clipboard, Tray, Menu, nativeImage } = require('electron');
const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto');
const { execFile } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { Client } = require('minecraft-launcher-core');
const { Auth } = require('msmc');
const mcutil = require('minecraft-server-util');
const extract = require('extract-zip');
const cfg = require('./config');
const DiscordRPC = require('./discord');
const { createUpdater } = require('./updater');

const ROOT = path.join(app.getPath('appData'), '.nexus-scp');
const SETTINGS_FILE = path.join(ROOT, 'launcher.json');
const LOG_FILE = path.join(ROOT, 'logs', 'launcher.log');
const RUNTIME = path.join(ROOT, 'runtime');
const FORGE_DEFAULT = path.join(ROOT, 'forge', 'installer.jar');
let forgeJar = FORGE_DEFAULT;
const MANIFEST_URL = () => `https://raw.githubusercontent.com/${cfg.repo}/${cfg.branch}/manifest.json?t=${Date.now()}`;

let win, game = null, busy = false;
let settings = { ram: cfg.defaultRam, token: null, name: null, autoConnect: false, hideOnLaunch: true, fullscreen: false, jvmArgs: '', offline: [], discordRpc: true };

fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch {}
// однократный сброс: раньше игра по умолчанию сразу заходила на сервер, теперь — обычное меню Minecraft
if (settings.menuV2 !== true) { settings.autoConnect = false; settings.menuV2 = true; }
const saveSettings = () => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings));
const log = m => fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] ${m}\n`, () => {});
const send = (ch, d) => win && !win.isDestroyed() && win.webContents.send(ch, d);
const progress = (label, pct) => send('progress', { label, pct });

if (!app.requestSingleInstanceLock()) app.quit();
let tray = null, quitting = false;
const showWin = () => { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); };
app.on('second-instance', showWin);           // повторный запуск ярлыка просто открывает уже работающий лаунчер
app.on('before-quit', () => { quitting = true; });

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 720, minWidth: 1000, minHeight: 620, frame: false,
    backgroundColor: '#05030f', icon: path.join(__dirname, 'assets/icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer/index.html'));

  // состояние окна -> интерфейс (меняет значки кнопок)
  const st = () => send('win:state', { max: win.isMaximized(), full: win.isFullScreen() });
  ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'].forEach(e => win.on(e, st));
  win.webContents.on('did-finish-load', st);

  // ошибки страницы пишем в лог (%APPDATA%\.nexus-scp\logs\launcher.log) — удобно искать причину «не работает ввод»
  win.webContents.on('console-message', (_e, level, msg, line, src) => { if (level >= 2) log(`[renderer] ${msg} (${path.basename(String(src))}:${line})`); });
  win.webContents.on('render-process-gone', (_e, d) => log('[renderer] gone: ' + d.reason));
  win.on('unresponsive', () => log('[window] unresponsive'));

  ['focus', 'show', 'restore', 'leave-full-screen', 'enter-full-screen'].forEach(e => win.on(e, () => setTimeout(() => win && !win.isDestroyed() && win.webContents.focus(), 50)));

  // пока игра запущена, закрытие лаунчера прячет его в трей (а не убивает), вернуть — клик по значку в трее
  win.on('close', e => { if (game && !quitting) { e.preventDefault(); win.hide(); } });

  if (!tray) {
    const img = nativeImage.createFromPath(path.join(__dirname, 'assets/icon.png')).resize({ width: 16, height: 16 });
    tray = new Tray(img); tray.setToolTip(cfg.name);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Открыть лаунчер', click: showWin },
      { label: 'Полный экран (F11)', click: () => { showWin(); win.setFullScreen(!win.isFullScreen()); } },
      { type: 'separator' },
      { label: 'Выход', click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on('click', () => (win.isVisible() && !win.isMinimized() ? win.hide() : showWin()));
  }
}
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

// ---------- вспомогательное ----------
const fetchT = (url, ms = 10000, opt = {}) => fetch(url, { ...opt, signal: AbortSignal.timeout(ms) });
const sha1 = f => new Promise(res => {
  const h = crypto.createHash('sha1');
  fs.createReadStream(f).on('data', d => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', () => res(null));
});
const walk = d => !fs.existsSync(d) ? [] : fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const safe = rel => { const p = path.resolve(ROOT, rel); if (!p.startsWith(ROOT + path.sep)) throw new Error('Недопустимый путь: ' + rel); return p; };

// Надёжная загрузка: без Readable.fromWeb (на Node 20 из Electron он портит файл — лишний кусок 16 КБ в конце),
// с проверкой размера и таймаутом только на «зависание», а не на всё скачивание
async function download(url, dest, onBytes, stallMs = 60000) {
  const ac = new AbortController();
  let timer; const kick = () => { clearTimeout(timer); timer = setTimeout(() => ac.abort(), stallMs); };
  kick();
  const tmp = dest + '.part';
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'follow', headers: { 'User-Agent': 'NexusLauncher/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const out = fs.createWriteStream(tmp);
    const failed = new Promise((_, bad) => out.on('error', bad)); failed.catch(() => {});
    const finished = new Promise(ok => out.on('finish', ok));
    const reader = res.body.getReader();
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      kick(); n += value.length;
      if (!out.write(value)) await Promise.race([new Promise(r => out.once('drain', r)), failed]);
      onBytes && onBytes(value.length);
    }
    out.end(); await Promise.race([finished, failed]);
    const want = +res.headers.get('content-length') || 0;
    if (want && !res.headers.get('content-encoding') && n !== want) throw new Error(`обрыв загрузки: ${n} из ${want} байт — ${url}`);
    fs.renameSync(tmp, dest);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw ac.signal.aborted ? new Error('таймаут соединения — ' + url) : e;
  } finally { clearTimeout(timer); }
}

async function getManifest() {
  const res = await fetchT(MANIFEST_URL());
  if (!res.ok) throw new Error(`Манифест недоступен (HTTP ${res.status}). Проверь repo/branch в config.js`);
  return res.json();
}

// ---------- проверка файлов и обновление сборки ----------
// Вся работа с файлами сборки - в src/updater.js: там отпечатки, зеркала и повторы.
const updater = createUpdater({ root: ROOT, cfg, log, progress, download, safe, walk });
const verify = m => updater.verify(m);

/** Последний отчёт об обновлении - его показывает окно после «Играть». */
let lastReport = null;

async function sync() {
  progress('Проверка обновлений…', 0);
  const m = await getManifest();
  updater.cleanParts(m.clean || []);
  const report = await updater.sync(m);
  await ensureForge(m);
  lastReport = { ...report, version: m.version, at: Date.now() };
  send('sync:report', lastReport);
  return { updated: report.added.length + report.updated.length, removed: report.removed.length };
}

// ---------- Forge (автоскачивание с официального maven) ----------
async function resolveForge() {
  if (cfg.forgeVersion && cfg.forgeVersion !== 'auto') return cfg.forgeVersion;
  try {
    const r = await fetchT('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
    const p = (await r.json()).promos;
    return p[`${cfg.mcVersion}-recommended`] || p[`${cfg.mcVersion}-latest`];
  } catch { return '47.4.0'; }
}
async function forgeTarget(m) {
  if (m && m.forge) return { file: FORGE_DEFAULT, url: m.forge.url, sha1: m.forge.sha1, label: 'из manifest' };
  const v = await resolveForge(), slug = `${cfg.mcVersion}-${v}`;
  return { file: path.join(ROOT, 'forge', `forge-${slug}-installer.jar`), label: `Forge ${v}`,
    url: `https://maven.minecraftforge.net/net/minecraftforge/forge/${slug}/forge-${slug}-installer.jar` };
}
async function ensureForge(m) {
  const t = await forgeTarget(m);
  const okFile = fs.existsSync(t.file) && (!t.sha1 || (await sha1(t.file)) === t.sha1);
  if (!okFile) { progress(`Загрузка ${t.label}…`, 0); await download(t.url, t.file, () => {}); log('forge downloaded ' + t.file); }
  forgeJar = t.file;
}

// ---------- Java ----------
function localJava() {
  if (!fs.existsSync(RUNTIME)) return null;
  for (const d of fs.readdirSync(RUNTIME, { withFileTypes: true })) {
    const j = path.join(RUNTIME, d.name, 'bin', 'javaw.exe');
    if (d.isDirectory() && fs.existsSync(j)) return j;
  }
  return null;
}
const systemJava = () => new Promise(res => execFile('java', ['-version'], (e, so, se) => {
  const v = /version "(\d+)/.exec(String(se)); res(e || !v ? null : +v[1]);
}));
async function findJava() {
  const l = localJava(); if (l) return { path: l, label: 'Встроенная Java 17' };
  const v = await systemJava(); if (v >= 17 && v <= 21) return { path: 'java', label: `Системная Java ${v}` };
  return null;
}
// Список источников Java 17 (по порядку; если один недоступен — берётся следующий)
const JAVA_SOURCES = [
  async () => 'https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jre/hotspot/normal/eclipse',
  async () => {
    const r = await fetchT('https://api.azul.com/metadata/v1/zulu/packages/?java_version=17&os=windows&arch=x64&archive_type=zip&java_package_type=jre&latest=true&release_status=ga&availability_types=CA&page=1&page_size=1', 15000);
    const j = await r.json(); if (!j[0] || !j[0].download_url) throw new Error('нет ссылки'); return j[0].download_url;
  },
  async () => 'https://aka.ms/download-jdk/microsoft-jdk-17-windows-x64.zip',
  async () => 'https://corretto.aws/downloads/latest/amazon-corretto-17-x64-windows-jdk.zip'
];

async function ensureJava() {
  const found = await findJava(); if (found) return found.path;
  fs.mkdirSync(RUNTIME, { recursive: true });
  const zip = path.join(RUNTIME, 'jre17.zip');
  const errors = [];
  for (const [idx, getUrl] of JAVA_SOURCES.entries()) {
    try {
      const url = await getUrl();
      log(`java: источник ${idx + 1}: ${url}`);
      let got = 0;
      await download(url, zip, n => { got += n; progress(`Загрузка Java 17: ${(got / 1048576).toFixed(0)} МБ`, 50); });
      if (fs.statSync(zip).size < 20 * 1048576) throw new Error('файл слишком мал (повреждён)');
      progress('Распаковка Java…', 90);
      await extract(zip, { dir: RUNTIME });
      fs.rmSync(zip, { force: true });
      const j = localJava(); if (!j) throw new Error('в архиве нет javaw.exe');
      log('java установлена: ' + j);
      return j;
    } catch (e) {
      errors.push(`#${idx + 1}: ${e.message}`);
      log(`java: источник ${idx + 1} не сработал — ${e.message}`);
      fs.rmSync(zip, { force: true });
    }
  }
  throw new Error('Не удалось скачать Java 17 (' + errors.join('; ') + '). Проверь интернет/VPN/антивирус.');
}

// ---------- авторизация: Microsoft / Ely.by / Офлайн ----------
const ELY = 'https://authserver.ely.by';
const PROVIDER_NAME = { microsoft: 'Microsoft', ely: 'Ely.by', offline: 'Офлайн' };
let account = null; // { name, provider, auth: () => объект authorization для MCLC }
const who = () => ({ name: account.name, provider: account.provider });

// ----- Ely.by -----
const ELY_NET = 'Нет связи с Ely.by — проверьте интернет или VPN';
async function elyCall(endpoint, body) {
  let r;
  try { r = await fetchT(ELY + endpoint, 15000, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  catch (e) { log(`ely ${endpoint}: сеть — ${e.message}`); throw new Error(ELY_NET); }
  let j = {}; try { j = JSON.parse(await r.text()); } catch {}
  log(`ely ${endpoint}: HTTP ${r.status}${j.errorMessage ? ' — ' + j.errorMessage : ''}`);
  return { ok: r.ok, status: r.status, j };
}
const elyAuth = e => ({ access_token: e.accessToken, client_token: e.clientToken, uuid: e.uuid, name: e.name, user_properties: '{}', meta: { type: 'mojang', demo: false } });
function elyError(r, hadCode) {
  const m = String(r.j.errorMessage || r.j.error || '');
  if (/two.?factor|2fa/i.test(m)) return new Error(hadCode ? 'Неверный код двухфакторной защиты' : 'NEED_2FA');
  if (r.status === 429 || /too many|rate/i.test(m)) return new Error('Слишком много попыток — подождите пару минут');
  if (/suspend|banned|block/i.test(m)) return new Error('Аккаунт Ely.by заблокирован');
  if (r.status === 401 || r.status === 403) return new Error(hadCode ? 'Неверный ник/email, пароль или код' : 'Неверный ник/email или пароль Ely.by');
  return new Error(`Ely.by вернул ошибку ${r.status || ''} ${m}`.trim());
}
ipcMain.handle('auth:ely', async (_, { login, password, code }) => {
  login = String(login || '').trim(); password = String(password || ''); code = String(code || '').replace(/\s+/g, '');
  if (!login || !password) throw new Error('Введите ник/email и пароль');
  const clientToken = (settings.ely && settings.ely.clientToken) || crypto.randomUUID();
  const r = await elyCall('/auth/authenticate', { username: login, password: code ? `${password}:${code}` : password, clientToken, requestUser: false });
  if (!r.ok) throw elyError(r, !!code);
  const p = r.j.selectedProfile || (r.j.availableProfiles || [])[0];
  if (!p || !r.j.accessToken) throw new Error('У аккаунта Ely.by нет профиля Minecraft');
  settings.ely = { accessToken: r.j.accessToken, clientToken: r.j.clientToken || clientToken, uuid: p.id, name: p.name };
  Object.assign(settings, { provider: 'ely', token: null, name: p.name }); saveSettings();
  account = { name: p.name, provider: 'ely', auth: () => elyAuth(settings.ely) };
  return who();
});
async function refreshEly() {
  const e = settings.ely;
  try {
    const v = await elyCall('/auth/validate', { accessToken: e.accessToken });
    if (!v.ok) {
      const r = await elyCall('/auth/refresh', { accessToken: e.accessToken, clientToken: e.clientToken });
      if (!r.ok) throw new Error('Сессия Ely.by истекла — войдите заново');
      e.accessToken = r.j.accessToken; if (r.j.clientToken) e.clientToken = r.j.clientToken;
      if (r.j.selectedProfile) { e.uuid = r.j.selectedProfile.id; e.name = r.j.selectedProfile.name; }
      saveSettings();
    }
  } catch (err) { if (err.message !== ELY_NET) throw err; } // нет сети — не выкидываем из аккаунта
  return (account = { name: e.name, provider: 'ely', auth: () => elyAuth(e) });
}

// ----- Офлайн (локальные аккаунты с паролем, хранятся только на этом компьютере) -----
const OFFLINE_NAME = /^[A-Za-z0-9_]{3,16}$/;
const offlineUuid = name => { const h = crypto.createHash('md5').update('OfflinePlayer:' + name).digest(); h[6] = (h[6] & 0x0f) | 0x30; h[8] = (h[8] & 0x3f) | 0x80; return h.toString('hex'); };
const offlineAuth = a => ({ access_token: a.uuid, client_token: a.uuid, uuid: a.uuid, name: a.name, user_properties: '{}', meta: { type: 'mojang', demo: false } });
const passHash = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
const findOffline = n => (settings.offline || []).find(a => a.name.toLowerCase() === String(n || '').toLowerCase());
function loginOffline(rec) {
  Object.assign(settings, { provider: 'offline', token: null, ely: null, name: rec.name }); saveSettings();
  account = { name: rec.name, provider: 'offline', auth: () => offlineAuth(rec) };
  return who();
}
ipcMain.handle('auth:offline:list', () => (settings.offline || []).map(a => a.name));
ipcMain.handle('auth:offline:register', (_, { name, password }) => {
  name = String(name || '').trim();
  if (!OFFLINE_NAME.test(name)) throw new Error('Ник: 3–16 символов, латиница, цифры и _');
  if (String(password || '').length < 4) throw new Error('Пароль — минимум 4 символа');
  if (findOffline(name)) throw new Error('Такой ник уже зарегистрирован на этом компьютере — войдите');
  const salt = crypto.randomBytes(16).toString('hex');
  const rec = { name, uuid: offlineUuid(name), salt, hash: passHash(password, salt), created: Date.now() };
  settings.offline = [...(settings.offline || []), rec];
  return loginOffline(rec);
});
ipcMain.handle('auth:offline:login', (_, { name, password }) => {
  const rec = findOffline(String(name || '').trim());
  const ok = rec && crypto.timingSafeEqual(Buffer.from(passHash(password, rec.salt), 'hex'), Buffer.from(rec.hash, 'hex'));
  if (!ok) throw new Error('Неверный ник или пароль');
  return loginOffline(rec);
});

// ----- Microsoft -----
ipcMain.handle('auth:login', async () => {
  const am = new Auth('select_account');
  const xbox = await am.launch('electron');
  const mc = await xbox.getMinecraft();
  Object.assign(settings, { token: xbox.save(), name: mc.profile.name, provider: 'microsoft', ely: null }); saveSettings();
  account = { name: mc.profile.name, provider: 'microsoft', auth: () => mc.mclc() };
  return who();
});

// ----- общее -----
async function refreshAccount() {
  if (settings.provider === 'offline') {
    const rec = findOffline(settings.name); if (!rec) throw new Error('Офлайн-аккаунт не найден — войдите заново');
    return (account = { name: rec.name, provider: 'offline', auth: () => offlineAuth(rec) });
  }
  if (settings.provider === 'ely' && settings.ely) return refreshEly();
  const am = new Auth('select_account');
  const xbox = await am.refresh(settings.token);
  const mc = await xbox.getMinecraft();
  settings.token = xbox.save(); settings.name = mc.profile.name; settings.provider = 'microsoft'; saveSettings();
  return (account = { name: mc.profile.name, provider: 'microsoft', auth: () => mc.mclc() });
}
ipcMain.handle('auth:restore', async () => {
  if (!settings.token && !settings.ely && settings.provider !== 'offline') return null;
  try { await refreshAccount(); return who(); } catch (e) { log('restore failed ' + e.message); return null; }
});
ipcMain.handle('auth:logout', () => { Object.assign(settings, { token: null, name: null, provider: null, ely: null }); account = null; saveSettings(); });

async function ensureAuthlib() {
  const jar = path.join(RUNTIME, 'authlib-injector.jar');
  if (fs.existsSync(jar)) return jar;
  progress('Загрузка authlib-injector (Ely.by)…', 0);
  const metas = ['https://authlib-injector.yushi.moe/artifact/latest.json', 'https://bmclapi2.bangbang93.com/mirrors/authlib-injector/artifact/latest.json'];
  const errs = [];
  for (const m of metas) {
    try {
      const meta = await (await fetchT(m, 15000)).json();
      await download(meta.download_url, jar, () => {});
      if (fs.statSync(jar).size < 20000) throw new Error('файл повреждён');
      return jar;
    } catch (e) { errs.push(e.message); fs.rmSync(jar, { force: true }); log('authlib-injector: ' + e.message); }
  }
  throw new Error('Не удалось скачать authlib-injector для Ely.by (' + errs.join('; ') + ')');
}

// ---------- сервер ----------
ipcMain.handle('server:status', async () => {
  try {
    const r = await mcutil.status(cfg.server.host, cfg.server.port, { timeout: 4000 });
    return { online: true, players: r.players.online, max: r.players.max, ping: r.roundTripLatency,
      names: (r.players.sample || []).map(p => p.name).filter(n => n && !/^§|^\s*$/.test(n)).slice(0, 6) };
  } catch { return { online: false }; }
});

// ---------- Discord: «Играет в Nexus» ----------
const rpc = new DiscordRPC(cfg.discordClientId, log);
const rpcLinks = [['Наш Discord', cfg.links && cfg.links.discord], ['Сайт', cfg.links && cfg.links.site], ['Telegram', cfg.links && cfg.links.telegram]]
  .filter(([, u]) => /^https:\/\//.test(u || '')).slice(0, 2).map(([label, url]) => ({ label, url }));
let playingSince = null;
function presence(phase) {
  if (!cfg.discordClientId || !settings.discordRpc) return;
  const base = { assets: { large_image: 'logo', large_text: cfg.name }, ...(rpcLinks.length ? { buttons: rpcLinks } : {}) };
  const loader = cfg.loader === 'forge' ? 'Forge' : cfg.loader;
  if (phase === 'playing') { playingSince = playingSince || Date.now(); rpc.setActivity({ ...base, details: ((cfg.discordPlaying || {}).details) || cfg.name, state: ((cfg.discordPlaying || {}).state) || `Играет на ${cfg.name}`, timestamps: { start: playingSince } }); }
  else if (phase === 'launching') rpc.setActivity({ ...base, details: `Запускает ${cfg.name}`, state: 'Подготовка файлов…' });
  else { playingSince = null; rpc.setActivity({ ...base, details: `В лаунчере ${cfg.name}`, state: 'Готовится к игре' }); }
}
const rpcApply = () => { if (cfg.discordClientId && settings.discordRpc) { rpc.start(); presence(game ? 'playing' : 'idle'); } else rpc.stop(); };
app.whenReady().then(rpcApply);
app.on('before-quit', () => rpc.stop());

// ---------- запуск ----------
ipcMain.handle('game:play', async () => {
  if (busy) return; busy = true;
  presence('launching');
  try {
    if (!settings.token && !settings.ely && settings.provider !== 'offline') throw new Error('Сначала войдите в аккаунт');
    await refreshAccount();
    await sync();
    const javaPath = await ensureJava();
    const extra = String(settings.jvmArgs || '').split(/\s+/).filter(a => a.startsWith('-'));
    const customArgs = [...(account.provider === 'ely' ? [`-javaagent:${await ensureAuthlib()}=${ELY}/api/authlib-injector`] : []), ...extra];
    const launcher = new Client();
    launcher.on('progress', e => progress(`Загрузка ${e.type}`, e.total ? e.task / e.total * 100 : 0));
    launcher.on('data', l => log(String(l).trim()));
    launcher.on('debug', l => log('[dbg] ' + l));
    launcher.on('package-extract', () => progress('Распаковка…', 100));
    launcher.on('close', code => { game = null; presence('idle'); win.show(); send('game:closed', code); log('game exit ' + code); });
    progress('Запуск игры…', 100);
    game = await launcher.launch({
      authorization: account.auth(), root: ROOT, javaPath, customArgs,
      version: { number: cfg.mcVersion, type: 'release' },
      forge: forgeJar,
      memory: { max: `${settings.ram}G`, min: '2G' },
      quickPlay: settings.autoConnect ? { type: 'multiplayer', identifier: `${cfg.server.host}:${cfg.server.port}` } : undefined,
      window: settings.fullscreen ? { fullscreen: true } : undefined
    });
    if (!game) throw new Error('Игра не запустилась — смотрите Диагностику и логи');
    presence('playing');
    if (settings.hideOnLaunch) setTimeout(() => win.minimize(), 4000);
    return true;
  } catch (e) { presence('idle'); throw e; } finally { busy = false; }
});

ipcMain.handle('game:repair', async () => { await sync(); await ensureJava(); return true; });

// ---------- ДИАГНОСТИКА ----------
const rus = (ok, warn) => (ok ? 'ok' : warn ? 'warn' : 'fail');
async function runDiagnostics() {
  const out = [];
  const add = async (id, title, fn) => {
    let r;
    try { r = await fn(); } catch (e) { r = { s: 'fail', d: e.message }; }
    const item = { id, title, status: r.s, detail: r.d, fix: r.fix || false };
    out.push(item); send('diag:item', item);
    await new Promise(r => setTimeout(r, 220));
  };
  const gb = n => (n / 1073741824).toFixed(1);

  await add('sys', 'Система', async () => {
    const x64 = os.arch() === 'x64';
    return { s: x64 ? 'ok' : 'fail', d: `${os.type()} ${os.release()} · ${os.arch()}${x64 ? '' : ' — нужна 64-битная система'}` };
  });
  await add('cpu', 'Процессор', async () => ({ s: os.cpus().length >= 4 ? 'ok' : 'warn', d: `${os.cpus()[0].model.trim()} · ${os.cpus().length} потоков` }));
  await add('gpu', 'Видеокарта', async () => {
    const g = await app.getGPUInfo('basic'); const d = g.gpuDevice && g.gpuDevice[0];
    const name = d && (d.deviceString || `vendor ${d.vendorId}`) || 'не определена';
    return { s: d ? 'ok' : 'warn', d: name + (d && d.driverVersion ? ` · драйвер ${d.driverVersion}` : '') };
  });
  await add('ram', 'Оперативная память', async () => {
    const t = os.totalmem(), f = os.freemem(), want = settings.ram * 1073741824;
    if (t < 8 * 1073741824) return { s: 'warn', d: `Всего ${gb(t)} ГБ — для сборки мало, нужно от 8 ГБ` };
    if (f < want) return { s: 'warn', d: `Свободно ${gb(f)} ГБ, а игре выделено ${settings.ram} ГБ — закройте лишние программы` };
    return { s: 'ok', d: `Свободно ${gb(f)} из ${gb(t)} ГБ · игре выделено ${settings.ram} ГБ` };
  });
  await add('disk', 'Место на диске', async () => {
    const st = fs.statfsSync(app.getPath('appData')); const free = st.bavail * st.bsize;
    return { s: free > 5e9 ? 'ok' : free > 1.5e9 ? 'warn' : 'fail', d: `Свободно ${gb(free)} ГБ` };
  });
  await add('write', 'Доступ к папке игры', async () => {
    const t = path.join(ROOT, '.w'); fs.writeFileSync(t, '1'); fs.rmSync(t);
    return { s: 'ok', d: ROOT };
  });
  await add('net', 'Интернет', async () => {
    const t = Date.now(); const r = await fetchT('https://github.com', 6000, { method: 'HEAD' });
    return { s: r.ok ? 'ok' : 'warn', d: `GitHub отвечает за ${Date.now() - t} мс` };
  });
  let manifest = null;
  await add('man', 'Обновления модов', async () => {
    manifest = await getManifest();
    return { s: 'ok', d: `Версия сборки от ${manifest.version.slice(0, 10)} · ${manifest.files.length} файлов` };
  });
  await add('srv', 'Сервер Nexus', async () => {
    const r = await mcutil.status(cfg.server.host, cfg.server.port, { timeout: 5000 });
    return { s: r.roundTripLatency < 150 ? 'ok' : 'warn', d: `Онлайн ${r.players.online}/${r.players.max} · пинг ${r.roundTripLatency} мс` };
  });
  await add('java', 'Java', async () => {
    const j = await findJava();
    return j ? { s: 'ok', d: j.label } : { s: 'fail', d: 'Java 17 не найдена — будет установлена автоматически', fix: true };
  });
  await add('mods', 'Целостность модов', async () => {
    if (!manifest) return { s: 'warn', d: 'Не удалось сверить — нет манифеста' };
    const v = await verify(manifest);
    const bad = v.missing.length + v.corrupt.length;
    if (!bad && !v.extra.length) return { s: 'ok', d: `Все ${manifest.files.length} файлов совпадают с эталоном` };
    return { s: bad ? 'fail' : 'warn', fix: true,
      d: `Не хватает: ${v.missing.length} · повреждено: ${v.corrupt.length} · лишних: ${v.extra.length}` };
  });
  await add('forge', 'Forge', async () => {
    const t = await forgeTarget(manifest);
    return fs.existsSync(t.file) ? { s: 'ok', d: `${t.label} · Minecraft ${cfg.mcVersion}` }
      : { s: 'warn', d: `${t.label} ещё не скачан — загрузится автоматически`, fix: true };
  });
  await add('auth', 'Аккаунт', async () =>
    settings.provider ? { s: 'ok', d: `${settings.name} · ${PROVIDER_NAME[settings.provider] || settings.provider}` } : { s: 'warn', d: 'Вход не выполнен' });
  await add('crash', 'Последний сбой игры', async () => {
    const dir = path.join(ROOT, 'crash-reports');
    const f = walk(dir).map(p => ({ p, t: fs.statSync(p).mtimeMs })).sort((a, b) => b.t - a.t)[0];
    if (!f) return { s: 'ok', d: 'Сбоев не найдено' };
    const days = (Date.now() - f.t) / 864e5;
    return { s: days < 1 ? 'warn' : 'ok', d: `${path.basename(f.p)} · ${days < 1 ? 'меньше суток назад' : Math.floor(days) + ' дн. назад'}` };
  });
  return out;
}
ipcMain.handle('diag:run', runDiagnostics);

// ---------- окно / прочее ----------
ipcMain.handle('config', () => ({ ...cfg, ram: settings.ram, maxRam: Math.max(2, Math.floor(os.totalmem() / 1073741824) - 2), name: settings.name }));
ipcMain.handle('settings:ram', (_, v) => { settings.ram = v; saveSettings(); });
// открыть нужную папку; если её ещё нет - создаём, иначе проводник ругнётся на пустое место
const openDir = sub => { const d = path.join(ROOT, sub); fs.mkdirSync(d, { recursive: true }); return shell.openPath(d); };
ipcMain.handle('open', (_, what) => {
  switch (what) {
    case 'logs': return shell.openPath(path.dirname(LOG_FILE));
    case 'game': return shell.openPath(ROOT);
    case 'shots': return openDir('screenshots');
    case 'mods': return openDir('mods');
    case 'packs': return openDir('pointblank');
    default: return shell.openExternal(what);
  }
});
ipcMain.handle('copy', (_, t) => clipboard.writeText(t));
ipcMain.on('rlog', (_, m) => log('[renderer] ' + String(m).slice(0, 500)));
ipcMain.on('win', (_, a) => {
  if (!win) return;
  if (a === 'min') win.minimize();
  else if (a === 'max') { if (win.isFullScreen()) win.setFullScreen(false); else win.isMaximized() ? win.unmaximize() : win.maximize(); }
  else if (a === 'full') win.setFullScreen(!win.isFullScreen());
  else if (a === 'exitfull') { if (win.isFullScreen()) win.setFullScreen(false); }
  else if (a === 'devtools') win.webContents.toggleDevTools();
  else if (a === 'quit') { quitting = true; app.quit(); }
  else win.close();
});

// ---------- настройки, сборка, моды (для интерфейса) ----------
ipcMain.handle('settings:get', () => ({
  ram: settings.ram, autoConnect: settings.autoConnect, hideOnLaunch: settings.hideOnLaunch, fullscreen: settings.fullscreen, jvmArgs: settings.jvmArgs, discordRpc: settings.discordRpc, discordAvailable: !!cfg.discordClientId,
  maxRam: Math.max(2, Math.floor(os.totalmem() / 1073741824) - 2), totalRam: Math.round(os.totalmem() / 1073741824), version: app.getVersion()
}));
ipcMain.handle('settings:set', (_, patch) => {
  for (const k of ['ram', 'autoConnect', 'hideOnLaunch', 'fullscreen', 'jvmArgs', 'discordRpc']) if (k in patch) settings[k] = patch[k];
  saveSettings(); rpcApply();
});
ipcMain.handle('java:info', async () => { const j = await findJava(); return j ? j.label : 'Java 17 скачается при первом запуске'; });
ipcMain.handle('manifest:info', async () => {
  const m = await getManifest(); const mods = m.files.filter(f => f.path.startsWith('mods/'));
  return { version: m.version, mods: mods.length, size: mods.reduce((a, f) => a + (f.size || 0), 0), news: (m.news || []).slice(0, 5) };
});
ipcMain.handle('mods:list', async () => {
  const m = await getManifest(), v = await verify(m), bad = new Map();
  v.missing.forEach(f => bad.set(f.path, 'missing')); v.corrupt.forEach(f => bad.set(f.path, 'corrupt'));
  const pick = pre => m.files.filter(f => f.path.startsWith(pre))
    .map(f => ({ name: path.basename(f.path), size: f.size || 0, status: bad.get(f.path) || 'ok' }));
  const mods = pick('mods/');
  return {
    mods,
    // дополнения Point Blank лежат отдельно - в папке pointblank, и в списке их видно отдельно
    packs: pick('pointblank/'),
    extra: v.extra.map(p => path.basename(p)),
    version: m.version,
    behind: v.missing.length + v.corrupt.length,
    size: mods.reduce((a, f) => a + f.size, 0)
  };
});

// ---------- обновление сборки вручную ----------
ipcMain.handle('mods:update', async () => {
  if (game) throw new Error('Сначала закройте Minecraft - открытые моды нельзя заменить.');
  if (busy) throw new Error('Обновление уже идёт.');
  busy = true;
  try { return await sync(); } finally { busy = false; }
});

/** Что изменилось при последнем обновлении - окно показывает это списком. */
ipcMain.handle('mods:report', () => lastReport);
