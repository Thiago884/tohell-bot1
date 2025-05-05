const { 
  EmbedBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  ModalBuilder, 
  TextInputBuilder, 
  TextInputStyle,
  ApplicationCommandOptionType,
  MessageFlags
} = require('discord.js');
const { dbConnection, formatBrazilianDate, safeSend, notifyWebhook } = require('./utils');

// Comandos Slash
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
    name: 'monitorar',
    description: 'Monitora um personagem para receber notificações de progresso',
    options: [
      {
        name: 'nome',
        description: 'Nome do personagem para monitorar',
        type: ApplicationCommandOptionType.String,
        required: true
      },
      {
        name: 'canal',
        description: 'Canal para enviar notificações (opcional)',
        type: ApplicationCommandOptionType.Channel,
        required: false
      }
    ]
  },
  {
    name: 'parar-monitorar',
    description: 'Para de monitorar um personagem',
    options: [
      {
        name: 'nome',
        description: 'Nome do personagem para parar de monitorar',
        type: ApplicationCommandOptionType.String,
        required: true
      }
    ]
  },
  {
    name: 'listar-monitorados',
    description: 'Lista todos os personagens sendo monitorados'
  },
  {
    name: 'ajuda',
    description: 'Mostra todos os comandos disponíveis'
  },
  {
    name: 'admin-permissoes',
    description: 'Gerencia permissões de comandos para cargos (Admin only)',
    options: [
      {
        name: 'comando',
        description: 'Comando para gerenciar permissões',
        type: ApplicationCommandOptionType.String,
        required: true,
        choices: [
          { name: 'pendentes', value: 'pendentes' },
          { name: 'buscar', value: 'buscar' },
          { name: 'char', value: 'char' },
          { name: 'ranking', value: 'ranking' },
          { name: 'monitorar', value: 'monitorar' },
          { name: 'parar-monitorar', value: 'parar-monitorar' },
          { name: 'listar-monitorados', value: 'listar-monitorados' }
        ]
      },
      {
        name: 'acao',
        description: 'Ação a ser realizada',
        type: ApplicationCommandOptionType.String,
        required: true,
        choices: [
          { name: 'Adicionar cargo', value: 'add' },
          { name: 'Remover cargo', value: 'remove' },
          { name: 'Listar cargos', value: 'list' }
        ]
      },
      {
        name: 'cargo',
        description: 'Cargo para adicionar/remover (não necessário para listar)',
        type: ApplicationCommandOptionType.Role,
        required: false
      }
    ]
  }
];

// Função para listar inscrições pendentes com paginação
async function listPendingApplications(context, args) {
  const page = args[0] ? parseInt(args[0]) : 1;
  
  if (isNaN(page) || page < 1) {
    return context.reply({ content: 'Por favor, especifique um número de página válido.', flags: MessageFlags.Ephemeral });
  }

  try {
    const offset = (page - 1) * 5; // ITEMS_PER_PAGE = 5
    
    const [countRows] = await dbConnection.execute(
      'SELECT COUNT(*) as total FROM inscricoes_pendentes'
    );
    const total = countRows[0].total;
    const totalPages = Math.ceil(total / 5);

    if (total === 0) {
      return context.reply({ content: 'Não há inscrições pendentes no momento.', flags: MessageFlags.Ephemeral });
    }

    if (page > totalPages) {
      return context.reply({ content: `Apenas ${totalPages} páginas disponíveis.`, flags: MessageFlags.Ephemeral });
    }

    const [rows] = await dbConnection.execute(
      'SELECT * FROM inscricoes_pendentes ORDER BY data_inscricao DESC LIMIT ? OFFSET ?',
      [5, offset]
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
    await context.reply({ content: 'Ocorreu um erro ao listar as inscrições pendentes.', flags: MessageFlags.Ephemeral });
  }
}

// Função para buscar inscrições
async function searchApplications(context, args) {
  if (args.length === 0) {
    return context.reply({ content: 'Por favor, especifique um termo de busca.', flags: MessageFlags.Ephemeral });
  }

  const searchTerm = args[0];
  const page = args[1] ? parseInt(args[1]) : 1;
  
  if (isNaN(page) || page < 1) {
    return context.reply({ content: 'Por favor, especifique um número de página válido.', flags: MessageFlags.Ephemeral });
  }

  try {
    const offset = (page - 1) * 5;
    const searchPattern = `%${searchTerm}%`;
    
    // Busca nas inscrições pendentes
    const [countRowsPendentes] = await dbConnection.execute(
      'SELECT COUNT(*) as total FROM inscricoes_pendentes WHERE nome LIKE ? OR discord LIKE ? OR telefone LIKE ?',
      [searchPattern, searchPattern, searchPattern]
    );
    
    // Busca nas inscrições aprovadas
    const [countRowsAprovadas] = await dbConnection.execute(
      'SELECT COUNT(*) as total FROM inscricoes WHERE (nome LIKE ? OR discord LIKE ? OR telefone LIKE ?) AND status = "aprovado"',
      [searchPattern, searchPattern, searchPattern]
    );
    
    const total = countRowsPendentes[0].total + countRowsAprovadas[0].total;
    const totalPages = Math.ceil(total / 5);

    if (total === 0) {
      return context.reply({ content: 'Nenhuma inscrição encontrada com esse termo de busca.', flags: MessageFlags.Ephemeral });
    }

    if (page > totalPages) {
      return context.reply({ content: `Apenas ${totalPages} páginas disponíveis para esta busca.`, flags: MessageFlags.Ephemeral });
    }

    // Busca combinada nas duas tabelas
    const [rowsPendentes] = await dbConnection.execute(
      'SELECT *, "pendente" as status FROM inscricoes_pendentes WHERE nome LIKE ? OR discord LIKE ? OR telefone LIKE ? ORDER BY data_inscricao DESC LIMIT ? OFFSET ?',
      [searchPattern, searchPattern, searchPattern, 5, offset]
    );
    
    // Ajusta o offset para a segunda consulta se necessário
    const remaining = 5 - rowsPendentes.length;
    let rowsAprovadas = [];
    
    if (remaining > 0) {
      const aprovadasOffset = Math.max(0, offset - countRowsPendentes[0].total);
      [rowsAprovadas] = await dbConnection.execute(
        'SELECT *, "aprovado" as status FROM inscricoes WHERE (nome LIKE ? OR discord LIKE ? OR telefone LIKE ?) AND status = "aprovado" ORDER BY data_inscricao DESC LIMIT ? OFFSET ?',
        [searchPattern, searchPattern, searchPattern, remaining, aprovadasOffset]
      );
    }
    
    const rows = [...rowsPendentes, ...rowsAprovadas];

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
    await context.reply({ content: 'Ocorreu um erro ao buscar inscrições.', flags: MessageFlags.Ephemeral });
  }
}

// Função para enviar embed de inscrição
async function sendApplicationEmbed(channel, application) {
  const screenshots = JSON.parse(application.screenshot_path || '[]');
  const screenshotLinks = screenshots.slice(0, 5).map((screenshot, index) => 
    `[Imagem ${index + 1}](${screenshot})`
  ).join('\n') || 'Nenhuma imagem enviada';

  const embed = new EmbedBuilder()
    .setColor(application.status === 'aprovado' ? '#00FF00' : '#FF4500')
    .setTitle(`Inscrição #${application.id} (${application.status === 'aprovado' ? 'Aprovada' : 'Pendente'})`)
    .setDescription(`**${application.nome}** deseja se juntar à guild!`)
    .addFields(
      { name: '📱 Telefone', value: application.telefone, inline: true },
      { name: '🎮 Discord', value: application.discord, inline: true },
      { name: '⚔️ Char Principal', value: application.char_principal, inline: true },
      { name: '🏰 Guild Anterior', value: application.guild_anterior || 'Nenhuma', inline: true },
      { name: '📸 Screenshots', value: screenshotLinks, inline: false },
      { name: '📅 Data', value: formatBrazilianDate(application.data_inscricao), inline: true },
      { name: '🌐 IP', value: application.ip || 'Não registrado', inline: true }
    )
    .setFooter({ text: 'ToHeLL Guild - Use os botões ou reações para aprovar/rejeitar' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`approve_${application.id}`)
      .setLabel('Aprovar')
      .setStyle(ButtonStyle.Success)
      .setDisabled(application.status === 'aprovado'),
    new ButtonBuilder()
      .setCustomId(`reject_${application.id}`)
      .setLabel('Rejeitar')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(application.status === 'aprovado')
  );

  const msg = await safeSend(channel, { 
    embeds: [embed],
    components: [row]
  });

  if (msg && application.status !== 'aprovado') {
    try {
      await msg.react('👍');
      await msg.react('👎');
    } catch (error) {
      console.error('❌ Erro ao adicionar reações:', error);
    }
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

  try {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ 
        embeds: [embed], 
        flags: MessageFlags.Ephemeral 
      });
    } else if (interaction.deferred && !interaction.replied) {
      await interaction.editReply({ 
        embeds: [embed] 
      });
    }
  } catch (error) {
    console.error('❌ Erro ao mostrar ajuda:', error);
  }
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
        flags: MessageFlags.Ephemeral 
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
        flags: MessageFlags.Ephemeral 
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
        flags: MessageFlags.Ephemeral 
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
        flags: MessageFlags.Ephemeral 
      }).catch(console.error);
    }
  }
}

// Função para configurar os comandos (NOVA FUNÇÃO ADICIONADA)
function setupCommands(client) {
  // Registrar comandos slash quando o bot estiver pronto
  client.on('ready', async () => {
    try {
      await client.application.commands.set(slashCommands);
      console.log('✅ Comandos slash registrados com sucesso');
    } catch (error) {
      console.error('❌ Erro ao registrar comandos slash:', error);
    }
  });
}

// Exportações
module.exports = {
  slashCommands,
  listPendingApplications,
  searchApplications,
  sendApplicationEmbed,
  showHelp,
  approveApplication,
  rejectApplication,
  setupCommands, // Exportando a nova função
  commands
};