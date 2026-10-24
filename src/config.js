// ====== ЕДИНСТВЕННЫЙ файл, который нужно поправить перед сборкой ======
module.exports = {
  name: 'Nexus SCP-RP',
  server: { host: 'de-2.sakuranet.space', port: 20341 },
  mcVersion: '1.20.1',
  loader: 'forge',
  // Версия Forge: конкретная (рекомендуется — должна совпадать с сервером) или 'auto' = рекомендуемая с сайта Forge
  forgeVersion: '47.4.0',

  // GitHub-репозиторий с модами: "логин/репозиторий" и ветка
  repo: 'sayderty/nexus-files',
  branch: 'main',

  // Ссылки внизу (оставь пустыми, чтобы скрыть кнопку)
  links: { discord: '', site: '', telegram: '' },

  // Discord Rich Presence («Играет в ...» в профиле Дискорда).
  // Application ID берётся на https://discord.com/developers/applications (New Application). Пусто = функция выключена.
  discordClientId: '1561269198506696774',
  // Две строки статуса, пока игрок в игре
  discordPlaying: { details: 'Nexus • Scp-Rp | Site-17', state: 'Играет на Nexus-ScpRp.' },

  defaultRam: 4 // ГБ
};
