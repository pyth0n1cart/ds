require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  ChannelType
} = require("discord.js");

const token = process.env.DISCORD_TOKEN;
const prefix = "!";
const commandName = "рассылка";
const MAX_DISCORD_MESSAGE_LENGTH = 2000;
const DM_DELAY_MIN_MS = 3500;
const DM_DELAY_MAX_MS = 7000;
const QUEUE_CHUNK_SIZE = 5;
const QUEUE_CHUNK_PAUSE_MS = 120000;
const PROGRESS_EVERY = 100;
let isBroadcastRunning = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRandomDelayMs() {
  return Math.floor(Math.random() * (DM_DELAY_MAX_MS - DM_DELAY_MIN_MS + 1)) + DM_DELAY_MIN_MS;
}

function splitIntoDiscordChunks(text, maxLength = MAX_DISCORD_MESSAGE_LENGTH) {
  if (text.length <= maxLength) return [text];

  const lines = text.split("\n");
  const chunks = [];
  let current = "";

  for (const line of lines) {
    const withNewline = current.length === 0 ? line : `\n${line}`;
    if (current.length + withNewline.length <= maxLength) {
      current += withNewline;
      continue;
    }

    if (current.length > 0) {
      chunks.push(current);
      current = "";
    }

    if (line.length <= maxLength) {
      current = line;
      continue;
    }

    for (let i = 0; i < line.length; i += maxLength) {
      chunks.push(line.slice(i, i + maxLength));
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

function extractRoleId(rawRole) {
  if (!rawRole) return null;
  const mentionMatch = rawRole.match(/^<@&(\d+)>$/);
  if (mentionMatch) return mentionMatch[1];
  const idMatch = rawRole.match(/^\d+$/);
  if (idMatch) return rawRole;
  return null;
}

if (!token) {
  console.error("Ошибка: DISCORD_TOKEN не найден в .env");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

client.once("clientReady", () => {
  client.user.setPresence({
    status: "online",
    activities: []
  });
  console.log(`Бот запущен как ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(prefix)) return;

  const [cmd, ...args] = message.content.slice(prefix.length).trim().split(/\s+/);
  if (cmd.toLowerCase() !== commandName) return;

  if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    await message.reply("Только администратор может использовать эту команду.");
    return;
  }

  const [roleArg, ...textArgs] = args;
  const roleId = extractRoleId(roleArg);
  const text = textArgs.join(" ").trim();
  if (!roleId || !text) {
    await message.reply(`Использование: \`${prefix}${commandName} @Роль ваш текст\``);
    return;
  }

  if (isBroadcastRunning) {
    await message.reply("Рассылка уже идет. Дождитесь завершения текущей.");
    return;
  }

  isBroadcastRunning = true;
  await message.reply(
    `Начинаю рассылку в личные сообщения участникам (очередь: ${QUEUE_CHUNK_SIZE} пользователей за проход, пауза ${Math.floor(QUEUE_CHUNK_PAUSE_MS / 1000)} сек между проходами)...`
  );

  let sent = 0;
  let failed = 0;
  let processed = 0;
  const successfulRecipients = [];
  const failureStats = new Map();
  let antiSpamLimited = false;

  try {
    const role = message.guild.roles.cache.get(roleId) ?? await message.guild.roles.fetch(roleId);
    if (!role) {
      await message.reply("Роль не найдена. Укажи корректное упоминание роли или ID.");
      return;
    }

    const members = await message.guild.members.fetch();
    const targetMembers = [...members.values()].filter(
      (member) => !member.user.bot && member.roles.cache.has(role.id)
    );
    const total = targetMembers.length;
    const queueChunks = [];

    if (total === 0) {
      await message.reply(`У роли ${role.toString()} нет подходящих участников для рассылки.`);
      return;
    }

    for (let i = 0; i < targetMembers.length; i += QUEUE_CHUNK_SIZE) {
      queueChunks.push(targetMembers.slice(i, i + QUEUE_CHUNK_SIZE));
    }

    await message.channel.send(
      `Целевая роль: ${role.toString()}, участников для рассылки: **${total}**, проходов очереди: **${queueChunks.length}**.`
    );

    const dmChunks = splitIntoDiscordChunks(text);

    for (let chunkIndex = 0; chunkIndex < queueChunks.length; chunkIndex += 1) {
      const queueChunk = queueChunks[chunkIndex];
      await message.channel.send(
        `Очередь ${chunkIndex + 1}/${queueChunks.length}: обрабатываю ${queueChunk.length} пользователей...`
      );

      for (const member of queueChunk) {
        try {
          for (const chunk of dmChunks) {
            await member.send(chunk);
          }
          sent += 1;
          successfulRecipients.push(`<@${member.id}>`);
        } catch (err) {
          failed += 1;
          const errorCode = err?.code ? String(err.code) : "UNKNOWN";
          if (errorCode === "20026") {
            antiSpamLimited = true;
            break;
          }
          const currentCount = failureStats.get(errorCode) ?? 0;
          failureStats.set(errorCode, currentCount + 1);
        }

        processed += 1;
        if (processed % PROGRESS_EVERY === 0 || processed === total) {
          await message.channel.send(
            `Прогресс: **${processed}/${total}** | доставлено: **${sent}** | ошибки: **${failed}**`
          );
        }

        if (antiSpamLimited) {
          break;
        }
        await sleep(getRandomDelayMs());
      }

      if (antiSpamLimited) {
        break;
      }

      if (chunkIndex < queueChunks.length - 1) {
        await message.channel.send(
          `Пауза ${Math.floor(QUEUE_CHUNK_PAUSE_MS / 1000)} сек перед следующим проходом очереди...`
        );
        await sleep(QUEUE_CHUNK_PAUSE_MS);
      }
    }

    await message.channel.send(
      `Готово. Успешно отправлено: **${sent}**, не удалось отправить: **${failed}**.`
    );

    if (antiSpamLimited) {
      await message.channel.send(
        "Discord временно ограничил массовую отправку ЛС для бота. Подожди и повтори позже."
      );
    }

    if (failureStats.size > 0) {
      const topFailures = [...failureStats.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([code, count]) => `\`${code}\`: ${count}`)
        .join(", ");
      await message.channel.send(`Коды ошибок отправки (топ): ${topFailures}`);
    }

    if (successfulRecipients.length > 0) {
      let currentChunk = "Доставлено пользователям:\n";
      const chunks = [];

      for (const mention of successfulRecipients) {
        const line = `${mention}\n`;
        if (currentChunk.length + line.length > MAX_DISCORD_MESSAGE_LENGTH) {
          chunks.push(currentChunk.trimEnd());
          currentChunk = line;
        } else {
          currentChunk += line;
        }
      }

      if (currentChunk.trim().length > 0) {
        chunks.push(currentChunk.trimEnd());
      }

      for (const chunk of chunks) {
        await message.channel.send(chunk);
      }
    }
  } catch (err) {
    console.error("Ошибка при рассылке:", err);
    const channel = message.channel;
    if (channel && channel.type === ChannelType.GuildText) {
      await channel.send("Произошла ошибка при рассылке.");
    } else {
      await message.reply("Произошла ошибка при рассылке.");
    }
  } finally {
    isBroadcastRunning = false;
  }
});

async function startBot() {
  while (true) {
    try {
      await client.login(token);
      break;
    } catch (err) {
      console.error("Не удалось подключиться к Discord. Повтор через 10 секунд.", err);
      await sleep(10000);
    }
  }
}

startBot();
