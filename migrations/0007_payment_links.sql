-- HitPay checkout bookkeeping: link payments to provisioned assets.
ALTER TABLE payments ADD COLUMN fork_repo_id TEXT NOT NULL DEFAULT '';
ALTER TABLE payments ADD COLUMN project_id TEXT NOT NULL DEFAULT '';
ALTER TABLE payments ADD COLUMN created_by TEXT NOT NULL DEFAULT '';
