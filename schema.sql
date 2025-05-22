-- Email Worker Database Schema for Cloudflare D1
-- This schema is designed to store email processing and expense tracking data
-- Designed for single-user use

-- Table to store processed emails
CREATE TABLE IF NOT EXISTS processed_emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL UNIQUE,
    subject TEXT,
    from_address TEXT NOT NULL,
    received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processed', 'failed', 'skipped')),
    is_reimbursable INTEGER NOT NULL DEFAULT 0
);

-- Table to store extracted expense information
CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_id INTEGER NOT NULL,
    amount DECIMAL(10, 2) NOT NULL CHECK(amount > 0),
    currency TEXT DEFAULT 'USD' CHECK(length(currency) = 3),
    description TEXT,
    expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
    category TEXT,
    vendor TEXT,
    is_reimbursable BOOLEAN NOT NULL DEFAULT 0,
    status TEXT NOT NULL GENERATED ALWAYS AS (
        CASE
            WHEN is_reimbursable = 0 THEN 'non_reimbursable'
            ELSE 'pending'
        END
    ) STORED,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (email_id) REFERENCES processed_emails(id) ON DELETE CASCADE,
    FOREIGN KEY (category) REFERENCES categories(name) ON UPDATE CASCADE,
    CHECK(
        (is_reimbursable = 0 AND status = 'non_reimbursable') OR
        (is_reimbursable = 1 AND status IN ('pending', 'approved', 'rejected', 'reimbursed'))
    )
);

-- Table to store expense categories
CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description TEXT,
    is_active BOOLEAN NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better query performance
-- Indexes for processed_emails
CREATE INDEX IF NOT EXISTS idx_processed_emails_message_id ON processed_emails(message_id);
CREATE INDEX IF NOT EXISTS idx_processed_emails_status ON processed_emails(status);
CREATE INDEX IF NOT EXISTS idx_processed_emails_received_at ON processed_emails(received_at);

-- Indexes for expenses
CREATE INDEX IF NOT EXISTS idx_expenses_email_id ON expenses(email_id);
CREATE INDEX IF NOT EXISTS idx_expenses_status ON expenses(status);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category);
CREATE INDEX IF NOT EXISTS idx_expenses_expense_date ON expenses(expense_date);
CREATE INDEX IF NOT EXISTS idx_expenses_amount ON expenses(amount);

-- Index for categories
CREATE INDEX IF NOT EXISTS idx_categories_name ON categories(name);

-- Add some initial categories if they don't exist
INSERT OR IGNORE INTO categories (name, description) VALUES
    ('Meals', 'Business meals and entertainment'),
    ('Travel', 'Airfare, hotels, and transportation'),
    ('Office Supplies', 'Office equipment and supplies'),
    ('Software', 'Software subscriptions and licenses'),
    ('Hardware', 'Computers and other hardware'),
    ('Training', 'Courses and educational materials'),
    ('Telecom', 'Phone and internet services'),
    ('Other', 'Miscellaneous expenses');
