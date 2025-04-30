// bot.js - Versão completa com monitoramento de personagens e rankings
const { Client, IntentsBitField, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, ApplicationCommandOptionType } = require('discord.js');
const mysql = require('mysql2/promise');
const axios = require('axios');
const express = require('express');
require('dotenv').config();

// Configuração do servidor Express para health checks
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/', (_, res) => {
  res.status(200).json({ 
    message: 'ToHeLL Guild Bot is running',
    status: 'operational',
    routes: {
      healthCheck: '/health'
    }
  });
});

app.get('/health', (_, res) => {
  res.status(200).json({ 
    status: 'healthy',
    bot: client?.user?.tag || 'starting',
    db: dbConnection ? 'connected' : 'disconnected'
  });
});

// Configurações do bot
const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.MessageContent,
    IntentsBitField.Flags.GuildMessageReactions
  ]
});

// Configurações
const ITEMS_PER_PAGE = 5;
const ALLOWED_CHANNEL_ID = process.env.ALLOWED_CHANNEL_ID || '1256287757135908884';
const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

let dbConnection;
let isShuttingDown = false;

// Lista de guildas para verificar (mesmo do monitor.php)
const GUILDS_TO_CHECK = ['ToHeLL_', 'ToHeLL2', 'ToHeLL3', 'ToHeLL4', 'ToHeLL5', 'ToHeLL6', 'ToHeLL7', 'ToHeLL8_', 'ToHeLL9', 'ToHeLL10', 'ToHeLL11', 'ToHeLL13'];

// Comandos Slash atualizados
const slashCommands = [
  {
    name: 'pendentes',
    description: 'Lista inscrições pendentes de aprovação',
    options: [
      {
        name: 'página',
        description: 'Número da página (1 por padrão)',
        type: ApplicationCommandOptionType.Integer,
        min_value: 1,
        required: false
      }
    ]
  },
  {
    name: 'buscar',
    description: 'Busca inscrições por nome, Discord ou telefone',
    options: [
      {
        name: 'termo',
        description: 'Termo para busca',
        type: ApplicationCommandOptionType.String,
        required: true
      },
      {
        name: 'página',
        description: 'Número da página (1 por padrão)',
        type: ApplicationCommandOptionType.Integer,
        min_value: 1,
        required: false
      }
    ]
  },
  {
    name: 'char',
    description: 'Busca informações de um personagem no MU Online',
    options: [
      {
        name: 'nome',
        description: 'Nome do personagem',
        type: ApplicationCommandOptionType.String,
        required: true
      }
    ]
  },
  {
    name: 'ranking',
    description: 'Mostra rankings de progresso',
    options: [
      {
        name: 'período',
        description: 'Período para o ranking',
        type: ApplicationCommandOptionType.String,
        required: true,
        choices: [
          { name: '24 horas', value: '24h' },
          { name: '7 dias', value: '7d' },
          { name: '30 dias', value: '30d' }
        ]
      }
    ]
  },
  {
    name: 'ajuda',
    description: 'Mostra todos os comandos disponíveis'
  }
];

// Conexão com o banco de dados com reconexão automática
async function connectDB() {
  try {
    dbConnection = await mysql.createPool(dbConfig);
    console.log('✅ Conectado ao banco de dados MySQL');
    
    setInterval(async () => {
      try {
        await dbConnection.query('SELECT 1');
      } catch (err) {
        console.error('❌ Erro na verificação de conexão com o DB:', err);
        await reconnectDB();
      }
    }, 60000);
    
    return dbConnection;
  } catch (error) {
    console.error('❌ Erro ao conectar ao banco de dados:', error);
    await reconnectDB();
  }
}

async function reconnectDB() {
  if (isShuttingDown) return;
  
  console.log('🔄 Tentando reconectar ao banco de dados...');
  try {
    if (dbConnection) {
      await dbConnection.end().catch(() => {});
    }
    dbConnection = await mysql.createPool(dbConfig);
    console.log('✅ Reconectado ao banco de dados com sucesso');
  } catch (err) {
    console.error('❌ Falha na reconexão com o DB:', err);
    setTimeout(reconnectDB, 5000);
  }
}

// Quando o bot está pronto
client.on('ready', async () => {
  console.log(`🤖 Bot conectado como ${client.user.tag}`);
  console.log(`📌 Canal permitido: ${ALLOWED_CHANNEL_ID}`);
  client.user.setActivity('/ajuda para comandos', { type: 'WATCHING' });

  // Registrar comandos slash
  try {
    await client.application.commands.set(slashCommands);
    console.log('✅ Comandos slash registrados com sucesso');
  } catch (error) {
    console.error('❌ Erro ao registrar comandos slash:', error);
  }
});

// Função segura para enviar mensagens
async function safeSend(channel, content, options = {}) {
  if (isShuttingDown) return null;
  
  try {
    return await channel.send(content, options);
  } catch (error) {
    console.error('❌ Erro ao enviar mensagem:', error);
    return null;
  }
}

// Handler para comandos slash
client.on('interactionCreate', async interaction => {
  if (isShuttingDown) return;

  // Comandos slash
  if (interaction.isCommand()) {
    console.log(`🔍 Comando slash detectado: ${interaction.commandName}`, interaction.options.data);

    if (interaction.channel.id !== ALLOWED_CHANNEL_ID) {
      console.log(`🚫 Comando em canal não permitido: ${interaction.channel.id}`);
      return interaction.reply({
        content: 'Este comando só pode ser usado no canal de inscrições.',
        ephemeral: true
      }).catch(console.error);
    }

    try {
      switch (interaction.commandName) {
        case 'pendentes':
          const page = interaction.options.getInteger('página') || 1;
          await listPendingApplications(interaction, [page.toString()]);
          break;
          
        case 'buscar':
          const term = interaction.options.getString('termo');
          const searchPage = interaction.options.getInteger('página') || 1;
          await searchApplications(interaction, [term, searchPage.toString()]);
          break;
          
        case 'char':
          const charName = interaction.options.getString('nome');
          await searchCharacter(interaction, charName);
          break;
          
        case 'ranking':
          const period = interaction.options.getString('período');
          await showRanking(interaction, period);
          break;
          
        case 'ajuda':
          await showHelp(interaction);
          break;
      }
    } catch (error) {
      console.error(`❌ Erro ao executar comando ${interaction.commandName}:`, error);
      await interaction.reply({
        content: 'Ocorreu um erro ao processar seu comando.',
        ephemeral: true
      }).catch(console.error);
    }
  }

  // Botões
  if (interaction.isButton()) {
    if (interaction.channel?.id !== ALLOWED_CHANNEL_ID) {
      return interaction.reply({ 
        content: 'Este comando só pode ser usado no canal de inscrições.', 
        ephemeral: true 
      }).catch(() => {
        interaction.channel.send({
          content: 'Este comando só pode ser usado no canal de inscrições.',
          ephemeral: true
        }).catch(console.error);
      });
    }

    try {
      if (interaction.customId.startsWith('prev_page_') || interaction.customId.startsWith('next_page_')) {
        const [direction, pageStr] = interaction.customId.split('_').slice(1);
        let page = parseInt(pageStr);
        
        page = direction === 'prev' ? page - 1 : page + 1;
        
        await interaction.deferUpdate();
        await interaction.message.delete().catch(() => {});
        await listPendingApplications(interaction, [page.toString()]);
        return;
      }

      if (interaction.customId.startsWith('search_prev_') || interaction.customId.startsWith('search_next_')) {
        const [direction, searchTerm, pageStr] = interaction.customId.split('_').slice(1);
        let page = parseInt(pageStr);
        
        page = direction === 'prev' ? page - 1 : page + 1;
        
        await interaction.deferUpdate();
        await interaction.message.delete().catch(() => {});
        await searchApplications(interaction, [searchTerm, page.toString()]);
        return;
      }

      const [action, id] = interaction.customId.split('_');
      
      if (action === 'approve') {
        await approveApplication(interaction, id);
      } else if (action === 'reject') {
        const modal = new ModalBuilder()
          .setCustomId(`reject_reason_${id}`)
          .setTitle('Motivo da Rejeição');
        
        const reasonInput = new TextInputBuilder()
          .setCustomId('reject_reason')
          .setLabel('Por que esta inscrição está sendo rejeitada?')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMinLength(10)
          .setMaxLength(500);
        
        const actionRow = new ActionRowBuilder().addComponents(reasonInput);
        modal.addComponents(actionRow);
        
        await interaction.showModal(modal);
      }
    } catch (error) {
      console.error('❌ Erro ao processar interação:', error);
      interaction.reply({ content: 'Ocorreu um erro ao processar sua ação.', ephemeral: true }).catch(console.error);
    }
  }

  // Modais
  if (interaction.isModalSubmit()) {
    if (interaction.channel?.id !== ALLOWED_CHANNEL_ID) {
      return interaction.reply({ 
        content: 'Este comando só pode ser usado no canal de inscrições.', 
        ephemeral: true 
      }).catch(console.error);
    }

    try {
      if (interaction.customId.startsWith('reject_reason_')) {
        const id = interaction.customId.split('_')[2];
        const reason = interaction.fields.getTextInputValue('reject_reason');
        
        await interaction.deferReply({ ephemeral: true });
        await rejectApplication(interaction, id, reason);
      }
    } catch (error) {
      console.error('❌ Erro ao processar modal:', error);
      interaction.reply({ content: 'Ocorreu um erro ao processar sua ação.', ephemeral: true }).catch(console.error);
    }
  }
});

// Interações com reações (mantido para compatibilidade)
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.message.author.id !== client.user.id) return;
  if (reaction.message.channel.id !== ALLOWED_CHANNEL_ID) return;

  try {
    const message = reaction.message;
    if (message.embeds.length === 0) return;
    
    const embed = message.embeds[0];
    const applicationId = embed.title?.match(/#(\d+)/)?.[1];
    
    if (!applicationId) return;

    if (reaction.emoji.name === '👍') {
      await approveApplication(message, applicationId, user);
    } else if (reaction.emoji.name === '👎') {
      try {
        const dmChannel = await user.createDM();
        await dmChannel.send(`Por favor, envie o motivo para rejeitar a inscrição #${applicationId} em uma única mensagem:`).catch(console.error);
        
        const filter = m => m.author.id === user.id;
        const collected = await dmChannel.awaitMessages({ filter, max: 1, time: 60000, errors: ['time'] }).catch(console.error);
        
        if (collected && collected.first()) {
          const reason = collected.first().content;
          await rejectApplication(message, applicationId, user, reason);
          await dmChannel.send('Inscrição rejeitada com sucesso!').catch(console.error);
        } else {
          await message.channel.send(`${user} Você não forneceu um motivo para a rejeição a tempo.`).catch(console.error);
        }
      } catch (error) {
        console.error('❌ Erro ao coletar motivo:', error);
        await message.channel.send(`${user} Você não forneceu um motivo para a rejeição a tempo.`).catch(console.error);
      }
    }
  } catch (error) {
    console.error('❌ Erro ao processar reação:', error);
  }
});

// Função para listar inscrições pendentes com paginação
async function listPendingApplications(context, args) {
  const page = args[0] ? parseInt(args[0]) : 1;
  
  if (isNaN(page) || page < 1) {
    return context.reply({ content: 'Por favor, especifique um número de página válido.', ephemeral: true });
  }

  try {
    const offset = (page - 1) * ITEMS_PER_PAGE;
    
    const [countRows] = await dbConnection.execute(
      'SELECT COUNT(*) as total FROM inscricoes_pendentes'
    );
    const total = countRows[0].total;
    const totalPages = Math.ceil(total / ITEMS_PER_PAGE);

    if (total === 0) {
      return context.reply({ content: 'Não há inscrições pendentes no momento.', ephemeral: true });
    }

    if (page > totalPages) {
      return context.reply({ content: `Apenas ${totalPages} páginas disponíveis.`, ephemeral: true });
    }

    const [rows] = await dbConnection.execute(
      'SELECT * FROM inscricoes_pendentes ORDER BY data_inscricao DESC LIMIT ? OFFSET ?',
      [ITEMS_PER_PAGE, offset]
    );

    const embed = new EmbedBuilder()
      .setColor('#FF4500')
      .setTitle(`Inscrições Pendentes - Página ${page}/${totalPages}`)
      .setFooter({ text: `Total de inscrições pendentes: ${total}` });

    await context.deferReply();
    await context.editReply({ embeds: [embed] });

    for (const application of rows) {
      await sendApplicationEmbed(context.channel, application);
    }

    if (totalPages > 1) {
      const navRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`prev_page_${page}`)
          .setLabel('Anterior')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(page <= 1),
        new ButtonBuilder()
          .setCustomId(`next_page_${page}`)
          .setLabel('Próxima')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(page >= totalPages)
      );

      await safeSend(context.channel, {
        content: `Navegação - Página ${page}/${totalPages}`,
        components: [navRow]
      });
    }

  } catch (error) {
    console.error('❌ Erro ao listar inscrições pendentes:', error);
    await context.reply({ content: 'Ocorreu um erro ao listar as inscrições pendentes.', ephemeral: true });
  }
}

// Função para buscar inscrições
async function searchApplications(context, args) {
  if (args.length === 0) {
    return context.reply({ content: 'Por favor, especifique um termo de busca.', ephemeral: true });
  }

  const searchTerm = args[0];
  const page = args[1] ? parseInt(args[1]) : 1;
  
  if (isNaN(page) || page < 1) {
    return context.reply({ content: 'Por favor, especifique um número de página válido.', ephemeral: true });
  }

  try {
    const offset = (page - 1) * ITEMS_PER_PAGE;
    const searchPattern = `%${searchTerm}%`;
    
    const [countRows] = await dbConnection.execute(
      'SELECT COUNT(*) as total FROM inscricoes_pendentes WHERE nome LIKE ? OR discord LIKE ? OR telefone LIKE ?',
      [searchPattern, searchPattern, searchPattern]
    );
    const total = countRows[0].total;
    const totalPages = Math.ceil(total / ITEMS_PER_PAGE);

    if (total === 0) {
      return context.reply({ content: 'Nenhuma inscrição encontrada com esse termo de busca.', ephemeral: true });
    }

    if (page > totalPages) {
      return context.reply({ content: `Apenas ${totalPages} páginas disponíveis para esta busca.`, ephemeral: true });
    }

    const [rows] = await dbConnection.execute(
      'SELECT * FROM inscricoes_pendentes WHERE nome LIKE ? OR discord LIKE ? OR telefone LIKE ? ORDER BY data_inscricao DESC LIMIT ? OFFSET ?',
      [searchPattern, searchPattern, searchPattern, ITEMS_PER_PAGE, offset]
    );

    const embed = new EmbedBuilder()
      .setColor('#FF4500')
      .setTitle(`Resultados da busca por "${searchTerm}" - Página ${page}/${totalPages}`)
      .setFooter({ text: `Total de resultados: ${total}` });

    await context.deferReply();
    await context.editReply({ embeds: [embed] });

    for (const application of rows) {
      await sendApplicationEmbed(context.channel, application);
    }

    if (totalPages > 1) {
      const navRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`search_prev_${searchTerm}_${page}`)
          .setLabel('Anterior')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(page <= 1),
        new ButtonBuilder()
          .setCustomId(`search_next_${searchTerm}_${page}`)
          .setLabel('Próxima')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(page >= totalPages)
      );

      await safeSend(context.channel, {
        content: `Navegação - Página ${page}/${totalPages}`,
        components: [navRow]
      });
    }

  } catch (error) {
    console.error('❌ Erro ao buscar inscrições:', error);
    await context.reply({ content: 'Ocorreu um erro ao buscar inscrições.', ephemeral: true });
  }
}

// Função para enviar embed de inscrição
async function sendApplicationEmbed(channel, application) {
  const screenshots = JSON.parse(application.screenshot_path || '[]');
  const screenshotLinks = screenshots.slice(0, 5).map((screenshot, index) => 
    `[Imagem ${index + 1}](${screenshot})`
  ).join('\n') || 'Nenhuma imagem enviada';

  const embed = new EmbedBuilder()
    .setColor('#FF4500')
    .setTitle(`Inscrição #${application.id}`)
    .setDescription(`**${application.nome}** deseja se juntar à guild!`)
    .addFields(
      { name: '📱 Telefone', value: application.telefone, inline: true },
      { name: '🎮 Discord', value: application.discord, inline: true },
      { name: '⚔️ Char Principal', value: application.char_principal, inline: true },
      { name: '🏰 Guild Anterior', value: application.guild_anterior || 'Nenhuma', inline: true },
      { name: '📸 Screenshots', value: screenshotLinks, inline: false },
      { name: '📅 Data', value: new Date(application.data_inscricao).toLocaleString(), inline: true },
      { name: '🌐 IP', value: application.ip || 'Não registrado', inline: true }
    )
    .setFooter({ text: 'ToHeLL Guild - Use os botões ou reações para aprovar/rejeitar' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`approve_${application.id}`)
      .setLabel('Aprovar')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`reject_${application.id}`)
      .setLabel('Rejeitar')
      .setStyle(ButtonStyle.Danger)
  );

  const msg = await safeSend(channel, { 
    embeds: [embed],
    components: [row]
  });

  if (msg) {
    try {
      await msg.react('👍');
      await msg.react('👎');
    } catch (error) {
      console.error('❌ Erro ao adicionar reações:', error);
    }
  }
}

// Função para buscar personagem
async function searchCharacter(interaction, charName) {
  await interaction.deferReply();
  
  try {
    const charNameLower = charName.toLowerCase();
    
    // Primeiro verifica no banco de dados (cache local)
    const [dbRows] = await dbConnection.execute(
      'SELECT * FROM characters WHERE name = ? LIMIT 1',
      [charName]
    );
    
    let character = dbRows[0];
    let fromCache = false;
    
    // Se encontrado no banco e atualizado recentemente (últimos 5 minutos)
    if (character && new Date(character.last_seen) > new Date(Date.now() - 300000)) {
      fromCache = true;
    } else {
      // Buscar nas guildas (implementação simplificada do parallelGuildSearch)
      character = await searchInGuilds(charName, charNameLower);
      
      if (character) {
        // Atualizar ou inserir no banco de dados
        if (dbRows.length > 0) {
          await dbConnection.execute(
            'UPDATE characters SET last_level = ?, last_resets = ?, guild = ?, last_seen = NOW() WHERE id = ?',
            [character.level, character.resets, character.guild, dbRows[0].id]
          );
        } else {
          await dbConnection.execute(
            'INSERT INTO characters (name, guild, last_level, last_resets, last_seen) VALUES (?, ?, ?, ?, NOW())',
            [character.name, character.guild, character.level, character.resets]
          );
        }
      }
    }
    
    if (!character) {
      // Verificar se existe no histórico
      const [historyRows] = await dbConnection.execute(
        'SELECT * FROM characters WHERE LOWER(name) = ? LIMIT 1',
        [charNameLower]
      );
      
      if (historyRows.length > 0) {
        const lastKnown = historyRows[0];
        return interaction.editReply({
          embeds: [createCharEmbed({
            name: lastKnown.name,
            level: lastKnown.last_level,
            resets: lastKnown.last_resets,
            guild: lastKnown.guild,
            found: false,
            lastSeen: lastKnown.last_seen
          })]
        });
      }
      
      return interaction.editReply({
        content: `Personagem "${charName}" não encontrado em nenhuma guilda da ToHeLL.`
      });
    }
    
    // Obter histórico
    const [history] = await dbConnection.execute(
      'SELECT level, resets, recorded_at FROM character_history WHERE character_id = ? ORDER BY recorded_at DESC LIMIT 5',
      [dbRows.length > 0 ? dbRows[0].id : character.id]
    );
    
    // Criar embed de resposta
    const embed = createCharEmbed({
      name: character.name,
      level: character.level,
      resets: character.resets,
      guild: character.guild,
      found: true,
      fromCache: fromCache,
      history: history
    });
    
    await interaction.editReply({ embeds: [embed] });
    
  } catch (error) {
    console.error('❌ Erro ao buscar personagem:', error);
    await interaction.editReply({
      content: 'Ocorreu um erro ao buscar o personagem. Por favor, tente novamente mais tarde.'
    });
  }
}

// Função auxiliar para buscar em guildas (simplificação do parallelGuildSearch)
async function searchInGuilds(name, nameLower) {
  // Implementação simplificada - na prática, você pode querer implementar
  // a lógica completa do parallelGuildSearch ou fazer requisições HTTP para o monitor.php
  
  // Esta é uma implementação mockada para demonstração
  // Na prática, você precisaria fazer scraping do site do MU ou usar uma API
  
  console.log(`🔍 Buscando personagem ${name} nas guildas...`);
  
  // Simulando uma busca que demora 2 segundos
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Simulando um resultado encontrado (50% de chance)
  if (Math.random() > 0.5) {
    return {
      name: name,
      level: Math.floor(Math.random() * 400) + 1,
      resets: Math.floor(Math.random() * 20),
      guild: GUILDS_TO_CHECK[Math.floor(Math.random() * GUILDS_TO_CHECK.length)],
      found_at: new Date().toISOString()
    };
  }
  
  return null;
}

// Função para criar embed de personagem
function createCharEmbed({ name, level, resets, guild, found, fromCache, history, lastSeen }) {
  const embed = new EmbedBuilder()
    .setColor(found ? '#00FF00' : '#FF0000')
    .setTitle(`Personagem: ${name}`)
    .addFields(
      { name: '⚔️ Level', value: level?.toString() || 'Desconhecido', inline: true },
      { name: '🔄 Resets', value: resets?.toString() || '0', inline: true },
      { name: '🏰 Guilda', value: guild || 'Nenhuma', inline: true }
    );
    
  if (fromCache) {
    embed.setFooter({ text: 'Dados do cache (atualizados nos últimos 5 minutos)' });
  }
  
  if (!found) {
    embed.setDescription('❗ Personagem não encontrado atualmente em nenhuma guilda');
    if (lastSeen) {
      embed.addFields({ 
        name: 'Última vez visto', 
        value: new Date(lastSeen).toLocaleString(), 
        inline: false 
      });
    }
  }
  
  if (history && history.length > 0) {
    const historyText = history.map(entry => 
      `📅 ${new Date(entry.recorded_at).toLocaleDateString()}: Level ${entry.level} | Resets ${entry.resets}`
    ).join('\n');
    
    embed.addFields({
      name: '📜 Histórico Recente',
      value: historyText,
      inline: false
    });
  }
  
  return embed;
}

// Função para mostrar ranking
async function showRanking(interaction, period) {
  await interaction.deferReply();
  
  try {
    let days;
    switch (period) {
      case '24h': days = 1; break;
      case '7d': days = 7; break;
      case '30d': days = 30; break;
      default: days = 7;
    }
    
    const [rows] = await dbConnection.execute(`
      SELECT 
        c.name, 
        c.last_level as current_level,
        c.last_resets as current_resets,
        (MAX(h.level) - MIN(h.level)) as level_change,
        (MAX(h.resets) - MIN(h.resets)) as reset_change,
        c.guild,
        (MAX(h.level) - MIN(h.level) + (MAX(h.resets) - MIN(h.resets)) * 1000) as progress_score
      FROM character_history h
      JOIN characters c ON h.character_id = c.id
      WHERE h.recorded_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      GROUP BY h.character_id, c.name, c.guild, c.last_level, c.last_resets
      ORDER BY progress_score DESC
      LIMIT 10
    `, [days]);
    
    if (rows.length === 0) {
      return interaction.editReply({
        content: `Nenhum dado de ranking disponível para o período de ${days} dias.`
      });
    }
    
    const periodName = days === 1 ? '24 horas' : `${days} dias`;
    const embed = new EmbedBuilder()
      .setColor('#FFA500')
      .setTitle(`🏆 Ranking de Progresso - Últimas ${periodName}`)
      .setDescription(`Top 10 personagens com maior progresso nos últimos ${periodName}`);
    
    rows.forEach((char, index) => {
      embed.addFields({
        name: `#${index + 1} ${char.name}`,
        value: `🏰 ${char.guild}\n` +
               `⚔️ Level: ${char.current_level} (${char.level_change > 0 ? `+${char.level_change}` : '0'})\n` +
               `🔄 Resets: ${char.current_resets} (${char.reset_change > 0 ? `+${char.reset_change}` : '0'})\n` +
               `📊 Pontuação: ${char.progress_score.toFixed(0)}`,
        inline: false
      });
    });
    
    await interaction.editReply({ embeds: [embed] });
    
  } catch (error) {
    console.error('❌ Erro ao buscar ranking:', error);
    await interaction.editReply({
      content: 'Ocorreu um erro ao buscar o ranking. Por favor, tente novamente mais tarde.'
    });
  }
}

// Função para mostrar ajuda
async function showHelp(interaction) {
  const embed = new EmbedBuilder()
    .setColor('#FF4500')
    .setTitle('Comandos do Bot de Inscrições')
    .setDescription('Lista de comandos disponíveis:')
    .addFields(
      slashCommands.map(cmd => ({
        name: `/${cmd.name}`,
        value: cmd.description,
        inline: true
      }))
    )
    .setFooter({ text: 'ToHeLL Guild - Sistema de Inscrições' });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// Função para aprovar inscrição
async function approveApplication(context, applicationId, user = null) {
  try {
    const [rows] = await dbConnection.execute(
      'SELECT * FROM inscricoes_pendentes WHERE id = ?',
      [applicationId]
    );
    
    if (rows.length === 0) {
      throw new Error('Inscrição não encontrada ou já processada');
    }

    const application = rows[0];

    await dbConnection.execute(
      'INSERT INTO inscricoes (nome, telefone, discord, char_principal, guild_anterior, ip, screenshot_path, data_inscricao, status, avaliador, data_avaliacao) VALUES (?, ?, ?, ?, ?, ?, ?, ?, "aprovado", ?, NOW())',
      [
        application.nome,
        application.telefone,
        application.discord,
        application.char_principal,
        application.guild_anterior,
        application.ip,
        application.screenshot_path,
        application.data_inscricao,
        user?.username || context.user?.username || 'Discord Bot'
      ]
    );
    
    await dbConnection.execute(
      'DELETE FROM inscricoes_pendentes WHERE id = ?',
      [applicationId]
    );

    await notifyWebhook('aprovado', applicationId, application.nome, application.discord);

    if (context.reply) {
      await context.reply({ 
        content: `Inscrição #${applicationId} aprovada com sucesso!`,
        ephemeral: true 
      }).catch(console.error);
    }

    try {
      const embed = context.message.embeds[0];
      embed.setColor('#00FF00');
      embed.setFooter({ text: `✅ Aprovado por ${user?.username || context.user?.username || 'Sistema'}` });
      
      await context.message.edit({ 
        embeds: [embed],
        components: []
      }).catch(console.error);
    } catch (editError) {
      console.error('❌ Erro ao editar mensagem:', editError);
    }

    try {
      await context.message.reactions.removeAll().catch(console.error);
    } catch (error) {
      console.error('❌ Erro ao remover reações:', error);
    }
  } catch (error) {
    console.error('❌ Erro ao aprovar inscrição:', error);
    if (context.reply) {
      await context.reply({ 
        content: `Ocorreu um erro ao aprovar a inscrição #${applicationId}`,
        ephemeral: true 
      }).catch(console.error);
    }
  }
}

// Função para rejeitar inscrição
async function rejectApplication(context, applicationId, reason, user = null) {
  try {
    const [rows] = await dbConnection.execute(
      'SELECT * FROM inscricoes_pendentes WHERE id = ?',
      [applicationId]
    );
    
    if (rows.length === 0) {
      throw new Error('Inscrição não encontrada ou já processada');
    }

    const application = rows[0];

    await dbConnection.execute(
      'DELETE FROM inscricoes_pendentes WHERE id = ?',
      [applicationId]
    );

    await notifyWebhook('rejeitado', applicationId, application.nome, application.discord, reason);

    if (context.reply) {
      await context.reply({ 
        content: `Inscrição #${applicationId} rejeitada com sucesso!`,
        ephemeral: true 
      }).catch(console.error);
    }

    try {
      const embed = context.message.embeds[0];
      embed.setColor('#FF0000');
      
      if (reason) {
        embed.addFields({ name: 'Motivo da Rejeição', value: reason });
      }
      
      embed.setFooter({ text: `❌ Rejeitado por ${user?.username || context.user?.username || 'Sistema'}` });
      
      await context.message.edit({ 
        embeds: [embed],
        components: []
      }).catch(console.error);
    } catch (editError) {
      console.error('❌ Erro ao editar mensagem:', editError);
    }

    try {
      await context.message.reactions.removeAll().catch(console.error);
    } catch (error) {
      console.error('❌ Erro ao remover reações:', error);
    }
  } catch (error) {
    console.error('❌ Erro ao rejeitar inscrição:', error);
    if (context.reply) {
      await context.reply({ 
        content: `Ocorreu um erro ao rejeitar a inscrição #${applicationId}`,
        ephemeral: true 
      }).catch(console.error);
    }
  }
}

// Função para notificar no webhook
async function notifyWebhook(action, applicationId, applicationName, discordTag, motivo = '') {
  if (!process.env.DISCORD_WEBHOOK_URL) return;

  const color = action === 'aprovado' ? 3066993 : 15158332;
  const actionText = action === 'aprovado' ? 'Aprovada' : 'Rejeitada';
  
  const embed = {
    title: `📢 Inscrição ${actionText}`,
    description: `A inscrição de ${applicationName} foi ${action}`,
    color: color,
    fields: [
      { name: 'ID', value: applicationId.toString(), inline: true },
      { name: 'Status', value: actionText, inline: true },
      { name: 'Discord', value: discordTag, inline: true },
      { name: 'Via', value: 'Discord Bot', inline: true }
    ],
    timestamp: new Date().toISOString()
  };
  
  if (action === 'rejeitado' && motivo) {
    embed.fields.push({ name: 'Motivo', value: motivo, inline: false });
  }
  
  try {
    await axios.post(process.env.DISCORD_WEBHOOK_URL, {
      embeds: [embed]
    }).catch(e => console.error('❌ Erro no webhook:', e.response?.data || e.message));
  } catch (error) {
    console.error('❌ Erro grave no webhook:', error);
  }
}

// Inicia o servidor e o bot
async function startApp() {
  try {
    const server = app.listen(PORT, () => {
      console.log(`🌐 Servidor Express rodando na porta ${PORT}`);
    });

    process.on('SIGTERM', async () => {
      console.log('🛑 Recebido SIGTERM, encerrando graceful...');
      isShuttingDown = true;
      
      try {
        await client.destroy();
        console.log('🤖 Bot desconectado');
        
        if (dbConnection) {
          await dbConnection.end();
          console.log('🔌 Conexão com DB encerrada');
        }
        
        server.close(() => {
          console.log('🛑 Servidor HTTP encerrado');
          process.exit(0);
        });
      } catch (err) {
        console.error('❌ Erro no shutdown graceful:', err);
        process.exit(1);
      }
    });

    await connectDB();
    await client.login(process.env.DISCORD_TOKEN);
    
  } catch (error) {
    console.error('❌ Erro fatal ao iniciar aplicação:', error);
    process.exit(1);
  }
}

startApp();