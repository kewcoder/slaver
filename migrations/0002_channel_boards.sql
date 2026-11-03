-- Channel boards: a group/channel can own one kanban project.
-- Issues stay on projects; the board is just filtered by the channel's project.
ALTER TABLE groups ADD COLUMN project_id TEXT NOT NULL DEFAULT '';
