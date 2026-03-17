const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { readJSON, writeJSON } = require('../lib/json-store');

// ===== Passkeys (WebAuthn) config =====

const PASSKEYS_FILE = path.join(__dirname, '..', '.dashboard', 'passkeys.json');
const RP_ID = process.env.WEBAUTHN_RP_ID || 'dashboard.infozen-consulting.com';
const RP_NAME = 'Dev Dashboard';
const ORIGIN = process.env.WEBAUTHN_ORIGIN || 'https://dashboard.infozen-consulting.com';
const ENV_PATH = path.join(__dirname, '..', '.env');

const passkeyChallenge = new Map(); // 'registration' | 'authentication' -> { challenge, timestamp }

function loadPasskeys() {
  return readJSON(PASSKEYS_FILE, { credentials: [] });
}

function savePasskeys(data) {
  writeJSON(PASSKEYS_FILE, data);
}

function cleanChallenges() {
  const now = Date.now();
  for (const [key, val] of passkeyChallenge) {
    if (now - val.timestamp > 5 * 60 * 1000) passkeyChallenge.delete(key);
  }
}

// ===== Rate limiter for login =====

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts, please try again later' }
});

module.exports = function createAuthRoutes({ requireAuth }) {
  const router = require('express').Router();

  // ===== Login / Logout / Session =====

  router.post('/api/login', loginLimiter, async (req, res) => {
    try {
      const { password } = req.body;
      const hash = process.env.AUTH_PASSWORD_HASH;
      if (!hash) return res.status(500).json({ error: 'Server misconfigured' });
      const match = await bcrypt.compare(password, hash);
      if (match) {
        req.session.authenticated = true;
        res.json({ ok: true });
      } else {
        res.status(401).json({ error: 'Invalid password' });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ ok: true });
  });

  router.get('/api/session', (req, res) => {
    res.json({ authenticated: !!(req.session && req.session.authenticated) });
  });

  // ===== Change password =====

  router.post('/api/profile/password', requireAuth, async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body;
      if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: 'Missing fields' });
      }
      if (newPassword.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }
      const hash = process.env.AUTH_PASSWORD_HASH;
      if (!hash) return res.status(500).json({ error: 'Server misconfigured' });

      const match = await bcrypt.compare(currentPassword, hash);
      if (!match) return res.status(401).json({ error: 'Mot de passe actuel incorrect' });

      const newHash = await bcrypt.hash(newPassword, 12);

      // Update .env file
      let envContent = fs.readFileSync(ENV_PATH, 'utf8');
      if (/^AUTH_PASSWORD_HASH=.*/m.test(envContent)) {
        envContent = envContent.replace(/^AUTH_PASSWORD_HASH=.*/m, `AUTH_PASSWORD_HASH=${newHash}`);
      } else {
        envContent += `\nAUTH_PASSWORD_HASH=${newHash}`;
      }
      fs.writeFileSync(ENV_PATH, envContent, 'utf8');

      // Update in-memory value
      process.env.AUTH_PASSWORD_HASH = newHash;

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ===== Passkeys: Registration =====

  router.post('/api/passkeys/register-options', requireAuth, async (req, res) => {
    try {
      const data = loadPasskeys();
      const excludeCredentials = data.credentials.map(c => ({ id: c.id, type: 'public-key' }));
      const options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: RP_ID,
        userName: 'ashwin',
        userDisplayName: 'Ashwin',
        attestationType: 'none',
        excludeCredentials,
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      });
      cleanChallenges();
      passkeyChallenge.set('registration', { challenge: options.challenge, timestamp: Date.now() });
      res.json(options);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/passkeys/register-verify', requireAuth, async (req, res) => {
    try {
      const entry = passkeyChallenge.get('registration');
      if (!entry || Date.now() - entry.timestamp > 5 * 60 * 1000) {
        return res.status(400).json({ error: 'Challenge expiré' });
      }
      const verification = await verifyRegistrationResponse({
        response: req.body,
        expectedChallenge: entry.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
      });
      if (!verification.verified) return res.status(400).json({ error: 'Vérification échouée' });
      passkeyChallenge.delete('registration');
      const { registrationInfo } = verification;
      const data = loadPasskeys();
      data.credentials.push({
        id: registrationInfo.credential.id,
        publicKey: Buffer.from(registrationInfo.credential.publicKey).toString('base64'),
        counter: registrationInfo.credential.counter,
        deviceType: registrationInfo.credentialDeviceType,
        backedUp: registrationInfo.credentialBackedUp,
        addedAt: new Date().toISOString(),
      });
      savePasskeys(data);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ===== Passkeys: Authentication =====

  router.post('/api/passkeys/auth-options', async (req, res) => {
    try {
      const data = loadPasskeys();
      const allowCredentials = data.credentials.map(c => ({ id: c.id, type: 'public-key' }));
      const options = await generateAuthenticationOptions({
        rpID: RP_ID,
        allowCredentials,
        userVerification: 'preferred',
      });
      cleanChallenges();
      passkeyChallenge.set('authentication', { challenge: options.challenge, timestamp: Date.now() });
      res.json(options);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/passkeys/auth-verify', async (req, res) => {
    try {
      const entry = passkeyChallenge.get('authentication');
      if (!entry || Date.now() - entry.timestamp > 5 * 60 * 1000) {
        return res.status(400).json({ error: 'Challenge expiré' });
      }
      const data = loadPasskeys();
      const storedCred = data.credentials.find(c => c.id === req.body.id);
      if (!storedCred) return res.status(400).json({ error: 'Clé non reconnue' });
      const verification = await verifyAuthenticationResponse({
        response: req.body,
        expectedChallenge: entry.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        credential: {
          id: storedCred.id,
          publicKey: new Uint8Array(Buffer.from(storedCred.publicKey, 'base64')),
          counter: storedCred.counter,
        },
      });
      if (!verification.verified) return res.status(401).json({ error: 'Authentification échouée' });
      passkeyChallenge.delete('authentication');
      storedCred.counter = verification.authenticationInfo.newCounter;
      savePasskeys(data);
      req.session.authenticated = true;
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ===== Passkeys: List & Delete =====

  router.get('/api/passkeys', requireAuth, (req, res) => {
    try {
      const data = loadPasskeys();
      res.json({ credentials: data.credentials.map(c => ({ id: c.id, deviceType: c.deviceType, backedUp: c.backedUp, addedAt: c.addedAt })) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/api/passkeys/:id', requireAuth, (req, res) => {
    try {
      const data = loadPasskeys();
      const before = data.credentials.length;
      data.credentials = data.credentials.filter(c => c.id !== req.params.id);
      if (data.credentials.length === before) return res.status(404).json({ error: 'Clé non trouvée' });
      savePasskeys(data);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
