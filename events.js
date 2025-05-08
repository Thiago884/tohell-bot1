const { Events, EmbedBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { safeSend, searchCharacterWithCache, showRanking, searchCharacter, getCommandPermissions, addCommandPermission, removeCommandPermission, checkUserPermission, formatBrazilianDate, processImageUrls } = require('./utils');
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