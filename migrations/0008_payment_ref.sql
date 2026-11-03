-- Reference id we send to HitPay (webhook matching without relying on shape).
ALTER TABLE payments ADD COLUMN reference TEXT NOT NULL DEFAULT '';
