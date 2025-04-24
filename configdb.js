// configdb.js
require('dotenv').config();
const sql = require('mssql');

const server = process.env.BDHOST;
if (!server) {
  throw new Error('🌱 La variable de entorno BDHOST no está definida. ¿Tu .env está en la raíz?');
}

const config = {
  user:     process.env.BDUSER,
  password: process.env.BDPASS,
  server,                             // ✔️ siempre será string
  database: process.env.BDNAME,
  port:     parseInt(process.env.BDPORT) || 1433,
  options: {
    encrypt: true,
    trustServerCertificate: true
  }
};

module.exports = sql
  .connect(config)
  .then(pool => {
    console.log('✅ Conexión a SQL Server establecida');
    return pool;
  })
  .catch(err => {
    console.error('❌ Error al conectar a la DB:', err);
    throw err;
  });
