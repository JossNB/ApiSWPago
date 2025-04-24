// routes/conexion.js
const express     = require('express');
const router      = express.Router();
const connection  = require('../configdb');
const sql         = require('mssql');
const PDFDocument = require('pdfkit');
const fs          = require('fs');
const nodemailer  = require('nodemailer');
const QRCode      = require('qrcode');

/**
 * Genera un PDF de factura SIN QR.
 */
async function generarFactura(datos) {
  const doc = new PDFDocument({ margin: 50 });
  const nombreArchivo = `factura_${Date.now()}.pdf`;
  const stream = fs.createWriteStream(nombreArchivo);
  doc.pipe(stream);

  const tarjetaEnmascarada = datos.numero_tarjeta.replace(/\d(?=\d{4})/g, "X");
  doc.fontSize(18)
     .text('Factura de Compra', { align: 'center', underline: true })
     .moveDown();
  doc.fontSize(12)
     .text(`Cliente: ${datos.nombre}`)
     .text(`Tarjeta: ${tarjetaEnmascarada}`)
     .text(`Fecha de compra: ${datos.fechaCompra}`)
     .moveDown();

  const startX = 50;
  let startY = doc.y;
  doc.text('Detalles de la compra:', startX, startY);
  startY += 20;
  doc.rect(startX, startY, 500, 20).fill('#cccccc').stroke();
  doc.fillColor('black')
     .text('Descripción', startX + 10, startY + 5)
     .text('Subtotal',    startX + 250, startY + 5)
     .text('Impuestos',   startX + 350, startY + 5)
     .text('Total',       startX + 450, startY + 5);
  startY += 20;
  doc.rect(startX, startY, 500, 20).stroke();
  doc.text(datos.descripcion,            startX + 10,  startY + 5)
     .text(datos.subtotal.toFixed(2),    startX + 250, startY + 5)
     .text(datos.impuestos.toFixed(2),   startX + 350, startY + 5)
     .text(datos.monto_total.toFixed(2), startX + 450, startY + 5)
     .moveDown(2);

  doc.moveDown(4)
     .fontSize(12)
     .text('Tixtly', { align: 'center', italic: true });

  doc.end();
  await new Promise((r, e) => stream.on('finish', r).on('error', e));
  return nombreArchivo;
}

/**
 * Genera un PDF de ticket con diseño mejorado y fecha del evento.
 */
async function generarTicket(datos, index) {
  const WIDTH = 600, HEIGHT = 250;
  const doc = new PDFDocument({
    size: [WIDTH, HEIGHT],
    margins: { top: 0, left: 0, right: 0, bottom: 0 }
  });
  const nombreArchivo = `ticket_${Date.now()}_${index}.pdf`;
  const stream = fs.createWriteStream(nombreArchivo);
  doc.pipe(stream);

  // fondo y header
  doc.rect(0, 0, WIDTH, HEIGHT).fill('#000');
  doc.rect(0, 0, WIDTH, 50).fill('#adff44');
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(24)
     .text('TICKET', 30, 15);

  // línea de perforación
  const sepX = WIDTH * 0.65;
  for (let y = 60; y < HEIGHT - 60; y += 15) {
    doc.circle(sepX, y, 3).fill('#333');
  }

  // detalles
  doc.fillColor('#adff44').font('Helvetica-Bold').fontSize(18)
     .text(datos.descripcion.toUpperCase(), 30, 70, { width: sepX - 60 });
  doc.fillColor('#fff').font('Helvetica').fontSize(12)
     .text(`Cliente: ${datos.nombre}`, 30, 110)
     .text(`Fecha evento: ${datos.fechaEvento}`, 30, 130)
     .text(`Monto: ₡${datos.monto_total.toFixed(2)}`, 30, 150);

  // QR
  const qrSize = 120;
  const qrX = sepX + (WIDTH - sepX - qrSize) / 2;
  const qrY = 70;
  doc.roundedRect(qrX - 10, qrY - 10, qrSize + 20, qrSize + 20, 10)
     .fill('#fff');
  const qrBuffer = await QRCode.toBuffer(datos.qrText, { type: 'png', margin: 1 });
  doc.image(qrBuffer, qrX, qrY, { width: qrSize, height: qrSize });
  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(10)
     .text('Escanea aquí', qrX - 10, qrY + qrSize + 15, { width: qrSize + 20, align: 'center' });

  // pie con código y nº de ticket
  doc.fillColor('#adff44').font('Courier').fontSize(12)
     .text(`Código: ${datos.codigo}-${index}`, 30, HEIGHT - 40);

  doc.end();
  await new Promise((r, e) => stream.on('finish', r).on('error', e));
  return nombreArchivo;
}

/**
 * Envía correo con adjuntos y borra archivos.
 */
async function enviarCorreo(destinatario, archivos) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: 'tixtly.eventos2025@gmail.com', pass: 'ubewpssdeagkedry' }
  });
  const attachments = archivos.map(path => ({ filename: path, path }));
  await transporter.sendMail({
    from: '"Tixtly" <tixtly.eventos2025@gmail.com>',
    to: destinatario,
    subject: 'Factura y Tickets',
    text: 'Adjuntamos tu factura y tus tickets. ¡Gracias por tu compra!',
    attachments
  });
  archivos.forEach(f => fs.unlinkSync(f));
}

// POST /pago
router.post('/pago', async (req, res) => {
  const {
    numero_tarjeta, cvv, fecha_vencimiento,
    monto_total, nombre, subtotal,
    impuestos, fecha_compra, fecha_evento,
    descripcion, cantidad = 1, Email
  } = req.body;

  if (!numero_tarjeta||!cvv||!fecha_vencimiento||
      !monto_total||!nombre||!subtotal||
      !impuestos||!fecha_compra||!fecha_evento||
      !descripcion||!Email) {
    return res.status(400).json({ success:false, message:'Faltan datos.' });
  }

  try {
    const pool = await connection;
    const { recordset } = await pool.request()
      .input('numero_tarjeta', sql.VarChar, numero_tarjeta)
      .input('cvv', sql.VarChar, cvv)
      .query(`
        SELECT monto AS saldo_actual, fecha_vencimiento
        FROM tarjetas
        WHERE numero_tarjeta=@numero_tarjeta AND cvv=@cvv
      `);

    if (!recordset.length) {
      return res.status(404).json({ success:false, message:'Tarjeta no encontrada' });
    }

    let { saldo_actual, fecha_vencimiento: fechaBD } = recordset[0];
    const [mes, anio] = fechaBD.split('/').map(Number);
    const now = new Date();
    if (anio < now.getFullYear()%100 || (anio===now.getFullYear()%100 && mes<now.getMonth()+1)) {
      return res.status(400).json({ success:false, message:'Tarjeta vencida' });
    }
    if (saldo_actual < monto_total * cantidad) {
      return res.status(400).json({ success:false, message:'Saldo insuficiente' });
    }

    // actualizar saldo
    const nuevo_saldo = saldo_actual - monto_total * cantidad;
    await pool.request()
      .input('nuevo_saldo', sql.Money, nuevo_saldo)
      .input('numero_tarjeta', sql.VarChar, numero_tarjeta)
      .query(`UPDATE tarjetas SET monto=@nuevo_saldo WHERE numero_tarjeta=@numero_tarjeta`);

    // insertar transacción
    const codigo = `TX-${Date.now()}`;
    await pool.request()
      .input('numero_tarjeta', sql.VarChar, numero_tarjeta)
      .input('monto_total',    sql.Money, monto_total * cantidad)
      .input('subtotal',       sql.Money, subtotal * cantidad)
      .input('impuestos',      sql.Money, impuestos * cantidad)
      .input('fecha',          sql.DateTime, fecha_compra)
      .input('descripcion',    sql.VarChar, `${descripcion} x${cantidad}`)
      .input('codigo_qr',      sql.VarChar, codigo)
      .query(`
        INSERT INTO Transacciones
          (numero_tarjeta,monto_total,subtotal,impuestos,fecha,descripcion,codigo_qr)
        VALUES
          (@numero_tarjeta,@monto_total,@subtotal,@impuestos,
           DATEADD(HOUR,-6,@fecha),@descripcion,@codigo_qr)
      `);

    const host = `${req.protocol}://${req.get('host')}`;
    const qrUrl = `${host}/scan?code=${encodeURIComponent(codigo)}`;

    // generar documentos
    const facturaPDF = await generarFactura({
      nombre,
      numero_tarjeta,
      fechaCompra: fecha_compra,
      descripcion: `${descripcion} x${cantidad}`,
      subtotal: subtotal * cantidad,
      impuestos: impuestos * cantidad,
      monto_total: monto_total * cantidad
    });

    const tickets = [];
    for (let i = 1; i <= cantidad; i++) {
      tickets.push(await generarTicket({
        nombre,
        descripcion,
        monto_total,
        fechaEvento: fecha_evento,
        qrText: qrUrl,
        codigo
      }, i));
    }

    await enviarCorreo(Email, [facturaPDF, ...tickets]);

    res.json({
      success: true,
      message: `Pago OK, enviados ${cantidad} ticket(s).`,
      saldo_anterior: saldo_actual,
      saldo_actual: nuevo_saldo
    });
  } catch (err) {
    console.error('Error en /pago:', err);
    res.status(500).json({ success:false, message:'Error interno.', error: err.message });
  }
});

// GET /scan — solo una única vez
router.get('/scan', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send('Código QR inválido.');
  }

  try {
    const pool = await connection;
    const { recordset } = await pool.request()
      .input('codigo', sql.VarChar, code)
      .query(`SELECT escaneado FROM Transacciones WHERE codigo_qr = @codigo`);

    if (!recordset.length) {
      return res.status(404).send('Código no registrado.');
    }

    if (recordset[0].escaneado) {
      return res.send(`
        <h1>Ya se ha utilizado este código</h1>
        <p>Este ticket ya fue escaneado previamente.</p>
      `);
    }

    // marcar como escaneado
    await pool.request()
      .input('codigo', sql.VarChar, code)
      .query(`UPDATE Transacciones SET escaneado = 1 WHERE codigo_qr = @codigo`);

    res.send(`
      <h1>Escaneo exitoso</h1>
      <p>Gracias, tu ticket ha sido validado.</p>
    `);
  } catch (err) {
    console.error('Error en /scan:', err);
    res.status(500).send('Error interno al escanear.');
  }
});

module.exports = router;
