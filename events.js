const { Events, EmbedBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { 
    safeSend, searchCharacterWithCache, showRanking, searchCharacter, 
    getCommandPermissions, addCommandPermission, removeCommandPermission, checkUserPermission, 
    formatBrazilianDate, processImageUrls, blockIP, unblockIP, queryIP, getIPInfo, 
    generateSecurityReport, getRecentAccess, manageWhitelist, checkPhoneNumber, get500RCharacters,
    addNotificationSubscription, removeNotificationSubscription, getNotificationSubscriptions, sendDmsToRoles,
    isValidImageUrl
} = require('./utils');
const { isShuttingDown, isConnectionActive, safeExecuteQuery } = require('./database');
const { 
  listPendingApplications, 
  searchApplications, 
  sendApplicationEmbed, 
  approveApplication, 
  rejectApplication, 
  showHelp, 
  createImageCarousel,
  createAdvancedCharEmbed, 
  createPaginationButtons 
} = require('./commands');

// Função auxiliar para verificar se pode executar operações no DB
async function canExecuteDBOperation() {
  if (isShuttingDown()) {
    return false;
  }
  
  return await isConnectionActive();
}

// Função auxiliar local para formatar link de WhatsApp
function formatWhatsAppLink(phone) {
  if (!phone) return 'Não informado';
  
  // Remove tudo que não é dígito
  const digits = phone.replace(/\D/g, '');
  
  if (digits.length < 8) return phone; // Número muito curto, retorna texto puro

  // Formatação visual
  let displayPhone = phone;
  
  // Lógica para o link (wa.me)
  let waNumber = digits;
  
  // Se tiver 10 ou 11 dígitos e não começar com 55 (assumindo BR), adiciona 55
  if ((digits.length === 10 || digits.length === 11) && !digits.startsWith('55')) {
    waNumber = `55${digits}`;
  }
  
  return `[${displayPhone}](https://wa.me/${waNumber})`;
}

// --- VARIÁVEIS DE ESTADO PARA OS MONITORES ---
let lastCheckedApplications = new Date();
let lastCheckedMemberTimestamp = new Date();
let lastCheckedDepartureTimestamp = new Date();
const SECURITY_ALERT_CHANNEL_ID = '1256287757135908884'; // ID do canal de segurança

// Mapa para rastrear mensagens de notificação de saída para atualização em massa
const activeDepartureMessages = new Map();

// Monitoramento de segurança
async function setupSecurityMonitoring(client) {
  setInterval(async () => {
    if (isShuttingDown() || !await canExecuteDBOperation()) {
      console.log('⏸️ Monitoramento de segurança pausado (shutdown ou DB indisponível)');
      return;
    }
    
    try {
      const suspiciousLogins = await safeExecuteQuery(`
        SELECT ip, COUNT(*) as tentativas 
        FROM tentativas_login_falhas 
        WHERE data_acesso >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
        GROUP BY ip 
        HAVING tentativas > 5
        ORDER BY tentativas DESC
      `);
      
      const blockedAccess = await safeExecuteQuery(`
        SELECT v.ip, COUNT(*) as tentativas, MAX(v.data_acesso) as ultima_tentativa
        FROM visitantes v
        JOIN ips_bloqueados b ON v.ip = b.ip
        WHERE v.data_acesso >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
        GROUP BY v.ip
        ORDER BY tentativas DESC
      `);
      
      const securityChannel = await client.channels.fetch(process.env.SECURITY_CHANNEL_ID).catch(() => null);
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
      if (error.message === 'POOL_CLOSED') {
        console.log('⏸️ Pool fechado, parando monitoramento de segurança...');
        return;
      }
      console.error('Erro no monitoramento de segurança:', error);
    }
  }, 5 * 60 * 1000); // 5 minutos
  
  console.log('✅ Monitoramento de segurança iniciado');
}

// Limpeza automática de registros
async function setupAutoCleanup() {
  const now = new Date();
  const nextCleanup = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    3, 0, 0
  );
  
  const timeUntilCleanup = nextCleanup - now;
  
  setTimeout(async function runCleanup() {
    if (isShuttingDown() || !await canExecuteDBOperation()) {
      console.log('⏸️ Limpeza automática pausada (shutdown ou DB indisponível)');
      setTimeout(runCleanup, 60 * 60 * 1000);
      return;
    }
    
    try {
      console.log('🔄 Iniciando limpeza automática de registros antigos...');
      await safeExecuteQuery('DELETE FROM ips_bloqueados WHERE data_bloqueio < DATE_SUB(NOW(), INTERVAL 30 DAY)');
      await safeExecuteQuery('DELETE FROM tentativas_login_falhas WHERE data_acesso < DATE_SUB(NOW(), INTERVAL 7 DAY)');
      await safeExecuteQuery('DELETE FROM visitantes WHERE data_acesso < DATE_SUB(NOW(), INTERVAL 30 DAY)');
      
      console.log('✅ Limpeza automática concluída');
      setTimeout(runCleanup, 24 * 60 * 60 * 1000);
    } catch (error) {
      if (error.message === 'POOL_CLOSED') {
        console.log('⏸️ Pool fechado, parando limpeza automática...');
      } else {
        console.error('❌ Erro na limpeza automática:', error);
      }
      setTimeout(runCleanup, 60 * 60 * 1000);
    }
  }, timeUntilCleanup);
  
  console.log('✅ Limpeza automática agendada');
}

// Verificar novas inscrições e notificar por DM
async function checkNewApplications(client) {
  if (isShuttingDown() || !await canExecuteDBOperation()) {
    console.log('⏸️ Monitoramento de inscrições pausado (shutdown ou DB indisponível)');
    return;
  }
  
  try {
    const rows = await safeExecuteQuery(
      'SELECT * FROM inscricoes_pendentes WHERE data_inscricao > ? ORDER BY data_inscricao ASC',
      [lastCheckedApplications]
    );
    
    if (rows.length > 0) {
      const channel = await client.channels.fetch(process.env.ALLOWED_CHANNEL_ID);
      
      await channel.send({
        content: `📢 Há ${rows.length} nova(s) inscrição(ões) pendente(s)! Use /pendentes para visualizar.`
      });
      
      const roleIdsToNotify = await getNotificationSubscriptions('inscricao_pendente');

      for (const application of rows) {
        await sendApplicationEmbed(channel, application);
        
        const dmEmbed = new EmbedBuilder()
          .setColor('#FF4500')
          .setTitle('🔔 Nova Inscrição Pendente')
          .setDescription(`Uma nova inscrição de **${application.nome}** está aguardando avaliação.`)
          .addFields(
              { name: '👤 Nome', value: application.nome, inline: true },
              { name: '⚔️ Personagem', value: application.char_principal || 'Não informado', inline: true },
              { name: '📅 Data', value: formatBrazilianDate(application.data_inscricao), inline: true }
          )
          .setFooter({ text: 'Por favor, verifique no canal de inscrições.' });

        await sendDmsToRoles(client, roleIdsToNotify, { embeds: [dmEmbed] });
      }
      
      lastCheckedApplications = new Date(rows[rows.length - 1].data_inscricao);
    }
  } catch (error) {
    if (error.message === 'POOL_CLOSED') {
      console.log('⏸️ Pool fechado, parando monitoramento de inscrições...');
      return;
    }
    console.error('❌ Erro ao verificar novas inscrições:', error);
  }
}

// Verificar novos membros e cruzar com a lista de inimigos
async function checkNewMembersForConflicts(client) {
    if (isShuttingDown() || !await canExecuteDBOperation()) {
        console.log('⏸️ Monitoramento de conflitos pausado (shutdown ou DB indisponível)');
        return;
    }

    try {
        const newMembers = await safeExecuteQuery(
            `SELECT nome, guild, data_insercao FROM membros WHERE data_insercao > ? AND status = 'novo' ORDER BY data_insercao ASC`,
            [lastCheckedMemberTimestamp]
        );

        if (newMembers.length > 0) {
            const securityChannel = await client.channels.fetch(SECURITY_ALERT_CHANNEL_ID).catch(() => null);
            const roleIdsToNotify = await getNotificationSubscriptions('alerta_seguranca');

            for (const member of newMembers) {
                const enemies = await safeExecuteQuery(
                    `SELECT nome, guild, status FROM inimigos WHERE nome = ?`,
                    [member.nome]
                );

                if (enemies.length > 0) {
                    const enemyInfo = enemies[0];
                    const alertTitle = enemyInfo.status === 'saiu' ? '✅ Ex-Inimigo Juntou-se à Guild' : '🚨 ALERTA: Inimigo Ativo Juntou-se à Guild';
                    const alertColor = enemyInfo.status === 'saiu' ? '#FFA500' : '#FF0000';
                    const description = `O personagem **${member.nome}**, que consta na lista de inimigos, entrou na guild **${member.guild}**.`;

                    const alertEmbed = new EmbedBuilder()
                        .setColor(alertColor)
                        .setTitle(alertTitle)
                        .setDescription(description)
                        .addFields(
                            { name: '👤 Personagem', value: member.nome, inline: true },
                            { name: '➡️ Guild Atual', value: member.guild, inline: true },
                            { name: '⬅️ Guild Inimiga (Registrada)', value: enemyInfo.guild, inline: true },
                            { name: '🗓️ Data da Entrada', value: formatBrazilianDate(member.data_insercao), inline: false }
                        )
                        .setFooter({ text: 'Ação recomendada: verificar histórico e intenções do membro.' });

                    if (securityChannel) {
                        await securityChannel.send({ embeds: [alertEmbed] });
                    }

                    await sendDmsToRoles(client, roleIdsToNotify, { embeds: [alertEmbed] });
                }
                lastCheckedMemberTimestamp = new Date(member.data_insercao);
            }
        }
    } catch (error) {
        if (error.message === 'POOL_CLOSED') {
            console.log('⏸️ Pool fechado, parando monitoramento de conflitos...');
            return;
        }
        console.error('❌ Erro ao verificar conflitos de membros:', error);
    }
}

// --- FUNÇÃO ATUALIZADA: VERIFICAR SAÍDAS (COM FILTRO DE INSCRIÇÃO OBRIGATÓRIA) ---
async function checkDepartingMembers(client) {
    if (isShuttingDown() || !await canExecuteDBOperation()) {
        console.log('⏸️ Monitoramento de saídas pausado (shutdown ou DB indisponível)');
        return;
    }

    try {
        // Pega membros que saíram desde a última checagem
        const departedRows = await safeExecuteQuery(
            `SELECT nome, guild, data_saida FROM membros WHERE status = 'saiu' AND data_saida > ? ORDER BY data_saida ASC`,
            [lastCheckedDepartureTimestamp]
        );

        if (departedRows.length > 0) {
            const securityChannel = await client.channels.fetch(SECURITY_ALERT_CHANNEL_ID).catch(() => null);
            const roleIdsToNotify = await getNotificationSubscriptions('alerta_seguranca');
            
            // Agrupar por dono usando as inscrições
            const groups = new Map();
            let maxTimestamp = lastCheckedDepartureTimestamp;

            for (const row of departedRows) {
                // Atualiza o timestamp máximo para evitar reprocessar o mesmo registro,
                // mesmo que ele seja pulado pelo filtro abaixo.
                if (new Date(row.data_saida) > maxTimestamp) {
                    maxTimestamp = new Date(row.data_saida);
                }

                // Busca a inscrição original para agrupar por dono e verificar existência
                const apps = await safeExecuteQuery(
                    `SELECT id, nome, telefone, discord, char_principal 
                     FROM inscricoes 
                     WHERE status = 'aprovado' AND (LOWER(char_principal) LIKE LOWER(?)) 
                     ORDER BY id DESC LIMIT 1`,
                    [`%${row.nome.trim()}%`]
                );
                
                const app = apps[0] || null;

                // CORREÇÃO: Se não encontrar inscrição, IGNORA o alerta
                if (!app) {
                    // console.log(`Saída ignorada (sem inscrição): ${row.nome}`);
                    continue; 
                }

                const groupKey = `app_${app.id}`;

                if (!groups.has(groupKey)) {
                    groups.set(groupKey, { 
                        app, 
                        departures: [], 
                        timestamp: row.data_saida 
                    });
                }
                groups.get(groupKey).departures.push(row);
            }

            // Processa cada grupo (que agora garantidamente tem uma app associada)
            for (const [key, data] of groups) {
                const { app, departures, timestamp } = data;
                let charStatusLines = [];
                
                // Determina todos os chars a verificar baseados na inscrição encontrada
                let charsToVerify = app.char_principal.split(',').map(c => c.trim());

                // Verifica o status atual de cada char na tabela membros
                for (const charName of charsToVerify) {
                    // Consulta o status real na tabela membros
                    const currentStatus = await safeExecuteQuery(
                        `SELECT guild, status FROM membros WHERE nome = ?`, 
                        [charName]
                    );

                    let icon = '❌';
                    let guildName = 'Sem Guild / Saiu';

                    if (currentStatus.length > 0) {
                        const status = currentStatus[0].status;
                        guildName = currentStatus[0].guild || 'Sem Guild';
                        
                        if (status === 'ativo' || status === 'novo') {
                            icon = '✅';
                        } else if (status === 'saiu') {
                            icon = '❌';
                        }
                    }
                    
                    // Verifica se este char está na lista dos que acabaram de sair
                    const isNewDeparture = departures.find(d => 
                        d.nome.toLowerCase() === charName.toLowerCase()
                    );
                    const note = isNewDeparture ? ` ⬅️ **(Saiu Agora)**` : '';
                    charStatusLines.push(`${icon} **${charName}** [Guild: ${guildName}]${note}`);
                }

                // Cria ID único para o agrupamento
                const departureId = `dep_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
                
                const waLink = formatWhatsAppLink(app.telefone);

                // Monta o embed
                const embed = new EmbedBuilder()
                    .setColor('#FFA500')
                    .setTitle(`👤 Membro(s) Saíram da Guild`)
                    .setDescription(`Detectada a saída de personagens associados a: **${app.nome}**`)
                    .addFields(
                        { name: '📋 Nome na Inscrição', value: app.nome, inline: true },
                        { name: '📱 Contato (WhatsApp)', value: waLink, inline: true },
                        { name: '🏰 Guild de Saída', value: departures[0].guild, inline: true },
                        { name: '📅 Data/Hora', value: formatBrazilianDate(timestamp), inline: true },
                        { name: '👥 Status da Conta (Banco de Dados)', 
                          value: charStatusLines.join('\n') || 'Nenhum char listado', 
                          inline: false }
                    )
                    .setTimestamp(new Date(timestamp));

                // Botões de ação
                const buttons = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`departed_cs_${departureId}`)
                        .setLabel('Saiu p/ CS (Volta)')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId(`departed_left_${departureId}`)
                        .setLabel('Saiu Definitivo')
                        .setStyle(ButtonStyle.Danger)
                );

                const messagePayload = { embeds: [embed], components: [buttons] };
                const messageReferences = [];

                if (securityChannel) {
                    try {
                        const channelMessage = await securityChannel.send(messagePayload);
                        messageReferences.push({ 
                            channelId: channelMessage.channel.id, 
                            messageId: channelMessage.id 
                        });
                    } catch (e) {
                        console.error("Falha ao enviar para o canal de segurança:", e);
                    }
                }

                const dmMessages = await sendDmsToRoles(client, roleIdsToNotify, messagePayload);
                for (const dm of dmMessages) {
                    messageReferences.push({ 
                        channelId: dm.channel.id, 
                        messageId: dm.id 
                    });
                }

                if (messageReferences.length > 0) {
                    activeDepartureMessages.set(departureId, messageReferences);
                }
            }
            
            // Atualiza o timestamp da última verificação
            lastCheckedDepartureTimestamp = maxTimestamp;
        }
    } catch (error) {
        if (error.message === 'POOL_CLOSED') {
            console.log('⏸️ Pool fechado, parando monitoramento de saídas...');
            return;
        }
        console.error('❌ Erro ao verificar saídas de membros:', error);
    }
}

// Configurar eventos
function setupEvents(client) {
  // Evento ready
  client.on(Events.ClientReady, async () => {
    console.log(`🤖 Bot conectado como ${client.user.tag}`);
    client.user.setActivity('/ajuda para comandos', { type: 'WATCHING' });
    
    await setupSecurityMonitoring(client);
    await setupAutoCleanup();
    
    // Intervalo para verificar novas inscrições
    setInterval(() => checkNewApplications(client), 60000); // 1 minuto
    
    // Intervalo para verificar conflitos de membros
    setInterval(() => checkNewMembersForConflicts(client), 5 * 60000); // 5 minutos
    
    // Intervalo para verificar saídas de membros
    setInterval(() => checkDepartingMembers(client), 5 * 60000); // 5 minutos
  });

  // Evento interactionCreate com tratamento de erros melhorado
  client.on(Events.InteractionCreate, async interaction => {
    if (isShuttingDown()) return;

    try {
      // Comandos slash
      if (interaction.isCommand()) {
        console.log(`🔍 Comando slash detectado: ${interaction.commandName}`, interaction.options.data);

        if (interaction.commandName !== 'pendentes' && !await checkUserPermission(interaction, interaction.commandName)) {
          return interaction.reply({
            content: '❌ Você não tem permissão para usar este comando.',
            flags: MessageFlags.Ephemeral
          }).catch(console.error);
        }

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
            console.log(`🔍 Comando /char recebido para personagem: ${charName}`);
            await searchCharacter(interaction, charName);
            break;
            
          case 'ranking':
            const period = interaction.options.getString('período');
            await showRanking(interaction, period);
            break;
            
          case 'ajuda':
            await showHelp(interaction);
            break;

          case 'admin-notificacoes':
              if (!interaction.member?.permissions.has('ADMINISTRATOR')) {
                  return interaction.reply({ content: '❌ Apenas administradores podem usar este comando.', flags: MessageFlags.Ephemeral });
              }
              const actionNotify = interaction.options.getString('acao');
              const typeNotify = interaction.options.getString('tipo');
              const roleNotify = interaction.options.getRole('cargo');

              await interaction.deferReply({ ephemeral: true });

              if (actionNotify === 'list') {
                  const roleIds = await getNotificationSubscriptions(typeNotify);
                  if (roleIds.length === 0) {
                      return interaction.editReply(`Nenhum cargo está subscrito para a notificação: **${typeNotify}**.`);
                  }
                  const roleNames = roleIds.map(id => interaction.guild.roles.cache.get(id)?.name || `ID: ${id}`).join(', ');
                  return interaction.editReply(`Cargos subscritos para **${typeNotify}**: ${roleNames}`);
              }

              if (!roleNotify) {
                  return interaction.editReply('Você precisa especificar um cargo para adicionar ou remover.');
              }

              if (actionNotify === 'add') {
                  const success = await addNotificationSubscription(typeNotify, roleNotify.id);
                  return interaction.editReply(success ? `✅ O cargo **${roleNotify.name}** agora receberá notificações de **${typeNotify}**.` : '❌ Erro. O cargo talvez já esteja subscrito.');
              }

              if (actionNotify === 'remove') {
                  const success = await removeNotificationSubscription(typeNotify, roleNotify.id);
                  return interaction.editReply(success ? `✅ O cargo **${roleNotify.name}** não receberá mais notificações de **${typeNotify}**.` : '❌ Erro. O cargo talvez não estivesse subscrito.');
              }
              break;

          case 'char500':
            await interaction.deferReply();
            
            try {
              const { chars, totalChars, page, totalPages, lastUpdated } = await get500RCharacters(1, 1);
              
              if (!chars || chars.length === 0) {
                return interaction.editReply({
                  content: 'Nenhum personagem com 500+ resets encontrado.',
                  flags: MessageFlags.Ephemeral
                });
              }

              const charData = chars[0];
              const embed = createAdvancedCharEmbed(charData, 1, totalPages, totalChars);
              const buttons = createPaginationButtons(1, totalPages, charData.name);

              await interaction.editReply({ 
                content: `**Personagens 500+ Resets** (Total: ${totalChars})`,
                embeds: [embed],
                components: buttons 
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
                const roleIds = await getCommandPermissions(commandName);
                
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
                const success = await addCommandPermission(commandName, role.id);
                return interaction.editReply({
                  content: success ? 
                    `✅ Cargo ${role.name} agora tem permissão para /${commandName}` :
                    '❌ Falha ao adicionar permissão. O cargo já pode ter esta permissão.'
                }).catch(console.error);
              }

              if (action === 'remove') {
                const success = await removeCommandPermission(commandName, role.id);
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
              const result = await blockIP(ip, motivo, interaction.user.id);
              
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
              const result = await unblockIP(ipToUnblock, interaction.user.id);
              
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
              const result = await queryIP(ipToQuery);
              
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
              const report = await generateSecurityReport(periodo);
              
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
              const accesses = await getRecentAccess(limit, country);
              
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

              const result = await manageWhitelist(whitelistAction, ipWhitelist, motivoWhitelist, interaction.user.id);
              
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
              
              const embed = new EmbedBuilder()
                .setColor('#0099ff')
                .setTitle('📱 Informações do Telefone')
                .addFields(
                  { name: 'Número Original', value: phoneNumber, inline: true },
                  { name: 'País', value: `${result.data.countryName} (${result.data.countryCode})`, inline: true },
                  { name: 'Código do País', value: result.data.countryPrefix || 'N/A', inline: true },
                  { name: 'Localização', value: result.data.location || 'N/A', inline: true },
                  { name: 'Operadora', value: result.data.carrier || 'N/A', inline: true },
                  { name: 'Tipo de Linha', value: result.data.lineType || 'N/A', inline: true }
                )
                .setFooter({ text: 'Dados fornecidos por Numverify API' })
                .setTimestamp();
              
              await interaction.editReply({ embeds: [embed] });
              
              const formatsMessage = `**Formatos do número ${phoneNumber}:**\n` +
                                    `• Número Internacional: ${result.data.number || 'N/A'}\n` +
                                    `• Formato Brasileiro: 0, 0XX${phoneNumber.replace(/^\+55/, '')}\n` +
                                    `• Formato Europeu: +BR 00${phoneNumber.replace(/^\+55/, '')}\n` +
                                    `• Formato EUA/Internacional: ${result.data.number || 'N/A'}`;
              
              await interaction.followUp({
                content: formatsMessage
              }).catch(console.error);
              
            } catch (error) {
              console.error('Erro ao consultar telefone:', error);
              await interaction.editReply({
                content: 'Ocorreu um erro ao consultar o número. Por favor, tente novamente mais tarde.',
                flags: MessageFlags.Ephemeral
              }).catch(console.error);
            }
            break;
        }
      }

      // Botões
      if (interaction.isButton()) {
        if (interaction.channel?.id !== process.env.ALLOWED_CHANNEL_ID && !interaction.customId.startsWith('departed_') && !interaction.customId.startsWith('carousel_')) {
            return interaction.reply({
                content: 'Este comando só pode ser usado no canal de inscrições.',
                flags: MessageFlags.Ephemeral
            }).catch(() => {
                interaction.channel.send({
                    content: 'Este comando só pode ser usado no canal de inscrições.',
                    flags: MessageFlags.Ephemeral
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
            await listPendingApplications(interaction, [page.toString()]);
            return;
          }
          
          if (interaction.customId.startsWith('departed_')) {
              try {
                  await interaction.deferUpdate();

                  const [_, action, departureId] = interaction.customId.split('_');
                  
                  const isCS = action === 'cs';
                  const statusText = isCS ? "Saiu para cs, mas volta!" : "Saiu da guild";
                  
                  const originalEmbed = interaction.message.embeds[0];
                  const updatedEmbed = new EmbedBuilder(originalEmbed)
                      .setColor(isCS ? '#00FF00' : '#FF0000') 
                      .setFooter({ text: `Status definido como: "${statusText}" por ${interaction.user.tag}` });

                  const messageRefs = activeDepartureMessages.get(departureId);

                  if (messageRefs && messageRefs.length > 0) {
                      const updatePromises = messageRefs.map(async (ref) => {
                          try {
                              const channel = await client.channels.fetch(ref.channelId);
                              const message = await channel.messages.fetch(ref.messageId);
                              await message.edit({ embeds: [updatedEmbed], components: [] });
                          } catch (error) {
                              if (error.code !== 10008 && error.code !== 10003) {
                                console.error(`Falha ao atualizar mensagem de saída ${ref.messageId}:`, error.message);
                              }
                          }
                      });

                      await Promise.allSettled(updatePromises);
                      activeDepartureMessages.delete(departureId); 
                  } else {
                      await interaction.editReply({ embeds: [updatedEmbed], components: [] });
                  }
      
              } catch (error) {
                  console.error('Erro ao processar botão de status de saída:', error);
                  if (interaction.replied || interaction.deferred) {
                      await interaction.followUp({ content: 'Ocorreu um erro ao atualizar o status.', ephemeral: true }).catch(console.error);
                  }
              }
              return; 
          }

          if (interaction.customId.startsWith('search_prev_') || interaction.customId.startsWith('search_next_')) {
            const [direction, searchTerm, pageStr] = interaction.customId.split('_').slice(1);
            let page = parseInt(pageStr);
            
            page = direction === 'prev' ? page - 1 : page + 1;
            
            await interaction.deferUpdate().catch(console.error);
            await interaction.message.delete().catch(() => {});
            await searchApplications(interaction, [searchTerm, page.toString()]);
            return;
          }

          if (interaction.customId.startsWith('view_screenshots_')) {
            await interaction.deferReply();

            const [_, __, applicationId, status] = interaction.customId.split('_');
            
            try {
              const table = status === 'aprovado' ? 'inscricoes' : 'inscricoes_pendentes';
              
              const rows = await safeExecuteQuery(
                `SELECT screenshot_path FROM ${table} WHERE id = ?`,
                [applicationId]
              );
              
              if (rows.length === 0) {
                return interaction.editReply({
                  content: 'Inscrição não encontrada.',
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
              
              const processedScreenshots = processImageUrls(screenshots);
              await createImageCarousel(interaction, processedScreenshots, applicationId, status);
              
            } catch (error) {
              console.error('❌ Erro ao buscar screenshots:', error);
              await interaction.editReply({
                content: 'Ocorreu um erro ao buscar as screenshots.',
              }).catch(console.error);
            }
            return;
          }
          
          if (interaction.customId.startsWith('carousel_')) {
            const [_, action, applicationId, status, currentIndexStr] = interaction.customId.split('_');
            let currentIndex = parseInt(currentIndexStr);
            
            if (action === 'close') {
              try {
                await interaction.message.delete().catch(error => {
                  if (error.code !== 10008) throw error; 
                });
              } catch (error) {
                console.error('Erro ao fechar carrossel:', error);
              }
              return;
            }
            
            const table = status === 'aprovado' ? 'inscricoes' : 'inscricoes_pendentes';
            
            try {
              const rows = await safeExecuteQuery(
                `SELECT screenshot_path FROM ${table} WHERE id = ?`,
                [applicationId]
              );
              
              if (rows.length === 0) {
                return interaction.update({
                  content: 'Inscrição não foi encontrada na tabela correta. Ela pode ter sido removida.',
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
              
              const processedScreenshots = processImageUrls(screenshots);
              const totalImages = processedScreenshots.length;
              
              if (totalImages === 0) {
                return interaction.update({
                  content: 'Nenhuma screenshot disponível para esta inscrição.',
                  embeds: [],
                  components: []
                }).catch(console.error);
              }
              
              if (action === 'prev') {
                currentIndex = (currentIndex - 1 + totalImages) % totalImages;
              } else if (action === 'next') {
                currentIndex = (currentIndex + 1) % totalImages;
              }

              const imageUrl = processedScreenshots[currentIndex];

              if (!imageUrl || !isValidImageUrl(imageUrl)) {
                  return interaction.update({
                      content: `A imagem ${currentIndex + 1} de ${totalImages} possui uma URL inválida e não pode ser exibida.`,
                      embeds: [],
                      components: []
                  }).catch(console.error);
              }
              
              const embed = new EmbedBuilder()
                .setColor('#0099ff')
                .setTitle(`Screenshots da Inscrição ${applicationId} (${status === 'aprovado' ? 'Aprovada' : 'Pendente'})`)
                .setImage(imageUrl)
                .setFooter({ text: `Imagem ${currentIndex + 1} de ${totalImages}` });
              
              const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setCustomId(`carousel_prev_${applicationId}_${status}_${currentIndex}`)
                  .setLabel('◀️ Anterior')
                  .setStyle(ButtonStyle.Primary)
                  .setDisabled(currentIndex === 0),
                new ButtonBuilder()
                  .setCustomId(`carousel_close_${applicationId}_${status}_${currentIndex}`)
                  .setLabel('❌ Fechar')
                  .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                  .setCustomId(`carousel_next_${applicationId}_${status}_${currentIndex}`)
                  .setLabel('Próxima ▶️')
                  .setStyle(ButtonStyle.Primary)
                  .setDisabled(currentIndex >= totalImages - 1)
              );
              
              await interaction.update({
                embeds: [embed],
                components: [row]
              }).catch(console.error);
              
            } catch (error) {
              console.error('❌ Erro ao navegar screenshots:', error);
            }
            return;
          }

          if (interaction.customId.startsWith('char500_')) {
            const parts = interaction.customId.split('_');
            const action = parts[1]; 
            
            if (action === 'close') {
              await interaction.message.delete().catch(() => {});
              return;
            }

            if (action === 'update') {
                const charName = parts[2];
                const currentPage = parseInt(parts[3]);

                await interaction.deferUpdate();

                try {
                    const freshData = await searchCharacterWithCache(charName);

                    if (freshData) {
                        const refreshedList = await get500RCharacters(currentPage, 1);

                        if (refreshedList.chars && refreshedList.chars.length > 0) {
                            const charData = refreshedList.chars[0];

                            const newEmbed = createAdvancedCharEmbed(
                                charData, 
                                currentPage, 
                                refreshedList.totalPages, 
                                refreshedList.totalChars
                            );
                            const newButtons = createPaginationButtons(currentPage, refreshedList.totalPages, charData.name);

                            await interaction.editReply({ embeds: [newEmbed], components: newButtons });
                            await interaction.followUp({ content: `✅ Dados de **${charName}** atualizados com sucesso direto do site!`, flags: MessageFlags.Ephemeral });
                            return;
                        }
                    } 
                    
                    await interaction.followUp({ content: `❌ Não foi possível atualizar **${charName}**. O site pode estar indisponível ou o personagem não foi encontrado.`, flags: MessageFlags.Ephemeral });
                    
                } catch (error) {
                    console.error('Erro ao atualizar char500:', error);
                    await interaction.followUp({ content: 'Ocorreu um erro durante a atualização.', flags: MessageFlags.Ephemeral });
                }
                return;
            }
            
            const pageStr = parts[parts.length - 1]; 
            let page = parseInt(pageStr);
            
            if (action === 'prev') {
              page = Math.max(1, page - 1);
            } else if (action === 'next') {
              page = page + 1;
            }
            
            await interaction.deferUpdate();
            
            try {
              const { chars, totalChars, totalPages } = await get500RCharacters(page, 1);
              
              if (!chars || chars.length === 0) {
                 await interaction.followUp({ content: 'Não foi possível carregar a página solicitada.', flags: MessageFlags.Ephemeral });
                 return;
              }

              const charData = chars[0];
              const embed = createAdvancedCharEmbed(charData, page, totalPages, totalChars);
              const buttons = createPaginationButtons(page, totalPages, charData.name);

              await interaction.editReply({ 
                content: `**Personagens 500+ Resets** (Total: ${totalChars})`,
                embeds: [embed],
                components: buttons 
              });

            } catch (error) {
              console.error('Erro ao navegar lista de personagens:', error);
              await interaction.editReply({
                content: 'Ocorreu um erro ao navegar a lista de personagens.',
                flags: MessageFlags.Ephemeral
              });
            }
            return;
          }

          if (interaction.customId.startsWith('approve_') || interaction.customId.startsWith('reject_')) {
            const action = interaction.customId.startsWith('approve_') ? 'approve' : 'reject';
            const applicationId = interaction.customId.split('_')[1];
            
            if (!await checkUserPermission(interaction, 'admin')) {
              return interaction.reply({
                content: '❌ Você não tem permissão para realizar esta ação.',
                flags: MessageFlags.Ephemeral
              }).catch(console.error);
            }
            
            try {
              if (action === 'approve') {
                await approveApplication(interaction, applicationId);
              } else {
                const modal = new ModalBuilder()
                  .setCustomId(`reject_modal_${applicationId}`)
                  .setTitle('Rejeitar Inscrição');

                const reasonInput = new TextInputBuilder()
                  .setCustomId('motivo_rejeicao')
                  .setLabel("Qual o motivo da rejeição?")
                  .setStyle(TextInputStyle.Paragraph)
                  .setRequired(true);

                const actionRow = new ActionRowBuilder().addComponents(reasonInput);
                modal.addComponents(actionRow);

                await interaction.showModal(modal);
              }
            } catch (error) {
              console.error(`❌ Erro ao ${action === 'approve' ? 'aprovar' : 'processar'} inscrição:`, error);
              if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                  content: `❌ Ocorreu um erro ao processar a inscrição.`,
                  flags: MessageFlags.Ephemeral
                }).catch(console.error);
              } else {
                await interaction.followUp({
                  content: `❌ Ocorreu um erro ao processar a inscrição.`,
                  flags: MessageFlags.Ephemeral
                }).catch(console.error);
              }
            }
            return;
          }
        } catch (error) {
          console.error('❌ Erro ao processar interação de botão:', error);
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
              content: 'Ocorreu um erro ao processar sua solicitação.',
              flags: MessageFlags.Ephemeral
            }).catch(console.error);
          }
        }
      }

      // Modals
      if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith('reject_modal_')) {
          const applicationId = interaction.customId.split('_')[2];
          
          if (!await checkUserPermission(interaction, 'admin')) {
            return interaction.reply({
              content: '❌ Você não tem permissão para realizar esta ação.',
              flags: MessageFlags.Ephemeral
            }).catch(console.error);
          }
          
          try {
            const reason = interaction.fields.getTextInputValue('motivo_rejeicao');
            
            await rejectApplication(interaction, applicationId, reason);
            
          } catch (error) {
            console.error('❌ Erro ao processar modal de rejeição:', error);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: '❌ Ocorreu um erro ao processar a rejeição.',
                    flags: MessageFlags.Ephemeral
                }).catch(console.error);
            }
          }
        }
      }
    } catch (error) {
      console.error('❌ Erro não tratado em interactionCreate:', error);
      if (interaction.isRepliable()) {
        await interaction.reply({
          content: 'Ocorreu um erro inesperado ao processar sua solicitação.',
          flags: MessageFlags.Ephemeral
        }).catch(console.error);
      }
    }
  });

  client.on(Events.Error, error => {
    console.error('❌ Erro do cliente Discord:', error);
  });

  client.on(Events.Warn, info => {
    console.warn('⚠️ Aviso do Discord:', info);
  });

  console.log('✅ Eventos configurados com sucesso');
}

module.exports = { setupEvents };