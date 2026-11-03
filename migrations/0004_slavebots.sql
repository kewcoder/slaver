-- SlaveBots: named agents with user-set memory (previously: chats).
ALTER TABLE chats RENAME TO slavebots;
ALTER TABLE slavebots ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE slavebots ADD COLUMN memory TEXT NOT NULL DEFAULT '';
ALTER TABLE messages RENAME COLUMN chat_id TO slavebot_id;
ALTER TABLE usage_logs RENAME COLUMN chat_id TO slavebot_id;
UPDATE slavebots SET name = substr(title, 1, 30) WHERE name = '';
DROP INDEX IF EXISTS idx_chats_user;
DROP INDEX IF EXISTS idx_messages_chat;
DROP INDEX IF EXISTS idx_usage_user;
CREATE INDEX IF NOT EXISTS idx_slavebots_user ON slavebots(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_bot ON messages(slavebot_id, id);
CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_logs(user_id, id DESC);
