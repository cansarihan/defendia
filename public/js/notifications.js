/* ══════════════════════════════════════════
   NOTIFICATIONS.JS
   İlk Kan Banner + Pending Check + Ses
══════════════════════════════════════════ */

/* ── Global AudioContext — bir kez yarat, hep kullan ── */
var _audioCtx = null;

function _getAudioCtx() {
  if (!_audioCtx) {
    try {
      _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch(e) { return null; }
  }
  return _audioCtx;
}

/* Kullanıcının ilk etkileşiminde context'i unlock et */
function _unlockAudio() {
  var ctx = _getAudioCtx();
  if (ctx && ctx.state === 'suspended') {
    ctx.resume();
  }
}
document.addEventListener('click',   _unlockAudio, { once: false, passive: true });
document.addEventListener('keydown', _unlockAudio, { once: false, passive: true });
document.addEventListener('touchstart', _unlockAudio, { once: false, passive: true });

/* ── Ses çal ── */
function _playSound(type) {
  var ctx = _getAudioCtx();
  if (!ctx) return;

  var doPlay = function() {
    try {
      if (type === 'firstblood') {
        /* Dramatik alarm — 3 bip */
        [0, 0.18, 0.36].forEach(function(delay) {
          var o = ctx.createOscillator();
          var g = ctx.createGain();
          o.connect(g); g.connect(ctx.destination);
          o.type = 'square';
          o.frequency.value = 880;
          g.gain.setValueAtTime(0.35, ctx.currentTime + delay);
          g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + 0.14);
          o.start(ctx.currentTime + delay);
          o.stop(ctx.currentTime + delay + 0.14);
        });
      } else {
        /* Normal bildirim — 2 nota */
        var o1 = ctx.createOscillator(), g1 = ctx.createGain();
        o1.connect(g1); g1.connect(ctx.destination);
        o1.type = 'sine'; o1.frequency.value = 520;
        g1.gain.setValueAtTime(0.3, ctx.currentTime);
        g1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        o1.start(ctx.currentTime); o1.stop(ctx.currentTime + 0.3);

        var o2 = ctx.createOscillator(), g2 = ctx.createGain();
        o2.connect(g2); g2.connect(ctx.destination);
        o2.type = 'sine'; o2.frequency.value = 660;
        g2.gain.setValueAtTime(0.2, ctx.currentTime + 0.15);
        g2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
        o2.start(ctx.currentTime + 0.15); o2.stop(ctx.currentTime + 0.45);
      }
    } catch(e) {}
  };

  if (ctx.state === 'suspended') {
    ctx.resume().then(doPlay).catch(function() {});
  } else {
    doPlay();
  }
}

/* ── Bekleyen ilk kan bildirimlerini kontrol et ── */
function checkPendingFirstBloods() {
  fetch('/api/firstblood/pending')
    .then(function(r) { return r.json(); })
    .then(function(pending) {
      if (pending && pending.length > 0) {
        setTimeout(function() {
          pending.forEach(function(p, i) {
            setTimeout(function() {
              showFirstBloodBanner({
                type: 'firstblood',
                message: '🩸 İLK KAN! "' + p.username + '" → "' + p.challengeTitle + '" görevini ilk çözdü!',
                severity: 'danger',
                sound: true,
                createdAt: p.solvedAt
              });
            }, i * 600);
          });
        }, 800);
      }
    })
    .catch(function() {});
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', checkPendingFirstBloods);
} else {
  setTimeout(checkPendingFirstBloods, 800);
}

/* ── İlk Kan Banner ── */
function showFirstBloodBanner(notif) {
  var existing = document.getElementById('firstBloodOverlay');
  if (existing) existing.remove();

  /* Ses çal */
  _playSound('firstblood');

  var overlay = document.createElement('div');
  overlay.id = 'firstBloodOverlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(8,12,24,0.92);z-index:99999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(16px);';
  var msg = notif.message.replace('🩸 İLK KAN! ', '');
  overlay.innerHTML = '<div style="max-width:480px;width:90%;background:rgba(13,18,36,0.98);border:2px solid #ef4444;border-radius:20px;padding:48px 36px;text-align:center;box-shadow:0 0 80px rgba(239,68,68,0.5);position:relative;">'
    + '<div style="font-size:80px;margin-bottom:8px;">🩸</div>'
    + '<div style="font-size:10px;letter-spacing:4px;color:#ef4444;text-transform:uppercase;font-weight:800;margin-bottom:10px;font-family:JetBrains Mono,monospace;">İLK KAN</div>'
    + '<div style="font-size:17px;color:#f1f5f9;font-weight:700;line-height:1.5;margin-bottom:28px;">' + msg + '</div>'
    + '<button id="fbCloseBtn" style="background:#ef4444;color:#080c18;border:none;padding:12px 44px;border-radius:8px;font-size:13px;font-weight:900;cursor:pointer;text-transform:uppercase;letter-spacing:2px;">ANLADIM</button>'
    + '</div>';
  document.body.appendChild(overlay);
  function doClose() { overlay.remove(); document.removeEventListener('keydown', esc); }
  document.getElementById('fbCloseBtn').addEventListener('click', doClose);
  function esc(e) { if (e.key === 'Escape') doClose(); }
  document.addEventListener('keydown', esc);
  overlay.addEventListener('click', function(e) { if (e.target === overlay) doClose(); });
}

/* ── processNotification — SSE mesajlarını işler ── */
function processNotification(notif) {
  if (notif.type === 'banned') {
    _showBanModal(notif);
    return; // handleNotification çağırma
  }
  if (notif.type === 'firstblood') {
    if (typeof handleNotification === 'function') handleNotification(notif);
    showFirstBloodBanner(notif);
  } else {
    if (typeof handleNotification === 'function') handleNotification(notif);
  }
}

/* ── Ban Modal (aktif oturum sırasında yasaklanınca) ── */
function _showBanModal(notif) {
  var existing = document.getElementById('activeBanOverlay');
  if (existing) existing.remove();
  var expText = notif.expiresAt
    ? 'Yasak bitiş: ' + new Date(notif.expiresAt).toLocaleString('tr-TR')
    : 'Süresiz yasak';
  var overlay = document.createElement('div');
  overlay.id = 'activeBanOverlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(2,6,23,0.97);z-index:999999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(20px);';
  overlay.innerHTML = '<div style="max-width:500px;width:92%;background:rgba(10,15,30,0.99);border:2px solid #ef4444;border-radius:20px;padding:48px 36px;text-align:center;box-shadow:0 0 100px rgba(239,68,68,0.5);position:relative;">'
    + '<div style="font-size:72px;margin-bottom:12px;animation:bellPulse 1s infinite;">🚫</div>'
    + '<div style="font-size:10px;letter-spacing:4px;color:#ef4444;text-transform:uppercase;font-weight:800;margin-bottom:14px;font-family:JetBrains Mono,monospace;">ERİŞİM ENGELLENDİ</div>'
    + '<div style="font-size:18px;color:#f1f5f9;font-weight:700;margin-bottom:20px;line-height:1.5;">Defendia Network Defense tarafından yasaklandınız.</div>'
    + '<div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:10px;padding:16px;margin-bottom:20px;text-align:left;">'
    + '<div style="display:flex;justify-content:space-between;margin-bottom:8px;"><span style="font-size:11px;color:#64748b;font-family:JetBrains Mono,monospace;">SEBEP</span><span style="font-size:12px;color:#fca5a5;font-weight:600;">' + (notif.reason || 'Belirtilmedi') + '</span></div>'
    + '<div style="display:flex;justify-content:space-between;margin-bottom:8px;"><span style="font-size:11px;color:#64748b;font-family:JetBrains Mono,monospace;">YETKİLİ</span><span style="font-size:12px;color:#94a3b8;">' + (notif.bannedBy || 'Admin') + '</span></div>'
    + '<div style="display:flex;justify-content:space-between;"><span style="font-size:11px;color:#64748b;font-family:JetBrains Mono,monospace;">SÜRE</span><span style="font-size:12px;color:' + (notif.expiresAt ? '#fbbf24' : '#ef4444') + ';font-weight:600;">' + expText + '</span></div>'
    + '</div>'
    + '<div style="font-size:12px;color:#475569;font-family:JetBrains Mono,monospace;margin-bottom:20px;">3 saniye içinde çıkış yapılıyor...</div>'
    + '<div style="position:absolute;top:14px;left:14px;width:16px;height:16px;border-top:2px solid #ef4444;border-left:2px solid #ef4444;border-radius:2px 0 0 0;opacity:0.6;"></div>'
    + '<div style="position:absolute;top:14px;right:14px;width:16px;height:16px;border-top:2px solid #ef4444;border-right:2px solid #ef4444;border-radius:0 2px 0 0;opacity:0.6;"></div>'
    + '<div style="position:absolute;bottom:14px;left:14px;width:16px;height:16px;border-bottom:2px solid #ef4444;border-left:2px solid #ef4444;border-radius:0 0 0 2px;opacity:0.6;"></div>'
    + '<div style="position:absolute;bottom:14px;right:14px;width:16px;height:16px;border-bottom:2px solid #ef4444;border-right:2px solid #ef4444;border-radius:0 0 2px 0;opacity:0.6;"></div>'
    + '</div>';
  document.body.appendChild(overlay);
  // 3 saniye sonra logout
  setTimeout(function() {
    window.location.href = '/logout';
  }, 3000);
}
