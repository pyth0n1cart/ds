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
const DM_DELAY_MS = 1200;
const PROGRESS_EVERY = 100;
let isBroadcastRunning = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  const text = args.join(" ").trim();
  if (!text) {
    await message.reply(`Использование: \`${prefix}${commandName} ваш текст\``);
    return;
  }

  if (isBroadcastRunning) {
    await message.reply("Рассылка уже идет. Дождитесь завершения текущей.");
    return;
  }

  isBroadcastRunning = true;
  await message.reply(
    `Начинаю рассылку в личные сообщения участникам (безопасный режим: ~${DM_DELAY_MS} мс между сообщениями)...`
  );

  let sent = 0;
  let failed = 0;
  let processed = 0;
  const successfulRecipients = [];

  try {
    const members = await message.guild.members.fetch();
    const humanMembers = [...members.values()].filter((member) => !member.user.bot);
    const total = humanMembers.length;

    for (const member of humanMembers) {
      try {
        await member.send(text);
        sent += 1;
        successfulRecipients.push(`<@${member.id}>`);
      } catch (err) {
        failed += 1;
      }

      processed += 1;
      if (processed % PROGRESS_EVERY === 0 || processed === total) {
        await message.channel.send(
          `Прогресс: **${processed}/${total}** | доставлено: **${sent}** | ошибки: **${failed}**`
        );
      }

      await sleep(DM_DELAY_MS);
    }

    await message.channel.send(
      `Готово. Успешно отправлено: **${sent}**, не удалось отправить: **${failed}**.`
    );

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
