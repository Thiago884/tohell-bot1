const { Events, EmbedBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { 
    safeSend, searchCharacterWithCache, showRanking, searchCharacter, 
    getCommandPermissions, addCommandPermission, removeCommandPermission, checkUserPermission, 
    formatBrazilianDate, processImageUrls, blockIP, unblockIP, queryIP, getIPInfo, 
    generateSecurityReport, getRecentAccess, manageWhitelist, checkPhoneNumber, get500RCharacters,
    // Novas importações para o sistema de notificação
    addNotificationSubscription, removeNotificationSubscription, getNotificationSubscriptions, sendDmsToRoles 
} = require('./utils');
const { isShuttingDown } = require('./database');
const { listPendingApplications, searchApplications, sendApplicationEmbed, approveApplication, rejectApplication, showHelp, createImageCarousel } = require('./commands');

// --- VARIÁVEIS DE ESTADO PARA OS MONITORES ---
// Monitor de inscrições pendentes
let lastCheckedApplications = new Date();
// Monitor de novos membros (para verificação de inimigos)
let lastCheckedMemberTimestamp = new Date();
// NOVO: Monitor de membros que saíram
let lastCheckedDepartureTimestamp = new Date();
const SECURITY_ALERT_CHANNEL_ID = '1256287757135908884';

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

// Verificar novas inscrições e notificar por DM
async function checkNewApplications(client, db) {
  if (isShuttingDown) return;
  
  try {
    if (!db || !(await db.execute('SELECT 1').catch(() => false))) {
      console.log('⚠️ Conexão com o banco de dados não está disponível para checar inscrições.');
      return;
    }

    const [rows] = await db.execute(
      'SELECT * FROM inscricoes_pendentes WHERE data_inscricao > ? ORDER BY data_inscricao ASC',
      [lastCheckedApplications]
    );
    
    if (rows.length > 0) {
      const channel = await client.channels.fetch(process.env.ALLOWED_CHANNEL_ID);
      
      await channel.send({
        content: `📢 Há ${rows.length} nova(s) inscrição(ões) pendente(s)! Use /pendentes para visualizar.`
      });
      
      // Busca os cargos que devem ser notificados por DM
      const roleIdsToNotify = await getNotificationSubscriptions('inscricao_pendente', db);

      for (const application of rows) {
        await sendApplicationEmbed(channel, application, db);
        
        // Envia a notificação por DM
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
      
      // <-- CORREÇÃO APLICADA AQUI -->
      // Atualiza o timestamp APENAS UMA VEZ, após o loop, com a data da última inscrição processada.
      lastCheckedApplications = new Date(rows[rows.length - 1].data_inscricao);
    }
  } catch (error) {
    if (error.code === 'POOL_CLOSED') {
      console.log('⚠️ Pool de conexão fechado, aguardando reconexão...');
    } else {
      console.error('❌ Erro ao verificar novas inscrições:', error);
    }
  }
}

// Verificar novos membros e cruzar com a lista de inimigos
async function checkNewMembersForConflicts(client, db) {
    if (isShuttingDown) return;

    try {
        if (!db || !(await db.execute('SELECT 1').catch(() => false))) {
            console.log('⚠️ Conexão com o banco de dados não está disponível para checar conflitos.');
            return;
        }

        const [newMembers] = await db.execute(
            `SELECT nome, guild, data_insercao FROM membros WHERE data_insercao > ? AND status = 'novo' ORDER BY data_insercao ASC`,
            [lastCheckedMemberTimestamp]
        );

        if (newMembers.length > 0) {
            const securityChannel = await client.channels.fetch(SECURITY_ALERT_CHANNEL_ID).catch(() => null);
            const roleIdsToNotify = await getNotificationSubscriptions('alerta_seguranca', db);

            for (const member of newMembers) {
                const [enemies] = await db.execute(
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

                    // Envia para o canal de segurança
                    if (securityChannel) {
                        await securityChannel.send({ embeds: [alertEmbed] });
                    }

                    // Envia DM para os cargos de segurança
                    await sendDmsToRoles(client, roleIdsToNotify, { embeds: [alertEmbed] });
                }

                // Atualiza o timestamp para a próxima verificação
                lastCheckedMemberTimestamp = new Date(member.data_insercao);
            }
        }
    } catch (error) {
        if (error.code === 'POOL_CLOSED') {
            console.log('⚠️ Pool de conexão fechado, aguardando reconexão...');
        } else {
            console.error('❌ Erro ao verificar conflitos de membros:', error);
        }
    }
}

// ==========================================================
// NOVA FUNÇÃO PARA VERIFICAR SAÍDAS E NOTIFICAR
// ==========================================================
async function checkDepartingMembers(client, db) {
    if (isShuttingDown) return;

    try {
        if (!db || !(await db.execute('SELECT 1').catch(() => false))) {
            console.log('⚠️ Conexão com o banco de dados não está disponível para checar saídas.');
            return;
        }

        // Busca membros que saíram desde a última verificação
        const [departedMembers] = await db.execute(
            `SELECT nome, data_saida FROM membros WHERE status = 'saiu' AND data_saida > ? ORDER BY data_saida ASC`,
            [lastCheckedDepartureTimestamp]
        );

        if (departedMembers.length > 0) {
            const securityChannel = await client.channels.fetch(SECURITY_ALERT_CHANNEL_ID).catch(() => null);
            // Reutiliza a notificação de 'alerta_seguranca' para notificar os mesmos cargos
            const roleIdsToNotify = await getNotificationSubscriptions('alerta_seguranca', db);

            for (const member of departedMembers) {
                // Busca a inscrição correspondente na tabela de inscrições aprovadas
                const [applications] = await db.execute(
                    `SELECT nome, telefone FROM inscricoes WHERE char_principal = ? AND status = 'aprovado' ORDER BY data_avaliacao DESC LIMIT 1`,
                    [member.nome]
                );

                if (applications.length > 0) {
                    const application = applications[0];

                    const departureEmbed = new EmbedBuilder()
                        .setColor('#FFA500')
                        .setTitle('👤 Membro Saiu da Guild')
                        .setDescription(`O personagem **${member.nome}** foi marcado como "saiu".`)
                        .addFields(
                            { name: '📋 Nome na Inscrição', value: application.nome, inline: true },
                            { name: '📞 Telefone na Inscrição', value: application.telefone || 'Não informado', inline: true },
                            { name: '🗓️ Data da Saída', value: formatBrazilianDate(member.data_saida), inline: false }
                        )
                        .setFooter({ text: 'Aguardando classificação da saída.' });

                    const actionRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId(`departed_cs_volta_${member.nome}`)
                            .setLabel('Saiu para cs, mas volta!')
                            .setStyle(ButtonStyle.Success),
                        new ButtonBuilder()
                            .setCustomId(`departed_left_guild_${member.nome}`)
                            .setLabel('Saiu da guild')
                            .setStyle(ButtonStyle.Danger)
                    );

                    const messagePayload = { embeds: [departureEmbed], components: [actionRow] };

                    // Envia para o canal de segurança
                    if (securityChannel) {
                        await securityChannel.send(messagePayload);
                    }

                    // Envia DMs para os cargos subscritos
                    await sendDmsToRoles(client, roleIdsToNotify, messagePayload);
                }

                // Atualiza o timestamp para a data de saída do membro atual
                lastCheckedDepartureTimestamp = new Date(member.data_saida);
            }
        }
    } catch (error) {
        if (error.code === 'POOL_CLOSED') {
            console.log('⚠️ Pool de conexão fechado, aguardando reconexão...');
        } else {
            console.error('❌ Erro ao verificar saídas de membros:', error);
        }
    }
}
// ==========================================================

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

// Configurar eventos
function setupEvents(client, db) {
  // Evento ready
  client.on(Events.ClientReady, async () => {
    console.log(`🤖 Bot conectado como ${client.user.tag}`);
    client.user.setActivity('/ajuda para comandos', { type: 'WATCHING' });
    
    await setupSecurityMonitoring(client, db);
    await setupAutoCleanup(db);
    
    // Intervalo para verificar novas inscrições
    setInterval(() => checkNewApplications(client, db), 60000); // 1 minuto
    
    // Intervalo para verificar conflitos de membros
    setInterval(() => checkNewMembersForConflicts(client, db), 5 * 60000); // 5 minutos
    
    // NOVO: Intervalo para verificar saídas de membros
    setInterval(() => checkDepartingMembers(client, db), 5 * 60000); // 5 minutos
  });

  // Evento interactionCreate com tratamento de erros melhorado
  client.on(Events.InteractionCreate, async interaction => {
    if (isShuttingDown) return;

    try {
      // Comandos slash
      if (interaction.isCommand()) {
        console.log(`🔍 Comando slash detectado: ${interaction.commandName}`, interaction.options.data);

        // A verificação de permissão para 'pendentes' agora é feita com base nas subscrições de notificação
        if (interaction.commandName !== 'pendentes' && !await checkUserPermission(interaction, interaction.commandName, db)) {
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

          case 'admin-notificacoes':
              if (!interaction.member?.permissions.has('ADMINISTRATOR')) {
                  return interaction.reply({ content: '❌ Apenas administradores podem usar este comando.', flags: MessageFlags.Ephemeral });
              }
              const actionNotify = interaction.options.getString('acao');
              const typeNotify = interaction.options.getString('tipo');
              const roleNotify = interaction.options.getRole('cargo');

              await interaction.deferReply({ ephemeral: true });

              if (actionNotify === 'list') {
                  const roleIds = await getNotificationSubscriptions(typeNotify, db);
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
                  const success = await addNotificationSubscription(typeNotify, roleNotify.id, db);
                  return interaction.editReply(success ? `✅ O cargo **${roleNotify.name}** agora receberá notificações de **${typeNotify}**.` : '❌ Erro. O cargo talvez já esteja subscrito.');
              }

              if (actionNotify === 'remove') {
                  const success = await removeNotificationSubscription(typeNotify, roleNotify.id, db);
                  return interaction.editReply(success ? `✅ O cargo **${roleNotify.name}** não receberá mais notificações de **${typeNotify}**.` : '❌ Erro. O cargo talvez não estivesse subscrito.');
              }
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
                  { name: 'País', value: `${result.data.countryName} (${result.data.countryCode})`, inline: true },
                  { name: 'Código do País', value: result.data.countryPrefix || 'N/A', inline: true },
                  { name: 'Localização', value: result.data.location || 'N/A', inline: true },
                  { name: 'Operadora', value: result.data.carrier || 'N/A', inline: true },
                  { name: 'Tipo de Linha', value: result.data.lineType || 'N/A', inline: true }
                )
                .setFooter({ text: 'Dados fornecidos por Numverify API' })
                .setTimestamp();
              
              await interaction.editReply({ embeds: [embed] });
              
              // Envia os formatos diretamente no canal (visível para todos)
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
            await listPendingApplications(interaction, [page.toString()], db);
            return;
          }
          
          if (interaction.customId.startsWith('departed_cs_volta_') || interaction.customId.startsWith('departed_left_guild_')) {
              try {
                  const isCS = interaction.customId.startsWith('departed_cs_volta_');
                  const statusText = isCS ? "Saiu para cs, mas volta!" : "Saiu da guild";
                  
                  await interaction.deferUpdate();
      
                  const originalEmbed = interaction.message.embeds[0];
                  const updatedEmbed = new EmbedBuilder(originalEmbed)
                      .setColor(isCS ? '#00FF00' : '#FF0000') 
                      .setFooter({ text: `Status definido como: "${statusText}" por ${interaction.user.tag}` });
      
                  await interaction.editReply({ embeds: [updatedEmbed], components: [] });
      
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
            await searchApplications(interaction, [searchTerm, page.toString()], db);
            return;
          }

          // =================================================================================
          // CORREÇÃO APLICADA AQUI
          // =================================================================================
          if (interaction.customId.startsWith('view_screenshots_')) {
            // Adia a resposta para evitar o erro "Unknown Interaction"
            await interaction.deferReply({ ephemeral: true });

            const [_, __, applicationId, status] = interaction.customId.split('_');
            
            try {
              const table = status === 'aprovado' ? 'inscricoes' : 'inscricoes_pendentes';
              
              const [rows] = await db.execute(
                `SELECT screenshot_path FROM ${table} WHERE id = ?`,
                [applicationId]
              );
              
              if (rows.length === 0) {
                // Usa editReply porque a resposta já foi adiada
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
              
              // Passa o 'status' para a função do carrossel
              await createImageCarousel(interaction, processedScreenshots, applicationId, status);
              
            } catch (error) {
              console.error('❌ Erro ao buscar screenshots:', error);
              // Usa editReply no bloco catch também
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
              const [rows] = await db.execute(
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
              
              // Atualiza o índice
              if (action === 'prev') {
                currentIndex = (currentIndex - 1 + totalImages) % totalImages;
              } else if (action === 'next') {
                currentIndex = (currentIndex + 1) % totalImages;
              }
              
              const embed = new EmbedBuilder()
                .setColor('#0099ff')
                .setTitle(`Screenshots da Inscrição ${applicationId} (${status === 'aprovado' ? 'Aprovada' : 'Pendente'})`)
                .setImage(processedScreenshots[currentIndex])
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
          // =================================================================================

          if (interaction.customId.startsWith('char500_')) {
            const [_, action, pageStr] = interaction.customId.split('_');
            
            if (action === 'close') {
              try {
                await interaction.message.delete().catch(error => {
                  if (error.code !== 10008) throw error; // Ignora "Unknown Message" error
                });
              } catch (error) {
                console.error('Erro ao fechar lista de personagens:', error);
              }
              return;
            }
            
            let page = parseInt(pageStr);
            
            if (action === 'prev') {
              page = Math.max(1, page - 1);
            } else if (action === 'next') {
              page = page + 1;
            }
            
            await interaction.deferUpdate();
            
            try {
              const { chars, totalChars, totalPages, lastUpdated } = await get500RCharacters(db, page);
              
              if (!chars || chars.length === 0) {
                return interaction.editReply({
                  content: 'Nenhum personagem com 500+ resets encontrado.',
                  flags: MessageFlags.Ephemeral
                });
              }

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
                  .setTitle(`🏆 ${char.name} — #${(page - 1) * 5 + index + 1}`)
                  .setDescription(
                    `🏰 **Guilda:** ${char.guild}\n` +
                    `🔄 **Resets:** ${char.resets}\n` +
                    `📌 **Status:** ${statusText}`
                  )
                  .setImage(userbarUrl)
                  .setFooter({ text: `Atualizado em ${formatBrazilianDate(lastUpdated)}` });
              });

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
            
            if (!await checkUserPermission(interaction, 'admin', db)) {
              return interaction.reply({
                content: '❌ Você não tem permissão para realizar esta ação.',
                flags: MessageFlags.Ephemeral
              }).catch(console.error);
            }
            
            try {
              await interaction.deferReply({ flags: MessageFlags.Ephemeral });
              
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
              
              if (action === 'approve') {
                await approveApplication(interaction, application, db);
              } else {
                await rejectApplication(interaction, application, db);
              }
              
              try {
                await interaction.message.delete().catch(error => {
                  if (error.code !== 10008) throw error; 
                });
              } catch (error) {
                console.error('Erro ao deletar mensagem:', error);
              }
              
            } catch (error) {
              console.error(`❌ Erro ao ${action === 'approve' ? 'aprovar' : 'rejeitar'} inscrição:`, error);
              await interaction.editReply({
                content: `❌ Ocorreu um erro ao processar a inscrição.`
              }).catch(console.error);
            }
          }
        } catch (error) {
          console.error('❌ Erro ao processar interação de botão:', error);
          await interaction.reply({
            content: 'Ocorreu um erro ao processar sua solicitação.',
            flags: MessageFlags.Ephemeral
          }).catch(console.error);
        }
      }

      // Modals
      if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith('reject_modal_')) {
          const applicationId = interaction.customId.split('_')[2];
          
          if (!await checkUserPermission(interaction, 'admin', db)) {
            return interaction.reply({
              content: '❌ Você não tem permissão para realizar esta ação.',
              flags: MessageFlags.Ephemeral
            }).catch(console.error);
          }
          
          try {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            
            const motivo = interaction.fields.getTextInputValue('motivo_rejeicao');
            
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
            
            try {
              const user = await client.users.fetch(application.discord_id);
              await user.send({
                content: `❌ Sua inscrição para a guilda foi **rejeitada**.\n**Motivo:** ${motivo}\n\nVocê pode se inscrever novamente após corrigir os problemas.`
              });
            } catch (dmError) {
              console.error('❌ Não foi possível enviar DM:', dmError);
            }
            
            await db.execute(
              'DELETE FROM inscricoes_pendentes WHERE id = ?',
              [applicationId]
            );
            
            await db.execute(
              'INSERT INTO historico_inscricoes (discord_id, discord_name, char_name, nivel, resets, guild, screenshot_path, status, motivo, moderador_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
              [application.discord_id, application.discord_name, application.char_name, application.nivel, application.resets, application.guild, application.screenshot_path, 'rejeitado', motivo, interaction.user.id]
            );
            
            await interaction.editReply({
              content: '✅ Inscrição rejeitada com sucesso.'
            }).catch(console.error);
            
            try {
              await interaction.message.delete().catch(error => {
                if (error.code !== 10008) throw error; 
              });
            } catch (error) {
              console.error('Erro ao deletar mensagem:', error);
            }
            
          } catch (error) {
            console.error('❌ Erro ao processar modal de rejeição:', error);
            await interaction.editReply({
              content: '❌ Ocorreu um erro ao processar a rejeição.'
            }).catch(console.error);
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