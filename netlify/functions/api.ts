import { GoogleGenAI, Type } from '@google/genai';

// Netlify Function : remplace les routes IA du server.ts (AI Studio).
// La clé GEMINI_API_KEY reste côté serveur (variable d'environnement Netlify).

const PRIMARY_MODEL = 'gemini-3-flash-preview';
const FALLBACK_MODEL = 'gemini-3.8-flash';
const FRIENDLY_AI_ERROR = "L'IA est très sollicitée, réessaie dans un instant";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function getGenAI() {
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

function isRetryableGeminiError(error: any): boolean {
  if (!error) return false;
  const status = error.status || error.statusCode || error.response?.status;
  if (String(status) === '503' || String(status) === '429') return true;
  return /503|429|RESOURCE_EXHAUSTED|UNAVAILABLE|quota|overload/i.test(String(error?.message || ''));
}

// Modèle principal, 1 réessai court, puis modèle de secours
// (une Netlify Function est limitée à ~10 s par défaut, donc délais courts)
async function callGemini(ai: GoogleGenAI, params: { contents: any; config?: any }) {
  try {
    return await ai.models.generateContent({ model: PRIMARY_MODEL, contents: params.contents, config: params.config });
  } catch (err: any) {
    console.warn('[Gemini] échec modèle principal:', err?.message || err);
    if (isRetryableGeminiError(err)) await sleep(1000);
  }
  try {
    return await ai.models.generateContent({ model: FALLBACK_MODEL, contents: params.contents, config: params.config });
  } catch (err: any) {
    console.error('[Gemini] échec modèle de secours:', err?.message || err);
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

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

function parseJsonText(text: string | undefined) {
  let raw = (text || '').trim();
  if (raw.startsWith('```json')) raw = raw.replace(/^```json/, '').replace(/```$/, '').trim();
  else if (raw.startsWith('```')) raw = raw.replace(/^```/, '').replace(/```$/, '').trim();
  return JSON.parse(raw || '{}');
}

export default async (req: Request) => {
  const route = new URL(req.url).pathname.replace(/\/+$/, '');

  // État système minimal (version Netlify : pas de notifications serveur)
  if (route === '/api/system/state' && req.method === 'GET') {
    return json({
      mode: 'SANDBOX_TEST_ONLY',
      activeProvider: { id: 'flutterwave_cm', displayName: 'Flutterwave (Sandbox CEMAC/UEMOA)' },
      userNotifications: [],
    });
  }

  if (req.method !== 'POST') return json({ error: 'Méthode non autorisée.' }, 405);

  let body: any = {};
  try { body = await req.json(); } catch { body = {}; }

  // ---------- Coach IA ----------
  if (route === '/api/ai/assistant') {
    try {
      const { message, contextData, language = 'fr' } = body;
      if (!message) return json({ error: 'Message requis.' }, 400);
      const ai = getGenAI();
      const response = await callGemini(ai, {
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
      return json({ reply: response.text || '' });
    } catch (error: any) {
      console.error('assistant error:', error?.message || error);
      return json({ error: FRIENDLY_AI_ERROR }, 503);
    }
  }

  // ---------- Calculateur caisse & durée ----------
  if (route === '/api/ai/analyze-goal') {
    const { goalText, currency = 'XAF', language = 'fr' } = body;
    if (!goalText || typeof goalText !== 'string') {
      return json({ error: 'Veuillez décrire votre objectif.' }, 400);
    }
    try {
      const ai = getGenAI();
      const response = await callGemini(ai, {
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
      const parsed = parseJsonText(response.text);
      if (!parsed.recommendedTier || !parsed.durationDays) throw new Error('Incomplete JSON response');
      return json(parsed);
    } catch (error: any) {
      console.warn('analyze-goal fallback:', error?.message || error);
      return json(computeSmartGoalPlanFallback(goalText, currency, language));
    }
  }

  // ---------- Aide Marché ----------
  if (route === '/api/ai/marketplace-helper') {
    try {
      const { prompt, productType = 'digital', currency = 'XAF', language = 'fr' } = body;
      const ai = getGenAI();
      const response = await callGemini(ai, {
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
      return json(parseJsonText(response.text));
    } catch (error: any) {
      console.error('marketplace-helper error:', error?.message || error);
      return json({ error: FRIENDLY_AI_ERROR }, 503);
    }
  }

  return json({ error: 'Route introuvable.' }, 404);
};

export const config = { path: '/api/*' };
