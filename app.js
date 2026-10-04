document.addEventListener('DOMContentLoaded', () => {
    checkFreeTrial();

    // 1. Boutons Réseaux Sociaux
    document.getElementById('btn-tiktok').addEventListener('click', () => {
        connectSocialNetwork('TikTok');
    });

    document.getElementById('btn-instagram').addEventListener('click', () => {
        connectSocialNetwork('Instagram');
    });

    document.getElementById('btn-youtube').addEventListener('click', () => {
        connectSocialNetwork('YouTube');
    });

    // 2. Activation Génération IA
    document.getElementById('btn-activate-daily').addEventListener('click', () => {
        const apiKey = document.getElementById('api-key').value.trim();
        const goal = document.getElementById('growth-goal').value.trim();

        if (!apiKey) {
            alert("Veuillez saisir une clé d'API valide pour permettre à l'agent IA de fonctionner.");
            return;
        }

        localStorage.setItem('nnap_api_key', apiKey);
        localStorage.setItem('nnap_goal', goal);

        alert("Agent IA activé ! Génération quotidienne et optimisation des abonnés configurées.");
    });

    // 3. Paiement Orange Money
    document.getElementById('btn-pay-om').addEventListener('click', () => {
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
        } else if (choix !== null) {
            alert("Choix invalide. Veuillez réessayer.");
        }
    });
});

function connectSocialNetwork(platform) {
    const username = prompt(`Entrez votre nom d'utilisateur ${platform} pour lancer la synchronisation :`);
    if (username) {
        alert(`Compte @${username} connecté ! Analyse des abonnés et optimisation des Lives en cours...`);
    }
}

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
