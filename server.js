require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = 3000;

// ============================================================
// BASE DE DATOS
// Pool permite varias consultas simultáneas y evita el problema
// de usar un único Client para todas las computadoras del POS.
// ============================================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    },
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
});

pool.on('error', error => {
    console.error('ERROR EN POOL POSTGRES:', error.message);
});

app.use(express.json({ limit: '1mb' }));
app.use(cors());
app.use(session({
    secret: process.env.SESSION_SECRET || 'clave-secreta-pos',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
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
app.post('/login', async (req, res) => {
    const usuario = String(req.body.usuario || '').trim();
    const password = String(req.body.password || '');

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
            return res.status(401).json({
                error: 'Usuario o contraseña incorrectos'
            });
        }

        const usuarioDB = resultado.rows[0];
        const correcta = await bcrypt.compare(password, usuarioDB.password);

        if (!correcta) {
            return res.status(401).json({
                error: 'Usuario o contraseña incorrectos'
            });
        }

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
                (codigo, nombre, marca, precio_compra, precio_venta, stock_minimo, stock)
            VALUES ($1, $2, $3, $4, $5, $6, 0)
            RETURNING *
        `, [
            String(codigo).trim(),
            String(nombre).trim(),
            String(marca || '').trim(),
            compra,
            venta,
            stockMinimo
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


app.post('/proveedores', requiereToken, async (req, res) => {

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


app.put('/proveedores/:id', requiereToken, async (req, res) => {

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


app.delete('/proveedores/:id', requiereToken, async (req, res) => {

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
        const efectivoEsperado = Number(caja.fondo_inicial) + Number(ventas.efectivo);

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
        const efectivoEsperado = Number(caja.fondo_inicial) + Number(datos.efectivo);
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