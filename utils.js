const { EmbedBuilder, MessageFlags } = require('discord.js');
const axios = require('axios');
const { JSDOM } = require('jsdom');

// Configurações
const ITEMS_PER_PAGE = 5;
const GUILDS_TO_CHECK = ['ToHeLL_', 'ToHeLL2', 'ToHeLL3', 'ToHeLL4', 'ToHeLL5', 'ToHeLL6', 'ToHeLL7', 'ToHeLL8_', 'ToHeLL9', 'ToHeLL10'];
const BASE_URL = process.env.BASE_URL || 'https://seusite.com/';

// Função para formatar data no padrão brasileiro com fuso horário
function formatBrazilianDate(dateString) {
  if (!dateString) return 'Data inválida';
  
  try {
    const date = new Date(dateString);
    const offset = -3 * 60; // Brasília UTC-3
    const adjustedDate = new Date(date.getTime() + (offset + date.getTimezoneOffset()) * 60000);
    
    const day = adjustedDate.getDate().toString().padStart(2, '0');
    const month = (adjustedDate.getMonth() + 1).toString().padStart(2, '0');
    const year = adjustedDate.getFullYear();
    const hours = adjustedDate.getHours().toString().padStart(2, '0');
    const minutes = adjustedDate.getMinutes().toString().padStart(2, '0');
    
    return `${day}/${month}/${year} ${hours}:${minutes}`;
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

// Função para processar URLs de imagens
function processImageUrls(imageData) {
  try {
    const urls = typeof imageData === 'string' ? JSON.parse(imageData || '[]') : imageData || [];
    const urlArray = Array.isArray(urls) ? urls : [urls];
    
    return urlArray.map(url => {
      if (!url) return null;
      return url.startsWith('http') ? url : `${BASE_URL}${url.replace(/^\/+/, '')}`;
    }).filter(url => url !== null && isValidImageUrl(url));
  } catch (error) {
    console.error('Erro ao processar URLs de imagem:', error);
    return [];
  }
}

// Função para extrair URLs de imagens válidas
function extractValidImageUrls(jsonString) {
  return processImageUrls(jsonString);
}

// Função para responder a interações de forma segura
async function safeInteractionReply(interaction, content) {
  try {
    if (interaction.replied || interaction.deferred) {
      return await interaction.editReply(content).catch(console.error);
    } else {
      return await interaction.reply(content).catch(console.error);
    }
  } catch (error) {
    console.error('❌ Erro ao responder interação:', error);
    return null;
  }
}

// Busca paralela em guildas com Promise.allSettled
async function parallelGuildSearch(name, nameLower, guilds = GUILDS_TO_CHECK) {
  const baseUrl = 'https://www.mucabrasil.com.br/?go=guild&n=';
  
  try {
    const requests = guilds.flatMap(guild => {
      return [1, 2].map(page => {
        const url = `${baseUrl}${guild}${page > 1 ? `&p=${page}` : ''}`;
        return axios.get(url, { 
          timeout: 5000,
          headers: {
            'User-Agent': 'ToHeLL-Discord-Bot/1.0'
          }
        })
          .then(response => ({ html: response.data, guild, page }))
          .catch(error => {
            console.error(`❌ Erro ao buscar guilda ${guild} página ${page}:`, error.message);
            return null;
          });
      });
    });

    const responses = await Promise.allSettled(requests);
    
    for (const response of responses) {
      if (response.status === 'fulfilled' && response.value) {
        const { html, guild, page } = response.value;
        const dom = new JSDOM(html);
        const doc = dom.window.document;
        
        const rows = doc.querySelectorAll('tr');
        for (const row of rows) {
          const cells = row.querySelectorAll('td');
          if (cells.length >= 4) {
            const charName = cells[1].textContent.trim();
            if (charName.toLowerCase() === nameLower) {
              return {
                name: charName,
                level: parseInt(cells[2].textContent.trim()) || 0,
                resets: parseInt(cells[3].textContent.trim()) || 0,
                guild,
                found_at: new Date().toISOString()
              };
            }
          }
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
  const nameLower = name.toLowerCase();
  
  try {
    const [dbRows] = await dbConnection.execute(
      'SELECT * FROM characters WHERE name = ? LIMIT 1',
      [name]
    );
    
    let character = dbRows[0];
    const cacheValid = character && new Date(character.last_seen) > new Date(Date.now() - 300000);
    
    if (cacheValid) {
      return character;
    }
    
    const mainGuildsSearch = parallelGuildSearch(name, nameLower, ['ToHeLL_', 'ToHeLL2', 'ToHeLL3']);
    const otherGuildsSearch = parallelGuildSearch(name, nameLower, GUILDS_TO_CHECK.filter(g => !['ToHeLL_', 'ToHeLL2', 'ToHeLL3'].includes(g)));
    
    const [mainResult, otherResult] = await Promise.allSettled([mainGuildsSearch, otherGuildsSearch]);
    
    const guildData = mainResult.status === 'fulfilled' && mainResult.value ? 
      mainResult.value : 
      (otherResult.status === 'fulfilled' && otherResult.value ? otherResult.value : null);
    
    if (guildData) {
      if (dbRows.length > 0) {
        await dbConnection.execute(
          'UPDATE characters SET last_level = ?, last_resets = ?, guild = ?, last_seen = NOW() WHERE id = ?',
          [guildData.level, guildData.resets, guildData.guild, dbRows[0].id]
        );
      } else {
        await dbConnection.execute(
          'INSERT INTO characters (name, guild, last_level, last_resets, last_seen) VALUES (?, ?, ?, ?, NOW())',
          [guildData.name, guildData.guild, guildData.level, guildData.resets]
        );
        
        const [inserted] = await dbConnection.execute('SELECT LAST_INSERT_ID() as id');
        guildData.id = inserted[0].id;
      }
      
      await dbConnection.execute(
        'INSERT INTO character_history (character_id, level, resets) VALUES (?, ?, ?)',
        [guildData.id, guildData.level, guildData.resets]
      );
      
      return guildData;
    }
    
    return character || null;
  } catch (error) {
    console.error('❌ Erro em searchCharacterWithCache:', error);
    return null;
  }
}

// Função principal para buscar personagem
async function searchCharacterInDatabaseOrGuilds(name, dbConnection) {
  return searchCharacterWithCache(name, dbConnection);
}

// Calcular estatísticas avançadas
async function calculateAdvancedStats(characterId, dbConnection) {
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
      
      const timeDelta = (current.timestamp - prev.timestamp) / 3600;
      const levelDelta = current.level - prev.level;
      const resetDelta = current.resets - prev.resets;
      
      if (timeDelta > 0) {
        levelChanges.push(levelDelta / timeDelta);
        if (resetDelta > 0) {
          resetChanges.push(resetDelta);
          timeDeltas.push(timeDelta / 24);
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
  const embed = new EmbedBuilder()
    .setColor(found ? '#00FF00' : '#FF0000')
    .setTitle(`Personagem: ${name}`)
    .addFields(
      { name: '⚔️ Level', value: level?.toString() || 'Desconhecido', inline: true },
      { name: '🔄 Resets', value: resets?.toString() || '0', inline: true },
      { name: '🏰 Guilda', value: guild || 'Nenhuma', inline: true }
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
      `📅 ${formatBrazilianDate(entry.recorded_at)}: Level ${entry.level} | Resets ${entry.resets}`
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
  if (interaction.replied || interaction.deferred) {
    console.log('⚠️ Interação já foi respondida, ignorando nova tentativa');
    return;
  }

  let replied = false;
  const reply = async (content) => {
    if (!replied) {
      replied = true;
      try {
        if (interaction.deferred) {
          await interaction.editReply(content);
        } else {
          await interaction.reply(content);
        }
      } catch (error) {
        console.error('❌ Erro ao enviar resposta:', error);
      }
    }
  };

  try {
    console.log(`🔍 Iniciando busca por ${charName}`);

    // Verificar conexão com o banco de dados
    if (!dbConnection || !(await dbConnection.execute('SELECT 1').catch(() => false))) {
      console.error('❌ Conexão com o banco de dados não está ativa');
      return reply({
        content: 'Erro de conexão com o banco de dados. Por favor, tente novamente mais tarde.',
        ephemeral: true
      });
    }

    // Deferir a resposta primeiro
    await interaction.deferReply();
    console.log(`⏳ Resposta deferida para busca de ${charName}`);

    // Timeout de 10 segundos
    const timeout = setTimeout(async () => {
      if (!replied) {
        console.error('⌛ Timeout excedido para busca de personagem');
        await reply({
          content: 'A busca está demorando mais que o esperado. Por favor, tente novamente.',
          ephemeral: true
        });
      }
    }, 10000);

    // Executar a busca
    const charData = await searchCharacterWithCache(charName, dbConnection);
    
    if (!charData) {
      console.log(`🔍 Personagem ${charName} não encontrado, verificando histórico...`);
      const [historyRows] = await dbConnection.execute(
        'SELECT * FROM characters WHERE LOWER(name) = ? LIMIT 1',
        [charName.toLowerCase()]
      );
      
      if (historyRows.length > 0) {
        const lastKnown = historyRows[0];
        console.log(`📌 Exibindo dados históricos para ${charName}`);
        return reply({
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
      
      console.log(`❌ Personagem ${charName} não encontrado em nenhum lugar`);
      return reply({
        content: `Personagem "${charName}" não encontrado em nenhuma guilda da ToHeLL.`
      });
    }
    
    console.log(`✅ Dados encontrados para ${charName}, buscando histórico e estatísticas...`);
    
    // Obter histórico e estatísticas em paralelo
    const [history, advancedStats] = await Promise.all([
      dbConnection.execute(
        'SELECT level, resets, recorded_at FROM character_history WHERE character_id = ? ORDER BY recorded_at DESC LIMIT 5',
        [charData.id]
      ),
      calculateAdvancedStats(charData.id, dbConnection)
    ]);
    
    // Criar embed de resposta
    const embed = createCharEmbed({
      name: charData.name,
      level: charData.level,
      resets: charData.resets,
      guild: charData.guild,
      found: true,
      history: history[0],
      stats: advancedStats
    });
    
    console.log(`📊 Embed criado para ${charName}, enviando resposta...`);
    await reply({ embeds: [embed] });
    clearTimeout(timeout);
    
  } catch (error) {
    console.error('❌ Erro ao buscar personagem:', error);
    await reply({
      content: 'Ocorreu um erro ao buscar o personagem. Por favor, tente novamente mais tarde.',
      ephemeral: true
    });
  }
}

// Mostrar ranking
async function showRanking(interaction, period, dbConnection) {
  try {
    await interaction.deferReply().catch(console.error);

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
      }).catch(console.error);
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
    
    await interaction.editReply({ embeds: [embed] }).catch(console.error);
    
  } catch (error) {
    console.error('❌ Erro ao buscar ranking:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: 'Ocorreu um erro ao buscar o ranking. Por favor, tente novamente mais tarde.',
        flags: MessageFlags.Ephemeral
      }).catch(console.error);
    } else if (interaction.deferred && !interaction.replied) {
      await interaction.editReply({
        content: 'Ocorreu um erro ao buscar o ranking. Por favor, tente novamente mais tarde.'
      }).catch(console.error);
    }
  }
}

// Gerenciar permissões de comandos
async function addCommandPermission(commandName, roleId, dbConnection) {
  try {
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
  
  const allowedRoles = await getCommandPermissions(commandName, dbConnection);
  
  if (allowedRoles.length === 0) return true;
  
  return interaction.member.roles.cache.some(role => allowedRoles.includes(role.id));
}

// Notificar no webhook
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
    timestamp: new Date(new Date().getTime() - 3 * 60 * 60 * 1000).toISOString()
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

// Envio seguro de mensagens
async function safeSend(channel, content) {
  try {
    return await channel.send(content);
  } catch (error) {
    console.error('❌ Erro ao enviar mensagem:', error);
    return null;
  }
}

module.exports = {
  formatBrazilianDate,
  isValidImageUrl,
  extractValidImageUrls,
  processImageUrls,
  safeInteractionReply,
  safeSend,
  parallelGuildSearch,
  searchCharacterInDatabaseOrGuilds,
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
  searchCharacterWithCache
};