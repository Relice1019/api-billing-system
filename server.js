const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const Redis = require('redis');
const crypto = require('crypto');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'api_billing',
    password: process.env.DB_PASSWORD || 'password',
    port: process.env.DB_PORT || 5432,
});

const redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD,
});

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const NEWAPI_URL = process.env.NEWAPI_URL || 'http://localhost:1234';
const NEWAPI_TOKEN = process.env.NEWAPI_TOKEN || '';

const MODEL_PRICING = {
    'gpt-3.5-turbo': { price_per_1k_tokens: 0.002, provider: 'openai' },
    'gpt-4': { price_per_1k_tokens: 0.06, provider: 'openai' },
    'gpt-4o': { price_per_1k_tokens: 0.015, provider: 'openai' },
    'claude-3-sonnet': { price_per_1k_tokens: 0.008, provider: 'anthropic' },
    'claude-3-5-sonnet': { price_per_1k_tokens: 0.015, provider: 'anthropic' },
    'gemini-pro': { price_per_1k_tokens: 0.001, provider: 'google' },
    'default': { price_per_1k_tokens: 0.002, provider: 'unknown' }
};

async function initDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                email VARCHAR(100) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                balance DECIMAL(10,2) DEFAULT 100.00,
                plan_id INTEGER DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS plans (
                id SERIAL PRIMARY KEY,
                name VARCHAR(50) NOT NULL,
                price_per_1k_tokens DECIMAL(6,4) NOT NULL,
                monthly_quota INTEGER,
                rate_limit_per_minute INTEGER DEFAULT 60
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS api_keys (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                key_name VARCHAR(100) NOT NULL,
                api_key VARCHAR(64) UNIQUE NOT NULL,
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_used_at TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS usage_records (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                api_key_id INTEGER REFERENCES api_keys(id),
                model VARCHAR(100),
                provider VARCHAR(50),
                tokens_used INTEGER NOT NULL,
                request_count INTEGER DEFAULT 1,
                endpoint VARCHAR(100),
                cost DECIMAL(8,4) NOT NULL,
                response_data JSONB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await pool.query(`
            INSERT INTO plans (name, price_per_1k_tokens, monthly_quota, rate_limit_per_minute) 
            VALUES 
                ('Basic', 0.0020, 10000, 60), 
                ('Pro', 0.0018, 100000, 120), 
                ('Enterprise', 0.0015, 1000000, 300)
            ON CONFLICT DO NOTHING
        `);

        console.log('Database initialized successfully');
    } catch (error) {
        console.error('Database initialization failed:', error);
    }
}

const getModelPricing = async (model) => {
    return MODEL_PRICING[model] || MODEL_PRICING['default'];
};

const authenticateAPI = async (req, res, next) => {
    try {
        const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
        if (!apiKey) {
            return res.status(401).json({ 
                error: { message: 'API key required', type: 'invalid_request_error' }
            });
        }

        let keyInfo = await redis.get(`api_key:${apiKey}`);
        
        if (!keyInfo) {
            const result = await pool.query(`
                SELECT ak.*, u.balance, u.plan_id, p.rate_limit_per_minute
                FROM api_keys ak 
                JOIN users u ON ak.user_id = u.id 
                JOIN plans p ON u.plan_id = p.id 
                WHERE ak.api_key = $1 AND ak.is_active = true
            `, [apiKey]);
            
            if (result.rows.length === 0) {
                return res.status(401).json({ 
                    error: { message: 'Invalid API key', type: 'invalid_request_error' }
                });
            }
            
            keyInfo = result.rows[0];
            await redis.setex(`api_key:${apiKey}`, 300, JSON.stringify(keyInfo));
        } else {
            keyInfo = JSON.parse(keyInfo);
        }

        if (keyInfo.balance <= 0) {
            return res.status(429).json({ 
                error: { message: 'Insufficient balance', type: 'insufficient_quota' }
            });
        }

        req.apiUser = keyInfo;
        
        await pool.query(
            'UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = $1',
            [keyInfo.id]
        );
        
        next();
    } catch (error) {
        console.error('API authentication error:', error);
        res.status(500).json({ 
            error: { message: 'Authentication failed', type: 'server_error' }
        });
    }
};

const rateLimit = async (req, res, next) => {
    const userId = req.apiUser.user_id;
    const limit = req.apiUser.rate_limit_per_minute || 60;
    const key = `rate_limit:${userId}:${Math.floor(Date.now() / 60000)}`;
    
    try {
        const current = await redis.incr(key);
        if (current === 1) {
            await redis.expire(key, 60);
        }
        
        if (current > limit) {
            return res.status(429).json({ 
                error: { message: `Rate limit exceeded. Maximum ${limit} requests per minute.`, type: 'rate_limit_exceeded' }
            });
        }
        
        res.set({
            'X-RateLimit-Limit': limit.toString(),
            'X-RateLimit-Remaining': Math.max(0, limit - current).toString()
        });
        
        next();
    } catch (error) {
        console.error('Rate limit error:', error);
        next();
    }
};

const recordUsageAndCharge = async (apiUser, tokensUsed, model, endpoint, responseData) => {
    try {
        const pricing = await getModelPricing(model);
        const cost = (tokensUsed * pricing.price_per_1k_tokens) / 1000;
        
        if (apiUser.balance < cost) {
            throw new Error('Insufficient balance');
        }
        
        await pool.query(`
            INSERT INTO usage_records (user_id, api_key_id, model, provider, tokens_used, endpoint, cost, response_data)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [apiUser.user_id, apiUser.id, model, pricing.provider, tokensUsed, endpoint, cost, responseData]);
        
        await pool.query(`
            UPDATE users SET balance = balance - $1 WHERE id = $2
        `, [cost, apiUser.user_id]);
        
        await redis.del(`api_key:${apiUser.api_key}`);
        
        console.log(`Charged $${cost.toFixed(6)} for ${tokensUsed} tokens (${model}) to user ${apiUser.user_id}`);
        
    } catch (error) {
        console.error('Failed to record usage:', error);
        throw error;
    }
};

const proxyToNewAPI = async (req, res) => {
    try {
        console.log(`Proxying ${req.method} ${req.path} to New API`);
        
        const headers = {
            'Content-Type': 'application/json',
            'User-Agent': 'API-Billing-Proxy/1.0'
        };
        
        if (NEWAPI_TOKEN) {
            headers['Authorization'] = `Bearer ${NEWAPI_TOKEN}`;
        }
        
        const targetUrl = `${NEWAPI_URL}${req.path}`;
        
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: headers,
            body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined,
            timeout: 120000
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`New API error (${response.status}):`, errorText);
            return res.status(response.status).json({
                error: { message: `Upstream API error: ${response.statusText}`, type: 'upstream_error' }
            });
        }
        
        const responseData = await response.json();
        
        if (req.path.includes('/chat/completions') && responseData.usage) {
            try {
                const model = req.body.model || 'gpt-3.5-turbo';
                const tokensUsed = responseData.usage.total_tokens || 0;
                
                if (tokensUsed > 0) {
                    await recordUsageAndCharge(
                        req.apiUser, 
                        tokensUsed, 
                        model, 
                        req.path,
                        { usage: responseData.usage, model: responseData.model }
                    );
                }
            } catch (billingError) {
                console.error('Billing error:', billingError);
            }
        }
        
        res.status(response.status).json(responseData);
        
    } catch (error) {
        console.error('Proxy error:', error);
        
        if (error.name === 'FetchError' || error.code === 'ECONNREFUSED') {
            return res.status(502).json({
                error: { message: 'New API service unavailable', type: 'service_unavailable' }
            });
        }
        
        res.status(500).json({
            error: { message: 'Proxy request failed', type: 'server_error' }
        });
    }
};

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });
        req.user = user;
        next();
    });
};

// Auth routes
app.post('/admin/auth/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        
        if (!username || !email || !password) {
            return res.status(400).json({ error: 'All fields are required' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        
        const result = await pool.query(
            'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email',
            [username, email, hashedPassword]
        );
        
        const user = result.rows[0];
        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
        
        res.json({ token, user });
    } catch (error) {
        if (error.code === '23505') {
            res.status(400).json({ error: 'Username or email already exists' });
        } else {
            console.error('Registration error:', error);
            res.status(500).json({ error: 'Registration failed' });
        }
    }
});

app.post('/admin/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        const result = await pool.query(
            'SELECT id, username, email, password_hash FROM users WHERE username = $1',
            [username]
        );
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const user = result.rows[0];
        const validPassword = await bcrypt.compare(password, user.password_hash);
        
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
        
        res.json({ 
            token, 
            user: { id: user.id, username: user.username, email: user.email }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

app.get('/admin/user/profile', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT u.id, u.username, u.email, u.balance, u.created_at, p.name as plan_name
            FROM users u 
            JOIN plans p ON u.plan_id = p.id 
            WHERE u.id = $1
        `, [req.user.id]);
        
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Profile fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch profile' });
    }
});

app.post('/admin/keys/generate', authenticateToken, async (req, res) => {
    try {
        const { keyName } = req.body;
        const apiKey = 'sk-' + crypto.randomBytes(32).toString('hex');
        
        const result = await pool.query(
            'INSERT INTO api_keys (user_id, key_name, api_key) VALUES ($1, $2, $3) RETURNING *',
            [req.user.id, keyName || 'Default Key', apiKey]
        );
        
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Key generation error:', error);
        res.status(500).json({ error: 'Failed to generate API key' });
    }
});

app.get('/admin/keys', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, key_name, api_key, is_active, created_at, last_used_at FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC',
            [req.user.id]
        );
        
        res.json(result.rows);
    } catch (error) {
        console.error('Keys fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch keys' });
    }
});

app.get('/admin/usage/stats', authenticateToken, async (req, res) => {
    try {
        const { period = 'month' } = req.query;
        
        let dateFilter = '';
        if (period === 'day') {
            dateFilter = "AND created_at >= CURRENT_DATE";
        } else if (period === 'week') {
            dateFilter = "AND created_at >= CURRENT_DATE - INTERVAL '7 days'";
        } else if (period === 'month') {
            dateFilter = "AND created_at >= DATE_TRUNC('month', CURRENT_DATE)";
        }
        
        const stats = await pool.query(`
            SELECT 
                COUNT(*) as total_requests,
                SUM(tokens_used) as total_tokens,
                SUM(cost) as total_cost,
                DATE(created_at) as date,
                model,
                provider
            FROM usage_records 
            WHERE user_id = $1 ${dateFilter}
            GROUP BY DATE(created_at), model, provider
            ORDER BY date DESC, total_cost DESC
            LIMIT 100
        `, [req.user.id]);
        
        const summary = await pool.query(`
            SELECT 
                COUNT(*) as total_requests,
                SUM(tokens_used) as total_tokens,
                SUM(cost) as total_cost
            FROM usage_records 
            WHERE user_id = $1 ${dateFilter}
        `, [req.user.id]);
        
        res.json({
            stats: stats.rows,
            summary: summary.rows[0] || { total_requests: 0, total_tokens: 0, total_cost: 0 }
        });
    } catch (error) {
        console.error('Stats fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// API routes
app.post('/v1/chat/completions', authenticateAPI, rateLimit, async (req, res) => {
    await proxyToNewAPI(req, res);
});

app.post('/v1/embeddings', authenticateAPI, rateLimit, async (req, res) => {
    await proxyToNewAPI(req, res);
});

app.get('/v1/models', authenticateAPI, async (req, res) => {
    await proxyToNewAPI(req, res);
});

app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        await redis.ping();
        
        res.json({
            status: 'healthy',
            database: 'connected',
            redis: 'connected',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            status: 'unhealthy',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function startServer() {
    await initDatabase();
    
    app.listen(PORT, () => {
        console.log(`🚀 API Billing System running on port ${PORT}`);
        console.log(`📊 Admin Dashboard: http://localhost:${PORT}/`);
        console.log(`🔗 API Endpoint: http://localhost:${PORT}/v1`);
        console.log(`🔍 Health Check: http://localhost:${PORT}/health`);
    });
}

startServer().catch(console.error);
