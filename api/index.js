const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Ganti bagian const pool = mysql.createPool(...) di api/index.js menjadi seperti ini:
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'db_qondis',
    port: process.env.DB_PORT || 3306,
    // Wajib untuk Cloud MySQL (Aiven / TiDB) saat di Vercel:
    ssl: process.env.DB_HOST && process.env.DB_HOST !== 'localhost' 
        ? { rejectUnauthorized: false } 
        : undefined,
    waitForConnections: true,
    connectionLimit: 10
});

// Fungsi Auto-Migrate: Otomatis buat tabel & isi data awal jika database Cloud masih kosong
async function initDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                email VARCHAR(100) NOT NULL UNIQUE,
                password VARCHAR(255) NOT NULL,
                role ENUM('user', 'admin') DEFAULT 'user',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS products (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(150) NOT NULL,
                category VARCHAR(50) NOT NULL,
                condition_item VARCHAR(50) NOT NULL,
                price DECIMAL(12,2) NOT NULL,
                stock INT NOT NULL DEFAULT 1,
                image_url TEXT NOT NULL,
                description TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                total_price DECIMAL(12,2) NOT NULL,
                payment_method VARCHAR(50) NOT NULL,
                status ENUM('Menunggu Konfirmasi', 'Dikonfirmasi (ACC)', 'Ditolak') DEFAULT 'Menunggu Konfirmasi',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS order_items (
                id INT AUTO_INCREMENT PRIMARY KEY,
                order_id INT NOT NULL,
                product_id INT NOT NULL,
                quantity INT NOT NULL,
                price DECIMAL(12,2) NOT NULL
            )
        `);

        // Isi akun default jika tabel users masih kosong
        const [users] = await pool.query('SELECT COUNT(*) AS count FROM users');
        if (users[0].count === 0) {
            await pool.query(`
                INSERT INTO users (name, email, password, role) VALUES 
                ('Administrator Qondis', 'admin@qondis.com', 'admin123', 'admin'),
                ('Budi Pembeli', 'user@qondis.com', 'user123', 'user')
            `);
        }

        // Isi produk awal jika tabel products masih kosong
        const [prods] = await pool.query('SELECT COUNT(*) AS count FROM products');
        if (prods[0].count === 0) {
            await pool.query(`
                INSERT INTO products (name, category, condition_item, price, stock, image_url, description) VALUES
                ('Jaket Vintage Carhartt Detroit', 'Fashion', 'Like New (95%)', 850000, 3, 'https://images.unsplash.com/photo-1551028719-00167b16eac5?auto=format&fit=crop&w=600&q=80', 'Jaket vintage original kondisi sangat mulus, warna masih pekat.'),
                ('Kamera Analog Canon AE-1', 'Elektronik', 'Good (85%)', 1750000, 2, 'https://images.unsplash.com/photo-1516035069371-29a1b244cc32?auto=format&fit=crop&w=600&q=80', 'Lensa bersih bebas jamur, lightmeter hidup normal.'),
                ('Sepatu Nike Air Jordan 1 Low', 'Sneakers', 'Very Good (90%)', 1200000, 4, 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=600&q=80', 'Size 42 lengkap dengan box original, tapak masih tebal.'),
                ('Mechanical Keyboard Keychron K2', 'Elektronik', 'Like New (98%)', 780000, 5, 'https://images.unsplash.com/photo-1587829741301-dc798b83add3?auto=format&fit=crop&w=600&q=80', 'Brown switch, hotswappable, kabel lengkap.')
            `);
        }
    } catch (err) {
        console.error('Auto-init DB info:', err.message);
    }
}
initDatabase();
// ================= 1. AUTHENTICATION (REGISTER & LOGIN) =================

// Register User Baru
app.post('/api/register', async (req, res) => {
    try {
        const { name, email, password, role } = req.body;
        const userRole = role === 'admin' ? 'admin' : 'user';
        
        const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
        if (existing.length > 0) {
            return res.status(400).json({ message: 'Email sudah terdaftar!' });
        }

        await pool.query(
            'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
            [name, email, password, userRole]
        );
        res.status(201).json({ message: 'Registrasi berhasil! Silakan login.' });
    } catch (err) {
        res.status(500).json({ message: 'Gagal registrasi', error: err.message });
    }
});

// Login User / Admin
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const [rows] = await pool.query(
            'SELECT id, name, email, role FROM users WHERE email = ? AND password = ?',
            [email, password]
        );

        if (rows.length === 0) {
            return res.status(401).json({ message: 'Email atau password salah!' });
        }

        res.json({ message: 'Login berhasil', user: rows[0] });
    } catch (err) {
        res.status(500).json({ message: 'Gagal login', error: err.message });
    }
});

// ================= 2. MANAJEMEN PRODUK =================

// Ambil Semua Produk
app.get('/api/products', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM products ORDER BY id DESC');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ message: 'Gagal mengambil produk', error: err.message });
    }
});

// Tambah Produk Baru (Khusus Admin)
app.post('/api/products', async (req, res) => {
    try {
        const { name, category, condition_item, price, stock, image_url, description } = req.body;
        await pool.query(
            'INSERT INTO products (name, category, condition_item, price, stock, image_url, description) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [name, category, condition_item, price, stock, image_url, description]
        );
        res.status(201).json({ message: 'Produk berhasil ditambahkan!' });
    } catch (err) {
        res.status(500).json({ message: 'Gagal menambah produk', error: err.message });
    }
});

// Hapus Produk (Khusus Admin)
app.delete('/api/products/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM products WHERE id = ?', [req.params.id]);
        res.json({ message: 'Produk berhasil dihapus!' });
    } catch (err) {
        res.status(500).json({ message: 'Gagal menghapus produk', error: err.message });
    }
});

// ================= 3. TRANSAKSI & ORDER =================

// Buat Pesanan Baru / Checkout Dummy Pay (User)
app.post('/api/orders', async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const { user_id, payment_method, items } = req.body;

        let totalPrice = 0;
        for (const item of items) {
            totalPrice += item.price * item.quantity;
        }

        const [orderResult] = await connection.query(
            'INSERT INTO orders (user_id, total_price, payment_method, status) VALUES (?, ?, ?, ?)',
            [user_id, totalPrice, payment_method, 'Menunggu Konfirmasi']
        );
        const orderId = orderResult.insertId;

        for (const item of items) {
            await connection.query(
                'INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?, ?, ?, ?)',
                [orderId, item.id, item.quantity, item.price]
            );
            await connection.query(
                'UPDATE products SET stock = GREATEST(stock - ?, 0) WHERE id = ?',
                [item.quantity, item.id]
            );
        }

        await connection.commit();
        res.status(201).json({ message: 'Pembayaran berhasil dikirim! Menunggu konfirmasi Admin.', order_id: orderId });
    } catch (err) {
        await connection.rollback();
        res.status(500).json({ message: 'Gagal memproses pesanan', error: err.message });
    } finally {
        connection.release();
    }
});

// Lihat Riwayat & Status Pesanan (Untuk User Tertentu)
app.get('/api/orders/user/:userId', async (req, res) => {
    try {
        const [orders] = await pool.query(
            'SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC',
            [req.params.userId]
        );

        for (let order of orders) {
            const [items] = await pool.query(
                `SELECT oi.quantity, oi.price, p.name, p.image_url 
                 FROM order_items oi 
                 JOIN products p ON oi.product_id = p.id 
                 WHERE oi.order_id = ?`,
                [order.id]
            );
            order.items = items;
        }
        res.json(orders);
    } catch (err) {
        res.status(500).json({ message: 'Gagal mengambil pesanan', error: err.message });
    }
});

// Lihat Semua Pesanan Masuk (Khusus Admin)
app.get('/api/admin/orders', async (req, res) => {
    try {
        const [orders] = await pool.query(
            `SELECT o.*, u.name AS buyer_name, u.email AS buyer_email 
             FROM orders o 
             JOIN users u ON o.user_id = u.id 
             ORDER BY o.created_at DESC`
        );

        for (let order of orders) {
            const [items] = await pool.query(
                `SELECT oi.quantity, oi.price, p.name 
                 FROM order_items oi 
                 JOIN products p ON oi.product_id = p.id 
                 WHERE oi.order_id = ?`,
                [order.id]
            );
            order.items = items;
        }
        res.json(orders);
    } catch (err) {
        res.status(500).json({ message: 'Gagal mengambil semua pesanan', error: err.message });
    }
});

// Konfirmasi / ACC atau Tolak Pesanan (Khusus Admin)
app.put('/api/admin/orders/:id/status', async (req, res) => {
    try {
        const { status } = req.body; // 'Dikonfirmasi (ACC)' atau 'Ditolak'
        await pool.query('UPDATE orders SET status = ? WHERE id = ?', [status, req.params.id]);
        res.json({ message: `Status pesanan #${req.params.id} diubah menjadi: ${status}` });
    } catch (err) {
        res.status(500).json({ message: 'Gagal mengubah status pesanan', error: err.message });
    }
});

// Jalankan server jika di lokal (XAMPP)
const PORT = process.env.PORT || 3000;
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server Qondis berjalan di http://localhost:${PORT}`);
    });
}

// Export untuk serverless Vercel
module.exports = app;