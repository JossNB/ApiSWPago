const sql = require('mssql');
require('dotenv').config();  // Cargar las variables de entorno desde .env

const config = {
    user: process.env.BDUSER,       // Tu usuario de base de datos
    password: process.env.BDPASS,   // Tu contraseña de base de datos
    server: process.env.BDHOST,     // Tu host
    database: process.env.BDNAME,   // Nombre de la base de datos
    port: parseInt(process.env.BDPORT) || 1433, // Puerto (por defecto 1433 para SQL Server)
    options: {
        encrypt: true, // Usar cifrado (requerido para Azure SQL, puede ser false en local)
        trustServerCertificate: true // Permite certificados autofirmados en entornos locales
    }
};

const pool = new sql.ConnectionPool(config);
const connection = pool.connect()
    .then(pool => {
        console.log('Conexión a la base de datos SQL Server exitosa');
        return pool;
    })
    .catch(err => {
        console.error('Error al conectar a la base de datos:', err);
    });

module.exports = connection;
