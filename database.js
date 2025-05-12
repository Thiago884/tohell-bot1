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
  queueLimit: 0,
  timezone: 'Z' // Usar UTC para evitar problemas com fusos horários
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
    
    // Verificação periódica da conexão
    setInterval(async () => {
      try {
        await dbConnection.query('SELECT 1');
      } catch (err) {
        console.error('❌ Erro na verificação de conexão com o DB:', err);
        await reconnectDB();
      }
    }, 60000); // Verificar a cada 1 minuto
    
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
      CREATE TABLE IF NOT EXISTS characters (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        guild VARCHAR(255),
        last_level INT,
        last_resets INT,
        last_seen DATETIME,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_character (name)
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

    // Tabela para personagens monitorados por usuários
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

    // Tabela para inscrições pendentes
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS inscricoes_pendentes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        telefone VARCHAR(20),
        discord VARCHAR(100) NOT NULL,
        char_principal VARCHAR(100),
        guild_anterior VARCHAR(100),
        ip VARCHAR(45),
        screenshot_path TEXT,
        data_inscricao DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Tabela para inscrições aprovadas
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS inscricoes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        telefone VARCHAR(20),
        discord VARCHAR(100) NOT NULL,
        char_principal VARCHAR(100),
        guild_anterior VARCHAR(100),
        ip VARCHAR(45),
        screenshot_path TEXT,
        data_inscricao DATETIME,
        status ENUM('aprovado', 'rejeitado') DEFAULT 'aprovado',
        avaliador VARCHAR(100),
        data_avaliacao DATETIME,
        motivo_rejeicao TEXT
      )
    `);

    // Tabela para status do sistema
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS system_status (
        key_name VARCHAR(255) PRIMARY KEY,
        key_value TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Tabela para logs do cron
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS cron_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Tabela para IPs bloqueados
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS ips_bloqueados (
        id INT AUTO_INCREMENT PRIMARY KEY,
        ip VARCHAR(45) NOT NULL,
        motivo TEXT NOT NULL,
        pais VARCHAR(100),
        regiao VARCHAR(100),
        cidade VARCHAR(100),
        postal VARCHAR(20),
        provedor VARCHAR(255),
        data_bloqueio TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        bloqueado_por VARCHAR(255),
        UNIQUE KEY unique_ip (ip)
      )
    `);

    // Tabela para whitelist de IPs
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS ips_whitelist (
        id INT AUTO_INCREMENT PRIMARY KEY,
        ip VARCHAR(45) NOT NULL,
        motivo TEXT,
        data_criacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        criado_por VARCHAR(255),
        UNIQUE KEY unique_ip (ip)
      )
    `);

    // Tabela para tentativas de login falhas
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS tentativas_login_falhas (
        id INT AUTO_INCREMENT PRIMARY KEY,
        ip VARCHAR(45) NOT NULL,
        username VARCHAR(255),
        data_acesso TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        user_agent TEXT
      )
    `);

    // Tabela para visitantes do site
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS visitantes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        ip VARCHAR(45) NOT NULL,
        pagina VARCHAR(255) NOT NULL,
        user_agent TEXT,
        referer TEXT,
        data_acesso TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Tabela para informações de IP (cache de geolocalização)
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS ips_info (
        ip VARCHAR(45) PRIMARY KEY,
        pais VARCHAR(100),
        pais_codigo VARCHAR(2),
        regiao VARCHAR(100),
        cidade VARCHAR(100),
        postal VARCHAR(20),
        provedor VARCHAR(255),
        latitude DECIMAL(10, 6),
        longitude DECIMAL(10, 6),
        timezone VARCHAR(50),
        ultima_atualizacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    console.log('✅ Todas as tabelas verificadas/criadas com sucesso');
  } catch (error) {
    console.error('❌ Erro ao criar tabelas:', error);
    throw error;
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
    return dbConnection;
  } catch (err) {
    console.error('❌ Falha na reconexão com o DB:', err);
    // Tentar novamente após 5 segundos
    setTimeout(reconnectDB, 5000);
    return null;
  }
}

// Verificar conexão
async function checkConnection() {
  if (!dbConnection) return false;
  try {
    await dbConnection.query('SELECT 1');
    return true;
  } catch (err) {
    return false;
  }
}

// Função para registrar logs do cron
async function logCronMessage(message) {
  try {
    await dbConnection.execute(
      'INSERT INTO cron_logs (message) VALUES (?)',
      [message]
    );
    return true;
  } catch (error) {
    console.error('❌ Erro ao registrar log do cron:', error);
    return false;
  }
}

// Função para atualizar status do sistema
async function updateSystemStatus(key, value) {
  try {
    await dbConnection.execute(
      'INSERT INTO system_status (key_name, key_value) VALUES (?, ?) ' +
      'ON DUPLICATE KEY UPDATE key_value = VALUES(key_value)',
      [key, value]
    );
    return true;
  } catch (error) {
    console.error('❌ Erro ao atualizar status do sistema:', error);
    return false;
  }
}

// Função para obter status do sistema
async function getSystemStatus(key) {
  try {
    const [rows] = await dbConnection.execute(
      'SELECT key_value FROM system_status WHERE key_name = ?',
      [key]
    );
    return rows.length > 0 ? rows[0].key_value : null;
  } catch (error) {
    console.error('❌ Erro ao obter status do sistema:', error);
    return null;
  }
}

// Função para registrar acesso de visitante
async function logVisitor(ip, pagina, userAgent, referer) {
  try {
    await dbConnection.execute(
      'INSERT INTO visitantes (ip, pagina, user_agent, referer) VALUES (?, ?, ?, ?)',
      [ip, pagina, userAgent, referer]
    );
    return true;
  } catch (error) {
    console.error('❌ Erro ao registrar visitante:', error);
    return false;
  }
}

// Função para registrar tentativa de login falha
async function logFailedLoginAttempt(ip, username, userAgent) {
  try {
    await dbConnection.execute(
      'INSERT INTO tentativas_login_falhas (ip, username, user_agent) VALUES (?, ?, ?)',
      [ip, username, userAgent]
    );
    return true;
  } catch (error) {
    console.error('❌ Erro ao registrar tentativa de login falha:', error);
    return false;
  }
}

// Função para atualizar/criar informações de IP
async function updateIPInfo(ip, geoData) {
  try {
    await dbConnection.execute(
      'INSERT INTO ips_info (ip, pais, pais_codigo, regiao, cidade, postal, provedor, latitude, longitude, timezone) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON DUPLICATE KEY UPDATE ' +
      'pais = VALUES(pais), ' +
      'pais_codigo = VALUES(pais_codigo), ' +
      'regiao = VALUES(regiao), ' +
      'cidade = VALUES(cidade), ' +
      'postal = VALUES(postal), ' +
      'provedor = VALUES(provedor), ' +
      'latitude = VALUES(latitude), ' +
      'longitude = VALUES(longitude), ' +
      'timezone = VALUES(timezone)',
      [
        ip,
        geoData.country,
        geoData.countryCode,
        geoData.region,
        geoData.city,
        geoData.postal,
        geoData.org,
        geoData.lat,
        geoData.lon,
        geoData.timezone
      ]
    );
    return true;
  } catch (error) {
    console.error('❌ Erro ao atualizar informações de IP:', error);
    return false;
  }
}

module.exports = {
  connectDB,
  dbConnection,
  isShuttingDown,
  checkConnection,
  reconnectDB,
  logCronMessage,
  updateSystemStatus,
  getSystemStatus,
  logVisitor,
  logFailedLoginAttempt,
  updateIPInfo
};