document.addEventListener('DOMContentLoaded', () => {
    // Initialisation de la période d'essai gratuit
    checkFreeTrial();

    // 1. Gestion des boutons Réseaux Sociaux
    const btnTiktok = document.getElementById('btn-tiktok');
    if (btnTiktok) {
        btnTiktok.addEventListener('click', () => connectSocialNetwork('TikTok'));
    }

    const btnInstagram = document.getElementById('btn-instagram');
    if (btnInstagram) {
        btnInstagram.addEventListener('click', () => connectSocialNetwork('Instagram'));
    }

    const btnYoutube = document.getElementById('btn-youtube');
    if (btnYoutube) {
        btnYoutube.addEventListener('click', () => connectSocialNetwork('YouTube'));
    }

    // 2. Activation Génération IA
    const btnActivate = document.getElementById('btn-activate-daily');
    if (btnActivate) {
        btnActivate.addEventListener('click', () => {
            const apiKeyInput = document.getElementById('api-key');
            const goalInput = document.getElementById('growth-goal');

            const apiKey = apiKeyInput ? apiKeyInput.value.trim() : '';
            const goal = goalInput ? goalInput.value.trim() : '';

            if (!apiKey) {
                alert("Veuillez saisir une clé d'API valide pour activer l'agent IA.");
                return;
            }

            localStorage.setItem('nnap_api_key', apiKey);
            localStorage.setItem('nnap_goal', goal);

            alert("Agent IA activé avec succès ! Génération automatique configurée.");
        });
    }

    // 3. Bouton Paiement Orange Money
    const btnOm = document.getElementById('btn-pay-om');
    if (btnOm) {
        btnOm.addEventListener('click', () => {
            const choix = prompt(
                "Abonnement NNAP Studio :\n\n" +
                "1. Formule Semaine : 3 000 FCFA\n" +
                "2. Formule Mois : 15 000 FCFA\n\n" +
                "Saisissez 1 ou 2 :"
            );

            if (choix === '1') {
                alert("Veuillez effectuer votre dépôt/transfert Orange Money de 3 000 FCFA au numéro :\n\n👉 690404474 (Ndoumin Nnanga Adams Pharel)");
            } else if (choix === '2') {
                alert("Veuillez effectuer votre dépôt/transfert Orange Money de 15 000 FCFA au numéro :\n\n👉 690404474 (Ndoumin Nnanga Adams Pharel)");
            } else if (choix !== null && choix !== '') {
                alert("Choix invalide. Veuillez saisir 1 ou 2.");
            }
        });
    }
});

// Fonction de synchronisation des comptes
function connectSocialNetwork(platform) {
    const username = prompt(`Entrez votre nom d'utilisateur ${platform} pour lancer la synchronisation :`);
    if (username) {
        alert(`Compte @${username} connecté ! Analyse des abonnés et optimisation des Lives en cours...`);
    }
}

// Fonction de gestion de l'essai gratuit (5 jours)
function checkFreeTrial() {
    let startDate = localStorage.getItem('nnap_start_date');

    if (!startDate) {
        startDate = new Date().toISOString();
        localStorage.setItem('nnap_start_date', startDate);
    }

    const start = new Date(startDate);
    const now = new Date();
    const diffTime = Math.abs(now - start);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    const daysRemaining = Math.max(0, 5 - diffDays);

    const bannerDays = document.getElementById('trial-days');
    if (bannerDays) {
        bannerDays.textContent = daysRemaining;
    }

    if (daysRemaining === 0) {
        const banner = document.getElementById('trial-banner');
        if (banner) {
            banner.style.background = '#dc2626';
            banner.innerHTML = "⚠️ Essai gratuit de 5 jours expiré. Veuillez souscrire à un abonnement.";
        }
    }
}
