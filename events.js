const { Events, EmbedBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { safeSend, searchCharacterWithCache, showRanking, searchCharacter, getCommandPermissions, addCommandPermission, removeCommandPermission, checkUserPermission, formatBrazilianDate, processImageUrls, blockIP, unblockIP, queryIP, getIPInfo, generateSecurityReport, getRecentAccess, manageWhitelist, checkPhoneNumber, get500RCharacters } = require('./utils');
const { isShuttingDown } = require('./database');
const { listPendingApplications, searchApplications, sendApplicationEmbed, approveApplication, rejectApplication, showHelp, createImageCarousel } = require('./commands');

// Monitor de inscrições pendentes
let lastCheckedApplications = new Date();

// Monitoramento de segurança
async function setupSecurityMonitoring(client, db) {
  let securityInterval;
  
  // Função para executar a verificação de segurança
  const runSecurityCheck = async () => {
    if (isShuttingDown || !(await db.checkConnection())) {
      if (securityInterval) {
        clearInterval(securityInterval);
        securityInterval = null;
      }
      return;
    }
    
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
  };
  
  // Executa a cada 5 minutos
  securityInterval = setInterval(runSecurityCheck, 5 * 60 * 1000);
  
  // Executa imediatamente a primeira verificação
  runSecurityCheck();
  
  console.log('✅ Monitoramento de segurança iniciado');
  return securityInterval; // Retorna a referência para poder parar depois
}

// Limpeza automática de registros
async function setupAutoCleanup(db) {
  let cleanupTimeout;
  
  const runCleanup = async () => {
    if (isShuttingDown || !(await db.checkConnection())) {
      if (cleanupTimeout) {
        clearTimeout(cleanupTimeout);
        cleanupTimeout = null;
      }
      return;
    }
    
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
    } catch (error) {
      console.error('❌ Erro na limpeza automática:', error);
      // Tenta novamente em 1 hora se falhar
      cleanupTimeout = setTimeout(runCleanup, 60 * 60 * 1000);
    }
  };
  
  // Agendamento inicial
  const now = new Date();
  const nextCleanup = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 3, 0, 0);
  const timeUntilCleanup = nextCleanup - now;
  
  cleanupTimeout = setTimeout(() => {
    runCleanup();
    // Agenda a próxima limpeza para 24 horas depois
    cleanupTimeout = setInterval(runCleanup, 24 * 60 * 60 * 1000);
  }, timeUntilCleanup);
  
  console.log('✅ Limpeza automática agendada');
  return cleanupTimeout; // Retorna a referência
}

// Verificar novas inscrições
async function checkNewApplications(client, db) {
  if (isShuttingDown || !(await db.checkConnection())) return;
  
  try {
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
    if (error.message.includes('Pool is closed') || error.code === 'POOL_CLOSED') {
      console.log('⚠️ Pool de conexão fechado, aguardando reconexão...');
    } else {
      console.error('❌ Erro ao verificar novas inscrições:', error);
    }
  }
}

// Função auxiliar para validar URLs de imagem
function isValidImageUrl(url) {
  if (!url) return false;
  try {
    const parsedUrl = new URL(url);
    const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    return allowedExtensions.some(ext => parsedUrl.pathname.toLowerCase().endsWith(ext));
  } catch {
    return false;
  }
}

// Função auxiliar para atualizar o editor de imagens
async function updateImageEditor(interaction, state) {
  const { images, applicationId, status } = state;
  
  try {
    // Verifica se a interação já foi respondida
    if (interaction.replied && !interaction.message) {
      return;
    }

    // Se não foi respondida nem deferida, deferir
    if (!interaction.replied && !interaction.deferred) {
      await interaction.deferUpdate().catch(console.error);
    }

    // Criar embed atualizado
    const embed = new EmbedBuilder()
      .setColor('#0099ff')
      .setTitle(`🖼️ Gerenciador de Imagens - Inscrição #${applicationId}`)
      .setDescription('**Selecione as imagens que deseja remover**\nClique nos botões abaixo para gerenciar:');
    
    if (images.length > 0) {
      embed.setImage(images[0]); // Mostra a primeira imagem como exemplo
      embed.addFields({
        name: `Imagens Atuais (${images.length})`,
        value: 'Clique nos botões abaixo para remover imagens específicas'
      });
    } else {
      embed.addFields({
        name: 'Imagens Atuais',
        value: 'Nenhuma imagem cadastrada'
      });
    }
    
    // Recriar os botões
    const actionRow1 = new ActionRowBuilder();
    const actionRow2 = new ActionRowBuilder();
    
    images.slice(0, 5).forEach((img, index) => {
      actionRow1.addComponents(
        new ButtonBuilder()
          .setCustomId(`img_remove_${applicationId}_${index}_${status}`)
          .setLabel(`Remover #${index + 1}`)
          .setStyle(ButtonStyle.Danger)
          .setEmoji('❌')
      );
    });
    
    if (images.length > 5) {
      images.slice(5, 10).forEach((img, index) => {
        actionRow2.addComponents(
          new ButtonBuilder()
            .setCustomId(`img_remove_${applicationId}_${index + 5}_${status}`)
            .setLabel(`Remover #${index + 6}`)
            .setStyle(ButtonStyle.Danger)
            .setEmoji('❌')
        );
      });
    }
    
    const mainActionRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`img_add_${applicationId}_${status}`)
        .setLabel('Adicionar Imagens')
        .setStyle(ButtonStyle.Success)
        .setEmoji('➕'),
      new ButtonBuilder()
        .setCustomId(`img_clear_${applicationId}_${status}`)
        .setLabel('Limpar Todas')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🗑️'),
      new ButtonBuilder()
        .setCustomId(`img_save_${applicationId}_${status}`)
        .setLabel('Salvar Alterações')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('💾'),
      new ButtonBuilder()
        .setCustomId(`img_cancel_${applicationId}`)
        .setLabel('Cancelar')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('✖️')
    );
    
    // Atualizar a mensagem
    await interaction.editReply({
      embeds: [embed],
      components: images.length > 0 ? 
        [actionRow1, actionRow2, mainActionRow] : 
        [mainActionRow]
    });
  } catch (error) {
    console.error('❌ Erro ao atualizar editor de imagens:', error);
    // Verifica se já foi respondido antes de tentar responder novamente
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: 'Ocorreu um erro ao atualizar o editor de imagens.',
        flags: MessageFlags.Ephemeral
      }).catch(console.error);
    } else if (interaction.deferred) {
      await interaction.editReply({
        content: 'Ocorreu um erro ao atualizar o editor de imagens.'
      }).catch(console.error);
    }
  }
}

// Adicione esta função para parar todos os monitors
function stopAllMonitors() {
  if (client.monitors) {
    if (client.monitors.securityInterval) {
      clearInterval(client.monitors.securityInterval);
    }
    if (client.monitors.cleanupTimeout) {
      clearTimeout(client.monitors.cleanupTimeout);
      clearInterval(client.monitors.cleanupTimeout);
    }
    if (client.monitors.checkApplicationsInterval) {
      clearInterval(client.monitors.checkApplicationsInterval);
    }
    console.log('⏹️ Todos os monitors parados');
  }
}

// Configurar eventos
function setupEvents(client, db) {
  // Evento ready
  client.on(Events.ClientReady, async () => {
    console.log(`🤖 Bot conectado como ${client.user.tag}`);
    client.user.setActivity('/ajuda para comandos', { type: 'WATCHING' });
    
    // Inicia os monitors e guarda as referências
    const securityInterval = await setupSecurityMonitoring(client, db);
    const cleanupTimeout = await setupAutoCleanup(db);
    let checkApplicationsInterval;
    
    // Intervalo com verificação de conexão
    checkApplicationsInterval = setInterval(async () => {
      if (isShuttingDown || !(await db.checkConnection())) {
        if (checkApplicationsInterval) {
          clearInterval(checkApplicationsInterval);
          checkApplicationsInterval = null;
        }
        return;
      }
      
      await checkNewApplications(client, db);
    }, 60000);
    
    // Guarda as referências para poder parar durante o shutdown
    client.monitors = {
      securityInterval,
      cleanupTimeout,
      checkApplicationsInterval
    };
  });

  // Evento interactionCreate com tratamento de erros melhorado
  client.on(Events.InteractionCreate, async interaction => {
    if (isShuttingDown) return;

    try {
      // Comandos slash
      if (interaction.isCommand()) {
        console.log(`🔍 Comando slash detectado: ${interaction.commandName}`, interaction.options.data);

        if (!await checkUserPermission(interaction, interaction.commandName, db)) {
          return interaction.reply({
            content: '❌ Você não tem permissão para usar este comando.',
            flags: MessageFlags.Ephemeral
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
            
          case 'ajuda':
            await showHelp(interaction);
            break;

          case 'char500':
            await interaction.deferReply();
            
            try {
              const { chars, totalChars, page, totalPages, lastUpdated } = await get500RCharacters(db);
              
              if (!chars || chars.length === 0) {
                return interaction.editReply({
                  content: 'Nenhum personagem com 500+ resets encontrado.',
                  flags: MessageFlags.Ephemeral
                });
              }

              // Criar múltiplos embeds - um para cada personagem
              const embeds = chars.map((char, index) => {
                const userbarUrl = `https://www.mucabrasil.com.br/forum/userbar.php?n=${encodeURIComponent(char.name)}&size=small&t=${Date.now()}`;
                
                // Determinar o status e a data apropriada
                let statusText = '';
                if (char.status) {
                  const statusDate = char.status_date ? formatBrazilianDate(char.status_date) : '';
                  switch(char.status) {
                    case 'novo':
                      statusText = `🆕 Novo (desde ${statusDate})`;
                      break;
                    case 'saiu':
                      statusText = `🚪 Saiu (em ${statusDate})`;
                      break;
                    case 'ativo':
                      statusText = `✅ Ativo`;
                      break;
                    default:
                      statusText = `❓ Status desconhecido`;
                  }
                } else {
                  statusText = '❓ Não cadastrado';
                }
                
                return new EmbedBuilder()
                  .setColor('#FFA500')
                  .setTitle(`🏆 ${char.name} — #${(page - 1) * 5 + index + 1}`)
                  .setDescription(
                    `🏰 **Guilda:** ${char.guild}\n` +
                    `🔄 **Resets:** ${char.resets}\n` +
                    `📌 **Status:** ${statusText}`
                  )
                  .setImage(userbarUrl)
                  .setFooter({ text: `Atualizado em ${formatBrazilianDate(lastUpdated)}` });
              });

              // Botões de navegação
              const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setCustomId(`char500_prev_${page}`)
                  .setLabel('Anterior')
                  .setStyle(ButtonStyle.Primary)
                  .setDisabled(page <= 1),
                new ButtonBuilder()
                  .setCustomId(`char500_next_${page}`)
                  .setLabel('Próxima')
                  .setStyle(ButtonStyle.Primary)
                  .setDisabled(page >= totalPages),
                new ButtonBuilder()
                  .setCustomId('char500_close')
                  .setLabel('Fechar')
                  .setStyle(ButtonStyle.Danger)
              );

              await interaction.editReply({ 
                content: `**Personagens 500+ Resets** (Página ${page}/${totalPages} - Total: ${totalChars})`,
                embeds: embeds,
                components: [row] 
              });

            } catch (error) {
              console.error('Erro no comando char500:', error);
              await interaction.editReply({
                content: 'Ocorreu um erro ao buscar os personagens. Por favor, tente novamente mais tarde.',
                flags: MessageFlags.Ephemeral
              });
            }
            break;

          case 'admin-permissoes':
            if (!interaction.inGuild()) {
              return interaction.reply({
                content: 'Este comando só pode ser usado em servidores.',
                flags: MessageFlags.Ephemeral
              }).catch(console.error);
            }

            if (!interaction.member || !interaction.member.permissions || !interaction.member.permissions.has('ADMINISTRATOR')) {
              return interaction.reply({
                content: '❌ Este comando é restrito a administradores.',
                flags: MessageFlags.Ephemeral
              }).catch(console.error);
            }

            const commandName = interaction.options.getString('comando');
            const action = interaction.options.getString('acao');
            const role = interaction.options.getRole('cargo');

            await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(console.error);

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
                    '❌ Falha ao remover permissão. O cargo pode não have esta permissão.'
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
                  flags: MessageFlags.Ephemeral
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
                flags: MessageFlags.Ephemeral
              }).catch(console.error);
            }
            break;

          case 'desbloquear-ip':
            const ipToUnblock = interaction.options.getString('ip');
            
            await interaction.deferReply();
            
            try {
              const result = await unblockIP(ipToUnblock, db, interaction.user.id);
              
              if (!result.success) {
                return interaction.editReply({
                  content: `❌ ${result.message}`,
                  flags: MessageFlags.Ephemeral
                }).catch(console.error);
              }

              const embed = new EmbedBuilder()
                .setColor('#00FF00')
                .setTitle('✅ IP Desbloqueado com Sucesso')
                .addFields(
                  { name: 'IP', value: ipToUnblock, inline: true },
                  { name: 'Motivo Original', value: result.originalReason || 'Não especificado', inline: true }
                )
                .setTimestamp();

              await interaction.editReply({ embeds: [embed] });

              // Notificar canal de segurança
              const securityChannel = await client.channels.fetch(process.env.SECURITY_CHANNEL_ID);
              if (securityChannel) {
                const notifyEmbed = new EmbedBuilder()
                  .setColor('#FFA500')
                  .setTitle('⚠️ IP Desbloqueado')
                  .setDescription(`O IP ${ipToUnblock} foi desbloqueado por ${interaction.user.tag}`)
                  .addFields(
                    { name: 'Motivo Original', value: result.originalReason || 'Não especificado' }
                  )
                  .setTimestamp();
                
                await securityChannel.send({ embeds: [notifyEmbed] });
              }
            } catch (error) {
              console.error('Erro ao desbloquear IP:', error);
              await interaction.editReply({
                content: '❌ Ocorreu um erro ao desbloquear o IP.',
                flags: MessageFlags.Ephemeral
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
                  flags: MessageFlags.Ephemeral
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
                flags: MessageFlags.Ephemeral
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
                  flags: MessageFlags.Ephemeral
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
                flags: MessageFlags.Ephemeral
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
                  flags: MessageFlags.Ephemeral
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
                flags: MessageFlags.Ephemeral
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
                  flags: MessageFlags.Ephemeral
                }).catch(console.error);
              }

              const result = await manageWhitelist(whitelistAction, ipWhitelist, motivoWhitelist, db, interaction.user.id);
              
              if (!result.success) {
                return interaction.editReply({
                  content: `❌ ${result.message}`,
                  flags: MessageFlags.Ephemeral
                }).catch(console.error);
              }

              if (whitelistAction === 'list') {
                if (result.data.length === 0) {
                  return interaction.editReply({
                    content: 'Nenhum IP na whitelist.',
                    flags: MessageFlags.Ephemeral
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
                  flags: MessageFlags.Ephemeral
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
                flags: MessageFlags.Ephemeral
              }).catch(console.error);
            }
            break;

          case 'consultar-telefone':
            const phoneNumber = interaction.options.getString('telefone');
            
            await interaction.deferReply();
            
            try {
              const result = await checkPhoneNumber(phoneNumber);
              
              if (!result.success) {
                return interaction.editReply({
                  content: result.message,
                  flags: MessageFlags.Ephemeral
                }).catch(console.error);
              }
              
              // Embed simplificado com informações básicas
              const embed = new EmbedBuilder()
                .setColor('#0099ff')
                .setTitle('📱 Informações do Telefone')
                .addFields(
                  { name: 'Número Original', value: phoneNumber, inline: true },
                  { name: 'País', value: result.country || 'Desconhecido', inline: true },
                  { name: 'Código do País', value: result.countryCode || 'N/A', inline: true },
                  { name: 'Número Nacional', value: result.nationalNumber || phoneNumber, inline: true },
                  { name: 'Número Internacional', value: result.internationalNumber || phoneNumber, inline: true },
                  { name: 'Válido', value: result.isValid ? '✅ Sim' : '❌ Não', inline: true },
                  { name: 'Tipo', value: result.type || 'Desconhecido', inline: true }
                );
              
              await interaction.editReply({ embeds: [embed] });
            } catch (error) {
              console.error('Erro ao consultar telefone:', error);
              await interaction.editReply({
                content: '❌ Ocorreu um erro ao consultar o número de telefone.',
                flags: MessageFlags.Ephemeral
              }).catch(console.error);
            }
            break;

          default:
            await interaction.reply({
              content: '❌ Comando não reconhecido.',
              flags: MessageFlags.Ephemeral
            }).catch(console.error);
        }
      }

      // Botões de aprovação/rejeição
      if (interaction.isButton()) {
        const [action, applicationId, status] = interaction.customId.split('_');
        
        if (action === 'aprovar' || action === 'rejeitar') {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(console.error);
          
          try {
            // Busca a inscrição no banco de dados
            const [rows] = await db.execute(
              'SELECT * FROM inscricoes_pendentes WHERE id = ?',
              [applicationId]
            );
            
            if (rows.length === 0) {
              return interaction.editReply({
                content: '❌ Inscrição não encontrada.'
              }).catch(console.error);
            }
            
            const application = rows[0];
            
            if (action === 'aprovar') {
              await approveApplication(interaction, application, db);
            } else {
              await rejectApplication(interaction, application, db);
            }
            
            // Remove os botões da mensagem original
            try {
              await interaction.message.edit({
                components: []
              }).catch(console.error);
            } catch (error) {
              console.log('Não foi possível remover os botões da mensagem:', error.message);
            }
          } catch (error) {
            console.error('❌ Erro ao processar botão:', error);
            await interaction.editReply({
              content: '❌ Ocorreu um erro ao processar sua ação.'
            }).catch(console.error);
          }
        }
        
        // Botões de navegação para personagens 500+
        if (interaction.customId.startsWith('char500_')) {
          const [_, action, page] = interaction.customId.split('_');
          
          await interaction.deferUpdate().catch(console.error);
          
          try {
            if (action === 'close') {
              await interaction.deleteReply().catch(console.error);
              return;
            }
            
            let newPage = parseInt(page);
            if (action === 'next') newPage++;
            if (action === 'prev') newPage--;
            
            const { chars, totalChars, totalPages, lastUpdated } = await get500RCharacters(db, newPage);
            
            if (!chars || chars.length === 0) {
              return;
            }
            
            // Recriar os embeds
            const embeds = chars.map((char, index) => {
              const userbarUrl = `https://www.mucabrasil.com.br/forum/userbar.php?n=${encodeURIComponent(char.name)}&size=small&t=${Date.now()}`;
              
              let statusText = '';
              if (char.status) {
                const statusDate = char.status_date ? formatBrazilianDate(char.status_date) : '';
                switch(char.status) {
                  case 'novo':
                    statusText = `🆕 Novo (desde ${statusDate})`;
                    break;
                  case 'saiu':
                    statusText = `🚪 Saiu (em ${statusDate})`;
                    break;
                  case 'ativo':
                    statusText = `✅ Ativo`;
                    break;
                  default:
                    statusText = `❓ Status desconhecido`;
                }
              } else {
                statusText = '❓ Não cadastrado';
              }
              
              return new EmbedBuilder()
                .setColor('#FFA500')
                .setTitle(`🏆 ${char.name} — #${(newPage - 1) * 5 + index + 1}`)
                .setDescription(
                  `🏰 **Guilda:** ${char.guild}\n` +
                  `🔄 **Resets:** ${char.resets}\n` +
                  `📌 **Status:** ${statusText}`
                )
                .setImage(userbarUrl)
                .setFooter({ text: `Atualizado em ${formatBrazilianDate(lastUpdated)}` });
            });
            
            // Recriar os botões
            const row = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`char500_prev_${newPage}`)
                .setLabel('Anterior')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(newPage <= 1),
              new ButtonBuilder()
                .setCustomId(`char500_next_${newPage}`)
                .setLabel('Próxima')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(newPage >= totalPages),
              new ButtonBuilder()
                .setCustomId('char500_close')
                .setLabel('Fechar')
                .setStyle(ButtonStyle.Danger)
            );
            
            await interaction.editReply({ 
              content: `**Personagens 500+ Resets** (Página ${newPage}/${totalPages} - Total: ${totalChars})`,
              embeds: embeds,
              components: [row] 
            });
          } catch (error) {
            console.error('Erro na navegação char500:', error);
          }
        }
        
        // Botões de gerenciamento de imagens
        if (interaction.customId.startsWith('img_')) {
          const [action, applicationId, index, status] = interaction.customId.split('_');
          
          try {
            // Busca a inscrição
            const [rows] = await db.execute(
              'SELECT * FROM inscricoes_pendentes WHERE id = ?',
              [applicationId]
            );
            
            if (rows.length === 0) {
              return interaction.reply({
                content: '❌ Inscrição não encontrada.',
                flags: MessageFlags.Ephemeral
              }).catch(console.error);
            }
            
            const application = rows[0];
            let images = application.imagens ? JSON.parse(application.imagens) : [];
            
            if (action === 'remove') {
              // Remove imagem específica
              const imgIndex = parseInt(index);
              if (imgIndex >= 0 && imgIndex < images.length) {
                images.splice(imgIndex, 1);
                
                // Atualiza o banco
                await db.execute(
                  'UPDATE inscricoes_pendentes SET imagens = ? WHERE id = ?',
                  [JSON.stringify(images), applicationId]
                );
                
                // Atualiza a interface
                await updateImageEditor(interaction, { images, applicationId, status });
              }
            } else if (action === 'add') {
              // Modal para adicionar imagens
              const modal = new ModalBuilder()
                .setCustomId(`img_modal_${applicationId}_${status}`)
                .setTitle('Adicionar Imagens');
              
              const imageInput = new TextInputBuilder()
                .setCustomId('image_urls')
                .setLabel('URLs das Imagens (separadas por vírgula)')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('https://exemplo.com/imagem1.jpg, https://exemplo.com/imagem2.png')
                .setRequired(true);
              
              const actionRow = new ActionRowBuilder().addComponents(imageInput);
              modal.addComponents(actionRow);
              
              await interaction.showModal(modal);
            } else if (action === 'clear') {
              // Limpa todas as imagens
              images = [];
              
              await db.execute(
                'UPDATE inscricoes_pendentes SET imagens = NULL WHERE id = ?',
                [applicationId]
              );
              
              await updateImageEditor(interaction, { images, applicationId, status });
            } else if (action === 'save') {
              // Fecha o editor
              await interaction.deferUpdate().catch(console.error);
              await interaction.deleteReply().catch(console.error);
              
              // Reenvia a inscrição atualizada
              const channel = await client.channels.fetch(process.env.ALLOWED_CHANNEL_ID);
              if (channel) {
                await sendApplicationEmbed(channel, application, db);
              }
            } else if (action === 'cancel') {
              // Cancela a edição
              await interaction.deferUpdate().catch(console.error);
              await interaction.deleteReply().catch(console.error);
            }
          } catch (error) {
            console.error('❌ Erro no gerenciador de imagens:', error);
            if (!interaction.replied && !interaction.deferred) {
              await interaction.reply({
                content: '❌ Ocorreu um erro ao processar sua ação.',
                flags: MessageFlags.Ephemeral
              }).catch(console.error);
            }
          }
        }
      }
      
      // Modais (para adicionar imagens)
      if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith('img_modal_')) {
          const [_, __, applicationId, status] = interaction.customId.split('_');
          const imageUrls = interaction.fields.getTextInputValue('image_urls');
          
          await interaction.deferUpdate().catch(console.error);
          
          try {
            // Busca a inscrição
            const [rows] = await db.execute(
              'SELECT * FROM inscricoes_pendentes WHERE id = ?',
              [applicationId]
            );
            
            if (rows.length === 0) {
              return interaction.editReply({
                content: '❌ Inscrição não encontrada.'
              }).catch(console.error);
            }
            
            const application = rows[0];
            let images = application.imagens ? JSON.parse(application.imagens) : [];
            
            // Processa as URLs
            const newImages = processImageUrls(imageUrls);
            
            // Adiciona as novas imagens (limite de 10)
            images = [...images, ...newImages].slice(0, 10);
            
            // Atualiza o banco
            await db.execute(
              'UPDATE inscricoes_pendentes SET imagens = ? WHERE id = ?',
              [JSON.stringify(images), applicationId]
            );
            
            // Atualiza a interface
            await updateImageEditor(interaction, { images, applicationId, status });
          } catch (error) {
            console.error('❌ Erro ao processar modal de imagens:', error);
            await interaction.editReply({
              content: '❌ Ocorreu um erro ao processar as imagens.'
            }).catch(console.error);
          }
        }
      }
    } catch (error) {
      console.error('❌ Erro não tratado em interactionCreate:', error);
      
      // Tenta enviar uma mensagem de erro se possível
      if (interaction && !interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: '❌ Ocorreu um erro inesperado ao processar sua solicitação.',
          flags: MessageFlags.Ephemeral
        }).catch(console.error);
      }
    }
  });

  // Evento de erro
  client.on(Events.Error, error => {
    console.error('❌ Erro do cliente Discord:', error);
  });

  // Evento de warn
  client.on(Events.Warn, info => {
    console.warn('⚠️ Aviso do Discord:', info);
  });

  // Evento de desconexão
  client.on(Events.ShardDisconnect, (event, shardId) => {
    console.log(`🔌 Shard ${shardId} desconectado:`, event);
  });

  // Evento de reconexão
  client.on(Events.ShardReconnecting, shardId => {
    console.log(`🔄 Shard ${shardId} reconectando...`);
  });

  // Evento de resumo (resumed)
  client.on(Events.ShardResume, (shardId, replayedEvents) => {
    console.log(`▶️ Shard ${shardId} retomado, eventos repassados: ${replayedEvents}`);
  });
}

module.exports = { setupEvents, stopAllMonitors };