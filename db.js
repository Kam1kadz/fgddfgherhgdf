const Database = require('better-sqlite3');
const db = new Database('arbuzbot.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS premium_users (
    discord_id TEXT PRIMARY KEY, 
    uid TEXT NOT NULL, 
    granted_by TEXT NOT NULL, 
    granted_at INTEGER NOT NULL, 
    expires_at INTEGER, 
    active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT, 
    user_id TEXT NOT NULL, 
    channel_id TEXT NOT NULL, 
    problem TEXT, 
    status TEXT DEFAULT 'open', 
    created_at INTEGER NOT NULL, 
    last_reply INTEGER,
    closed_by TEXT,
    closed_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS recruitment (
    type TEXT PRIMARY KEY, 
    enabled INTEGER DEFAULT 1
  );

  INSERT OR IGNORE INTO recruitment VALUES ('staff', 1), ('youtuber', 1), ('tiktoker', 1);
`);

module.exports = {
  addPremium: db.prepare("INSERT OR REPLACE INTO premium_users (discord_id, uid, granted_by, granted_at, expires_at, active) VALUES (?, ?, ?, ?, ?, 1)"),
  deactivatePremium: db.prepare("UPDATE premium_users SET active = 0 WHERE discord_id = ?"),
  getPremiumUser: db.prepare("SELECT * FROM premium_users WHERE discord_id = ? AND active = 1"),
  getPremiumByUid: db.prepare("SELECT * FROM premium_users WHERE uid = ? AND active = 1"),
  getAllActivePremiums: db.prepare("SELECT * FROM premium_users WHERE active = 1"),
  createTicket: db.prepare("INSERT INTO tickets (user_id, channel_id, problem, created_at, last_reply) VALUES (?, ?, ?, ?, ?)"),
  updateTicketReply: db.prepare("UPDATE tickets SET last_reply = ? WHERE channel_id = ?"),
  getOpenTicketByUser: db.prepare("SELECT * FROM tickets WHERE user_id = ? AND status = 'open'"),
  getTicketById: db.prepare("SELECT * FROM tickets WHERE id = ?"),
  closeTicket: db.prepare("UPDATE tickets SET status = 'closed', closed_by = ?, closed_at = ? WHERE id = ?"),
  getRecruitmentStatus: db.prepare("SELECT enabled FROM recruitment WHERE type = ?"),
  setRecruitmentStatus: db.prepare("UPDATE recruitment SET enabled = ? WHERE type = ?")
};