const express = require('express');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcrypt');
const pool = require('./db');
const ExcelJS = require('exceljs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: process.env.SESSION_SECRET || 'drive_premium_secret_key_2024',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));

app.use(express.static(path.join(__dirname, 'public')));

// ============= АВТОРИЗАЦИЯ =============

app.post('/api/register', async (req, res) => {
    const { last_name, first_name, middle_name, email, password } = req.body;
    
    if (!last_name || !first_name || !email || !password) {
        return res.status(400).json({ error: 'Заполните все обязательные поля' });
    }
    
    try {
        const existingUser = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (existingUser.rows.length > 0) {
            return res.status(400).json({ error: 'Пользователь с таким email уже существует' });
        }
        
        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(password, saltRounds);
        
        const result = await pool.query(
            'INSERT INTO users (last_name, first_name, middle_name, email, password_hash, role_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, last_name, first_name, email',
            [last_name, first_name, middle_name || null, email, passwordHash, 2]
        );
        
        res.status(201).json({ message: 'Регистрация успешна!', user: result.rows[0] });
    } catch (err) {
        console.error('Ошибка регистрации:', err);
        res.status(500).json({ error: 'Ошибка при регистрации' });
    }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ error: 'Введите email и пароль' });
    }
    
    try {
        const result = await pool.query(
            `SELECT u.*, r.name as role_name 
             FROM users u 
             JOIN roles r ON u.role_id = r.id 
             WHERE u.email = $1`,
            [email]
        );
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Неверный email или пароль' });
        }
        
        const user = result.rows[0];
        const validPassword = await bcrypt.compare(password, user.password_hash);
        
        if (!validPassword) {
            return res.status(401).json({ error: 'Неверный email или пароль' });
        }
        
        req.session.user = {
            id: user.id,
            last_name: user.last_name,
            first_name: user.first_name,
            middle_name: user.middle_name,
            email: user.email,
            role: user.role_name,
            role_id: user.role_id
        };
        
        res.json({ message: 'Вход выполнен успешно', user: req.session.user });
    } catch (err) {
        console.error('Ошибка входа:', err);
        res.status(500).json({ error: 'Ошибка при входе' });
    }
});

app.get('/api/me', (req, res) => {
    if (req.session.user) {
        res.json({ user: req.session.user });
    } else {
        res.json({ user: null });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ error: 'Ошибка при выходе' });
        }
        res.json({ message: 'Выход выполнен успешно' });
    });
});

// ============= API ДЛЯ АВТОМОБИЛЕЙ =============

// 1. ВСЕ АВТОМОБИЛИ
app.get('/api/cars', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM cars ORDER BY id');
        res.json(result.rows);
    } catch (err) {
        console.error('Ошибка:', err);
        res.status(500).json({ error: 'Ошибка при получении автомобилей' });
    }
});

// 2. ПОИСК
app.get('/api/cars/search', async (req, res) => {
    const query = req.query.q;
    
    if (!query || query.trim() === '') {
        const result = await pool.query('SELECT * FROM cars ORDER BY id');
        return res.json(result.rows);
    }
    
    try {
        const result = await pool.query(
            `SELECT * FROM cars 
             WHERE model ILIKE $1 OR brand ILIKE $1 OR engine_type ILIKE $1 
             ORDER BY id`,
            [`%${query}%`]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Ошибка поиска:', err);
        res.status(500).json({ error: 'Ошибка при поиске' });
    }
});

// 3. ФИЛЬТРАЦИЯ
app.get('/api/cars/filter', async (req, res) => {
    const { minPrice, maxPrice, brand, engine_type, sort } = req.query;
    
    let sql = 'SELECT * FROM cars WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (minPrice && minPrice > 0) {
        sql += ` AND price >= $${paramIndex++}`;
        params.push(minPrice);
    }
    if (maxPrice && maxPrice > 0) {
        sql += ` AND price <= $${paramIndex++}`;
        params.push(maxPrice);
    }
    if (brand && brand !== 'all') {
        sql += ` AND brand ILIKE $${paramIndex++}`;
        params.push(`%${brand}%`);
    }
    if (engine_type && engine_type !== 'all') {
        sql += ` AND engine_type = $${paramIndex++}`;
        params.push(engine_type);
    }
    
    if (sort === 'price_asc') sql += ' ORDER BY price ASC';
    else if (sort === 'price_desc') sql += ' ORDER BY price DESC';
    else sql += ' ORDER BY id';
    
    try {
        const result = await pool.query(sql, params);
        res.json(result.rows);
    } catch (err) {
        console.error('Ошибка фильтрации:', err);
        res.status(500).json({ error: 'Ошибка при фильтрации' });
    }
});

// 4. БРЕНДЫ
app.get('/api/cars/brands', async (req, res) => {
    try {
        const result = await pool.query('SELECT DISTINCT brand FROM cars ORDER BY brand');
        res.json(result.rows.map(row => row.brand));
    } catch (err) {
        console.error('Ошибка получения брендов:', err);
        res.status(500).json({ error: 'Ошибка при получении брендов' });
    }
});

// 5. ПАГИНАЦИЯ
app.get('/api/cars/paginate', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 6;
    const search = req.query.search || '';
    const minPrice = req.query.minPrice;
    const maxPrice = req.query.maxPrice;
    const brand = req.query.brand;
    const engine_type = req.query.engine_type;
    const offset = (page - 1) * limit;
    
    try {
        let sqlCount = 'SELECT COUNT(*) as total FROM cars WHERE 1=1';
        let sqlData = 'SELECT * FROM cars WHERE 1=1';
        const params = [];
        let paramIndex = 1;
        
        if (search.trim() !== '') {
            sqlCount += ` AND (model ILIKE $${paramIndex} OR brand ILIKE $${paramIndex} OR engine_type ILIKE $${paramIndex})`;
            sqlData += ` AND (model ILIKE $${paramIndex} OR brand ILIKE $${paramIndex} OR engine_type ILIKE $${paramIndex})`;
            params.push(`%${search}%`);
            paramIndex++;
        }
        
        if (minPrice && minPrice > 0) {
            sqlCount += ` AND price >= $${paramIndex}`;
            sqlData += ` AND price >= $${paramIndex}`;
            params.push(minPrice);
            paramIndex++;
        }
        
        if (maxPrice && maxPrice > 0) {
            sqlCount += ` AND price <= $${paramIndex}`;
            sqlData += ` AND price <= $${paramIndex}`;
            params.push(maxPrice);
            paramIndex++;
        }
        
        if (brand && brand !== 'all') {
            sqlCount += ` AND brand ILIKE $${paramIndex}`;
            sqlData += ` AND brand ILIKE $${paramIndex}`;
            params.push(`%${brand}%`);
            paramIndex++;
        }
        
        if (engine_type && engine_type !== 'all') {
            sqlCount += ` AND engine_type = $${paramIndex}`;
            sqlData += ` AND engine_type = $${paramIndex}`;
            params.push(engine_type);
            paramIndex++;
        }
        
        sqlData += ` ORDER BY id LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        
        const countResult = await pool.query(sqlCount, params);
        const total = parseInt(countResult.rows[0].total);
        
        const dataResult = await pool.query(sqlData, [...params, limit, offset]);
        
        res.json({
            cars: dataResult.rows,
            total: total,
            page: page,
            limit: limit,
            totalPages: Math.ceil(total / limit)
        });
    } catch (err) {
        console.error('Ошибка при пагинации:', err);
        res.status(500).json({ error: 'Ошибка при получении данных' });
    }
});

// 6. ОДИН АВТОМОБИЛЬ ПО ID
app.get('/api/cars/:id', async (req, res) => {
    const id = req.params.id;
    if (isNaN(id)) {
        return res.status(400).json({ error: 'ID должен быть числом' });
    }
    try {
        const result = await pool.query('SELECT * FROM cars WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Автомобиль не найден' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Ошибка:', err);
        res.status(500).json({ error: 'Ошибка при получении автомобиля' });
    }
});

// 7. ДОБАВИТЬ (POST)
app.post('/api/cars', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') {
        return res.status(403).json({ error: 'Доступ запрещен' });
    }
    const { model, brand, price, year, engine_type } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO cars (model, brand, price, year, engine_type) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [model, brand, price, year, engine_type]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Ошибка:', err);
        res.status(500).json({ error: 'Ошибка при добавлении' });
    }
});

// 8. ОБНОВИТЬ (PUT)
app.put('/api/cars/:id', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') {
        return res.status(403).json({ error: 'Доступ запрещен' });
    }
    const id = req.params.id;
    const { model, brand, price, year, engine_type } = req.body;
    try {
        const result = await pool.query(
            'UPDATE cars SET model=$1, brand=$2, price=$3, year=$4, engine_type=$5 WHERE id=$6 RETURNING *',
            [model, brand, price, year, engine_type, id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Автомобиль не найден' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Ошибка:', err);
        res.status(500).json({ error: 'Ошибка при обновлении' });
    }
});

// 9. УДАЛИТЬ (DELETE)
app.delete('/api/cars/:id', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') {
        return res.status(403).json({ error: 'Доступ запрещен' });
    }
    const id = req.params.id;
    try {
        const result = await pool.query('DELETE FROM cars WHERE id = $1 RETURNING *', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Автомобиль не найден' });
        }
        res.json({ message: 'Автомобиль удален', car: result.rows[0] });
    } catch (err) {
        console.error('Ошибка:', err);
        res.status(500).json({ error: 'Ошибка при удалении' });
    }
});

// 10. ОТПРАВИТЬ ЗАЯВКУ
app.post('/api/requests', async (req, res) => {
    const { name, phone, email, car_id, message } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO requests (name, phone, email, car_id, message) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [name, phone, email, car_id, message]
        );
        res.status(201).json({ message: 'Заявка отправлена!', request: result.rows[0] });
    } catch (err) {
        console.error('Ошибка:', err);
        res.status(500).json({ error: 'Ошибка при отправке' });
    }
});

// ============= API ДЛЯ ЭКСПОРТА В EXCEL =============

// 11. ЭКСПОРТ ВСЕХ АВТОМОБИЛЕЙ В EXCEL
app.get('/api/cars/export/excel', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM cars ORDER BY id');
        const cars = result.rows;
        
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Автомобили');
        
        worksheet.columns = [
            { header: 'ID', key: 'id', width: 10 },
            { header: 'Модель', key: 'model', width: 25 },
            { header: 'Бренд', key: 'brand', width: 20 },
            { header: 'Цена (₽)', key: 'price', width: 15 },
            { header: 'Год выпуска', key: 'year', width: 12 },
            { header: 'Тип двигателя', key: 'engine_type', width: 15 },
            { header: 'Дата добавления', key: 'created_at', width: 20 }
        ];
        
        worksheet.getRow(1).font = { bold: true };
        worksheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: '0A4B8A' }
        };
        worksheet.getRow(1).font = { color: { argb: 'FFFFFFFF' } };
        
        cars.forEach(car => {
            worksheet.addRow({
                id: car.id,
                model: car.model,
                brand: car.brand,
                price: car.price,
                year: car.year,
                engine_type: car.engine_type || '—',
                created_at: car.created_at ? new Date(car.created_at).toLocaleDateString('ru-RU') : '—'
            });
        });
        
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="cars_export.xlsx"');
        
        await workbook.xlsx.write(res);
        res.end();
        
    } catch (err) {
        console.error('Ошибка при экспорте:', err);
        res.status(500).json({ error: 'Ошибка при экспорте данных' });
    }
});

// 12. ЭКСПОРТ С ФИЛЬТРАЦИЕЙ
app.get('/api/cars/export/excel/filtered', async (req, res) => {
    const { search, minPrice, maxPrice, brand, engine_type } = req.query;
    
    let sql = 'SELECT * FROM cars WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (search && search.trim() !== '') {
        sql += ` AND (model ILIKE $${paramIndex} OR brand ILIKE $${paramIndex} OR engine_type ILIKE $${paramIndex})`;
        params.push(`%${search}%`);
        paramIndex++;
    }
    
    if (minPrice && minPrice > 0) {
        sql += ` AND price >= $${paramIndex++}`;
        params.push(minPrice);
    }
    
    if (maxPrice && maxPrice > 0) {
        sql += ` AND price <= $${paramIndex++}`;
        params.push(maxPrice);
    }
    
    if (brand && brand !== 'all') {
        sql += ` AND brand ILIKE $${paramIndex++}`;
        params.push(`%${brand}%`);
    }
    
    if (engine_type && engine_type !== 'all') {
        sql += ` AND engine_type = $${paramIndex++}`;
        params.push(engine_type);
    }
    
    sql += ' ORDER BY id';
    
    try {
        const result = await pool.query(sql, params);
        const cars = result.rows;
        
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Автомобили');
        
        worksheet.columns = [
            { header: 'ID', key: 'id', width: 10 },
            { header: 'Модель', key: 'model', width: 25 },
            { header: 'Бренд', key: 'brand', width: 20 },
            { header: 'Цена (₽)', key: 'price', width: 15 },
            { header: 'Год выпуска', key: 'year', width: 12 },
            { header: 'Тип двигателя', key: 'engine_type', width: 15 },
            { header: 'Дата добавления', key: 'created_at', width: 20 }
        ];
        
        worksheet.getRow(1).font = { bold: true };
        worksheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: '0A4B8A' }
        };
        worksheet.getRow(1).font = { color: { argb: 'FFFFFFFF' } };
        
        cars.forEach(car => {
            worksheet.addRow({
                id: car.id,
                model: car.model,
                brand: car.brand,
                price: car.price,
                year: car.year,
                engine_type: car.engine_type || '—',
                created_at: car.created_at ? new Date(car.created_at).toLocaleDateString('ru-RU') : '—'
            });
        });
        
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="cars_filtered_export.xlsx"');
        
        await workbook.xlsx.write(res);
        res.end();
        
    } catch (err) {
        console.error('Ошибка при экспорте с фильтрацией:', err);
        res.status(500).json({ error: 'Ошибка при экспорте данных' });
    }
});

// ============= СТРАНИЦЫ =============

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/cars.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'cars.html')));
app.get('/offers.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'offers.html')));
app.get('/finance.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'finance.html')));
app.get('/about.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'about.html')));
app.get('/contacts.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'contacts.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/profile.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'profile.html')));

// АДМИН-СТРАНИЦЫ
app.get('/admin.html', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') {
        return res.send('<h1>🚫 Доступ запрещён</h1><a href="/">На главную</a>');
    }
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/admin-cars.html', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') {
        return res.send('<h1>🚫 Доступ запрещён</h1>');
    }
    res.sendFile(path.join(__dirname, 'public', 'admin-cars.html'));
});

app.get('/admin-car-add.html', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') {
        return res.send('<h1>🚫 Доступ запрещён</h1>');
    }
    res.sendFile(path.join(__dirname, 'public', 'admin-car-add.html'));
});

app.get('/admin-car-edit.html', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') {
        return res.send('<h1>🚫 Доступ запрещён</h1>');
    }
    res.sendFile(path.join(__dirname, 'public', 'admin-car-edit.html'));
});

// ЗАПУСК
app.listen(PORT, () => {
    console.log(`✅ Сервер запущен на http://localhost:${PORT}`);
    console.log(`📊 API для экспорта в Excel готов`);
});