-- Retire the F&B Suite seed app: Hermes Agent is the only production listing.
-- Removes the "F&B Suite" template listing, its listing reviews, and the demo
-- buyer account's (resto@slaver.app) installed copy (projects + children,
-- licenses, payments, forks). Forks owned by any other team are left alone on
-- purpose: buyers keep what they bought. The boot seed (src/seed.rs) repeats
-- this cleanup and also removes the orphaned bare git repos from disk.
-- All statements are re-runnable.

-- Children of the demo account's F&B Suite projects.
DELETE FROM customize_changes WHERE project_id IN (SELECT p.id FROM projects p WHERE p.team_id IN (SELECT t.id FROM teams t JOIN users u ON u.id = t.owner_user_id WHERE u.email = 'resto@slaver.app') AND (p.repo_id IN (SELECT id FROM repos WHERE template = 1 AND (name LIKE 'F&B Suite%' OR name LIKE 'fnb-suite%')) OR p.repo_id IN (SELECT id FROM repos WHERE fork_of IN (SELECT id FROM repos WHERE template = 1 AND (name LIKE 'F&B Suite%' OR name LIKE 'fnb-suite%'))) OR p.name LIKE '%F&B Suite%' OR p.name LIKE '%Saung Ranggon%'));
DELETE FROM installs WHERE project_id IN (SELECT p.id FROM projects p WHERE p.team_id IN (SELECT t.id FROM teams t JOIN users u ON u.id = t.owner_user_id WHERE u.email = 'resto@slaver.app') AND (p.repo_id IN (SELECT id FROM repos WHERE template = 1 AND (name LIKE 'F&B Suite%' OR name LIKE 'fnb-suite%')) OR p.repo_id IN (SELECT id FROM repos WHERE fork_of IN (SELECT id FROM repos WHERE template = 1 AND (name LIKE 'F&B Suite%' OR name LIKE 'fnb-suite%'))) OR p.name LIKE '%F&B Suite%' OR p.name LIKE '%Saung Ranggon%'));
DELETE FROM local_runs WHERE project_id IN (SELECT p.id FROM projects p WHERE p.team_id IN (SELECT t.id FROM teams t JOIN users u ON u.id = t.owner_user_id WHERE u.email = 'resto@slaver.app') AND (p.repo_id IN (SELECT id FROM repos WHERE template = 1 AND (name LIKE 'F&B Suite%' OR name LIKE 'fnb-suite%')) OR p.repo_id IN (SELECT id FROM repos WHERE fork_of IN (SELECT id FROM repos WHERE template = 1 AND (name LIKE 'F&B Suite%' OR name LIKE 'fnb-suite%'))) OR p.name LIKE '%F&B Suite%' OR p.name LIKE '%Saung Ranggon%'));
DELETE FROM payments WHERE project_id IN (SELECT p.id FROM projects p WHERE p.team_id IN (SELECT t.id FROM teams t JOIN users u ON u.id = t.owner_user_id WHERE u.email = 'resto@slaver.app') AND (p.repo_id IN (SELECT id FROM repos WHERE template = 1 AND (name LIKE 'F&B Suite%' OR name LIKE 'fnb-suite%')) OR p.repo_id IN (SELECT id FROM repos WHERE fork_of IN (SELECT id FROM repos WHERE template = 1 AND (name LIKE 'F&B Suite%' OR name LIKE 'fnb-suite%'))) OR p.name LIKE '%F&B Suite%' OR p.name LIKE '%Saung Ranggon%'));

-- The demo projects themselves.
DELETE FROM projects WHERE id IN (SELECT p.id FROM projects p WHERE p.team_id IN (SELECT t.id FROM teams t JOIN users u ON u.id = t.owner_user_id WHERE u.email = 'resto@slaver.app') AND (p.repo_id IN (SELECT id FROM repos WHERE template = 1 AND (name LIKE 'F&B Suite%' OR name LIKE 'fnb-suite%')) OR p.repo_id IN (SELECT id FROM repos WHERE fork_of IN (SELECT id FROM repos WHERE template = 1 AND (name LIKE 'F&B Suite%' OR name LIKE 'fnb-suite%'))) OR p.name LIKE '%F&B Suite%' OR p.name LIKE '%Saung Ranggon%'));

-- Demo licenses and payments referencing the template or its forks.
DELETE FROM licenses WHERE repo_id IN (SELECT id FROM repos WHERE template = 1 AND (name LIKE 'F&B Suite%' OR name LIKE 'fnb-suite%')) AND team_id IN (SELECT t.id FROM teams t JOIN users u ON u.id = t.owner_user_id WHERE u.email = 'resto@slaver.app');
DELETE FROM payments WHERE team_id IN (SELECT t.id FROM teams t JOIN users u ON u.id = t.owner_user_id WHERE u.email = 'resto@slaver.app') AND (repo_id IN (SELECT id FROM repos WHERE template = 1 AND (name LIKE 'F&B Suite%' OR name LIKE 'fnb-suite%')) OR fork_repo_id IN (SELECT id FROM repos WHERE fork_of IN (SELECT id FROM repos WHERE template = 1 AND (name LIKE 'F&B Suite%' OR name LIKE 'fnb-suite%'))));

-- Reviews, then the demo forks and the template listings themselves.
DELETE FROM listing_reviews WHERE repo_id IN (SELECT id FROM repos WHERE template = 1 AND (name LIKE 'F&B Suite%' OR name LIKE 'fnb-suite%'));
DELETE FROM repos WHERE fork_of IN (SELECT id FROM repos WHERE template = 1 AND (name LIKE 'F&B Suite%' OR name LIKE 'fnb-suite%')) AND team_id IN (SELECT t.id FROM teams t JOIN users u ON u.id = t.owner_user_id WHERE u.email = 'resto@slaver.app');
DELETE FROM repos WHERE template = 1 AND (name LIKE 'F&B Suite%' OR name LIKE 'fnb-suite%');
