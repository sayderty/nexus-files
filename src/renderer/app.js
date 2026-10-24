const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)], api = window.nexus;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = e => String(e.message || e).replace(/^Error invoking remote method '.*?': (Error: )?/, '');
let cfg, S, user = null, busy = false, report = [], modsAll = [];

const head = n => `https://mc-heads.net/avatar/${encodeURIComponent(n)}/64`;
const initial = n => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#3d2fa8"/><text x="32" y="43" font-size="32" text-anchor="middle" fill="#fff" font-family="sans-serif">${esc(n[0] || '?').toUpperCase()}</text></svg>`);
const avatar = u => u.provider === 'microsoft' ? head(u.name) : initial(u.name);
addEventListener('error', e => api.log(`error: ${e.message} @${e.lineno}`));
addEventListener('unhandledrejection', e => api.log('promise: ' + (e.reason && e.reason.message || e.reason)));
// горячие клавиши окна: F11 — полный экран, Esc — выход из него, Ctrl+Shift+I — инструменты разработчика
addEventListener('keydown', e => {
  if (e.key === 'F11') { e.preventDefault(); api.win('full'); }
  else if (e.key === 'Escape') api.win('exitfull');
  else if (e.ctrlKey && e.shiftKey && e.code === 'KeyI') api.win('devtools');
});
const state = s => document.body.className = s;
const setStatus = (t, p) => { $('#status').textContent = t; if (p != null) $('#fill').style.width = p + '%'; };
const fmtMB = b => b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' ГБ' : Math.round(b / 1048576) + ' МБ';
function toast(msg, kind = '') { const t = document.createElement('div'); t.className = 'toast ' + kind; t.textContent = msg; $('#toasts').append(t); setTimeout(() => t.remove(), 3700); }

// ---- эффекты: подсветка карточек под курсором и лёгкий параллакс фона ----
let raf = 0;
document.addEventListener('mousemove', e => {
  const c = e.target.closest && e.target.closest('.card,.tile');
  if (c) { const r = c.getBoundingClientRect(); c.style.setProperty('--mx', e.clientX - r.left + 'px'); c.style.setProperty('--my', e.clientY - r.top + 'px'); }
  if (raf) return; raf = requestAnimationFrame(() => { raf = 0;
    document.documentElement.style.setProperty('--px', ((e.clientX / innerWidth - .5) * -18).toFixed(1) + 'px');
    document.documentElement.style.setProperty('--py', ((e.clientY / innerHeight - .5) * -12).toFixed(1) + 'px'); });
});
$$('[data-w]').forEach(b => b.onclick = () => api.win(b.dataset.w));
api.on('win:state', w => { $('#wMax').innerHTML = w.max && !w.full ? '&#10064;' : '&#9633;'; $('#wFull').classList.toggle('on', w.full); });
addEventListener('dblclick', e => e.target.classList.contains('drag') && api.win('max'));

// ---- навигация ----
function go(page) {
  $$('.page').forEach(p => p.classList.toggle('on', p.id === 'p-' + page));
  $$('.nav button').forEach(b => b.classList.toggle('on', b.dataset.page === page));
  if (page === 'mods') loadMods(); if (page === 'set') fillSettings(); if (page === 'diag' && !report.length) runDiag();
}
$$('.nav button').forEach(b => b.onclick = () => go(b.dataset.page));
$('#me').onclick = () => go('set');

// ---- вход ----
const shake = el => { el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); };
function enterApp(u) {
  user = u; $('#meImg').src = avatar(u); $('#meName').textContent = u.name; $('#hello').textContent = `Добро пожаловать, ${u.name}`;
  state('app'); go('home'); loadBuild(); poll(); setStatus('Готов к запуску', 0); toast(`Вы вошли как ${u.name}`, 'ok');
}
$('#tMs').onclick = async () => {
  const m = $('#msMsg'); m.className = 'authmsg'; m.textContent = 'Откройте окно входа Microsoft…'; $('#tMs').disabled = true;
  try { enterApp(await api.login()); m.textContent = ''; } catch (e) { m.className = 'authmsg bad'; m.textContent = 'Вход отменён или не удался'; shake(m); }
  $('#tMs').disabled = false;
};
// переключение панелей экрана входа (без сдвигов и измерений высоты — поля всегда кликабельны)
const PANES = { home: '#paneHome', ely: '#paneEly', off: '#paneOff' };
const setMsg = (sel, text, bad) => { const m = $(sel); m.className = 'authmsg' + (bad ? ' bad' : ''); m.textContent = text || ''; if (bad) shake(m); };
function showPane(name) {
  $$('.authcard .pane').forEach(p => p.classList.remove('on')); $(PANES[name]).classList.add('on');
  ['#msMsg', '#elyMsg', '#offMsg'].forEach(s => setMsg(s, ''));
  const f = { ely: '#elyUser', off: '#offUser' }[name]; if (f) setTimeout(() => $(f).focus(), 80);
}
const busyBtn = (btn, on, label) => { btn.disabled = on; btn.innerHTML = on ? '<span class="spin"></span>' : `<span>${label}</span>`; };
$$('[data-back]').forEach(b => b.onclick = () => showPane('home'));
$$('[data-open]').forEach(b => b.onclick = () => api.open(b.dataset.open));
$$('[data-eye]').forEach(b => b.onclick = () => { const p = $('#' + b.dataset.eye); p.type = p.type === 'password' ? 'text' : 'password'; p.focus(); });

// ---- Ely.by ----
let elyNeed2fa = false;
$('#tEly').onclick = () => showPane('ely');
async function elyGo() {
  const login = $('#elyUser').value.trim(), password = $('#elyPass').value, code = $('#elyCode').value.trim();
  if (!login || !password) return setMsg('#elyMsg', 'Введите ник/email и пароль', true);
  if (elyNeed2fa && !code) { $('#elyCode').focus(); return setMsg('#elyMsg', 'Введите код из приложения-аутентификатора', true); }
  busyBtn($('#elyGo'), true); setMsg('#elyMsg', 'Входим…');
  try { const u = await api.elyLogin({ login, password, code }); $('#elyPass').value = ''; $('#elyCode').value = ''; enterApp(u); }
  catch (e) {
    if (String(e.message).includes('NEED_2FA')) { elyNeed2fa = true; $('#fCode').hidden = false; setMsg('#elyMsg', 'Аккаунт защищён 2FA — введите код из приложения'); $('#elyCode').focus(); }
    else setMsg('#elyMsg', clean(e), true);
  }
  busyBtn($('#elyGo'), false, 'Войти');
}
$('#elyGo').onclick = elyGo;
$$('#elyUser,#elyPass,#elyCode').forEach(i => i.addEventListener('keydown', e => e.key === 'Enter' && elyGo()));

// ---- Офлайн: вход и регистрация ----
let offMode = 'login', offNames = [];
function renderChips() {
  const c = $('#chips'); c.hidden = offMode !== 'login' || !offNames.length;
  c.innerHTML = offNames.map(n => `<button class="chip" data-n="${esc(n)}">${esc(n)}</button>`).join('');
  $$('#chips .chip').forEach(b => b.onclick = () => { $('#offUser').value = b.dataset.n; $$('#chips .chip').forEach(x => x.classList.toggle('on', x === b)); $('#offPass').focus(); });
}
function setOffMode(m) {
  offMode = m; $$('.seg button').forEach(b => b.classList.toggle('on', b.dataset.m === m));
  $('#fPass2').hidden = m !== 'reg'; $('#offPass').autocomplete = m === 'reg' ? 'new-password' : 'current-password';
  busyBtn($('#offGo'), false, m === 'reg' ? 'Зарегистрироваться' : 'Войти');
  setMsg('#offMsg', m === 'reg' ? 'Придумайте ник и пароль — аккаунт сохранится на этом компьютере' : ''); renderChips();
}
$$('.seg button').forEach(b => b.onclick = () => setOffMode(b.dataset.m));
$('#tOff').onclick = async () => {
  try { offNames = await api.offlineList(); } catch { offNames = []; }
  showPane('off'); setOffMode(offNames.length ? 'login' : 'reg');
};
async function offGo() {
  const name = $('#offUser').value.trim(), password = $('#offPass').value;
  if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) return setMsg('#offMsg', 'Ник: 3–16 символов, латиница, цифры и _', true);
  if (password.length < 4) return setMsg('#offMsg', 'Пароль — минимум 4 символа', true);
  if (offMode === 'reg' && password !== $('#offPass2').value) return setMsg('#offMsg', 'Пароли не совпадают', true);
  busyBtn($('#offGo'), true); setMsg('#offMsg', '');
  try { const u = await (offMode === 'reg' ? api.offlineRegister : api.offlineLogin)({ name, password }); $('#offPass').value = ''; $('#offPass2').value = ''; enterApp(u); }
  catch (e) { setMsg('#offMsg', clean(e), true); }
  busyBtn($('#offGo'), false, offMode === 'reg' ? 'Зарегистрироваться' : 'Войти');
}
$('#offGo').onclick = offGo;
$$('#offUser,#offPass,#offPass2').forEach(i => i.addEventListener('keydown', e => e.key === 'Enter' && offGo()));

$('#logout').onclick = async () => {
  await api.logout(); user = null; report = []; elyNeed2fa = false; $('#fCode').hidden = true;
  ['#elyPass', '#elyCode', '#offPass', '#offPass2'].forEach(s => $(s).value = ''); showPane('home'); state('auth');
};

// ---- главная ----
async function loadBuild() {
  const bl = $('#buildLine');
  try {
    const i = await api.manifestInfo(); bl.className = 'buildline'; bl.innerHTML = `<i></i>Сборка от ${new Date(i.version).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })} · ${i.mods} модов`;
    $('#stMods').textContent = i.mods; $('#stSize').textContent = fmtMB(i.size); $('#stDate').textContent = new Date(i.version).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
    if (i.news.length) $('#news').innerHTML = i.news.map(n => `<div class="ni"><b>${esc(n.title || '')}</b><p>${esc(n.text || '')}</p><small>${esc(n.date || '')}</small></div>`).join('');
  } catch (e) { bl.className = 'buildline warn'; bl.innerHTML = '<i></i>Не удалось получить данные сборки — проверьте Диагностику'; }
}
let shown = 0;
function countTo(el, to) { const from = shown; shown = to; const t0 = performance.now();
  (function f(t) { const k = Math.min(1, (t - t0) / 700); el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(f); })(t0); }
async function poll() {
  const s = await api.status(), pill = $('#pill');
  pill.className = 'pill ' + (s.online ? 'on' : 'off'); $('#pillTxt').textContent = s.online ? 'Онлайн' : 'Оффлайн';
  if (s.online) { countTo($('#online'), s.players); $('#max').textContent = '/ ' + s.max; $('#meter').style.width = Math.min(100, s.players / Math.max(1, s.max) * 100) + '%'; }
  else { $('#online').textContent = '–'; $('#max').textContent = ''; $('#meter').style.width = '0'; }
  $('#ping').textContent = s.online ? `пинг ${s.ping} мс` : 'нет связи';
  $('#sig').dataset.q = !s.online ? 0 : s.ping < 60 ? 4 : s.ping < 120 ? 3 : s.ping < 200 ? 2 : 1;
  $('#heads').innerHTML = (s.names || []).map((n, i) => `<img src="${head(n)}" title="${esc(n)}" alt="" style="animation-delay:${i * 60}ms">`).join('');
}
setInterval(() => user && poll(), 15000);
$('#ip').onclick = () => { api.copy(`${cfg.server.host}:${cfg.server.port}`); $('#copied').innerHTML = '<svg><use href="#i-copy"/></svg>скопировано'; setTimeout(() => $('#copied').innerHTML = '<svg><use href="#i-copy"/></svg>скопировать', 1500); };

api.on('progress', p => { setStatus(p.label, p.pct); if (busy) $('#playTxt').textContent = p.pct >= 100 ? 'Запуск…' : Math.round(p.pct) + '%'; });
api.on('game:closed', () => { setStatus('Игра закрыта', 0); toast('Игра закрыта'); });
$('#play').onclick = async () => {
  if (busy) return; busy = true; const b = $('#play'); b.disabled = true; b.classList.add('busy'); $('#playTxt').textContent = 'Подготовка…';
  try { await api.play(); setStatus('Игра запущена. Приятной игры!', 100); toast('Игра запущена', 'ok'); }
  catch (e) { setStatus('Ошибка: ' + clean(e) + ' — откройте «Диагностику»', 0); toast('Не удалось запустить игру', 'bad'); }
  busy = false; b.disabled = false; b.classList.remove('busy'); $('#playTxt').textContent = 'Играть';
};
async function repair() {
  if (busy) return; busy = true; $('#repairBtn').disabled = true; setStatus('Проверка файлов…', 0);
  try { await api.repair(); setStatus('Все файлы в порядке', 100); toast('Файлы проверены и обновлены', 'ok'); loadBuild(); }
  catch (e) { setStatus('Ошибка: ' + clean(e), 0); toast('Не удалось обновить файлы', 'bad'); }
  busy = false; $('#repairBtn').disabled = false;
}
$('#repairBtn').onclick = repair;

// ---- сборка ----
let packsAll = [];

async function loadMods() {
  $('#modGrid').innerHTML = '<div class="skel"></div>'.repeat(9);
  $('#modsSub').textContent = 'Сверяем файлы с эталоном…';
  try {
    const r = await api.modsList();
    modsAll = r.mods.concat(r.extra.map(n => ({ name: n, size: 0, status: 'extra' })));
    packsAll = r.packs || [];
    const bad = r.behind || 0;
    const when = r.version ? new Date(r.version) : null;
    $('#modsSub').innerHTML = `${r.mods.length} модов · ${fmtMB(r.size)}`
      + (bad ? ` · <b class="warn">обновить: ${bad}</b>` : ' · <b class="okk">всё совпадает с сервером</b>')
      + (r.extra.length ? ` · лишних: ${r.extra.length}` : '')
      + (when && !isNaN(when) ? ` · сборка от ${when.toLocaleDateString('ru-RU')}` : '');
    $('#modsFix').innerHTML = bad
      ? '<svg><use href="#i-arrow"/></svg>Обновить сборку (' + bad + ')'
      : '<svg><use href="#i-wrench"/></svg>Проверить и починить';
    renderMods();
  } catch (e) {
    $('#modGrid').innerHTML = '';
    $('#modsSub').textContent = 'Не удалось получить список: ' + clean(e);
  }
}

const ST = { ok: 'ок', missing: 'нет файла', corrupt: 'обновится', extra: 'лишний' };
const modCard = (m, i) =>
  `<div class="mod" style="--i:${Math.min(i, 30)}"><span class="mi"><svg><use href="#i-box"/></svg></span>`
  + `<div><b title="${esc(m.name)}">${esc(m.name.replace(/\.(jar|zip)$/, ''))}</b>`
  + `<small>${m.size ? fmtMB(m.size) : '—'}</small></div>`
  + `<span class="st ${m.status}">${ST[m.status]}</span></div>`;

function renderMods() {
  const q = $('#modQ').value.toLowerCase();
  const mods = modsAll.filter(m => m.name.toLowerCase().includes(q));
  const packs = packsAll.filter(m => m.name.toLowerCase().includes(q));
  $('#modGrid').innerHTML = mods.map(modCard).join('') || '<p class="muted">Ничего не найдено</p>';
  $('#packGrid').innerHTML = packs.map(modCard).join('');
  $('#headMods').hidden = !packs.length;          // заголовки нужны, только когда списков два
  $('#headPacks').hidden = !packs.length;
}
$('#modQ').oninput = renderMods;
$('#modsRescan').onclick = loadMods;

// ---- обновление сборки вручную ----
function showProgressBar(on) { $('#upBar').hidden = !on; }
api.on('progress', p => {
  if ($('#upBar').hidden) return;
  $('#upFill').style.width = (p.pct || 0) + '%';
  $('#upTxt').textContent = p.label || '';
});

/** Что поменялось после обновления - коротким списком, без простыни из имён файлов. */
function showReport(r) {
  if (!r) return;
  const box = $('#chBody'), rows = [];
  const line = (cls, title, names) => names && names.length
    ? `<div class="chrow ${cls}"><b>${title}: ${names.length}</b><span>${names.slice(0, 8).map(esc).join(', ')}`
      + (names.length > 8 ? ` и ещё ${names.length - 8}` : '') + '</span></div>' : '';
  rows.push(line('add', 'Добавлено', r.added));
  rows.push(line('upd', 'Обновлено', r.updated));
  rows.push(line('del', 'Удалено лишних', r.removed));
  const body = rows.filter(Boolean).join('');
  box.innerHTML = body || '<p class="muted">Ничего не менялось — сборка уже была свежей.</p>';
  $('#changes').hidden = false;
}
api.on('sync:report', showReport);
$('#chHide').onclick = () => { $('#changes').hidden = true; };

$('#modsFix').onclick = async () => {
  const b = $('#modsFix'); b.disabled = true; showProgressBar(true);
  try {
    const r = await api.modsUpdate();
    toast(r.updated || r.removed ? `Готово: обновлено ${r.updated}, удалено ${r.removed}` : 'Сборка уже свежая', 'ok');
  } catch (e) { toast(clean(e), 'bad'); }
  b.disabled = false; showProgressBar(false); loadMods();
};

// ---- диагностика ----
const ICON = { ok: '✓', warn: '!', fail: '✕' };
function paint(ok, total) { const pct = Math.round(ok / total * 100); $('#score').textContent = pct;
  const a = $('#arc'); a.style.strokeDashoffset = 327 - 327 * pct / 100; a.style.stroke = pct > 85 ? 'var(--ok)' : pct > 60 ? 'var(--warn)' : 'var(--bad)'; }
api.on('diag:item', i => { report.push(i);
  const li = document.createElement('li'); li.className = i.status; li.innerHTML = `<u>${ICON[i.status]}</u><b>${esc(i.title)}</b><span>${esc(i.detail || '')}</span>`; $('#dlist').append(li);
  paint(report.filter(x => x.status === 'ok').length, 15); });
async function runDiag() {
  report = []; $('#dlist').innerHTML = ''; $('#fix').hidden = true; $('#again').disabled = true; $('#verdict').textContent = 'Проверяем систему…'; paint(0, 15);
  try {
    const all = await api.diag(), bad = all.filter(i => i.status === 'fail').length, warn = all.filter(i => i.status === 'warn').length;
    paint(all.filter(i => i.status === 'ok').length, all.length);
    $('#verdict').textContent = !bad && !warn ? 'Всё в порядке — можно играть' : `Проблем: ${bad} · предупреждений: ${warn}`;
    $('#fix').hidden = !all.some(i => i.fix);
  } catch (e) { $('#verdict').textContent = 'Ошибка диагностики: ' + clean(e); }
  $('#again').disabled = false;
}
$('#again').onclick = runDiag; $('#logs').onclick = () => api.open('logs');
$('#fix').onclick = async () => { $('#fix').disabled = true; $('#verdict').textContent = 'Исправляем…'; try { await api.repair(); } catch (e) { toast(clean(e), 'bad'); } $('#fix').disabled = false; runDiag(); };
$('#rep').onclick = () => { api.copy('Nexus Launcher — отчёт\n' + report.map(i => `[${i.status.toUpperCase()}] ${i.title}: ${i.detail}`).join('\n')); toast('Отчёт скопирован', 'ok'); };

// ---- настройки ----
let t = 0; const save = p => { clearTimeout(t); t = setTimeout(() => api.settingsSet(p), 150); };
async function fillSettings() {
  S = await api.settingsGet();
  const r = $('#ram'); r.max = S.maxRam; r.value = Math.min(S.ram, S.maxRam); setRam(+r.value, false);
  const rec = Math.min(S.maxRam, Math.max(4, Math.floor(S.totalRam / 2)));
  const pr = [...new Set([Math.min(4, S.maxRam), Math.min(6, S.maxRam), rec, S.maxRam])].sort((a, b) => a - b);
  $('#presets').innerHTML = pr.map(v => `<button data-v="${v}">${v} ГБ${v === rec ? ' · рекомендуем' : ''}</button>`).join('');
  $$('#presets button').forEach(b => b.onclick = () => setRam(+b.dataset.v, true));
  $('#ramHint').textContent = `Всего в системе ${S.totalRam} ГБ. Больше ${S.maxRam} ГБ выделять нельзя — Windows и игре не хватит памяти.`;
  $('#swAuto').checked = S.autoConnect; $('#swHide').checked = S.hideOnLaunch; $('#swFull').checked = S.fullscreen; $('#swDs').checked = S.discordRpc !== false; $('#rowDs').hidden = !S.discordAvailable; $('#jvm').value = S.jvmArgs || '';
  $('#accImg').src = avatar(user); $('#accName').textContent = user.name; $('#accProv').textContent = ({ ely: 'Ely.by', offline: 'Офлайн' })[user.provider] || 'Microsoft';
  $('#verTxt').textContent = `Nexus Launcher ${S.version} · Minecraft ${cfg.mcVersion} · ${cfg.loader}`;
  api.javaInfo().then(j => $('#javaInfo').textContent = j);
}
function setRam(v, send) { const r = $('#ram'); r.value = v; $('#ramVal').textContent = v; r.style.setProperty('--pct', (v - r.min) / (r.max - r.min) * 100 + '%');
  $$('#presets button').forEach(b => b.classList.toggle('on', +b.dataset.v === v)); if (send) save({ ram: v }); }
$('#ram').oninput = e => setRam(+e.target.value, true);
$('#swAuto').onchange = e => save({ autoConnect: e.target.checked }); $('#swHide').onchange = e => save({ hideOnLaunch: e.target.checked });
$('#swFull').onchange = e => save({ fullscreen: e.target.checked }); $('#swDs').onchange = e => save({ discordRpc: e.target.checked }); $('#jvm').onchange = e => save({ jvmArgs: e.target.value.trim() });
$$('[data-open]').forEach(b => b.onclick = () => api.open(b.dataset.open));

// ---- старт ----
(async () => {
  cfg = await api.config();
  $('#ipTxt').textContent = `${cfg.server.host}:${cfg.server.port}`; $('#ver').textContent = `${cfg.mcVersion} · ${cfg.loader}`;
  const u = await api.restore(); u ? enterApp(u) : state('auth');
})();

// на случай, если клик не ставит фокус в поле (безрамочное окно): ставим принудительно
$$('.field input').forEach(i => i.addEventListener('mousedown', () => setTimeout(() => i.focus(), 0)));
