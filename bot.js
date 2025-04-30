// bot.js
const { Client, IntentsBitField, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const mysql = require('mysql2/promise');
const axios = require('axios');
require('dotenv').config();

const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.MessageContent
  ]
});

// Configurações
const ITEMS_PER_PAGE = 5;
const ALLOWED_CHANNEL_ID = '1256287757135908884'; // Canal permitido
const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3306
};

let dbConnection;

// Conexão com o banco de dados
async function connectDB() {
  try {
    dbConnection = await mysql.createConnection(dbConfig);
    console.log('Conectado ao banco de dados MySQL');
  } catch (error) {
    console.error('Erro ao conectar ao banco de dados:', error);
    process.exit(1);
  }
}

// Comandos do bot
const commands = {
  '!pendentes': {
    description: 'Lista inscrições pendentes (use !pendentes [página] para navegar)',
    execute: listPendingApplications
  },
  '!buscar': {
    description: 'Busca inscrições por nome, Discord ou telefone (!buscar termo [página])',
    execute: searchApplications
  },
  '!ajuda': {
    description: 'Mostra todos os comandos disponíveis',
    execute: showHelp
  }
};

// Quando o bot está pronto
client.on('ready', () => {
  console.log(`Bot conectado como ${client.user.tag}`);
});

// Função segura para enviar mensagens
async function safeSend(channel, content, options = {}) {
  try {
    return await channel.send(content, options);
  } catch (error) {
    console.error('Erro ao enviar mensagem:', error);
    return null;
  }
}

// Quando uma mensagem é recebida
client.on('messageCreate', async message => {
  // Ignora mensagens de bots e que não começam com !
  if (message.author.bot || !message.content.startsWith('!')) return;

  const args = message.content.slice(1).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // Verifica se o comando existe
  if (commands[command]) {
    // Verifica se está no canal permitido
    if (message.channel.id !== ALLOWED_CHANNEL_ID) {
      try {
        await message.author.send('Este comando só pode ser usado no canal de inscrições.').catch(() => {});
        await message.delete().catch(() => {});
      } catch (error) {
        console.error('Erro ao processar mensagem em canal não permitido:', error);
      }
      return;
    }

    // Verifica permissões do bot
    if (!message.channel.permissionsFor(client.user).has('SendMessages')) {
      return console.error('Bot não tem permissão para enviar mensagens neste canal');
    }

    try {
      await commands[command].execute(message, args);
    } catch (error) {
      console.error('Erro ao executar comando:', error);
      await safeSend(message.channel, 'Ocorreu um erro ao processar seu comando.');
    }
  }
});

// Função para listar inscrições pendentes com paginação
async function listPendingApplications(message, args) {
  const page = args[0] ? parseInt(args[0]) : 1;
  
  if (isNaN(page) || page < 1) {
    return safeSend(message.channel, 'Por favor, especifique um número de página válido.');
  }

  try {
    const offset = (page - 1) * ITEMS_PER_PAGE;
    
    // Conta o total de inscrições pendentes
    const [countRows] = await dbConnection.execute(
      'SELECT COUNT(*) as total FROM inscricoes_pendentes'
    );
    const total = countRows[0].total;
    const totalPages = Math.ceil(total / ITEMS_PER_PAGE);

    if (total === 0) {
      return safeSend(message.channel, 'Não há inscrições pendentes no momento.');
    }

    if (page > totalPages) {
      return safeSend(message.channel, `Apenas ${totalPages} páginas disponíveis.`);
    }

    // Obtém as inscrições da página atual
    const [rows] = await dbConnection.execute(
      'SELECT * FROM inscricoes_pendentes ORDER BY data_inscricao DESC LIMIT ? OFFSET ?',
      [ITEMS_PER_PAGE, offset]
    );

    // Cria mensagem com paginação
    const embed = new EmbedBuilder()
      .setColor('#FF4500')
      .setTitle(`Inscrições Pendentes - Página ${page}/${totalPages}`)
      .setFooter({ text: `Total de inscrições pendentes: ${total}` });

    await safeSend(message.channel, { embeds: [embed] });

    // Envia cada inscrição como uma mensagem separada
    for (const application of rows) {
      await sendApplicationEmbed(message.channel, application);
    }

    // Adiciona navegação se houver mais páginas
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

      await safeSend(message.channel, {
        content: `Navegação - Página ${page}/${totalPages}`,
        components: [navRow]
      });
    }

  } catch (error) {
    console.error('Erro ao listar inscrições pendentes:', error);
    await safeSend(message.channel, 'Ocorreu um erro ao listar as inscrições pendentes.');
  }
}

// Função para buscar inscrições
async function searchApplications(message, args) {
  if (args.length === 0) {
    return safeSend(message.channel, 'Por favor, especifique um termo de busca.');
  }

  const searchTerm = args[0];
  const page = args[1] ? parseInt(args[1]) : 1;
  
  if (isNaN(page) || page < 1) {
    return safeSend(message.channel, 'Por favor, especifique um número de página válido.');
  }

  try {
    const offset = (page - 1) * ITEMS_PER_PAGE;
    const searchPattern = `%${searchTerm}%`;
    
    // Conta o total de resultados
    const [countRows] = await dbConnection.execute(
      'SELECT COUNT(*) as total FROM inscricoes_pendentes WHERE nome LIKE ? OR discord LIKE ? OR telefone LIKE ?',
      [searchPattern, searchPattern, searchPattern]
    );
    const total = countRows[0].total;
    const totalPages = Math.ceil(total / ITEMS_PER_PAGE);

    if (total === 0) {
      return safeSend(message.channel, 'Nenhuma inscrição encontrada com esse termo de busca.');
    }

    if (page > totalPages) {
      return safeSend(message.channel, `Apenas ${totalPages} páginas disponíveis para esta busca.`);
    }

    // Obtém os resultados da busca
    const [rows] = await dbConnection.execute(
      'SELECT * FROM inscricoes_pendentes WHERE nome LIKE ? OR discord LIKE ? OR telefone LIKE ? ORDER BY data_inscricao DESC LIMIT ? OFFSET ?',
      [searchPattern, searchPattern, searchPattern, ITEMS_PER_PAGE, offset]
    );

    // Cria mensagem com resultados
    const embed = new EmbedBuilder()
      .setColor('#FF4500')
      .setTitle(`Resultados da busca por "${searchTerm}" - Página ${page}/${totalPages}`)
      .setFooter({ text: `Total de resultados: ${total}` });

    await safeSend(message.channel, { embeds: [embed] });

    // Envia cada inscrição encontrada
    for (const application of rows) {
      await sendApplicationEmbed(message.channel, application);
    }

    // Adiciona navegação se houver mais páginas
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

      await safeSend(message.channel, {
        content: `Navegação - Página ${page}/${totalPages}`,
        components: [navRow]
      });
    }

  } catch (error) {
    console.error('Erro ao buscar inscrições:', error);
    await safeSend(message.channel, 'Ocorreu um erro ao buscar inscrições.');
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
      console.error('Erro ao adicionar reações:', error);
    }
  }
}

// Função para mostrar ajuda
async function showHelp(message) {
  const embed = new EmbedBuilder()
    .setColor('#FF4500')
    .setTitle('Comandos do Bot de Inscrições')
    .setDescription('Lista de comandos disponíveis:')
    .addFields(
      Object.entries(commands).map(([cmd, info]) => ({
        name: cmd,
        value: info.description,
        inline: true
      }))
    )
    .setFooter({ text: 'ToHeLL Guild - Sistema de Inscrições' });

  const helpMessage = await safeSend(message.channel, { embeds: [embed] });
  
  if (helpMessage) {
    try {
      await helpMessage.react('✅');
      // Deleta a mensagem após 30 segundos
      setTimeout(() => {
        helpMessage.delete().catch(() => {});
      }, 30000);
    } catch (error) {
      console.error('Erro ao adicionar reação:', error);
    }
  }
}

// Interações com botões
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  
  // Verificação segura do canal
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
    // Navegação de páginas
    if (interaction.customId.startsWith('prev_page_') || interaction.customId.startsWith('next_page_')) {
      const [direction, pageStr] = interaction.customId.split('_').slice(1);
      let page = parseInt(pageStr);
      
      page = direction === 'prev' ? page - 1 : page + 1;
      
      await interaction.deferUpdate();
      await interaction.message.delete().catch(() => {});
      await listPendingApplications(interaction, [page.toString()]);
      return;
    }

    // Navegação de busca
    if (interaction.customId.startsWith('search_prev_') || interaction.customId.startsWith('search_next_')) {
      const [direction, searchTerm, pageStr] = interaction.customId.split('_').slice(1);
      let page = parseInt(pageStr);
      
      page = direction === 'prev' ? page - 1 : page + 1;
      
      await interaction.deferUpdate();
      await interaction.message.delete().catch(() => {});
      await searchApplications(interaction, [searchTerm, page.toString()]);
      return;
    }

    // Aprovar/Rejeitar
    const [action, id] = interaction.customId.split('_');
    
    if (action === 'approve') {
      await approveApplication(interaction, id);
    } else if (action === 'reject') {
      // Cria um modal para coletar o motivo da rejeição
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
    console.error('Erro ao processar interação:', error);
    interaction.reply({ content: 'Ocorreu um erro ao processar sua ação.', ephemeral: true }).catch(console.error);
  }
});

// Interações com modais (para motivo de rejeição)
client.on('interactionCreate', async interaction => {
  if (!interaction.isModalSubmit()) return;
  
  // Verificação segura do canal
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
    console.error('Erro ao processar modal:', error);
    interaction.reply({ content: 'Ocorreu um erro ao processar sua ação.', ephemeral: true }).catch(console.error);
  }
});

// Interações com reações
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.message.author.id !== client.user.id) return;
  
  // Verifica se a reação foi adicionada no canal permitido
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
      // Para reações, pedimos o motivo via DM
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
        console.error('Erro ao coletar motivo:', error);
        await message.channel.send(`${user} Você não forneceu um motivo para a rejeição a tempo.`).catch(console.error);
      }
    }
  } catch (error) {
    console.error('Erro ao processar reação:', error);
  }
});

// Função para aprovar inscrição
async function approveApplication(context, applicationId, user = null) {
  try {
    // Obtém os dados da inscrição
    const [rows] = await dbConnection.execute(
      'SELECT * FROM inscricoes_pendentes WHERE id = ?',
      [applicationId]
    );
    
    if (rows.length === 0) {
      throw new Error('Inscrição não encontrada ou já processada');
    }

    const application = rows[0];

    // Move para a tabela de inscrições aprovadas
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
    
    // Remove da tabela de pendentes
    await dbConnection.execute(
      'DELETE FROM inscricoes_pendentes WHERE id = ?',
      [applicationId]
    );

    // Notifica no webhook
    await notifyWebhook('aprovado', applicationId, application.nome, application.discord);

    // Resposta diferente para diferentes tipos de contexto
    if (context.reply) {
      await context.reply({ 
        content: `Inscrição #${applicationId} aprovada com sucesso!`,
        ephemeral: true 
      }).catch(console.error);
    }

    // Atualiza a mensagem original
    try {
      const embed = context.message.embeds[0];
      embed.setColor('#00FF00');
      embed.setFooter({ text: `✅ Aprovado por ${user?.username || context.user?.username || 'Sistema'}` });
      
      await context.message.edit({ 
        embeds: [embed],
        components: [] // Remove os botões
      }).catch(console.error);
    } catch (editError) {
      console.error('Erro ao editar mensagem:', editError);
    }

    // Remove todas as reações
    try {
      await context.message.reactions.removeAll().catch(console.error);
    } catch (error) {
      console.error('Erro ao remover reações:', error);
    }
  } catch (error) {
    console.error('Erro ao aprovar inscrição:', error);
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
    // Obtém os dados da inscrição
    const [rows] = await dbConnection.execute(
      'SELECT * FROM inscricoes_pendentes WHERE id = ?',
      [applicationId]
    );
    
    if (rows.length === 0) {
      throw new Error('Inscrição não encontrada ou já processada');
    }

    const application = rows[0];

    // Remove da tabela de pendentes
    await dbConnection.execute(
      'DELETE FROM inscricoes_pendentes WHERE id = ?',
      [applicationId]
    );

    // Notifica no webhook
    await notifyWebhook('rejeitado', applicationId, application.nome, application.discord, reason);

    // Resposta diferente para diferentes tipos de contexto
    if (context.reply) {
      await context.reply({ 
        content: `Inscrição #${applicationId} rejeitada com sucesso!`,
        ephemeral: true 
      }).catch(console.error);
    }

    // Atualiza a mensagem original
    try {
      const embed = context.message.embeds[0];
      embed.setColor('#FF0000');
      
      // Adiciona o motivo da rejeição ao embed se existir
      if (reason) {
        embed.addFields({ name: 'Motivo da Rejeição', value: reason });
      }
      
      embed.setFooter({ text: `❌ Rejeitado por ${user?.username || context.user?.username || 'Sistema'}` });
      
      await context.message.edit({ 
        embeds: [embed],
        components: [] // Remove os botões
      }).catch(console.error);
    } catch (editError) {
      console.error('Erro ao editar mensagem:', editError);
    }

    // Remove todas as reações
    try {
      await context.message.reactions.removeAll().catch(console.error);
    } catch (error) {
      console.error('Erro ao remover reações:', error);
    }
  } catch (error) {
    console.error('Erro ao rejeitar inscrição:', error);
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
    }).catch(e => console.error('Erro no webhook:', e.response?.data || e.message));
  } catch (error) {
    console.error('Erro grave no webhook:', error);
  }
}

// Inicia o bot
async function startBot() {
  try {
    await connectDB();
    await client.login(process.env.DISCORD_TOKEN);
  } catch (error) {
    console.error('Erro ao iniciar o bot:', error);
    process.exit(1);
  }
}

startBot();

const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (_, res) => res.send('Bot online.'));
app.listen(PORT, () => console.log(`Servidor escutando na porta ${PORT}`));