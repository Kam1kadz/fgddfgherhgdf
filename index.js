const { 
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, 
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, 
  ModalBuilder, TextInputBuilder, TextInputStyle, 
  AttachmentBuilder, MessageFlags, PermissionFlagsBits, Events,
  StringSelectMenuBuilder
} = require('discord.js');

const fs = require('fs');
const db = require('./db.js');
const config = require('./config.json');

const ticketSessions = new Map();

// banTracker: userId → [{ ts: timestamp, targetId: string }]
const banTracker = new Map();

const EMBED_COLOR = '#2B2D31'; 
const OWNER_ID = '818502458640564224'; 

const client = new Client({ 
  intents: [
      GatewayIntentBits.Guilds, 
      GatewayIntentBits.GuildMembers, 
      GatewayIntentBits.GuildMessages, 
      GatewayIntentBits.MessageContent
  ] 
});

/* ==========================================
   УТИЛИТЫ
   ========================================== */

function formatDuration(minutes) {
    if (minutes < 60) return `${minutes} мин.`;
    if (minutes < 1440) {
        const h = Math.floor(minutes / 60), m = minutes % 60;
        return m > 0 ? `${h} ч. ${m} мин.` : `${h} ч.`;
    }
    const d = Math.floor(minutes / 1440), h = Math.floor((minutes % 1440) / 60);
    return h > 0 ? `${d} д. ${h} ч.` : `${d} д.`;
}

// Возвращает { count, targets[] } — кол-во банов за минуту и ID забаненных
function trackBan(moderatorId, targetId) {
    const now     = Date.now();
    const history = (banTracker.get(moderatorId) || []).filter(e => now - e.ts < 60_000);
    history.push({ ts: now, targetId });
    banTracker.set(moderatorId, history);
    return { count: history.length, targets: history.map(e => e.targetId) };
}

async function askAI(problemText) {
  if (!config.status.ai || !config.ai.keys.length) return null;
  const systemPrompt = `Ты — эксперт техподдержки чит-клиента "Arbuz Client". 
Твоя задача: помочь пользователю, используя ТОЛЬКО предоставленную ниже документацию.

ИНСТРУКЦИИ:
1. Анализируй СМЫСЛ вопроса. Если пользователь пишет "лоудер не воркает", "не открывается" или "вылетает" — ищи решение в разделе про Лоудер.
2. Понимай сокращения: "фп" = "FunPay", "ют" = "YouTube", "тг" = "Telegram", "дс" = "Discord", "сброс" = "HWID/ХВИД".
3. Если вопрос касается контактов, соцсетей или ссылок (сайт, фанпей, лоадер) — бери их из соответствующих разделов документации.
4. Ответ давай кратко и по делу, копируя инструкции из документации.
5. Если в документации НЕТ даже близкого по смыслу решения — ответь строго одной фразой: "Решение не найдено."

ДОКУМЕНТАЦИЯ АРБУЗ КЛИЕНТА:
${config.ai.documentation}`;
  const randomKey = config.ai.keys[Math.floor(Math.random() * config.ai.keys.length)];
  try {
      const response = await fetch(config.ai.url, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${randomKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://arbuz.cc' },
          body: JSON.stringify({
              model: config.ai.model,
              messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: problemText }],
              temperature: 0.3
          }),
          signal: AbortSignal.timeout(10000)
      });
      const data = await response.json();
      const answer = data.choices?.[0]?.message?.content || "";
      return (answer.length < 5 || answer.includes("не найдено")) ? "Решение не найдено." : answer;
  } catch (e) { return null; }
}

function createStyledEmbed(title, description, fields = []) {
    return new EmbedBuilder()
        .setTitle(title)
        .setDescription(description || null)
        .setColor(EMBED_COLOR)
        .addFields(fields);
}

/* ==========================================
   КОМАНДЫ
   ========================================== */

const commands = [
  new SlashCommandBuilder().setName('setup').setDescription('Установка панелей')
      .addStringOption(o => o.setName('type').setDescription('Тип').setRequired(true)
          .addChoices({name:'Поддержка', value:'t'}, {name:'Наборы', value:'r'})),
  
  new SlashCommandBuilder().setName('search').setDescription('Поиск по базе данных')
      .addStringOption(o => o.setName('type').setDescription('Метод').setRequired(true)
          .addChoices({name:'По UID', value:'uid'}, {name:'По Discord ID', value:'user'}))
      .addStringOption(o => o.setName('value').setDescription('Значение').setRequired(true)),

  new SlashCommandBuilder().setName('settings').setDescription('Настройки бота'),

  new SlashCommandBuilder().setName('updatedoc').setDescription('Обновить документацию ИИ через .txt файл')
      .addAttachmentOption(o => o.setName('file').setDescription('Прикрепите .txt файл').setRequired(true)),

  new SlashCommandBuilder().setName('adduser').setDescription('Выдать Premium')
      .addUserOption(o => o.setName('user').setDescription('Юзер').setRequired(true))
      .addStringOption(o => o.setName('uid').setDescription('UID').setRequired(true))
      .addIntegerOption(o => o.setName('days').setDescription('Дни').setRequired(true)),

  new SlashCommandBuilder().setName('mute').setDescription('Выдать мут (таймаут) участнику')
    .addUserOption(o => o.setName('user').setDescription('Участник').setRequired(true))
    .addStringOption(o => o.setName('duration')
        .setDescription('Длительность: 5мин / 2ч / 3дн (макс. 28дн)')
        .setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Причина').setRequired(false)),

  new SlashCommandBuilder().setName('unmute').setDescription('Снять мут (таймаут) с участника')
      .addUserOption(o => o.setName('user').setDescription('Участник').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Причина снятия').setRequired(false)),

  new SlashCommandBuilder().setName('ban').setDescription('Забанить участника')
      .addUserOption(o => o.setName('user').setDescription('Участник').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Причина').setRequired(false))
      .addIntegerOption(o => o.setName('delete_days').setDescription('Удалить сообщения за N дней (0–7)').setRequired(false).setMinValue(0).setMaxValue(7))
].map(c => c.toJSON());

client.once(Events.ClientReady, async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    await rest.put(Routes.applicationGuildCommands(config.bot.clientId, config.bot.guildId), { body: commands });
    console.log(`[READY] ${client.user.tag}`);
});

/* ==========================================
   ОБРАБОТКА ИНТЕРАКЦИЙ
   ========================================== */

client.on(Events.InteractionCreate, async i => {
  const isAdmin   = i.user.id === OWNER_ID || i.member?.permissions.has(PermissionFlagsBits.Administrator);
  const isSupport = i.member?.roles.cache.has(config.roles.moderatorRoleId);
  const isStaff   = isAdmin || isSupport;

  if (i.isChatInputCommand()) {
      const adminOnlyCommands = ['setup', 'settings', 'updatedoc', 'adduser'];
      const staffCommands     = ['mute', 'unmute', 'ban', 'search'];

      if (adminOnlyCommands.includes(i.commandName) && !isAdmin) {
          return i.reply({ content: "Доступ закрыт.", flags: [MessageFlags.Ephemeral] });
      }
      if (staffCommands.includes(i.commandName) && !isStaff) {
          return i.reply({ content: "Доступ закрыт.", flags: [MessageFlags.Ephemeral] });
      }

      // ── /updatedoc ─────────────────────────────────────────
      if (i.commandName === 'updatedoc') {
          const file = i.options.getAttachment('file');
          if (!file.name.endsWith('.txt')) return i.reply({ content: "❌ Нужен только .txt файл!", flags: [MessageFlags.Ephemeral] });
          await i.deferReply({ flags: [MessageFlags.Ephemeral] });
          try {
              const res  = await fetch(file.url);
              const text = await res.text();
              config.ai.documentation = text;
              fs.writeFileSync('./config.json', JSON.stringify(config, null, 4));
              return i.editReply({ content: `✅ Документация обновлена! Символов загружено: ${text.length}` });
          } catch (e) { return i.editReply({ content: "❌ Ошибка при загрузке файла." }); }
      }

      // ── /setup ─────────────────────────────────────────────
      if (i.commandName === 'setup') {
          const type = i.options.getString('type');
          if (type === 't') {
              const row = new ActionRowBuilder().addComponents(
                  new ButtonBuilder().setCustomId('t:open').setLabel('Открыть обращение').setStyle(ButtonStyle.Secondary)
              );
				await i.channel.send({
					files: ['https://iili.io/BWBXn6l.png'],
					embeds: [createStyledEmbed("<:tickets2:1488661578919317574> — Центр поддержки", "Если у вас возникли технические сложности или вопросы по оплате, нажмите кнопку ниже.\n \nНаш AI-ассистент попробует помочь мгновенно.")],
					components: [row]
				});   
			} else {
              const menu = new StringSelectMenuBuilder()
                  .setCustomId('r:select')
                  .setPlaceholder('Выберите вакансию для подачи заявки...')
                  .addOptions([
                      { label: 'Модерация (Staff)',  value: 'mod', description: 'Помощь пользователям и слежка за порядком', emoji: '<:staff:1488661574188273764>', },
                      { label: 'YouTube (Media)',    value: 'yt',  description: 'Сотрудничество для видео-мейкеров', emoji: '<:media:1488661577229144177>', },
                      { label: 'TikTok (Media)',     value: 'tt',  description: 'Сотрудничество для создателей коротких роликов', emoji: '<:media:1488661577229144177>', }
                  ]);
              await i.channel.send({
					files: ['https://iili.io/BWBevS4.png'],
					embeds: [createStyledEmbed("<:tr:1488661575673057401> — Наборы в команду Arbuz", "Мы всегда рады новым талантам. Выберите направление ниже, чтобы заполнить анкету.")],
					components: [new ActionRowBuilder().addComponents(menu)]
				});
          }
          return i.reply({ content: "Панель установлена.", flags: [MessageFlags.Ephemeral] });
      }

      // ── /search ────────────────────────────────────────────
      if (i.commandName === 'search') {
          const type = i.options.getString('type');
          const val  = i.options.getString('value');
          const data = (type === 'uid') ? db.getPremiumByUid.get(val) : db.getPremiumUser.get(val);
          if (!data) return i.reply({ embeds: [createStyledEmbed("Результат", "Пользователь не найден в базе данных.")], flags: [MessageFlags.Ephemeral] });
          return i.reply({
              embeds: [createStyledEmbed("Информация о лицензии", null, [
                  { name: "Discord", value: `<@${data.discord_id}>`,   inline: true },
                  { name: "UID",     value: `\`${data.uid}\``,         inline: true },
                  { name: "Выдал",   value: `<@${data.granted_by}>`,   inline: true },
                  { name: "Дата",    value: `<t:${data.granted_at}:D>`, inline: true },
                  { name: "Статус",  value: data.active ? "✅ Активен" : "❌ Отозван", inline: true }
              ])],
              flags: [MessageFlags.Ephemeral]
          });
      }

      // ── /settings ──────────────────────────────────────────
      if (i.commandName === 'settings') {
          return i.reply({ 
              embeds: [createStyledEmbed("Настройки Arbuz Bot", "Управление функциональными модулями. Изменения применяются мгновенно.")], 
              components: [createSettingsRow(config)], 
              flags: [MessageFlags.Ephemeral] 
          });
      }

      // ── /adduser ───────────────────────────────────────────
      if (i.commandName === 'adduser') {
          const target = i.options.getUser('user');
          const uid    = i.options.getString('uid');
          const days   = i.options.getInteger('days');
          const expiry = days > 0 ? Math.floor(Date.now() / 1000) + (days * 86400) : null;
          db.addPremium.run(target.id, uid, i.user.id, Math.floor(Date.now() / 1000), expiry);
          const member = await i.guild.members.fetch(target.id).catch(() => null);
          if (member) await member.roles.add(config.roles.premiumId).catch(() => {});
          return i.reply({ embeds: [createStyledEmbed("Лицензия выдана", `Пользователь: ${target}\nUID: \`${uid}\``)], flags: [MessageFlags.Ephemeral] });
      }

      // ── /mute ──────────────────────────────────────────────
      if (i.commandName === 'mute') {
          const target   = i.options.getUser('user');
          const rawDuration = i.options.getString('duration');
	   	  const minutes     = parseDuration(rawDuration);
		  if (!minutes) return i.reply({ content: "❌ Неверный формат. Примеры: `5мин`, `2ч`, `3дн` (макс. `28дн`)", flags: [MessageFlags.Ephemeral] });
          const reason   = i.options.getString('reason') || 'Причина не указана';
          const member   = await i.guild.members.fetch(target.id).catch(() => null);

          if (!member) return i.reply({ content: "❌ Участник не найден на сервере.", flags: [MessageFlags.Ephemeral] });
          if (!member.moderatable) return i.reply({ content: "❌ Нет прав для мута этого участника.", flags: [MessageFlags.Ephemeral] });

          const durationMs  = minutes * 60 * 1000;
          const until       = Math.floor((Date.now() + durationMs) / 1000);
          const durationStr = formatDuration(minutes);

          await target.send({
              embeds: [new EmbedBuilder().setColor(EMBED_COLOR).setTitle('Вам выдан мут')
                  .addFields(
                      { name: 'Сервер',       value: i.guild.name,     inline: true },
                      { name: 'Длительность', value: durationStr,      inline: true },
                      { name: 'Истекает',     value: `<t:${until}:R>`, inline: true },
                      { name: 'Причина',      value: reason,           inline: false }
                  ).setTimestamp()]
          }).catch(() => {});

          await member.timeout(durationMs, reason);

          const logChan = client.channels.cache.get(config.channels.logId);
          if (logChan) {
              await logChan.send({
                  embeds: [new EmbedBuilder().setColor(EMBED_COLOR).setTitle('🔇 Мут выдан')
                      .addFields(
                          { name: 'Участник',     value: `${target} \`${target.id}\``, inline: true },
                          { name: 'Модератор',    value: `${i.user}`,                  inline: true },
                          { name: 'Длительность', value: durationStr,                  inline: true },
                          { name: 'Истекает',     value: `<t:${until}:F>`,             inline: true },
                          { name: 'Причина',      value: reason,                       inline: false }
                      ).setTimestamp()]
              });
          }

          return i.reply({
              embeds: [new EmbedBuilder().setColor(EMBED_COLOR).setTitle('Мут выдан')
                  .addFields(
                      { name: 'Участник',     value: `${target}`, inline: true },
                      { name: 'Длительность', value: durationStr, inline: true },
                      { name: 'Причина',      value: reason,      inline: false }
                  ).setTimestamp()],
              flags: [MessageFlags.Ephemeral]
          });
      }

      // ── /unmute ────────────────────────────────────────────
      if (i.commandName === 'unmute') {
          const target = i.options.getUser('user');
          const reason = i.options.getString('reason') || 'Причина не указана';
          const member = await i.guild.members.fetch(target.id).catch(() => null);

          if (!member) return i.reply({ content: "❌ Участник не найден на сервере.", flags: [MessageFlags.Ephemeral] });
          if (!member.communicationDisabledUntil) return i.reply({ content: "❌ У этого участника нет активного мута.", flags: [MessageFlags.Ephemeral] });
          if (!member.moderatable) return i.reply({ content: "❌ Нет прав для снятия мута.", flags: [MessageFlags.Ephemeral] });

          await member.timeout(null, reason);

          // DM участнику
          await target.send({
              embeds: [new EmbedBuilder().setColor(EMBED_COLOR).setTitle('Мут снят')
                  .addFields(
                      { name: 'Сервер',  value: i.guild.name, inline: true },
                      { name: 'Причина', value: reason,       inline: false }
                  ).setTimestamp()]
          }).catch(() => {});

          // Лог
          const logChan = client.channels.cache.get(config.channels.logId);
          if (logChan) {
              await logChan.send({
                  embeds: [new EmbedBuilder().setColor(EMBED_COLOR).setTitle('🔊 Мут снят')
                      .addFields(
                          { name: 'Участник',  value: `${target} \`${target.id}\``, inline: true },
                          { name: 'Модератор', value: `${i.user}`,                  inline: true },
                          { name: 'Причина',   value: reason,                       inline: false }
                      ).setTimestamp()]
              });
          }

          return i.reply({
              embeds: [new EmbedBuilder().setColor(EMBED_COLOR).setTitle('Мут снят')
                  .addFields(
                      { name: 'Участник', value: `${target}`, inline: true },
                      { name: 'Причина',  value: reason,      inline: false }
                  ).setTimestamp()],
              flags: [MessageFlags.Ephemeral]
          });
      }

      // ── /ban ───────────────────────────────────────────────
      if (i.commandName === 'ban') {
          const target     = i.options.getUser('user');
          const reason     = i.options.getString('reason') || 'Причина не указана';
          const deleteDays = i.options.getInteger('delete_days') ?? 0;
          const member     = await i.guild.members.fetch(target.id).catch(() => null);

          if (member && !member.bannable) {
              return i.reply({ content: "❌ Нет прав для бана этого участника.", flags: [MessageFlags.Ephemeral] });
          }

          // ── Анти-абьюз ─────────────────────────────────────
          const { count: banCount, targets: bannedTargets } = trackBan(i.user.id, target.id);

          if (banCount > 5) {
              await i.deferReply({ flags: [MessageFlags.Ephemeral] });

              // Снять роль модератора
              const modMember = await i.guild.members.fetch(i.user.id).catch(() => null);
              if (modMember?.roles.cache.has(config.roles.moderatorRoleId)) {
                  await modMember.roles.remove(config.roles.moderatorRoleId).catch(() => {});
              }

              // Разбанить всех, кого забанил за эту минуту
              const unbanResults = [];
              for (const uid of bannedTargets) {
                  try {
                      await i.guild.bans.remove(uid, 'Автоматический разбан: анти-абьюз');
                      unbanResults.push(`<@${uid}> \`${uid}\``);
                  } catch { /* уже не в бане или не существует */ }
              }

              const logChan = client.channels.cache.get(config.channels.logId);
              if (logChan) {
                  await logChan.send({
                      embeds: [new EmbedBuilder()
                          .setColor('#FF3333')
                          .setTitle('⚠️ Анти-абьюз сработал')
                          .setDescription(
                              `Модератор ${i.user} выдал **${banCount} банов за 1 минуту**.\n` +
                              `Роль модератора **снята**. Все баны **отменены**.`
                          )
                          .addFields(
                              { name: 'Модератор',      value: `${i.user} \`${i.user.id}\``, inline: true },
                              { name: 'Банов/мин',      value: `${banCount}`,                inline: true },
                              { name: 'Разбаненные',    value: unbanResults.length > 0 ? unbanResults.join('\n') : 'Нет', inline: false }
                          )
                          .setTimestamp()
                      ]
                  });
              }

              banTracker.delete(i.user.id);
              return i.editReply({ content: `❌ Превышен лимит (5 банов/мин). Действие заблокировано.\nРоль модератора снята. Выданные баны отменены.` });
          }
          // ───────────────────────────────────────────────────

          // DM нарушителю (до бана, иначе не дойдёт)
          await target.send({
              embeds: [new EmbedBuilder().setColor(EMBED_COLOR).setTitle('Вы были забанены')
                  .addFields(
                      { name: 'Сервер',  value: i.guild.name, inline: true },
                      { name: 'Причина', value: reason,       inline: false }
                  ).setTimestamp()]
          }).catch(() => {});

          await i.guild.bans.create(target.id, { reason, deleteMessageDays: deleteDays });

          // Лог
          const logChan = client.channels.cache.get(config.channels.logId);
          if (logChan) {
              await logChan.send({
                  embeds: [new EmbedBuilder().setColor(EMBED_COLOR).setTitle('🔨 Бан выдан')
                      .addFields(
                          { name: 'Участник',         value: `${target} \`${target.id}\``, inline: true },
                          { name: 'Модератор',         value: `${i.user}`,                 inline: true },
                          { name: 'Удалено сообщений', value: `За ${deleteDays} дн.`,      inline: true },
                          { name: 'Причина',           value: reason,                      inline: false }
                      ).setTimestamp()]
              });
          }

          return i.reply({
              embeds: [new EmbedBuilder().setColor(EMBED_COLOR).setTitle('Бан выдан')
                  .addFields(
                      { name: 'Участник', value: `${target}`, inline: true },
                      { name: 'Причина',  value: reason,      inline: false }
                  ).setTimestamp()],
              flags: [MessageFlags.Ephemeral]
          });
      }
  }

  // ── Select Menu (наборы) ───────────────────────────────────
  if (i.isStringSelectMenu() && i.customId === 'r:select') {
      const type = i.values[0];
      if (type === 'mod' && !config.status.recruitment.moderator)
          return i.reply({ content: "Набор в Staff временно закрыт.", flags: [MessageFlags.Ephemeral] });
      if ((type === 'yt' || type === 'tt') && !config.status.recruitment.media)
          return i.reply({ content: "Набор в Media временно закрыт.", flags: [MessageFlags.Ephemeral] });

      const modal = new ModalBuilder().setCustomId(`rm:${type}`).setTitle('Анкета кандидата');
      if (type === 'mod') {
          modal.addComponents(
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('1').setLabel('Возраст').setStyle(TextInputStyle.Short).setRequired(true)),
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('2').setLabel('Опыт (где были модератором?)').setStyle(TextInputStyle.Paragraph).setRequired(true)),
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('3').setLabel('Знание правил (1-10)').setStyle(TextInputStyle.Short).setRequired(true)),
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('4').setLabel('Почему мы должны взять именно вас?').setStyle(TextInputStyle.Paragraph).setRequired(true))
          );
      } else {
          modal.addComponents(
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('1').setLabel('Ссылка на канал/TikTok').setStyle(TextInputStyle.Short).setRequired(true)),
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('2').setLabel('Количество просмотров/сабов').setStyle(TextInputStyle.Short).setRequired(true)),
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('3').setLabel('Ваши идеи для контента по нашему читу').setStyle(TextInputStyle.Paragraph).setRequired(true))
          );
      }
      return i.showModal(modal);
  }

  // ── Buttons ────────────────────────────────────────────────
  if (i.isButton()) {
      if (i.customId === 't:open') {
          if (!config.status.tickets) return i.reply({ embeds: [createStyledEmbed("Тех. работы", "Система тикетов временно отключена.")], flags: [MessageFlags.Ephemeral] });
          const channelName = `ticket-${i.user.username.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
          const existing = i.guild.channels.cache.find(c => c.name === channelName);
          if (existing) return i.reply({ content: `У вас уже есть открытый тикет: ${existing}`, flags: [MessageFlags.Ephemeral] });
          const modal = new ModalBuilder().setCustomId('t:modal').setTitle('Техническое обращение')
              .addComponents(new ActionRowBuilder().addComponents(
                  new TextInputBuilder().setCustomId('text').setLabel('Детальное описание проблемы').setStyle(TextInputStyle.Paragraph).setMinLength(10).setRequired(true)
              ));
          return i.showModal(modal);
      }

      if (i.customId.startsWith('t:close:')) {
          const tId = i.customId.split(':')[2];
          await i.reply({ content: "Формирование отчета и закрытие...", flags: [MessageFlags.Ephemeral] });
          const messagesFetch = await i.channel.messages.fetch({ limit: 100 });
          const messages = Array.from(messagesFetch.values()).reverse();
          const htmlContent = generateHTMLTranscript(messages, i.channel.name, tId);
          const attachment = new AttachmentBuilder(Buffer.from(htmlContent), { name: `transcript-${tId}.html` });
          const logChan = client.channels.cache.get(config.channels.logId);
          if (logChan) {
              await logChan.send({ 
                  embeds: [createStyledEmbed("🔒 Тикет закрыт", `ID: \`#${tId}\`\nЗакрыл: ${i.user}`)],
                  files: [attachment] 
              });
          }
          db.closeTicket.run(i.user.id, Math.floor(Date.now()/1000), tId);
          setTimeout(() => i.channel.delete().catch(() => {}), 3000);
      }

      if (i.customId === 't:force') {
          const channelName = `ticket-${i.user.username.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
          const existing = i.guild.channels.cache.find(c => c.name === channelName);
          if (existing) return i.reply({ content: "Тикет уже был создан.", flags: [MessageFlags.Ephemeral] });
          const data = ticketSessions.get(i.user.id);
          if (!data) return i.reply({ content: "Ошибка сессии.", flags: [MessageFlags.Ephemeral] });
          await createTicketChannel(i, data.problem);
          ticketSessions.delete(i.user.id);
      }

      if (i.customId.startsWith('r:accept:') || i.customId.startsWith('r:reject:')) {
          if (!isAdmin) return i.reply({ content: "Доступ закрыт.", flags: [MessageFlags.Ephemeral] });
          const parts = i.customId.split(':');
          const action = parts[1]; // accept or reject
          const type = parts[2];   // mod, yt, tt
          const userId = parts[3];
          const member = await i.guild.members.fetch(userId).catch(() => null);
          if (!member) return i.reply({ content: "Пользователь не найден на сервере.", flags: [MessageFlags.Ephemeral] });

          await i.update({ components: [] });

          const typeName = type === 'yt' ? 'YouTube' : type === 'tt' ? 'TikTok' : 'Support';
          let message;
          if (action === 'reject') {
              if (type === 'yt') {
                  message = `Заявка на YouTube - Arbuz Client:\nОтказано. На YouTube принимаем минимум при среднем количестве в 500 просмотров и 100 подписчиков.`;
              } else if (type === 'tt') {
                  message = `Заявка на TikTok - Arbuz Client:\nОтказано. На TikTok принимаем минимум при среднем количестве в 1000 просмотров`;
              } else {
                  message = `Заявка на Support - Arbuz Client:\nОтказано.`;
              }
          } else {
              if (type === 'yt') {
                  message = `Заявка на YouTube - Arbuz Client:\nПринято. Берем тебя на стажировку в 2 недели, подписку для съемок мы тебе предоставим, после стажировки при хороших результатах ты получишь личный промокод на скидку 10% и возможность получать подписку каждые 2 недели.\n\nПредоставь пожалуйста скриншот студии (док-ва, что ютуб канал является твоим личным)`;
              } else if (type === 'tt') {
                  message = `Заявка на TikTok - Arbuz Client:\nПринято. Берем тебя на стажировку в 2 недели, подписку для съемок мы тебе предоставим, после стажировки при хороших результатах ты получишь личный промокод на скидку 10% и возможность получать подписку каждые 2 недели.\n\nПредоставь пожалуйста скриншот профиля (док-ва, что тикток канал является твоим личным)`;
              } else {
                  message = `Заявка на Support - Arbuz Client:\nПринято. Ожидайте инструкций от администрации.`;
              }
          }

          const safeName = member.user.username.toLowerCase().replace(/[^a-z0-9]/g, '');
          const channel = await i.guild.channels.create({
              name: `ticket-${safeName}`,
              parent: config.channels.ticketCategoryId,
              permissionOverwrites: [
                  { id: i.guild.id,                   deny:  [PermissionFlagsBits.ViewChannel] },
                  { id: member.user.id,               allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles] },
                  { id: config.roles.moderatorRoleId,  allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
              ]
          });
          const problem = `${action === 'accept' ? 'Принята' : 'Отклонена'} заявка: ${typeName}`;
          const res = db.createTicket.run(member.user.id, channel.id, problem, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000));
          const tId = res.lastInsertRowid;
          const closeRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`t:close:${tId}`).setLabel('Закрыть тикет').setStyle(ButtonStyle.Danger)
          );
          await channel.send({ content: `<@${member.user.id}>\n\n${message}`, components: [closeRow] });
      }

      if (i.customId.startsWith('s:t:')) {
          if (!isAdmin) return i.reply({ content: "Доступ закрыт.", flags: [MessageFlags.Ephemeral] });
          const target = i.customId.split(':')[2];
          if (target === 'tickets') config.status.tickets = !config.status.tickets;
          if (target === 'ai')      config.status.ai      = !config.status.ai;
          if (target === 'mod')     config.status.recruitment.moderator = !config.status.recruitment.moderator;
          if (target === 'media')   config.status.recruitment.media     = !config.status.recruitment.media;
          fs.writeFileSync('./config.json', JSON.stringify(config, null, 4));
          return i.update({ components: [createSettingsRow(config)] });
      }
  }

  // ── Modals ─────────────────────────────────────────────────
  if (i.isModalSubmit()) {
      if (i.customId === 't:modal') {
          await i.deferReply({ flags: [MessageFlags.Ephemeral] });
          const text    = i.fields.getTextInputValue('text');
          const aiReply = await askAI(text);
          if (!aiReply || aiReply === "Решение не найдено.") {
              await createTicketChannel(i, text);
          } else {
              ticketSessions.set(i.user.id, { problem: text });
              const row = new ActionRowBuilder().addComponents(
                  new ButtonBuilder().setCustomId('t:force').setLabel('Не помогло, создать тикет').setStyle(ButtonStyle.Primary)
              );
              await i.editReply({ embeds: [createStyledEmbed("Предлагаемое решение", aiReply)], components: [row] });
          }
      }

      if (i.customId.startsWith('rm:')) {
          const logChan = client.channels.cache.get(config.channels.recruitmentLogId);
          if (logChan) {
              const type   = i.customId.split(':')[1];
              const fields = i.fields.fields.map(f => ({ name: `Вопрос #${f.customId}`, value: f.value, inline: false }));
              const row = new ActionRowBuilder().addComponents(
                  new ButtonBuilder().setCustomId(`r:accept:${type}:${i.user.id}`).setLabel('Принять').setStyle(ButtonStyle.Success),
                  new ButtonBuilder().setCustomId(`r:reject:${type}:${i.user.id}`).setLabel('Отклонить').setStyle(ButtonStyle.Danger)
              );
              logChan.send({ embeds: [createStyledEmbed(`Новая заявка: ${type.toUpperCase()}`, `От: ${i.user} (${i.user.id})`).addFields(fields)], components: [row] });
          }
          await i.reply({ content: "Ваша заявка отправлена.", flags: [MessageFlags.Ephemeral] });
      }
  }
});

/* ==========================================
   ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
   ========================================== */

function parseDuration(input) {
    const match = input.trim().match(/^(\d+)\s*(мин|ч|дн|m|h|d)$/i);
    if (!match) return null;
    const value = parseInt(match[1]);
    const unit  = match[2].toLowerCase();
    let minutes;
    if (unit === 'мин' || unit === 'm') minutes = value;
    else if (unit === 'ч'  || unit === 'h') minutes = value * 60;
    else if (unit === 'дн' || unit === 'd') minutes = value * 1440;
    if (minutes < 1 || minutes > 40320) return null; // макс 28 дней
    return minutes;
}

function createSettingsRow(conf) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('s:t:tickets').setLabel('Тикеты').setStyle(conf.status.tickets ? ButtonStyle.Success : ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('s:t:ai').setLabel('ИИ').setStyle(conf.status.ai ? ButtonStyle.Success : ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('s:t:mod').setLabel('Модеры').setStyle(conf.status.recruitment.moderator ? ButtonStyle.Success : ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('s:t:media').setLabel('Медиа').setStyle(conf.status.recruitment.media ? ButtonStyle.Success : ButtonStyle.Danger)
    );
}

function generateHTMLTranscript(messages, channelName, ticketId) {
    const msgsHtml = messages.map(m => {
        const time = m.createdAt.toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        const attachments = m.attachments.map(a => 
            a.contentType?.startsWith('image/') 
            ? `<img src="${a.url}" style="max-width:400px;border-radius:8px;margin-top:10px;display:block;">` 
            : `<a href="${a.url}" class="attachment">📎 Файл: ${a.name}</a>`
        ).join('');
        return `<div class="message"><div class="meta"><span class="author">${m.author.tag}</span><span class="time">${time}</span></div><div class="content">${m.content.replace(/\n/g, '<br>')}${attachments}</div></div>`;
    }).join('');

    return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><style>body{background:#0f0f0f;color:#e0e0e0;font-family:'Inter',sans-serif;line-height:1.6;padding:40px;margin:0}.container{max-width:800px;margin:0 auto}header{margin-bottom:40px;border-bottom:1px solid #2b2d31;padding-bottom:20px}h1{font-size:20px;font-weight:500;color:#fff;margin:0}.ticket-info{font-size:13px;color:#888;margin-top:5px}.message{margin-bottom:25px}.meta{display:flex;align-items:baseline;gap:10px;margin-bottom:4px}.author{font-weight:600;color:#fff;font-size:14px}.time{font-size:11px;color:#555}.content{font-size:14px;color:#ccc;word-wrap:break-word}.attachment{display:inline-block;margin-top:10px;padding:5px 12px;background:#2b2d31;border-radius:4px;color:#fff;text-decoration:none;font-size:12px}</style><title>Transcript #${ticketId}</title></head><body><div class="container"><header><h1>Transcript — ${channelName}</h1><div class="ticket-info">ID: ${ticketId}</div></header>${msgsHtml}</div></body></html>`;
}

async function createTicketChannel(i, problem) {
    try {
        const safeName = i.user.username.toLowerCase().replace(/[^a-z0-9]/g, '');
        const channel  = await i.guild.channels.create({
            name: `ticket-${safeName}`,
            parent: config.channels.ticketCategoryId,
            permissionOverwrites: [
                { id: i.guild.id,                   deny:  [PermissionFlagsBits.ViewChannel] },
                { id: i.user.id,                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles] },
                { id: config.roles.moderatorRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
            ]
        });
        const res = db.createTicket.run(i.user.id, channel.id, problem, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000));
        const tId = res.lastInsertRowid;
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`t:close:${tId}`).setLabel('Закрыть тикет').setStyle(ButtonStyle.Danger)
        );
        await channel.send({ content: `<@&${config.roles.moderatorRoleId}>`, embeds: [createStyledEmbed(`Обращение #${tId}`, `**От:** ${i.user}\n**Проблема:** ${problem}`)], components: [row] });
        const ok = createStyledEmbed("Тикет создан", `Перейдите в канал: ${channel}`);
        if (i.deferred || i.replied) await i.editReply({ embeds: [ok], components: [] });
        else await i.reply({ embeds: [ok], flags: [MessageFlags.Ephemeral] });
    } catch (e) { console.error(e); }
}

client.login(process.env.TOKEN);
