const { Client, IntentsBitField } = require('discord.js');
const express = require('express');
require('dotenv').config();

// Importações dos outros módulos
const { setupCommands } = require('./commands');
const { setupEvents } = require('./events');
const { connectDB, setShutdownState, closeConnection, isConnectionActive } = require('./database');

// Configurações do bot
const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMembers,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.MessageContent,
    IntentsBitField.Flags.GuildMessageReactions
  ]
});

// Configuração do servidor Express
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.get('/', (_, res) => res.status(200).json({ status: 'ok' }));

// Health check melhorado
app.get('/health', async (_, res) => {
  try {
    const dbHealthy = await isConnectionActive();
    const discordHealthy = client.isReady();
    
    res.status(200).json({ 
      status: dbHealthy && discordHealthy ? 'healthy' : 'degraded',
      database: dbHealthy ? 'connected' : 'disconnected',
      discord: discordHealthy ? 'connected' : 'disconnected',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'unhealthy',
      error: error.message 
    });
  }
});
// Inicialização do bot
async function startBot() {
  try {
    // Conectar ao banco de dados
    console.log('🔌 Conectando ao banco de dados...');
    await connectDB();
    
    if (!await isConnectionActive()) {
      throw new Error('Não foi possível estabelecer conexão com o banco de dados');
    }

    // Configurar comandos e eventos
    console.log('⚙️ Configurando comandos e eventos...');
    setupCommands(client);
    setupEvents(client);

    // Iniciar servidor
    const server = app.listen(PORT, () => {
      console.log(`🌐 Servidor Express rodando na porta ${PORT}`);
    });
    
    // Login do bot
    console.log('🔑 Conectando ao Discord...');
    await client.login(process.env.DISCORD_TOKEN);
    
    // Configurar shutdown graceful
    process.on('SIGTERM', gracefulShutdown(server));
    process.on('SIGINT', gracefulShutdown(server));
    
  } catch (error) {
    console.error('❌ Erro fatal ao iniciar o bot:', error);
    process.exit(1);
  }
}

// Função para shutdown graceful
function gracefulShutdown(server) {
  return async (signal) => {
    console.log(`🛑 Recebido ${signal}, encerrando graceful...`);
    setShutdownState(true); // Atualiza a variável global em todos os módulos
    
    try {
      // Desconectar o bot do Discord
      if (client && !client.destroyed) {
        client.destroy();
        console.log('🤖 Bot desconectado do Discord');
      }
      
      // Encerrar conexão com o banco de dados
      await closeConnection();
      
      // Encerrar servidor HTTP
      server.close(() => {
        console.log('🛑 Servidor HTTP encerrado');
        process.exit(0);
      });
      
      // Timeout de segurança
      setTimeout(() => {
        console.log('🛑 Forçando encerramento...');
        process.exit(1);
      }, 10000);
      
    } catch (err) {
      console.error('❌ Erro no shutdown graceful:', err);
      process.exit(1);
    }
  };
}

// Manipuladores para exceções não tratadas
process.on('unhandledRejection', error => {
    console.error('❌ Rejeição de Promise não tratada:', error);
});

process.on('uncaughtException', error => {
    console.error('❌ Exceção não capturada:', error);
});

startBot();

// Exportações para testes (opcional)
module.exports = {
  client,
  app,
  startBot,
  gracefulShutdown
};