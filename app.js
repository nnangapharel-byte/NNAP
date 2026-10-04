document.addEventListener('DOMContentLoaded', () => {
    // Check-up de l'essai gratuit (5 jours)
    checkFreeTrial();

    // 1. Gestion des boutons de connexion aux Réseaux Sociaux
    document.getElementById('btn-tiktok').addEventListener('click', () => {
        connectSocialNetwork('TikTok');
    });

    document.getElementById('btn-instagram').addEventListener('click', () => {
        connectSocialNetwork('Instagram');
    });

    document.getElementById('btn-youtube').addEventListener('click', () => {
        connectSocialNetwork('YouTube');
    });

    // 2. Gestion du bouton d'activation de la génération IA
    document.getElementById('btn-activate-daily').addEventListener('click', () => {
        const apiKey = document.getElementById('api-key').value.trim();
        const goal = document.getElementById('growth-goal').value.trim();

        if (!apiKey) {
            alert(' Veuillez saisir votre clé d\'API (Gemini ou OpenAI) pour activer le service.');
            return;
        }

        // Sauvegarde locale de la configuration
        localStorage.setItem('nnap_api_key', apiKey);
        localStorage.setItem('nnap_goal', goal);

        alert(' Generation Daily activée avec succès ! L\'agent IA commencera la création automatisée.');
    });

    // 3. Gestion du paiement Orange Money
    document.getElementById('btn-pay-om').addEventListener('click', () => {
        const amountChoice = prompt("Choisissez votre formule :\n1. Semaine (3 000 FCFA)\n2. Mois (15 000 FCFA)\n\nEntrez 1 ou 2 :");
        
        if (amountChoice === '1') {
            alert(' Virement de 3 000 FCFA à effectuer sur le numéro Orange Money : 690404474 (Ndoumin Nnanga Adams Pharel).');
        } else if (amountChoice === '2') {
            alert(' Virement de 15 000 FCFA à effectuer sur le numéro Orange Money : 690404474 (Ndoumin Nnanga Adams Pharel).');
        } else {
            alert('Option invalide.');
        }
    });
});

// Fonction pour simuler la redirection OAuth des réseaux
function connectSocialNetwork(platform) {
    alert(`Redirection vers la page d'authentification ${platform}...`);
    // Remplacez par votre URL d'authentification réelle
    // window.location.href = `https://api.${platform.toLowerCase()}.com/oauth/...`;
}

// Fonction de calcul de la période d'essai de 5 jours
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

    if (diffDays > 5) {
        console.log("Période d'essai gratuite de 5 jours expirée. Passer à la version payante.");
    } else {
        console.log(`Période d'essai active : Jour ${diffDays} sur 5.`);
    }
}
