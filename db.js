const fs = require('fs');
const path = require('path');
const dbPath = path.join(__dirname, 'users.json');

// Dosya yoksa boş bir diziyle oluşturur
if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, JSON.stringify([]));
}

// Kullanıcı girdilerinden HTML tag'lerini temizle
function sanitizeStr(str, maxLen = 500) {
    if (typeof str !== 'string') return str;
    return str
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')
        .trim()
        .slice(0, maxLen);
}

// Kullanıcı tarafından değiştirilebilen alanlar sanitize edilir
const SANITIZE_FIELDS = ['bio'];

const db = {
    getUsers: () => {
        try {
            return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        } catch (e) {
            return [];
        }
    },
    saveUsers: (users) => fs.writeFileSync(dbPath, JSON.stringify(users, null, 2)),
    findUser: (username) => db.getUsers().find(u => u.username === username),
    findUserById: (id) => db.getUsers().find(u => Number(u.id) === Number(id)),
    updateUser: (id, data) => {
        let users = db.getUsers();
        const index = users.findIndex(u => Number(u.id) === Number(id));
        if (index !== -1) {
            // Sanitize edilmesi gereken alanları temizle
            const sanitized = { ...data };
            SANITIZE_FIELDS.forEach(field => {
                if (sanitized[field] !== undefined) {
                    sanitized[field] = sanitizeStr(sanitized[field], 300);
                }
            });
            users[index] = { ...users[index], ...sanitized };
            db.saveUsers(users);
            return true;
        }
        return false;
    }
};

module.exports = db;
