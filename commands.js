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
const { formatBrazilianDate, safeSend, notifyWebhook, searchCharacterWithCache, calculateAdvancedStats, createCharEmbed, safeInteractionReply, isValidImageUrl, get500RCharacters } = require('./utils');
const { safeExecuteQuery } = require('./database');

// Configuração da URL base para imagens
const BASE_URL = process.env.BASE_URL || 'https://tohellguild.com.br/';

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
          { name: 'consultar-telefone', value: 'consultar-telefone' }
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
  },
  {
    name: 'admin-notificacoes',
    description: 'Gerencia quem recebe notificações por DM (Admin only)',
    options: [
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
        name: 'tipo',
        description: 'O tipo de notificação a ser gerenciada',
        type: ApplicationCommandOptionType.String,
        required: true,
        choices: [
          { name: 'Inscrição Pendente', value: 'inscricao_pendente' },
          { name: 'Alerta de Segurança (Membro vs Inimigo)', value: 'alerta_seguranca' }
        ]
      },
      {
        name: 'cargo',
        description: 'O cargo para adicionar ou remover da notificação',
        type: ApplicationCommandOptionType.Role,
        required: false
      }
    ]
  },
  {
    name: 'bloquear-ip',
    description: 'Bloqueia um IP no sistema',
    options: [
      {
        name: 'ip',
        description: 'Endereço IP para bloquear',
        type: ApplicationCommandOptionType.String,
        required: true
      },
      {
        name: 'motivo',
        description: 'Motivo do bloqueio',
        type: ApplicationCommandOptionType.String,
        required: true
      }
    ]
  },
  {
    name: 'desbloquear-ip',
    description: 'Remove um IP da lista de bloqueados',
    options: [
      {
        name: 'ip',
        description: 'Endereço IP para desbloquear',
        type: ApplicationCommandOptionType.String,
        required: true
      }
    ]
  },
  {
    name: 'consultar-ip',
    description: 'Consulta informações sobre um IP',
    options: [
      {
        name: 'ip',
        description: 'Endereço IP para consultar',
        type: ApplicationCommandOptionType.String,
        required: true
      }
    ]
  },
  {
    name: 'relatorio-seguranca',
    description: 'Gera relatório de segurança',
    options: [
      {
        name: 'periodo',
        description: 'Período do relatório',
        type: ApplicationCommandOptionType.String,
        required: false,
        choices: [
          { name: 'Últimas 24 horas', value: '24h' },
          { name: 'Últimos 7 dias', value: '7d' },
          { name: 'Últimos 30 dias', value: '30d' }
        ]
      }
    ]
  },
  {
    name: 'ultimos-acessos',
    description: 'Lista os últimos acessos ao site',
    options: [
      {
        name: 'limite',
        description: 'Número de registros a retornar (padrão: 10)',
        type: ApplicationCommandOptionType.Integer,
        min_value: 1,
        max_value: 50,
        required: false
      },
      {
        name: 'pais',
        description: 'Filtrar por país (código de 2 letras)',
        type: ApplicationCommandOptionType.String,
        required: false
      }
    ]
  },
  {
    name: 'whitelist',
    description: 'Gerencia a lista de IPs permitidos',
    options: [
      {
        name: 'acao',
        description: 'Ação a ser realizada',
        type: ApplicationCommandOptionType.String,
        required: true,
        choices: [
          { name: 'Adicionar IP', value: 'add' },
          { name: 'Remover IP', value: 'remove' },
          { name: 'Listar IPs', value: 'list' }
        ]
      },
      {
        name: 'ip',
        description: 'Endereço IP (não necessário para listar)',
        type: ApplicationCommandOptionType.String,
        required: false
      },
      {
        name: 'motivo',
        description: 'Motivo para whitelist (opcional)',
        type: ApplicationCommandOptionType.String,
        required: false
      }
    ]
  },
  {
    name: 'consultar-telefone',
    description: 'Consulta informações de um número de telefone',
    options: [
      {
        name: 'telefone',
        description: 'Número de telefone no formato internacional (ex: +5511999999999)',
        type: ApplicationCommandOptionType.String,
        required: true
      }
    ]
  },
  {
    name: 'char500',
    description: 'Lista personagens com 500+ resets'
  }
];

// Função para converter caminhos em URLs completas
function processImageUrls(imageData) {
  try {
    // Se for string, tentar parsear como JSON
    const urls = typeof imageData === 'string' ? JSON.parse(imageData || '[]') : imageData || [];

    // Converter para array se não for
    const urlArray = Array.isArray(urls) ? urls : [urls];

    // Mapear para URLs completas se necessário
    return urlArray.map(url => {
      if (!url) return null;
      return url.startsWith('http') ? url : `${BASE_URL}${url.replace(/^\/+/, '')}`;
    }).filter(url => url !== null);
  } catch (error) {
    console.error('Erro ao processar URLs de imagem:', error);
    return [];
  }
}

// =================================================================================
// CORREÇÃO APLICADA AQUI
// =================================================================================
// Função para criar um carrossel de imagens (CORRIGIDA)
async function createImageCarousel(interaction, images, applicationId, status) {
  const processedImages = processImageUrls(images);
  
  if (processedImages.length === 0) {
    return safeInteractionReply(interaction, {
      content: 'Nenhuma imagem válida disponível para exibição.',
      flags: MessageFlags.Ephemeral
    });
  }

  const currentIndex = 0;
  const totalImages = processedImages.length;

  if (!processedImages[currentIndex] || !isValidImageUrl(processedImages[currentIndex])) {
    return safeInteractionReply(interaction, {
      content: 'A URL da imagem é inválida.',
      flags: MessageFlags.Ephemeral
    });
  }

  const embed = new EmbedBuilder()
    .setColor('#FF4500')
    .setTitle(`Screenshots da Inscrição #${applicationId} (${status === 'aprovado' ? 'Aprovada' : 'Pendente'})`)
    .setImage(processedImages[currentIndex])
    .setFooter({ text: `Imagem ${currentIndex + 1} de ${totalImages}` });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`carousel_prev_${applicationId}_${status}_${currentIndex}`)
      .setLabel('◀️ Anterior')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true), // Começa desabilitado
    new ButtonBuilder()
      .setCustomId(`carousel_close_${applicationId}_${status}_${currentIndex}`)
      .setLabel('❌ Fechar')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`carousel_next_${applicationId}_${status}_${currentIndex}`)
      .setLabel('Próxima ▶️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(totalImages <= 1)
  );
  
  // Usa safeInteractionReply em vez de .reply() para lidar com interações adiadas
  return safeInteractionReply(interaction, {
    embeds: [embed],
    components: [row],
    flags: MessageFlags.Ephemeral
  });
}
// =================================================================================

// Função para normalizar números de telefone (mais robusta)
function normalizePhoneForSearch(phone) {
  if (!phone) return null;

  // Remove tudo que não é dígito, incluindo o caractere '+' se presente
  const digits = phone.replace(/\D/g, '');

  // Se o número começar com código de país (ex: 55), remove para busca mais ampla
  if (digits.startsWith('55') && digits.length > 10) {
    return digits.substring(2); // Remove o '55' do início
  }

  // Se tiver 11 dígitos e começar com 0, remove o 0
  if (digits.length === 11 && digits.startsWith('0')) {
    return digits.substring(1);
  }

  return digits;
}

// Função para listar inscrições pendentes com paginação
async function listPendingApplications(context, args) {
  const page = args[0] ? parseInt(args[0]) : 1;

  if (isNaN(page) || page < 1) {
    return safeInteractionReply(context, {
      content: 'Por favor, especifique um número de página válido.',
      flags: MessageFlags.Ephemeral
    });
  }

  try {
    const offset = (page - 1) * 5;

    const countRows = await safeExecuteQuery(
      'SELECT COUNT(*) as total FROM inscricoes_pendentes'
    );
    const total = countRows[0].total;
    const totalPages = Math.ceil(total / 5);

    if (total === 0) {
      return safeInteractionReply(context, {
        content: 'Não há inscrições pendentes no momento.',
      });
    }

    if (page > totalPages) {
      return safeInteractionReply(context, {
        content: `Apenas ${totalPages} páginas disponíveis.`,
        flags: MessageFlags.Ephemeral
      });
    }

    const rows = await safeExecuteQuery(
      'SELECT * FROM inscricoes_pendentes ORDER BY data_inscricao DESC LIMIT ? OFFSET ?',
      [5, offset]
    );

    const embed = new EmbedBuilder()
      .setColor('#FF4500')
      .setTitle(`Inscrições Pendentes - Página ${page}/${totalPages}`)
      .setFooter({ text: `Total de inscrições pendentes: ${total}` });

    await safeInteractionReply(context, { embeds: [embed] });

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
    await safeInteractionReply(context, {
      content: 'Ocorreu um erro ao listar as inscrições pendentes.',
      flags: MessageFlags.Ephemeral
    });
  }
}

// Função para buscar inscrições (atualizada para normalização robusta de telefones)
async function searchApplications(context, args) {
  if (args.length === 0) {
    return safeInteractionReply(context, {
      content: 'Por favor, especifique um termo de busca.',
      flags: MessageFlags.Ephemeral
    });
  }

  const searchTerm = args[0];
  const page = args[1] ? parseInt(args[1]) : 1;

  if (isNaN(page) || page < 1) {
    return safeInteractionReply(context, {
      content: 'Por favor, especifique um número de página válido.',
      flags: MessageFlags.Ephemeral
    });
  }

  try {
    const offset = (page - 1) * 5;

    // Normaliza o termo de busca para telefone
    const normalizedSearchTerm = normalizePhoneForSearch(searchTerm);

    // Se o termo de busca parece ser um número de telefone, busca de forma especial
    const isPhoneSearch = normalizedSearchTerm && normalizedSearchTerm.length >= 8;

    const searchPattern = `%${searchTerm}%`;
    const phoneSearchPattern = isPhoneSearch ? `%${normalizedSearchTerm}%` : null;

    let countQuery, countParams;
    let dataQuery, dataParams;

    if (isPhoneSearch) {
      // Busca especial para telefones - normaliza ambos os lados
      countQuery = `
        SELECT COUNT(*) as total FROM (
          SELECT id, nome, telefone, discord, data_inscricao, 'pendente' as status 
          FROM inscricoes_pendentes 
          WHERE REPLACE(REPLACE(REPLACE(REPLACE(telefone, '(', ''), ')', ''), ' ', ''), '-', '') LIKE ?
          UNION ALL
          SELECT id, nome, telefone, discord, data_inscricao, 'aprovado' as status 
          FROM inscricoes 
          WHERE status = 'aprovado' 
          AND REPLACE(REPLACE(REPLACE(REPLACE(telefone, '(', ''), ')', ''), ' ', ''), '-', '') LIKE ?
        ) as combined
      `;

      countParams = [phoneSearchPattern, phoneSearchPattern];

      dataQuery = `
        SELECT * FROM (
          SELECT id, nome, telefone, discord, char_principal, guild_anterior, ip, 
                 screenshot_path, data_inscricao, 'pendente' as status 
          FROM inscricoes_pendentes 
          WHERE REPLACE(REPLACE(REPLACE(REPLACE(telefone, '(', ''), ')', ''), ' ', ''), '-', '') LIKE ?
          UNION ALL
          SELECT id, nome, telefone, discord, char_principal, guild_anterior, ip, 
                 screenshot_path, data_inscricao, 'aprovado' as status 
          FROM inscricoes 
          WHERE status = 'aprovado' 
          AND REPLACE(REPLACE(REPLACE(REPLACE(telefone, '(', ''), ')', ''), ' ', ''), '-', '') LIKE ?
        ) as combined 
        ORDER BY data_inscricao DESC 
        LIMIT ? OFFSET ?
      `;

      dataParams = [phoneSearchPattern, phoneSearchPattern, 5, offset];

    } else {
      // Busca normal por nome ou Discord
      countQuery = `
        SELECT COUNT(*) as total FROM (
          SELECT id, nome, telefone, discord, data_inscricao, 'pendente' as status 
          FROM inscricoes_pendentes 
          WHERE nome LIKE ? OR discord LIKE ?
          UNION ALL
          SELECT id, nome, telefone, discord, data_inscricao, 'aprovado' as status 
          FROM inscricoes 
          WHERE status = 'aprovado' 
          AND (nome LIKE ? OR discord LIKE ?)
        ) as combined
      `;

      countParams = [searchPattern, searchPattern, searchPattern, searchPattern];

      dataQuery = `
        SELECT * FROM (
          SELECT id, nome, telefone, discord, char_principal, guild_anterior, ip, 
                 screenshot_path, data_inscricao, 'pendente' as status 
          FROM inscricoes_pendentes 
          WHERE nome LIKE ? OR discord LIKE ?
          UNION ALL
          SELECT id, nome, telefone, discord, char_principal, guild_anterior, ip, 
                 screenshot_path, data_inscricao, 'aprovado' as status 
          FROM inscricoes 
          WHERE status = 'aprovado' 
          AND (nome LIKE ? OR discord LIKE ?)
        ) as combined 
        ORDER BY data_inscricao DESC 
        LIMIT ? OFFSET ?
      `;

      dataParams = [searchPattern, searchPattern, searchPattern, searchPattern, 5, offset];
    }

    // Executa a contagem
    const countRows = await safeExecuteQuery(countQuery, countParams);
    const total = countRows[0].total;
    const totalPages = Math.ceil(total / 5);

    if (total === 0) {
      return safeInteractionReply(context, {
        content: 'Nenhuma inscrição encontrada com esse termo de busca.',
        flags: MessageFlags.Ephemeral
      });
    }

    if (page > totalPages) {
      return safeInteractionReply(context, {
        content: `Apenas ${totalPages} páginas disponíveis para esta busca.`,
        flags: MessageFlags.Ephemeral
      });
    }

    // Busca os dados
    const rows = await safeExecuteQuery(dataQuery, dataParams);

    const embed = new EmbedBuilder()
      .setColor('#FF4500')
      .setTitle(`Resultados da busca por "${searchTerm}" - Página ${page}/${totalPages}`)
      .setFooter({ text: `Total de resultados: ${total}` });

    await safeInteractionReply(context, { embeds: [embed] });

    for (const application of rows) {
      await sendApplicationEmbed(context.channel, application);
    }

    if (totalPages > 1) {
      const navRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`search_prev_${encodeURIComponent(searchTerm)}_${page}`)
          .setLabel('Anterior')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(page <= 1),
        new ButtonBuilder()
          .setCustomId(`search_next_${encodeURIComponent(searchTerm)}_${page}`)
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
    await safeInteractionReply(context, {
      content: 'Ocorreu um erro ao buscar inscrições.',
      flags: MessageFlags.Ephemeral
    });
  }
}

// Função para enviar embed de inscrição (atualizada com formatação de telefone)
async function sendApplicationEmbed(channel, application) {
  const screenshots = processImageUrls(application.screenshot_path);
  const screenshotLinks = screenshots.slice(0, 5).map((screenshot, index) =>
    `[Imagem ${index + 1}](${screenshot})`
  ).join('\n') || 'Nenhuma imagem enviada';

  const isApproved = application.status === 'aprovado';

  // Normaliza o telefone para exibição consistente
  const normalizePhoneForDisplay = (phone) => {
    if (!phone) return 'Não informado';
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 11) {
      return `(${digits.substring(0, 2)}) ${digits.substring(2, 7)}-${digits.substring(7)}`;
    }
    return phone;
  };

  const embed = new EmbedBuilder()
    .setColor(isApproved ? '#00FF00' : '#FF4500')
    .setTitle(`Inscrição #${application.id} (${isApproved ? 'Aprovada' : 'Pendente'})`)
    .setDescription(`**${application.nome}** deseja se juntar à guild!`)
    .addFields(
      { name: '📱 Telefone', value: normalizePhoneForDisplay(application.telefone), inline: true },
      { name: '🎮 Discord', value: application.discord, inline: true },
      { name: '⚔️ Char Principal', value: application.char_principal, inline: true },
      { name: '🏰 Guild Anterior', value: application.guild_anterior || 'Nenhuma', inline: true },
      { name: '📸 Screenshots', value: screenshotLinks, inline: false },
      { name: '📅 Data', value: formatBrazilianDate(application.data_inscricao), inline: true },
      { name: '🌐 IP', value: application.ip || 'Não registrado', inline: true }
    )
    .setFooter({ text: 'ToHeLL Guild - Use os botões para visualizar ou gerenciar' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`view_screenshots_${application.id}_${application.status || 'pendente'}`)
      .setLabel('Visualizar Screenshots')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(screenshots.length === 0)
  );

  // Apenas adiciona botões de aprovar/rejeitar se não for aprovado
  if (!isApproved) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`approve_${application.id}`)
        .setLabel('Aprovar')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`reject_${application.id}`)
        .setLabel('Rejeitar')
        .setStyle(ButtonStyle.Danger)
    );
  }

  const msg = await safeSend(channel, {
    embeds: [embed],
    components: [row]
  });

  if (msg && !isApproved) {
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

  await safeInteractionReply(interaction, {
    embeds: [embed],
    flags: MessageFlags.Ephemeral
  });
}

// Função para aprovar inscrição
async function approveApplication(context, applicationId, user = null) {
  try {
    const rows = await safeExecuteQuery(
      'SELECT * FROM inscricoes_pendentes WHERE id = ?',
      [applicationId]
    );

    if (rows.length === 0) {
      throw new Error('Inscrição não encontrada ou já processada');
    }

    const application = rows[0];

    await safeExecuteQuery(
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

    await safeExecuteQuery(
      'DELETE FROM inscricoes_pendentes WHERE id = ?',
      [applicationId]
    );

    await notifyWebhook('aprovado', applicationId, application.nome, application.discord);

    await safeInteractionReply(context, {
      content: `Inscrição #${applicationId} aprovada com sucesso!`,
      flags: MessageFlags.Ephemeral
    });

    try {
      // Verificar se a mensagem ainda existe e pode ser editada
      if (context.message && context.message.editable) {
        const embed = new EmbedBuilder(context.message.embeds[0]);
        embed.setColor('#00FF00');
        embed.setFooter({ text: `✅ Aprovado por ${user?.username || context.user?.username || 'Sistema'}` });

        await context.message.edit({
          embeds: [embed],
          components: []
        }).catch(console.error);
      }
    } catch (editError) {
      console.error('❌ Erro ao editar mensagem:', editError);
    }

    try {
      if (context.message) {
        await context.message.reactions.removeAll().catch(console.error);
      }
    } catch (error) {
      console.error('❌ Erro ao remover reações:', error);
    }
  } catch (error) {
    console.error('❌ Erro ao aprovar inscrição:', error);
    await safeInteractionReply(context, {
      content: `Ocorreu um erro ao aprovar a inscrição #${applicationId}`,
      flags: MessageFlags.Ephemeral
    });
  }
}

// Função para rejeitar inscrição
async function rejectApplication(context, applicationId, reason, user = null) {
  try {
    const rows = await safeExecuteQuery(
      'SELECT * FROM inscricoes_pendentes WHERE id = ?',
      [applicationId]
    );

    if (rows.length === 0) {
      throw new Error('Inscrição não encontrada ou já processada');
    }

    const application = rows[0];

    await safeExecuteQuery(
      'DELETE FROM inscricoes_pendentes WHERE id = ?',
      [applicationId]
    );

    await notifyWebhook('rejeitado', applicationId, application.nome, application.discord, reason);

    await safeInteractionReply(context, {
      content: `Inscrição #${applicationId} rejeitada com sucesso!`,
      flags: MessageFlags.Ephemeral
    });

    try {
      // Verificar se a mensagem ainda existe e pode ser editada
      if (context.message && context.message.editable) {
        const embed = new EmbedBuilder(context.message.embeds[0]);
        embed.setColor('#FF0000');

        if (reason) {
          embed.addFields({ name: 'Motivo da Rejeição', value: reason });
        }

        embed.setFooter({ text: `❌ Rejeitado por ${user?.username || context.user?.username || 'Sistema'}` });

        await context.message.edit({
          embeds: [embed],
          components: []
        }).catch(console.error);
      }
    } catch (editError) {
      console.error('❌ Erro ao editar mensagem:', editError);
    }

    try {
      if (context.message) {
        await context.message.reactions.removeAll().catch(console.error);
      }
    } catch (error) {
      console.error('❌ Erro ao remover reações:', error);
    }
  } catch (error) {
    console.error('❌ Erro ao rejeitar inscrição:', error);
    await safeInteractionReply(context, {
      content: `Ocorreu um erro ao rejeitar a inscrição #${applicationId}`,
      flags: MessageFlags.Ephemeral
    });
  }
}

// Função para configurar os comandos
function setupCommands(client) {
  client.on('ready', async () => {
    try {
      await client.application.commands.set(slashCommands);
      console.log('✅ Comandos slash registrados com sucesso');
    } catch (error) {
      console.error('❌ Erro ao registrar comandos slash:', error);
    }
  });
}

module.exports = {
  slashCommands,
  listPendingApplications,
  searchApplications,
  sendApplicationEmbed,
  showHelp,
  approveApplication,
  rejectApplication,
  setupCommands,
  createImageCarousel,
  processImageUrls
};