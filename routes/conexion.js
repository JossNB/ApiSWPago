const express = require('express');
const router = express.Router();
const connection = require('../configdb'); // Conexión a la base de datos
const sql = require('mssql');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const nodemailer = require('nodemailer');


async function generarFactura(datos) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50 });
        const nombreArchivo = `factura_${Date.now()}.pdf`;
        const stream = fs.createWriteStream(nombreArchivo);

        doc.pipe(stream);

        // Enmascarar el número de tarjeta (XXXX-XXXX-XXXX-1234)
        const tarjetaEnmascarada = datos.numero_tarjeta.replace(/\d(?=\d{4})/g, "X");

        // Título
        doc.fontSize(18).text('Factura de Compra', { align: 'center', underline: true });
        doc.moveDown(1);

        // Información del cliente
        doc.fontSize(12);
        doc.text(`Cliente: ${datos.nombre}`);
        doc.text(`Número de tarjeta: ${tarjetaEnmascarada}`);
        doc.text(`Fecha: ${datos.fecha}`);
        doc.moveDown(1);

        // Dibujar tabla
        const startX = 50;
        let startY = doc.y; // Posición inicial de la tabla

        doc.fontSize(12).text('Detalles de la compra:', startX, startY);
        startY += 20;

        // Dibujar encabezados
        doc.rect(startX, startY, 500, 20).fill('#cccccc').stroke();
        doc.fillColor('black').text('Descripción', startX + 10, startY + 5);
        doc.text('Subtotal', startX + 250, startY + 5);
        doc.text('Impuestos', startX + 350, startY + 5);
        doc.text('Total', startX + 450, startY + 5);
        startY += 20;

        // Dibujar contenido
        doc.rect(startX, startY, 500, 20).stroke();
        doc.text(datos.descripcion, startX + 10, startY + 5);
        doc.text(`${datos.subtotal.toFixed(2)}`, startX + 250, startY + 5);
        doc.text(`${datos.impuestos.toFixed(2)}`, startX + 350, startY + 5);
        doc.text(`${datos.monto_total.toFixed(2)}`, startX + 450, startY + 5);
        startY += 30;

        doc.moveDown(2);
        doc.fontSize(12).text('Tixtly', { align: 'center', italic: true });

        doc.end();

        stream.on('finish', () => resolve(nombreArchivo));
        stream.on('error', reject);
    });
}

async function enviarCorreo(destinatario, archivo) {
    let transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: 'tixtly.eventos2025@gmail.com',
            pass: 'ubewpssdeagkedry'
        }
    });

    let mailOptions = {
        from: '"Tixtly - Confirmación de Pago" <tixtly.eventos2025@gmail.com>',
        to: destinatario,
        subject: 'Tu factura de compra - Tixtly',
        text: `Estimado cliente, 

Gracias por tu compra en Tixtly. Adjuntamos la factura correspondiente a tu transacción.

Detalles de la compra:
- Fecha: ${new Date().toLocaleDateString()}
- Archivo adjunto: Factura en formato PDF

Si tienes alguna duda o necesitas más información, no dudes en contactarnos.

Atentamente,
Tixtly`,

        attachments: [
            {
                filename: archivo,
                path: archivo
            }
        ]
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`Correo enviado a ${destinatario}`);
        fs.unlinkSync(archivo); // Eliminar el archivo después de enviarlo
    } catch (error) {
        console.error("Error al enviar el correo:", error);
    }
}


// Ruta para realizar un pago con tarjeta
router.post('/pago', async (req, res) => {
    const { numero_tarjeta, cvv, fecha_vencimiento, monto_total, nombre, marcaTarjeta, subtotal, impuestos, fecha, descripcion, Email } = req.body;
    console.log("Datos recibidos: ", req.body); 

    // Verificar que se envían todos los datos necesarios
    if (!numero_tarjeta || !cvv || !fecha_vencimiento || !monto_total || !nombre || !marcaTarjeta || !subtotal || !impuestos || !fecha || !descripcion || !Email) {
        return res.status(400).json({
            success: false,
            message: 'Faltan datos para procesar el pago.'
        });
    }

    try {
        const pool = await connection;
        
        // Buscar la tarjeta en la base de datos
        const query = 'SELECT marcaTarjeta, nombre, monto, fecha_vencimiento FROM tarjetas WHERE numero_tarjeta = @numero_tarjeta AND cvv = @cvv';
        const result = await pool.request()
            .input('numero_tarjeta', sql.VarChar, numero_tarjeta)
            .input('cvv', sql.VarChar, cvv)
            .query(query);
        
        // Verificar si la tarjeta existe
        if (result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Tarjeta no encontrada o datos incorrectos'
            });
        }

        let { monto: saldo_actual, fecha_vencimiento: fechaBD } = result.recordset[0];
        
        // Validar fecha de vencimiento
        const [mes, anio] = fechaBD.split('/').map(Number);
        const fechaActual = new Date();
        const mesActual = fechaActual.getMonth() + 1;
        const anioActual = fechaActual.getFullYear() % 100;
        
        if (anio < anioActual || (anio === anioActual && mes < mesActual)) {
            return res.status(400).json({
                success: false,
                message: 'La tarjeta ha vencido y no se puede procesar el pago'
            });
        }

        // Verificar si hay suficiente saldo
        if (saldo_actual < monto_total) {
            return res.status(400).json({
                success: false,
                message: 'Saldo insuficiente'
            });
        }

        // Restar el monto de la tarjeta
        const nuevo_saldo = saldo_actual - monto_total;
        const updateQuery = 'UPDATE tarjetas SET monto = @nuevo_saldo WHERE numero_tarjeta = @numero_tarjeta';
        await pool.request()
            .input('nuevo_saldo', sql.Money, nuevo_saldo)
            .input('numero_tarjeta', sql.VarChar, numero_tarjeta)
            .query(updateQuery);
        
        // Insertar la transacción en la tabla Transferencias
        const insertQuery = `
            INSERT INTO Transacciones (numero_tarjeta, monto_total, subtotal, impuestos, fecha, descripcion)
            VALUES (@numero_tarjeta, @monto_total, @subtotal, @impuestos, DATEADD(HOUR, -6, @fecha), @descripcion)`;
        await pool.request()
            .input('numero_tarjeta', sql.VarChar, numero_tarjeta)
            .input('monto_total', sql.Money, monto_total)
            .input('subtotal', sql.Money, subtotal)
            .input('impuestos', sql.Money, impuestos)
            .input('fecha', sql.DateTime, fecha)
            .input('descripcion', sql.VarChar, descripcion)
            .query(insertQuery);

         // Generar la factura en PDF
         const archivoPDF = await generarFactura({
            nombre,
            numero_tarjeta,
            fecha,
            descripcion,
            subtotal,
            impuestos,
            monto_total
        });

        // Enviar la factura al correo del cliente
        await enviarCorreo(Email, archivoPDF);

        // Responder con éxito
        return res.status(200).json({
            success: true,
            message: 'Pago realizado exitosamente',
            saldo_anterior: saldo_actual,
            saldo_actual: nuevo_saldo
        });
    } catch (err) {
        console.error('Error en la transacción:', err);
        return res.status(500).json({ success: false, message: 'Error interno del servidor' });
    }
});

module.exports = router;
