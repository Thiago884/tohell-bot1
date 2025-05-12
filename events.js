const { Events, EmbedBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { safeSend, searchCharacterWithCache, showRanking, searchCharacter, getCommandPermissions, addCommandPermission, removeCommandPermission, checkUserPermission, formatBrazilianDate, processImageUrls, blockIP, queryIP, getIPInfo, generateSecurityReport, getRecentAccess, manageWhitelist } = require('./utils');
const { isShuttingDown } = require('./database');
const { listPendingApplications, searchApplications, sendApplicationEmbed, approveApplication, rejectApplication, showHelp, createImageCarousel } = require('./commands');

// Monitor de inscrições pendentes
let lastCheckedApplications = new Date();

// Sistema de tracking de personagens
class CharacterTracker {
  constructor(db) {
    this.db = db;
    this.trackedCharacters = new Map();
    this.trackingInterval = null;
  }

  async startTracking() {
    await this.loadTrackedCharacters();
    this.trackingInterval = setInterval(() => this.checkTrackedCharacters(), 5 * 60 * 1000); // Verificar a cada 5 minutos
    console.log('✅ Sistema de tracking iniciado');
  }

  async loadTrackedCharacters() {
    try {
      const [rows] = await this.db.execute('SELECT * FROM tracked_characters');
      this.trackedCharacters = new Map(rows.map(row => [row.name.toLowerCase(), row]));
      console.log(`✅ Carregados ${rows.length} personagens monitorados`);
    } catch (error) {
      console.error('❌ Erro ao carregar personagens monitorados:', error);
    }
  }

  async checkTrackedCharacters() {
    if (isShuttingDown) return;
    
    console.log('🔍 Verificando personagens monitorados...');
    const notifications = [];
    
    for (const [nameLower, trackingData] of this.trackedCharacters) {
      try {
        const charName = trackingData.name;
        const charData = await searchCharacterWithCache(charName, this.db);
        
        if (charData) {
          const changes = [];
          
          if (charData.level !== trackingData.last_level) {
            changes.push(`Level: ${trackingData.last_level || 'N/A'} → ${charData.level}`);
          }
          
          if (charData.resets !== trackingData.last_resets) {
            changes.push(`Resets: ${trackingData.last_resets || 'N/A'} → ${charData.resets}`);
          }
          
          if (changes.length > 0) {
            notifications.push({
              trackingData,
              charData,
              changes
            });
            
            await this.db.execute(
              'UPDATE tracked_characters SET last_level = ?, last_resets = ? WHERE id = ?',
              [charData.level, charData.resets, trackingData.id]
            );
          }
        }
      } catch (error) {
        console.error(`❌ Erro ao verificar personagem ${trackingData.name}:`, error);
      }
    }
    
    await this.sendNotifications(notifications);
  }

  async sendNotifications(notifications) {
    for (const { trackingData, charData, changes } of notifications) {
      try {
        const channel = trackingData.channel_id ? 
          await client.channels.fetch(trackingData.channel_id) : 
          await client.users.fetch(trackingData.discord_user_id).then(user => user.createDM());
          
        const embed = new EmbedBuilder()
          .setColor('#00FF00')
          .setTitle(`📢 Progresso de ${charData.name}`)
          .setDescription(`O personagem ${charData.name} teve mudanças!`)
          .addFields(
            { name: '🏰 Guilda', value: charData.guild || 'Nenhuma', inline: true },
            { name: 'Mudanças', value: changes.join('\n'), inline: false }
          )
          .setTimestamp();
          
        await channel.send({ embeds: [embed] });
        console.log(`✅ Notificação enviada para ${trackingData.name}`);
      } catch (error) {
        console.error(`❌ Erro ao enviar notificação para ${trackingData.name}:`, error);
      }
    }
  }

  async addTracking(name, userId, channelId = null) {
    try {
      const charData = await searchCharacterWithCache(name, this.db);
      if (!charData) {
        throw new Error('Personagem não encontrado');
      }
      
      await this.db.execute(
        'INSERT INTO tracked_characters (name, discord_user_id, channel_id, last_level, last_resets) VALUES (?, ?, ?, ?, ?) ' +
        'ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id), last_level = VALUES(last_level), last_resets = VALUES(last_resets)',
        [name, userId, channelId, charData.level, charData.resets]
      );
      
      await this.loadTrackedCharacters();
      return true;
    } catch (error) {
      console.error('❌ Erro ao adicionar tracking:', error);
      throw error;
    }
  }

  async removeTracking(name, userId) {
    try {
      const [result] = await this.db.execute(
        'DELETE FROM tracked_characters WHERE name = ? AND discord_user_id = ?',
        [name, userId]
      );
      
      await this.loadTrackedCharacters();
      return result.affectedRows > 0;
    } catch (error) {
      console.error('❌ Erro ao remover tracking:', error);
      throw error;
    }
  }

  async listTracked(userId) {
    try {
      const [rows] = await this.db.execute(
        'SELECT * FROM tracked_characters WHERE discord_user_id = ?',
        [userId]
      );
      return rows;
    } catch (error) {
      console.error('❌ Erro ao listar personagens monitorados:', error);
      throw error;
    }
  }
}

// Monitoramento de segurança
async function setupSecurityMonitoring(client, db) {
  // Verifica tentativas suspeitas a cada 5 minutos
  setInterval(async () => {
    if (isShuttingDown) return;
    
    try {
      // IPs com muitas tentativas de login em curto período
      const [suspiciousLogins] = await db.execute(`
        SELECT ip, COUNT(*) as tentativas 
        FROM tentativas_login_falhas 
        WHERE data_acesso >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
        GROUP BY ip 
        HAVING tentativas > 5
        ORDER BY tentativas DESC
      `);
      
      // IPs bloqueados que tentaram acessar
      const [blockedAccess] = await db.execute(`
        SELECT v.ip, COUNT(*) as tentativas, MAX(v.data_acesso) as ultima_tentativa
        FROM visitantes v
        JOIN ips_bloqueados b ON v.ip = b.ip
        WHERE v.data_acesso >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
        GROUP BY v.ip
        ORDER BY tentativas DESC
      `);
      
      // Envia notificações se houver atividade suspeita
      const securityChannel = await client.channels.fetch(process.env.SECURITY_CHANNEL_ID);
      if (!securityChannel) return;
      
      if (suspiciousLogins.length > 0) {
        const embed = new EmbedBuilder()
          .setColor('#FF0000')
          .setTitle('⚠️ Tentativas Suspeitas de Login')
          .setDescription('Os seguintes IPs tentaram acessar várias vezes em um curto período:');
          
        suspiciousLogins.forEach(ip => {
          embed.addFields({
            name: `IP: ${ip.ip}`,
            value: `Tentativas: ${ip.tentativas} na última hora`,
            inline: false
          });
        });
        
        await securityChannel.send({ embeds: [embed] });
      }
      
      if (blockedAccess.length > 0) {
        const embed = new EmbedBuilder()
          .setColor('#FFA500')
          .setTitle('⚠️ IPs Bloqueados Tentando Acessar')
          .setDescription('Os seguintes IPs bloqueados tentaram acessar o site:');
          
        blockedAccess.forEach(ip => {
          embed.addFields({
            name: `IP: ${ip.ip}`,
            value: `Tentativas: ${ip.tentativas} | Última: ${formatBrazilianDate(ip.ultima_tentativa)}`,
            inline: false
          });
        });
        
        await securityChannel.send({ embeds: [embed] });
      }
    } catch (error) {
      console.error('Erro no monitoramento de segurança:', error);
    }
  }, 5 * 60 * 1000); // 5 minutos
  
  console.log('✅ Monitoramento de segurança iniciado');
}

// Limpeza automática de registros
async function setupAutoCleanup(db) {
  // Executa a limpeza diária às 3:00 AM
  const now = new Date();
  const nextCleanup = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    3, 0, 0
  );
  
  const timeUntilCleanup = nextCleanup - now;
  
  setTimeout(async function runCleanup() {
    if (isShuttingDown) return;
    
    try {
      console.log('🔄 Iniciando limpeza automática de registros antigos...');
      
      // Remove bloqueios com mais de 30 dias
      await db.execute(
        'DELETE FROM ips_bloqueados WHERE data_bloqueio < DATE_SUB(NOW(), INTERVAL 30 DAY)'
      );
      
      // Remove tentativas de login com mais de 7 dias
      await db.execute(
        'DELETE FROM tentativas_login_falhas WHERE data_acesso < DATE_SUB(NOW(), INTERVAL 7 DAY)'
      );
      
      // Remove registros de visitantes com mais de 30 dias
      await db.execute(
        'DELETE FROM visitantes WHERE data_acesso < DATE_SUB(NOW(), INTERVAL 30 DAY)'
      );
      
      console.log('✅ Limpeza automática concluída');
      
      // Agenda a próxima limpeza para 24 horas depois
      setTimeout(runCleanup, 24 * 60 * 60 * 1000);
    } catch (error) {
      console.error('❌ Erro na limpeza automática:', error);
      // Tenta novamente em 1 hora se falhar
      setTimeout(runCleanup, 60 * 60 * 1000);
    }
  }, timeUntilCleanup);
  
  console.log('✅ Limpeza automática agendada');
}

// Verificar novas inscrições
async function checkNewApplications(client, db) {
  if (isShuttingDown) return;
  
  try {
    if (!db) {
      console.log('⚠️ Conexão com o banco de dados não está disponível, tentando reconectar...');
      return;
    }

    const [rows] = await db.execute(
      'SELECT * FROM inscricoes_pendentes WHERE data_inscricao > ? ORDER BY data_inscricao DESC',
      [lastCheckedApplications]
    );
    
    if (rows.length > 0) {
      const channel = await client.channels.fetch(process.env.ALLOWED_CHANNEL_ID);
      lastCheckedApplications = new Date();
      
      await channel.send({
        content: `📢 Há ${rows.length} nova(s) inscrição(ões) pendente(s)! Use /pendentes para visualizar.`
      });
      
      for (const application of rows) {
        await sendApplicationEmbed(channel, application, db);
      }
    }
  } catch (error) {
    console.error('❌ Erro ao verificar novas inscrições:', error);
  }
}

// Configurar eventos
function setupEvents(client, db) {
  const tracker = new CharacterTracker(db);

  // Evento ready
  client.on(Events.ClientReady, async () => {
    console.log(`🤖 Bot conectado como ${client.user.tag}`);
    client.user.setActivity('/ajuda para comandos', { type: 'WATCHING' });
    
    await tracker.startTracking();
    await setupSecurityMonitoring(client, db);
    await setupAutoCleanup(db);
    setInterval(() => checkNewApplications(client, db), 60000); // Verificar novas inscrições a cada 1 minuto
  });

  // Evento interactionCreate
  client.on(Events.InteractionCreate, async interaction => {
    if (isShuttingDown) return;

    try {
      // Comandos slash
      if (interaction.isCommand()) {
        console.log(`🔍 Comando slash detectado: ${interaction.commandName}`, interaction.options.data);

        if (!await checkUserPermission(interaction, interaction.commandName, db)) {
          return interaction.reply({
            content: '❌ Você não tem permissão para usar este comando.',
            ephemeral: true
          }).catch(console.error);
        }

        switch (interaction.commandName) {
          case 'pendentes':
            const page = interaction.options.getInteger('página') || 1;
            await listPendingApplications(interaction, [page.toString()], db);
            break;
            
          case 'buscar':
            const term = interaction.options.getString('termo');
            const searchPage = interaction.options.getInteger('página') || 1;
            await searchApplications(interaction, [term, searchPage.toString()], db);
            break;
            
          case 'char':
            const charName = interaction.options.getString('nome');
            console.log(`🔍 Comando /char recebido para personagem: ${charName}`);
            await searchCharacter(interaction, charName, db);
            break;
            
          case 'ranking':
            const period = interaction.options.getString('período');
            await showRanking(interaction, period, db);
            break;
            
          case 'monitorar':
            const charToTrack = interaction.options.getString('nome');
            const channel = interaction.options.getChannel('canal');
            
            await interaction.deferReply({ ephemeral: true }).catch(console.error);
            
            try {
              await tracker.addTracking(
                charToTrack, 
                interaction.user.id, 
                channel?.id
              );
              
              await interaction.editReply({
                content: `✅ Personagem "${charToTrack}" está sendo monitorado${channel ? ` no canal ${channel.name}` : ''}.`
              }).catch(console.error);
            } catch (error) {
              await interaction.editReply({
                content: `❌ Erro ao monitorar personagem: ${error.message}`
              }).catch(console.error);
            }
            break;
            
          case 'parar-monitorar':
            const charToStop = interaction.options.getString('nome');
            
            await interaction.deferReply({ ephemeral: true }).catch(console.error);
            
            try {
              const removed = await tracker.removeTracking(charToStop, interaction.user.id);
              
              await interaction.editReply({
                content: removed ? 
                  `✅ Personagem "${charToStop}" não será mais monitorado.` :
                  `❌ Personagem "${charToStop}" não estava sendo monitorado.`
              }).catch(console.error);
            } catch (error) {
              await interaction.editReply({
                content: `❌ Erro ao parar de monitorar: ${error.message}`
              }).catch(console.error);
            }
            break;
            
          case 'listar-monitorados':
            await interaction.deferReply({ ephemeral: true }).catch(console.error);
            
            try {
              const tracked = await tracker.listTracked(interaction.user.id);
              
              if (tracked.length === 0) {
                return interaction.editReply({
                  content: 'Você não está monitorando nenhum personagem no momento.'
                }).catch(console.error);
              }
              
              const embed = new EmbedBuilder()
                .setColor('#FFA500')
                .setTitle('Personagens Monitorados')
                .setDescription('Lista de personagens que você está monitorando:');
                
              tracked.forEach(char => {
                embed.addFields({
                  name: char.name,
                  value: `Último level: ${char.last_level || 'N/A'}\n` +
                         `Últimos resets: ${char.last_resets || 'N/A'}`,
                  inline: true
                });
              });
              
              await interaction.editReply({ embeds: [embed] }).catch(console.error);
            } catch (error) {
              await interaction.editReply({
                content: `❌ Erro ao listar personagens monitorados: ${error.message}`
              }).catch(console.error);
            }
            break;
            
          case 'ajuda':
            await showHelp(interaction);
            break;

          case 'admin-permissoes':
            if (!interaction.member.permissions.has('ADMINISTRATOR')) {
              return interaction.reply({
                content: '❌ Este comando é restrito a administradores.',
                ephemeral: true
              }).catch(console.error);
            }

            const commandName = interaction.options.getString('comando');
            const action = interaction.options.getString('acao');
            const role = interaction.options.getRole('cargo');

            await interaction.deferReply({ ephemeral: true }).catch(console.error);

            try {
              if (action === 'list') {
                const roleIds = await getCommandPermissions(commandName, db);
                
                if (roleIds.length === 0) {
                  return interaction.editReply({
                    content: `Nenhum cargo tem permissão para o comando /${commandName}`
                  }).catch(console.error);
                }

                const roles = roleIds.map(id => interaction.guild.roles.cache.get(id)?.toString() || id).join('\n');
                return interaction.editReply({
                  content: `Cargos com permissão para /${commandName}:\n${roles}`
                }).catch(console.error);
              }

              if (!role) {
                return interaction.editReply({
                  content: 'Por favor, especifique um cargo para esta ação.'
                }).catch(console.error);
              }

              if (action === 'add') {
                const success = await addCommandPermission(commandName, role.id, db);
                return interaction.editReply({
                  content: success ? 
                    `✅ Cargo ${role.name} agora tem permissão para /${commandName}` :
                    '❌ Falha ao adicionar permissão. O cargo já pode ter esta permissão.'
                }).catch(console.error);
              }

              if (action === 'remove') {
                const success = await removeCommandPermission(commandName, role.id, db);
                return interaction.editReply({
                  content: success ? 
                    `✅ Cargo ${role.name} não tem mais permissão para /${commandName}` :
                    '❌ Falha ao remover permissão. O cargo pode não ter esta permissão.'
                }).catch(console.error);
              }
            } catch (error) {
              console.error('❌ Erro ao gerenciar permissões:', error);
              return interaction.editReply({
                content: 'Ocorreu um erro ao processar sua solicitação.'
              }).catch(console.error);
            }
            break;

          case 'bloquear-ip':
            const ip = interaction.options.getString('ip');
            const motivo = interaction.options.getString('motivo');

            await interaction.deferReply();

            try {
              const result = await blockIP(ip, motivo, db, interaction.user.id);
              
              if (!result.success) {
                return interaction.editReply({
                  content: `❌ ${result.message}`,
                  ephemeral: true
                }).catch(console.error);
              }

              const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('✅ IP Bloqueado com Sucesso')
                .addFields(
                  { name: 'IP', value: ip, inline: true },
                  { name: 'Motivo', value: motivo, inline: true },
                  { name: 'País', value: result.geoInfo.country || 'Desconhecido', inline: true },
                  { name: 'Cidade', value: result.geoInfo.city || 'Desconhecida', inline: true },
                  { name: 'Provedor', value: result.geoInfo.org || 'Desconhecido', inline: true }
                )
                .setTimestamp();

              await interaction.editReply({ embeds: [embed] });

              // Notificar canal de segurança
              const securityChannel = await client.channels.fetch(process.env.SECURITY_CHANNEL_ID);
              if (securityChannel) {
                const notifyEmbed = new EmbedBuilder()
                  .setColor('#FF0000')
                  .setTitle('⚠️ Novo IP Bloqueado')
                  .setDescription(`O IP ${ip} foi bloqueado por ${interaction.user.tag}`)
                  .addFields(
                    { name: 'Motivo', value: motivo },
                    { name: 'Localização', value: `${result.geoInfo.city}, ${result.geoInfo.country}` }
                  )
                  .setTimestamp();
                
                await securityChannel.send({ embeds: [notifyEmbed] });
              }
            } catch (error) {
              console.error('Erro ao bloquear IP:', error);
              await interaction.editReply({
                content: '❌ Ocorreu um erro ao bloquear o IP.',
                ephemeral: true
              }).catch(console.error);
            }
            break;

          case 'consultar-ip':
            const ipToQuery = interaction.options.getString('ip');

            await interaction.deferReply();

            try {
              const result = await queryIP(ipToQuery, db);
              
              if (!result) {
                return interaction.editReply({
                  content: '❌ Não foi possível consultar o IP.',
                  ephemeral: true
                }).catch(console.error);
              }

              const embed = new EmbedBuilder()
                .setColor(result.blocked ? '#FF0000' : result.whitelisted ? '#00FF00' : '#FFFF00')
                .setTitle(`🌍 Informações do IP: ${ipToQuery}`)
                .addFields(
                  { name: 'Status', 
                    value: result.blocked ? '🚫 Bloqueado' : result.whitelisted ? '✅ Whitelist' : '⚠️ Não bloqueado', 
                    inline: true 
                  },
                  { name: 'País', value: result.geoInfo?.country || 'Desconhecido', inline: true },
                  { name: 'Código País', value: result.geoInfo?.countryCode || 'N/A', inline: true },
                  { name: 'Região', value: result.geoInfo?.region || 'Desconhecida', inline: true },
                  { name: 'Cidade', value: result.geoInfo?.city || 'Desconhecida', inline: true },
                  { name: 'Código Postal', value: result.geoInfo?.postal || 'N/A', inline: true },
                  { name: 'Provedor', value: result.geoInfo?.org || 'Desconhecido', inline: false }
                );

              if (result.blocked) {
                embed.addFields(
                  { name: 'Motivo do Bloqueio', value: result.blocked.motivo || 'Não especificado', inline: false },
                  { name: 'Bloqueado por', value: result.blocked.bloqueado_por || 'Sistema', inline: true },
                  { name: 'Data do Bloqueio', value: formatBrazilianDate(result.blocked.data_bloqueio), inline: true }
                );
              }

              if (result.whitelisted) {
                embed.addFields(
                  { name: 'Motivo da Whitelist', value: result.whitelisted.motivo || 'Não especificado', inline: false },
                  { name: 'Adicionado por', value: result.whitelisted.criado_por || 'Sistema', inline: true },
                  { name: 'Data da Whitelist', value: formatBrazilianDate(result.whitelisted.data_criacao), inline: true }
                );
              }

              // Adicionar coordenadas se disponíveis
              if (result.geoInfo?.coordinates) {
                embed.addFields(
                  { name: 'Coordenadas', value: result.geoInfo.coordinates, inline: true },
                  { name: 'Fuso Horário', value: result.geoInfo.timezone || 'N/A', inline: true }
                );
              }

              await interaction.editReply({ embeds: [embed] });
            } catch (error) {
              console.error('Erro ao consultar IP:', error);
              await interaction.editReply({
                content: '❌ Ocorreu um erro ao consultar o IP.',
                ephemeral: true
              }).catch(console.error);
            }
            break;

          case 'relatorio-seguranca':
            const periodo = interaction.options.getString('periodo') || '24h';

            await interaction.deferReply();

            try {
              const report = await generateSecurityReport(db, periodo);
              
              if (!report) {
                return interaction.editReply({
                  content: '❌ Não foi possível gerar o relatório.',
                  ephemeral: true
                }).catch(console.error);
              }

              let periodName;
              switch (periodo) {
                case '7d': periodName = 'últimos 7 dias'; break;
                case '30d': periodName = 'últimos 30 dias'; break;
                default: periodName = 'últimas 24 horas';
              }

              const embed = new EmbedBuilder()
                .setColor('#FFA500')
                .setTitle(`📊 Relatório de Segurança - ${periodName}`)
                .addFields(
                  { name: 'IPs Bloqueados Recentemente', 
                    value: report.blockedIPs.length > 0 ? 
                      report.blockedIPs.map(ip => `• ${ip.ip} (${ip.pais}) - ${ip.motivo}`).join('\n') : 
                      'Nenhum IP bloqueado neste período',
                    inline: false 
                  },
                  { name: 'Tentativas Suspeitas', 
                    value: report.suspiciousAccess.length > 0 ? 
                      report.suspiciousAccess.map(acc => `• ${acc.ip}: ${acc.tentativas} tentativas`).join('\n') : 
                      'Nenhuma tentativa suspeita',
                    inline: false 
                  },
                  { name: 'IPs Mais Problemáticos', 
                    value: report.problematicIPs.length > 0 ? 
                      report.problematicIPs.map(ip => `• ${ip.ip}: ${ip.bloqueios} bloqueios`).join('\n') : 
                      'Nenhum IP problemático',
                    inline: false 
                  }
                );

              await interaction.editReply({ embeds: [embed] });
            } catch (error) {
              console.error('Erro ao gerar relatório:', error);
              await interaction.editReply({
                content: '❌ Ocorreu um erro ao gerar o relatório.',
                ephemeral: true
              }).catch(console.error);
            }
            break;

          case 'ultimos-acessos':
            const limit = interaction.options.getInteger('limite') || 10;
            const country = interaction.options.getString('pais');

            await interaction.deferReply();

            try {
              const accesses = await getRecentAccess(db, limit, country);
              
              if (!accesses || accesses.length === 0) {
                return interaction.editReply({
                  content: '❌ Nenhum acesso encontrado com os filtros especificados.',
                  ephemeral: true
                }).catch(console.error);
              }

              const embed = new EmbedBuilder()
                .setColor('#3498db')
                .setTitle(`🌐 Últimos Acessos${country ? ` (Filtro: ${country})` : ''}`)
                .setDescription(`Lista dos últimos ${accesses.length} acessos ao site:`);

              accesses.forEach(access => {
                embed.addFields({
                  name: `📅 ${formatBrazilianDate(access.data_acesso)}`,
                  value: `• IP: ${access.ip}\n• Página: ${access.pagina}\n• Navegador: ${access.user_agent.substring(0, 50)}...`,
                  inline: false
                });
              });

              await interaction.editReply({ embeds: [embed] });
            } catch (error) {
              console.error('Erro ao buscar acessos:', error);
              await interaction.editReply({
                content: '❌ Ocorreu um erro ao buscar os últimos acessos.',
                ephemeral: true
              }).catch(console.error);
            }
            break;

          case 'whitelist':
            const whitelistAction = interaction.options.getString('acao');
            const ipWhitelist = interaction.options.getString('ip');
            const motivoWhitelist = interaction.options.getString('motivo');

            await interaction.deferReply();

            try {
              if (whitelistAction !== 'list' && !ipWhitelist) {
                return interaction.editReply({
                  content: '❌ Por favor, especifique um IP para esta ação.',
                  ephemeral: true
                }).catch(console.error);
              }

              const result = await manageWhitelist(whitelistAction, ipWhitelist, motivoWhitelist, db, interaction.user.id);
              
              if (!result.success) {
                return interaction.editReply({
                  content: `❌ ${result.message}`,
                  ephemeral: true
                }).catch(console.error);
              }

              if (whitelistAction === 'list') {
                if (result.data.length === 0) {
                  return interaction.editReply({
                    content: 'Nenhum IP na whitelist.',
                    ephemeral: true
                  }).catch(console.error);
                }

                const embed = new EmbedBuilder()
                  .setColor('#00FF00')
                  .setTitle('📝 IPs na Whitelist')
                  .setDescription(`Lista dos ${result.data.length} IPs permitidos:`);

                result.data.forEach(ip => {
                  embed.addFields({
                    name: `✅ ${ip.ip}`,
                    value: `• Motivo: ${ip.motivo || 'Não especificado'}\n• Adicionado em: ${formatBrazilianDate(ip.data_criacao)}`,
                    inline: false
                  });
                });

                await interaction.editReply({ embeds: [embed] });
              } else {
                await interaction.editReply({
                  content: `✅ ${result.message}`,
                  ephemeral: true
                }).catch(console.error);

                // Notificar canal de segurança
                const securityChannel = await client.channels.fetch(process.env.SECURITY_CHANNEL_ID);
                if (securityChannel) {
                  const actionText = whitelistAction === 'add' ? 'adicionado à' : 'removido da';
                  const notifyEmbed = new EmbedBuilder()
                    .setColor(whitelistAction === 'add' ? '#00FF00' : '#FFA500')
                    .setTitle(`⚠️ IP ${actionText} Whitelist`)
                    .setDescription(`O IP ${ipWhitelist} foi ${actionText} whitelist por ${interaction.user.tag}`)
                    .addFields(
                      { name: 'Motivo', value: motivoWhitelist || 'Não especificado' }
                    )
                    .setTimestamp();
                  
                  await securityChannel.send({ embeds: [notifyEmbed] });
                }
              }
            } catch (error) {
              console.error('Erro ao gerenciar whitelist:', error);
              await interaction.editReply({
                content: '❌ Ocorreu um erro ao gerenciar a whitelist.',
                ephemeral: true
              }).catch(console.error);
            }
            break;
        }
      }

      // Botões
      if (interaction.isButton()) {
        if (interaction.channel?.id !== process.env.ALLOWED_CHANNEL_ID) {
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
            
            await interaction.deferUpdate().catch(console.error);
            await interaction.message.delete().catch(() => {});
            await listPendingApplications(interaction, [page.toString()], db);
            return;
          }

          if (interaction.customId.startsWith('search_prev_') || interaction.customId.startsWith('search_next_')) {
            const [direction, searchTerm, pageStr] = interaction.customId.split('_').slice(1);
            let page = parseInt(pageStr);
            
            page = direction === 'prev' ? page - 1 : page + 1;
            
            await interaction.deferUpdate().catch(console.error);
            await interaction.message.delete().catch(() => {});
            await searchApplications(interaction, [searchTerm, page.toString()], db);
            return;
          }

          if (interaction.customId.startsWith('view_screenshots_')) {
            const [_, __, applicationId, status] = interaction.customId.split('_');
            
            try {
              const table = status === 'aprovado' ? 'inscricoes' : 'inscricoes_pendentes';
              
              const [rows] = await db.execute(
                `SELECT screenshot_path FROM ${table} WHERE id = ?`,
                [applicationId]
              );
              
              if (rows.length === 0) {
                return interaction.reply({
                  content: 'Inscrição não encontrada.',
                  ephemeral: true
                }).catch(console.error);
              }
              
              let screenshots = [];
              try {
                screenshots = typeof rows[0].screenshot_path === 'string' ? 
                  JSON.parse(rows[0].screenshot_path || '[]') : 
                  rows[0].screenshot_path || [];
              } catch (e) {
                screenshots = rows[0].screenshot_path ? [rows[0].screenshot_path] : [];
              }
              
              // Processa as URLs para garantir que são absolutas
              const processedScreenshots = processImageUrls(screenshots);
              
              await createImageCarousel(interaction, processedScreenshots, applicationId);
              
            } catch (error) {
              console.error('❌ Erro ao buscar screenshots:', error);
              await interaction.reply({
                content: 'Ocorreu um erro ao buscar as screenshots.',
                ephemeral: true
              }).catch(console.error);
            }
            return;
          }
          
          if (interaction.customId.startsWith('carousel_')) {
            const [_, action, applicationId, currentIndexStr] = interaction.customId.split('_');
            let currentIndex = parseInt(currentIndexStr);
            
            if (action === 'close') {
              try {
                await interaction.message.delete().catch(error => {
                  if (error.code !== 10008) { // Ignora erro de mensagem desconhecida
                    console.error('Erro ao deletar mensagem do carrossel:', error);
                  }
                });
                return;
              } catch (error) {
                if (error.code !== 10008) {
                  console.error('Erro ao deletar mensagem do carrossel:', error);
                }
                return;
              }
            }
            
            // Primeiro verifica na tabela de pendentes
            let [rows] = await db.execute(
              'SELECT screenshot_path FROM inscricoes_pendentes WHERE id = ?',
              [applicationId]
            );
            
            // Se não encontrou, verifica na tabela de aprovados
            if (rows.length === 0) {
              [rows] = await db.execute(
                'SELECT screenshot_path FROM inscricoes WHERE id = ?',
                [applicationId]
              );
            }
            
            if (rows.length === 0) {
              console.log(`Inscrição ${applicationId} não encontrada em nenhuma tabela`);
              return interaction.update({
                content: 'As screenshots não estão mais disponíveis.',
                embeds: [],
                components: []
              }).catch(console.error);
            }
            
            let screenshots = [];
            try {
              screenshots = typeof rows[0].screenshot_path === 'string' ? 
                JSON.parse(rows[0].screenshot_path || '[]') : 
                rows[0].screenshot_path || [];
            } catch (e) {
              screenshots = rows[0].screenshot_path ? [rows[0].screenshot_path] : [];
            }
            
            // Processa as URLs para garantir que são absolutas
            const processedScreenshots = processImageUrls(screenshots);
            
            const totalImages = processedScreenshots.length;
            
            if (action === 'prev' && currentIndex > 0) {
              currentIndex--;
            } else if (action === 'next' && currentIndex < totalImages - 1) {
              currentIndex++;
            }
            
            const embed = new EmbedBuilder()
              .setColor('#FF4500')
              .setTitle(`Screenshot #${currentIndex + 1} de ${totalImages}`)
              .setImage(processedScreenshots[currentIndex]) // Usa a URL processada
              .setFooter({ text: `Inscrição #${applicationId}` });
            
            const row = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`carousel_prev_${applicationId}_${currentIndex}`)
                .setLabel('Anterior')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(currentIndex === 0),
              new ButtonBuilder()
                .setCustomId(`carousel_next_${applicationId}_${currentIndex}`)
                .setLabel('Próxima')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(currentIndex === totalImages - 1),
              new ButtonBuilder()
                .setCustomId(`carousel_close_${applicationId}`)
                .setLabel('Fechar')
                .setStyle(ButtonStyle.Danger)
            );
            
            await interaction.update({
              embeds: [embed],
              components: [row]
            }).catch(console.error);
            return;
          }

          // Aprovar/rejeitar inscrição
          const [action, id] = interaction.customId.split('_');
          
          if (action === 'approve') {
            await approveApplication(interaction, id, db);
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
            
            await interaction.showModal(modal).catch(console.error);
          }
        } catch (error) {
          console.error('❌ Erro ao processar interação:', error);
          interaction.reply({ content: 'Ocorreu um erro ao processar sua ação.', ephemeral: true }).catch(console.error);
        }
      }

      // Modais
      if (interaction.isModalSubmit()) {
        if (interaction.channel?.id !== process.env.ALLOWED_CHANNEL_ID) {
          return interaction.reply({ 
            content: 'Este comando só pode ser usado no canal de inscrições.', 
            ephemeral: true 
          }).catch(console.error);
        }

        try {
          if (interaction.customId.startsWith('reject_reason_')) {
            const id = interaction.customId.split('_')[2];
            const reason = interaction.fields.getTextInputValue('reject_reason');
            
            await interaction.deferReply({ ephemeral: true }).catch(console.error);
            await rejectApplication(interaction, id, reason, db);
          }
        } catch (error) {
          console.error('❌ Erro ao processar modal:', error);
          interaction.reply({ content: 'Ocorreu um erro ao processar sua ação.', ephemeral: true }).catch(console.error);
        }
      }
    } catch (error) {
      console.error('❌ Erro não tratado em InteractionCreate:', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: 'Ocorreu um erro interno. Por favor, tente novamente mais tarde.',
          ephemeral: true
        }).catch(console.error);
      } else if (interaction.deferred) {
        await interaction.editReply({
          content: 'Ocorreu um erro interno. Por favor, tente novamente mais tarde.'
        }).catch(console.error);
      }
    }
  });
}

module.exports = {
  setupEvents,
  CharacterTracker
};