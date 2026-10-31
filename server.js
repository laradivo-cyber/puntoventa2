require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');


const app = express();
const PORT = Number(process.env.PORT) || 3000;
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
    console.warn('AVISO DE SEGURIDAD: configura SESSION_SECRET en el entorno de producción.');
}

// ============================================================
// BASE DE DATOS
// Pool permite varias consultas simultáneas y evita el problema
// de usar un único Client para todas las computadoras del POS.
// ============================================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('neon.tech')
        ? { rejectUnauthorized: false }
        : false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
});

pool.on('error', error => {
    console.error('ERROR EN POOL POSTGRES:', error.message);
});

app.use(express.json({ limit: '1mb' }));
if (process.env.CORS_ORIGIN) {
    const origins = process.env.CORS_ORIGIN.split(',').map(value => value.trim()).filter(Boolean);
    app.use(cors({ origin: origins }));
}
app.use(session({
    secret: process.env.SESSION_SECRET || 'clave-secreta-pos-cambiar-en-produccion',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 1000 * 60 * 60 * 12
    }
}));
app.use(express.static('public', { index: false }));

// ============================================================
// MIGRACIÓN COMPATIBLE CON LA BASE ACTUAL
// No borra datos. Solo agrega lo necesario si falta.
// ============================================================
async function prepararBaseDatos() {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        await client.query(`
            CREATE TABLE IF NOT EXISTS sesiones_pestana (
                id SERIAL PRIMARY KEY,
                token VARCHAR(128) UNIQUE NOT NULL,
                usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
                fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await client.query(`
            ALTER TABLE ventas
            ADD COLUMN IF NOT EXISTS usuario_id INTEGER
                REFERENCES usuarios(id) ON DELETE SET NULL
        `);

        await client.query(`
            ALTER TABLE ventas
            ADD COLUMN IF NOT EXISTS efectivo_recibido DECIMAL(12,2)
        `);

        await client.query(`
            ALTER TABLE ventas
            ADD COLUMN IF NOT EXISTS cambio DECIMAL(12,2)
        `);

        await client.query(`
            ALTER TABLE ventas
            ADD COLUMN IF NOT EXISTS estado VARCHAR(20)
                NOT NULL DEFAULT 'COMPLETADA'
        `);

        await client.query(`
            ALTER TABLE ventas
            ADD COLUMN IF NOT EXISTS corte_caja_id INTEGER
                REFERENCES cortes_caja(id) ON DELETE SET NULL
        `);

        // Módulos adicionales: compras, movimientos de caja y auditoría de anulaciones.
        await client.query(`
            CREATE TABLE IF NOT EXISTS compras (
                id BIGSERIAL PRIMARY KEY,
                proveedor_id INTEGER NOT NULL REFERENCES proveedores(id),
                usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
                fecha TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                total NUMERIC(12,2) NOT NULL CHECK (total >= 0),
                metodo_pago VARCHAR(1) NOT NULL CHECK (metodo_pago IN ('1','2','3'))
            )
        `);
        await client.query(`ALTER TABLE compras ADD COLUMN IF NOT EXISTS referencia VARCHAR(100)`);
        await client.query(`
            CREATE TABLE IF NOT EXISTS detalle_compras (
                id BIGSERIAL PRIMARY KEY,
                compra_id BIGINT NOT NULL REFERENCES compras(id) ON DELETE RESTRICT,
                producto_id INTEGER NOT NULL REFERENCES productos(id),
                cantidad INTEGER NOT NULL CHECK (cantidad > 0),
                costo_unitario NUMERIC(12,2) NOT NULL CHECK (costo_unitario >= 0),
                subtotal NUMERIC(12,2) NOT NULL CHECK (subtotal >= 0)
            )
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS movimientos_caja (
                id BIGSERIAL PRIMARY KEY,
                corte_caja_id INTEGER REFERENCES cortes_caja(id) ON DELETE SET NULL,
                usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
                fecha TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                tipo VARCHAR(10) NOT NULL CHECK (tipo IN ('ENTRADA','SALIDA')),
                categoria VARCHAR(30) NOT NULL DEFAULT 'OTRO',
                importe NUMERIC(12,2) NOT NULL CHECK (importe > 0),
                concepto TEXT NOT NULL,
                referencia_tipo VARCHAR(30),
                referencia_id BIGINT
            )
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS anulaciones_ventas (
                id BIGSERIAL PRIMARY KEY,
                venta_id INTEGER NOT NULL UNIQUE REFERENCES ventas(id) ON DELETE RESTRICT,
                usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
                fecha TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                motivo TEXT NOT NULL,
                importe NUMERIC(12,2) NOT NULL
            )
        `);
        await client.query('CREATE INDEX IF NOT EXISTS idx_compras_fecha ON compras(fecha)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_compras_proveedor ON compras(proveedor_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_movimientos_caja_fecha ON movimientos_caja(fecha)');

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_ventas_fecha
            ON ventas(fecha)
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_ventas_metodo
            ON ventas(metodo_pago)
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_ventas_usuario
            ON ventas(usuario_id)
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_ventas_corte
            ON ventas(corte_caja_id)
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_detalle_ventas_venta
            ON detalle_ventas(venta_id)
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_detalle_ventas_producto
            ON detalle_ventas(producto_id)
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_productos_codigo
            ON productos(codigo)
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_movimientos_producto_fecha
            ON movimientos(producto_id, fecha)
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_sesiones_token
            ON sesiones_pestana(token)
        `);

        // Trigger de stock: se crea solo si la instalación actual no lo tiene.
        await client.query(`
            CREATE OR REPLACE FUNCTION public.actualizar_stock()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $function$
            DECLARE
                stock_actual INTEGER;
            BEGIN
                SELECT stock INTO stock_actual
                FROM productos
                WHERE id = NEW.producto_id
                FOR UPDATE;

                IF NOT FOUND THEN
                    RAISE EXCEPTION 'Producto no encontrado: %', NEW.producto_id;
                END IF;

                IF NEW.tipo = 'SALIDA' THEN
                    IF stock_actual < NEW.cantidad THEN
                        RAISE EXCEPTION
                            'Stock insuficiente. Disponible: %, solicitado: %',
                            stock_actual, NEW.cantidad;
                    END IF;

                    UPDATE productos
                    SET stock = stock - NEW.cantidad
                    WHERE id = NEW.producto_id;

                ELSIF NEW.tipo = 'ENTRADA' THEN
                    UPDATE productos
                    SET stock = stock + NEW.cantidad
                    WHERE id = NEW.producto_id;
                END IF;

                RETURN NEW;
            END;
            $function$
        `);

        await client.query(`
            DROP TRIGGER IF EXISTS trigger_actualizar_stock
            ON movimientos
        `);

        await client.query(`
            CREATE TRIGGER trigger_actualizar_stock
            AFTER INSERT ON movimientos
            FOR EACH ROW
            EXECUTE FUNCTION public.actualizar_stock()
        `);

        // Ventas antiguas no tienen usuario/efectivo/cambio: se dejan NULL.
        // Las nuevas ventas sí los guardarán.
        await client.query('COMMIT');
        console.log('BASE DE DATOS PREPARADA');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

// ============================================================
// AUTENTICACIÓN
// ============================================================
async function obtenerUsuarioPorToken(token) {
    if (!token) return null;

    const resultado = await pool.query(`
        SELECT
            u.id,
            u.nombre,
            u.usuario,
            u.rol,
            u.admin_principal,
            u.activo
        FROM sesiones_pestana s
        JOIN usuarios u ON u.id = s.usuario_id
        WHERE s.token = $1
          AND u.activo = true
    `, [token]);

    return resultado.rows[0] || null;
}

async function requiereToken(req, res, next) {
    const token = req.headers['x-token-pestana'];

    if (!token) {
        return res.status(401).json({ error: 'Debes iniciar sesión' });
    }

    try {
        const usuario = await obtenerUsuarioPorToken(token);

        if (!usuario) {
            return res.status(401).json({ error: 'Sesión no válida' });
        }

        req.usuarioId = usuario.id;
        req.usuario = usuario.usuario;
        req.nombreUsuario = usuario.nombre;
        req.rol = usuario.rol;
        req.admin_principal = usuario.admin_principal === true;
        req.usuarioActual = usuario;

        next();
    } catch (error) {
        console.error('ERROR EN AUTENTICACIÓN:', error.message);
        res.status(500).json({ error: 'No se pudo comprobar la sesión' });
    }
}

async function soloAdmin(req, res, next) {
    await requiereToken(req, res, () => {
        if (req.rol !== 'Admin') {
            return res.status(403).json({
                error: 'No tienes permisos de administrador'
            });
        }
        next();
    });
}

async function soloAdminPrincipal(req, res, next) {
    await requiereToken(req, res, () => {
        if (req.rol !== 'Admin' || !req.admin_principal) {
            return res.status(403).json({
                error: 'Solo el Admin principal puede realizar esta acción'
            });
        }
        next();
    });
}

function requiereLogin(req, res, next) {
    if (!req.session.usuarioId) {
        return res.redirect('/login.html');
    }
    next();
}

// ============================================================
// LOGIN / SESIÓN
// ============================================================
const intentosLogin = new Map();
const VENTANA_LOGIN_MS = 15 * 60 * 1000;
const MAX_INTENTOS_LOGIN = 10;
setInterval(() => {
    const ahora = Date.now();
    for (const [clave, dato] of intentosLogin) if (ahora - dato.inicio > VENTANA_LOGIN_MS) intentosLogin.delete(clave);
}, 5 * 60 * 1000).unref();

app.post('/login', async (req, res) => {
    const usuario = String(req.body.usuario || '').trim();
    const password = String(req.body.password || '');
    const claveIntentos = `${req.ip || req.socket.remoteAddress || 'desconocida'}:${usuario.toLowerCase()}`;
    const ahoraIntentos = Date.now();
    let datoIntentos = intentosLogin.get(claveIntentos);
    if (!datoIntentos || ahoraIntentos - datoIntentos.inicio > VENTANA_LOGIN_MS) {
        datoIntentos = { inicio: ahoraIntentos, cantidad: 0 };
        intentosLogin.set(claveIntentos, datoIntentos);
    }
    if (datoIntentos.cantidad >= MAX_INTENTOS_LOGIN) {
        return res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos antes de volver a intentarlo.' });
    }

    if (!usuario || !password) {
        return res.status(400).json({
            error: 'Usuario y contraseña son obligatorios'
        });
    }

    try {
        const resultado = await pool.query(`
            SELECT *
            FROM usuarios
            WHERE usuario = $1
              AND activo = true
            LIMIT 1
        `, [usuario]);

        if (resultado.rows.length === 0) {
            datoIntentos.cantidad++;
            return res.status(401).json({
                error: 'Usuario o contraseña incorrectos'
            });
        }

        const usuarioDB = resultado.rows[0];
        const correcta = await bcrypt.compare(password, usuarioDB.password);

        if (!correcta) {
            datoIntentos.cantidad++;
            return res.status(401).json({
                error: 'Usuario o contraseña incorrectos'
            });
        }

        intentosLogin.delete(claveIntentos);
        const tokenPestana = crypto.randomBytes(32).toString('hex');

        await pool.query(`
            INSERT INTO sesiones_pestana (token, usuario_id)
            VALUES ($1, $2)
        `, [tokenPestana, usuarioDB.id]);

        req.session.usuarioId = usuarioDB.id;
        req.session.usuario = usuarioDB.usuario;
        req.session.rol = usuarioDB.rol;

        res.json({
            acceso: true,
            usuario: usuarioDB.usuario,
            rol: usuarioDB.rol,
            tokenPestana
        });
    } catch (error) {
        console.error('ERROR EN LOGIN:', error.message);
        res.status(500).json({ error: 'No se pudo iniciar sesión' });
    }
});

app.get('/sesion', async (req, res) => {
    const token = req.headers['x-token-pestana'];

    try {
        const usuario = await obtenerUsuarioPorToken(token);

        if (!usuario) {
            return res.status(401).json({ error: 'Sesión no válida' });
        }

        res.json({
            usuario: usuario.usuario,
            nombre: usuario.nombre,
            rol: usuario.rol,
            admin_principal: usuario.admin_principal
        });
    } catch (error) {
        console.error('ERROR EN SESION:', error.message);
        res.status(500).json({ error: 'No se pudo comprobar la sesión' });
    }
});

app.post('/logout', async (req, res) => {
    const token = req.headers['x-token-pestana'];

    try {
        if (token) {
            await pool.query(
                'DELETE FROM sesiones_pestana WHERE token = $1',
                [token]
            );
        }

        req.session.destroy(error => {
            if (error) {
                return res.status(500).json({
                    error: 'No se pudo cerrar la sesión'
                });
            }

            res.json({ mensaje: 'Sesión cerrada' });
        });
    } catch (error) {
        console.error('ERROR AL CERRAR SESIÓN:', error.message);
        res.status(500).json({ error: 'No se pudo cerrar la sesión' });
    }
});

app.post('/cambiar-password', requiereLogin, async (req, res) => {
    const { passwordActual, passwordNueva } = req.body;

    if (!passwordActual || !passwordNueva) {
        return res.status(400).json({ error: 'Completa todos los campos' });
    }

    if (String(passwordNueva).length < 8) {
        return res.status(400).json({
            error: 'La nueva contraseña debe tener al menos 8 caracteres'
        });
    }

    try {
        const resultado = await pool.query(
            'SELECT password FROM usuarios WHERE id = $1',
            [req.session.usuarioId]
        );

        if (!resultado.rows.length) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        const correcta = await bcrypt.compare(
            passwordActual,
            resultado.rows[0].password
        );

        if (!correcta) {
            return res.status(401).json({
                error: 'Contraseña actual incorrecta'
            });
        }

        const nuevoHash = await bcrypt.hash(passwordNueva, 10);
        await pool.query(
            'UPDATE usuarios SET password = $1 WHERE id = $2',
            [nuevoHash, req.session.usuarioId]
        );

        res.json({ mensaje: 'Contraseña cambiada correctamente' });
    } catch (error) {
        console.error('ERROR AL CAMBIAR PASSWORD:', error.message);
        res.status(500).json({ error: 'No se pudo cambiar la contraseña' });
    }
});

// ============================================================
// INICIO
// ============================================================
app.get('/', requiereLogin, (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// ============================================================
// PRODUCTOS
// ============================================================
// ================= IMPORTACION_MASIVA_PRODUCTOS_V1 =================
// Plantilla XLSX + validación previa + alta/actualización en bloque.
const uploadImportacionProductos = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
        if (String(file.originalname || '').toLowerCase().endsWith('.xlsx')) return cb(null, true);
        cb(new Error('Selecciona un archivo Excel .xlsx'));
    }
});

app.get('/productos/plantilla-importacion', soloAdmin, async (req, res) => {
    try {
        const wb = new ExcelJS.Workbook();
        wb.creator = 'PuntoVenta2';
        const ws = wb.addWorksheet('Productos', { views: [{ state: 'frozen', ySplit: 1 }] });
        const columnas = [
            { header: 'codigo', key: 'codigo', width: 22 }, { header: 'nombre', key: 'nombre', width: 32 },
            { header: 'marca', key: 'marca', width: 20 }, { header: 'categoria', key: 'categoria', width: 22 },
            { header: 'descripcion', key: 'descripcion', width: 34 }, { header: 'ubicacion', key: 'ubicacion', width: 18 },
            { header: 'precio_compra', key: 'precio_compra', width: 18 }, { header: 'precio_venta', key: 'precio_venta', width: 18 },
            { header: 'stock', key: 'stock', width: 12 }, { header: 'stock_minimo', key: 'stock_minimo', width: 16 }
        ];
        ws.columns = columnas;
        ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF243447' } };
        ws.getRow(1).height = 25;
        ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columnas.length } };
        ws.getColumn('codigo').numFmt = '@';
        ['precio_compra', 'precio_venta'].forEach(k => { ws.getColumn(k).numFmt = '$#,##0.00'; });
        ['stock', 'stock_minimo'].forEach(k => { ws.getColumn(k).numFmt = '0'; });
        const instrucciones = wb.addWorksheet('Instrucciones');
        instrucciones.columns = [{ width: 36 }, { width: 100 }];
        instrucciones.addRows([
            ['Campo', 'Instrucción'],
            ['codigo', 'Obligatorio y único. Código de barras o código interno. La columna está preparada como texto.'],
            ['nombre', 'Obligatorio. Nombre del producto.'],
            ['marca / categoria / descripcion / ubicacion', 'Opcionales; puedes dejarlos vacíos.'],
            ['precio_compra / precio_venta', 'Importes en pesos mexicanos (MXN), como números. No escribas el signo $. Ambos son obligatorios.'],
            ['stock', 'Existencia inicial para productos nuevos. En modo actualización se ignora para proteger el stock actual.'],
            ['stock_minimo', 'Número entero igual o mayor que cero. Si se deja vacío, se usa 0.'],
            ['Importante', 'No cambies los encabezados de la primera fila. Máximo 2.000 filas por archivo. Revisa siempre la vista previa.']
        ]);
        instrucciones.getRow(1).font = { bold: true };
        instrucciones.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDE7F0' } };
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="plantilla_productos_puntoventa2.xlsx"');
        await wb.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error('ERROR PLANTILLA IMPORTACION:', error.message);
        if (!res.headersSent) res.status(500).json({ error: 'No se pudo generar la plantilla' });
        else res.end();
    }
});

function normalizarEncabezadoImportacion(valor) {
    return String(valor ?? '').trim().toLowerCase().normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
function textoCeldaImportacion(celda) {
    if (!celda || celda.value == null) return '';
    if (typeof celda.value === 'object' && celda.value.richText) return celda.value.richText.map(x => x.text || '').join('').trim();
    if (typeof celda.value === 'object' && celda.value.text != null) return String(celda.value.text).trim();
    return String(celda.text ?? celda.value).trim();
}
function numeroCeldaImportacion(valor, campo, fila, errores, entero = false, obligatorio = false) {
    if (valor == null || String(valor).trim() === '') {
        if (obligatorio) errores.push(`Fila ${fila}: falta ${campo}`);
        return obligatorio ? NaN : 0;
    }
    let numero = valor;
    if (typeof numero !== 'number') numero = Number(String(numero).replace(/\s/g, '').replace(/\$/g, '').replace(/MXN/gi, '').replace(/,/g, ''));
    if (!Number.isFinite(numero) || numero < 0 || (entero && !Number.isInteger(numero))) {
        errores.push(`Fila ${fila}: ${campo} debe ser ${entero ? 'un entero' : 'un número'} igual o mayor que cero`);
        return NaN;
    }
    return numero;
}
async function leerArchivoImportacionProductos(buffer) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.getWorksheet('Productos') || wb.worksheets[0];
    if (!ws || ws.rowCount < 2) throw new Error('El Excel debe tener encabezados y al menos un producto.');
    if (ws.rowCount - 1 > 2000) throw new Error('El archivo supera el máximo de 2.000 filas de productos.');
    const aliases = {
        codigo: 'codigo', codigo_de_barras: 'codigo', codigo_barras: 'codigo', barcode: 'codigo', codigo_interno: 'codigo',
        nombre: 'nombre', producto: 'nombre', nombre_del_producto: 'nombre', marca: 'marca', categoria: 'categoria',
        descripcion: 'descripcion', ubicacion: 'ubicacion', precio_compra: 'precio_compra', costo: 'precio_compra',
        costo_compra: 'precio_compra', precio_de_compra: 'precio_compra', precio_venta: 'precio_venta',
        precio_de_venta: 'precio_venta', stock: 'stock', existencias: 'stock', cantidad: 'stock',
        stock_minimo: 'stock_minimo', minimo: 'stock_minimo'
    };
    const mapa = {};
    ws.getRow(1).eachCell({ includeEmpty: true }, (celda, col) => {
        const key = aliases[normalizarEncabezadoImportacion(textoCeldaImportacion(celda))];
        if (key) mapa[key] = col;
    });
    for (const key of ['codigo', 'nombre', 'precio_compra', 'precio_venta']) {
        if (!mapa[key]) throw new Error(`Falta el encabezado obligatorio: ${key}`);
    }
    const filas = [];
    for (let n = 2; n <= ws.rowCount; n++) {
        const row = ws.getRow(n);
        const valor = key => mapa[key] ? row.getCell(mapa[key]).value : '';
        const t = {};
        for (const key of ['codigo', 'nombre', 'marca', 'categoria', 'descripcion', 'ubicacion']) t[key] = mapa[key] ? textoCeldaImportacion(row.getCell(mapa[key])) : '';
        if (!Object.values(t).some(Boolean) && ['precio_compra', 'precio_venta', 'stock', 'stock_minimo'].every(k => !String(valor(k) ?? '').trim())) continue;
        const errores = [];
        if (!t.codigo) errores.push(`Fila ${n}: falta codigo`);
        if (!t.nombre) errores.push(`Fila ${n}: falta nombre`);
        const precio_compra = numeroCeldaImportacion(valor('precio_compra'), 'precio_compra', n, errores, false, true);
        const precio_venta = numeroCeldaImportacion(valor('precio_venta'), 'precio_venta', n, errores, false, true);
        const stock = numeroCeldaImportacion(valor('stock'), 'stock', n, errores, true, false);
        const stock_minimo = numeroCeldaImportacion(valor('stock_minimo'), 'stock_minimo', n, errores, true, false);
        filas.push({ fila: n, codigo: t.codigo, nombre: t.nombre, marca: t.marca, categoria: t.categoria,
            descripcion: t.descripcion, ubicacion: t.ubicacion, precio_compra, precio_venta, stock, stock_minimo, errores });
    }
    if (!filas.length) throw new Error('No encontré productos debajo de los encabezados.');
    const conteo = new Map();
    filas.forEach(f => { const k = f.codigo.toLowerCase(); if (k) conteo.set(k, (conteo.get(k) || 0) + 1); });
    filas.forEach(f => { if (f.codigo && conteo.get(f.codigo.toLowerCase()) > 1) f.errores.push(`Fila ${f.fila}: el código aparece repetido dentro del archivo`); });
    return filas;
}

app.post('/productos/importacion-masiva', soloAdmin, (req, res, next) => {
    uploadImportacionProductos.single('archivo')(req, res, error => {
        if (error) return res.status(400).json({ error: error.message || 'No se pudo leer el archivo' });
        next();
    });
}, async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Selecciona un archivo .xlsx' });
    const modo = String(req.query.modo || 'validar');
    const operacion = String(req.query.operacion || 'crear');
    if (!['validar', 'importar'].includes(modo) || !['crear', 'actualizar'].includes(operacion)) return res.status(400).json({ error: 'Modo u operación no válidos' });
    let client;
    try {
        const filas = await leerArchivoImportacionProductos(req.file.buffer);
        const codigos = [...new Set(filas.filter(f => f.codigo).map(f => f.codigo.toLowerCase()))];
        const encontrados = codigos.length ? await pool.query('SELECT id, codigo FROM productos WHERE LOWER(codigo) = ANY($1::text[])', [codigos]) : { rows: [] };
        const existentes = new Map(encontrados.rows.map(p => [String(p.codigo).toLowerCase(), p]));
        const resumen = { nuevos: 0, actualizables: 0, omitidos: 0, errores: 0 };
        for (const f of filas) {
            f.idExistente = existentes.get(f.codigo.toLowerCase())?.id || null;
            if (f.errores.length) { f.estado = 'ERROR'; resumen.errores++; }
            else if (operacion === 'crear' && f.idExistente) { f.estado = 'OMITIR: ya existe'; resumen.omitidos++; }
            else if (operacion === 'crear') { f.estado = 'NUEVO'; resumen.nuevos++; }
            else if (f.idExistente) { f.estado = 'ACTUALIZAR (stock protegido)'; resumen.actualizables++; }
            else { f.estado = 'OMITIR: no existe'; resumen.omitidos++; }
        }
        if (modo === 'validar') return res.json({ resumen, filas: filas.map(f => ({ fila: f.fila, codigo: f.codigo, nombre: f.nombre,
            precio_compra: f.precio_compra, precio_venta: f.precio_venta, stock: f.stock, estado: f.estado, errores: f.errores })) });

        client = await pool.connect();
        await client.query('BEGIN');
        let importados = 0, actualizados = 0, omitidos = 0;
        const erroresFinales = [];
        for (const f of filas) {
            if (f.errores.length) { erroresFinales.push({ fila: f.fila, errores: f.errores }); continue; }
            if (operacion === 'crear') {
                if (f.idExistente) { omitidos++; continue; }
                const insertado = await client.query(`INSERT INTO productos
                    (codigo,nombre,marca,categoria,descripcion,ubicacion,precio_compra,precio_venta,stock_minimo,stock)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0) RETURNING id`,
                    [f.codigo, f.nombre, f.marca, f.categoria, f.descripcion, f.ubicacion, f.precio_compra, f.precio_venta, f.stock_minimo]);
                if (f.stock > 0) await client.query(`INSERT INTO movimientos (producto_id,tipo,cantidad,motivo)
                    VALUES ($1,'ENTRADA',$2,$3)`, [insertado.rows[0].id, f.stock, 'Stock inicial por importación masiva']);
                importados++;
            } else {
                if (!f.idExistente) { omitidos++; continue; }
                await client.query(`UPDATE productos SET nombre=$1,marca=$2,categoria=$3,descripcion=$4,ubicacion=$5,
                    precio_compra=$6,precio_venta=$7,stock_minimo=$8 WHERE id=$9`,
                    [f.nombre, f.marca, f.categoria, f.descripcion, f.ubicacion, f.precio_compra, f.precio_venta, f.stock_minimo, f.idExistente]);
                actualizados++;
            }
        }
        await client.query('COMMIT');
        return res.json({ mensaje: 'Importación procesada', importados, actualizados, omitidos, errores: erroresFinales.length, detalleErrores: erroresFinales.slice(0, 100) });
    } catch (error) {
        if (client) { try { await client.query('ROLLBACK'); } catch (_) {} }
        console.error('ERROR IMPORTACION MASIVA PRODUCTOS:', error.message);
        return res.status(400).json({ error: error.message || 'No se pudo procesar la importación' });
    } finally { if (client) client.release(); }
});
// ================= FIN IMPORTACION_MASIVA_PRODUCTOS_V1 =================

app.get('/productos', requiereToken, async (req, res) => {
    try {
        const resultado = await pool.query(`
            SELECT *
            FROM productos
            WHERE activo = true
            ORDER BY id
        `);
        res.json(resultado.rows);
    } catch (error) {
        console.error('ERROR AL OBTENER PRODUCTOS:', error.message);
        res.status(500).json({ error: 'Error al obtener productos' });
    }
});

app.post('/productos', soloAdmin, async (req, res) => {
    const {
        codigo,
        nombre,
        marca,
        categoria,
        descripcion,
        ubicacion,
        precio_compra,
        precio_venta,
        stock,
        stock_minimo
    } = req.body;

    if (!String(codigo || '').trim() || !String(nombre || '').trim()) {
        return res.status(400).json({
            error: 'Código y nombre son obligatorios'
        });
    }

    const compra = Number(precio_compra);
    const venta = Number(precio_venta);
    const stockInicial = Number(stock || 0);
    const stockMinimo = Number(stock_minimo || 0);

    if (![compra, venta, stockInicial, stockMinimo].every(Number.isFinite) ||
        compra < 0 || venta < 0 || stockInicial < 0 || stockMinimo < 0) {
        return res.status(400).json({ error: 'Los valores numéricos no son válidos' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const resultado = await client.query(`
            INSERT INTO productos
                (codigo, nombre, marca, categoria, descripcion, ubicacion, precio_compra, precio_venta, stock_minimo, stock)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0)
            RETURNING *
        `, [
            String(codigo).trim(), String(nombre).trim(), String(marca || '').trim(),
            String(categoria || '').trim(), String(descripcion || '').trim(), String(ubicacion || '').trim(),
            compra, venta, stockMinimo
        ]);

        const producto = resultado.rows[0];

        if (stockInicial > 0) {
            await client.query(`
                INSERT INTO movimientos
                    (producto_id, tipo, cantidad, motivo)
                VALUES ($1, 'ENTRADA', $2, $3)
            `, [producto.id, stockInicial, 'Stock inicial']);
        }

        await client.query('COMMIT');
        res.json(producto);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('ERROR AL AGREGAR PRODUCTO:', error.message);
        res.status(error.code === '23505' ? 400 : 500).json({
            error: error.code === '23505'
                ? 'El código del producto ya existe'
                : 'No se pudo agregar el producto'
        });
    } finally {
        client.release();
    }
});

app.put('/productos/:id', soloAdmin, async (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({
            error: 'ID de producto inválido'
        });
    }

    const codigo = String(req.body.codigo || '').trim();
    const nombre = String(req.body.nombre || '').trim();
    const marca = String(req.body.marca || '').trim();
    const categoria = String(req.body.categoria || '').trim();
    const descripcion = String(req.body.descripcion || '').trim();
    const precioCompra = Number(req.body.precio_compra);
    const precioVenta = Number(req.body.precio_venta);
    const stockMinimo = Number(req.body.stock_minimo);
    const ubicacion = String(req.body.ubicacion || '').trim();

    if (
        !codigo ||
        !nombre ||
        !Number.isFinite(precioCompra) ||
        !Number.isFinite(precioVenta) ||
        !Number.isFinite(stockMinimo) ||
        precioCompra < 0 ||
        precioVenta < 0 ||
        stockMinimo < 0
    ) {
        return res.status(400).json({
            error: 'Datos de producto inválidos'
        });
    }

    try {

        const resultado = await pool.query(`
            UPDATE productos
            SET codigo = $1,
                nombre = $2,
                marca = $3,
                categoria = $4,
                descripcion = $5,
                precio_compra = $6,
                precio_venta = $7,
                stock_minimo = $8,
                ubicacion = $9
            WHERE id = $10
            RETURNING *
        `, [
            codigo,
            nombre,
            marca,
            categoria,
            descripcion,
            precioCompra,
            precioVenta,
            stockMinimo,
            ubicacion,
            id
        ]);

        if (!resultado.rows.length) {
            return res.status(404).json({
                error: 'Producto no encontrado'
            });
        }

        res.json(resultado.rows[0]);

    } catch (error) {

        console.error(
            'ERROR AL EDITAR PRODUCTO:',
            error.message
        );

        res.status(500).json({
            error: 'No se pudo actualizar el producto'
        });
    }
});

app.delete('/productos/:id', soloAdmin, async (req, res) => {
    const id = Number(req.params.id);

    try {
        const resultado = await pool.query(`
            UPDATE productos
            SET activo = false
            WHERE id = $1
            RETURNING id
        `, [id]);

        if (!resultado.rows.length) {
            return res.status(404).json({ error: 'Producto no encontrado' });
        }

        res.json({ mensaje: 'Producto eliminado correctamente' });
    } catch (error) {
        console.error('ERROR AL ELIMINAR PRODUCTO:', error.message);
        res.status(500).json({ error: 'No se pudo eliminar el producto' });
    }
});
// ========================================
// PROVEEDORES
// ========================================

app.get('/proveedores', requiereToken, async (req, res) => {

    try {

        const resultado = await pool.query(`
            SELECT *
            FROM proveedores
            WHERE activo = TRUE
            ORDER BY nombre ASC
        `);

        res.json(resultado.rows);

    } catch (error) {

        console.error(
            'ERROR AL OBTENER PROVEEDORES:',
            error.message
        );

        res.status(500).json({
            error: 'No se pudieron obtener los proveedores'
        });

    }

});


app.post('/proveedores', soloAdmin, async (req, res) => {

    const {
        nombre,
        empresa,
        telefono,
        correo,
        direccion,
        notas
    } = req.body;

    if (!nombre || !nombre.trim()) {

        return res.status(400).json({
            error: 'El nombre del proveedor es obligatorio'
        });

    }

    try {

        const resultado = await pool.query(`
            INSERT INTO proveedores
                (
                    nombre,
                    empresa,
                    telefono,
                    correo,
                    direccion,
                    notas
                )
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
        `, [
            nombre.trim(),
            empresa || null,
            telefono || null,
            correo || null,
            direccion || null,
            notas || null
        ]);

        res.json({
            mensaje: 'Proveedor registrado correctamente',
            proveedor: resultado.rows[0]
        });

    } catch (error) {

        console.error(
            'ERROR AL REGISTRAR PROVEEDOR:',
            error.message
        );

        res.status(500).json({
            error: 'No se pudo registrar el proveedor'
        });

    }

});


app.put('/proveedores/:id', soloAdmin, async (req, res) => {

    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {

        return res.status(400).json({
            error: 'ID de proveedor no válido'
        });

    }

    const {
        nombre,
        empresa,
        telefono,
        correo,
        direccion,
        notas
    } = req.body;

    if (!nombre || !nombre.trim()) {

        return res.status(400).json({
            error: 'El nombre del proveedor es obligatorio'
        });

    }

    try {

        const resultado = await pool.query(`
            UPDATE proveedores
            SET
                nombre = $1,
                empresa = $2,
                telefono = $3,
                correo = $4,
                direccion = $5,
                notas = $6
            WHERE id = $7
              AND activo = TRUE
            RETURNING *
        `, [
            nombre.trim(),
            empresa || null,
            telefono || null,
            correo || null,
            direccion || null,
            notas || null,
            id
        ]);

        if (!resultado.rows.length) {

            return res.status(404).json({
                error: 'Proveedor no encontrado'
            });

        }

        res.json({
            mensaje: 'Proveedor actualizado correctamente',
            proveedor: resultado.rows[0]
        });

    } catch (error) {

        console.error(
            'ERROR AL ACTUALIZAR PROVEEDOR:',
            error.message
        );

        res.status(500).json({
            error: 'No se pudo actualizar el proveedor'
        });

    }

});


app.delete('/proveedores/:id', soloAdmin, async (req, res) => {

    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {

        return res.status(400).json({
            error: 'ID de proveedor no válido'
        });

    }

    try {

        const resultado = await pool.query(`
            UPDATE proveedores
            SET activo = FALSE
            WHERE id = $1
              AND activo = TRUE
            RETURNING id
        `, [id]);

        if (!resultado.rows.length) {

            return res.status(404).json({
                error: 'Proveedor no encontrado'
            });

        }

        res.json({
            mensaje: 'Proveedor eliminado correctamente'
        });

    } catch (error) {

        console.error(
            'ERROR AL ELIMINAR PROVEEDOR:',
            error.message
        );

        res.status(500).json({
            error: 'No se pudo eliminar el proveedor'
        });

    }

});
// ============================================================
// MOVIMIENTOS / INVENTARIO
// ============================================================
app.get('/movimientos', requiereToken, async (req, res) => {
    try {
        const resultado = await pool.query(`
            SELECT
                m.id,
                m.fecha,
                p.codigo,
                p.nombre,
                m.tipo,
                m.cantidad,
                m.motivo
            FROM movimientos m
            JOIN productos p ON p.id = m.producto_id
            ORDER BY m.fecha DESC, m.id DESC
        `);
        res.json(resultado.rows);
    } catch (error) {
        console.error('ERROR AL OBTENER MOVIMIENTOS:', error.message);
        res.status(500).json({ error: 'No se pudieron obtener los movimientos' });
    }
});

app.post('/movimientos/entrada', requiereToken, async (req, res) => {
    const productoId = Number(req.body.producto_id);
    const cantidad = Number(req.body.cantidad);
    const motivo = String(req.body.motivo || 'Entrada de mercancía').trim();

    if (!Number.isInteger(productoId) || productoId <= 0 ||
        !Number.isInteger(cantidad) || cantidad <= 0) {
        return res.status(400).json({
            error: 'Producto y cantidad válidos son obligatorios'
        });
    }

    try {
        const producto = await pool.query(
            'SELECT id FROM productos WHERE id = $1 AND activo = true',
            [productoId]
        );

        if (!producto.rows.length) {
            return res.status(404).json({ error: 'Producto no encontrado' });
        }

        const resultado = await pool.query(`
            INSERT INTO movimientos
                (producto_id, tipo, cantidad, motivo)
            VALUES ($1, 'ENTRADA', $2, $3)
            RETURNING *
        `, [productoId, cantidad, motivo || 'Entrada de mercancía']);

        res.json({
            mensaje: 'Entrada registrada correctamente',
            movimiento: resultado.rows[0]
        });
    } catch (error) {
        console.error('ERROR EN ENTRADA:', error.message);
        res.status(500).json({ error: 'No se pudo registrar la entrada' });
    }
});

app.post('/inventario-valor', soloAdminPrincipal, async (req, res) => {
    try {
        const resultado = await pool.query(`
            SELECT
                COALESCE(SUM(stock * precio_compra), 0) AS inventario_costo,
                COALESCE(SUM(stock * precio_venta), 0) AS inventario_venta,
                COALESCE(SUM(stock * (precio_venta - precio_compra)), 0) AS utilidad_potencial
            FROM productos
            WHERE activo = true
        `);
        res.json(resultado.rows[0]);
    } catch (error) {
        console.error('ERROR AL OBTENER VALOR INVENTARIO:', error.message);
        res.status(500).json({ error: 'No se pudo obtener el valor del inventario' });
    }
});

// ============================================================
// VENTAS - TRANSACCIÓN REAL Y SEGURA
// ============================================================
app.post('/ventas', requiereToken, async (req, res) => {
    const carrito = Array.isArray(req.body.carrito) ? req.body.carrito : [];
    const metodoPago = String(req.body.metodo_pago || '');
    const efectivoRecibidoRaw = req.body.efectivo_recibido;
    const efectivoRecibido = efectivoRecibidoRaw === null || efectivoRecibidoRaw === undefined || efectivoRecibidoRaw === ''
        ? null
        : Number(efectivoRecibidoRaw);

    if (!carrito.length) {
        return res.status(400).json({ error: 'La venta está vacía' });
    }

    if (!['1', '2', '3'].includes(metodoPago)) {
        return res.status(400).json({ error: 'Método de pago inválido' });
    }

    if (metodoPago === '1' &&
        (efectivoRecibido === null || !Number.isFinite(efectivoRecibido) || efectivoRecibido < 0)) {
        return res.status(400).json({ error: 'El efectivo recibido no es válido' });
    }

    // Agrupar IDs repetidos y validar cantidades enteras.
    const cantidades = new Map();
    for (const item of carrito) {
        const id = Number(item.id);
        const cantidad = Number(item.cantidad);

        if (!Number.isInteger(id) || id <= 0 ||
            !Number.isInteger(cantidad) || cantidad <= 0) {
            return res.status(400).json({ error: 'El carrito contiene datos inválidos' });
        }

        cantidades.set(id, (cantidades.get(id) || 0) + cantidad);
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        const cajaResult = await client.query(`
    SELECT id
    FROM cortes_caja
    WHERE estado = 'ABIERTA'
    ORDER BY id DESC
    LIMIT 1
    FOR UPDATE
`);

if (!cajaResult.rows.length) {
    throw new Error('No se puede realizar la venta: la caja está cerrada');
}

const corteCajaId = cajaResult.rows[0].id;

        const ids = [...cantidades.keys()];
        const placeholders = ids.map((_, index) => `$${index + 1}`).join(',');

        const productosResult = await client.query(`
            SELECT id, codigo, nombre, precio_venta, precio_compra, stock
            FROM productos
            WHERE id IN (${placeholders})
              AND activo = true
            FOR UPDATE
        `, ids);

        if (productosResult.rows.length !== ids.length) {
            throw new Error('Uno o más productos ya no están disponibles');
        }

        const productos = new Map(
            productosResult.rows.map(producto => [Number(producto.id), producto])
        );

        let total = 0;
        for (const id of ids) {
            const producto = productos.get(id);
            const cantidad = cantidades.get(id);

            if (Number(producto.stock) < cantidad) {
                throw new Error(
                    `Stock insuficiente para ${producto.nombre}. Disponible: ${producto.stock}, solicitado: ${cantidad}`
                );
            }

            total += Number(producto.precio_venta) * cantidad;
        }

        total = Number(total.toFixed(2));

        if (metodoPago === '1' && efectivoRecibido < total) {
            throw new Error('El efectivo recibido no cubre el total');
        }

        const cambio = metodoPago === '1'
            ? Number((efectivoRecibido - total).toFixed(2))
            : null;

        const ventaResult = await client.query(`
            INSERT INTO ventas
                (total, metodo_pago, usuario_id, efectivo_recibido, cambio, estado, corte_caja_id)
            VALUES ($1, $2, $3, $4, $5, 'COMPLETADA', $6)
            RETURNING id, fecha, total, metodo_pago, usuario_id,
                      efectivo_recibido, cambio, estado, corte_caja_id
        `, [
            total,
            metodoPago,
            req.usuarioId,
            metodoPago === '1' ? efectivoRecibido : null,
            cambio,
            corteCajaId
        ]);

        const venta = ventaResult.rows[0];

        for (const id of ids) {
            const producto = productos.get(id);
            const cantidad = cantidades.get(id);

            await client.query(`
                INSERT INTO detalle_ventas
                    (venta_id, producto_id, cantidad, precio, precio_compra)
                VALUES ($1, $2, $3, $4, $5)
            `, [
                venta.id,
                id,
                cantidad,
                producto.precio_venta,
                producto.precio_compra
            ]);

            // El trigger descuenta el stock y valida que no quede negativo.
            await client.query(`
                INSERT INTO movimientos
                    (producto_id, tipo, cantidad, motivo)
                VALUES ($1, 'SALIDA', $2, $3)
            `, [id, cantidad, `Venta #${venta.id}`]);
        }

        await client.query('COMMIT');

        res.json({
            mensaje: 'Venta registrada correctamente',
            venta: {
                ...venta,
                total: Number(venta.total),
                efectivo_recibido: venta.efectivo_recibido === null ? null : Number(venta.efectivo_recibido),
                cambio: venta.cambio === null ? null : Number(venta.cambio)
            }
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('ERROR AL REGISTRAR VENTA:', error.message);
        res.status(400).json({ error: error.message });
    } finally {
        client.release();
    }
});

app.get('/ventas', requiereToken, async (req, res) => {
    try {
        const condiciones = [];
        const valores = [];

        if (!(req.rol === 'Admin' && req.admin_principal)) {
            condiciones.push('v.fecha::date = CURRENT_DATE');
        }

        const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';

        const resultado = await pool.query(`
            SELECT
                v.id,
                v.fecha,
                v.total,
                v.metodo_pago,
                v.usuario_id,
                v.efectivo_recibido,
                v.cambio,
                v.estado
            FROM ventas v
            ${where}
            ORDER BY v.id DESC
        `, valores);

        res.json(resultado.rows);
    } catch (error) {
        console.error('ERROR AL OBTENER VENTAS:', error.message);
        res.status(500).json({ error: 'No se pudieron obtener las ventas' });
    }
});

// ============================================================
// DASHBOARD / REPORTES
// ============================================================
app.get('/dashboard', requiereToken, async (req, res) => {
    try {
        const resultado = await pool.query(`
            SELECT
                (SELECT COUNT(*) FROM productos WHERE activo = true) AS total_productos,
                (SELECT COUNT(*) FROM productos WHERE activo = true AND stock <= stock_minimo) AS productos_stock_bajo,
                (SELECT COUNT(*) FROM ventas WHERE fecha::date = CURRENT_DATE AND estado = 'COMPLETADA') AS ventas_hoy,
                (SELECT COALESCE(SUM(total), 0) FROM ventas WHERE fecha::date = CURRENT_DATE AND estado = 'COMPLETADA') AS vendido_hoy,
                (SELECT COALESCE(SUM(dv.cantidad * (dv.precio - dv.precio_compra)), 0)
                 FROM detalle_ventas dv
                 JOIN ventas v ON v.id = dv.venta_id
                 WHERE v.fecha::date = CURRENT_DATE AND v.estado = 'COMPLETADA') AS utilidad_hoy
        `);

        if (req.rol === 'Admin') {
            const inventario = await pool.query(`
                SELECT COALESCE(SUM(stock * precio_compra), 0) AS inventario_costo
                FROM productos WHERE activo = true
            `);

            return res.json({
                ...resultado.rows[0],
                inventario_costo: inventario.rows[0].inventario_costo
            });
        }

        res.json({
            total_productos: resultado.rows[0].total_productos,
            productos_stock_bajo: resultado.rows[0].productos_stock_bajo
        });
    } catch (error) {
        console.error('ERROR EN DASHBOARD:', error.message);
        res.status(500).json({ error: 'No se pudo obtener el dashboard' });
    }
});

app.get('/reporte-ventas', soloAdminPrincipal, async (req, res) => {
    const fecha = req.query.fecha;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha || ''))) {
        return res.status(400).json({ error: 'Fecha inválida' });
    }

    try {
        const resultado = await pool.query(`
            SELECT
                COUNT(*) AS numero_ventas,
                COALESCE(SUM(total), 0) AS total_vendido,
                COALESCE(SUM(CASE WHEN metodo_pago = '1' THEN total ELSE 0 END), 0) AS efectivo,
                COALESCE(SUM(CASE WHEN metodo_pago = '2' THEN total ELSE 0 END), 0) AS tarjeta,
                COALESCE(SUM(CASE WHEN metodo_pago = '3' THEN total ELSE 0 END), 0) AS transferencia
            FROM ventas
            WHERE fecha::date = $1::date
              AND estado = 'COMPLETADA'
        `, [fecha]);

        const utilidad = await pool.query(`
            SELECT COALESCE(SUM(dv.cantidad * (dv.precio - dv.precio_compra)), 0) AS utilidad
            FROM detalle_ventas dv
            JOIN ventas v ON v.id = dv.venta_id
            WHERE v.fecha::date = $1::date
              AND v.estado = 'COMPLETADA'
        `, [fecha]);

        res.json({
            ...resultado.rows[0],
            utilidad: utilidad.rows[0].utilidad
        });
    } catch (error) {
        console.error('ERROR EN REPORTE:', error.message);
        res.status(500).json({ error: 'No se pudo obtener el reporte' });
    }
});

// ============================================================
// USUARIOS
// ============================================================
app.get('/usuarios', soloAdminPrincipal, async (req, res) => {
    try {
        const resultado = await pool.query(`
            SELECT id, nombre, usuario, rol, activo,
                   admin_principal, fecha_creacion
            FROM usuarios
            ORDER BY id
        `);
        res.json(resultado.rows);
    } catch (error) {
        console.error('ERROR AL OBTENER USUARIOS:', error.message);
        res.status(500).json({ error: 'No se pudieron obtener los usuarios' });
    }
});

app.put('/usuarios/:id/password', soloAdminPrincipal, async (req, res) => {
    const id = Number(req.params.id);
    const password = String(req.body.password || '');

    if (!Number.isInteger(id) || id <= 0 || password.length < 8) {
        return res.status(400).json({
            error: 'La contraseña debe tener al menos 8 caracteres'
        });
    }

    try {
        const hash = await bcrypt.hash(password, 10);
        const resultado = await pool.query(`
            UPDATE usuarios
            SET password = $1
            WHERE id = $2
            RETURNING id, usuario
        `, [hash, id]);

        if (!resultado.rows.length) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        // Invalida las sesiones del usuario al cambiar su contraseña.
        await pool.query(
            'DELETE FROM sesiones_pestana WHERE usuario_id = $1',
            [id]
        );

        res.json({ mensaje: 'Contraseña cambiada correctamente' });
    } catch (error) {
        console.error('ERROR AL CAMBIAR CONTRASEÑA:', error.message);
        res.status(500).json({ error: 'No se pudo cambiar la contraseña' });
    }
});

app.put('/usuarios/:id/estado', soloAdminPrincipal, async (req, res) => {
    const id = Number(req.params.id);

    try {
        const resultado = await pool.query(`
            UPDATE usuarios
            SET activo = NOT activo
            WHERE id = $1
              AND admin_principal = false
            RETURNING id, usuario, activo
        `, [id]);

        if (!resultado.rows.length) {
            return res.status(400).json({
                error: 'No puedes cambiar el estado del Admin principal o el usuario no existe'
            });
        }

        if (!resultado.rows[0].activo) {
            await pool.query(
                'DELETE FROM sesiones_pestana WHERE usuario_id = $1',
                [id]
            );
        }

        res.json({
            mensaje: resultado.rows[0].activo
                ? 'Usuario activado correctamente'
                : 'Usuario desactivado correctamente'
        });
    } catch (error) {
        console.error('ERROR AL CAMBIAR ESTADO:', error.message);
        res.status(500).json({ error: 'No se pudo cambiar el estado del usuario' });
    }
});

app.post('/usuarios', soloAdminPrincipal, async (req, res) => {
    const nombre = String(req.body.nombre || '').trim();
    const usuario = String(req.body.usuario || '').trim();
    const password = String(req.body.password || '');
    const rol = String(req.body.rol || '');

    if (!nombre || !usuario || password.length < 8 || !['Empleado', 'Admin'].includes(rol)) {
        return res.status(400).json({
            error: 'Nombre, usuario, contraseña de al menos 8 caracteres y rol válido son obligatorios'
        });
    }

    try {
        const hash = await bcrypt.hash(password, 10);
        const resultado = await pool.query(`
            INSERT INTO usuarios (nombre, usuario, password, rol)
            VALUES ($1, $2, $3, $4)
            RETURNING id, nombre, usuario, rol, activo, admin_principal, fecha_creacion
        `, [nombre, usuario, hash, rol]);

        res.json({
            mensaje: 'Usuario creado correctamente',
            usuario: resultado.rows[0]
        });
    } catch (error) {
        console.error('ERROR AL CREAR USUARIO:', error.message);
        if (error.code === '23505') {
            return res.status(400).json({ error: 'Ese nombre de usuario ya existe' });
        }
        res.status(500).json({ error: 'No se pudo crear el usuario' });
    }
});

// ============================================================
// CAJA
// ============================================================
async function obtenerCajaAbierta() {
    const resultado = await pool.query(`
        SELECT
            c.*,
            u.nombre AS usuario_apertura_nombre,
            uc.nombre AS usuario_cierre_nombre
        FROM cortes_caja c
        JOIN usuarios u ON u.id = c.usuario_apertura
        LEFT JOIN usuarios uc ON uc.id = c.usuario_cierre
        WHERE c.estado = 'ABIERTA'
        ORDER BY c.id DESC
        LIMIT 1
    `);
    return resultado.rows[0] || null;
}

async function obtenerVentasDesde(fechaApertura) {
    const resultado = await pool.query(`
        SELECT
            COALESCE(SUM(CASE WHEN metodo_pago = '1' THEN total ELSE 0 END), 0) AS efectivo,
            COALESCE(SUM(CASE WHEN metodo_pago = '2' THEN total ELSE 0 END), 0) AS tarjeta,
            COALESCE(SUM(CASE WHEN metodo_pago = '3' THEN total ELSE 0 END), 0) AS transferencia,
            COALESCE(SUM(total), 0) AS total_vendido,
            COUNT(*) AS numero_ventas
        FROM ventas
        WHERE fecha >= $1
          AND estado = 'COMPLETADA'
    `, [fechaApertura]);
    return resultado.rows[0];
}

app.get('/caja/abierta', requiereToken, async (req, res) => {
    try {
        const caja = await obtenerCajaAbierta();
        if (!caja) return res.json({ abierta: false });

        const ventas = await obtenerVentasDesde(caja.fecha_apertura);
        const movimientos = await pool.query(`
            SELECT COALESCE(SUM(CASE WHEN tipo='ENTRADA' THEN importe ELSE -importe END),0) AS neto
            FROM movimientos_caja WHERE fecha >= $1 AND categoria <> 'DEVOLUCION'
        `, [caja.fecha_apertura]);
        const efectivoEsperado = Number(caja.fondo_inicial) + Number(ventas.efectivo) + Number(movimientos.rows[0].neto);

        res.json({
            abierta: true,
            caja,
            ventas,
            efectivo_esperado: efectivoEsperado
        });
    } catch (error) {
        console.error('ERROR AL CONSULTAR CAJA:', error.message);
        res.status(500).json({ error: 'No se pudo consultar la caja' });
    }
});

app.post('/caja/abrir', requiereToken, async (req, res) => {
    const fondoInicial = Number(req.body.fondo_inicial);

    if (!Number.isFinite(fondoInicial) || fondoInicial < 0) {
        return res.status(400).json({ error: 'El fondo inicial no es válido' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Serializa aperturas concurrentes incluso cuando todavía no existe una fila abierta.
        await client.query('SELECT pg_advisory_xact_lock(73194720)');

        const abierta = await client.query(`
            SELECT id
            FROM cortes_caja
            WHERE estado = 'ABIERTA'
            LIMIT 1
            FOR UPDATE
        `);

        if (abierta.rows.length) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Ya existe una caja abierta' });
        }

        const resultado = await client.query(`
            INSERT INTO cortes_caja (usuario_apertura, fondo_inicial, estado)
            VALUES ($1, $2, 'ABIERTA')
            RETURNING *
        `, [req.usuarioId, fondoInicial]);

        await client.query('COMMIT');
        res.json({ mensaje: 'Caja abierta correctamente', caja: resultado.rows[0] });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('ERROR AL ABRIR CAJA:', error.message);
        res.status(500).json({ error: 'No se pudo abrir la caja' });
    } finally {
        client.release();
    }
});

app.post('/caja/cerrar', requiereToken, async (req, res) => {
    const efectivoContado = Number(req.body.efectivo_contado);

    if (!Number.isFinite(efectivoContado) || efectivoContado < 0) {
        return res.status(400).json({ error: 'El efectivo contado no es válido' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const cajaResult = await client.query(`
            SELECT *
            FROM cortes_caja
            WHERE estado = 'ABIERTA'
            ORDER BY id DESC
            LIMIT 1
            FOR UPDATE
        `);

        if (!cajaResult.rows.length) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'No hay una caja abierta' });
        }

        const caja = cajaResult.rows[0];
        const ventasResult = await client.query(`
            SELECT
                COALESCE(SUM(CASE WHEN metodo_pago = '1' THEN total ELSE 0 END), 0) AS efectivo,
                COALESCE(SUM(CASE WHEN metodo_pago = '2' THEN total ELSE 0 END), 0) AS tarjeta,
                COALESCE(SUM(CASE WHEN metodo_pago = '3' THEN total ELSE 0 END), 0) AS transferencia,
                COALESCE(SUM(total), 0) AS total_vendido
            FROM ventas
            WHERE fecha >= $1
              AND estado = 'COMPLETADA'
        `, [caja.fecha_apertura]);

        const datos = ventasResult.rows[0];
        const movimientosCaja = await client.query(`
            SELECT COALESCE(SUM(CASE WHEN tipo='ENTRADA' THEN importe ELSE -importe END),0) AS neto
            FROM movimientos_caja WHERE fecha >= $1 AND categoria <> 'DEVOLUCION'
        `, [caja.fecha_apertura]);
        const efectivoEsperado = Number(caja.fondo_inicial) + Number(datos.efectivo) + Number(movimientosCaja.rows[0].neto);
        const diferencia = Number((efectivoContado - efectivoEsperado).toFixed(2));

        const cierre = await client.query(`
            UPDATE cortes_caja
            SET
                fecha_cierre = CURRENT_TIMESTAMP,
                usuario_cierre = $1,
                efectivo_esperado = $2,
                efectivo_contado = $3,
                diferencia = $4,
                ventas_efectivo = $5,
                ventas_tarjeta = $6,
                ventas_transferencia = $7,
                total_vendido = $8,
                estado = 'CERRADA'
            WHERE id = $9
            RETURNING *
        `, [
            req.usuarioId,
            efectivoEsperado,
            efectivoContado,
            diferencia,
            datos.efectivo,
            datos.tarjeta,
            datos.transferencia,
            datos.total_vendido,
            caja.id
        ]);

        await client.query(`
            UPDATE ventas
            SET corte_caja_id = $1
            WHERE corte_caja_id IS NULL
              AND fecha >= $2
              AND estado = 'COMPLETADA'
        `, [caja.id, caja.fecha_apertura]);

        await client.query('COMMIT');
        res.json({ mensaje: 'Caja cerrada correctamente', corte: cierre.rows[0] });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('ERROR AL CERRAR CAJA:', error.message);
        res.status(500).json({ error: 'No se pudo cerrar la caja' });
    } finally {
        client.release();
    }
});

app.get('/caja/historial', requiereToken, async (req, res) => {
    try {
        const resultado = await pool.query(`
            SELECT
                c.*,
                ua.nombre AS usuario_apertura_nombre,
                uc.nombre AS usuario_cierre_nombre
            FROM cortes_caja c
            JOIN usuarios ua ON ua.id = c.usuario_apertura
            LEFT JOIN usuarios uc ON uc.id = c.usuario_cierre
            WHERE c.estado = 'CERRADA'
            ORDER BY c.id DESC
        `);
        res.json(resultado.rows);
    } catch (error) {
        console.error('ERROR AL OBTENER HISTORIAL DE CAJA:', error.message);
        res.status(500).json({ error: 'No se pudo obtener el historial de caja' });
    }
});

app.get('/corte-caja', requiereToken, async (req, res) => {
    const fecha = String(req.query.fecha || '');

    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
        return res.status(400).json({ error: 'Fecha inválida' });
    }

    try {
        if (req.rol !== 'Admin') {
            const permitido = await pool.query(`
                SELECT
                    $1::date >= DATE_TRUNC('month', CURRENT_DATE)::date
                    AND $1::date < (DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month')::date
                    AS permitido
            `, [fecha]);

            if (!permitido.rows[0].permitido) {
                return res.status(403).json({
                    error: 'El Empleado solo puede consultar cortes del mes actual'
                });
            }
        }

        const resultado = await pool.query(`
            SELECT
                COUNT(*) AS numero_ventas,
                COALESCE(SUM(CASE WHEN metodo_pago = '1' THEN total ELSE 0 END), 0) AS efectivo,
                COALESCE(SUM(CASE WHEN metodo_pago = '2' THEN total ELSE 0 END), 0) AS tarjeta,
                COALESCE(SUM(CASE WHEN metodo_pago = '3' THEN total ELSE 0 END), 0) AS transferencia,
                COALESCE(SUM(total), 0) AS total_vendido
            FROM ventas
            WHERE fecha::date = $1::date
              AND estado = 'COMPLETADA'
        `, [fecha]);

        if (req.rol === 'Admin') {
            const utilidad = await pool.query(`
                SELECT COALESCE(SUM(dv.cantidad * (dv.precio - dv.precio_compra)), 0) AS utilidad
                FROM detalle_ventas dv
                JOIN ventas v ON v.id = dv.venta_id
                WHERE v.fecha::date = $1::date
                  AND v.estado = 'COMPLETADA'
            `, [fecha]);

            return res.json({
                ...resultado.rows[0],
                utilidad: utilidad.rows[0].utilidad
            });
        }

        res.json(resultado.rows[0]);
    } catch (error) {
        console.error('ERROR EN CORTE DE CAJA:', error.message);
        res.status(500).json({ error: 'No se pudo obtener el corte de caja' });
    }
});

// ============================================================
// HISTORIAL PROFESIONAL
// ============================================================
function construirFiltrosHistorial(req, alias = 'v') {
    const condiciones = [];
    const valores = [];

    if (!(req.rol === 'Admin' && req.admin_principal)) {
        condiciones.push(`${alias}.fecha::date = CURRENT_DATE`);
    }

    const desde = String(req.query.desde || '').trim();
    const hasta = String(req.query.hasta || '').trim();
    const metodo = String(req.query.metodo || '').trim();
    const busqueda = String(req.query.busqueda || '').trim();

    if (desde && /^\d{4}-\d{2}-\d{2}$/.test(desde)) {
        valores.push(desde);
        condiciones.push(`${alias}.fecha::date >= $${valores.length}::date`);
    }

    if (hasta && /^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
        valores.push(hasta);
        condiciones.push(`${alias}.fecha::date <= $${valores.length}::date`);
    }

    if (['1', '2', '3'].includes(metodo)) {
        valores.push(metodo);
        condiciones.push(`${alias}.metodo_pago = $${valores.length}`);
    }

    if (busqueda) {
        valores.push(`%${busqueda}%`);
        const p = `$${valores.length}`;
        condiciones.push(`(
            CAST(${alias}.id AS TEXT) ILIKE ${p}
            OR EXISTS (
                SELECT 1
                FROM detalle_ventas dvb
                JOIN productos pb ON pb.id = dvb.producto_id
                WHERE dvb.venta_id = ${alias}.id
                  AND (
                    pb.nombre ILIKE ${p}
                    OR CAST(pb.codigo AS TEXT) ILIKE ${p}
                  )
            )
        )`);
    }

    return {
        where: condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '',
        values: valores
    };
}

app.get('/historial-ventas', requiereToken, async (req, res) => {
    try {
        const pagina = Math.max(1, Number.parseInt(req.query.pagina, 10) || 1);
        const limite = Math.min(100, Math.max(1, Number.parseInt(req.query.limite, 10) || 25));
        const offset = (pagina - 1) * limite;
        const filtros = construirFiltrosHistorial(req, 'v');

        const totalResult = await pool.query(`
            SELECT COUNT(*)::integer AS total
            FROM ventas v
            ${filtros.where}
        `, filtros.values);

        const values = [...filtros.values, limite, offset];
        const pLimite = `$${values.length - 1}`;
        const pOffset = `$${values.length}`;

        const ventasResult = await pool.query(`
            SELECT
                v.id,
                v.fecha,
                v.total,
                v.metodo_pago,
                CASE
                    WHEN v.metodo_pago = '1' THEN 'Efectivo'
                    WHEN v.metodo_pago = '2' THEN 'Tarjeta'
                    WHEN v.metodo_pago = '3' THEN 'Transferencia'
                    ELSE v.metodo_pago::text
                END AS metodo_nombre,
                v.efectivo_recibido,
                v.cambio,
                v.estado,
                v.usuario_id,
                COALESCE(u.nombre, u.usuario, '—') AS usuario_nombre,
                COALESCE(SUM(dv.cantidad), 0)::integer AS unidades
            FROM ventas v
            LEFT JOIN usuarios u ON u.id = v.usuario_id
            LEFT JOIN detalle_ventas dv ON dv.venta_id = v.id
            ${filtros.where}
            GROUP BY v.id, u.id
            ORDER BY v.id DESC
            LIMIT ${pLimite}
            OFFSET ${pOffset}
        `, values);

        const total = Number(totalResult.rows[0].total);

        res.json({
            ventas: ventasResult.rows,
            paginacion: {
                pagina,
                limite,
                total,
                paginas: Math.ceil(total / limite)
            }
        });
    } catch (error) {
        console.error('ERROR HISTORIAL VENTAS:', error.message);
        res.status(500).json({ error: 'No se pudo obtener el historial de ventas' });
    }
});

app.get('/historial-ventas/analisis', requiereToken, async (req, res) => {
    try {
        const filtros = construirFiltrosHistorial(req, 'v');
        filtros.where += (filtros.where ? ' AND ' : 'WHERE ') + "v.estado = 'COMPLETADA'";

        const resumenResult = await pool.query(`
            SELECT
                COUNT(*)::integer AS numero_ventas,
                COALESCE(SUM(v.total), 0) AS total_vendido,
                COALESCE(AVG(v.total), 0) AS ticket_promedio,
                COALESCE(SUM(CASE WHEN v.metodo_pago = '1' THEN v.total ELSE 0 END), 0) AS efectivo,
                COALESCE(SUM(CASE WHEN v.metodo_pago = '2' THEN v.total ELSE 0 END), 0) AS tarjeta,
                COALESCE(SUM(CASE WHEN v.metodo_pago = '3' THEN v.total ELSE 0 END), 0) AS transferencia
            FROM ventas v
            ${filtros.where}
        `, filtros.values);

        const utilidadResult = await pool.query(`
            SELECT
                COALESCE(SUM(dv.cantidad * (dv.precio - dv.precio_compra)), 0) AS utilidad,
                COALESCE(SUM(dv.cantidad), 0)::integer AS unidades
            FROM detalle_ventas dv
            JOIN ventas v ON v.id = dv.venta_id
            ${filtros.where}
        `, filtros.values);

        const ventasPorDia = await pool.query(`
    SELECT
        v.fecha::date AS fecha,
        COUNT(*)::integer AS ventas,
        COALESCE(SUM(v.total), 0) AS ingresos,
        COALESCE(SUM(dv.cantidad), 0)::integer AS unidades
    FROM ventas v
    LEFT JOIN detalle_ventas dv
        ON dv.venta_id = v.id
    ${filtros.where}
    GROUP BY v.fecha::date
    ORDER BY v.fecha::date ASC
`, filtros.values);

        const utilidadPorDia = await pool.query(`
            SELECT
                v.fecha::date AS fecha,
                COALESCE(SUM(dv.cantidad * (dv.precio - dv.precio_compra)), 0) AS utilidad
            FROM ventas v
            JOIN detalle_ventas dv ON dv.venta_id = v.id
            ${filtros.where}
            GROUP BY v.fecha::date
            ORDER BY v.fecha::date ASC
        `, filtros.values);

        const ventasPorMetodo = await pool.query(`
            SELECT
                CASE
                    WHEN v.metodo_pago = '1' THEN 'Efectivo'
                    WHEN v.metodo_pago = '2' THEN 'Tarjeta'
                    WHEN v.metodo_pago = '3' THEN 'Transferencia'
                    ELSE v.metodo_pago::text
                END AS metodo,
                COUNT(*)::integer AS ventas,
                COALESCE(SUM(v.total), 0) AS total
            FROM ventas v
            ${filtros.where}
            GROUP BY v.metodo_pago
            ORDER BY total DESC
        `, filtros.values);

        const productosTop = await pool.query(`
            SELECT
                p.id,
                p.codigo,
                p.nombre,
                COALESCE(SUM(dv.cantidad), 0)::integer AS unidades,
                COALESCE(SUM(dv.cantidad * dv.precio), 0) AS ingresos,
                COALESCE(SUM(dv.cantidad * (dv.precio - dv.precio_compra)), 0) AS utilidad
            FROM detalle_ventas dv
            JOIN ventas v ON v.id = dv.venta_id
            JOIN productos p ON p.id = dv.producto_id
            ${filtros.where}
            GROUP BY p.id, p.codigo, p.nombre
            ORDER BY unidades DESC
            LIMIT 10
        `, filtros.values);

        const topIngreso = await pool.query(`
            SELECT p.id, p.codigo, p.nombre,
                   COALESCE(SUM(dv.cantidad * dv.precio), 0) AS ingresos
            FROM detalle_ventas dv
            JOIN ventas v ON v.id = dv.venta_id
            JOIN productos p ON p.id = dv.producto_id
            ${filtros.where}
            GROUP BY p.id, p.codigo, p.nombre
            ORDER BY ingresos DESC
            LIMIT 1
        `, filtros.values);

        const resumen = resumenResult.rows[0] || {};
        const utilidad = Number(utilidadResult.rows[0]?.utilidad || 0);
        const totalVendido = Number(resumen.total_vendido || 0);

        res.json({
            resumen: {
                numero_ventas: Number(resumen.numero_ventas || 0),
                total_vendido: totalVendido,
                utilidad,
                ticket_promedio: Number(resumen.ticket_promedio || 0),
                efectivo: Number(resumen.efectivo || 0),
                tarjeta: Number(resumen.tarjeta || 0),
                transferencia: Number(resumen.transferencia || 0),
                unidades: Number(utilidadResult.rows[0]?.unidades || 0),
                margen: totalVendido > 0 ? (utilidad / totalVendido) * 100 : 0,
                top_producto: productosTop.rows[0] || null,
                producto_mayor_ingreso: topIngreso.rows[0] || null
            },
            graficas: {
                ventas_por_dia: ventasPorDia.rows,
                utilidad_por_dia: utilidadPorDia.rows,
                ventas_por_metodo: ventasPorMetodo.rows,
                productos_top: productosTop.rows,
                producto_mayor_ingreso: topIngreso.rows[0] || null
            }
        });
    } catch (error) {
        console.error('ERROR ANALISIS HISTORIAL:', error.message);
        res.status(500).json({ error: 'No se pudo obtener el análisis del historial' });
    }
});

// Exportación CSV sencilla del historial de ventas para análisis externo.
app.get('/historial-ventas/exportar.csv', requiereToken, async(req,res)=>{
    try{
        const filtros=construirFiltrosHistorial(req,'v');
        const result=await pool.query(`SELECT v.id,v.fecha,v.total,v.metodo_pago,v.estado,COALESCE(u.nombre,u.usuario,'') AS usuario FROM ventas v LEFT JOIN usuarios u ON u.id=v.usuario_id ${filtros.where} ORDER BY v.id DESC LIMIT 10000`,filtros.values);
        const csvCell=value=>'"'+String(value??'').replace(/"/g,'""')+'"';
        const csv=['id,fecha,total,metodo_pago,estado,usuario',...result.rows.map(r=>[r.id,r.fecha,Number(r.total).toFixed(2),r.metodo_pago,r.estado,r.usuario].map(csvCell).join(','))].join('\r\n');
        res.setHeader('Content-Type','text/csv; charset=utf-8');
        res.setHeader('Content-Disposition','attachment; filename="historial_ventas.csv"');
        res.send('\uFEFF'+csv);
    }catch(error){console.error('ERROR EXPORTACIÓN CSV:',error.message);res.status(500).json({error:'No se pudo exportar el historial'});}
});

app.get('/historial-ventas/:id', requiereToken, async (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Número de venta inválido' });
    }

    try {
        const condiciones = ['v.id = $1'];
        const valores = [id];

        if (!(req.rol === 'Admin' && req.admin_principal)) {
            condiciones.push('v.fecha::date = CURRENT_DATE');
        }

        const ventaResult = await pool.query(`
            SELECT
                v.id,
                v.fecha,
                v.total,
                v.metodo_pago,
                CASE
                    WHEN v.metodo_pago = '1' THEN 'Efectivo'
                    WHEN v.metodo_pago = '2' THEN 'Tarjeta'
                    WHEN v.metodo_pago = '3' THEN 'Transferencia'
                    ELSE v.metodo_pago::text
                END AS metodo_nombre,
                v.efectivo_recibido,
                v.cambio,
                v.estado,
                COALESCE(u.nombre, u.usuario, '—') AS usuario_nombre
            FROM ventas v
            LEFT JOIN usuarios u ON u.id = v.usuario_id
            WHERE ${condiciones.join(' AND ')}
            LIMIT 1
        `, valores);

        if (!ventaResult.rows.length) {
            return res.status(404).json({ error: 'Venta no encontrada' });
        }

        const detalleResult = await pool.query(`
            SELECT
                p.id AS producto_id,
                p.codigo,
                p.nombre,
                dv.cantidad,
                dv.precio,
                dv.precio_compra,
                dv.cantidad * dv.precio AS subtotal,
                dv.cantidad * (dv.precio - dv.precio_compra) AS utilidad
            FROM detalle_ventas dv
            JOIN productos p ON p.id = dv.producto_id
            WHERE dv.venta_id = $1
            ORDER BY dv.id
        `, [id]);

        const venta = ventaResult.rows[0];
        const unidades = detalleResult.rows.reduce((sum, item) => sum + Number(item.cantidad), 0);
        const utilidad = detalleResult.rows.reduce((sum, item) => sum + Number(item.utilidad), 0);

        res.json({
            venta: {
                ...venta,
                total: Number(venta.total),
                efectivo_recibido: venta.efectivo_recibido === null ? null : Number(venta.efectivo_recibido),
                cambio: venta.cambio === null ? null : Number(venta.cambio),
                unidades,
                utilidad
            },
            productos: detalleResult.rows
        });
    } catch (error) {
        console.error('ERROR DETALLE HISTORIAL:', error.message);
        res.status(500).json({ error: 'No se pudo obtener el detalle de la venta' });
    }
});

app.get('/ventas/:id/detalle', requiereToken, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'ID de venta inválido' });
    }

    try {
        const condiciones = ['dv.venta_id = $1'];
        const valores = [id];

        if (!(req.rol === 'Admin' && req.admin_principal)) {
            condiciones.push('v.fecha::date = CURRENT_DATE');
        }

        const resultado = await pool.query(`
            SELECT
                p.nombre,
                p.codigo,
                dv.cantidad,
                dv.precio,
                dv.precio_compra,
                (dv.precio - dv.precio_compra) AS utilidad,
                (dv.cantidad * dv.precio) AS subtotal,
                (dv.cantidad * (dv.precio - dv.precio_compra)) AS utilidad_total
            FROM detalle_ventas dv
            JOIN productos p ON p.id = dv.producto_id
            JOIN ventas v ON v.id = dv.venta_id
            WHERE ${condiciones.join(' AND ')}
            ORDER BY dv.id
        `, valores);

        res.json(resultado.rows);
    } catch (error) {
        console.error('ERROR AL OBTENER DETALLE:', error.message);
        res.status(500).json({ error: 'No se pudo obtener el detalle de la venta' });
    }
});


// ============================================================
// COMPRAS A PROVEEDORES
// ============================================================
app.get('/compras', requiereToken, async (req, res) => {
    try {
        const resultado = await pool.query(`
            SELECT c.id, c.fecha, c.total, c.metodo_pago, c.referencia,
                   p.nombre AS proveedor_nombre, COALESCE(u.nombre,u.usuario,'—') AS usuario_nombre
            FROM compras c
            JOIN proveedores p ON p.id=c.proveedor_id
            LEFT JOIN usuarios u ON u.id=c.usuario_id
            ORDER BY c.id DESC LIMIT 100
        `);
        res.json(resultado.rows);
    } catch (error) {
        console.error('ERROR AL LISTAR COMPRAS:', error.message);
        res.status(500).json({error:'No se pudieron obtener las compras'});
    }
});

app.get('/compras/:id', requiereToken, async (req,res)=>{
    const id=Number(req.params.id);
    if(!Number.isInteger(id)||id<=0)return res.status(400).json({error:'ID de compra inválido'});
    try{
        const cabecera=await pool.query(`SELECT c.*,p.nombre AS proveedor_nombre,COALESCE(u.nombre,u.usuario,'—') AS usuario_nombre FROM compras c JOIN proveedores p ON p.id=c.proveedor_id LEFT JOIN usuarios u ON u.id=c.usuario_id WHERE c.id=$1`,[id]);
        if(!cabecera.rows.length)return res.status(404).json({error:'Compra no encontrada'});
        const detalle=await pool.query(`SELECT dc.producto_id,dc.cantidad,dc.costo_unitario,dc.subtotal,p.codigo,p.nombre FROM detalle_compras dc JOIN productos p ON p.id=dc.producto_id WHERE dc.compra_id=$1 ORDER BY dc.id`,[id]);
        res.json({compra:cabecera.rows[0],lineas:detalle.rows});
    }catch(error){console.error('ERROR DETALLE COMPRA:',error.message);res.status(500).json({error:'No se pudo obtener el detalle de compra'});}
});

app.post('/compras', soloAdmin, async (req, res) => {
    const proveedorId = Number(req.body.proveedor_id);
    const metodoPago = String(req.body.metodo_pago || '1');
    const referencia = String(req.body.referencia || '').trim().slice(0,100) || null;
    const lineas = Array.isArray(req.body.lineas) ? req.body.lineas : [];
    if (!Number.isInteger(proveedorId) || proveedorId <= 0 || !['1','2','3'].includes(metodoPago) || !lineas.length) {
        return res.status(400).json({error:'Proveedor, forma de pago y productos son obligatorios'});
    }
    const agrupadas = new Map();
    for (const linea of lineas) {
        const productoId = Number(linea.producto_id), cantidad = Number(linea.cantidad), costo = Number(linea.costo_unitario);
        if (!Number.isInteger(productoId)||productoId<=0||!Number.isInteger(cantidad)||cantidad<=0||!Number.isFinite(costo)||costo<0) {
            return res.status(400).json({error:'Una línea de compra contiene datos inválidos'});
        }
        if (agrupadas.has(productoId)) return res.status(400).json({error:'No repitas el mismo producto en varias líneas; agrupa su cantidad antes de guardar'});
        agrupadas.set(productoId,{cantidad,costo});
    }
    const client=await pool.connect();
    try {
        await client.query('BEGIN');
        const prov=await client.query('SELECT id,nombre FROM proveedores WHERE id=$1 AND activo=TRUE FOR SHARE',[proveedorId]);
        if(!prov.rows.length) throw new Error('El proveedor no existe o está inactivo');
        const ids=[...agrupadas.keys()];
        const products=await client.query('SELECT id,nombre,precio_compra FROM productos WHERE id=ANY($1::int[]) AND activo=TRUE FOR UPDATE',[ids]);
        if(products.rows.length!==ids.length) throw new Error('Uno o más productos no existen o están inactivos');
        let total=0;
        for(const [id,l] of agrupadas) total += l.cantidad*l.costo;
        total=Number(total.toFixed(2));
        const compraRes=await client.query(`INSERT INTO compras(proveedor_id,usuario_id,total,metodo_pago,referencia) VALUES($1,$2,$3,$4,$5) RETURNING *`,[proveedorId,req.usuarioId,total,metodoPago,referencia]);
        const compra=compraRes.rows[0];
        for(const [id,l] of agrupadas){
            await client.query(`INSERT INTO detalle_compras(compra_id,producto_id,cantidad,costo_unitario,subtotal) VALUES($1,$2,$3,$4,$5)`,[compra.id,id,l.cantidad,l.costo,Number((l.cantidad*l.costo).toFixed(2))]);
            await client.query(`UPDATE productos SET precio_compra=$1 WHERE id=$2`,[l.costo,id]);
            await client.query(`INSERT INTO movimientos(producto_id,tipo,cantidad,motivo) VALUES($1,'ENTRADA',$2,$3)`,[id,l.cantidad,`Compra #${compra.id} - ${prov.rows[0].nombre}`]);
        }
        // Solo una compra pagada en efectivo modifica el efectivo esperado de caja.
        if(metodoPago==='1'){
            const caja=await client.query(`SELECT id FROM cortes_caja WHERE estado='ABIERTA' ORDER BY id DESC LIMIT 1 FOR UPDATE`);
            if(caja.rows.length){
                await client.query(`INSERT INTO movimientos_caja(corte_caja_id,usuario_id,tipo,categoria,importe,concepto,referencia_tipo,referencia_id) VALUES($1,$2,'SALIDA','COMPRA',$3,$4,'COMPRA',$5)`,[caja.rows[0].id,req.usuarioId,total,`Pago en efectivo de compra #${compra.id}`,compra.id]);
            } else {
                // Evita registrar compra pagada en efectivo sin que el movimiento de caja sea trazable.
                throw new Error('No hay caja abierta. Abre caja o registra la compra con tarjeta/transferencia si corresponde.');
            }
        }
        await client.query('COMMIT');
        res.status(201).json({mensaje:'Compra registrada',compra:{...compra,total:Number(compra.total)}});
    } catch(error){
        await client.query('ROLLBACK');
        console.error('ERROR AL REGISTRAR COMPRA:',error.message);
        res.status(400).json({error:error.message||'No se pudo registrar la compra'});
    } finally {client.release();}
});

// ============================================================
// MOVIMIENTOS ADICIONALES DE CAJA (gastos, retiros y entradas)
// ============================================================
app.get('/caja/movimientos', requiereToken, async (req,res)=>{
    try{
        const caja=await obtenerCajaAbierta();
        const resultado=await pool.query(`
            SELECT m.id,m.fecha,m.tipo,m.categoria,m.importe,m.concepto,COALESCE(u.nombre,u.usuario,'—') AS usuario_nombre
            FROM movimientos_caja m LEFT JOIN usuarios u ON u.id=m.usuario_id
            WHERE ($1::integer IS NULL OR m.corte_caja_id=$1)
            ORDER BY m.id DESC LIMIT 100
        `,[caja ? caja.id : null]);
        res.json(resultado.rows);
    }catch(error){console.error('ERROR MOVIMIENTOS CAJA:',error.message);res.status(500).json({error:'No se pudieron obtener los movimientos de caja'});}
});
app.post('/caja/movimientos', soloAdmin, async(req,res)=>{
    const tipo=String(req.body.tipo||'');
    const categoria=String(req.body.categoria||'OTRO');
    const importe=Number(req.body.importe);
    const concepto=String(req.body.concepto||'').trim();
    if(!['ENTRADA','SALIDA'].includes(tipo)||!['GASTO','RETIRO','APORTE','OTRO'].includes(categoria)||!Number.isFinite(importe)||importe<=0||!concepto){
        return res.status(400).json({error:'Tipo, categoría, importe y concepto válidos son obligatorios'});
    }
    try{
        const caja=await pool.query(`SELECT id FROM cortes_caja WHERE estado='ABIERTA' ORDER BY id DESC LIMIT 1`);
        if(!caja.rows.length)return res.status(400).json({error:'Debes abrir caja antes de registrar movimientos de efectivo'});
        if(tipo==='ENTRADA' && !['APORTE','OTRO'].includes(categoria))return res.status(400).json({error:'Para entradas usa la categoría Aporte u Otro'});
        if(tipo==='SALIDA' && categoria==='APORTE')return res.status(400).json({error:'La categoría Aporte solo puede usarse para entradas'});
        const resultado=await pool.query(`INSERT INTO movimientos_caja(corte_caja_id,usuario_id,tipo,categoria,importe,concepto) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[caja.rows[0].id,req.usuarioId,tipo,categoria,Number(importe.toFixed(2)),concepto]);
        res.status(201).json({mensaje:'Movimiento de caja registrado',movimiento:resultado.rows[0]});
    }catch(error){console.error('ERROR AL REGISTRAR MOVIMIENTO DE CAJA:',error.message);res.status(500).json({error:'No se pudo registrar el movimiento de caja'});}
});

// ============================================================
// ANULACIÓN TOTAL DE VENTAS (auditoría + reposición de stock)
// ============================================================
app.post('/ventas/:id/anular', soloAdmin, async(req,res)=>{
    const ventaId=Number(req.params.id), motivo=String(req.body.motivo||'').trim();
    if(!Number.isInteger(ventaId)||ventaId<=0||motivo.length<3)return res.status(400).json({error:'Venta y motivo de anulación válidos son obligatorios'});
    const client=await pool.connect();
    try{
        await client.query('BEGIN');
        const ventaRes=await client.query(`SELECT * FROM ventas WHERE id=$1 FOR UPDATE`,[ventaId]);
        if(!ventaRes.rows.length)throw new Error('La venta no existe');
        const venta=ventaRes.rows[0];
        if(venta.estado!=='COMPLETADA')throw new Error('La venta ya fue anulada o no está completada');
        if(String(venta.metodo_pago)==='1'){
            const cajaAbierta=await client.query(`SELECT id FROM cortes_caja WHERE estado='ABIERTA' ORDER BY id DESC LIMIT 1 FOR UPDATE`);
            if(!cajaAbierta.rows.length)throw new Error('Abre caja antes de anular una venta en efectivo para que el reembolso quede registrado.');
        }
        const detalles=await client.query(`SELECT producto_id,cantidad FROM detalle_ventas WHERE venta_id=$1 FOR UPDATE`,[ventaId]);
        if(!detalles.rows.length)throw new Error('La venta no tiene detalle y no puede anularse automáticamente');
        for(const d of detalles.rows){
            await client.query(`INSERT INTO movimientos(producto_id,tipo,cantidad,motivo) VALUES($1,'ENTRADA',$2,$3)`,[d.producto_id,d.cantidad,`Devolución por anulación de venta #${ventaId}`]);
        }
        await client.query(`INSERT INTO anulaciones_ventas(venta_id,usuario_id,motivo,importe) VALUES($1,$2,$3,$4)`,[ventaId,req.usuarioId,motivo,venta.total]);
        await client.query(`UPDATE ventas SET estado='ANULADA' WHERE id=$1`,[ventaId]);
        if(String(venta.metodo_pago)==='1'){
            const caja=await client.query(`SELECT id FROM cortes_caja WHERE estado='ABIERTA' ORDER BY id DESC LIMIT 1 FOR UPDATE`);
            if(caja.rows.length){
                // Si la venta pertenece a esta misma caja, ya deja de sumar al cambiar a ANULADA.
                // Si es una devolución de una caja anterior, sí debe descontarse del efectivo actual.
                const categoriaReembolso = Number(venta.corte_caja_id) === Number(caja.rows[0].id) ? 'DEVOLUCION' : 'DEVOLUCION_PENDIENTE';
                await client.query(`INSERT INTO movimientos_caja(corte_caja_id,usuario_id,tipo,categoria,importe,concepto,referencia_tipo,referencia_id) VALUES($1,$2,'SALIDA',$3,$4,$5,'VENTA',$6)`,[caja.rows[0].id,req.usuarioId,categoriaReembolso,venta.total,`Reembolso en efectivo por anulación de venta #${ventaId}`,ventaId]);
            }
        }
        await client.query('COMMIT');
        res.json({mensaje:'Venta anulada; stock repuesto y auditoría guardada',venta_id:ventaId});
    }catch(error){await client.query('ROLLBACK');console.error('ERROR ANULACIÓN:',error.message);res.status(400).json({error:error.message||'No se pudo anular la venta'});}finally{client.release();}
});

// Resumen financiero por fechas: utilidad bruta estimada menos gastos registrados.
app.get('/reportes/finanzas', soloAdminPrincipal, async (req,res)=>{
    const desde=String(req.query.desde||'').trim(), hasta=String(req.query.hasta||'').trim();
    if((desde&&!/^\d{4}-\d{2}-\d{2}$/.test(desde))||(hasta&&!/^\d{4}-\d{2}-\d{2}$/.test(hasta)))return res.status(400).json({error:'Fechas inválidas'});
    try{
        const vals=[], cond=[];
        if(desde){vals.push(desde);cond.push(`v.fecha::date >= $${vals.length}::date`);}
        if(hasta){vals.push(hasta);cond.push(`v.fecha::date <= $${vals.length}::date`);}
        const where=cond.length?' AND '+cond.join(' AND '):'';
        const ventas=await pool.query(`
            WITH periodo AS (
                SELECT v.id,v.total FROM ventas v WHERE v.estado='COMPLETADA'${where}
            ), detalle AS (
                SELECT COALESCE(SUM(dv.cantidad*dv.precio_compra),0) AS costo_mercancia,
                       COALESCE(SUM(dv.cantidad*(dv.precio-dv.precio_compra)),0) AS utilidad_bruta
                FROM detalle_ventas dv JOIN periodo p ON p.id=dv.venta_id
            )
            SELECT (SELECT COALESCE(SUM(total),0) FROM periodo) AS ingresos,
                   (SELECT COUNT(*)::integer FROM periodo) AS numero_ventas,
                   detalle.costo_mercancia,detalle.utilidad_bruta FROM detalle
        `,vals);
        const expVals=[], expCond=[];
        if(desde){expVals.push(desde);expCond.push(`fecha::date >= $${expVals.length}::date`);}
        if(hasta){expVals.push(hasta);expCond.push(`fecha::date <= $${expVals.length}::date`);}
        const gastos=await pool.query(`SELECT COALESCE(SUM(importe),0) gastos FROM movimientos_caja WHERE tipo='SALIDA' AND categoria='GASTO'${expCond.length?' AND '+expCond.join(' AND '):''}`,expVals);
        const a=ventas.rows[0], gasto=Number(gastos.rows[0].gastos||0);
        res.json({desde:desde||null,hasta:hasta||null,numero_ventas:Number(a.numero_ventas),ingresos:Number(a.ingresos),costo_mercancia:Number(a.costo_mercancia),utilidad_bruta:Number(a.utilidad_bruta),gastos:gasto,utilidad_neta_estimada:Number(a.utilidad_bruta)-gasto});
    }catch(error){console.error('ERROR REPORTE FINANCIERO:',error.message);res.status(500).json({error:'No se pudo generar el reporte financiero'});}
});

app.get('/reportes/exportar-excel', soloAdminPrincipal, async (req, res) => {
    const desde = String(req.query.desde || '').trim();
    const hasta = String(req.query.hasta || '').trim();
    const fechaValida = value => !value || /^\d{4}-\d{2}-\d{2}$/.test(value);
    if (!fechaValida(desde) || !fechaValida(hasta)) {
        return res.status(400).json({ error: 'Formato de fecha inválido' });
    }
    if (desde && hasta && desde > hasta) {
        return res.status(400).json({ error: 'La fecha inicial no puede ser posterior a la fecha final' });
    }

    try {
        const buildRange = (column, startIndex = 1) => {
            const values = [];
            const conditions = [];
            if (desde) { values.push(desde); conditions.push(`${column}::date >= $${startIndex + values.length - 1}::date`); }
            if (hasta) { values.push(hasta); conditions.push(`${column}::date <= $${startIndex + values.length - 1}::date`); }
            return { values, where: conditions.length ? ` AND ${conditions.join(' AND ')}` : '' };
        };

        const ventasRango = buildRange('v.fecha');
        const comprasRango = buildRange('c.fecha');
        const cajaRango = buildRange('mc.fecha');

        const [ventas, detalle, inventario, stockBajo, compras, movimientos, finanzas] = await Promise.all([
            pool.query(`SELECT v.id AS venta, v.fecha, v.estado, v.total, v.metodo_pago,
                        v.efectivo_recibido, v.cambio, COALESCE(u.nombre,u.usuario,'') AS usuario
                        FROM ventas v LEFT JOIN usuarios u ON u.id=v.usuario_id
                        WHERE 1=1${ventasRango.where} ORDER BY v.fecha DESC, v.id DESC`, ventasRango.values),
            pool.query(`SELECT v.id AS venta, v.fecha, v.estado, p.codigo, p.nombre AS producto,
                        p.marca, dv.cantidad, dv.precio AS precio_unitario,
                        dv.precio_compra AS costo_unitario,
                        (dv.cantidad*dv.precio) AS subtotal,
                        (dv.cantidad*(dv.precio-dv.precio_compra)) AS utilidad_bruta
                        FROM detalle_ventas dv JOIN ventas v ON v.id=dv.venta_id
                        JOIN productos p ON p.id=dv.producto_id
                        WHERE 1=1${ventasRango.where} ORDER BY v.fecha DESC, v.id DESC, p.nombre`, ventasRango.values),
            pool.query(`SELECT codigo,nombre,marca,categoria,descripcion,ubicacion,stock,stock_minimo,
                        precio_compra,precio_venta,(stock*precio_compra) AS valor_a_costo,
                        (stock*precio_venta) AS valor_a_venta,activo
                        FROM productos ORDER BY nombre`),
            pool.query(`SELECT codigo,nombre,marca,categoria,ubicacion,stock,stock_minimo,precio_compra,precio_venta
                        FROM productos WHERE activo=TRUE AND stock<=stock_minimo ORDER BY stock ASC,nombre`),
            pool.query(`SELECT c.id AS compra,c.fecha,p.nombre AS proveedor,c.referencia,c.metodo_pago,
                        c.total,COALESCE(u.nombre,u.usuario,'') AS usuario
                        FROM compras c JOIN proveedores p ON p.id=c.proveedor_id
                        LEFT JOIN usuarios u ON u.id=c.usuario_id
                        WHERE 1=1${comprasRango.where} ORDER BY c.fecha DESC,c.id DESC`, comprasRango.values),
            pool.query(`SELECT mc.fecha,mc.tipo,mc.categoria,mc.importe,mc.concepto,
                        mc.referencia_tipo,mc.referencia_id,COALESCE(u.nombre,u.usuario,'') AS usuario
                        FROM movimientos_caja mc LEFT JOIN usuarios u ON u.id=mc.usuario_id
                        WHERE 1=1${cajaRango.where} ORDER BY mc.fecha DESC,mc.id DESC`, cajaRango.values),
            pool.query(`WITH periodo AS (
                            SELECT v.id,v.total FROM ventas v WHERE v.estado='COMPLETADA'${ventasRango.where}
                        ), detalle AS (
                            SELECT COALESCE(SUM(dv.cantidad*dv.precio_compra),0) AS costo_mercancia,
                                   COALESCE(SUM(dv.cantidad*(dv.precio-dv.precio_compra)),0) AS utilidad_bruta
                            FROM detalle_ventas dv JOIN periodo p ON p.id=dv.venta_id
                        )
                        SELECT (SELECT COUNT(*)::integer FROM periodo) AS numero_ventas,
                               (SELECT COALESCE(SUM(total),0) FROM periodo) AS ingresos,
                               detalle.costo_mercancia,detalle.utilidad_bruta FROM detalle`, ventasRango.values)
        ]);

        const gasto = await pool.query(`SELECT COALESCE(SUM(importe),0) AS gastos FROM movimientos_caja
            WHERE tipo='SALIDA' AND categoria='GASTO'${buildRange('fecha').where}`, buildRange('fecha').values);
        const fin = finanzas.rows[0] || {};
        const gastos = Number(gasto.rows[0]?.gastos || 0);
        const wb = new ExcelJS.Workbook();
        wb.creator = 'PuntoVenta2';
        wb.subject = 'Informe de ventas, finanzas e inventario';
        wb.title = 'Informe de PuntoVenta2';
        wb.created = new Date();
        wb.modified = new Date();
        wb.views = [{ state: 'frozen', x: 0, y: 1 }];

        const fmtMoney = '"$" #,##0.00;[Red]-"$" #,##0.00';
        const fmtDate = 'dd/mm/yyyy hh:mm';
        function addSheet(name, rows, columns, moneyKeys = [], dateKeys = []) {
            const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
            ws.columns = columns.map(c => ({ header: c.header, key: c.key, width: c.width || Math.max(14, c.header.length + 2) }));
            ws.addRows(rows);
            ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
            ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF243447' } };
            ws.getRow(1).alignment = { vertical: 'middle', wrapText: true };
            ws.getRow(1).height = 26;
            ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, ws.rowCount), column: columns.length } };
            moneyKeys.forEach(key => { const col = columns.findIndex(c => c.key === key) + 1; if (col > 0) ws.getColumn(col).numFmt = fmtMoney; });
            dateKeys.forEach(key => { const col = columns.findIndex(c => c.key === key) + 1; if (col > 0) ws.getColumn(col).numFmt = fmtDate; });
            ws.eachRow((row, rowNumber) => { if (rowNumber > 1) row.alignment = { vertical: 'top' }; });
            return ws;
        }
        const resumen = wb.addWorksheet('Resumen', { views: [{ state: 'normal' }] });
        resumen.columns = [{ header: 'Indicador', key: 'indicador', width: 34 }, { header: 'Valor', key: 'valor', width: 22 }];
        resumen.addRows([
            { indicador: 'Informe de PuntoVenta2', valor: '' },
            { indicador: 'Desde', valor: desde || 'Sin límite' },
            { indicador: 'Hasta', valor: hasta || 'Sin límite' },
            { indicador: 'Ventas completadas', valor: Number(fin.numero_ventas || 0) },
            { indicador: 'Ingresos por ventas', valor: Number(fin.ingresos || 0) },
            { indicador: 'Costo de mercancía vendida', valor: Number(fin.costo_mercancia || 0) },
            { indicador: 'Utilidad bruta estimada', valor: Number(fin.utilidad_bruta || 0) },
            { indicador: 'Gastos registrados', valor: gastos },
            { indicador: 'Utilidad neta estimada', valor: Number(fin.utilidad_bruta || 0) - gastos },
            { indicador: 'Productos activos', valor: inventario.rows.filter(p => p.activo === true).length },
            { indicador: 'Productos con stock bajo', valor: stockBajo.rowCount },
            { indicador: 'Valor del inventario a costo', valor: inventario.rows.reduce((sum,p) => sum + (p.activo === true ? Number(p.valor_a_costo || 0) : 0), 0) },
            { indicador: 'Generado el', valor: new Date() }
        ]);
        resumen.getRow(1).font = { bold: true, size: 15, color: { argb: 'FFFFFFFF' } };
        resumen.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF243447' } };
        resumen.getRow(1).height = 30;
        resumen.getColumn(2).numFmt = fmtMoney;
        [5,11,12].forEach(n => { resumen.getCell(n,2).numFmt = '0'; });
        resumen.getCell(14,2).numFmt = fmtDate;
        resumen.getCell(3,2).numFmt = '@'; resumen.getCell(4,2).numFmt = '@';

        addSheet('Ventas', ventas.rows, [
            {header:'Venta #',key:'venta',width:12},{header:'Fecha',key:'fecha',width:21},{header:'Estado',key:'estado',width:16},
            {header:'Total',key:'total',width:16},{header:'Método de pago',key:'metodo_pago',width:17},
            {header:'Efectivo recibido',key:'efectivo_recibido',width:18},{header:'Cambio',key:'cambio',width:14},{header:'Usuario',key:'usuario',width:22}
        ], ['total','efectivo_recibido','cambio'], ['fecha']);
        addSheet('Detalle ventas', detalle.rows, [
            {header:'Venta #',key:'venta',width:12},{header:'Fecha',key:'fecha',width:21},{header:'Estado',key:'estado',width:15},
            {header:'Código',key:'codigo',width:16},{header:'Producto',key:'producto',width:32},{header:'Marca',key:'marca',width:20},
            {header:'Cantidad',key:'cantidad',width:12},{header:'Precio unitario',key:'precio_unitario',width:16},
            {header:'Costo unitario',key:'costo_unitario',width:16},{header:'Subtotal',key:'subtotal',width:16},{header:'Utilidad bruta',key:'utilidad_bruta',width:17}
        ], ['precio_unitario','costo_unitario','subtotal','utilidad_bruta'], ['fecha']);
        addSheet('Inventario', inventario.rows, [
            {header:'Código',key:'codigo',width:16},{header:'Producto',key:'nombre',width:32},{header:'Marca',key:'marca',width:20},
            {header:'Categoría',key:'categoria',width:20},{header:'Descripción',key:'descripcion',width:36},{header:'Ubicación',key:'ubicacion',width:18},
            {header:'Stock',key:'stock',width:10},{header:'Stock mínimo',key:'stock_minimo',width:14},{header:'Precio compra',key:'precio_compra',width:16},
            {header:'Precio venta',key:'precio_venta',width:16},{header:'Valor a costo',key:'valor_a_costo',width:16},{header:'Valor a venta',key:'valor_a_venta',width:16},{header:'Activo',key:'activo',width:10}
        ], ['precio_compra','precio_venta','valor_a_costo','valor_a_venta']);
        addSheet('Stock bajo', stockBajo.rows, [
            {header:'Código',key:'codigo',width:16},{header:'Producto',key:'nombre',width:32},{header:'Marca',key:'marca',width:20},
            {header:'Categoría',key:'categoria',width:20},{header:'Ubicación',key:'ubicacion',width:18},{header:'Stock actual',key:'stock',width:13},
            {header:'Stock mínimo',key:'stock_minimo',width:14},{header:'Precio compra',key:'precio_compra',width:16},{header:'Precio venta',key:'precio_venta',width:16}
        ], ['precio_compra','precio_venta']);
        addSheet('Compras', compras.rows, [
            {header:'Compra #',key:'compra',width:12},{header:'Fecha',key:'fecha',width:21},{header:'Proveedor',key:'proveedor',width:28},
            {header:'Referencia',key:'referencia',width:20},{header:'Método de pago',key:'metodo_pago',width:17},{header:'Total',key:'total',width:16},{header:'Usuario',key:'usuario',width:22}
        ], ['total'], ['fecha']);
        addSheet('Movimientos caja', movimientos.rows, [
            {header:'Fecha',key:'fecha',width:21},{header:'Tipo',key:'tipo',width:14},{header:'Categoría',key:'categoria',width:20},
            {header:'Importe',key:'importe',width:16},{header:'Concepto',key:'concepto',width:42},{header:'Tipo referencia',key:'referencia_tipo',width:18},
            {header:'Referencia #',key:'referencia_id',width:15},{header:'Usuario',key:'usuario',width:22}
        ], ['importe'], ['fecha']);
 const dashboard = wb.addWorksheet('Dashboard', {
            properties: { tabColor: { argb: 'FF0F766E' } },
            views: [{ showGridLines: false }]
        });
        dashboard.getColumn(1).width = 3;
        dashboard.getColumn(2).width = 22;
        dashboard.getColumn(3).width = 22;
        dashboard.getColumn(4).width = 4;
        dashboard.getColumn(5).width = 22;
        dashboard.getColumn(6).width = 22;
        dashboard.getColumn(7).width = 4;
        dashboard.getColumn(8).width = 22;
        dashboard.getColumn(9).width = 22;
        dashboard.mergeCells('B2:I2');
        dashboard.getCell('B2').value = 'PUNTOVENTA2 | INFORME COMERCIAL';
        dashboard.getCell('B2').font = { name: 'Aptos Display', size: 20, bold: true, color: { argb: 'FFFFFFFF' } };
        dashboard.getCell('B2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF172B4D' } };
        dashboard.getCell('B2').alignment = { vertical: 'middle', horizontal: 'left' };
        dashboard.getRow(2).height = 38;
        dashboard.mergeCells('B3:I3');
        dashboard.getCell('B3').value = `Periodo: ${desde || 'Desde el inicio'} — ${hasta || 'Hasta hoy'} | Generado: ${new Date().toLocaleString('es-ES')}`;
        dashboard.getCell('B3').font = { italic: true, color: { argb: 'FF526176' }, size: 10 };

        const completadas = ventas.rows.filter(v => String(v.estado || '').toUpperCase() === 'COMPLETADA');
        const totalIngresos = completadas.reduce((s, v) => s + Number(v.total || 0), 0);
        const totalVentas = completadas.length;
        const ticketMedio = totalVentas ? totalIngresos / totalVentas : 0;
        const totalUnidades = detalle.rows
            .filter(d => String(d.estado || '').toUpperCase() === 'COMPLETADA')
            .reduce((s, d) => s + Number(d.cantidad || 0), 0);
        const utilidadBruta = Number(finanzas.rows[0]?.utilidad_bruta || 0);

        function tarjeta(rango, titulo, valor, formato = 'texto') {
            dashboard.mergeCells(rango);
            const celda = dashboard.getCell(rango.split(':')[0]);
            celda.value = valor;
            celda.font = { bold: true, size: 16, color: { argb: 'FF172B4D' } };
            celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
            celda.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
            celda.border = {
                top: { style: 'thin', color: { argb: 'FFD9E2EC' } },
                bottom: { style: 'thin', color: { argb: 'FFD9E2EC' } },
                left: { style: 'thin', color: { argb: 'FFD9E2EC' } },
                right: { style: 'thin', color: { argb: 'FFD9E2EC' } }
            };
            if (formato === 'dinero') celda.numFmt = '"MXN $" #,##0.00';
        }
        // Etiquetas encima de cada indicador.
        for (const [r, t] of [['B5:C5','VENTAS COMPLETADAS'],['E5:F5','INGRESOS'],['H5:I5','TICKET MEDIO']]) {
            dashboard.mergeCells(r);
            const c = dashboard.getCell(r.split(':')[0]); c.value = t;
            c.font = { bold: true, size: 9, color: { argb: 'FF526176' } };
            c.alignment = { horizontal: 'center' };
        }
        tarjeta('B6:C7', 'VENTAS', totalVentas);
        tarjeta('E6:F7', 'INGRESOS', totalIngresos, 'dinero');
        tarjeta('H6:I7', 'TICKET MEDIO', ticketMedio, 'dinero');
        dashboard.getRow(6).height = 25;
        dashboard.getRow(7).height = 25;
        dashboard.mergeCells('B9:C9'); dashboard.getCell('B9').value = 'UNIDADES VENDIDAS';
        dashboard.mergeCells('E9:F9'); dashboard.getCell('E9').value = 'UTILIDAD BRUTA ESTIMADA';
        dashboard.mergeCells('H9:I9'); dashboard.getCell('H9').value = 'PRODUCTOS CON STOCK BAJO';
        for (const cell of ['B9','E9','H9']) {
            dashboard.getCell(cell).font = { bold: true, size: 9, color: { argb: 'FF526176' } };
            dashboard.getCell(cell).alignment = { horizontal: 'center' };
        }
        tarjeta('B10:C11', 'UNIDADES', totalUnidades);
        tarjeta('E10:F11', 'UTILIDAD', utilidadBruta, 'dinero');
        tarjeta('H10:I11', 'STOCK BAJO', stockBajo.rowCount);
        dashboard.getRow(10).height = 25;
        dashboard.getRow(11).height = 25;

        const chartCanvas = new ChartJSNodeCanvas({ width: 900, height: 420, backgroundColour: '#FFFFFF' });
        const dinero = n => Number(n || 0).toLocaleString('es-MX', {
            style: 'currency',
    currency: 'MXN'
});
        const porDia = new Map();
        for (const v of completadas) {
            const fecha = v.fecha ? new Date(v.fecha) : null;
            const label = fecha && !Number.isNaN(fecha.getTime())
                ? fecha.toLocaleDateString('sv-SE')
                : 'Fecha desconocida';
            porDia.set(label, (porDia.get(label) || 0) + Number(v.total || 0));
        }
        const ventasDia = [...porDia.entries()].sort((a, b) => a[0].localeCompare(b[0]));
        const metodos = new Map();
        for (const v of completadas) {
            const metodo = String(v.metodo_pago || 'No especificado');
            metodos.set(metodo, (metodos.get(metodo) || 0) + Number(v.total || 0));
        }
        const productos = new Map();
        for (const d of detalle.rows) {
            if (String(d.estado || '').toUpperCase() !== 'COMPLETADA') continue;
            const nombre = String(d.producto || 'Producto sin nombre');
            const actual = productos.get(nombre) || { cantidad: 0, importe: 0 };
            actual.cantidad += Number(d.cantidad || 0);
            actual.importe += Number(d.subtotal || 0);
            productos.set(nombre, actual);
        }
        const topProductos = [...productos.entries()].sort((a,b) => b[1].importe - a[1].importe).slice(0,10);
        const topStock = stockBajo.rows.slice(0,10);

        const chartConfigs = [
            {
                title: 'Ingresos por día', type: 'line', x: 40, y: 14,
                labels: ventasDia.map(x => x[0]), values: ventasDia.map(x => Number(x[1].toFixed(2))),
                dataset: 'Ingresos (€)', color: '#0F766E', money: true
            },
            {
                title: 'Ingresos por método de pago', type: 'doughnut', x: 40, y: 14,
                labels: [...metodos.keys()], values: [...metodos.values()].map(n => Number(n.toFixed(2))),
                dataset: 'Ingresos (€)', money: true
            },
            {
                title: 'Top 10 productos por importe vendido', type: 'bar', x: 40, y: 14,
                labels: topProductos.map(x => x[0]), values: topProductos.map(x => Number(x[1].importe.toFixed(2))),
                dataset: 'Importe vendido (€)', color: '#2563EB', money: true
            },
            {
                title: 'Productos con stock bajo: actual vs mínimo', type: 'bar', x: 40, y: 14,
                labels: topStock.map(p => String(p.nombre || p.codigo)),
                values: topStock.map(p => Number(p.stock || 0)),
                secondValues: topStock.map(p => Number(p.stock_minimo || 0)),
                dataset: 'Stock actual', secondDataset: 'Stock mínimo', color: '#D97706', money: false
            }
        ];
        const placements = [
            { col: 'B', row: 13 }, { col: 'F', row: 13 },
            { col: 'B', row: 35 }, { col: 'F', row: 35 }
        ];
        for (let i = 0; i < chartConfigs.length; i++) {
            const c = chartConfigs[i];
            const datasets = [{
                label: c.dataset,
                data: c.values,
                backgroundColor: c.type === 'doughnut'
                    ? ['#0F766E','#2563EB','#D97706','#7C3AED','#DC2626','#0891B2']
                    : c.color,
                borderColor: c.color || '#0F766E',
                borderWidth: c.type === 'line' ? 3 : 1,
                fill: false,
                tension: 0.25
            }];
            if (c.secondValues) datasets.push({
                label: c.secondDataset, data: c.secondValues,
                backgroundColor: '#CBD5E1', borderColor: '#94A3B8', borderWidth: 1
            });
            const config = {
                type: c.type,
                data: { labels: c.labels, datasets },
                options: {
                    responsive: false, animation: false,
                    plugins: { title: { display: true, text: c.title, font: { size: 18 } }, legend: { display: true, position: 'bottom' } },
                    scales: c.type === 'doughnut' ? {} : {
                        x: { ticks: { maxRotation: 45, minRotation: 0 } },
                        y: { beginAtZero: true, ticks: { callback: value => c.money ? dinero(value) : value } }
                    }
                }
            };
            const png = await chartCanvas.renderToBuffer(config, 'image/png');
            const imageId = wb.addImage({ buffer: png, extension: 'png' });
            const p = placements[i];
            dashboard.addImage(imageId, { tl: { col: p.col === 'B' ? 1 : 5, row: p.row - 1 }, ext: { width: 570, height: 266 } });
        }
        dashboard.views = [{ state: 'normal', showGridLines: false }];

        const stamp = new Date().toISOString().slice(0,10);
        const suffix = desde || hasta ? `_${desde || 'inicio'}_${hasta || 'hoy'}` : `_${stamp}`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="informe_puntoventa${suffix}.xlsx"`);
        await wb.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error('ERROR EXPORTACIÓN EXCEL:', error.message);
        if (!res.headersSent) res.status(500).json({ error: 'No se pudo generar el archivo Excel' });
        else res.end();
    }
});


// ============================================================
// ARRANQUE
// ============================================================
async function iniciarServidor() {
    try {
        await pool.query('SELECT 1');
        console.log('CONEXION EXITOSA');
        await prepararBaseDatos();

        app.listen(PORT, '0.0.0.0', () => {
            console.log(`Servidor disponible en el puerto ${PORT}`);
        });
    } catch (error) {
        console.error('NO SE PUDO INICIAR EL SERVIDOR:', error.message);
        process.exit(1);
    }
}

process.on('SIGINT', async () => {
    await pool.end();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    await pool.end();
    process.exit(0);
});

iniciarServidor()