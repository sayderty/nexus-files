// Discord Rich Presence без внешних библиотек: говорим с Discord напрямую через его локальный IPC-канал.
// Если Discord не запущен — тихо пробуем снова каждые 15 секунд.
const net = require('net'), os = require('os'), path = require('path'), crypto = require('crypto');

class DiscordRPC {
  constructor(clientId, log = () => {}) {
    this.clientId = clientId; this.log = log;
    this.sock = null; this.ready = false; this.stopped = true; this.buf = Buffer.alloc(0);
    this.pending = null; this.timer = null; this.warned = false;
  }
  start() { if (!this.clientId || !this.stopped) return; this.stopped = false; this._connect(0); }
  stop() {
    this.stopped = true; clearTimeout(this.timer);
    if (this.sock) { try { if (this.ready) this._send(1, this._activityFrame(null)); this.sock.destroy(); } catch {} }
    this.sock = null; this.ready = false;
  }
  setActivity(a) { this.pending = a; if (this.ready) this._send(1, this._activityFrame(a)); }

  _paths() {
    if (process.platform === 'win32') return Array.from({ length: 10 }, (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`);
    const dirs = [process.env.XDG_RUNTIME_DIR, process.env.TMPDIR, process.env.TMP, process.env.TEMP, '/tmp'].filter(Boolean);
    return dirs.flatMap(d => Array.from({ length: 10 }, (_, i) => path.join(d, `discord-ipc-${i}`)));
  }
  _connect(i) {
    if (this.stopped) return;
    const list = this._paths();
    if (i >= list.length) return this._retry();
    const s = net.createConnection(list[i]);
    let opened = false;
    s.once('connect', () => {
      opened = true; this.sock = s; this.buf = Buffer.alloc(0);
      this._send(0, { v: 1, client_id: this.clientId });
    });
    s.on('data', d => this._onData(d));
    s.on('error', () => { if (!opened) { s.destroy(); this._connect(i + 1); } });
    s.on('close', () => {
      if (!opened) return;
      this.ready = false; this.sock = null;
      if (!this.stopped) this._retry();
    });
  }
  _retry() { clearTimeout(this.timer); if (!this.stopped) this.timer = setTimeout(() => this._connect(0), 15000); }
  _send(op, data) {
    if (!this.sock || this.sock.destroyed) return;
    const j = Buffer.from(JSON.stringify(data), 'utf8'), h = Buffer.alloc(8);
    h.writeInt32LE(op, 0); h.writeInt32LE(j.length, 4);
    this.sock.write(Buffer.concat([h, j]));
  }
  _activityFrame(activity) { return { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity }, nonce: crypto.randomUUID() }; }
  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 8) {
      const op = this.buf.readInt32LE(0), len = this.buf.readInt32LE(4);
      if (this.buf.length < 8 + len) break;
      let msg = {}; try { msg = JSON.parse(this.buf.subarray(8, 8 + len).toString('utf8')); } catch {}
      this.buf = this.buf.subarray(8 + len);
      if (op === 2) { this.log('discord: соединение закрыто Discord-ом'); this.sock && this.sock.destroy(); }
      else if (op === 3) this._send(4, msg);                       // ping -> pong
      else if (msg.evt === 'READY') { this.ready = true; this.log('discord: подключено'); this._send(1, this._activityFrame(this.pending)); }
      else if (msg.evt === 'ERROR') this.log(`discord: ошибка ${msg.data && msg.data.code} ${msg.data && msg.data.message}`);
    }
  }
}
module.exports = DiscordRPC;
