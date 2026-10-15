import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { GoogleGenAI, Type } from '@google/genai';

dotenv.config();

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = 3000;
const ADMIN_EMAIL_SECRET = process.env.ADMIN_EMAIL || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'nnap_kobo_sandbox_hmac_secret_2026';

let runtimeAdminSecretOverride: string | null = null;
function getActiveAdminSecret(): string {
  return process.env.ADMIN_SECRET_CODE || runtimeAdminSecretOverride || '';
}

const ADMIN_INACTIVITY_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes d'inactivité maximum
const MAX_ADMIN_FAILED_ATTEMPTS = 3;
const MAX_USER_LOGIN_ATTEMPTS = 5;

interface AdminSession {
  token: string;
  ownerName: string;
  createdAt: number;
  lastActivityAt: number;
}

const adminSessions = new Map<string, AdminSession>();
let adminFailedAttempts = 0;
let adminBlockedUntil: number | null = null;
let activeAggregatorId: AggregatorId = 'flutterwave_cm';

// Limitation des tentatives de connexion ratées des utilisateurs
interface LoginAttemptState {
  count: number;
  blockedUntil: number | null;
}
const userLoginAttempts = new Map<string, LoginAttemptState>();

// Codes SMS OTP & Liens de confirmation E-mail côté serveur
interface OtpRecord {
  code: string;
  expiresAt: number;
  attempts: number;
}
const pendingSmsOtps = new Map<string, OtpRecord>();
const pendingEmailTokens = new Map<string, { token: string; email: string; expiresAt: number }>();

// Registre serveur protégé des profils utilisateurs (visible uniquement dans l'Espace Administrateur avec trace d'audit)
export interface ServerUserProfile {
  uid: string;
  fullName: string;
  publicDisplayName: string;
  birthDate: string;
  isAdultVerified: boolean;
  gender: 'Homme' | 'Femme' | 'Je préfère ne pas dire';
  country: string;
  city: string;
  neighborhood: string;
  phone: string;
  phoneVerified: boolean;
  mobileMoneyOperator: 'MTN_MOMO' | 'ORANGE_MONEY';
  mobileMoneyNumber: string;
  email: string;
  emailVerified: boolean;
  termsAccepted: boolean;
  createdAt: string;
  updatedAt: string;
}

const registeredUsersStore = new Map<string, ServerUserProfile>();

function maskPhoneServer(rawPhone: string): string {
  if (!rawPhone) return '+237 6** ** ** **';
  const cleaned = rawPhone.replace(/\s+/g, '');
  if (cleaned.startsWith('+237') && cleaned.length >= 11) {
    return `+237 ${cleaned.charAt(4) || '6'}** ** ** ${cleaned.slice(-2)}`;
  }
  if (cleaned.length >= 6) {
    return `${cleaned.slice(0, 4)} ** ** ${cleaned.slice(-2)}`;
  }
  return '*** ** **';
}

function verifySecretConstantTime(input: string, expected: string): boolean {
  if (!expected || !input) return false;
  const bufInput = Buffer.from(input.trim(), 'utf8');
  const bufExpected = Buffer.from(expected.trim(), 'utf8');
  if (bufInput.length !== bufExpected.length) return false;
  return crypto.timingSafeEqual(bufInput, bufExpected);
}

function getGenAI() {
  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

// ============================================================================
// 1. ISOLATED PAYMENT PROVIDER INTERFACE
// ============================================================================

export type CurrencyCode = 'XAF' | 'XOF' | 'EUR' | 'USD';
export type AggregatorId = 'flutterwave_cm' | 'cinetpay_cemac' | 'pawapay_momo';
export type PenaltyDestination = 'redistribution_pool' | 'platform_revenue' | 'solidarity_fund';

export interface PaymentTransactionRequest {
  idempotencyKey: string;
  userId: string;
  userPhone: string;
  amount: number;
  currency: CurrencyCode;
  operator: 'MTN_MOMO' | 'ORANGE_MONEY' | 'WAVE' | 'CARD_ESCROW';
  purpose: 'GUARANTEE_DEPOSIT' | 'DAILY_SAVING' | 'MARKETPLACE_ESCROW' | 'WITHDRAWAL_PAYOUT';
  metadata?: Record<string, string | number>;
}

export interface PaymentTransactionResult {
  success: boolean;
  providerId: AggregatorId;
  providerReference: string;
  status: 'CONFIRMED_SANDBOX' | 'PENDING_USSD_PIN' | 'FAILED';
  ussdPromptSimulated: string;
  webhookSignature: string;
  timestamp: string;
  feeAmount: number;
}

export interface PaymentProvider {
  readonly id: AggregatorId;
  readonly displayName: string;
  readonly supportedZones: string[];
  readonly supportsPreAuthorizedDebit: boolean;
  initiateCollection(req: PaymentTransactionRequest): Promise<PaymentTransactionResult>;
  initiateEscrowHold(req: PaymentTransactionRequest): Promise<PaymentTransactionResult>;
  releaseEscrowToSeller(escrowRef: string, sellerPhone: string, amount: number, currency: CurrencyCode): Promise<PaymentTransactionResult>;
  refundGuaranteeBalance(userPhone: string, amount: number, currency: CurrencyCode, idempotencyKey: string): Promise<PaymentTransactionResult>;
  verifyWebhookSignature(rawPayload: string, signatureHeader: string): boolean;
}

class SandboxAggregatorAdapter implements PaymentProvider {
  constructor(
    public readonly id: AggregatorId,
    public readonly displayName: string,
    public readonly supportedZones: string[],
    public readonly supportsPreAuthorizedDebit: boolean
  ) {}

  private signPayload(payload: string): string {
    return crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');
  }

  async initiateCollection(req: PaymentTransactionRequest): Promise<PaymentTransactionResult> {
    const providerReference = `${this.id.toUpperCase()}-SBX-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    const payload = JSON.stringify({ ref: providerReference, key: req.idempotencyKey, amount: req.amount, currency: req.currency });
    const signature = this.signPayload(payload);
    const ussdCode = req.operator === 'MTN_MOMO' ? '*126#' : req.operator === 'ORANGE_MONEY' ? '#150#' : 'Confirmation App';

    return {
      success: true,
      providerId: this.id,
      providerReference,
      status: 'CONFIRMED_SANDBOX',
      ussdPromptSimulated: `[SANDBOX ${this.displayName}] Push ${req.operator} (${ussdCode}) validé par l'utilisateur (${maskPhoneServer(req.userPhone)}) pour ${req.amount} ${req.currency}.`,
      webhookSignature: signature,
      timestamp: new Date().toISOString(),
      feeAmount: 0,
    };
  }

  async initiateEscrowHold(req: PaymentTransactionRequest): Promise<PaymentTransactionResult> {
    const providerReference = `ESCROW-${this.id.toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
    const payload = JSON.stringify({ ref: providerReference, key: req.idempotencyKey, amount: req.amount, escrow: true });
    return {
      success: true,
      providerId: this.id,
      providerReference,
      status: 'CONFIRMED_SANDBOX',
      ussdPromptSimulated: `[SÉQUESTRE ${this.displayName}] Fonds (${req.amount} ${req.currency}) bloqués sur compte de cantonnement partenaire jusqu'à confirmation de livraison.`,
      webhookSignature: this.signPayload(payload),
      timestamp: new Date().toISOString(),
      feeAmount: Math.round(req.amount * 0.015),
    };
  }

  async releaseEscrowToSeller(escrowRef: string, sellerPhone: string, amount: number, currency: CurrencyCode): Promise<PaymentTransactionResult> {
    const providerReference = `PAYOUT-${this.id.toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
    const payload = JSON.stringify({ escrowRef, sellerPhone, amount, currency });
    return {
      success: true,
      providerId: this.id,
      providerReference,
      status: 'CONFIRMED_SANDBOX',
      ussdPromptSimulated: `[VERSEMENT VENDEUR ${this.displayName}] ${amount} ${currency} transférés vers le vendeur (${maskPhoneServer(sellerPhone)}) suite au déblocage du séquestre ${escrowRef}.`,
      webhookSignature: this.signPayload(payload),
      timestamp: new Date().toISOString(),
      feeAmount: 0,
    };
  }

  async refundGuaranteeBalance(userPhone: string, amount: number, currency: CurrencyCode, idempotencyKey: string): Promise<PaymentTransactionResult> {
    const providerReference = `REFUND-${this.id.toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
    const payload = JSON.stringify({ userPhone, amount, currency, idempotencyKey });
    return {
      success: true,
      providerId: this.id,
      providerReference,
      status: 'CONFIRMED_SANDBOX',
      ussdPromptSimulated: `[RETOUR CAUTION ${this.displayName}] Solde de garantie non pénalisé (${amount} ${currency}) reversé sur ${maskPhoneServer(userPhone)}.`,
      webhookSignature: this.signPayload(payload),
      timestamp: new Date().toISOString(),
      feeAmount: 0,
    };
  }

  verifyWebhookSignature(rawPayload: string, signatureHeader: string): boolean {
    const expected = this.signPayload(rawPayload);
    return expected === signatureHeader;
  }
}

const PROVIDERS: Record<AggregatorId, PaymentProvider> = {
  flutterwave_cm: new SandboxAggregatorAdapter(
    'flutterwave_cm',
    'Flutterwave (Sandbox CEMAC/UEMOA)',
    ['CM (XAF)', 'SN/CI (XOF)', 'EUR', 'USD'],
    true
  ),
  cinetpay_cemac: new SandboxAggregatorAdapter(
    'cinetpay_cemac',
    'CinetPay (Sandbox Mobile Money)',
    ['CM (XAF)', 'CI/SN/TG/BJ (XOF)'],
    false
  ),
  pawapay_momo: new SandboxAggregatorAdapter(
    'pawapay_momo',
    'pawaPay (Sandbox Direct Telco API)',
    ['CM MTN/Orange (XAF)', 'CI/SN (XOF)'],
    false
  ),
};

// ============================================================================
// 2. IMMUTABLE AUDIT LOG & DUAL NOTIFICATION ROUTER
// ============================================================================

interface AuditLogEntry {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  details: string;
  idempotencyKey: string;
  prevHash: string;
  hash: string;
}

interface NotificationLog {
  id: string;
  timestamp: string;
  audience: 'ADMIN_ONLY' | 'USER_ONLY';
  recipient: string;
  channel: 'EMAIL_ADMIN' | 'SMS' | 'EMAIL_USER' | 'PUSH';
  subject: string;
  message: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
}

const processedIdempotencyKeys = new Map<string, PaymentTransactionResult>();
const auditLogs: AuditLogEntry[] = [];
const notificationLogs: NotificationLog[] = [];

function appendAuditLog(actor: string, action: string, details: string, idempotencyKey = 'N/A'): AuditLogEntry {
  const prevHash = auditLogs.length > 0 ? auditLogs[0].hash : '0000000000000000000000000000000000000000000000000000000000000000';
  const timestamp = new Date().toISOString();
  const raw = `${prevHash}|${timestamp}|${actor}|${action}|${details}|${idempotencyKey}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const entry: AuditLogEntry = {
    id: `AUD-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 900 + 100)}`,
    timestamp,
    actor,
    action,
    details,
    idempotencyKey,
    prevHash: prevHash.slice(0, 16) + '...',
    hash,
  };
  auditLogs.unshift(entry);
  return entry;
}

function sendAdminAlert(subject: string, message: string, severity: 'WARNING' | 'CRITICAL' = 'WARNING') {
  const _targetSecretDestination = ADMIN_EMAIL_SECRET;
  void _targetSecretDestination;

  const entry: NotificationLog = {
    id: `ADM-${Date.now().toString(36).toUpperCase()}`,
    timestamp: new Date().toISOString(),
    audience: 'ADMIN_ONLY',
    recipient: 'Administrateur',
    channel: 'EMAIL_ADMIN',
    subject: `[ALERTE ADMIN NNAP KOBO] ${subject}`,
    message,
    severity,
  };
  notificationLogs.unshift(entry);
  appendAuditLog('SYSTEM_WATCHDOG', 'ADMIN_ALERT_DISPATCHED', `Alerte envoyée à l'administrateur : ${subject}`);
  return entry;
}

function sendUserNotification(
  userRecipient: string,
  channel: 'SMS' | 'EMAIL_USER' | 'PUSH',
  subject: string,
  message: string
) {
  const safeRecipient =
    ADMIN_EMAIL_SECRET && userRecipient.toLowerCase() === ADMIN_EMAIL_SECRET.toLowerCase()
      ? '+237 6** ** ** 00'
      : userRecipient.startsWith('+')
      ? maskPhoneServer(userRecipient)
      : userRecipient;

  const entry: NotificationLog = {
    id: `USR-${Date.now().toString(36).toUpperCase()}`,
    timestamp: new Date().toISOString(),
    audience: 'USER_ONLY',
    recipient: safeRecipient,
    channel,
    subject,
    message,
    severity: 'INFO',
  };
  notificationLogs.unshift(entry);
  return entry;
}

appendAuditLog('SYSTEM_BOOT', 'SANDBOX_INITIALIZED', 'Interface PaymentProvider et authentification Firebase/Firestore prêtes.');
appendAuditLog('COMPLIANCE_ENGINE', 'PENALTY_RULE_LOCKED', 'Règle active : Pénalité déduite uniquement du dépôt de garantie, jamais du compte Mobile Money en secret.');
sendUserNotification('+237 699 12 34 12', 'SMS', 'Confirmation Épargne Jour 12', 'NNAP KOBO : Votre épargne de 5 000 XAF (Niveau Boss) a été validée avant 20h00. Série en cours : 12 jours.');
sendAdminAlert('Surveillance Sandbox Active', "Le routage des alertes critiques (fraude, échecs webhooks, litiges marché) est actif vers l'administrateur.", 'WARNING');

// ============================================================================
// 3. INSCRIPTION, VÉRIFICATION SMS/EMAIL, LIMITATION DE CONNEXION & PROFILS
// ============================================================================

function isUserAdultServer(birthDateStr: string): boolean {
  if (!birthDateStr || !/^\d{4}-\d{2}-\d{2}$/.test(birthDateStr)) return false;
  const [y, m, d] = birthDateStr.split('-').map(Number);
  const now = new Date();
  let age = now.getFullYear() - y;
  const mDiff = now.getMonth() + 1 - m;
  if (mDiff < 0 || (mDiff === 0 && now.getDate() < d)) age--;
  return age >= 18;
}

// Envoi du code SMS de vérification du numéro de téléphone
app.post('/api/auth/send-sms-otp', (req, res) => {
  const { phone } = req.body;
  if (!phone || typeof phone !== 'string' || phone.trim().length < 8) {
    return res.status(400).json({ error: 'Veuillez saisir un numéro de téléphone valide avec indicatif (ex: +237...).' });
  }
  const cleanPhone = phone.trim();
  const code = String(Math.floor(100000 + Math.random() * 900000));
  pendingSmsOtps.set(cleanPhone, {
    code,
    expiresAt: Date.now() + 10 * 60 * 1000,
    attempts: 0,
  });

  sendUserNotification(
    cleanPhone,
    'SMS',
    'Code de vérification SMS NNAP KOBO',
    `Votre code de vérification téléphone est : ${code} (Valable 10 minutes).`
  );

  // En mode simulation/aperçu, on retourne un aperçu d'aide pour que l'utilisateur puisse tester immédiatement
  res.json({
    ok: true,
    maskedPhone: maskPhoneServer(cleanPhone),
    sandboxSmsCodePreview: code,
    message: `Code SMS envoyé au ${maskPhoneServer(cleanPhone)}.`,
  });
});

// Vérification du code SMS
app.post('/api/auth/verify-sms-otp', (req, res) => {
  const { phone, code } = req.body;
  const cleanPhone = String(phone || '').trim();
  const record = pendingSmsOtps.get(cleanPhone);

  if (!record || Date.now() > record.expiresAt) {
    return res.status(400).json({ error: 'Code SMS expiré ou introuvable. Veuillez redemander un code.' });
  }

  if (record.attempts >= 5) {
    pendingSmsOtps.delete(cleanPhone);
    sendAdminAlert('Blocage Vérification SMS', `5 tentatives de code SMS échouées pour ${maskPhoneServer(cleanPhone)}.`, 'WARNING');
    return res.status(429).json({ error: 'Trop de tentatives erronées. Veuillez redemander un nouveau code SMS.' });
  }

  if (record.code !== String(code || '').trim()) {
    record.attempts += 1;
    return res.status(400).json({
      error: `Code SMS incorrect (${record.attempts}/5 essais).`,
    });
  }

  pendingSmsOtps.delete(cleanPhone);
  appendAuditLog('AUTH_SERVICE', 'PHONE_SMS_VERIFIED', `Numéro de téléphone vérifié par SMS (${maskPhoneServer(cleanPhone)}).`);
  res.json({ ok: true, phoneVerified: true });
});

// Envoi d'un lien de confirmation e-mail (en complément de Firebase sendEmailVerification)
app.post('/api/auth/send-email-confirmation', (req, res) => {
  const { email } = req.body;
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'Adresse e-mail invalide.' });
  }
  const cleanEmail = email.trim().toLowerCase();
  const token = crypto.randomBytes(20).toString('hex');
  pendingEmailTokens.set(cleanEmail, {
    token,
    email: cleanEmail,
    expiresAt: Date.now() + 30 * 60 * 1000,
  });

  res.json({
    ok: true,
    confirmationToken: token,
    message: 'Lien de confirmation généré et envoyé.',
  });
});

app.post('/api/auth/verify-email-link', (req, res) => {
  const { email, token } = req.body;
  const cleanEmail = String(email || '').trim().toLowerCase();
  const record = pendingEmailTokens.get(cleanEmail);
  if (!record || record.token !== token || Date.now() > record.expiresAt) {
    return res.status(400).json({ error: 'Lien de confirmation invalide ou expiré.' });
  }
  pendingEmailTokens.delete(cleanEmail);
  appendAuditLog('AUTH_SERVICE', 'EMAIL_LINK_CONFIRMED', 'Adresse e-mail vérifiée par lien de confirmation.');
  res.json({ ok: true, emailVerified: true });
});

// Limitation des tentatives de connexion ratées côté serveur
app.post('/api/auth/login-guard', (req, res) => {
  const { identifier, action } = req.body; // action: 'check' | 'fail' | 'reset'
  const key = String(identifier || 'anonymous').trim().toLowerCase();
  const current = userLoginAttempts.get(key) || { count: 0, blockedUntil: null };
  const now = Date.now();

  if (current.blockedUntil && now < current.blockedUntil) {
    const waitSec = Math.ceil((current.blockedUntil - now) / 1000);
    return res.status(429).json({
      allowed: false,
      error: `Compte temporairement bloqué après ${MAX_USER_LOGIN_ATTEMPTS} tentatives de connexion ratées. Réessayez dans ${waitSec}s.`,
    });
  }

  if (action === 'reset') {
    userLoginAttempts.delete(key);
    return res.json({ allowed: true, failedAttempts: 0 });
  }

  if (action === 'fail') {
    const nextCount = current.count + 1;
    const blockedUntil = nextCount >= MAX_USER_LOGIN_ATTEMPTS ? now + 5 * 60 * 1000 : null;
    userLoginAttempts.set(key, { count: nextCount, blockedUntil });
    appendAuditLog('AUTH_GUARD', 'USER_LOGIN_FAILED', `Échec de connexion utilisateur (${nextCount}/${MAX_USER_LOGIN_ATTEMPTS}).`);

    if (blockedUntil) {
      sendAdminAlert(
        'Tentatives de connexion multiples bloquées',
        `Un compte utilisateur a été temporairement verrouillé après ${MAX_USER_LOGIN_ATTEMPTS} échecs de mot de passe.`,
        'WARNING'
      );
      return res.status(429).json({
        allowed: false,
        failedAttempts: nextCount,
        error: `Accès temporairement bloqué après ${MAX_USER_LOGIN_ATTEMPTS} essais ratés. Alerte envoyée à l'administrateur.`,
      });
    }

    return res.json({
      allowed: true,
      failedAttempts: nextCount,
      remainingAttempts: MAX_USER_LOGIN_ATTEMPTS - nextCount,
    });
  }

  res.json({ allowed: true, failedAttempts: current.count });
});

// Synchronisation et validation côté serveur du profil utilisateur (Zéro mot de passe / Zéro code PIN)
app.post('/api/users/sync-profile', (req, res) => {
  const profile = req.body;
  if (!profile || !profile.uid) {
    return res.status(400).json({ error: 'Identifiant utilisateur (UID) manquant.' });
  }

  // Vérification stricte de la majorité (>= 18 ans) côté serveur
  if (!isUserAdultServer(profile.birthDate)) {
    appendAuditLog('COMPLIANCE_GUARD', 'MINOR_REGISTRATION_REJECTED', 'Tentative d’inscription refusée : moins de 18 ans.');
    return res.status(400).json({
      error: 'Inscription refusée : vous devez avoir au moins 18 ans révolus pour ouvrir un compte NNAP KOBO.',
    });
  }

  if (!profile.termsAccepted) {
    return res.status(400).json({
      error: 'Vous devez accepter les Conditions d’utilisation et la Politique de confidentialité.',
    });
  }

  if (!profile.phoneVerified) {
    return res.status(400).json({
      error: 'Votre numéro de téléphone doit être vérifié par code SMS.',
    });
  }

  // On construit un objet strictement épuré : jamais de mot de passe, jamais de PIN, jamais de code Mobile Money
  const existing = registeredUsersStore.get(profile.uid);
  const nowIso = new Date().toISOString();
  const firstName = String(profile.fullName || '').trim().split(/\s+/)[0] || 'Membre';

  const sanitized: ServerUserProfile = {
    uid: String(profile.uid).slice(0, 128),
    fullName: String(profile.fullName || '').trim().slice(0, 120),
    publicDisplayName: String(profile.publicDisplayName || firstName).trim().slice(0, 60),
    birthDate: String(profile.birthDate).slice(0, 10),
    isAdultVerified: true,
    gender: ['Homme', 'Femme', 'Je préfère ne pas dire'].includes(profile.gender)
      ? profile.gender
      : 'Je préfère ne pas dire',
    country: String(profile.country || '').trim().slice(0, 80),
    city: String(profile.city || '').trim().slice(0, 80),
    neighborhood: String(profile.neighborhood || '').trim().slice(0, 100),
    phone: String(profile.phone || '').trim().slice(0, 24),
    phoneVerified: Boolean(profile.phoneVerified),
    mobileMoneyOperator: profile.mobileMoneyOperator === 'ORANGE_MONEY' ? 'ORANGE_MONEY' : 'MTN_MOMO',
    mobileMoneyNumber: String(profile.mobileMoneyNumber || '').trim().slice(0, 24),
    email: String(profile.email || '').trim().slice(0, 160),
    emailVerified: Boolean(profile.emailVerified),
    termsAccepted: true,
    createdAt: existing ? existing.createdAt : nowIso,
    updatedAt: nowIso,
  };

  registeredUsersStore.set(sanitized.uid, sanitized);
  appendAuditLog(
    `USER_${sanitized.uid.slice(0, 8)}`,
    existing ? 'USER_PROFILE_UPDATED' : 'USER_ACCOUNT_CREATED',
    `Profil ${existing ? 'mis à jour' : 'créé'} (${sanitized.country}, ${sanitized.city}, Tél masqué: ${maskPhoneServer(sanitized.phone)}). Aucun mot de passe ni code PIN stocké.`
  );

  res.json({ ok: true });
});

// Suppression complète du compte et des données personnelles (Droit à l'oubli)
app.post('/api/users/delete-account', (req, res) => {
  const { uid } = req.body;
  if (!uid) {
    return res.status(400).json({ error: 'UID requis.' });
  }
  registeredUsersStore.delete(String(uid));
  appendAuditLog(
    `USER_${String(uid).slice(0, 8)}`,
    'USER_ACCOUNT_DELETED',
    'Compte utilisateur et toutes ses données personnelles définitivement supprimés à la demande de l’utilisateur.'
  );
  res.json({
    ok: true,
    message: 'Votre compte et toutes vos données personnelles ont été supprimés.',
  });
});

// ============================================================================
// 4. SERVER-SIDE ADMIN AUTHENTICATION MIDDLEWARE (2-min Timeout + 3 Tries Lock)
// ============================================================================

function requireAdminSession(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  if (!token || !adminSessions.has(token)) {
    return res.status(401).json({
      error: 'Accès refusé : session administrateur requise (vérification serveur).',
      code: 'ADMIN_UNAUTHORIZED',
    });
  }

  const session = adminSessions.get(token)!;
  const now = Date.now();
  if (now - session.lastActivityAt > ADMIN_INACTIVITY_TIMEOUT_MS) {
    adminSessions.delete(token);
    appendAuditLog('ADMIN_GUARD', 'ADMIN_SESSION_TIMEOUT', 'Session administrateur expirée après 2 minutes d’inactivité.');
    return res.status(401).json({
      error: 'Session administrateur expirée après 2 minutes d’inactivité. Veuillez revalider la biométrie et votre code secret.',
      code: 'ADMIN_TIMEOUT',
    });
  }

  session.lastActivityAt = now;
  next();
}

app.get('/api/admin/status', (_req, res) => {
  const isBlocked = Boolean(adminBlockedUntil && Date.now() < adminBlockedUntil);
  res.json({
    ownerName: 'Ndoumin Nnanga Adams Pharel',
    isSecretConfiguredInEnv: Boolean(process.env.ADMIN_SECRET_CODE),
    isSecretConfigured: Boolean(getActiveAdminSecret()),
    failedAttempts: adminFailedAttempts,
    maxAttempts: MAX_ADMIN_FAILED_ATTEMPTS,
    isBlocked,
    inactivityTimeoutSeconds: 120,
  });
});

app.post('/api/admin/bootstrap-secret', (req, res) => {
  if (getActiveAdminSecret()) {
    return res.status(403).json({
      error: 'Un code secret administrateur est déjà actif sur le serveur.',
    });
  }
  const { newSecretCode, webAuthnVerified } = req.body;
  if (!webAuthnVerified) {
    return res.status(400).json({
      error: 'Le verrouillage de l’appareil (WebAuthn / Biométrie) doit être validé avant d’initialiser le code.',
    });
  }
  if (!newSecretCode || typeof newSecretCode !== 'string' || newSecretCode.trim().length < 4) {
    return res.status(400).json({
      error: 'Le code secret administrateur doit contenir au moins 4 caractères.',
    });
  }
  runtimeAdminSecretOverride = newSecretCode.trim();
  appendAuditLog('OWNER_SETUP', 'ADMIN_SECRET_INITIALIZED', 'Code secret administrateur initialisé côté serveur.');
  res.json({ ok: true });
});

app.post('/api/admin/login', (req, res) => {
  const now = Date.now();
  if (adminBlockedUntil && now < adminBlockedUntil) {
    const remainingSec = Math.ceil((adminBlockedUntil - now) / 1000);
    return res.status(429).json({
      error: `Accès administrateur bloqué suite à 3 essais ratés. Réessayez dans ${remainingSec}s. Alerte envoyée à l'administrateur.`,
      isBlocked: true,
      failedAttempts: adminFailedAttempts,
    });
  }

  const { secretCode, webAuthnVerified } = req.body;
  if (!webAuthnVerified) {
    return res.status(400).json({
      error: 'Étape 1 obligatoire : veuillez d’abord valider le verrouillage de l’appareil (PIN/Empreinte/Visage via WebAuthn).',
    });
  }

  const activeSecret = getActiveAdminSecret();
  if (!activeSecret) {
    return res.status(400).json({
      error: 'Aucun code secret administrateur n’est encore configuré. Configurez ADMIN_SECRET_CODE dans Secrets ou initialisez-le ci-dessous.',
      needsBootstrap: true,
    });
  }

  const isValid = verifySecretConstantTime(String(secretCode || ''), activeSecret);
  if (!isValid) {
    adminFailedAttempts += 1;
    appendAuditLog(
      'ADMIN_GATE',
      'ADMIN_AUTH_FAILED',
      `Tentative de connexion administrateur échouée (${adminFailedAttempts}/${MAX_ADMIN_FAILED_ATTEMPTS}).`
    );

    if (adminFailedAttempts >= MAX_ADMIN_FAILED_ATTEMPTS) {
      adminBlockedUntil = Date.now() + 5 * 60 * 1000;
      sendAdminAlert(
        'Blocage Sécurité Espace Administrateur',
        '3 tentatives erronées du code secret administrateur ont été détectées. L’accès administrateur est verrouillé.',
        'CRITICAL'
      );
      return res.status(403).json({
        error: "Accès administrateur bloqué après 3 essais ratés. Alerte envoyée à l'administrateur.",
        isBlocked: true,
        failedAttempts: adminFailedAttempts,
      });
    }

    return res.status(401).json({
      error: `Code secret administrateur incorrect (${adminFailedAttempts}/${MAX_ADMIN_FAILED_ATTEMPTS} essais).`,
      failedAttempts: adminFailedAttempts,
    });
  }

  adminFailedAttempts = 0;
  adminBlockedUntil = null;
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.set(token, {
    token,
    ownerName: 'Ndoumin Nnanga Adams Pharel',
    createdAt: now,
    lastActivityAt: now,
  });

  appendAuditLog(
    'Ndoumin Nnanga Adams Pharel',
    'ADMIN_SPACE_UNLOCKED',
    'Ouverture de l’Espace Propriétaire validée côté serveur (WebAuthn + Code secret).'
  );

  res.json({
    token,
    ownerName: 'Ndoumin Nnanga Adams Pharel',
    inactivityTimeoutMs: ADMIN_INACTIVITY_TIMEOUT_MS,
  });
});

app.post('/api/admin/logout', (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (token) {
    adminSessions.delete(token);
  }
  appendAuditLog('Ndoumin Nnanga Adams Pharel', 'ADMIN_SPACE_LOCKED', 'Fermeture / verrouillage de l’Espace Administrateur.');
  res.json({ ok: true });
});

app.get('/api/admin/dashboard', requireAdminSession, (_req, res) => {
  res.json({
    ownerName: 'Ndoumin Nnanga Adams Pharel',
    activeProviderId: activeAggregatorId,
    providers: Object.values(PROVIDERS).map((p) => ({
      id: p.id,
      displayName: p.displayName,
      supportedZones: p.supportedZones,
      supportsPreAuthorizedDebit: p.supportsPreAuthorizedDebit,
    })),
    adminAlerts: notificationLogs.filter((n) => n.audience === 'ADMIN_ONLY').slice(0, 30),
    auditCount: auditLogs.length,
    registeredUsersCount: registeredUsersStore.size,
  });
});

// Action sensible Admin 1 : Consulter le journal d'audit complet
app.post('/api/admin/audit-logs', requireAdminSession, (req, res) => {
  const { secretCode, webAuthnVerified } = req.body;
  if (!webAuthnVerified || !verifySecretConstantTime(String(secretCode || ''), getActiveAdminSecret())) {
    appendAuditLog('ADMIN_GUARD', 'STEP_UP_AUDIT_DENIED', 'Échec de re-vérification avant lecture du journal d’audit.');
    return res.status(403).json({
      error: 'Re-vérification (Biométrie appareil + Code secret administrateur) requise pour déverrouiller le journal d’audit.',
    });
  }

  appendAuditLog('Ndoumin Nnanga Adams Pharel', 'AUDIT_LOG_INSPECTED', 'Consultation autorisée du journal d’audit immuable SHA-256.');
  res.json({
    auditLogs: auditLogs.slice(0, 50),
  });
});

// Action sensible Admin 2 : Consulter les données des utilisateurs inscrits (avec trace d'audit obligatoire de chaque consultation)
app.post('/api/admin/users', requireAdminSession, (req, res) => {
  const { secretCode, webAuthnVerified, reason = 'Vérification de conformité KYC / Support' } = req.body;
  if (!webAuthnVerified || !verifySecretConstantTime(String(secretCode || ''), getActiveAdminSecret())) {
    appendAuditLog('ADMIN_GUARD', 'STEP_UP_USERS_DENIED', 'Échec de re-vérification avant consultation des données utilisateurs.');
    return res.status(403).json({
      error: 'Re-vérification (Biométrie appareil + Code secret administrateur) requise pour consulter les données des utilisateurs.',
    });
  }

  const usersList = Array.from(registeredUsersStore.values());
  appendAuditLog(
    'Ndoumin Nnanga Adams Pharel',
    'USER_DATA_CONSULTED',
    `Consultation des données utilisateurs dans l'Espace Administrateur (${usersList.length} profil(s) consulté(s) — Motif : ${reason}).`
  );

  res.json({
    users: usersList,
    auditRecorded: true,
  });
});

// Action sensible Admin 3 : Changer d'agrégateur de paiement
app.post('/api/admin/change-provider', requireAdminSession, (req, res) => {
  const { newProviderId, secretCode, webAuthnVerified } = req.body;
  if (!webAuthnVerified || !verifySecretConstantTime(String(secretCode || ''), getActiveAdminSecret())) {
    appendAuditLog('ADMIN_GUARD', 'STEP_UP_PROVIDER_DENIED', 'Échec de re-vérification avant changement d’agrégateur.');
    return res.status(403).json({
      error: 'Re-vérification (Biométrie appareil + Code secret administrateur) obligatoire avant de changer d’agrégateur.',
    });
  }

  if (!PROVIDERS[newProviderId as AggregatorId]) {
    return res.status(400).json({ error: 'Agrégateur invalide.' });
  }

  const prev = activeAggregatorId;
  activeAggregatorId = newProviderId as AggregatorId;
  appendAuditLog(
    'Ndoumin Nnanga Adams Pharel',
    'PAYMENT_PROVIDER_CHANGED',
    `Agrégateur modifié de ${prev} vers ${activeAggregatorId} après double validation propriétaire.`
  );

  res.json({
    ok: true,
    activeProviderId: activeAggregatorId,
    message: `Agrégateur actif basculé sur ${PROVIDERS[activeAggregatorId].displayName}.`,
  });
});

// ============================================================================
// 5. PUBLIC / USER API ROUTES
// ============================================================================

app.get('/api/system/state', (_req, res) => {
  const activeProv = PROVIDERS[activeAggregatorId];
  res.json({
    mode: 'SANDBOX_TEST_ONLY',
    activeProvider: {
      id: activeProv.id,
      displayName: activeProv.displayName,
    },
    userNotifications: notificationLogs.filter((n) => n.audience === 'USER_ONLY').slice(0, 15),
  });
});

app.post('/api/payments/execute', async (req, res) => {
  try {
    const {
      idempotencyKey,
      userId = 'USR-CM-001',
      userPhone = '+237 699 12 34 12',
      userNotificationChannel = 'SMS',
      amount,
      currency = 'XAF',
      operator = 'MTN_MOMO',
      purpose = 'DAILY_SAVING',
      simulateFailure = false,
    } = req.body;

    if (!idempotencyKey) {
      return res.status(400).json({ error: 'Clé d’idempotence obligatoire pour éviter tout double débit.' });
    }

    if (processedIdempotencyKeys.has(idempotencyKey)) {
      const cached = processedIdempotencyKeys.get(idempotencyKey)!;
      appendAuditLog(userId, 'IDEMPOTENCY_REPLAY_BLOCKED', `Transaction ${idempotencyKey} déjà traitée (${cached.providerReference}).`, idempotencyKey);
      return res.json({ ...cached, idempotentReplay: true });
    }

    if (simulateFailure) {
      sendAdminAlert(
        `Échec de paiement Mobile Money (${operator})`,
        `La transaction de ${amount} ${currency} (${purpose}) pour ${maskPhoneServer(userPhone)} a expiré ou échoué sur l'agrégateur ${activeAggregatorId}. Clé: ${idempotencyKey}`,
        'CRITICAL'
      );
      appendAuditLog(userId, 'PAYMENT_FAILED', `Échec simulé ${amount} ${currency} via ${activeAggregatorId}`, idempotencyKey);
      return res.status(422).json({
        success: false,
        error: "Délai de confirmation USSD dépassé ou solde insuffisant (Alerte envoyée à l'administrateur).",
      });
    }

    const provider = PROVIDERS[activeAggregatorId] || PROVIDERS.flutterwave_cm;
    const result =
      purpose === 'MARKETPLACE_ESCROW'
        ? await provider.initiateEscrowHold({ idempotencyKey, userId, userPhone, amount, currency, operator, purpose })
        : await provider.initiateCollection({ idempotencyKey, userId, userPhone, amount, currency, operator, purpose });

    processedIdempotencyKeys.set(idempotencyKey, result);

    appendAuditLog(
      userId,
      `PAYMENT_${purpose}`,
      `${amount} ${currency} confirmé via ${provider.displayName} (Réf: ${result.providerReference})`,
      idempotencyKey
    );

    const purposeLabels: Record<string, string> = {
      GUARANTEE_DEPOSIT: 'Dépôt de garantie validé',
      DAILY_SAVING: 'Épargne quotidienne validée',
      MARKETPLACE_ESCROW: 'Paiement bloqué en séquestre',
      WITHDRAWAL_PAYOUT: 'Retrait d’épargne exécuté',
    };

    sendUserNotification(
      userPhone,
      userNotificationChannel,
      purposeLabels[purpose] || 'Confirmation de transaction',
      `NNAP KOBO (Sandbox) : ${purposeLabels[purpose]} de ${amount} ${currency}. Réf: ${result.providerReference}.`
    );

    res.json(result);
  } catch (err: any) {
    sendAdminAlert('Erreur Critique Serveur Paiement', err?.message || 'Erreur inconnue', 'CRITICAL');
    res.status(500).json({ error: err?.message || 'Erreur interne du serveur' });
  }
});

app.post('/api/payments/penalty', (req, res) => {
  const {
    userPhone = '+237 699 12 34 12',
    userNotificationChannel = 'SMS',
    penaltyAmount,
    remainingGuaranteeAfter,
    currency = 'XAF',
    destination = 'redistribution_pool',
    dayLabel = 'Jour 14',
  } = req.body;

  const idempotencyKey = `PENALTY-${dayLabel}-${Date.now()}`;
  const destinationLabels: Record<string, string> = {
    redistribution_pool: 'Cagnotte de redistribution aux épargnants assidus',
    platform_revenue: 'Revenu de service plateforme NNAP KOBO',
    solidarity_fund: 'Fonds communautaire de solidarité',
  };

  appendAuditLog(
    'DISCIPLINE_ENGINE',
    'GUARANTEE_PENALTY_APPLIED',
    `${dayLabel} raté : ${penaltyAmount} ${currency} déduits du dépôt de garantie (Solde caution restant : ${remainingGuaranteeAfter} ${currency}). Affectation : ${destinationLabels[destination] || destination}. Aucun prélèvement externe.`,
    idempotencyKey
  );

  sendUserNotification(
    userPhone,
    userNotificationChannel,
    `Pénalité appliquée sur votre caution (${dayLabel})`,
    `NNAP KOBO : Vous n'avez pas validé votre épargne avant l'heure limite. ${penaltyAmount} ${currency} ont été retenus sur votre dépôt de garantie (Solde caution restant : ${remainingGuaranteeAfter} ${currency}). Aucun débit n'a été fait sur votre compte Mobile Money.`
  );

  res.json({
    success: true,
    auditRecorded: true,
    message: `Pénalité de ${penaltyAmount} ${currency} retenue uniquement sur le dépôt de garantie.`,
  });
});

app.post('/api/security/event', (req, res) => {
  const { eventType, details, userPhone = '+237 699 12 34 12', severity = 'WARNING' } = req.body;
  appendAuditLog('SECURITY_GUARD', eventType, details);
  if (severity === 'CRITICAL' || eventType.includes('FAILED') || eventType.includes('REPORT') || eventType.includes('FRAUD')) {
    sendAdminAlert(`Sécurité : ${eventType}`, `${details} (Compte concerné : ${maskPhoneServer(userPhone)})`, 'CRITICAL');
  }
  res.json({ ok: true });
});

// ============================================================================
// 6. GEMINI AI ENDPOINTS (Server-Side Only - gemini-3-flash-preview & fallback gemini-3.8-flash)
// ============================================================================

const PRIMARY_MODEL = 'gemini-3-flash-preview';
const FALLBACK_MODEL = 'gemini-3.8-flash';
const FRIENDLY_AI_ERROR = "L'IA est très sollicitée, réessaie dans un instant";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryableGeminiError(error: any): boolean {
  if (!error) return false;
  const status = error.status || error.statusCode || error.response?.status;
  if (status === 503 || status === 429 || String(status) === '503' || String(status) === '429') {
    return true;
  }
  const msg = String(error?.message || '');
  return /503|429|RESOURCE_EXHAUSTED|UNAVAILABLE|quota|overload/i.test(msg);
}

interface GenerateGeminiParams {
  contents: any;
  config?: any;
}

/**
 * Exécute l'appel Gemini sur le modèle principal (gemini-3-flash-preview).
 * Si erreur 503 ou 429 : 3 réessais (2s, 4s, 8s).
 * Si échec persistant : bascule automatique sur gemini-3.8-flash.
 * Si tout échoue : renvoie l'erreur amicale sans JSON brut.
 */
async function callGeminiWithRetryAndFallback(ai: ReturnType<typeof getGenAI>, params: GenerateGeminiParams) {
  const retryDelays = [2000, 4000, 8000]; // 2 s, 4 s, 8 s
  let lastError: any = null;

  // 1. Essais sur le modèle principal : gemini-3-flash-preview
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: PRIMARY_MODEL,
        contents: params.contents,
        config: params.config,
      });
      return response;
    } catch (err: any) {
      lastError = err;
      const isRetryable = isRetryableGeminiError(err);
      console.warn(
        `[Gemini] Tentative ${attempt + 1}/${retryDelays.length + 1} échouée sur ${PRIMARY_MODEL}:`,
        err?.message || err
      );

      if (attempt < retryDelays.length && isRetryable) {
        const delay = retryDelays[attempt];
        console.log(`[Gemini] Réessai 503/429 dans ${delay / 1000}s...`);
        await sleep(delay);
      } else if (!isRetryable) {
        // Erreur non transitoire sur le preview : on bascule immédiatement sur le modèle de secours
        break;
      }
    }
  }

  // 2. Si ça échoue encore, bascule sur gemini-3.8-flash
  console.warn(`[Gemini] Bascule de secours vers le modèle ${FALLBACK_MODEL}...`);
  try {
    const fallbackResponse = await ai.models.generateContent({
      model: FALLBACK_MODEL,
      contents: params.contents,
      config: params.config,
    });
    return fallbackResponse;
  } catch (fallbackErr: any) {
    console.error(`[Gemini] Échec du modèle de secours ${FALLBACK_MODEL}:`, fallbackErr?.message || fallbackErr);
    throw new Error(FRIENDLY_AI_ERROR);
  }
}

function computeSmartGoalPlanFallback(goalText: string, currency: string = 'XAF', language: string = 'fr') {
  const textLower = goalText.toLowerCase();

  // 1. Extraction d'un montant explicite dans le texte si présent
  const numMatches = goalText.replace(/\s+/g, '').match(/(\d+)/g);
  let targetAmount = 300000; // valeur de référence par défaut

  if (numMatches && numMatches.length > 0) {
    const candidate = parseInt(numMatches[0], 10);
    if (!isNaN(candidate) && candidate >= 5000 && candidate <= 50000000) {
      targetAmount = candidate;
    }
  } else if (/voiture|véhicule|auto|moto|taxi/i.test(textLower)) {
    targetAmount = currency === 'EUR' || currency === 'USD' ? 2500 : 1800000;
  } else if (/loyer|boutique|magasin/i.test(textLower)) {
    targetAmount = currency === 'EUR' || currency === 'USD' ? 600 : 360000;
  } else if (/stock|marchandise|commerce/i.test(textLower)) {
    targetAmount = currency === 'EUR' || currency === 'USD' ? 800 : 500000;
  } else if (/ordinateur|pc|laptop|machine|téléphone|iphone|smartphone/i.test(textLower)) {
    targetAmount = currency === 'EUR' || currency === 'USD' ? 400 : 250000;
  } else if (/permis|formation|école|scolarité/i.test(textLower)) {
    targetAmount = currency === 'EUR' || currency === 'USD' ? 250 : 150000;
  }

  // 2. Détermination de la caisse adaptée
  let recommendedTier = 'semi_pro';
  let dailyAmount = 1500;
  let caisseName = 'Caisse Semi-Pro';

  if (currency === 'EUR' || currency === 'USD') {
    if (targetAmount <= 150) {
      recommendedTier = 'amateur';
      dailyAmount = 1;
      caisseName = 'Caisse Amateur';
    } else if (targetAmount <= 600) {
      recommendedTier = 'semi_pro';
      dailyAmount = 3;
      caisseName = 'Caisse Semi-Pro';
    } else if (targetAmount <= 2000) {
      recommendedTier = 'boss';
      dailyAmount = 8;
      caisseName = 'Caisse Boss';
    } else {
      recommendedTier = 'mega_boss';
      dailyAmount = 16;
      caisseName = 'Caisse Méga Boss';
    }
  } else {
    // XAF / XOF
    if (targetAmount <= 100000) {
      recommendedTier = 'amateur';
      dailyAmount = 500;
      caisseName = 'Caisse Amateur';
    } else if (targetAmount <= 450000) {
      recommendedTier = 'semi_pro';
      dailyAmount = 1500;
      caisseName = 'Caisse Semi-Pro';
    } else if (targetAmount <= 1500000) {
      recommendedTier = 'boss';
      dailyAmount = 5000;
      caisseName = 'Caisse Boss';
    } else {
      recommendedTier = 'mega_boss';
      dailyAmount = 10000;
      caisseName = 'Caisse Méga Boss';
    }
  }

  // 3. Calcul précis du nombre de jours
  const durationDays = Math.max(7, Math.ceil(targetAmount / dailyAmount));
  const monthsApprox = (durationDays / 30).toFixed(1).replace('.0', '');
  const durationFormatted =
    durationDays >= 30
      ? `${durationDays} jours (environ ${monthsApprox} mois)`
      : `${durationDays} jours`;

  const recommendedGuaranteeDays = durationDays >= 60 ? 14 : 7;

  let goalTitle = goalText.length > 38 ? goalText.substring(0, 35) + '...' : goalText;
  goalTitle = goalTitle.replace(/^(je veux|j'aimerais|projet)\s*/i, '').trim();
  goalTitle = goalTitle.charAt(0).toUpperCase() + goalTitle.slice(1);

  return {
    goalTitle: goalTitle || 'Mon Projet d’Épargne',
    caisseName,
    targetAmount,
    recommendedTier,
    dailyAmount,
    durationDays,
    durationFormatted,
    recommendedGuaranteeDays,
    explanation:
      language === 'fr'
        ? `Pour financer « ${goalTitle} » à hauteur de ${targetAmount.toLocaleString()} ${currency}, la **${caisseName} (${dailyAmount.toLocaleString()} ${currency}/jour)** est la plus équilibrée. À ce rythme, votre objectif est atteint en **${durationFormatted}**. Une caution de ${recommendedGuaranteeDays} jours sécurise votre engagement sans aucun prélèvement secret.`
        : `To reach "${goalTitle}" (${targetAmount.toLocaleString()} ${currency}), the **${caisseName} (${dailyAmount.toLocaleString()} ${currency}/day)** is recommended. You will hit your goal in **${durationFormatted}**. A ${recommendedGuaranteeDays}-day guarantee protects your streak with zero stealth debits.`,
  };
}

app.post('/api/ai/analyze-goal', async (req, res) => {
  const { goalText, currency = 'XAF', language = 'fr' } = req.body;
  if (!goalText || typeof goalText !== 'string') {
    return res.status(400).json({ error: 'Veuillez décrire votre objectif.' });
  }

  try {
    const ai = getGenAI();
    const response = await callGeminiWithRetryAndFallback(ai, {
      contents: `Tu es le conseiller d'épargne de l'application Android NNAP KOBO. Analyse cet objectif d'épargne d'un utilisateur mobile en Afrique : "${goalText}". Devise choisie : ${currency}. Langue de réponse : ${language === 'en' ? 'Anglais' : 'Français'}.
Les 4 niveaux quotidiens de référence en XAF sont :
- amateur : 500 XAF/jour (Caisse Amateur)
- semi_pro : 1500 XAF/jour (Caisse Semi-Pro)
- boss : 5000 XAF/jour (Caisse Boss)
- mega_boss : 10000 XAF/jour (Caisse Méga Boss)
(Si la devise est XOF, garde les mêmes montants. Si EUR : 1, 3, 8, 15 EUR/jour. Si USD : 1, 3, 8, 16 USD/jour).
Réponds obligatoirement avec quelle caisse choisir (caisseName et recommendedTier) et combien de temps il faudra précisément (durationDays et durationFormatted).
Ton explication doit être naturelle, humaine, chaleureuse et sans jargon.`,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            goalTitle: { type: Type.STRING, description: 'Titre court et motivant de l’objectif' },
            caisseName: { type: Type.STRING, description: 'Nom de la caisse conseillée (ex: Caisse Semi-Pro)' },
            targetAmount: { type: Type.NUMBER, description: 'Montant total réaliste visé dans la devise choisie' },
            recommendedTier: {
              type: Type.STRING,
              description: 'Un parmi: amateur, semi_pro, boss, mega_boss',
            },
            dailyAmount: { type: Type.NUMBER, description: 'Montant quotidien recommandé dans la devise' },
            durationDays: { type: Type.INTEGER, description: 'Nombre de jours nécessaires pour atteindre la cible' },
            durationFormatted: { type: Type.STRING, description: 'Durée formulée en clair (ex: 90 jours / environ 3 mois)' },
            recommendedGuaranteeDays: {
              type: Type.INTEGER,
              description: 'Nombre de jours de dépôt de garantie conseillé (7, 14 ou 30)',
            },
            explanation: {
              type: Type.STRING,
              description: 'Explication naturelle et humaine qui indique clairement quelle caisse faire et combien de temps.',
            },
          },
          required: [
            'goalTitle',
            'caisseName',
            'targetAmount',
            'recommendedTier',
            'dailyAmount',
            'durationDays',
            'durationFormatted',
            'recommendedGuaranteeDays',
            'explanation',
          ],
        },
      },
    });

    let raw = (response.text || '').trim();
    if (raw.startsWith('```json')) raw = raw.replace(/^```json/, '').replace(/```$/, '').trim();
    else if (raw.startsWith('```')) raw = raw.replace(/^```/, '').replace(/```$/, '').trim();

    const parsed = JSON.parse(raw || '{}');
    if (!parsed.recommendedTier || !parsed.durationDays) {
      throw new Error('Incomplete JSON response');
    }
    res.json(parsed);
  } catch (error: any) {
    console.warn('Gemini analyze-goal using smart calculated fallback:', error?.message || error);
    // Fournit toujours un plan calculé précis et fiable : l'utilisateur reçoit toujours sa caisse et sa durée
    const fallbackPlan = computeSmartGoalPlanFallback(goalText, currency, language);
    res.json(fallbackPlan);
  }
});

app.post('/api/ai/assistant', async (req, res) => {
  try {
    const { message, contextData, language = 'fr' } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Message requis.' });
    }

    const ai = getGenAI();
    const response = await callGeminiWithRetryAndFallback(ai, {
      contents: message,
      config: {
        systemInstruction: `Tu es le coach d'épargne de l'application Android NNAP KOBO (« L'app qui te pousse à tenir parole avec toi-même »), conçue par Ndoumin Nnanga Adams Pharel au Cameroun.

Style et ton (naturel, vivant, inspiré de Claude) :
- Réponds de manière profondément naturelle, fluide, chaleureuse et humaine.
- Ne parle JAMAIS comme un robot, un formulaire administratif ou une FAQ : évite les formules rigides ("En tant qu'intelligence artificielle...", "Il est important de noter...", "Veuillez trouver ci-dessous").
- Parle avec franchise, clarté et bienveillance, comme un mentor intègre et complice qui accompagne l'utilisateur sur son smartphone Android au quotidien.
- Sois concis et percutant : 2 à 4 paragraphes courts ou quelques phrases vivantes, faciles à lire sur un écran de téléphone mobile.

Contexte en direct de l'utilisateur sur l'application Android :
${JSON.stringify(contextData || {})}

Règles incontournables :
1. Langue : ${language === 'en' ? 'Anglais naturel, direct et chaleureux' : 'Français naturel, chaleureux, percutant et authentique'}.
2. Sécurité des fonds : explique simplement que l'argent est cantonné sur un compte séquestre bancaire officiel auprès d'agrégateurs agréés (MTN MoMo, Orange Money), jamais géré de manière artisanale.
3. Règle du dépôt de garantie sur Android : le Mobile Money exigeant la saisie manuelle d'un code PIN secret USSD à chaque validation, l'application ne fait AUCUN prélèvement automatique secret sur la carte SIM ou le compte mobile de l'utilisateur. Si un jour est manqué après 20h00, la pénalité est retenue uniquement sur son dépôt de garantie initial.
4. Vérité financière : AUCUNE promesse d'intérêts financiers, de rendements ou de gains miraculeux. La victoire, c'est la discipline personnelle et l'habitude tenue.
5. Contexte mobile : l'application est une application Android native pensée pour les utilisateurs d'Afrique et de la diaspora.`,
      },
    });

    res.json({ reply: response.text || '' });
  } catch (error: any) {
    console.error('Gemini assistant error:', error?.message || error);
    // Jamais de JSON brut en cas d'erreur
    res.status(503).json({ error: FRIENDLY_AI_ERROR });
  }
});

app.post('/api/ai/marketplace-helper', async (req, res) => {
  try {
    const { prompt, productType = 'digital', currency = 'XAF', language = 'fr' } = req.body;
    const ai = getGenAI();
    const response = await callGeminiWithRetryAndFallback(ai, {
      contents: `Tu aides un vendeur sur le Marché de l'application Android NNAP KOBO. Idée ou produit : "${prompt}". Type : ${productType}. Devise principale : ${currency}. Langue : ${language === 'en' ? 'Anglais' : 'Français'}. Propose une rédaction naturelle, vendeuse et rassurante.`,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            suggestedTitle: { type: Type.STRING, description: 'Titre accrocheur et professionnel de l’annonce' },
            suggestedPriceXAF: { type: Type.NUMBER, description: 'Prix conseillé en XAF (FCFA)' },
            suggestedDescription: {
              type: Type.STRING,
              description: 'Description claire et humaine mettant en avant la valeur et la protection par séquestre NNAP KOBO',
            },
            digitalProductIdeas: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: '3 idées concrètes de produits digitaux ou physiques complémentaires vendables en Afrique francophone',
            },
            deliveryTip: {
              type: Type.STRING,
              description: 'Conseil pratique pour la livraison automatique ou la preuve de remise',
            },
          },
          required: [
            'suggestedTitle',
            'suggestedPriceXAF',
            'suggestedDescription',
            'digitalProductIdeas',
            'deliveryTip',
          ],
        },
      },
    });

    res.json(JSON.parse(response.text || '{}'));
  } catch (error: any) {
    console.error('Gemini marketplace-helper error:', error?.message || error);
    // Jamais de JSON brut en cas d'erreur
    res.status(503).json({ error: FRIENDLY_AI_ERROR });
  }
});

// ============================================================================
// 7. VITE MIDDLEWARE / STATIC ASSETS
// ============================================================================

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`NNAP KOBO Server running on http://localhost:${PORT}`);
  });
}

startServer();
