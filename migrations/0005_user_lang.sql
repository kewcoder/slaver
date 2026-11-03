-- UI language preference per user: 'en' (default) or 'id'.
ALTER TABLE users ADD COLUMN lang TEXT NOT NULL DEFAULT 'en';
