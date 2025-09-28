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
  timezone: 'Z',
  connectTimeout: 10000,
  acquireTimeout: 60000,
  timeout: 60000,
  reconnect: true
};

// Variável global para controle de shutdown
let dbConnection = null;
let isShuttingDown = false;

// Função para definir o estado de shutdown
function setShutdownState(shuttingDown) {
  isShuttingDown = shuttingDown;
}

// Conexão com o banco de dados
async function connectDB() {
  try {
    dbConnection = await mysql.createPool(dbConfig);
    console.log('✅ Conectado ao banco de dados MySQL');
    
    // Criar tabelas necessárias
    await createTables();
    
    // Verificação periódica da conexão
    setInterval(async () => {
      if (isShuttingDown) return;
      
      try {
        await dbConnection.query('SELECT 1');
      } catch (err) {
        console.error('❌ Erro na verificação de conexão com o DB:', err.message);
        await reconnectDB();
      }
    }, 60000); // Verificar a cada 1 minuto
    
    return dbConnection;
  } catch (error) {
    console.error('❌ Erro ao conectar ao banco de dados:', error.message);
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

    // Tabela para IPs bloqueados (atualizada com bloqueado_por)
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
    
    // NOVA TABELA PARA NOTIFICAÇÕES
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS notification_subscriptions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        notification_type VARCHAR(100) NOT NULL,
        role_id VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_subscription (notification_type, role_id)
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
      try {
        await dbConnection.end().catch(() => {});
      } catch (endError) {
        console.log('⚠️ Erro ao encerrar conexão anterior:', endError.message);
      }
    }
    
    dbConnection = await mysql.createPool(dbConfig);
    console.log('✅ Reconectado ao banco de dados com sucesso');
    return dbConnection;
  } catch (err) {
    console.error('❌ Falha na reconexão com o DB:', err.message);
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

// Função para verificar se a conexão está ativa
async function isConnectionActive() {
  if (isShuttingDown || !dbConnection) {
    return false;
  }
  
  try {
    await dbConnection.execute('SELECT 1');
    return true;
  } catch (error) {
    console.log('⚠️ Conexão com DB não está ativa:', error.message);
    return false;
  }
}

// Função para executar query com verificação de conexão
async function executeQuery(query, params = []) {
  if (isShuttingDown) {
    throw new Error('Database pool is shutting down');
  }
  
  try {
    if (!dbConnection) {
      throw new Error('Conexão com DB não disponível');
    }
    
    const [result] = await dbConnection.execute(query, params);
    return result;
  } catch (error) {
    if (error.code === 'POOL_CLOSED' || error.message.includes('Pool is closed')) {
      console.log('⚠️ Pool fechado, tentando reconectar...');
      throw new Error('POOL_CLOSED');
    }
    console.error('❌ Erro na execução da query:', error.message);
    throw error;
  }
}

// Função auxiliar para executar query com tratamento seguro
async function safeExecuteQuery(query, params = []) {
  if (isShuttingDown) {
    console.log('⏸️ Query cancelada (shutdown em andamento)');
    return null;
  }
  
  if (!await isConnectionActive()) {
    console.log('🔄 Reconectando ao DB antes da query...');
    await reconnectDB();
  }
  
  if (!dbConnection) {
    console.error('❌ Conexão com DB não disponível após tentativa de reconexão');
    return null;
  }
  
  try {
    const [result] = await dbConnection.execute(query, params);
    return result;
  } catch (error) {
    if (error.code === 'POOL_CLOSED' || error.message.includes('Pool is closed')) {
      console.log('⚠️ Pool fechado durante query, tentando reconectar...');
      await reconnectDB();
      return null;
    }
    console.error('❌ Erro na execução da query:', error.message);
    return null;
  }
}

// Função para registrar logs do cron
async function logCronMessage(message) {
  try {
    const result = await safeExecuteQuery(
      'INSERT INTO cron_logs (message) VALUES (?)',
      [message]
    );
    return result !== null;
  } catch (error) {
    console.error('❌ Erro ao registrar log do cron:', error);
    return false;
  }
}

// Função para atualizar status do sistema
async function updateSystemStatus(key, value) {
  try {
    const result = await safeExecuteQuery(
      'INSERT INTO system_status (key_name, key_value) VALUES (?, ?) ' +
      'ON DUPLICATE KEY UPDATE key_value = VALUES(key_value)',
      [key, value]
    );
    return result !== null;
  } catch (error) {
    console.error('❌ Erro ao atualizar status do sistema:', error);
    return false;
  }
}

// Função para obter status do sistema
async function getSystemStatus(key) {
  try {
    const rows = await safeExecuteQuery(
      'SELECT key_value FROM system_status WHERE key_name = ?',
      [key]
    );
    return rows && rows.length > 0 ? rows[0].key_value : null;
  } catch (error) {
    console.error('❌ Erro ao obter status do sistema:', error);
    return null;
  }
}

// Função para registrar acesso de visitante
async function logVisitor(ip, pagina, userAgent, referer) {
  try {
    const result = await safeExecuteQuery(
      'INSERT INTO visitantes (ip, pagina, user_agent, referer) VALUES (?, ?, ?, ?)',
      [ip, pagina, userAgent, referer]
    );
    return result !== null;
  } catch (error) {
    console.error('❌ Erro ao registrar visitante:', error);
    return false;
  }
}

// Função para registrar tentativa de login falha
async function logFailedLoginAttempt(ip, username, userAgent) {
  try {
    const result = await safeExecuteQuery(
      'INSERT INTO tentativas_login_falhas (ip, username, user_agent) VALUES (?, ?, ?)',
      [ip, username, userAgent]
    );
    return result !== null;
  } catch (error) {
    console.error('❌ Erro ao registrar tentativa de login falha:', error);
    return false;
  }
}

// Função para atualizar/criar informações de IP
async function updateIPInfo(ip, geoData) {
  try {
    const result = await safeExecuteQuery(
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
    return result !== null;
  } catch (error) {
    console.error('❌ Erro ao atualizar informações de IP:', error);
    return false;
  }
}

// Função para buscar inscrições pendentes (usada pelo checkNewApplications)
async function getPendingApplicationsSince(lastChecked) {
  try {
    const rows = await safeExecuteQuery(
      'SELECT * FROM inscricoes_pendentes WHERE data_inscricao > ? ORDER BY data_inscricao DESC',
      [lastChecked]
    );
    return rows || [];
  } catch (error) {
    console.error('❌ Erro ao buscar inscrições pendentes:', error);
    return [];
  }
}

// Função para buscar novos membros (usada pelo checkNewMembersForConflicts)
async function getNewMembersSince(lastChecked) {
  try {
    const rows = await safeExecuteQuery(
      `SELECT nome, guild, data_insercao FROM membros WHERE data_insercao > ? AND status = 'novo' ORDER BY data_insercao ASC`,
      [lastChecked]
    );
    return rows || [];
  } catch (error) {
    console.error('❌ Erro ao buscar novos membros:', error);
    return [];
  }
}

// Função para buscar membros que saíram (usada pelo checkDepartingMembers)
async function getDepartedMembersSince(lastChecked) {
  try {
    const rows = await safeExecuteQuery(
      `SELECT nome, data_saida FROM membros WHERE status = 'saiu' AND data_saida > ? ORDER BY data_saida ASC`,
      [lastChecked]
    );
    return rows || [];
  } catch (error) {
    console.error('❌ Erro ao buscar membros que saíram:', error);
    return [];
  }
}

// Função para verificar se pode executar operações no DB
async function canExecuteDBOperation() {
  if (isShuttingDown) {
    return false;
  }
  
  return await isConnectionActive();
}

// Função para obter informações de segurança (usada pelo monitoramento)
async function getSecurityMonitoringData() {
  if (!await canExecuteDBOperation()) {
    return { suspiciousLogins: [], blockedAccess: [] };
  }
  
  try {
    const [suspiciousLogins] = await dbConnection.execute(`
      SELECT ip, COUNT(*) as tentativas 
      FROM tentativas_login_falhas 
      WHERE data_acesso >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
      GROUP BY ip 
      HAVING tentativas > 5
      ORDER BY tentativas DESC
    `);
    
    const [blockedAccess] = await dbConnection.execute(`
      SELECT v.ip, COUNT(*) as tentativas, MAX(v.data_acesso) as ultima_tentativa
      FROM visitantes v
      JOIN ips_bloqueados b ON v.ip = b.ip
      WHERE v.data_acesso >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
      GROUP BY v.ip
      ORDER BY tentativas DESC
    `);
    
    return { suspiciousLogins, blockedAccess };
  } catch (error) {
    console.error('❌ Erro ao buscar dados de segurança:', error);
    return { suspiciousLogins: [], blockedAccess: [] };
  }
}

// Função para fechar a conexão gracefulmente
async function closeConnection() {
  isShuttingDown = true;
  if (dbConnection) {
    try {
      await dbConnection.end();
      console.log('🔌 Conexão com DB encerrada gracefulmente');
    } catch (error) {
      console.error('❌ Erro ao encerrar conexão com DB:', error);
    }
    dbConnection = null;
  }
}

// Getter para a conexão do banco (para compatibilidade com código existente)
function getDBConnection() {
  return dbConnection;
}

module.exports = {
  connectDB,
  dbConnection: getDBConnection, // Getter function
  isShuttingDown: () => isShuttingDown, // Getter function
  setShutdownState,
  checkConnection,
  reconnectDB,
  isConnectionActive,
  executeQuery,
  safeExecuteQuery,
  canExecuteDBOperation,
  logCronMessage,
  updateSystemStatus,
  getSystemStatus,
  logVisitor,
  logFailedLoginAttempt,
  updateIPInfo,
  getPendingApplicationsSince,
  getNewMembersSince,
  getDepartedMembersSince,
  getSecurityMonitoringData,
  closeConnection
};