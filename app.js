process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const https = require('https');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// ── Güvenli HTML escape (XSS önleme) ──
function escapeHtml(str) {
    if (typeof str !== 'string') return str;
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

// ── Input sanitize (bio, mesaj vb. için) ──
function sanitizeInput(str, maxLen = 500) {
    if (typeof str !== 'string') return '';
    return escapeHtml(str.trim().slice(0, maxLen));
}

// SSE client connections map (key: userId, value: { res, connectedAt })
const sseClients = new Map();
const teamTypingStates = new Map();
const privateTypingStates = new Map();
const onlineActivity = new Map();

function touchUserOnline(userId) {
    if (userId) onlineActivity.set(String(userId), Date.now());
}

function isUserOnline(userId) {
    const id = String(userId);
    if (sseClients.has(id)) return true;
    const lastSeen = onlineActivity.get(id);
    return !!lastSeen && Date.now() - lastSeen < 90000;
}

// 📁 Klasör ve Veri Kontrolleri
const uploadDir = './public/uploads/avatars';
const ctfUploadDir = './public/files';
const scenarioBannerDir = './public/uploads/scenarios'; // YENİ: Senaryo Kapak Klasörü
const dataDir = './data';

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(ctfUploadDir)) fs.mkdirSync(ctfUploadDir, { recursive: true });
if (!fs.existsSync(scenarioBannerDir)) fs.mkdirSync(scenarioBannerDir, { recursive: true }); // YENİ
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// JSON Dosya Yolları
const labsDataPath = path.join(__dirname, 'data', 'labs.json');
const ctfDataPath = path.join(__dirname, 'data', 'ctf.json');
const systemDataPath = path.join(__dirname, 'data', 'system.json');
const scenariosDataPath = path.join(__dirname, 'data', 'scenarios.json'); // YENİ
const teamsDataPath = path.join(__dirname, 'data', 'teams.json'); // TAKIM
const firstbloodPath = path.join(__dirname, 'data', 'firstblood.json'); // İLK KAN
const badgesPath     = path.join(__dirname, 'data', 'badges.json');     // ROZETLER
const bansPath       = path.join(__dirname, 'data', 'bans.json');        // YASAKLAR
const ticketsPath    = path.join(__dirname, 'data', 'tickets.json');     // DESTEK TALEPLERİ
const adminsPath     = path.join(__dirname, 'data', 'admins.json');      // ADMİNLER
const privateMessagesPath = path.join(__dirname, 'data', 'private-messages.json'); // ÖZEL MESAJLAR

// ⚙️ JSON OKUMA/YAZMA YARDIMCI FONKSİYONLARI
function getLabs() {
    if (!fs.existsSync(labsDataPath)) return {};
    return JSON.parse(fs.readFileSync(labsDataPath, 'utf8'));
}

function saveLabs(data) {
    fs.writeFileSync(labsDataPath, JSON.stringify(data, null, 4), 'utf8');
}

function getCtfChallenges() {
    if (!fs.existsSync(ctfDataPath)) return {};
    return JSON.parse(fs.readFileSync(ctfDataPath, 'utf8'));
}

function saveCtfChallenges(data) {
    fs.writeFileSync(ctfDataPath, JSON.stringify(data, null, 4), 'utf8');
}

// 📢 SİSTEM YARDIMCI FONKSİYONLARI
function getSystemData() {
    if (!fs.existsSync(systemDataPath)) {
        const defaultData = { announcement: "Defendia Network Defense'e hoş geldiniz!", notifications: [] };
        fs.writeFileSync(systemDataPath, JSON.stringify(defaultData, null, 4), 'utf8');
        return defaultData;
    }
    return JSON.parse(fs.readFileSync(systemDataPath, 'utf8'));
}

function saveSystemData(data) {
    fs.writeFileSync(systemDataPath, JSON.stringify(data, null, 4), 'utf8');
}

// 🗺️ SENARYO YARDIMCI FONKSİYONLARI (YENİ)
function getScenarios() {
    if (!fs.existsSync(scenariosDataPath)) return {};
    return JSON.parse(fs.readFileSync(scenariosDataPath, 'utf8'));
}

function saveScenarios(data) {
    fs.writeFileSync(scenariosDataPath, JSON.stringify(data, null, 4), 'utf8');
}

// 👑 ADMİN YÖNETİMİ YARDIMCI FONKSİYONLARI
function getAdmins() {
    if (!fs.existsSync(adminsPath)) { fs.writeFileSync(adminsPath, '["cansarihan"]', 'utf8'); return ['cansarihan']; }
    try { return JSON.parse(fs.readFileSync(adminsPath, 'utf8')); } catch(e) { return ['cansarihan']; }
}
function saveAdmins(data) {
    fs.writeFileSync(adminsPath, JSON.stringify(data, null, 2), 'utf8');
}

// 🎫 DESTEK TALEBİ YARDIMCI FONKSİYONLARI
function getTickets() {
    if (!fs.existsSync(ticketsPath)) { fs.writeFileSync(ticketsPath, '{}', 'utf8'); return {}; }
    try { return JSON.parse(fs.readFileSync(ticketsPath, 'utf8')); } catch(e) { return {}; }
}
function saveTickets(data) {
    fs.writeFileSync(ticketsPath, JSON.stringify(data, null, 4), 'utf8');
}

// 🚫 YASAK YARDIMCI FONKSİYONLARI
function getBans() {
    if (!fs.existsSync(bansPath)) { fs.writeFileSync(bansPath, '{}', 'utf8'); return {}; }
    try { return JSON.parse(fs.readFileSync(bansPath, 'utf8')); } catch(e) { return {}; }
}
function saveBans(data) {
    fs.writeFileSync(bansPath, JSON.stringify(data, null, 4), 'utf8');
}
function isUserBanned(userId) {
    const bans = getBans();
    const ban = bans[String(userId)];
    if (!ban || !ban.active) return null;
    if (ban.expiresAt && new Date() > new Date(ban.expiresAt)) {
        // Süre dolmuş — otomatik kaldır
        ban.active = false;
        saveBans(bans);
        return null;
    }
    return ban;
}

// 🏅 ROZET YARDIMCI FONKSİYONLARI
function getBadges() {
    if (!fs.existsSync(badgesPath)) { fs.writeFileSync(badgesPath, '{}', 'utf8'); return {}; }
    try { return JSON.parse(fs.readFileSync(badgesPath, 'utf8')); } catch(e) { return {}; }
}
function saveBadges(data) {
    fs.writeFileSync(badgesPath, JSON.stringify(data, null, 4), 'utf8');
}

// Kullanıcı için rozet listesi hesapla
function calcUserBadges(user, ctfChallenges, labs, scenarios, firstbloodData) {
    const allBadges = getBadges();
    const result = [];
    const username = user.username;
    const solved = user.solved || [];

    Object.values(allBadges).forEach(b => {
        let earned = false;
        if (b.type === 'special') {
            earned = (b.assignedTo || []).includes(username);
        } else if (b.type === 'auto_all') {
            earned = true; // herkese
        } else if (b.type === 'auto_firstblood') {
            const myFBs = Object.values(firstbloodData).filter(f => f.username === username);
            if (myFBs.length > 0) {
                result.push({
                    ...b,
                    name: `İlk Kan x${myFBs.length}`,
                    firstbloods: myFBs.map(f => ({
                        title: f.challengeTitle || '—',
                        solvedAt: f.solvedAt
                    }))
                });
                return;
            }
        } else if (b.type === 'auto_ctf') {
            const allCtfIds = Object.keys(ctfChallenges);
            earned = allCtfIds.length > 0 && allCtfIds.every(id => solved.includes(id));
        } else if (b.type === 'auto_lab') {
            const allLabIds = Object.keys(labs);
            earned = allLabIds.length > 0 && allLabIds.every(id => solved.includes(id));
        } else if (b.type === 'auto_scenario') {
            const allSceIds = [];
            Object.values(scenarios).forEach(s => (s.tasks||[]).forEach(t => allSceIds.push(`${s.id}_task_${t.id}`)));
            earned = allSceIds.length > 0 && allSceIds.every(id => solved.includes(id));
        } else if (b.type === 'manual') {
            earned = (b.assignedTo || []).includes(username);
        }
        if (earned) result.push({ ...b });
    });
    return result;
}

// 🏆 TAKIM YARDIMCI FONKSİYONLARI
function getTeams() {
    if (!fs.existsSync(teamsDataPath)) { fs.writeFileSync(teamsDataPath, '{}', 'utf8'); return {}; }
    try { return JSON.parse(fs.readFileSync(teamsDataPath, 'utf8')); } catch(e) { return {}; }
}

function saveTeams(data) {
    fs.writeFileSync(teamsDataPath, JSON.stringify(data, null, 4), 'utf8');
}

function getPrivateMessages() {
    if (!fs.existsSync(privateMessagesPath)) {
        fs.writeFileSync(privateMessagesPath, JSON.stringify({ conversations: {}, blocks: {} }, null, 4), 'utf8');
        return { conversations: {}, blocks: {} };
    }
    try {
        const data = JSON.parse(fs.readFileSync(privateMessagesPath, 'utf8'));
        if (!data.conversations) data.conversations = {};
        if (!data.blocks) data.blocks = {};
        return data;
    } catch(e) {
        return { conversations: {}, blocks: {} };
    }
}

function savePrivateMessages(data) {
    fs.writeFileSync(privateMessagesPath, JSON.stringify(data, null, 4), 'utf8');
}

function getPrivateConversationId(a, b) {
    return [String(a), String(b)].sort().join('_');
}

function canAccessPrivateConversation(conv, userId) {
    return conv && Array.isArray(conv.participants) && conv.participants.includes(String(userId));
}

function isInvitedToPrivateGroup(conv, userId) {
    return conv && conv.type === 'group' && Array.isArray(conv.invited) && conv.invited.includes(String(userId));
}

function makePrivateSystemMessage(convId, message) {
    return {
        id: `${Date.now()}_system_${Math.random().toString(36).slice(2, 7)}`,
        conversationId: convId,
        type: 'system',
        senderId: 'system',
        senderUsername: 'Sistem',
        senderAvatar: null,
        message,
        createdAt: new Date().toISOString()
    };
}

function isPrivateBlocked(data, blockerId, targetId) {
    const blocked = data && data.blocks && Array.isArray(data.blocks[String(blockerId)]) ? data.blocks[String(blockerId)] : [];
    return blocked.includes(String(targetId));
}

function getUserBadgeSummary(user, limit = 3) {
    if (!user) return [];
    const badges = calcUserBadges(user, getCtfChallenges(), getLabs(), getScenarios(), getFirstBlood());
    return badges.slice(0, limit).map(b => ({
        id: b.id,
        icon: b.icon || '🏅',
        name: b.name,
        color: b.color || '#38bdf8',
        desc: b.name === 'Kurucu' ? 'Defendia Network Defense\'nın kurucusu. Platform\'un yaratıcısı ve baş mimarı.' :
              b.name === 'CTF Editörü' ? 'CTF görevlerini oluşturan ve yöneten editör.' :
              b.name === 'Beta' ? 'Defendia Network Defense\'nın beta test sürecine katılan ilk operatörlerden biri.' :
              (b.name || '').startsWith('İlk Kan') ? 'Bir veya daha fazla görevi platformda ilk çözen operatör.' :
              b.name === 'CTF Avcısı' ? 'Platformdaki tüm CTF görevlerini başarıyla tamamladı!' :
              b.name === 'Lab Avcısı' ? 'Platformdaki tüm laboratuvar makinelerini ele geçirdi!' :
              b.name === 'Senaryo Avcısı' ? 'Platformdaki tüm operasyon senaryolarını tamamladı!' :
              b.desc || 'Özel rozet.',
        extraCount: badges.length > limit ? badges.length - limit : 0
    }));
}

function resolveUserAvatar(user) {
    if (!user) return null;
    if (user.avatar && typeof user.avatar === 'string') return user.avatar;
    try {
        const id = String(user.id);
        if (!fs.existsSync(uploadDir)) return null;
        const files = fs.readdirSync(uploadDir)
            .filter(file => file.startsWith(`user-${id}-`) || file.startsWith(`${id}_`))
            .sort((a, b) => {
                const aTime = fs.statSync(path.join(uploadDir, a)).mtimeMs;
                const bTime = fs.statSync(path.join(uploadDir, b)).mtimeMs;
                return bTime - aTime;
            });
        return files[0] ? `/uploads/avatars/${files[0]}` : null;
    } catch(e) {
        return null;
    }
}

function sendPrivateEvent(userIds, payload) {
    userIds.forEach(uid => {
        const id = String(uid);
        if (!sseClients.has(id)) return;
        try {
            sseClients.get(id).res.write(`data: ${JSON.stringify(payload)}\n\n`);
        } catch(e) {
            sseClients.delete(id);
        }
    });
}

function getPrivateUnreadCount(userId) {
    const currentUserId = String(userId);
    const data = getPrivateMessages();
    const unreadMessages = Object.values(data.conversations)
        .filter(conv => canAccessPrivateConversation(conv, currentUserId))
        .reduce((total, conv) => {
            const lastReadAt = conv.readBy && conv.readBy[currentUserId] ? new Date(conv.readBy[currentUserId]).getTime() : 0;
            return total + (conv.messages || []).filter(m =>
                String(m.senderId) !== currentUserId &&
                new Date(m.createdAt).getTime() > lastReadAt
            ).length;
        }, 0);
    const pendingInvites = Object.values(data.conversations)
        .filter(conv => isInvitedToPrivateGroup(conv, currentUserId)).length;
    return unreadMessages + pendingInvites;
}

// 🩸 İLK KAN YARDIMCI FONKSİYONLARI
function getFirstBlood() {
    if (!fs.existsSync(firstbloodPath)) { fs.writeFileSync(firstbloodPath, '{}', 'utf8'); return {}; }
    try { return JSON.parse(fs.readFileSync(firstbloodPath, 'utf8')); } catch(e) { return {}; }
}
function saveFirstBlood(data) {
    fs.writeFileSync(firstbloodPath, JSON.stringify(data, null, 4), 'utf8');
}
// Bir challenge'ı ilk çözen kişiyi kaydet, bildirim gönder
function recordFirstBlood(challengeId, challengeTitle, userId, username) {
    const fb = getFirstBlood();
    if (fb[challengeId]) return; // Zaten var
    fb[challengeId] = { 
        userId: String(userId), 
        username, 
        solvedAt: new Date().toISOString(),
        challengeTitle,
        pendingNotify: String(userId) // Bu kullanıcıya henüz gösterilmedi
    };
    saveFirstBlood(fb);
    // Tüm kullanıcılara broadcast (çevrimiçi olanlar için)
    const notif = {
        id: Date.now().toString(),
        type: 'firstblood',
        message: `🩸 İLK KAN! "${username}" → "${challengeTitle}" görevini ilk çözdü!`,
        severity: 'danger',
        sound: true,
        createdAt: new Date().toISOString()
    };
    sseClients.forEach((client, uid) => {
        try { client.res.write(`data: ${JSON.stringify(notif)}\n\n`); } catch(e) { sseClients.delete(uid); }
    });
}

// Kullanıcının takımını bul
function getUserTeam(userId) {
    const teams = getTeams();
    return Object.values(teams).find(t => t.members.includes(String(userId))) || null;
}

// Takım puanını hesapla
function calcTeamPoints(team) {
    const labs = getLabs();
    const ctf = getCtfChallenges();
    const scenarios = getScenarios();
    let total = 0;
    (team.members || []).forEach(uid => {
        const u = db.findUserById(uid);
        if (!u) return;
        (u.solved || []).forEach(id => {
            if (labs[id])  total += labs[id].points || 0;
            if (ctf[id])   total += ctf[id].points || 0;
            Object.values(scenarios).forEach(s => {
                const task = (s.tasks || []).find(t => `${s.id}_task_${t.id}` === id);
                if (task) total += task.points || 0;
            });
        });
    });
    return total;
}

function normalizeTeamChat(team) {
    if (!Array.isArray(team.chatMessages)) team.chatMessages = [];
    team.chatMessages = team.chatMessages.slice(-200);
    return team.chatMessages;
}

function sendTeamChatEvent(team, payload) {
    (team.members || []).forEach(uid => {
        const id = String(uid);
        if (!sseClients.has(id)) return;
        try {
            sseClients.get(id).res.write(`data: ${JSON.stringify(payload)}\n\n`);
        } catch(e) {
            sseClients.delete(id);
        }
    });
}

// SSE ile bildirim gönder (pending'e de ekle)
function sendNotification(targetUserId, notification) {
    const uid = String(targetUserId);
    if (sseClients.has(uid)) {
        try {
            sseClients.get(uid).res.write(`data: ${JSON.stringify(notification)}\n\n`);
            return;
        } catch(e) { sseClients.delete(uid); }
    }
    // Çevrimdışı — pending'e ekle
    const sysData = getSystemData();
    if (!sysData.pendingNotifications) sysData.pendingNotifications = {};
    if (!sysData.pendingNotifications[uid]) sysData.pendingNotifications[uid] = [];
    sysData.pendingNotifications[uid].push(notification);
    saveSystemData(sysData);
}

// 🔍 ARAMA VERİSİ YARDIMCI FONKSİYONU (YENİ - Task 4)
function getSearchData() {
    const labs = getLabs();
    const ctfChallenges = getCtfChallenges();
    const scenarios = getScenarios();
    
    return {
        ctf: Object.values(ctfChallenges).map(c => ({ id: c.id, title: c.title, points: c.points })),
        labs: Object.values(labs).map(l => ({ id: l.id, title: l.title, points: l.points })),
        scenarios: Object.values(scenarios).map(s => ({ id: s.id, title: s.title, points: s.points }))
    };
}

// ⚙️ AVATAR YÜKLEME YAPILANDIRMASI
const storage = multer.diskStorage({
    destination: (req, file, cb) => { cb(null, uploadDir); },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'user-' + req.session.userId + '-' + uniqueSuffix + path.extname(file.originalname).toLowerCase());
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedExtensions = /jpeg|jpg|png/;
        const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png'];
        const extname = allowedExtensions.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedMimes.includes(file.mimetype);
        if (extname && mimetype) return cb(null, true);
        else cb(new Error('GÜVENLİK HATASI: Sadece .png, .jpg ve .jpeg yükleyebilirsiniz!'));
    }
});

// ⚙️ CTF DOSYA YÜKLEME YAPILANDIRMASI
const ctfStorage = multer.diskStorage({
    destination: (req, file, cb) => { cb(null, ctfUploadDir); },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'challenge-' + uniqueSuffix + path.extname(file.originalname).toLowerCase());
    }
});

const uploadCtf = multer({ 
    storage: ctfStorage,
    limits: { fileSize: 20 * 1024 * 1024 }, 
    fileFilter: (req, file, cb) => {
        const allowedExtensions = /jpeg|jpg|png|zip|pcap/;
        const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png', 'application/zip', 'application/x-zip-compressed', 'application/octet-stream'];
        const extname = allowedExtensions.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedMimes.includes(file.mimetype);
        if (extname && mimetype) return cb(null, true);
        else cb(new Error('HATA: Sadece .png, .jpg, .jpeg, .zip ve .pcap yükleyebilirsiniz!'));
    }
});

// 🖼️ YENİ: SENARYO BANNER YÜKLEME YAPILANDIRMASI
const scenarioStorage = multer.diskStorage({
    destination: (req, file, cb) => { cb(null, scenarioBannerDir); },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'banner-' + uniqueSuffix + path.extname(file.originalname).toLowerCase());
    }
});

const uploadScenario = multer({ 
    storage: scenarioStorage,
    limits: { fileSize: 5 * 1024 * 1024 }, 
    fileFilter: (req, file, cb) => {
        const allowedExtensions = /jpeg|jpg|png/;
        const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png'];
        const extname = allowedExtensions.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedMimes.includes(file.mimetype);
        if (extname && mimetype) return cb(null, true);
        else cb(new Error('HATA: Sadece .png, .jpg, .jpeg yükleyebilirsiniz!'));
    }
});

const PVE_NODE = process.env.PVE_NODE || 'pve';
const PVE_IP   = process.env.PVE_IP; // .env üzerinden verilir
const API_TOKEN = process.env.PVE_API_TOKEN;

const proxmox = axios.create({
  baseURL: `https://${PVE_IP}:8006/api2/json`,
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  headers: { 'Authorization': API_TOKEN },
  timeout: 30000  // 30 saniye — full clone için yeterli
});

function generateRandomMac() {
    const hex = '0123456789ABCDEF';
    let mac = '02'; 
    for (let i = 0; i < 5; i++) { mac += ':' + hex.charAt(Math.floor(Math.random() * 16)) + hex.charAt(Math.floor(Math.random() * 16)); }
    return mac;
}

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use('/uploads', express.static('public/uploads'));
app.use('/files', express.static('public/files'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: process.env.SESSION_SECRET || 'defendia_fallback_secret_change_me',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,      // JS erişimi yok
        sameSite: 'strict',  // CSRF koruması
        maxAge: 8 * 60 * 60 * 1000  // 8 saat
        // secure: true — HTTPS kullanıyorsanız açın
    }
}));

// ── Rate Limiting ──
// Login/Register: 15 dakikada max 20 deneme
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { success: false, error: 'Çok fazla deneme. 15 dakika sonra tekrar deneyin.' },
    standardHeaders: true,
    legacyHeaders: false
});

// Flag submit: 1 dakikada max 30 deneme
const flagLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: { success: false, message: 'Çok hızlı deneme yapıyorsunuz. Biraz bekleyin.' }
});

// Genel API: 1 dakikada max 120 istek
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    message: { success: false, error: 'İstek limiti aşıldı.' }
});

app.use('/login', authLimiter);
app.use('/register', authLimiter);
app.use('/api/submit-flag', flagLimiter);
app.use('/api/submit-scenario-task', flagLimiter);
app.use('/api/', apiLimiter);

// --- MIDDLEWARES ---
const checkAuth = (req, res, next) => {
    if (!req.session.userId) return res.redirect('/login');
    touchUserOnline(req.session.userId);
    const user = db.findUserById(req.session.userId);
    if (user) {
        req._isAdmin = getAdmins().includes(user.username);
        res.locals.currentUserIsAdmin = req._isAdmin;
    }
    next();
};

const isAdmin = (req, res, next) => {
    const user = db.findUserById(req.session.userId);
    const admins = getAdmins();
    if (user && admins.includes(user.username)) next();
    else {
        res.status(403).send(`<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Erişim Engellendi</title>
  <link rel="icon" type="image/png" href="/favicon.png">
  <style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{background:#080c18;display:flex;align-items:center;justify-content:center;height:100vh;font-family:'Inter',sans-serif;overflow:hidden;}
    canvas{position:fixed;inset:0;z-index:0;opacity:0.06;pointer-events:none;}
    .box{position:relative;z-index:1;max-width:480px;width:92%;background:rgba(10,15,30,0.98);border:2px solid #ef4444;border-radius:20px;padding:48px 36px;text-align:center;box-shadow:0 0 80px rgba(239,68,68,0.3);}
    .icon{font-size:64px;margin-bottom:16px;}
    .label{font-size:10px;letter-spacing:4px;color:#ef4444;text-transform:uppercase;font-weight:800;margin-bottom:14px;font-family:'JetBrains Mono',monospace;}
    .title{font-size:20px;color:#f1f5f9;font-weight:700;margin-bottom:10px;}
    .desc{font-size:13px;color:#64748b;line-height:1.6;margin-bottom:28px;}
    .btn{display:inline-flex;align-items:center;gap:8px;padding:12px 28px;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.4);border-radius:8px;color:#ef4444;font-size:12px;font-weight:700;text-decoration:none;font-family:'JetBrains Mono',monospace;letter-spacing:1px;transition:all 0.2s;}
    .btn:hover{background:rgba(239,68,68,0.25);}
    .corner{position:absolute;width:16px;height:16px;opacity:0.6;}
    .tl{top:12px;left:12px;border-top:2px solid #ef4444;border-left:2px solid #ef4444;border-radius:2px 0 0 0;}
    .tr{top:12px;right:12px;border-top:2px solid #ef4444;border-right:2px solid #ef4444;border-radius:0 2px 0 0;}
    .bl{bottom:12px;left:12px;border-bottom:2px solid #ef4444;border-left:2px solid #ef4444;border-radius:0 0 0 2px;}
    .br{bottom:12px;right:12px;border-bottom:2px solid #ef4444;border-right:2px solid #ef4444;border-radius:0 0 2px 0;}
  </style>
</head>
<body>
<canvas id="m"></canvas>
<div class="box">
  <div class="corner tl"></div><div class="corner tr"></div>
  <div class="corner bl"></div><div class="corner br"></div>
  <div class="icon">🚫</div>
  <div class="label">ERİŞİM ENGELLENDİ</div>
  <div class="title">Bu Bölüm İçin Yetkiniz Yok</div>
  <div class="desc">Bu sayfaya erişmek için admin yetkisine sahip olmanız gerekmektedir. Eğer bunun bir hata olduğunu düşünüyorsanız platform yöneticisiyle iletişime geçin.</div>
  <a href="/dashboard" class="btn">← Ana Sayfaya Dön</a>
</div>
<script>
const c=document.getElementById('m'),ctx=c.getContext('2d');
c.width=window.innerWidth;c.height=window.innerHeight;
const d=Array(Math.ceil(c.width/16)).fill(1);
setInterval(()=>{ctx.fillStyle='rgba(8,12,24,0.05)';ctx.fillRect(0,0,c.width,c.height);ctx.fillStyle='#38bdf8';ctx.font='13px monospace';d.forEach((y,i)=>{ctx.fillText(Math.floor(Math.random()*2),i*16,y*16);if(y*16>c.height&&Math.random()>0.975)d[i]=0;d[i]++;});},60);
</script>
</body>
</html>`);
    }
};

// --- ROUTES ---

app.get('/', checkAuth, (req, res) => res.redirect('/dashboard'));

app.get('/dashboard', checkAuth, (req, res) => {
    const user = db.findUserById(req.session.userId);
    const labs = getLabs();
    const ctfChallenges = getCtfChallenges();
    const scenarios = getScenarios();
    const systemData = getSystemData();
    const searchData = getSearchData();
    
    const stats = {};
    const userSolved = user.solved || [];
    
    Object.values(ctfChallenges).forEach(c => {
        if (!stats[c.category]) stats[c.category] = { total: 0, solved: 0 };
        stats[c.category].total++;
        if (userSolved.includes(c.id)) stats[c.category].solved++;
    });

    Object.values(scenarios).forEach(s => {
        const cat = "Senaryolar";
        if (!stats[cat]) stats[cat] = { total: 0, solved: 0 };
        const tasks = s.tasks || [];
        stats[cat].total += tasks.length;
        tasks.forEach(task => {
            if (userSolved.includes(`${s.id}_task_${task.id}`)) stats[cat].solved++;
        });
    });

    // Max puan hesapla
    let maxPoints = 0;
    Object.values(labs).forEach(l => maxPoints += l.points || 0);
    Object.values(ctfChallenges).forEach(c => maxPoints += c.points || 0);
    Object.values(scenarios).forEach(s => (s.tasks||[]).forEach(t => maxPoints += t.points || 0));
    if (!maxPoints) maxPoints = 1;

    const solvedSet = new Set(userSolved);
    const calcPoints = (solvedIds) => {
        let total = 0;
        solvedIds.forEach(id => {
            if (labs[id]) total += labs[id].points || 0;
            if (ctfChallenges[id]) total += ctfChallenges[id].points || 0;
            Object.values(scenarios).forEach(s => {
                const task = (s.tasks || []).find(t => `${s.id}_task_${t.id}` === id);
                if (task) total += task.points || 0;
            });
        });
        return total;
    };

    const labList = Object.values(labs);
    const ctfList = Object.values(ctfChallenges);
    const scenarioTaskList = Object.values(scenarios).flatMap(s =>
        (s.tasks || []).map(task => ({
            id: `${s.id}_task_${task.id}`,
            title: `${s.title} / ${task.title}`,
            type: 'Senaryo',
            difficulty: s.difficulty || 'Orta',
            points: task.points || 0,
            href: `/scenario/${s.id}`
        }))
    );
    const challengeList = [
        ...labList.map(l => ({
            id: l.id,
            title: l.title,
            type: 'Lab',
            difficulty: l.difficulty || 'Orta',
            points: l.points || 0,
            href: '/lab'
        })),
        ...ctfList.map(c => ({
            id: c.id,
            title: c.title,
            type: c.category || 'CTF',
            difficulty: c.difficulty || 'CTF',
            points: c.points || 0,
            href: '/ctf'
        })),
        ...scenarioTaskList
    ];

    const difficultyOrder = { 'Kolay': 1, 'Orta': 2, 'Zor': 3, 'CTF': 4 };
    const nextTargets = challengeList
        .filter(item => !solvedSet.has(item.id))
        .sort((a, b) => (difficultyOrder[a.difficulty] || 9) - (difficultyOrder[b.difficulty] || 9) || a.points - b.points)
        .slice(0, 4);

    const recentSolves = Object.entries(user.solvedDates || {})
        .map(([id, solvedAt]) => {
            const item = challengeList.find(c => c.id === id);
            return item ? { ...item, solvedAt } : null;
        })
        .filter(Boolean)
        .sort((a, b) => new Date(b.solvedAt) - new Date(a.solvedAt))
        .slice(0, 4);

    const difficultyStats = ['Kolay', 'Orta', 'Zor'].map(label => {
        const items = [
            ...labList.filter(l => (l.difficulty || 'Orta') === label).map(l => l.id),
            ...scenarioTaskList.filter(t => t.difficulty === label).map(t => t.id)
        ];
        return {
            label,
            total: items.length,
            solved: items.filter(id => solvedSet.has(id)).length
        };
    });

    const dashboardData = {
        points: calcPoints(userSolved),
        remainingPoints: Math.max(0, maxPoints - calcPoints(userSolved)),
        totals: {
            labs: labList.length,
            labsSolved: labList.filter(l => solvedSet.has(l.id)).length,
            ctf: ctfList.length,
            ctfSolved: ctfList.filter(c => solvedSet.has(c.id)).length,
            scenarioTasks: scenarioTaskList.length,
            scenarioTasksSolved: scenarioTaskList.filter(t => solvedSet.has(t.id)).length,
            all: challengeList.length,
            solved: challengeList.filter(c => solvedSet.has(c.id)).length
        },
        nextTargets,
        recentSolves,
        difficultyStats
    };

    // Dashboard için rozet hesapla
    const dashBadges = calcUserBadges(user, ctfChallenges, labs, scenarios, getFirstBlood());

    res.render('dashboard', { 
        user, stats, labs, ctfChallenges, scenarios,
        systemAnnouncement: systemData.announcement,
        systemNotifications: systemData.notifications,
        searchData, maxPoints, dashBadges, dashboardData
    });
});

app.get('/scenarios', checkAuth, (req, res) => {
    const user = db.findUserById(req.session.userId);
    const scenarios = getScenarios();
    const searchData = getSearchData();
    res.render('scenarios', { user, scenarios, searchData });
});

app.get('/scenario/:id', checkAuth, (req, res) => {
    const user = db.findUserById(req.session.userId);
    const scenarios = getScenarios();
    const scenario = scenarios[req.params.id];
    const searchData = getSearchData();
    if (!scenario) return res.redirect('/scenarios');

    if (!user.scenario_progress) user.scenario_progress = {};
    const currentTaskIndex = user.scenario_progress[scenario.id] || 0;

    res.render('scenario-detail', { user, scenario, currentTaskIndex, searchData });
});

app.get('/lab', checkAuth, (req, res) => {
    const user = db.findUserById(req.session.userId);
    const labs = getLabs();
    const searchData = getSearchData();
    res.render('lab', { user, labs, searchData });
});

app.get('/ctf', checkAuth, (req, res) => {
    const user = db.findUserById(req.session.userId);
    const ctfChallenges = getCtfChallenges();
    const searchData = getSearchData();
    const solvedSet = new Set(user.solved || []);
    const challenges = Object.values(ctfChallenges);
    const getDifficulty = (points) => points <= 75 ? 'Kolay' : (points <= 150 ? 'Orta' : 'Zor');
    const totalPoints = challenges.reduce((sum, c) => sum + (c.points || 0), 0);
    const solvedChallenges = challenges.filter(c => solvedSet.has(c.id));
    const solvedPoints = solvedChallenges.reduce((sum, c) => sum + (c.points || 0), 0);

    const categoryStats = {};
    challenges.forEach(c => {
        const category = c.category || 'Diğer';
        if (!categoryStats[category]) categoryStats[category] = { total: 0, solved: 0, points: 0, solvedPoints: 0 };
        categoryStats[category].total++;
        categoryStats[category].points += c.points || 0;
        if (solvedSet.has(c.id)) {
            categoryStats[category].solved++;
            categoryStats[category].solvedPoints += c.points || 0;
        }
    });

    const difficultyStats = ['Kolay', 'Orta', 'Zor'].map(label => {
        const items = challenges.filter(c => getDifficulty(c.points || 0) === label);
        return {
            label,
            total: items.length,
            solved: items.filter(c => solvedSet.has(c.id)).length,
            points: items.reduce((sum, c) => sum + (c.points || 0), 0)
        };
    });

    const nextTargets = challenges
        .filter(c => !solvedSet.has(c.id))
        .sort((a, b) => (a.points || 0) - (b.points || 0))
        .slice(0, 4)
        .map(c => ({
            id: c.id,
            title: c.title,
            category: c.category || 'Diğer',
            points: c.points || 0,
            difficulty: getDifficulty(c.points || 0),
            hasDownload: !!c.download
        }));

    const recentSolves = Object.entries(user.solvedDates || {})
        .filter(([id]) => ctfChallenges[id])
        .map(([id, solvedAt]) => ({
            id,
            title: ctfChallenges[id].title,
            category: ctfChallenges[id].category || 'Diğer',
            points: ctfChallenges[id].points || 0,
            solvedAt
        }))
        .sort((a, b) => new Date(b.solvedAt) - new Date(a.solvedAt))
        .slice(0, 4);

    const ctfData = {
        totalPoints,
        solvedPoints,
        remainingPoints: Math.max(0, totalPoints - solvedPoints),
        downloadableCount: challenges.filter(c => c.download).length,
        categoryStats,
        difficultyStats,
        nextTargets,
        recentSolves
    };

    res.render('ctf', { user, challenges: ctfChallenges, searchData, ctfData });
});

// --- PROXMOX CANLI VERİ API (admin.ejs ve dashboard.ejs için) ---
app.get('/api/admin/pve-live-stats', checkAuth, isAdmin, async (req, res) => {
    try {
        // 3 isteği paralel gönder — sıralı değil, toplam max 3s bekler
        const [nodeStatus, storageData, vmData] = await Promise.all([
            proxmox.get(`/nodes/${PVE_NODE}/status`),
            proxmox.get(`/nodes/${PVE_NODE}/storage`),
            proxmox.get(`/nodes/${PVE_NODE}/qemu`)
        ]);

        const nData = nodeStatus.data.data;
        const disks = storageData.data.data.map(d => ({
            name: d.storage,
            total: (d.total / (1024**3)).toFixed(1),
            used: (d.used / (1024**3)).toFixed(1)
        }));
        const vms = vmData.data.data.map(vm => ({
            vmid: vm.vmid,
            name: vm.name,
            status: vm.status,
            cpu: (vm.cpu * 100).toFixed(1),
            ram: (vm.mem / (1024**2)).toFixed(0)
        }));

        res.json({
            success: true,
            status: "OK",
            temp: 45,
            cpu: (nData.cpu * 100).toFixed(1),
            ram: { total: 128, used: (nData.memory.used / (1024**3)).toFixed(1) },
            disks,
            vms
        });
    } catch (err) {
        // Proxmox erişilemez — sessizce hata dön, sunucuyu bloke etme
        res.json({ success: false, error: 'Proxmox bağlantısı kurulamadı.' });
    }
});

// Admin sayfasının ilk yüklenmesi (Hata almamak için boş obje gönderiyoruz, JS dolduracak)
app.get('/admin', checkAuth, isAdmin, (req, res) => {
    const users = db.getUsers();
    const labs = getLabs();
    const ctfChallenges = getCtfChallenges();
    const scenarios = getScenarios();
    const systemData = getSystemData();
    const searchData = getSearchData();

    res.render('admin', { 
        user: db.findUserById(req.session.userId),
        users, labs, ctfChallenges, scenarios,
        systemAnnouncement: systemData.announcement,
        systemNotifications: systemData.notifications,
        pve: null, // İlk başta null gönderiyoruz, Scripts.ejs saniyeler içinde dolduracak
        searchData
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

app.get('/users', checkAuth, (req, res) => {
    const currentUser = db.findUserById(req.session.userId);
    const users = db.getUsers();
    const labs = getLabs();
    const ctfChallenges = getCtfChallenges();
    const scenarios = getScenarios();
    const searchData = getSearchData();

    const teams = getTeams();
    const allUsersData = users.map(u => {
        let p = 0;
        (u.solved || []).forEach(id => { 
            if(labs[id]) p += labs[id].points; 
            if(ctfChallenges[id]) p += ctfChallenges[id].points; 
            Object.values(scenarios || {}).forEach(s => {
                const task = (s.tasks || []).find(t => `${s.id}_task_${t.id}` === id);
                if (task) p += task.points || 0;
            });
        });
        // Kullanıcının takımını bul
        const userTeam = Object.values(teams).find(t => t.members.includes(String(u.id)));
        return { username: u.username, points: p, solvedCount: (u.solved || []).length, avatar: u.avatar || null, teamName: userTeam ? userTeam.name : null };
    }).sort((a,b) => b.points - a.points);

    let maxPoints = 0;
    Object.values(getLabs()).forEach(l => maxPoints += l.points || 0);
    Object.values(ctfChallenges).forEach(c => maxPoints += c.points || 0);
    Object.values(scenarios).forEach(s => (s.tasks||[]).forEach(t => maxPoints += t.points || 0));
    if (!maxPoints) maxPoints = 1;

    res.render('users', { user: currentUser, allUsersData, searchData, maxPoints });
});

app.get(['/messages', '/sohbetlerim'], checkAuth, (req, res) => {
    const user = db.findUserById(req.session.userId);
    const searchData = getSearchData();
    res.render('messages', { user, searchData });
});

app.get('/api/pm/users', checkAuth, (req, res) => {
    const currentUserId = String(req.session.userId);
    const users = db.getUsers()
        .filter(u => String(u.id) !== currentUserId)
        .map(u => ({
            id: String(u.id),
            username: u.username,
            avatar: resolveUserAvatar(u),
            online: isUserOnline(u.id),
            badges: getUserBadgeSummary(u)
        }))
        .sort((a, b) => a.username.localeCompare(b.username, 'tr'));
    res.json({ success: true, users });
});

app.get('/api/pm/conversations', checkAuth, (req, res) => {
    const currentUserId = String(req.session.userId);
    const data = getPrivateMessages();
    const users = db.getUsers();
    const conversations = Object.values(data.conversations)
        .filter(conv => canAccessPrivateConversation(conv, currentUserId))
        .map(conv => {
            const isGroup = conv.type === 'group';
            const otherId = conv.participants.find(id => String(id) !== currentUserId);
            const other = users.find(u => String(u.id) === String(otherId));
            const messages = conv.messages || [];
            const lastMessage = messages[messages.length - 1] || null;
            const lastReadAt = conv.readBy && conv.readBy[currentUserId] ? new Date(conv.readBy[currentUserId]).getTime() : 0;
            const unreadCount = messages.filter(m => String(m.senderId) !== currentUserId && new Date(m.createdAt).getTime() > lastReadAt).length;
            return {
                id: conv.id,
                type: isGroup ? 'group' : 'direct',
                isGroup,
                name: isGroup ? conv.name : null,
                ownerId: conv.ownerId || null,
                memberCount: isGroup ? (conv.participants || []).length : 2,
                invitedCount: isGroup ? (conv.invited || []).length : 0,
                otherUser: isGroup ? {
                    id: conv.id,
                    username: conv.name || 'Grup sohbeti',
                    avatar: null,
                    online: false,
                    group: true,
                    badges: []
                } : (other ? {
                    id: String(other.id),
                    username: other.username,
                    avatar: resolveUserAvatar(other),
                    online: isUserOnline(other.id),
                    badges: getUserBadgeSummary(other)
                } : { id: otherId, username: 'Bilinmeyen', avatar: null, online: false, badges: [] }),
                blockedByMe: !isGroup && otherId ? isPrivateBlocked(data, currentUserId, otherId) : false,
                blockedMe: !isGroup && otherId ? isPrivateBlocked(data, otherId, currentUserId) : false,
                lastMessage,
                unreadCount,
                updatedAt: conv.updatedAt || conv.createdAt
            };
        })
        .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    res.json({ success: true, conversations });
});

app.get('/api/pm/unread-count', checkAuth, (req, res) => {
    res.json({ success: true, unreadCount: getPrivateUnreadCount(req.session.userId) });
});

app.post('/api/pm/block', checkAuth, (req, res) => {
    const currentUserId = String(req.session.userId);
    const targetUser = db.findUserById(req.body.targetUserId);
    if (!targetUser) return res.json({ success: false, message: 'Kullanıcı bulunamadı.' });
    if (String(targetUser.id) === currentUserId) return res.json({ success: false, message: 'Kendinizi engelleyemezsiniz.' });

    const data = getPrivateMessages();
    if (!data.blocks) data.blocks = {};
    if (!Array.isArray(data.blocks[currentUserId])) data.blocks[currentUserId] = [];
    if (!data.blocks[currentUserId].includes(String(targetUser.id))) {
        data.blocks[currentUserId].push(String(targetUser.id));
    }
    savePrivateMessages(data);
    res.json({ success: true, blocked: true, targetUserId: String(targetUser.id), message: `${targetUser.username} engellendi.` });
});

app.post('/api/pm/unblock', checkAuth, (req, res) => {
    const currentUserId = String(req.session.userId);
    const targetUser = db.findUserById(req.body.targetUserId);
    if (!targetUser) return res.json({ success: false, message: 'Kullanıcı bulunamadı.' });

    const data = getPrivateMessages();
    if (!data.blocks) data.blocks = {};
    data.blocks[currentUserId] = (data.blocks[currentUserId] || []).filter(id => String(id) !== String(targetUser.id));
    savePrivateMessages(data);
    res.json({ success: true, blocked: false, targetUserId: String(targetUser.id), message: `${targetUser.username} engeli kaldırıldı.` });
});

app.get('/api/pm/group-invites', checkAuth, (req, res) => {
    const currentUserId = String(req.session.userId);
    const users = db.getUsers();
    const data = getPrivateMessages();
    const invites = Object.values(data.conversations)
        .filter(conv => isInvitedToPrivateGroup(conv, currentUserId))
        .map(conv => {
            const owner = users.find(u => String(u.id) === String(conv.ownerId));
            return {
                id: conv.id,
                name: conv.name,
                ownerUsername: owner ? owner.username : 'Bilinmeyen',
                memberCount: (conv.participants || []).length,
                invitedAt: conv.invitedAt && conv.invitedAt[currentUserId] ? conv.invitedAt[currentUserId] : conv.updatedAt
            };
        })
        .sort((a, b) => new Date(b.invitedAt || 0) - new Date(a.invitedAt || 0));
    res.json({ success: true, invites });
});

app.post('/api/pm/conversations', checkAuth, (req, res) => {
    const currentUser = db.findUserById(req.session.userId);
    const targetId = String(req.body.targetUserId || '');
    const targetUser = db.findUserById(targetId);
    if (!targetUser) return res.json({ success: false, message: 'Kullanıcı bulunamadı.' });
    if (String(targetUser.id) === String(currentUser.id)) return res.json({ success: false, message: 'Kendinize sohbet açamazsınız.' });

    const data = getPrivateMessages();
    const convId = getPrivateConversationId(currentUser.id, targetUser.id);
    if (!data.conversations[convId]) {
        data.conversations[convId] = {
            id: convId,
            type: 'direct',
            participants: [String(currentUser.id), String(targetUser.id)],
            messages: [],
            readBy: { [String(currentUser.id)]: new Date().toISOString() },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        savePrivateMessages(data);
    }
    res.json({ success: true, conversationId: convId });
});

app.post('/api/pm/groups', checkAuth, (req, res) => {
    const currentUser = db.findUserById(req.session.userId);
    const name = sanitizeInput(req.body.name || '', 50).trim();
    const memberIds = Array.isArray(req.body.memberIds) ? req.body.memberIds.map(id => String(id)) : [];
    const uniqueInvites = [...new Set(memberIds)]
        .filter(id => id !== String(currentUser.id))
        .slice(0, 20);

    if (name.length < 3) return res.json({ success: false, message: 'Grup adı en az 3 karakter olmalı.' });
    if (!uniqueInvites.length) return res.json({ success: false, message: 'En az bir kullanıcı davet etmelisiniz.' });

    const validUsers = db.getUsers().filter(u => uniqueInvites.includes(String(u.id)));
    if (!validUsers.length) return res.json({ success: false, message: 'Davet edilecek kullanıcı bulunamadı.' });

    const now = new Date().toISOString();
    const convId = `group_${Date.now()}_${currentUser.id}`;
    const invited = validUsers.map(u => String(u.id));
    const invitedAt = invited.reduce((acc, id) => ({ ...acc, [id]: now }), {});
    const data = getPrivateMessages();
    const systemMessage = makePrivateSystemMessage(convId, `${currentUser.username} "${name}" grubunu oluşturdu.`);

    data.conversations[convId] = {
        id: convId,
        type: 'group',
        name,
        ownerId: String(currentUser.id),
        participants: [String(currentUser.id)],
        invited,
        rejected: [],
        invitedAt,
        messages: [systemMessage],
        readBy: { [String(currentUser.id)]: now },
        createdAt: now,
        updatedAt: now
    };
    savePrivateMessages(data);

    sendPrivateEvent(invited, {
        id: Date.now().toString(),
        type: 'pm_group_invite',
        conversationId: convId,
        groupName: name,
        ownerUsername: currentUser.username,
        createdAt: now
    });

    res.json({ success: true, conversationId: convId });
});

app.post('/api/pm/groups/:id/respond', checkAuth, (req, res) => {
    const currentUser = db.findUserById(req.session.userId);
    const currentUserId = String(currentUser.id);
    const action = String(req.body.action || '').toLowerCase();
    const data = getPrivateMessages();
    const conv = data.conversations[req.params.id];

    if (!isInvitedToPrivateGroup(conv, currentUserId)) {
        return res.status(403).json({ success: false, message: 'Bu grup davetine erişiminiz yok.' });
    }
    if (!['accept', 'reject'].includes(action)) {
        return res.json({ success: false, message: 'Geçersiz işlem.' });
    }

    const now = new Date().toISOString();
    conv.invited = (conv.invited || []).filter(id => String(id) !== currentUserId);
    conv.invitedAt = conv.invitedAt || {};
    delete conv.invitedAt[currentUserId];
    conv.messages = Array.isArray(conv.messages) ? conv.messages : [];

    let systemMessage;
    if (action === 'accept') {
        if (!conv.participants.includes(currentUserId)) conv.participants.push(currentUserId);
        systemMessage = makePrivateSystemMessage(conv.id, `${currentUser.username} gruba katıldı.`);
        if (!conv.readBy) conv.readBy = {};
        conv.readBy[currentUserId] = systemMessage.createdAt;
    } else {
        if (!Array.isArray(conv.rejected)) conv.rejected = [];
        if (!conv.rejected.includes(currentUserId)) conv.rejected.push(currentUserId);
        systemMessage = makePrivateSystemMessage(conv.id, `${currentUser.username} grup davetini reddetti.`);
    }

    conv.messages.push(systemMessage);
    conv.messages = conv.messages.slice(-500);
    conv.updatedAt = systemMessage.createdAt;
    data.conversations[conv.id] = conv;
    savePrivateMessages(data);

    sendPrivateEvent([...new Set([...(conv.participants || []), currentUserId])], {
        id: Date.now().toString(),
        type: 'pm_group_update',
        conversationId: conv.id,
        message: systemMessage,
        action,
        userId: currentUserId,
        username: currentUser.username,
        createdAt: now
    });

    res.json({ success: true, conversationId: conv.id, action, message: systemMessage });
});

app.get('/api/pm/conversations/:id/members', checkAuth, (req, res) => {
    const currentUserId = String(req.session.userId);
    const data = getPrivateMessages();
    const conv = data.conversations[req.params.id];
    if (!canAccessPrivateConversation(conv, currentUserId)) return res.status(403).json({ success: false, message: 'Yetkisiz erişim.' });

    const users = db.getUsers();
    const userMap = new Map(users.map(u => [String(u.id), u]));
    const members = (conv.participants || []).map(id => {
        const u = userMap.get(String(id));
        return u ? {
            id: String(u.id),
            username: u.username,
            avatar: resolveUserAvatar(u),
            online: isUserOnline(u.id),
            owner: String(u.id) === String(conv.ownerId),
            badges: getUserBadgeSummary(u)
        } : null;
    }).filter(Boolean);
    const invited = (conv.invited || []).map(id => {
        const u = userMap.get(String(id));
        return u ? { id: String(u.id), username: u.username, avatar: resolveUserAvatar(u) } : null;
    }).filter(Boolean);

    res.json({
        success: true,
        conversationId: conv.id,
        type: conv.type || 'direct',
        name: conv.name || null,
        members,
        invited
    });
});

app.get('/api/pm/conversations/:id/messages', checkAuth, (req, res) => {
    const currentUserId = String(req.session.userId);
    const data = getPrivateMessages();
    const conv = data.conversations[req.params.id];
    if (!canAccessPrivateConversation(conv, currentUserId)) return res.status(403).json({ success: false, message: 'Yetkisiz erişim.' });

    const users = db.getUsers();
    const otherParticipants = (conv.participants || []).filter(id => String(id) !== currentUserId);
    const messages = (conv.messages || []).map(m => {
        const sender = users.find(u => String(u.id) === String(m.senderId));
        const mine = String(m.senderId) === currentUserId;
        const messageTime = new Date(m.createdAt).getTime();
        const readByOther = mine && otherParticipants.length > 0 && otherParticipants.every(id =>
            conv.readBy && conv.readBy[id] && new Date(conv.readBy[id]).getTime() >= messageTime
        );
        return {
            ...m,
            senderUsername: sender ? sender.username : (m.senderUsername || 'Bilinmeyen'),
            senderAvatar: sender ? resolveUserAvatar(sender) : (m.senderAvatar || null),
            senderBadges: sender ? getUserBadgeSummary(sender) : [],
            mine,
            readByOther,
            readAt: readByOther ? m.createdAt : null
        };
    });
    res.json({ success: true, conversationId: conv.id, messages });
});

app.post('/api/pm/conversations/:id/messages', checkAuth, (req, res) => {
    const currentUser = db.findUserById(req.session.userId);
    const currentUserId = String(currentUser.id);
    const data = getPrivateMessages();
    const conv = data.conversations[req.params.id];
    if (!canAccessPrivateConversation(conv, currentUserId)) return res.status(403).json({ success: false, message: 'Yetkisiz erişim.' });

    if ((conv.type || 'direct') !== 'group') {
        const otherId = (conv.participants || []).find(id => String(id) !== currentUserId);
        const other = otherId ? db.findUserById(otherId) : null;
        if (otherId && isPrivateBlocked(data, otherId, currentUserId)) {
            return res.json({ success: false, code: 'BLOCKED_BY_OTHER', message: `${other ? other.username : 'Bu kullanıcı'} tarafından engellendiniz. Mesaj gönderilemedi.` });
        }
        if (otherId && isPrivateBlocked(data, currentUserId, otherId)) {
            return res.json({ success: false, code: 'BLOCKED_BY_ME', message: `${other ? other.username : 'Bu kullanıcı'} engelli. Mesaj göndermek için engeli kaldırın.` });
        }
    }

    const text = sanitizeInput(req.body.message || '', 1000).trim();
    if (!text) return res.json({ success: false, message: 'Mesaj boş olamaz.' });

    const message = {
        id: `${Date.now()}_${currentUser.id}`,
        conversationId: conv.id,
        senderId: currentUserId,
        senderUsername: currentUser.username,
        senderAvatar: resolveUserAvatar(currentUser),
        senderBadges: getUserBadgeSummary(currentUser),
        message: text,
        createdAt: new Date().toISOString()
    };
    conv.messages = Array.isArray(conv.messages) ? conv.messages : [];
    conv.messages.push(message);
    conv.messages = conv.messages.slice(-500);
    conv.updatedAt = message.createdAt;
    if (!conv.readBy) conv.readBy = {};
    conv.readBy[currentUserId] = message.createdAt;
    data.conversations[conv.id] = conv;
    savePrivateMessages(data);

    const payload = {
        id: Date.now().toString(),
        type: 'pm_message',
        conversationId: conv.id,
        message,
        createdAt: message.createdAt
    };
    sendPrivateEvent(conv.participants, payload);
    res.json({ success: true, message: { ...message, mine: true, readByOther: false, readAt: null } });
});

app.post('/api/pm/conversations/:id/read', checkAuth, (req, res) => {
    const currentUserId = String(req.session.userId);
    const data = getPrivateMessages();
    const conv = data.conversations[req.params.id];
    if (!canAccessPrivateConversation(conv, currentUserId)) return res.status(403).json({ success: false, message: 'Yetkisiz erişim.' });
    if (!conv.readBy) conv.readBy = {};
    const readAt = new Date().toISOString();
    conv.readBy[currentUserId] = readAt;
    data.conversations[conv.id] = conv;
    savePrivateMessages(data);
    sendPrivateEvent(conv.participants.filter(id => String(id) !== currentUserId), {
        id: Date.now().toString(),
        type: 'pm_read',
        conversationId: conv.id,
        readerId: currentUserId,
        readAt,
        createdAt: readAt
    });
    res.json({ success: true });
});

app.post('/api/pm/conversations/:id/typing', checkAuth, (req, res) => {
    const currentUser = db.findUserById(req.session.userId);
    const currentUserId = String(currentUser.id);
    const data = getPrivateMessages();
    const conv = data.conversations[req.params.id];
    if (!canAccessPrivateConversation(conv, currentUserId)) return res.status(403).json({ success: false, message: 'Yetkisiz erişim.' });

    const typing = !!req.body.typing;
    if (!privateTypingStates.has(conv.id)) privateTypingStates.set(conv.id, new Map());
    const state = privateTypingStates.get(conv.id);
    if (typing) {
        state.set(currentUserId, { userId: currentUserId, username: currentUser.username, expiresAt: Date.now() + 3500 });
    } else {
        state.delete(currentUserId);
    }

    sendPrivateEvent(conv.participants.filter(id => String(id) !== currentUserId), {
        id: Date.now().toString(),
        type: 'pm_typing',
        conversationId: conv.id,
        userId: currentUserId,
        username: currentUser.username,
        typing,
        createdAt: new Date().toISOString()
    });
    res.json({ success: true });
});

app.get('/api/pm/conversations/:id/typing', checkAuth, (req, res) => {
    const currentUserId = String(req.session.userId);
    const data = getPrivateMessages();
    const conv = data.conversations[req.params.id];
    if (!canAccessPrivateConversation(conv, currentUserId)) return res.status(403).json({ success: false, typing: [] });

    const state = privateTypingStates.get(conv.id);
    if (!state) return res.json({ success: true, typing: [] });

    const now = Date.now();
    const typing = [];
    for (const [uid, item] of state.entries()) {
        if (item.expiresAt < now) {
            state.delete(uid);
        } else if (uid !== currentUserId) {
            typing.push({ userId: uid, username: item.username });
        }
    }
    res.json({ success: true, typing });
});

app.get('/profile/:username', checkAuth, (req, res) => {
    const targetUser = db.findUser(req.params.username);
    const currentUser = db.findUserById(req.session.userId);
    const searchData = getSearchData();
    if (!targetUser) return res.send("Kullanıcı bulunamadı!");

    const labs = getLabs();
    const ctfChallenges = getCtfChallenges();
    const scenariosData = getScenarios();
    const firstbloodData = getFirstBlood();
    const stats = {};
    const userSolved = targetUser.solved || [];
    
    Object.values(ctfChallenges).forEach(c => {
        if (!stats[c.category]) stats[c.category] = { total: 0, solved: 0 };
        stats[c.category].total++;
        if (userSolved.includes(c.id)) stats[c.category].solved++;
    });

    // Senaryo istatistikleri
    Object.values(scenariosData).forEach(s => {
        if (!stats['Senaryolar']) stats['Senaryolar'] = { total: 0, solved: 0 };
        stats['Senaryolar'].total += (s.tasks || []).length;
        (s.tasks || []).forEach(task => {
            if (userSolved.includes(`${s.id}_task_${task.id}`)) stats['Senaryolar'].solved++;
        });
    });

    const badges = calcUserBadges(targetUser, ctfChallenges, labs, scenariosData, firstbloodData);

    res.render('profile', { user: currentUser, profile: targetUser, labs, ctfChallenges, scenarios: scenariosData, badges, stats, searchData, firstblood: firstbloodData, isOnline: isUserOnline(targetUser.id), maxPoints: (() => {
        let m = 0;
        Object.values(labs).forEach(l => m += l.points || 0);
        Object.values(ctfChallenges).forEach(c => m += c.points || 0);
        Object.values(scenariosData).forEach(s => (s.tasks||[]).forEach(t => m += t.points || 0));
        return m || 1;
    })(), solvedDates: targetUser.solvedDates || {} });
});

// ── DESTEK TALEBİ ROUTE'LARI ──
app.get('/support', checkAuth, (req, res) => {
    const user = db.findUserById(req.session.userId);
    const searchData = getSearchData();
    const tickets = getTickets();
    const myTickets = Object.values(tickets)
        .filter(t => String(t.userId) === String(user.id))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.render('support', { user, myTickets, searchData });
});

app.get('/support/:id', checkAuth, (req, res) => {
    const user = db.findUserById(req.session.userId);
    const searchData = getSearchData();
    const tickets = getTickets();
    const ticket = tickets[req.params.id];
    if (!ticket) return res.redirect('/support');
    if (String(ticket.userId) !== String(user.id)) return res.redirect('/support');
    res.render('support-detail', { user, ticket, searchData });
});

// API: Ticket oluştur
app.post('/api/support/create', checkAuth, (req, res) => {
    const category = sanitizeInput(req.body.category || '', 50);
    const subject  = sanitizeInput(req.body.subject  || '', 150);
    const message  = sanitizeInput(req.body.message  || '', 2000);
    const user = db.findUserById(req.session.userId);
    if (!category || !subject || !message) return res.json({ success: false, message: 'Tüm alanları doldurun.' });
    const tickets = getTickets();
    const id = 'ticket_' + Date.now();
    tickets[id] = {
        id, userId: String(user.id), username: user.username,
        category, subject, message,
        status: 'open',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        replies: []
    };
    saveTickets(tickets);
    res.json({ success: true, ticketId: id, message: 'Destek talebiniz oluşturuldu.' });
});

// API: Ticket'a kullanıcı yanıtı ekle
app.post('/api/support/reply', checkAuth, (req, res) => {
    const { ticketId } = req.body;
    const message = sanitizeInput(req.body.message || '', 2000);
    const user = db.findUserById(req.session.userId);
    const tickets = getTickets();
    const ticket = tickets[ticketId];
    if (!ticket) return res.json({ success: false, message: 'Ticket bulunamadı.' });
    if (String(ticket.userId) !== String(user.id)) return res.json({ success: false, message: 'Yetkisiz.' });
    if (ticket.status === 'closed') return res.json({ success: false, message: 'Kapalı ticket\'a yanıt verilemez.' });
    if (!message) return res.json({ success: false, message: 'Mesaj boş olamaz.' });
    ticket.replies.push({ from: 'user', username: user.username, message, createdAt: new Date().toISOString() });
    ticket.status = 'open';
    ticket.updatedAt = new Date().toISOString();
    saveTickets(tickets);
    res.json({ success: true });
});

// API: Ticket kapat (kullanıcı)
app.post('/api/support/close', checkAuth, (req, res) => {
    const { ticketId } = req.body;
    const user = db.findUserById(req.session.userId);
    const tickets = getTickets();
    const ticket = tickets[ticketId];
    if (!ticket || String(ticket.userId) !== String(user.id)) return res.json({ success: false });
    ticket.status = 'closed';
    ticket.updatedAt = new Date().toISOString();
    saveTickets(tickets);
    res.json({ success: true });
});

// API: Ticket sil (kullanıcı)
app.post('/api/support/delete', checkAuth, (req, res) => {
    const { ticketId } = req.body;
    const user = db.findUserById(req.session.userId);
    const tickets = getTickets();
    const ticket = tickets[ticketId];
    if (!ticket) return res.json({ success: false, message: 'Destek talebi bulunamadı.' });
    if (String(ticket.userId) !== String(user.id)) return res.json({ success: false, message: 'Yetkisiz işlem.' });
    delete tickets[ticketId];
    saveTickets(tickets);
    res.json({ success: true, message: 'Destek talebi silindi.' });
});

// Admin: Tüm ticket'ları listele
app.get('/api/admin/tickets', checkAuth, isAdmin, (req, res) => {
    const tickets = getTickets();
    const list = Object.values(tickets).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    res.json({ success: true, tickets: list });
});

// Admin: Ticket'a yanıt ver
app.post('/api/admin/ticket/reply', checkAuth, isAdmin, (req, res) => {
    const { ticketId } = req.body;
    const message = sanitizeInput(req.body.message || '', 2000);
    const admin = db.findUserById(req.session.userId);
    const tickets = getTickets();
    const ticket = tickets[ticketId];
    if (!ticket) return res.json({ success: false, message: 'Ticket bulunamadı.' });
    if (!message) return res.json({ success: false, message: 'Mesaj boş olamaz.' });
    ticket.replies.push({ from: 'admin', username: admin.username, message, createdAt: new Date().toISOString() });
    ticket.status = 'answered';
    ticket.updatedAt = new Date().toISOString();
    saveTickets(tickets);
    sendNotification(ticket.userId, {
        id: Date.now().toString(), type: 'support_reply',
        message: `Destek talebiniz "${ticket.subject}" yanıtlandı.`,
        severity: 'info', sound: true, createdAt: new Date().toISOString()
    });
    res.json({ success: true });
});

// Admin: Ticket durumunu değiştir
app.post('/api/admin/ticket/status', checkAuth, isAdmin, (req, res) => {
    const { ticketId, status } = req.body;
    const tickets = getTickets();
    const ticket = tickets[ticketId];
    if (!ticket) return res.json({ success: false });
    ticket.status = status;
    ticket.updatedAt = new Date().toISOString();
    saveTickets(tickets);
    res.json({ success: true });
});

// Admin: Admin listesi
app.get('/api/admin/admins', checkAuth, isAdmin, (req, res) => {
    const admins = getAdmins();
    const users = db.getUsers();
    const adminUsers = admins.map(username => {
        const u = users.find(u => u.username === username);
        return { username, avatar: u ? u.avatar || null : null, exists: !!u };
    });
    const nonAdmins = users
        .filter(u => !admins.includes(u.username))
        .map(u => ({ username: u.username, avatar: u.avatar || null }));
    res.json({ success: true, admins: adminUsers, users: nonAdmins });
});

// Admin: Admin ekle
app.post('/api/admin/admins/add', checkAuth, isAdmin, (req, res) => {
    const { username } = req.body;
    const requester = db.findUserById(req.session.userId);
    // Kurucu kontrolü: ID ile doğrula (username spoofing'e karşı)
    const FOUNDER_ID = 1774035004843;
    if (Number(requester.id) !== FOUNDER_ID) return res.json({ success: false, message: 'Sadece kurucu admin ekleyebilir.' });
    const target = db.findUser(username);
    if (!target) return res.json({ success: false, message: 'Kullanıcı bulunamadı.' });
    const admins = getAdmins();
    if (admins.includes(username)) return res.json({ success: false, message: 'Zaten admin.' });
    admins.push(username);
    saveAdmins(admins);
    res.json({ success: true, message: `"${username}" admin yapıldı.` });
});

// Admin: Admin kaldır
app.post('/api/admin/admins/remove', checkAuth, isAdmin, (req, res) => {
    const { username } = req.body;
    const requester = db.findUserById(req.session.userId);
    const FOUNDER_ID = 1774035004843;
    if (Number(requester.id) !== FOUNDER_ID) return res.json({ success: false, message: 'Sadece kurucu admin kaldırabilir.' });
    if (Number(db.findUser(username)?.id) === FOUNDER_ID) return res.json({ success: false, message: 'Kurucu adminlikten çıkarılamaz.' });
    const admins = getAdmins();
    const newAdmins = admins.filter(a => a !== username);
    saveAdmins(newAdmins);
    res.json({ success: true, message: `"${username}" adminlikten çıkarıldı.` });
});

// --- API ACTIONS ---

app.post('/api/upload-avatar', checkAuth, (req, res) => {
    upload.single('avatar')(req, res, (err) => {
        if (err) return res.status(400).json({ success: false, message: err.message });
        if (!req.file) return res.status(400).json({ success: false, message: 'Lütfen bir resim seçin!' });
        const avatarPath = '/uploads/avatars/' + req.file.filename;
        db.updateUser(req.session.userId, { avatar: avatarPath });
        res.json({ success: true, avatar: avatarPath, message: 'Profil resmi başarıyla güncellendi!' });
    });
});

app.post('/api/update-profile', checkAuth, (req, res) => {
    const bio = sanitizeInput(req.body.bio || '', 300);
    db.updateUser(req.session.userId, { bio });
    res.json({ success: true });
});

// Kullanıcı kendi şifresini değiştir
app.post('/api/change-password', checkAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) return res.json({ success: false, message: 'Yeni şifre en az 8 karakter olmalı.' });
    const user = db.findUserById(req.session.userId);
    if (!user) return res.json({ success: false, message: 'Kullanıcı bulunamadı.' });
    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) return res.json({ success: false, message: 'Mevcut şifre hatalı.' });
    const hashed = await bcrypt.hash(newPassword, 10);
    db.updateUser(user.id, { password: hashed });
    res.json({ success: true, message: 'Şifre başarıyla güncellendi.' });
});

// --- ADMIN API ---

app.post('/api/admin/announcement', checkAuth, isAdmin, (req, res) => {
    const { announcement } = req.body;
    let sysData = getSystemData();
    sysData.announcement = announcement;
    saveSystemData(sysData);
    res.json({ success: true, message: "Duyuru güncellendi!" });
});

app.post('/api/admin/notification', checkAuth, isAdmin, (req, res) => {
    const { message } = req.body;
    let sysData = getSystemData();
    sysData.notifications.unshift({ id: Date.now(), message });
    saveSystemData(sysData);
    res.json({ success: true });
});

app.post('/api/admin/notification/delete', checkAuth, isAdmin, (req, res) => {
    const id = Number(req.body.id); 
    let sysData = getSystemData();
    sysData.notifications = sysData.notifications.filter(n => n.id !== id);
    saveSystemData(sysData);
    res.json({ success: true });
});

app.post('/api/admin/notification/send', checkAuth, isAdmin, (req, res) => {
    const { targetUserId, message, severity, sound } = req.body;
    
    // Create notification JSON with standard structure
    const notification = {
        id: Date.now().toString(),
        type: 'targeted',
        targetUserId: targetUserId,
        message: message,
        severity: severity || 'info',
        sound: sound !== false,
        createdAt: new Date().toISOString()
    };

    // Check if target user is online
    if (sseClients.has(targetUserId.toString())) {
        // User is online - send via SSE stream
        const client = sseClients.get(targetUserId.toString());
        try {
            client.res.write(`data: ${JSON.stringify(notification)}\n\n`);
            res.json({ success: true, message: 'Bildirim gönderildi', delivered: true });
        } catch (err) {
            // Connection broken, remove from clients and save as pending
            sseClients.delete(targetUserId.toString());
            
            // Save to pending notifications
            let sysData = getSystemData();
            if (!sysData.pendingNotifications) sysData.pendingNotifications = {};
            if (!sysData.pendingNotifications[targetUserId.toString()]) sysData.pendingNotifications[targetUserId.toString()] = [];
            sysData.pendingNotifications[targetUserId.toString()].push(notification);
            saveSystemData(sysData);
            
            res.json({ success: true, message: 'Kullanıcı çevrimdışı, bildirim beklemede', delivered: false });
        }
    } else {
        // User is offline - add to pending notifications
        let sysData = getSystemData();
        if (!sysData.pendingNotifications) sysData.pendingNotifications = {};
        if (!sysData.pendingNotifications[targetUserId.toString()]) sysData.pendingNotifications[targetUserId.toString()] = [];
        sysData.pendingNotifications[targetUserId.toString()].push(notification);
        saveSystemData(sysData);
        
        res.json({ success: true, message: 'Kullanıcı çevrimdışı, bildirim beklemede', delivered: false });
    }
});

app.post('/api/admin/notification/broadcast', checkAuth, isAdmin, (req, res) => {
    const { message, severity, sound } = req.body;
    
    // Create notification JSON with standard structure
    const notification = {
        id: Date.now().toString(),
        type: 'broadcast',
        targetUserId: null,
        message: message,
        severity: severity || 'info',
        sound: sound !== false,
        createdAt: new Date().toISOString()
    };

    // Send to all online users
    let deliveredCount = 0;
    sseClients.forEach((client, userId) => {
        try {
            client.res.write(`data: ${JSON.stringify(notification)}\n\n`);
            deliveredCount++;
        } catch (err) {
            // Connection broken, remove from clients
            sseClients.delete(userId);
        }
    });

    // Save to system.json notifications array (keep last 5 broadcasts)
    let sysData = getSystemData();
    if (!sysData.notifications) sysData.notifications = [];
    sysData.notifications.unshift(notification);
    // Keep only last 5 broadcast notifications
    sysData.notifications = sysData.notifications.slice(0, 5);
    saveSystemData(sysData);

    res.json({ 
        success: true, 
        message: `${deliveredCount} kullanıcıya iletildi`,
        deliveredCount: deliveredCount 
    });
});

// Çevrimiçi kullanıcıları döndüren endpoint (admin panel için)
app.get('/api/admin/online-users', checkAuth, isAdmin, (req, res) => {
    const onlineUsers = Array.from(sseClients.keys());
    res.json({ 
        success: true, 
        onlineUsers: onlineUsers,
        count: onlineUsers.length
    });
});

app.post('/api/admin/save-lab', checkAuth, isAdmin, (req, res) => {
    const { id, title, difficulty, points, flag, hint } = req.body;
    const labs = getLabs();
    labs[id] = { id, title, difficulty, points: parseInt(points), flag, hint };
    saveLabs(labs); 
    res.json({ success: true });
});

app.post('/api/admin/delete-lab', checkAuth, isAdmin, (req, res) => {
    const { id } = req.body;
    const labs = getLabs();
    delete labs[id];
    saveLabs(labs); 
    res.json({ success: true });
});

app.post('/api/admin/save-ctf', checkAuth, isAdmin, (req, res) => {
    const { id, title, category, points, flag, hint, download } = req.body;
    const ctfChallenges = getCtfChallenges();
    ctfChallenges[id] = { id, title, category, points: parseInt(points), flag, hint, download };
    saveCtfChallenges(ctfChallenges); 
    res.json({ success: true });
});

app.post('/api/admin/delete-ctf', checkAuth, isAdmin, (req, res) => {
    const { id } = req.body;
    const ctfChallenges = getCtfChallenges();
    delete ctfChallenges[id];
    saveCtfChallenges(ctfChallenges); 
    res.json({ success: true });
});

app.post('/api/admin/save-scenario', checkAuth, isAdmin, (req, res) => {
    const scenario = req.body;
    const scenarios = getScenarios();
    scenarios[scenario.id] = scenario;
    saveScenarios(scenarios);
    res.json({ success: true });
});

app.post('/api/admin/delete-scenario', checkAuth, isAdmin, (req, res) => {
    const { id } = req.body;
    const scenarios = getScenarios();
    delete scenarios[id];
    saveScenarios(scenarios);
    res.json({ success: true });
});

app.post('/api/admin/upload-ctf-file', checkAuth, isAdmin, (req, res) => {
    uploadCtf.single('ctfFile')(req, res, (err) => {
        if (err) return res.status(400).json({ success: false, message: err.message });
        const filePath = '/files/' + req.file.filename;
        res.json({ success: true, filePath: filePath });
    });
});

// 🖼️ YENİ: SENARYO BANNER YÜKLEME API ROTASI
app.post('/api/admin/upload-scenario-banner', checkAuth, isAdmin, (req, res) => {
    uploadScenario.single('sceBanner')(req, res, (err) => {
        if (err) return res.status(400).json({ success: false, message: err.message });
        if (!req.file) return res.status(400).json({ success: false, message: 'Lütfen bir resim seçin!' });
        const filePath = '/uploads/scenarios/' + req.file.filename;
        res.json({ success: true, filePath: filePath });
    });
});

app.post('/api/admin/delete-user', checkAuth, isAdmin, (req, res) => {
    const { userId } = req.body;
    let users = db.getUsers();
    users = users.filter(u => u.id != userId);
    db.saveUsers(users);
    res.json({ success: true });
});

// Admin: Kullanıcıyı yasakla
app.post('/api/admin/ban-user', checkAuth, isAdmin, (req, res) => {
    const { userId, reason, days } = req.body; // days: null = süresiz
    const adminUser = db.findUserById(req.session.userId);
    const targetUser = db.findUserById(userId);
    if (!targetUser) return res.json({ success: false, message: 'Kullanıcı bulunamadı.' });
    const bans = getBans();
    const expiresAt = days ? new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString() : null;
    bans[String(userId)] = {
        userId: String(userId),
        username: targetUser.username,
        reason: reason || 'Belirtilmedi',
        bannedBy: adminUser.username,
        bannedAt: new Date().toISOString(),
        expiresAt,
        days: days || null,
        active: true
    };
    saveBans(bans);
    // Kullanıcı çevrimiçiyse SSE ile ban bildirimi gönder → otomatik logout
    const banNotif = {
        id: Date.now().toString(),
        type: 'banned',
        reason: reason || 'Belirtilmedi',
        bannedBy: adminUser.username,
        expiresAt,
        message: `Defendia Network Defense tarafından yasaklandınız. Sebep: ${reason || 'Belirtilmedi'}`,
        severity: 'danger',
        sound: false,
        createdAt: new Date().toISOString()
    };
    sendNotification(userId, banNotif);
    res.json({ success: true, message: `"${targetUser.username}" yasaklandı.` });
});

// Admin: Yasağı kaldır
app.post('/api/admin/unban-user', checkAuth, isAdmin, (req, res) => {
    const { userId } = req.body;
    const bans = getBans();
    if (!bans[String(userId)]) return res.json({ success: false, message: 'Ban kaydı bulunamadı.' });
    bans[String(userId)].active = false;
    saveBans(bans);
    res.json({ success: true, message: 'Yasak kaldırıldı.' });
});

// Admin: Ban listesi
app.get('/api/admin/bans', checkAuth, isAdmin, (req, res) => {
    const bans = getBans();
    const list = Object.values(bans).map(b => {
        const expired = b.expiresAt && new Date() > new Date(b.expiresAt);
        return { ...b, expired };
    }).sort((a, b) => new Date(b.bannedAt) - new Date(a.bannedAt));
    res.json({ success: true, bans: list });
});

// Admin: Kullanıcının aktif VM'ini durdur ve sıfırla
app.post('/api/admin/stop-user-vm', checkAuth, isAdmin, async (req, res) => {
    const { userId } = req.body;
    const user = db.findUserById(userId);
    if (!user) return res.json({ success: false, message: 'Kullanıcı bulunamadı.' });
    if (!user.active_vmid) return res.json({ success: false, message: 'Aktif VM yok.' });
    const vmid = user.active_vmid;
    // Önce DB'yi sıfırla
    db.updateUser(userId, { active_vmid: null, active_vmid_id: null, ip_address: null, expiry: null });
    // Proxmox'ta durdur ve sil
    try {
        await proxmox.post(`/nodes/${PVE_NODE}/qemu/${vmid}/status/stop`);
        await new Promise(r => setTimeout(r, 3000));
        await proxmox.delete(`/nodes/${PVE_NODE}/qemu/${vmid}`);
        res.json({ success: true, message: `VMID ${vmid} durduruldu ve silindi.` });
    } catch (e) {
        res.json({ success: true, message: 'DB sıfırlandı, VM kapatma sırasında hata oluştu.' });
    }
});

app.post('/api/admin/reset-progress', checkAuth, isAdmin, (req, res) => {
    const { userId } = req.body;
    db.updateUser(userId, { solved: [], active_vmid: null, active_vmid_id: null, ip_address: null, expiry: null, scenario_progress: {}, hackerbox_vmid: null, hackerbox_ip: null });
    res.json({ success: true });
});

// Admin: Kullanıcı şifresini değiştir
app.post('/api/admin/change-password', checkAuth, isAdmin, async (req, res) => {
    const { userId, newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) return res.json({ success: false, message: 'Şifre en az 8 karakter olmalı.' });
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    db.updateUser(userId, { password: hashedPassword });
    res.json({ success: true, message: 'Şifre güncellendi.' });
});
app.get('/api/admin/teams', checkAuth, isAdmin, (req, res) => {
    const teams = getTeams();
    const result = Object.values(teams).map(t => {
        const leader = db.findUserById(t.leaderId);
        const members = (t.members || []).map(uid => {
            const u = db.findUserById(uid);
            return u ? { id: String(u.id), username: u.username, avatar: u.avatar || null } : null;
        }).filter(Boolean);
        return {
            id: t.id,
            name: t.name,
            points: calcTeamPoints(t),
            memberCount: t.members.length,
            leaderUsername: leader ? leader.username : '?',
            members,
            createdAt: t.createdAt
        };
    }).sort((a, b) => b.points - a.points);
    res.json({ success: true, teams: result });
});

// Admin: Takımı sil (tüm üyeleri takımdan çıkar)
app.post('/api/admin/delete-team', checkAuth, isAdmin, (req, res) => {
    const { teamId } = req.body;
    const teams = getTeams();
    const team = teams[teamId];
    if (!team) return res.json({ success: false, message: 'Takım bulunamadı.' });
    // Üyelere bildirim gönder
    (team.members || []).forEach(uid => {
        sendNotification(uid, {
            id: Date.now().toString() + uid,
            type: 'team_deleted',
            message: `"${team.name}" takımı admin tarafından silindi.`,
            severity: 'warning',
            sound: true,
            createdAt: new Date().toISOString()
        });
    });
    delete teams[teamId];
    saveTeams(teams);
    res.json({ success: true, message: `"${team.name}" takımı silindi.` });
});

// Admin: Rozet listesi
app.get('/api/admin/badges', checkAuth, isAdmin, (req, res) => {
    const badges = getBadges();
    const users = db.getUsers();
    res.json({ success: true, badges: Object.values(badges), users: users.map(u => ({ id: u.id, username: u.username })) });
});

// Admin: Rozet güncelle (isim, ikon, renk, açıklama)
app.post('/api/admin/badge/update', checkAuth, isAdmin, (req, res) => {
    const { id, name, icon, color, desc } = req.body;
    const badges = getBadges();
    if (!badges[id]) return res.json({ success: false, message: 'Rozet bulunamadı.' });
    if (name)  badges[id].name  = name;
    if (icon)  badges[id].icon  = icon;
    if (color) badges[id].color = color;
    if (desc !== undefined) badges[id].desc = desc;
    saveBadges(badges);
    res.json({ success: true, message: 'Rozet güncellendi.' });
});

// Admin: Rozet oluştur
app.post('/api/admin/badge/create', checkAuth, isAdmin, (req, res) => {
    const { name, icon, color, desc, type } = req.body;
    if (!name || !icon) return res.json({ success: false, message: 'İsim ve ikon zorunlu.' });
    const badges = getBadges();
    const id = 'badge_' + Date.now();
    badges[id] = { id, name, icon, color: color || '#38bdf8', desc: desc || '', type: type || 'manual', assignedTo: [] };
    saveBadges(badges);
    res.json({ success: true, message: 'Rozet oluşturuldu.', id });
});

// Admin: Rozet sil
app.post('/api/admin/badge/delete', checkAuth, isAdmin, (req, res) => {
    const { id } = req.body;
    const badges = getBadges();
    if (!badges[id]) return res.json({ success: false, message: 'Rozet bulunamadı.' });
    delete badges[id];
    saveBadges(badges);
    res.json({ success: true, message: 'Rozet silindi.' });
});

// Admin: Rozeti kullanıcıya ata / kaldır
app.post('/api/admin/badge/assign', checkAuth, isAdmin, (req, res) => {
    const { badgeId, username, action } = req.body; // action: 'add' | 'remove'
    const badges = getBadges();
    if (!badges[badgeId]) return res.json({ success: false, message: 'Rozet bulunamadı.' });
    const user = db.findUser(username);
    if (!user) return res.json({ success: false, message: 'Kullanıcı bulunamadı.' });
    if (!badges[badgeId].assignedTo) badges[badgeId].assignedTo = [];
    if (action === 'add') {
        if (!badges[badgeId].assignedTo.includes(username)) badges[badgeId].assignedTo.push(username);
    } else {
        badges[badgeId].assignedTo = badges[badgeId].assignedTo.filter(u => u !== username);
    }
    saveBadges(badges);
    res.json({ success: true, message: action === 'add' ? `Rozet ${username} kullanıcısına atandı.` : `Rozet ${username} kullanıcısından kaldırıldı.` });
});

// Admin: İlk kan listesi
app.get('/api/admin/firstbloods', checkAuth, isAdmin, (req, res) => {
    const fb = getFirstBlood();
    const labs = getLabs();
    const ctf = getCtfChallenges();
    const scenarios = getScenarios();
    const list = Object.entries(fb).map(([challengeId, data]) => {
        let title = data.challengeTitle || challengeId;
        let type = 'Bilinmiyor';
        if (labs[challengeId])  { title = labs[challengeId].title;  type = 'Lab'; }
        if (ctf[challengeId])   { title = ctf[challengeId].title;   type = 'CTF'; }
        Object.values(scenarios).forEach(s => {
            if ((s.tasks||[]).find(t => `${s.id}_task_${t.id}` === challengeId)) type = 'Senaryo';
        });
        return { challengeId, title, type, username: data.username, solvedAt: data.solvedAt };
    }).sort((a, b) => new Date(b.solvedAt) - new Date(a.solvedAt));
    res.json({ success: true, list });
});

// Admin: Tek ilk kan sil
app.post('/api/admin/delete-firstblood', checkAuth, isAdmin, (req, res) => {
    const { challengeId } = req.body;
    const fb = getFirstBlood();
    if (!fb[challengeId]) return res.json({ success: false, message: 'Kayıt bulunamadı.' });
    delete fb[challengeId];
    saveFirstBlood(fb);
    res.json({ success: true, message: 'İlk kan kaydı silindi.' });
});

// Admin: Tüm ilk kanları sıfırla
app.post('/api/admin/reset-firstbloods', checkAuth, isAdmin, (req, res) => {
    saveFirstBlood({});
    res.json({ success: true, message: 'Tüm ilk kan kayıtları sıfırlandı.' });
});
app.post('/api/submit-scenario-task', checkAuth, (req, res) => {
    const { scenarioId, taskId, flag } = req.body;
    const user = db.findUserById(req.session.userId);
    const scenarios = getScenarios();
    const scenario = scenarios[scenarioId];
    if (!scenario) return res.json({ success: false, message: "Hata!" });

    const taskIndex = scenario.tasks.findIndex(t => t.id == taskId);
    const task = scenario.tasks[taskIndex];

    if (flag === task.flag) {
        if (!user.scenario_progress) user.scenario_progress = {};
        const solvedList = user.solved || [];
        const uniqueId = `${scenarioId}_task_${taskId}`;
        if (!solvedList.includes(uniqueId)) {
            solvedList.push(uniqueId);
            if ((user.scenario_progress[scenarioId] || 0) == taskIndex) {
                user.scenario_progress[scenarioId] = taskIndex + 1;
            }
            // Çözüm tarihini kaydet
            const solvedDates = user.solvedDates || {};
            solvedDates[uniqueId] = new Date().toISOString();
            db.updateUser(user.id, { solved: solvedList, scenario_progress: user.scenario_progress, solvedDates });
            // İlk kan kontrolü
            recordFirstBlood(uniqueId, `${scenario.title} - ${task.question.substring(0,30)}`, user.id, user.username);
        }
        res.json({ success: true, message: `Doğru! ${task.points} Puan kazandın.` });
    } else res.json({ success: false, message: "Hatalı bayrak!" });
});

// --- AUTH ---
// --- GET ROUTLARI (AYNI KALIYOR) ---
app.get('/login', (req, res) => res.render('login'));
app.get('/register', (req, res) => res.render('register'));

// --- REGISTER (KAYIT OL) POST ---
app.post('/register', async (req, res) => {
    const { username, password } = req.body;

    // Input validasyonu
    if (!username || typeof username !== 'string' || username.trim().length < 3 || username.trim().length > 30) {
        return res.json({ success: false, error: 'Kullanıcı adı 3-30 karakter arasında olmalı.' });
    }
    if (!password || password.length < 8) {
        return res.json({ success: false, error: 'Şifre en az 8 karakter olmalı.' });
    }
    // Sadece harf, rakam ve _ izin ver
    if (!/^[a-zA-Z0-9_]+$/.test(username.trim())) {
        return res.json({ success: false, error: 'Kullanıcı adı sadece harf, rakam ve _ içerebilir.' });
    }

    // Kullanıcı kontrolü
    if (db.findUser(username.trim())) {
        return res.json({ success: false, error: "Bu kullanıcı adı zaten alınmış!" });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        
        // Senin orijinal newUser yapın
        const newUser = { 
            id: Date.now(), 
            username: username.trim(), 
            password: hashedPassword, 
            active_vmid: null, 
            active_vmid_id: null, 
            ip_address: null, 
            expiry: null, 
            solved: [], 
            scenario_progress: {}, 
            bio: "", 
            avatar: "" 
        };

        const users = db.getUsers();
        users.push(newUser);
        db.saveUsers(users);

        // ✅ BAŞARILI: Frontend bu JSON'u alınca "Kayıt Başarılı" diyecek
        res.json({ success: true });

    } catch (e) { 
        res.json({ success: false, error: "Kayıt sırasında bir hata oluştu!" }); 
    }
});

// --- LOGIN (GİRİŞ YAP) POST ---
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = db.findUser(username);

    // Kullanıcı doğrulama
    if (user && await bcrypt.compare(password, user.password)) {
        // Ban kontrolü
        const ban = isUserBanned(user.id);
        if (ban) {
            return res.json({
                success: false,
                banned: true,
                banReason: ban.reason || 'Belirtilmedi',
                banExpires: ban.expiresAt || null,
                banAdmin: ban.bannedBy || 'Admin'
            });
        }
        req.session.userId = user.id;
        return res.json({ success: true });
    } else {
        return res.json({ success: false, error: "Kullanıcı adı veya şifre hatalı!" });
    }
});

// --- PROXMOX & LAB LOGIC ---
app.post('/api/start-lab', checkAuth, async (req, res) => {
    const { vmid } = req.body;
    const user = db.findUserById(req.session.userId);
    if (user.active_vmid) return res.json({ success: false, message: "Zaten aktif labın var!" });
    try {
        const newId = 10000 + Math.floor(Math.random() * 90000);
        await proxmox.post(`/nodes/${PVE_NODE}/qemu/${vmid}/clone`, { newid: newId, name: `lab-${user.username}`, full: 0 });
        const randomMac = generateRandomMac();
        await proxmox.post(`/nodes/${PVE_NODE}/qemu/${newId}/config`, { net0: `virtio,bridge=vmbr0,macaddr=${randomMac}` });
        await proxmox.post(`/nodes/${PVE_NODE}/qemu/${newId}/status/start`);
        // 🎯 DÜZELTME: SÜREYİ 1 SAAT (3600 sn) OLARAK SET EDİYORUZ
        const oneHour = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        db.updateUser(user.id, { active_vmid: newId, active_vmid_id: vmid, ip_address: null, expiry: oneHour });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/submit-flag', checkAuth, async (req, res) => {
    const { labId, flag } = req.body;
    const user = db.findUserById(req.session.userId);
    const labs = getLabs();
    const ctfChallenges = getCtfChallenges();
    const challenge = labs[labId] || ctfChallenges[labId];
    if (!challenge || user.solved.includes(labId)) return res.json({ success: false });
    
    if (flag === challenge.flag) {
        const solvedList = user.solved || [];
        solvedList.push(labId);
        
        // Çözüm tarihini kaydet
        const solvedDates = user.solvedDates || {};
        solvedDates[labId] = new Date().toISOString();
        
        // İlk kan kontrolü
        recordFirstBlood(labId, challenge.title, user.id, user.username);
        
        let updateData = { solved: solvedList, solvedDates };
        if (labs[labId] && user.active_vmid) {
            const vmidToKill = user.active_vmid;
            updateData.active_vmid = null; updateData.active_vmid_id = null;
            updateData.ip_address = null; updateData.expiry = null;
            proxmox.post(`/nodes/${PVE_NODE}/qemu/${vmidToKill}/status/stop`)
                .then(() => new Promise(r => setTimeout(r, 3000)))
                .then(() => proxmox.delete(`/nodes/${PVE_NODE}/qemu/${vmidToKill}`))
                .catch(err => console.log(err.message));
        }
        db.updateUser(user.id, updateData);
        res.json({ success: true, message: `${challenge.points} Puan kazandın.` });
    } else res.json({ success: false, message: "Hatalı bayrak!" });
});

app.get('/api/get-ip/0', checkAuth, async (req, res) => {
    const user = db.findUserById(req.session.userId);
    if (!user.active_vmid) return res.json({ ip: null });
    if (user.expiry && new Date() > new Date(user.expiry)) {
        const vmidToKill = user.active_vmid;
        db.updateUser(user.id, { active_vmid: null, active_vmid_id: null, ip_address: null, expiry: null });
        proxmox.post(`/nodes/${PVE_NODE}/qemu/${vmidToKill}/status/stop`)
            .then(() => new Promise(r => setTimeout(r, 3000)))
            .then(() => proxmox.delete(`/nodes/${PVE_NODE}/qemu/${vmidToKill}`))
            .catch(err => console.log(err.message));
        return res.json({ ip: null, expired: true }); 
    }
    // IP zaten DB'de varsa Proxmox'a gitme
    if (user.ip_address) {
        return res.json({ ip: user.ip_address, expiry: user.expiry });
    }
    try {
        const agentRes = await proxmox.get(`/nodes/${PVE_NODE}/qemu/${user.active_vmid}/agent/network-get-interfaces`);
        const interfaces = agentRes.data.data.result;
        let foundIp = null;
        for (const iface of interfaces) {
            if (iface.name !== 'lo' && iface['ip-addresses']) {
                const ipv4 = iface['ip-addresses'].find(ip => ip['ip-address-type'] === 'ipv4');
                if (ipv4) { foundIp = ipv4['ip-address']; break; }
            }
        }
        if (foundIp) {
            db.updateUser(user.id, { ip_address: foundIp });
            return res.json({ ip: foundIp, expiry: user.expiry });
        }
        res.json({ ip: null });
    } catch (e) { res.json({ ip: null }); }
});

app.get('/api/leaderboard', checkAuth, (req, res) => {
    const users = db.getUsers();
    const labs = getLabs();
    const ctfChallenges = getCtfChallenges();
    const scenarios = getScenarios();
    const currentUserId = String(req.session.userId);

    const board = users.map(u => {
        let p = 0;
        (u.solved || []).forEach(id => { 
            if(labs[id]) p += labs[id].points; 
            if(ctfChallenges[id]) p += ctfChallenges[id].points;
            Object.values(scenarios).forEach(s => {
                const task = s.tasks.find(t => `${s.id}_task_${t.id}` === id);
                if(task) p += task.points;
            });
        });
        // Kendisi her zaman online, diğerleri SSE map'inden kontrol
        const isOnline = String(u.id) === currentUserId || isUserOnline(u.id);
        return { 
            username: u.username, 
            points: p, 
            avatar: u.avatar || null,
            online: isOnline
        };
    }).sort((a,b) => b.points - a.points);
    res.json(board);
});

// SSE Notification Stream Endpoint

// ══════════════════════════════════════════
// TAKIM SİSTEMİ
// ══════════════════════════════════════════

// Takım sayfası
app.get('/teams', checkAuth, (req, res) => {
    const user = db.findUserById(req.session.userId);
    const teams = getTeams();
    const users = db.getUsers();
    const searchData = getSearchData();
    const myTeam = getUserTeam(user.id);
    const currentUserId = String(req.session.userId);
    
    // Takım sıralaması
    const teamRanking = Object.values(teams).map(t => ({
        ...t,
        points: calcTeamPoints(t),
        memberDetails: t.members.map(uid => {
            const u = db.findUserById(uid);
            return u ? { id: u.id, username: u.username, avatar: u.avatar || null, online: String(u.id) === currentUserId || isUserOnline(u.id) } : null;
        }).filter(Boolean)
    })).sort((a, b) => b.points - a.points);

    res.render('teams', { user, myTeam, teamRanking, users, searchData });
});

// Takım oluştur
app.post('/api/teams/create', checkAuth, (req, res) => {
    const name = sanitizeInput(req.body.name || '', 30);
    const user = db.findUserById(req.session.userId);
    
    if (!name || name.length < 2) return res.json({ success: false, message: 'Takım adı en az 2 karakter olmalı.' });
    if (name.length > 30) return res.json({ success: false, message: 'Takım adı en fazla 30 karakter olabilir.' });
    
    const teams = getTeams();
    
    // Zaten takımda mı?
    if (getUserTeam(user.id)) return res.json({ success: false, message: 'Zaten bir takıma üyesiniz.' });
    
    // İsim çakışması?
    if (Object.values(teams).find(t => t.name.toLowerCase() === name.toLowerCase())) {
        return res.json({ success: false, message: 'Bu takım adı zaten kullanılıyor.' });
    }
    
    const teamId = 'team_' + Date.now();
    teams[teamId] = {
        id: teamId,
        name: name,
        leaderId: String(user.id),
        members: [String(user.id)],
        pendingInvites: [],
        createdAt: new Date().toISOString()
    };
    saveTeams(teams);
    res.json({ success: true, teamId, message: `"${name}" takımı oluşturuldu!` });
});

// Takım daveti gönder
app.post('/api/teams/invite', checkAuth, (req, res) => {
    const { targetUsername } = req.body;
    const user = db.findUserById(req.session.userId);
    const teams = getTeams();
    
    const myTeam = getUserTeam(user.id);
    if (!myTeam) return res.json({ success: false, message: 'Önce bir takım oluşturun veya katılın.' });
    if (String(myTeam.leaderId) !== String(user.id)) return res.json({ success: false, message: 'Sadece takım lideri davet gönderebilir.' });
    if (myTeam.members.length >= 4) return res.json({ success: false, message: 'Takım dolu (maksimum 4 üye).' });
    
    const target = db.findUser(targetUsername);
    if (!target) return res.json({ success: false, message: 'Kullanıcı bulunamadı.' });
    if (String(target.id) === String(user.id)) return res.json({ success: false, message: 'Kendinizi davet edemezsiniz.' });
    if (getUserTeam(target.id)) return res.json({ success: false, message: 'Bu kullanıcı zaten bir takımda.' });
    if (myTeam.pendingInvites.includes(String(target.id))) return res.json({ success: false, message: 'Bu kullanıcıya zaten davet gönderildi.' });
    
    // Daveti kaydet
    myTeam.pendingInvites.push(String(target.id));
    teams[myTeam.id] = myTeam;
    saveTeams(teams);
    
    // SSE bildirimi gönder
    const notification = {
        id: Date.now().toString(),
        type: 'team_invite',
        teamId: myTeam.id,
        teamName: myTeam.name,
        fromUsername: user.username,
        message: `"${user.username}" sizi "${myTeam.name}" takımına davet etti!`,
        severity: 'info',
        sound: true,
        createdAt: new Date().toISOString()
    };
    sendNotification(target.id, notification);
    
    res.json({ success: true, message: `${targetUsername} kullanıcısına davet gönderildi.` });
});

// Daveti kabul et
app.post('/api/teams/accept', checkAuth, (req, res) => {
    const { teamId } = req.body;
    const user = db.findUserById(req.session.userId);
    const teams = getTeams();
    
    if (getUserTeam(user.id)) return res.json({ success: false, message: 'Zaten bir takıma üyesiniz.' });
    
    const team = teams[teamId];
    if (!team) return res.json({ success: false, message: 'Takım bulunamadı.' });
    if (!team.pendingInvites.includes(String(user.id))) return res.json({ success: false, message: 'Bu takımdan davet almadınız.' });
    if (team.members.length >= 4) return res.json({ success: false, message: 'Takım dolu.' });
    
    // Üye ekle, daveti kaldır
    team.members.push(String(user.id));
    team.pendingInvites = team.pendingInvites.filter(id => id !== String(user.id));
    teams[teamId] = team;
    saveTeams(teams);
    
    // Takım liderine bildirim
    const notification = {
        id: Date.now().toString(),
        type: 'team_joined',
        message: `"${user.username}" takımınıza katıldı!`,
        severity: 'success',
        sound: true,
        createdAt: new Date().toISOString()
    };
    sendNotification(team.leaderId, notification);
    
    res.json({ success: true, message: `"${team.name}" takımına katıldınız!` });
});

// Daveti reddet
app.post('/api/teams/decline', checkAuth, (req, res) => {
    const { teamId } = req.body;
    const user = db.findUserById(req.session.userId);
    const teams = getTeams();
    
    const team = teams[teamId];
    if (!team) return res.json({ success: false, message: 'Takım bulunamadı.' });
    
    team.pendingInvites = team.pendingInvites.filter(id => id !== String(user.id));
    teams[teamId] = team;
    saveTeams(teams);
    
    res.json({ success: true, message: 'Davet reddedildi.' });
});

// Takımdan ayrıl
app.post('/api/teams/leave', checkAuth, (req, res) => {
    const user = db.findUserById(req.session.userId);
    const teams = getTeams();
    const myTeam = getUserTeam(user.id);
    
    if (!myTeam) return res.json({ success: false, message: 'Bir takımda değilsiniz.' });
    
    if (String(myTeam.leaderId) === String(user.id) && myTeam.members.length > 1) {
        return res.json({ success: false, message: 'Lider olarak ayrılmak için önce liderliği devredin veya takımı dağıtın.' });
    }
    
    if (myTeam.members.length === 1) {
        // Son üye — takımı sil
        delete teams[myTeam.id];
    } else {
        myTeam.members = myTeam.members.filter(id => id !== String(user.id));
        // Lider ayrılıyorsa yeni lider ata
        if (String(myTeam.leaderId) === String(user.id)) {
            myTeam.leaderId = myTeam.members[0];
        }
        teams[myTeam.id] = myTeam;
    }
    saveTeams(teams);
    res.json({ success: true, message: 'Takımdan ayrıldınız.' });
});

// Takım sıralaması API
app.get('/api/teams/ranking', checkAuth, (req, res) => {
    const teams = getTeams();
    const ranking = Object.values(teams).map(t => ({
        id: t.id,
        name: t.name,
        points: calcTeamPoints(t),
        memberCount: t.members.length,
        members: t.members.map(uid => {
            const u = db.findUserById(uid);
            return u ? { username: u.username, avatar: u.avatar || null } : null;
        }).filter(Boolean)
    })).sort((a, b) => b.points - a.points);
    res.json(ranking);
});

// Bekleyen davetleri getir
app.get('/api/teams/invites', checkAuth, (req, res) => {
    const user = db.findUserById(req.session.userId);
    const teams = getTeams();
    const invites = Object.values(teams).filter(t => t.pendingInvites.includes(String(user.id)));
    res.json(invites.map(t => ({ id: t.id, name: t.name, leaderUsername: (db.findUserById(t.leaderId) || {}).username })));
});

// Takıma katılma isteği gönder
app.post('/api/teams/request-join', checkAuth, (req, res) => {
    const { teamId } = req.body;
    const user = db.findUserById(req.session.userId);
    const teams = getTeams();
    if (getUserTeam(user.id)) return res.json({ success: false, message: 'Zaten bir takıma üyesiniz.' });
    const team = teams[teamId];
    if (!team) return res.json({ success: false, message: 'Takım bulunamadı.' });
    if (team.members.length >= 4) return res.json({ success: false, message: 'Takım dolu.' });
    if (!team.joinRequests) team.joinRequests = [];
    if (team.joinRequests.includes(String(user.id))) return res.json({ success: false, message: 'Zaten istek gönderdiniz.' });
    team.joinRequests.push(String(user.id));
    teams[teamId] = team;
    saveTeams(teams);
    sendNotification(team.leaderId, {
        id: Date.now().toString(), type: 'join_request', teamId: team.id, teamName: team.name,
        fromUserId: String(user.id), fromUsername: user.username,
        message: `"${user.username}" takımınıza katılmak istiyor!`,
        severity: 'info', sound: true, createdAt: new Date().toISOString()
    });
    res.json({ success: true, message: `"${team.name}" takımına istek gönderildi.` });
});

// Katılma isteğini onayla
app.post('/api/teams/approve-join', checkAuth, (req, res) => {
    const { teamId, targetUserId } = req.body;
    const user = db.findUserById(req.session.userId);
    const teams = getTeams();
    const team = teams[teamId];
    if (!team) return res.json({ success: false, message: 'Takım bulunamadı.' });
    if (String(team.leaderId) !== String(user.id)) return res.json({ success: false, message: 'Sadece lider onaylayabilir.' });
    if (team.members.length >= 4) return res.json({ success: false, message: 'Takım dolu.' });
    if (!team.joinRequests) team.joinRequests = [];
    if (!team.joinRequests.includes(String(targetUserId))) return res.json({ success: false, message: 'İstek bulunamadı.' });
    if (getUserTeam(targetUserId)) {
        team.joinRequests = team.joinRequests.filter(id => id !== String(targetUserId));
        teams[teamId] = team; saveTeams(teams);
        return res.json({ success: false, message: 'Kullanıcı başka takıma katılmış.' });
    }
    team.members.push(String(targetUserId));
    team.joinRequests = team.joinRequests.filter(id => id !== String(targetUserId));
    teams[teamId] = team; saveTeams(teams);
    const targetUser = db.findUserById(targetUserId);
    sendNotification(targetUserId, {
        id: Date.now().toString(), type: 'join_approved',
        message: `"${team.name}" takımına katılma isteğiniz onaylandı! Hoş geldiniz!`,
        severity: 'success', sound: true, createdAt: new Date().toISOString()
    });
    res.json({ success: true, message: `${targetUser ? targetUser.username : 'Kullanıcı'} takıma eklendi.` });
});

// Katılma isteğini reddet
app.post('/api/teams/reject-join', checkAuth, (req, res) => {
    const { teamId, targetUserId } = req.body;
    const user = db.findUserById(req.session.userId);
    const teams = getTeams();
    const team = teams[teamId];
    if (!team) return res.json({ success: false, message: 'Takım bulunamadı.' });
    if (String(team.leaderId) !== String(user.id)) return res.json({ success: false, message: 'Sadece lider reddedebilir.' });
    if (!team.joinRequests) team.joinRequests = [];
    team.joinRequests = team.joinRequests.filter(id => id !== String(targetUserId));
    teams[teamId] = team; saveTeams(teams);
    sendNotification(targetUserId, {
        id: Date.now().toString(), type: 'join_rejected',
        message: `"${team.name}" takımına katılma isteğiniz reddedildi.`,
        severity: 'warning', sound: false, createdAt: new Date().toISOString()
    });
    res.json({ success: true, message: 'İstek reddedildi.' });
});

// Bekleyen katılma isteklerini getir (lider için)
app.get('/api/teams/join-requests', checkAuth, (req, res) => {
    const user = db.findUserById(req.session.userId);
    const myTeam = getUserTeam(user.id);
    if (!myTeam || String(myTeam.leaderId) !== String(user.id)) return res.json([]);
    const requests = (myTeam.joinRequests || []).map(uid => {
        const u = db.findUserById(uid);
        return u ? { id: String(u.id), username: u.username, avatar: u.avatar || null } : null;
    }).filter(Boolean);
    res.json(requests);
});

// Tüm takımları listele (katılmak isteyenler için)
app.get('/api/teams/list', checkAuth, (req, res) => {
    const user = db.findUserById(req.session.userId);
    const teams = getTeams();
    const myTeam = getUserTeam(user.id);
    const list = Object.values(teams).map(t => ({
        id: t.id, name: t.name, memberCount: t.members.length,
        isFull: t.members.length >= 4,
        members: t.members.map(uid => { const u = db.findUserById(uid); return u ? { username: u.username, avatar: u.avatar || null } : null; }).filter(Boolean),
        hasRequested: (t.joinRequests || []).includes(String(user.id)),
        isMyTeam: !!(myTeam && myTeam.id === t.id)
    }));
    res.json(list);
});

// Takım detayı (üyeler + puanlar)
app.get('/api/teams/detail/:teamId', checkAuth, (req, res) => {
    const teams = getTeams();
    const team = teams[req.params.teamId];
    if (!team) return res.json({ success: false, message: 'Takım bulunamadı.' });
    const currentUserId = String(req.session.userId);
    const labs = getLabs();
    const ctf = getCtfChallenges();
    const scenarios = getScenarios();
    const members = (team.members || []).map(uid => {
        const u = db.findUserById(uid);
        if (!u) return null;
        let pts = 0;
        (u.solved || []).forEach(id => {
            if (labs[id]) pts += labs[id].points || 0;
            if (ctf[id])  pts += ctf[id].points || 0;
            Object.values(scenarios).forEach(s => {
                const task = (s.tasks || []).find(t => `${s.id}_task_${t.id}` === id);
                if (task) pts += task.points || 0;
            });
        });
        return {
            id: String(u.id),
            username: u.username,
            avatar: u.avatar || null,
            points: pts,
            solvedCount: (u.solved || []).length,
            isLeader: String(u.id) === String(team.leaderId),
            online: String(u.id) === currentUserId || isUserOnline(u.id)
        };
    }).filter(Boolean).sort((a, b) => b.points - a.points);
    res.json({ success: true, team: { id: team.id, name: team.name, leaderId: String(team.leaderId), points: calcTeamPoints(team), memberCount: team.members.length }, members });
});

// Takım chat geçmişi
app.get('/api/teams/chat', checkAuth, (req, res) => {
    const user = db.findUserById(req.session.userId);
    const team = getUserTeam(user.id);
    if (!team) return res.json({ success: false, message: 'Bir takımda değilsiniz.' });

    const messages = normalizeTeamChat(team).map(m => {
        const sender = db.findUserById(m.senderId);
        return {
            ...m,
            senderUsername: sender ? sender.username : (m.senderUsername || 'Bilinmeyen'),
            senderAvatar: sender ? (sender.avatar || null) : (m.senderAvatar || null),
            mine: String(m.senderId) === String(user.id)
        };
    });
    res.json({ success: true, teamId: team.id, teamName: team.name, messages });
});

// Takım chat mesajı gönder
app.post('/api/teams/chat', checkAuth, (req, res) => {
    const user = db.findUserById(req.session.userId);
    const teams = getTeams();
    const team = Object.values(teams).find(t => (t.members || []).includes(String(user.id)));
    if (!team) return res.json({ success: false, message: 'Bir takımda değilsiniz.' });

    const text = sanitizeInput(req.body.message || '', 800).replace(/\s+/g, ' ').trim();
    if (!text) return res.json({ success: false, message: 'Mesaj boş olamaz.' });

    normalizeTeamChat(team);
    const message = {
        id: `${Date.now()}_${user.id}`,
        teamId: team.id,
        senderId: String(user.id),
        senderUsername: user.username,
        senderAvatar: user.avatar || null,
        message: text,
        createdAt: new Date().toISOString()
    };

    team.chatMessages.push(message);
    team.chatMessages = team.chatMessages.slice(-200);
    teams[team.id] = team;
    saveTeams(teams);

    const payload = {
        id: Date.now().toString(),
        type: 'team_chat_message',
        teamId: team.id,
        message,
        severity: 'info',
        sound: false,
        createdAt: message.createdAt
    };
    sendTeamChatEvent(team, payload);

    res.json({ success: true, message: { ...message, mine: true } });
});

// Takım chat yazıyor durumu
app.post('/api/teams/chat/typing', checkAuth, (req, res) => {
    const user = db.findUserById(req.session.userId);
    const team = getUserTeam(user.id);
    if (!team) return res.json({ success: false, message: 'Bir takımda değilsiniz.' });

    const typing = !!req.body.typing;
    if (!teamTypingStates.has(team.id)) teamTypingStates.set(team.id, new Map());
    const state = teamTypingStates.get(team.id);
    if (typing) {
        state.set(String(user.id), { userId: String(user.id), username: user.username, expiresAt: Date.now() + 3500 });
    } else {
        state.delete(String(user.id));
    }

    const payload = {
        id: Date.now().toString(),
        type: 'team_chat_typing',
        teamId: team.id,
        userId: String(user.id),
        username: user.username,
        typing,
        createdAt: new Date().toISOString()
    };

    (team.members || []).forEach(uid => {
        const id = String(uid);
        if (id === String(user.id) || !sseClients.has(id)) return;
        try {
            sseClients.get(id).res.write(`data: ${JSON.stringify(payload)}\n\n`);
        } catch(e) {
            sseClients.delete(id);
        }
    });

    res.json({ success: true });
});

// Takım chat aktif yazanlar
app.get('/api/teams/chat/typing', checkAuth, (req, res) => {
    const user = db.findUserById(req.session.userId);
    const team = getUserTeam(user.id);
    if (!team) return res.json({ success: false, typing: [] });

    const state = teamTypingStates.get(team.id);
    if (!state) return res.json({ success: true, typing: [] });

    const now = Date.now();
    const typing = [];
    for (const [uid, item] of state.entries()) {
        if (item.expiresAt < now) {
            state.delete(uid);
        } else if (uid !== String(user.id)) {
            typing.push({ userId: uid, username: item.username });
        }
    }

    res.json({ success: true, typing });
});

// Üyeyi takımdan çıkar (sadece lider)
app.post('/api/teams/kick', checkAuth, (req, res) => {
    const { targetUserId } = req.body;
    const user = db.findUserById(req.session.userId);
    const teams = getTeams();
    const myTeam = getUserTeam(user.id);
    if (!myTeam) return res.json({ success: false, message: 'Takımda değilsiniz.' });
    if (String(myTeam.leaderId) !== String(user.id)) return res.json({ success: false, message: 'Sadece lider üye çıkarabilir.' });
    if (String(targetUserId) === String(user.id)) return res.json({ success: false, message: 'Kendinizi çıkaramazsınız.' });
    if (!myTeam.members.includes(String(targetUserId))) return res.json({ success: false, message: 'Bu kullanıcı takımda değil.' });
    myTeam.members = myTeam.members.filter(id => id !== String(targetUserId));
    teams[myTeam.id] = myTeam;
    saveTeams(teams);
    sendNotification(targetUserId, {
        id: Date.now().toString(), type: 'kicked',
        message: `"${myTeam.name}" takımından çıkarıldınız.`,
        severity: 'warning', sound: true, createdAt: new Date().toISOString()
    });
    res.json({ success: true, message: 'Üye takımdan çıkarıldı.' });
});

// Liderliği devret
app.post('/api/teams/transfer-leader', checkAuth, (req, res) => {
    const { targetUserId } = req.body;
    const user = db.findUserById(req.session.userId);
    const teams = getTeams();
    const myTeam = getUserTeam(user.id);
    if (!myTeam) return res.json({ success: false, message: 'Takımda değilsiniz.' });
    if (String(myTeam.leaderId) !== String(user.id)) return res.json({ success: false, message: 'Sadece lider devredebilir.' });
    if (!myTeam.members.includes(String(targetUserId))) return res.json({ success: false, message: 'Bu kullanıcı takımda değil.' });
    myTeam.leaderId = String(targetUserId);
    teams[myTeam.id] = myTeam;
    saveTeams(teams);
    const target = db.findUserById(targetUserId);
    sendNotification(targetUserId, {
        id: Date.now().toString(), type: 'leader_transfer',
        message: `"${myTeam.name}" takımının liderliği size devredildi!`,
        severity: 'success', sound: true, createdAt: new Date().toISOString()
    });
    res.json({ success: true, message: `Liderlik ${target ? target.username : 'kullanıcıya'} devredildi.` });
});

// Son ilk kan kayıtları (dashboard için)
app.get('/api/firstblood/recent', checkAuth, (req, res) => {
    const fb = getFirstBlood();
    const recent = Object.values(fb)
        .filter(f => f.solvedAt)
        .sort((a, b) => new Date(b.solvedAt) - new Date(a.solvedAt))
        .slice(0, 4)
        .map(f => ({
            username: f.username,
            challengeTitle: f.challengeTitle || '—',
            solvedAt: f.solvedAt
        }));
    res.json(recent);
});

// Bekleyen ilk kan bildirimini getir ve temizle
app.get('/api/firstblood/pending', checkAuth, (req, res) => {
    const userId = String(req.session.userId);
    const fb = getFirstBlood();
    const pending = Object.entries(fb)
        .filter(([id, data]) => data.pendingNotify === userId)
        .map(([id, data]) => ({
            challengeId: id,
            challengeTitle: data.challengeTitle || id,
            username: data.username,
            solvedAt: data.solvedAt
        }));
    
    // Bildirimleri işaretlenmiş olarak güncelle
    if (pending.length > 0) {
        pending.forEach(p => {
            if (fb[p.challengeId]) {
                delete fb[p.challengeId].pendingNotify;
            }
        });
        saveFirstBlood(fb);
    }
    
    res.json(pending);
});

// SSE Notification Stream Endpoint
app.get('/api/notifications/stream', checkAuth, (req, res) => {
    const userId = req.session.userId.toString();
    touchUserOnline(userId);

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // nginx proxy varsa buffer'ı kapat
    res.flushHeaders();

    // Eski bağlantıyı kapat (aynı kullanıcı yeni sekme açtıysa)
    if (sseClients.has(userId)) {
        try { sseClients.get(userId).res.end(); } catch(e) {}
    }

    // Bağlantıyı kaydet
    const client = { res, connectedAt: new Date() };
    sseClients.set(userId, client);

    // Bekleyen bildirimleri async gönder — bağlantıyı bloke etme
    setImmediate(() => {
        try {
            const systemData = getSystemData();
            if (systemData.pendingNotifications && systemData.pendingNotifications[userId] && systemData.pendingNotifications[userId].length > 0) {
                const pendingNotifs = systemData.pendingNotifications[userId];
                pendingNotifs.forEach(notif => {
                    try { res.write(`data: ${JSON.stringify(notif)}\n\n`); } catch(e) {}
                });
                systemData.pendingNotifications[userId] = [];
                saveSystemData(systemData);
            }
        } catch(e) {}
    });

    // Bağlantı kapanınca temizle
    req.on('close', () => {
        touchUserOnline(userId);
        if (sseClients.get(userId) === client) {
            sseClients.delete(userId);
        }
    });
});

// ══════════════════════════════════════════
// HACKERBOX — Kişisel Linux Ortamı (VMID 110 klonu)
// ══════════════════════════════════════════

const HACKERBOX_TEMPLATE_VMID = Number(process.env.HACKERBOX_TEMPLATE_VMID) || 110;
const HACKERBOX_VNC_PORT = Number(process.env.HACKERBOX_VNC_PORT) || 8080;
const HACKERBOX_VNC_PASSWORD = process.env.HACKERBOX_VNC_PASSWORD || ''; // .env üzerinden verilir

// Proxmox task'ının bitmesini bekle — VM status poll ile
async function waitForClone(newVmid, maxWaitMs = 300000) {
    // Clone poll için kısa timeout'lu ayrı instance
    const px = axios.create({
        baseURL: `https://${PVE_IP}:8006/api2/json`,
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
        headers: { 'Authorization': API_TOKEN },
        timeout: 8000
    });

    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        await new Promise(r => setTimeout(r, 5000));
        try {
            const res = await px.get(`/nodes/${PVE_NODE}/qemu/${newVmid}/status/current`);
            const status = res.data.data.status;
            // Clone bitti — VM stopped veya running durumunda görünüyor
            if (status === 'stopped' || status === 'running') {
                console.log(`[HackerBox] VMID ${newVmid} clone bitti, status: ${status}`);
                return true;
            }
        } catch(e) {
            // 404 = VM henüz yok (clone devam ediyor) — normal
            console.log(`[HackerBox] VMID ${newVmid} henüz hazır değil... (${Math.round((Date.now()-start)/1000)}s)`);
        }
    }
    throw new Error('Clone timeout — 5 dakika içinde tamamlanamadı');
}

// HackerBox bağlan: VMID 110'u klonla, kullanıcıya ata
app.post('/api/hackerbox/connect', checkAuth, async (req, res) => {
    const user = db.findUserById(req.session.userId);
    if (user.hackerbox_vmid) {
        return res.json({
            success: true,
            already: true,
            vmid: user.hackerbox_vmid,
            ip: user.hackerbox_ip || null,
            expiry: user.hackerbox_expiry || null
        });
    }

    const newId = 20000 + Math.floor(Math.random() * 9000);
    const expiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    // DB'ye hemen yaz — frontend response beklemeden poll başlatabilsin
    db.updateUser(user.id, { hackerbox_vmid: newId, hackerbox_ip: null, hackerbox_expiry: expiry });
    res.json({ success: true, vmid: newId, expiry });

    // Arka planda: clone → VM görünene kadar bekle → start
    (async () => {
        try {
            console.log(`[HackerBox] ${user.username}: clone başlatılıyor → VMID ${newId}`);

            // 1. Clone isteği at
            await proxmox.post(`/nodes/${PVE_NODE}/qemu/${HACKERBOX_TEMPLATE_VMID}/clone`, {
                newid: newId,
                name: `hackerbox-${user.username}`,
                full: 1
            });

            console.log(`[HackerBox] ${user.username}: clone isteği gönderildi, VM hazır olana kadar bekleniyor...`);

            // 2. VM Proxmox'ta görünene kadar bekle (clone bitmesini VM status ile anla)
            await waitForClone(newId);

            console.log(`[HackerBox] ${user.username}: clone tamamlandı, MAC atanıyor ve başlatılıyor...`);

            // 3. MAC ata
            const randomMac = generateRandomMac();
            await proxmox.post(`/nodes/${PVE_NODE}/qemu/${newId}/config`, {
                net0: `virtio,bridge=vmbr0,macaddr=${randomMac}`
            });

            // 4. Başlat
            await proxmox.post(`/nodes/${PVE_NODE}/qemu/${newId}/status/start`);

            console.log(`[HackerBox] ${user.username}: VM ${newId} başlatıldı, IP bekleniyor...`);

        } catch(e) {
            console.error(`[HackerBox] ${user.username}: HATA —`, e.message);
            // Hata durumunda DB'yi temizle
            const u = db.findUserById(user.id);
            if (u && u.hackerbox_vmid === newId) {
                db.updateUser(user.id, { hackerbox_vmid: null, hackerbox_ip: null, hackerbox_expiry: null });
            }
            try { 
                await proxmox.post(`/nodes/${PVE_NODE}/qemu/${newId}/status/stop`).catch(()=>{});
                await new Promise(r => setTimeout(r, 3000));
                await proxmox.delete(`/nodes/${PVE_NODE}/qemu/${newId}`); 
            } catch(_) {}
        }
    })();
});

// HackerBox IP al (VM boot olduktan sonra QEMU agent'tan)
app.get('/api/hackerbox/ip', checkAuth, async (req, res) => {
    const user = db.findUserById(req.session.userId);
    if (!user.hackerbox_vmid) return res.json({ ip: null });
    // Daha önce çözümlendiyse tekrar Proxmox'a gitme
    if (user.hackerbox_ip) return res.json({ ip: user.hackerbox_ip, vmid: user.hackerbox_vmid });
    try {
        const agentRes = await proxmox.get(`/nodes/${PVE_NODE}/qemu/${user.hackerbox_vmid}/agent/network-get-interfaces`);
        const interfaces = agentRes.data.data.result;
        let foundIp = null;
        for (const iface of interfaces) {
            if (iface.name !== 'lo' && iface['ip-addresses']) {
                const ipv4 = iface['ip-addresses'].find(ip => ip['ip-address-type'] === 'ipv4');
                if (ipv4) { foundIp = ipv4['ip-address']; break; }
            }
        }
        if (foundIp) {
            db.updateUser(user.id, { hackerbox_ip: foundIp });
            return res.json({ ip: foundIp, vmid: user.hackerbox_vmid });
        }
        res.json({ ip: null, vmid: user.hackerbox_vmid });
    } catch (e) {
        res.json({ ip: null, vmid: user.hackerbox_vmid });
    }
});

// HackerBox durumu
app.get('/api/hackerbox/status', checkAuth, (req, res) => {
    const user = db.findUserById(req.session.userId);
    // Süre dolmuşsa otomatik temizle (VM silme arka planda)
    if (user.hackerbox_vmid && user.hackerbox_expiry && new Date() > new Date(user.hackerbox_expiry)) {
        const vmid = user.hackerbox_vmid;
        db.updateUser(user.id, { hackerbox_vmid: null, hackerbox_ip: null, hackerbox_expiry: null });
        proxmox.post(`/nodes/${PVE_NODE}/qemu/${vmid}/status/stop`)
            .then(() => new Promise(r => setTimeout(r, 3000)))
            .then(() => proxmox.delete(`/nodes/${PVE_NODE}/qemu/${vmid}`))
            .catch(() => {});
        return res.json({ active: false, vmid: null, ip: null, vncUrl: null, expiry: null, expired: true });
    }
    res.json({
        active: !!user.hackerbox_vmid,
        vmid: user.hackerbox_vmid || null,
        ip: user.hackerbox_ip || null,
        expiry: user.hackerbox_expiry || null,
        vncUrl: user.hackerbox_ip
            ? `http://${user.hackerbox_ip}:${HACKERBOX_VNC_PORT}/vnc.html?autoconnect=true&password=${HACKERBOX_VNC_PASSWORD}`
            : null
    });
});

// HackerBox süre uzat (+60 dakika)
app.post('/api/hackerbox/extend', checkAuth, (req, res) => {
    const user = db.findUserById(req.session.userId);
    if (!user.hackerbox_vmid) return res.json({ success: false, message: 'Aktif HackerBox yok.' });
    const current = user.hackerbox_expiry ? new Date(user.hackerbox_expiry) : new Date();
    const base = current > new Date() ? current : new Date(); // süresi dolmamışsa mevcut, dolmuşsa şimdiden
    const newExpiry = new Date(base.getTime() + 60 * 60 * 1000).toISOString();
    db.updateUser(user.id, { hackerbox_expiry: newExpiry });
    res.json({ success: true, expiry: newExpiry });
});

// HackerBox bağlantıyı kes ve VM'i sil
app.post('/api/hackerbox/disconnect', checkAuth, async (req, res) => {
    const user = db.findUserById(req.session.userId);
    if (!user.hackerbox_vmid) return res.json({ success: false, message: 'Aktif HackerBox yok.' });
    const vmid = user.hackerbox_vmid;
    db.updateUser(user.id, { hackerbox_vmid: null, hackerbox_ip: null });
    try {
        await proxmox.post(`/nodes/${PVE_NODE}/qemu/${vmid}/status/stop`);
        await new Promise(r => setTimeout(r, 4000));
        await proxmox.delete(`/nodes/${PVE_NODE}/qemu/${vmid}`);
        res.json({ success: true });
    } catch (e) {
        res.json({ success: true, message: 'DB sıfırlandı, VM kapatma sırasında hata oluştu.' });
    }
});

app.post('/api/stop-lab', checkAuth, async (req, res) => {
    const user = db.findUserById(req.session.userId);
    if (!user.active_vmid) return res.json({ success: false });
    const vmid = user.active_vmid;
    db.updateUser(user.id, { active_vmid: null, active_vmid_id: null, ip_address: null, expiry: null });
    try {
        await proxmox.post(`/nodes/${PVE_NODE}/qemu/${vmid}/status/stop`);
        await new Promise(r => setTimeout(r, 4000));
        await proxmox.delete(`/nodes/${PVE_NODE}/qemu/${vmid}`);
        res.json({ success: true });
    } catch (e) { res.json({ success: false }); }
});

// SSE Ping Mechanism - Send ping every 30 seconds to all active connections
setInterval(() => {
    sseClients.forEach((client, userId) => {
        try {
            client.res.write('event: ping\ndata: {}\n\n');
        } catch (err) {
            // Connection is broken, remove it
            sseClients.delete(userId);
        }
    });
}, 30000);

app.listen(port, () => console.log(`[+] Arena: ${port}`));
