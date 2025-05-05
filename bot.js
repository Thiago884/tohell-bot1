const { Client, IntentsBitField } = require('discord.js');
const express = require('express');
require('dotenv').config();

// Importações dos outros módulos
const { setupCommands } = require('./commands');
const { setupEvents } = require('./events');
const { connectDB, isShuttingDown } = require('./database');

// Configurações do bot
const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
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
app.get('/health', (_, res) => res.status(200).json({ status: 'healthy' }));

// Variável para armazenar a conexão com o banco de dados
let db;

// Inicialização do bot
async function startBot() {
  try {
    // Conectar ao banco de dados
    db = await connectDB();
    
    // Configurar comandos e eventos
    setupCommands(client);
    setupEvents(client, db);
    
    // Iniciar servidor
    const server = app.listen(PORT, () => {
      console.log(`🌐 Servidor Express rodando na porta ${PORT}`);
    });
    
    // Login do bot
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
    isShuttingDown = true;
    
    try {
      // Desconectar o bot do Discord
      if (client && !client.destroyed) {
        await client.destroy();
        console.log('🤖 Bot desconectado do Discord');
      }
      
      // Encerrar conexão com o banco de dados
      if (db) {
        await db.end();
        console.log('🔌 Conexão com DB encerrada');
      }
      
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

startBot();

// Exportações para testes (opcional)
module.exports = {
  client,
  app,
  startBot,
  gracefulShutdown
};