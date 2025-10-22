require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Test database connection
pool.connect((err, client, release) => {
  if (err) {
    console.error('Error acquiring client', err.stack);
  } else {
    console.log('Database connected successfully');
    release();
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Sync data endpoint
app.post('/api/sync', async (req, res) => {
  try {
    const { userId, transactions, loans, products, settings } = req.body;
    
    // Validate required fields
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Start transaction
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      // Sync transactions
      if (transactions && Array.isArray(transactions)) {
        for (const transaction of transactions) {
          await client.query(
            `INSERT INTO transactions (user_id, date, product_id, product_name, quantity, order_price, selling_price, profit)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT DO NOTHING`,
            [userId, transaction.date, transaction.productId, transaction.productName, 
             transaction.quantity, transaction.orderPrice, transaction.sellingPrice, transaction.profit]
          );
        }
      }

      // Sync loans
      if (loans && Array.isArray(loans)) {
        for (const loan of loans) {
          await client.query(
            `INSERT INTO loans (user_id, loan_id, full_name, phone_number, national_id, date_taken, date_paid, total_amount, status, products, reminders, reminder_sent, last_reminder_date)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
             ON CONFLICT (loan_id) DO UPDATE SET
               full_name = EXCLUDED.full_name,
               phone_number = EXCLUDED.phone_number,
               national_id = EXCLUDED.national_id,
               date_taken = EXCLUDED.date_taken,
               date_paid = EXCLUDED.date_paid,
               total_amount = EXCLUDED.total_amount,
               status = EXCLUDED.status,
               products = EXCLUDED.products,
               reminders = EXCLUDED.reminders,
               reminder_sent = EXCLUDED.reminder_sent,
               last_reminder_date = EXCLUDED.last_reminder_date,
               updated_at = CURRENT_TIMESTAMP`,
            [userId, loan.id, loan.fullName, loan.phoneNumber, loan.nationalId, 
             loan.dateTaken, loan.datePaid, loan.totalAmount, loan.status,
             JSON.stringify(loan.products || []), JSON.stringify(loan.reminders || []),
             loan.reminderSent || false, loan.lastReminderDate]
          );
        }
      }

      // Sync products
      if (products && Array.isArray(products)) {
        for (const product of products) {
          await client.query(
            `INSERT INTO products (user_id, name, order_price, selling_price, reserve_stock, market_stock)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (user_id, name) DO UPDATE SET
               order_price = EXCLUDED.order_price,
               selling_price = EXCLUDED.selling_price,
               reserve_stock = EXCLUDED.reserve_stock,
               market_stock = EXCLUDED.market_stock,
               updated_at = CURRENT_TIMESTAMP`,
            [userId, product.name, product.orderPrice, product.sellingPrice, 
             product.reserveStock, product.marketStock]
          );
        }
      }

      // Sync settings
      if (settings) {
        await client.query(
          `INSERT INTO app_settings (user_id, settings)
           VALUES ($1, $2)
           ON CONFLICT (user_id) DO UPDATE SET
             settings = EXCLUDED.settings,
             updated_at = CURRENT_TIMESTAMP`,
          [userId, JSON.stringify(settings)]
        );
      }

      await client.query('COMMIT');
      
      res.json({ 
        success: true, 
        message: 'Data synced successfully',
        syncedAt: new Date().toISOString()
      });
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Sync error:', error);
    res.status(500).json({ error: 'Failed to sync data' });
  }
});

// Get user data endpoint
app.get('/api/data/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const client = await pool.connect();
    
    try {
      // Get transactions
      const transactionsResult = await client.query(
        'SELECT * FROM transactions WHERE user_id = $1 ORDER BY date DESC',
        [userId]
      );

      // Get loans
      const loansResult = await client.query(
        'SELECT * FROM loans WHERE user_id = $1 ORDER BY created_at DESC',
        [userId]
      );

      // Get products
      const productsResult = await client.query(
        'SELECT * FROM products WHERE user_id = $1',
        [userId]
      );

      // Get settings
      const settingsResult = await client.query(
        'SELECT settings FROM app_settings WHERE user_id = $1',
        [userId]
      );

      res.json({
        transactions: transactionsResult.rows.map(row => ({
          id: row.id,
          date: row.date,
          productId: row.product_id,
          productName: row.product_name,
          quantity: parseFloat(row.quantity),
          orderPrice: parseFloat(row.order_price),
          sellingPrice: parseFloat(row.selling_price),
          profit: parseFloat(row.profit)
        })),
        loans: loansResult.rows.map(row => ({
          id: row.loan_id,
          fullName: row.full_name,
          phoneNumber: row.phone_number,
          nationalId: row.national_id,
          dateTaken: row.date_taken,
          datePaid: row.date_paid,
          totalAmount: parseFloat(row.total_amount),
          status: row.status,
          products: row.products || [],
          reminders: row.reminders || [],
          reminderSent: row.reminder_sent,
          lastReminderDate: row.last_reminder_date
        })),
        products: productsResult.rows.map(row => ({
          id: row.id,
          name: row.name,
          orderPrice: parseFloat(row.order_price),
          sellingPrice: parseFloat(row.selling_price),
          reserveStock: parseFloat(row.reserve_stock),
          marketStock: parseFloat(row.market_stock)
        })),
        settings: settingsResult.rows[0]?.settings || {}
      });
      
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Get data error:', error);
    res.status(500).json({ error: 'Failed to fetch data' });
  }
});

// Real-time updates endpoint (WebSocket-like polling)
app.get('/api/updates/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { lastUpdate } = req.query;
    
    const client = await pool.connect();
    
    try {
      // Check for updates since last sync
      const updatesQuery = `
        SELECT 
          (SELECT COUNT(*) FROM transactions WHERE user_id = $1 AND created_at > $2) as new_transactions,
          (SELECT COUNT(*) FROM loans WHERE user_id = $1 AND updated_at > $2) as updated_loans,
          (SELECT COUNT(*) FROM products WHERE user_id = $1 AND updated_at > $2) as updated_products
      `;
      
      const result = await client.query(updatesQuery, [userId, lastUpdate || '1970-01-01']);
      
      res.json({
        hasUpdates: Object.values(result.rows[0]).some(count => parseInt(count) > 0),
        details: result.rows[0],
        serverTime: new Date().toISOString()
      });
      
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Updates check error:', error);
    res.status(500).json({ error: 'Failed to check updates' });
  }
});

// Start server
app.listen(port, () => {
  console.log(`GDFarms backend running on port ${port}`);
});
