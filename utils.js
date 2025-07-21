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
const axios = require('axios');
const axiosRetry = require('axios-retry');
const { JSDOM } = require('jsdom');
const moment = require('moment-timezone');

// Configura axios para tentar novamente em caso de falha
axiosRetry(axios, {
  retries: 2,
  retryDelay: (retryCount) => retryCount * 1000,
  retryCondition: (error) => 
    axiosRetry.isNetworkOrIdempotentRequestError(error) || 
    error.code === 'ECONNABORTED'
});

// Configurações
const ITEMS_PER_PAGE = 5;
const GUILDS_TO_CHECK = ['ToHeLL_', 'ToHeLL2', 'ToHeLL3', 'ToHeLL4', 'ToHeLL5', 'ToHeLL6', 'ToHeLL7', 'ToHeLL8_', 'ToHeLL9', 'ToHeLL10'];
const BASE_URL = process.env.BASE_URL || 'https://tohellguild.com.br/';
const MAIN_GUILDS = ['ToHeLL_', 'ToHeLL2', 'ToHeLL3'];
const MUCA_BRASIL_URL = 'https://www.mucabrasil.com.br/?go=guild&n=';
const CACHE_TIME = 300; // 5 minutos em segundos
const WEBHOOK_DELAY_MS = 1500; // Delay entre chamadas de webhook
const NUMVERIFY_API_KEY = process.env.NUMVERIFY_API_KEY || '92a8a50f3a787b49eecc7fc8356cbd46';

// Sistema de fila para webhooks
const webhookQueue = [];
let isProcessingWebhook = false;

// Função para formatar data no padrão brasileiro com fuso horário
function formatBrazilianDate(dateString) {
  if (!dateString) return 'Data inválida';
  
  try {
    return moment(dateString).tz('America/Sao_Paulo').format('DD/MM/YYYY HH:mm');
  } catch (error) {
    console.error('Erro ao formatar data:', error);
    return 'Data inválida';
  }
}

// Função para validar URL de imagem
function isValidImageUrl(url) {
  try {
    new URL(url);
    return /\.(jpg|jpeg|png|gif|webp)$/i.test(url);
  } catch {
    return false;
  }
}

// Função para processar URLs de imagens (corrigida)
function processImageUrls(imageData) {
  try {
    // Se for string, tentar parsear como JSON
    const urls = typeof imageData === 'string' ? JSON.parse(imageData || '[]') : imageData || [];
    
    // Converter para array se não for
    const urlArray = Array.isArray(urls) ? urls : [urls];
    
    // Mapear para URLs completas se necessário e filtrar URLs inválidas
    return urlArray.map(url => {
      if (!url) return null;
      
      // Verifica se é uma URL válida
      try {
        let processedUrl = url.startsWith('http') ? url : `${BASE_URL}${url.replace(/^\/+/, '')}`;
        new URL(processedUrl); // Isso vai lançar erro se não for URL válida
        return processedUrl;
      } catch {
        return null;
      }
    }).filter(url => url !== null);
  } catch (error) {
    console.error('Erro ao processar URLs de imagem:', error);
    return [];
  }
}

// Função para responder a interações de forma segura
async function safeInteractionReply(interaction, content) {
  try {
    if (interaction.replied) {
      // Se já foi respondido, tenta editar
      const message = await interaction.fetchReply().catch(() => null);
      if (message && message.editable) {
        return await message.edit(content).catch(() => null);
      }
      return null;
    } else if (interaction.deferred) {
      return await interaction.editReply(content).catch(() => null);
    } else {
      return await interaction.reply(content).catch(() => null);
    }
  } catch (error) {
    console.error('❌ Erro ao responder interação:', error);
    return null;
  }
}

// Processador de fila de webhooks
async function processWebhookQueue() {
  if (isProcessingWebhook || webhookQueue.length === 0) return;
  
  isProcessingWebhook = true;
  const webhookData = webhookQueue.shift();
  
  try {
    await axios.post(webhookData.url, webhookData.payload, {
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' }
    });
    
    // Delay para evitar rate limit
    await new Promise(resolve => setTimeout(resolve, WEBHOOK_DELAY_MS));
  } catch (error) {
    console.error('❌ Erro no webhook (fila):', error.message);
    // Re-adiciona à fila se for um erro temporário
    if (!error.response || error.response.status >= 500) {
      webhookQueue.unshift(webhookData);
    }
  } finally {
    isProcessingWebhook = false;
    if (webhookQueue.length > 0) {
      setImmediate(processWebhookQueue);
    }
  }
}

// Notificar no webhook com sistema de fila
async function notifyWebhook(action, applicationId, applicationName, discordTag, motivo = '') {
  if (!process.env.DISCORD_WEBHOOK_URL) return;
  if (!action || !applicationId || !applicationName || !discordTag) {
    console.error('❌ Parâmetros inválidos para notifyWebhook');
    return;
  }

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
  
  // Adiciona à fila de webhooks
  webhookQueue.push({
    url: process.env.DISCORD_WEBHOOK_URL,
    payload: { embeds: [embed] }
  });
  
  // Inicia o processamento se não estiver em andamento
  if (!isProcessingWebhook) {
    processWebhookQueue();
  }
}

// Busca paralela em guildas otimizada com retry e priorização
async function parallelGuildSearch(name, nameLower, guilds = GUILDS_TO_CHECK) {
  if (!name || typeof name !== 'string') {
    console.error('❌ Nome inválido para busca em guildas:', name);
    return null;
  }

  try {
    // Separa guildas principais e secundárias
    const mainGuilds = guilds.filter(g => MAIN_GUILDS.includes(g));
    const otherGuilds = guilds.filter(g => !MAIN_GUILDS.includes(g));
    
    // Função para criar requests
    const createRequests = (guildList, timeout) => 
      guildList.flatMap(guild => {
        if (!guild) return [];
        return [1, 2].map(page => {
          const url = `${MUCA_BRASIL_URL}${encodeURIComponent(guild)}${page > 1 ? `&p=${page}` : ''}`;
          return axios.get(url, { 
            timeout,
            headers: { 'User-Agent': 'ToHeLL-Discord-Bot/1.0' }
          })
            .then(response => ({ 
              html: response.data, 
              guild: guild || 'Desconhecida', 
              page 
            }))
            .catch(error => {
              console.error(`❌ Erro ao buscar guilda ${guild} página ${page}:`, error.message);
              return null;
            });
        });
      });

    // Executa buscas em paralelo com prioridade para guildas principais
    const [mainResponses, otherResponses] = await Promise.all([
      Promise.allSettled(createRequests(mainGuilds, 3000)), // 3s para guildas principais
      Promise.allSettled(createRequests(otherGuilds, 5000)) // 5s para outras
    ]);

    // Processa respostas
    for (const response of [...mainResponses, ...otherResponses]) {
      if (response.status === 'fulfilled' && response.value) {
        const { html, guild, page } = response.value;
        try {
          const dom = new JSDOM(html);
          const doc = dom.window.document;
          
          const rows = doc.querySelectorAll('tr');
          for (const row of rows) {
            const cells = row.querySelectorAll('td');
            if (cells.length >= 4) {
              const charName = cells[1]?.textContent?.trim();
              if (charName && charName.toLowerCase() === nameLower) {
                return {
                  name: charName || name,
                  level: parseInt(cells[2]?.textContent?.trim()) || 0,
                  resets: parseInt(cells[3]?.textContent?.trim()) || 0,
                  guild: guild || 'Desconhecida',
                  found_at: new Date().toISOString()
                };
              }
            }
          }
        } catch (error) {
          console.error('❌ Erro ao processar HTML da guilda:', error);
        }
      }
    }
    
    return null;
  } catch (error) {
    console.error('❌ Erro no parallelGuildSearch:', error);
    return null;
  }
}

// Função com cache e busca paralela otimizada
async function searchCharacterWithCache(name, dbConnection) {
  if (!name || typeof name !== 'string') {
    console.error('❌ Nome do personagem inválido:', name);
    return null;
  }

  const nameLower = name.toLowerCase();
  
  try {
    // Verifica no banco de dados primeiro
    const [dbRows] = await dbConnection.execute(
      'SELECT * FROM characters WHERE name = ? LIMIT 1',
      [name]
    );
    
    // Se encontrou no banco e foi atualizado nos últimos 5 minutos, retorna
    if (dbRows[0] && dbRows[0].last_seen && new Date(dbRows[0].last_seen) > new Date(Date.now() - CACHE_TIME * 1000)) {
      return dbRows[0];
    }
    
    // Busca nas guildas
    const guildData = await parallelGuildSearch(name, nameLower);
    
    if (guildData) {
      // Valida os dados antes de inserir/atualizar
      const level = Number.isInteger(guildData.level) ? guildData.level : null;
      const resets = Number.isInteger(guildData.resets) ? guildData.resets : null;
      const guild = guildData.guild || null;

      // Atualiza ou insere no banco de dados
      if (dbRows.length > 0 && dbRows[0].id) {
        await dbConnection.execute(
          'UPDATE characters SET last_level = ?, last_resets = ?, guild = ?, last_seen = NOW() WHERE id = ?',
          [level, resets, guild, dbRows[0].id]
        );
        guildData.id = dbRows[0].id;
      } else {
        const [result] = await dbConnection.execute(
          'INSERT INTO characters (name, guild, last_level, last_resets, last_seen) VALUES (?, ?, ?, ?, NOW())',
          [name, guild, level, resets]
        );
        guildData.id = result.insertId;
      }
      
      // Adiciona ao histórico (apenas se level e resets são válidos)
      if (level !== null && resets !== null && guildData.id) {
        await dbConnection.execute(
          'INSERT INTO character_history (character_id, level, resets) VALUES (?, ?, ?)',
          [guildData.id, level, resets]
        ).catch(error => {
          console.error('❌ Erro ao inserir no histórico:', error);
        });
      }
      
      return {
        ...guildData,
        id: guildData.id,
        level,
        resets,
        guild,
        last_seen: new Date().toISOString()
      };
    }
    
    // Se não encontrou nas guildas, retorna o do banco se existir
    return dbRows.length > 0 ? dbRows[0] : null;
  } catch (error) {
    console.error('❌ Erro em searchCharacterWithCache:', error);
    return null;
  }
}

// Calcular estatísticas avançadas
async function calculateAdvancedStats(characterId, dbConnection) {
  if (!characterId || !dbConnection) {
    console.error('❌ Parâmetros inválidos para calculateAdvancedStats');
    return null;
  }

  try {
    const [history] = await dbConnection.execute(`
      SELECT level, resets, UNIX_TIMESTAMP(recorded_at) as timestamp 
      FROM character_history 
      WHERE character_id = ? 
      AND recorded_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      ORDER BY recorded_at ASC
    `, [characterId]);
    
    if (history.length < 2) {
      return null;
    }
    
    const stats = {};
    const levelChanges = [];
    const resetChanges = [];
    const timeDeltas = [];
    const timeBetweenResets = [];
    const timeTo400 = [];
    
    for (let i = 1; i < history.length; i++) {
      const prev = history[i-1];
      const current = history[i];
      
      const timeDelta = (current.timestamp - prev.timestamp) / 3600; // em horas
      const levelDelta = current.level - prev.level;
      const resetDelta = current.resets - prev.resets;
      
      if (timeDelta > 0) {
        levelChanges.push(levelDelta / timeDelta);
        if (resetDelta > 0) {
          resetChanges.push(resetDelta);
          timeDeltas.push(timeDelta / 24); // em dias
        }
        
        if (resetDelta > 0) {
          timeBetweenResets.push(timeDelta / resetDelta);
        }
        
        if (prev.level < 400 && levelDelta > 0) {
          timeTo400.push((400 - prev.level) / (levelDelta / timeDelta));
        }
      }
    }
    
    stats.levelPerHour = levelChanges.length > 0 ? 
      levelChanges.reduce((a, b) => a + b, 0) / levelChanges.length : 0;
    
    stats.avgTimePerReset = resetChanges.length > 0 ? 
      timeDeltas.reduce((a, b) => a + b, 0) / resetChanges.length : null;
    
    stats.nextLevelPrediction = stats.levelPerHour > 0 ? 
      1 / stats.levelPerHour : null;
    
    stats.nextResetPrediction = stats.avgTimePerReset;
    
    const latest = history[history.length - 1];
    if (latest.level < 400 && timeTo400.length > 0) {
      stats.projectionTo400 = timeTo400.reduce((a, b) => a + b, 0) / timeTo400.length;
    } else if (latest.level >= 400) {
      stats.projectionTo400 = 'Já atingiu level 400';
    } else {
      stats.projectionTo400 = null;
    }
    
    if (timeBetweenResets.length > 0 && stats.levelPerHour > 0) {
      const avgTimeBetweenResets = timeBetweenResets.reduce((a, b) => a + b, 0) / timeBetweenResets.length;
      stats.projectionNextReset = avgTimeBetweenResets;
      
      if (latest.level < 400 && stats.projectionTo400 !== null) {
        stats.projectionNextReset = stats.projectionTo400 + avgTimeBetweenResets;
      }
    } else {
      stats.projectionNextReset = null;
    }
    
    return stats;
  } catch (error) {
    console.error('❌ Erro ao calcular estatísticas avançadas:', error);
    return null;
  }
}

// Criar embed de personagem
function createCharEmbed({ name, level, resets, guild, found, lastSeen, history, stats }) {
  // Valores padrão para evitar undefined
  name = name || 'Desconhecido';
  level = level !== undefined ? level : 0;
  resets = resets !== undefined ? resets : 0;
  guild = guild || 'Nenhuma';
  found = found !== undefined ? found : false;

  const embed = new EmbedBuilder()
    .setColor(found ? '#00FF00' : '#FF0000')
    .setTitle(`Personagem: ${name}`)
    .addFields(
      { name: '⚔️ Level', value: level.toString(), inline: true },
      { name: '🔄 Resets', value: resets.toString(), inline: true },
      { name: '🏰 Guilda', value: guild, inline: true }
    );
    
  if (!found) {
    embed.setDescription('❗ Personagem não encontrado atualmente em nenhuma guilda');
    if (lastSeen) {
      embed.addFields({ 
        name: 'Última vez visto', 
        value: formatBrazilianDate(lastSeen), 
        inline: false 
      });
    }
  }
  
  if (history && history.length > 0) {
    const historyText = history.map(entry => 
      `📅 ${formatBrazilianDate(entry.recorded_at)}: Level ${entry.level || 0} | Resets ${entry.resets || 0}`
    ).join('\n');
    
    embed.addFields({
      name: '📜 Histórico Recente',
      value: historyText,
      inline: false
    });
  }
  
  if (stats) {
    const statsFields = [];
    
    if (stats.levelPerHour > 0) {
      statsFields.push({
        name: '📊 Progresso',
        value: `Média: ${stats.levelPerHour.toFixed(2)} levels/hora`,
        inline: true
      });
      
      if (stats.nextLevelPrediction) {
        statsFields.push({
          name: '⏱️ Próximo Level',
          value: `~${stats.nextLevelPrediction.toFixed(2)} horas`,
          inline: true
        });
      }
    }
    
    if (stats.projectionTo400) {
      statsFields.push({
        name: '🎯 Projeção para 400',
        value: typeof stats.projectionTo400 === 'string' ? 
          stats.projectionTo400 : 
          `~${(stats.projectionTo400 / 24).toFixed(2)} dias`,
        inline: true
      });
    }
    
    if (stats.projectionNextReset) {
      statsFields.push({
        name: '🔄 Próximo Reset',
        value: `~${(stats.projectionNextReset / 24).toFixed(2)} dias`,
        inline: true
      });
    }
    
    if (statsFields.length > 0) {
      embed.addFields(statsFields);
    }
  }
  
  return embed;
}

// Buscar personagem com tratamento de erro completo
async function searchCharacter(interaction, charName, dbConnection) {
  if (!charName || typeof charName !== 'string') {
    return interaction.reply({
      content: 'Por favor, forneça um nome de personagem válido.',
      flags: MessageFlags.Ephemeral
    });
  }

  try {
    // Verificar conexão com o banco de dados
    if (!dbConnection || !(await dbConnection.execute('SELECT 1').catch(() => false))) {
      return interaction.reply({
        content: 'Erro de conexão com o banco de dados. Por favor, tente novamente mais tarde.',
        flags: MessageFlags.Ephemeral
      });
    }

    // Deferir a resposta primeiro
    await interaction.deferReply();

    // Executar a busca com timeout total de 15 segundos
    const charData = await Promise.race([
      searchCharacterWithCache(charName, dbConnection),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 15000))
    ]);

    if (!charData) {
      const [historyRows] = await dbConnection.execute(
        'SELECT * FROM characters WHERE LOWER(name) = ? LIMIT 1',
        [charName.toLowerCase()]
      );
      
      if (historyRows.length > 0) {
        const lastKnown = historyRows[0];
        return interaction.editReply({
          embeds: [createCharEmbed({
            name: lastKnown.name,
            level: lastKnown.last_level || 0,
            resets: lastKnown.last_resets || 0,
            guild: lastKnown.guild || 'Desconhecida',
            found: false,
            lastSeen: lastKnown.last_seen
          })]
        });
      }
      
      return interaction.editReply({
        content: `Personagem "${charName}" não encontrado em nenhuma guilda da ToHeLL.`
      });
    }
    
    // Obter histórico e estatísticas em paralelo
    const [history, advancedStats] = await Promise.all([
      dbConnection.execute(
        'SELECT level, resets, recorded_at FROM character_history WHERE character_id = ? ORDER BY recorded_at DESC LIMIT 5',
        [charData.id]
      ).catch(() => [[]]), // Retorna array vazio em caso de erro
      calculateAdvancedStats(charData.id, dbConnection)
    ]);
    
    // Criar embed de resposta
    const embed = createCharEmbed({
      name: charData.name,
      level: charData.level || 0,
      resets: charData.resets || 0,
      guild: charData.guild || 'Desconhecida',
      found: true,
      history: history[0],
      stats: advancedStats
    });
    
    await interaction.editReply({ embeds: [embed] });
    
  } catch (error) {
    console.error('❌ Erro ao buscar personagem:', error);
    
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: 'Ocorreu um erro ao buscar o personagem. Por favor, tente novamente mais tarde.',
        flags: MessageFlags.Ephemeral
      });
    } else if (interaction.deferred) {
      await interaction.editReply({
        content: error.message === 'Timeout' ? 
          'A busca está demorando mais que o esperado. Por favor, tente novamente.' :
          'Ocorreu um erro ao buscar o personagem. Por favor, tente novamente mais tarde.'
      });
    }
  }
}

// Mostrar ranking igual ao do monitor.php
async function showRanking(interaction, period, dbConnection) {
  try {
    await interaction.deferReply();

    // Definir intervalos conforme monitor.php
    let interval, periodName;
    switch (period) {
      case '24h':
        interval = '24 HOUR';
        periodName = '24 Horas';
        break;
      case '7d':
        interval = '7 DAY';
        periodName = '7 Dias';
        break;
      case '30d':
        interval = '30 DAY';
        periodName = '30 Dias';
        break;
      default:
        interval = '24 HOUR';
        periodName = '24 Horas';
    }

    // Verificar cache (5 minutos como no monitor.php)
    const cacheKey = `rankings_${period}`;
    const [cacheRows] = await dbConnection.execute(
      'SELECT key_value FROM system_status WHERE key_name = ? AND updated_at > DATE_SUB(NOW(), INTERVAL 5 MINUTE)',
      [cacheKey]
    );

    if (cacheRows.length > 0) {
      const cachedData = JSON.parse(cacheRows[0].key_value);
      return interaction.editReply({ embeds: [cachedData.embed] });
    }

    // Consulta idêntica ao monitor.php
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
      WHERE h.recorded_at >= DATE_SUB(NOW(), INTERVAL ${interval})
      GROUP BY h.character_id, c.name, c.guild, c.last_level, c.last_resets
      ORDER BY progress_score DESC
      LIMIT 10
    `);

    if (rows.length === 0) {
      return interaction.editReply({
        content: `Nenhum dado de ranking disponível para o período de ${periodName.toLowerCase()}.`
      });
    }

    // Criar embed com estilo similar ao monitor.php
    const embed = new EmbedBuilder()
      .setColor('#FFA500')
      .setTitle(`🏆 Ranking de Progresso - ${periodName}`)
      .setDescription(`Top 10 personagens com maior progresso`);

    rows.forEach((char, index) => {
      embed.addFields({
        name: `#${index + 1} ${char.name}`,
        value: `🏰 ${char.guild || 'Nenhuma'}\n` +
               `⚔️ Level: ${char.current_level || 0} ` + 
               (char.level_change > 0 ? `**(+${char.level_change})**` : '') + '\n' +
               `🔄 Resets: ${char.current_resets || 0} ` +
               (char.reset_change > 0 ? `**(+${char.reset_change})**` : '') + '\n' +
               `📊 Pontuação: **${char.progress_score?.toFixed(0) || '0'}**`,
        inline: false
      });
    });

    // Salvar no cache como no monitor.php
    await dbConnection.execute(
      'INSERT INTO system_status (key_name, key_value) VALUES (?, ?) ' +
      'ON DUPLICATE KEY UPDATE key_value = VALUES(key_value), updated_at = NOW()',
      [cacheKey, JSON.stringify({ embed })]
    );

    await interaction.editReply({ embeds: [embed] });

  } catch (error) {
    console.error('❌ Erro ao buscar ranking:', error);
    await interaction.editReply({
      content: 'Ocorreu um erro ao buscar o ranking. Por favor, tente novamente mais tarde.'
    });
  }
}

// Gerenciar permissões de comandos
async function addCommandPermission(commandName, roleId, dbConnection) {
  try {
    if (!commandName || !roleId || !dbConnection) {
      console.error('❌ Parâmetros inválidos para addCommandPermission');
      return false;
    }
    await dbConnection.execute(
      'INSERT INTO command_permissions (command_name, role_id) VALUES (?, ?)',
      [commandName, roleId]
    );
    return true;
  } catch (error) {
    console.error('❌ Erro ao adicionar permissão:', error);
    return false;
  }
}

async function removeCommandPermission(commandName, roleId, dbConnection) {
  try {
    if (!commandName || !roleId || !dbConnection) {
      console.error('❌ Parâmetros inválidos para removeCommandPermission');
      return false;
    }
    const [result] = await dbConnection.execute(
      'DELETE FROM command_permissions WHERE command_name = ? AND role_id = ?',
      [commandName, roleId]
    );
    return result.affectedRows > 0;
  } catch (error) {
    console.error('❌ Erro ao remover permissão:', error);
    return false;
  }
}

async function getCommandPermissions(commandName, dbConnection) {
  try {
    if (!commandName || !dbConnection) {
      console.error('❌ Parâmetros inválidos para getCommandPermissions');
      return [];
    }
    const [rows] = await dbConnection.execute(
      'SELECT role_id FROM command_permissions WHERE command_name = ?',
      [commandName]
    );
    return rows.map(row => row.role_id);
  } catch (error) {
    console.error('❌ Erro ao obter permissões:', error);
    return [];
  }
}

async function checkUserPermission(interaction, commandName, dbConnection) {
  if (commandName === 'pendentes') return true;
  if (!interaction || !commandName || !dbConnection) return false;
  
  const allowedRoles = await getCommandPermissions(commandName, dbConnection);
  
  if (allowedRoles.length === 0) return true;
  
  return interaction.member?.roles?.cache?.some(role => allowedRoles.includes(role.id));
}

// Envio seguro de mensagens
async function safeSend(channel, content) {
  try {
    if (!channel || !content) {
      console.error('❌ Parâmetros inválidos para safeSend');
      return null;
    }
    return await channel.send(content);
  } catch (error) {
    console.error('❌ Erro ao enviar mensagem:', error);
    return null;
  }
}

// ==============================================
// FUNÇÕES PARA SISTEMA DE IP
// ==============================================

// Função para bloquear IP (atualizada)
async function blockIP(ip, motivo, dbConnection, userId) {
  try {
    // Verifica se o IP já está bloqueado
    const [existing] = await dbConnection.execute(
      'SELECT * FROM ips_bloqueados WHERE ip = ?',
      [ip]
    );
    
    if (existing.length > 0) {
      return { success: false, message: 'Este IP já está bloqueado.' };
    }

    // Consulta informações do IP
    const geoInfo = await getIPInfo(ip);
    if (!geoInfo) {
      return { success: false, message: 'Não foi possível obter informações do IP.' };
    }

    // Verifica se a coluna bloqueado_por existe
    const [columns] = await dbConnection.execute(
      `SHOW COLUMNS FROM ips_bloqueados LIKE 'bloqueado_por'`
    );
    
    const hasBloqueadoPor = columns.length > 0;
    
    // Monta a query dinamicamente
    let query = 'INSERT INTO ips_bloqueados (ip, motivo, pais, regiao, cidade, postal, provedor';
    let values = [ip, motivo, geoInfo.country, geoInfo.region, geoInfo.city, geoInfo.postal, geoInfo.org];
    
    if (hasBloqueadoPor) {
      query += ', bloqueado_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
      values.push(userId);
    } else {
      query += ') VALUES (?, ?, ?, ?, ?, ?, ?)';
    }

    // Insere no banco de dados
    await dbConnection.execute(query, values);

    return { success: true, message: 'IP bloqueado com sucesso!', geoInfo };
  } catch (error) {
    console.error('Erro ao bloquear IP:', error);
    return { success: false, message: 'Erro ao bloquear IP.' };
  }
}

// Função para desbloquear IP
async function unblockIP(ip, dbConnection, userId) {
  try {
    // Verifica se o IP está bloqueado
    const [blocked] = await dbConnection.execute(
      'SELECT * FROM ips_bloqueados WHERE ip = ?',
      [ip]
    );
    
    if (blocked.length === 0) {
      return { success: false, message: 'Este IP não está bloqueado.' };
    }

    // Remove o bloqueio
    await dbConnection.execute(
      'DELETE FROM ips_bloqueados WHERE ip = ?',
      [ip]
    );

    return { 
      success: true, 
      message: 'IP desbloqueado com sucesso!',
      originalReason: blocked[0].motivo
    };
  } catch (error) {
    console.error('Erro ao desbloquear IP:', error);
    return { success: false, message: 'Erro ao desbloquear IP.' };
  }
}

// Função para consultar IP
async function queryIP(ip, dbConnection) {
  try {
    // Verifica se está bloqueado
    const [blocked] = await dbConnection.execute(
      'SELECT * FROM ips_bloqueados WHERE ip = ?',
      [ip]
    );

    // Verifica se está na whitelist
    const [whitelisted] = await dbConnection.execute(
      'SELECT * FROM ips_whitelist WHERE ip = ?',
      [ip]
    );

    // Consulta informações do IP
    const geoInfo = await getIPInfo(ip);
    
    return {
      blocked: blocked.length > 0 ? blocked[0] : null,
      whitelisted: whitelisted.length > 0 ? whitelisted[0] : null,
      geoInfo
    };
  } catch (error) {
    console.error('Erro ao consultar IP:', error);
    return null;
  }
}

// Função para obter informações de geolocalização
async function getIPInfo(ip) {
  try {
    const response = await axios.get(`http://ip-api.com/json/${ip}?fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,query`);
    
    if (response.data.status !== 'success') {
      console.error('Erro ao consultar IP:', response.data.message);
      return null;
    }
    
    return {
      country: response.data.country,
      countryCode: response.data.countryCode,
      region: response.data.regionName,
      city: response.data.city,
      postal: response.data.zip,
      org: response.data.org,
      isp: response.data.isp,
      timezone: response.data.timezone,
      coordinates: `${response.data.lat}, ${response.data.lon}`
    };
  } catch (error) {
    console.error('Erro na API de geolocalização:', error);
    return null;
  }
}

// Função para gerar relatório de segurança
async function generateSecurityReport(dbConnection, period = '24h') {
  try {
    let interval;
    switch (period) {
      case '7d': interval = '7 DAY'; break;
      case '30d': interval = '30 DAY'; break;
      default: interval = '1 DAY';
    }

    // IPs bloqueados recentemente
    const [blockedIPs] = await dbConnection.execute(
      `SELECT ip, motivo, pais, data_bloqueio FROM ips_bloqueados 
       WHERE data_bloqueio >= DATE_SUB(NOW(), INTERVAL ${interval})
       ORDER BY data_bloqueio DESC LIMIT 10`
    );

    // Tentativas de acesso suspeitas
    const [suspiciousAccess] = await dbConnection.execute(
      `SELECT ip, COUNT(*) as tentativas, MAX(data_acesso) as ultima_tentativa 
       FROM tentativas_login_falhas 
       WHERE data_acesso >= DATE_SUB(NOW(), INTERVAL ${interval})
       GROUP BY ip 
       HAVING tentativas > 3
       ORDER BY tentativas DESC LIMIT 5`
    );

    // IPs mais problemáticos
    const [problematicIPs] = await dbConnection.execute(
      `SELECT ip, COUNT(*) as bloqueios 
       FROM ips_bloqueados 
       WHERE data_bloqueio >= DATE_SUB(NOW(), INTERVAL ${interval})
       GROUP BY ip 
       ORDER BY bloqueios DESC LIMIT 5`
    );

    return {
      blockedIPs,
      suspiciousAccess,
      problematicIPs,
      period
    };
  } catch (error) {
    console.error('Erro ao gerar relatório:', error);
    return null;
  }
}

// Função para listar últimos acessos
async function getRecentAccess(dbConnection, limit = 10, country = null) {
  try {
    let query = `SELECT ip, pagina, user_agent, data_acesso 
                FROM visitantes 
                ORDER BY data_acesso DESC 
                LIMIT ?`;
    
    let params = [limit];
    
    if (country) {
      query = `SELECT v.ip, v.pagina, v.user_agent, v.data_acesso, i.pais
               FROM visitantes v
               LEFT JOIN ips_info i ON v.ip = i.ip
               WHERE i.pais = ?
               ORDER BY v.data_acesso DESC 
               LIMIT ?`;
      params = [country.toUpperCase(), limit];
    }

    const [access] = await dbConnection.execute(query, params);
    return access;
  } catch (error) {
    console.error('Erro ao buscar acessos:', error);
    return null;
  }
}

// Função para gerenciar whitelist
async function manageWhitelist(action, ip, motivo, dbConnection, userId) {
  try {
    if (action === 'add') {
      // Verifica se já está na whitelist
      const [existing] = await dbConnection.execute(
        'SELECT * FROM ips_whitelist WHERE ip = ?',
        [ip]
      );
      
      if (existing.length > 0) {
        return { success: false, message: 'Este IP já está na whitelist.' };
      }

      // Adiciona à whitelist
      await dbConnection.execute(
        'INSERT INTO ips_whitelist (ip, motivo, criado_por) VALUES (?, ?, ?)',
        [ip, motivo || 'Adicionado via Discord', userId]
      );

      // Remove do bloqueio se estiver bloqueado
      await dbConnection.execute(
        'DELETE FROM ips_bloqueados WHERE ip = ?',
        [ip]
      );

      return { success: true, message: 'IP adicionado à whitelist com sucesso!' };
    }
    else if (action === 'remove') {
      const [result] = await dbConnection.execute(
        'DELETE FROM ips_whitelist WHERE ip = ?',
        [ip]
      );
      
      if (result.affectedRows === 0) {
        return { success: false, message: 'IP não encontrado na whitelist.' };
      }
      
      return { success: true, message: 'IP removido da whitelist com sucesso!' };
    }
    else if (action === 'list') {
      const [ips] = await dbConnection.execute(
        'SELECT ip, motivo, data_criacao FROM ips_whitelist ORDER BY data_criacao DESC LIMIT 50'
      );
      return { success: true, data: ips };
    }
    
    return { success: false, message: 'Ação inválida.' };
  } catch (error) {
    console.error('Erro ao gerenciar whitelist:', error);
    return { success: false, message: 'Erro ao gerenciar whitelist.' };
  }
}

// Função para consultar número de telefone (atualizada)
async function checkPhoneNumber(phoneNumber) {
  try {
    // Normaliza o número removendo caracteres não numéricos
    const normalizedNumber = phoneNumber.replace(/[^\d+]/g, '');
    
    // Verifica se o número está em formato brasileiro (sem código de país)
    let formattedNumber = normalizedNumber;
    if (/^(\d{2})(\d{8,9})$/.test(normalizedNumber)) {
      formattedNumber = `+55${normalizedNumber}`;
    } 
    // Verifica se está em formato europeu (geralmente começa com + e código de país)
    else if (/^\d{9,15}$/.test(normalizedNumber) && !normalizedNumber.startsWith('+')) {
      // Assume que é um número europeu sem o +, adiciona o código do país padrão
      formattedNumber = `+${normalizedNumber}`;
    }
    // Se já começa com +, assume que está em formato internacional
    
    const response = await axios.get(`http://apilayer.net/api/validate`, {
      params: {
        access_key: NUMVERIFY_API_KEY,
        number: formattedNumber,
        format: 1
      },
      timeout: 5000
    });

    if (response.data.valid) {
      return {
        success: true,
        data: {
          number: response.data.number,
          countryPrefix: response.data.country_prefix,
          countryCode: response.data.country_code,
          countryName: response.data.country_name,
          location: response.data.location,
          carrier: response.data.carrier,
          lineType: response.data.line_type
        }
      };
    } else {
      return {
        success: false,
        message: 'Número de telefone inválido ou não encontrado.'
      };
    }
  } catch (error) {
    console.error('Erro na API Numverify:', error);
    return {
      success: false,
      message: 'Erro ao consultar o número. Por favor, tente novamente mais tarde.'
    };
  }
}

module.exports = {
  formatBrazilianDate,
  isValidImageUrl,
  processImageUrls,
  safeInteractionReply,
  safeSend,
  parallelGuildSearch,
  searchCharacterWithCache,
  calculateAdvancedStats,
  createCharEmbed,
  searchCharacter,
  showRanking,
  addCommandPermission,
  removeCommandPermission,
  getCommandPermissions,
  checkUserPermission,
  notifyWebhook,
  ITEMS_PER_PAGE,
  // Funções para sistema de IP
  blockIP,
  unblockIP,
  queryIP,
  getIPInfo,
  generateSecurityReport,
  getRecentAccess,
  manageWhitelist,
  // Nova função para consulta de telefone
  checkPhoneNumber
};