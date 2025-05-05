const mysql = require('mysql2/promise');

// Configurações do banco de dados
const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

let dbConnection;
let isShuttingDown = false;

// Conexão com o banco de dados
async function connectDB() {
  try {
    dbConnection = await mysql.createPool(dbConfig);
    console.log('✅ Conectado ao banco de dados MySQL');
    
    // Criar tabelas necessárias
    await createTables();
    
    setInterval(async () => {
      try {
        await dbConnection.query('SELECT 1');
      } catch (err) {
        console.error('❌ Erro na verificação de conexão com o DB:', err);
        await reconnectDB();
      }
    }, 60000);
    
    return dbConnection;
  } catch (error) {
    console.error('❌ Erro ao conectar ao banco de dados:', error);
    await reconnectDB();
  }
}

// Criar tabelas
async function createTables() {
  try {
    // Tabela para personagens monitorados
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS tracked_characters (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        discord_user_id VARCHAR(255) NOT NULL,
        channel_id VARCHAR(255),
        last_level INT,
        last_resets INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_tracking (name, discord_user_id)
      )
    `);
    
    // Tabela para histórico de personagens
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS character_history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        character_id INT NOT NULL,
        level INT NOT NULL,
        resets INT NOT NULL,
        recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
      )
    `);
    
    // Tabela para permissões de comandos
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS command_permissions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        command_name VARCHAR(255) NOT NULL,
        role_id VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_permission (command_name, role_id)
      )
    `);
    
    console.log('✅ Tabelas verificadas/criadas com sucesso');
  } catch (error) {
    console.error('❌ Erro ao criar tabelas:', error);
  }
}

// Reconectar ao banco de dados
async function reconnectDB() {
  if (isShuttingDown) return;
  
  console.log('🔄 Tentando reconectar ao banco de dados...');
  try {
    if (dbConnection) {
      await dbConnection.end().catch(() => {});
    }
    dbConnection = await mysql.createPool(dbConfig);
    console.log('✅ Reconectado ao banco de dados com sucesso');
  } catch (err) {
    console.error('❌ Falha na reconexão com o DB:', err);
    setTimeout(reconnectDB, 5000);
  }
}

module.exports = {
  connectDB,
  dbConnection,
  isShuttingDown
};