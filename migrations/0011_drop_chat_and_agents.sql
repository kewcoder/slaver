-- Slaver now focuses on the app marketplace and customizing owned apps.
-- Chat, AI agents (slaveBots), channels, meetings, DMs, schedules, recaps,
-- AI skills, agent connectors, the kanban board, VPS deploys and team Fly dev
-- machines are gone (agents move to OpenClaw / Hermes). Children first.
DROP TABLE IF EXISTS run_steps;
DROP TABLE IF EXISTS runs;
DROP TABLE IF EXISTS meeting_messages;
DROP TABLE IF EXISTS meeting_participants;
DROP TABLE IF EXISTS meetings;
DROP TABLE IF EXISTS group_messages;
DROP TABLE IF EXISTS group_members;
DROP TABLE IF EXISTS groups;
DROP TABLE IF EXISTS direct_messages;
DROP TABLE IF EXISTS read_state;
DROP TABLE IF EXISTS bot_grants;
DROP TABLE IF EXISTS schedules;
DROP TABLE IF EXISTS summaries;
DROP TABLE IF EXISTS usage_logs;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS slavebots;
DROP TABLE IF EXISTS skills;
DROP TABLE IF EXISTS app_connectors;
DROP TABLE IF EXISTS issues;
DROP TABLE IF EXISTS deployments;
DROP TABLE IF EXISTS vps_targets;
DROP TABLE IF EXISTS fly_machines;
DROP TABLE IF EXISTS custom_domains;
