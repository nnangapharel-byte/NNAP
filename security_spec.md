# Spécification de Sécurité Firestore — NNAP KOBO (`security_spec.md`)

## 1. Invariants de Données (Data Invariants)
1. **Isolation stricte des données personnelles (PII) :** Un document `/users/{userId}` ne peut être lu (`get`), créé (`create`), modifié (`update`) ou supprimé (`delete`) que par l'utilisateur authentifié dont `request.auth.uid == userId` (ou un administrateur vérifié dans `/admins/$(request.auth.uid)`). Le listage global (`allow list`) par les clients est strictement interdit (`if false`).
2. **Interdiction absolue de secrets en base :** Aucun champ `password`, `pin`, `momoPin` ou `secretCode` n'est autorisé dans le schéma `isValidUserProfile(data)` grâce à `data.keys().hasOnly(...)`.
3. **Majorité légale et Consentement :** `data.isAdultVerified == true` et `data.termsAccepted == true` sont obligatoires à la création et à la mise à jour.
4. **Intégrité temporelle :** `createdAt == request.time` à la création ; `createdAt == resource.data.createdAt` (immuable) et `updatedAt == request.time` lors des mises à jour.

## 2. Les 12 Payloads d'Attaque ("Dirty Dozen")
1. **Usurpation d'identité (`Identity Spoofing`) :** Créer `/users/victim_uid` alors que `request.auth.uid == "attacker_uid"` → `PERMISSION_DENIED`.
2. **Injection de champ fantôme (`Shadow Field / Password Leak`) :** Envoyer `{ ..., password: "secret123" }` ou `{ ..., role: "admin" }` → `PERMISSION_DENIED` (bloqué par `.keys().hasOnly(...)`).
3. **Mineur (< 18 ans) :** Envoyer `isAdultVerified: false` → `PERMISSION_DENIED`.
4. **Refus des CGU :** Envoyer `termsAccepted: false` → `PERMISSION_DENIED`.
5. **Lecture du profil d'un tiers (`PII Blanket Read`) :** `get(/users/other_uid)` par un utilisateur connecté → `PERMISSION_DENIED`.
6. **Listage de la collection `/users` (`Scraping`) :** `list(/users)` depuis le client → `PERMISSION_DENIED`.
7. **Dépassement de taille (`Denial of Wallet`) :** `fullName` de 5 000 caractères → `PERMISSION_DENIED`.
8. **Modification du `createdAt` ou du `uid` (`Immortal Field Mutation`) :** Changer `uid` ou `createdAt` lors d'un `update` → `PERMISSION_DENIED`.
9. **Falsification d'horodatage (`Client Timestamp Spoofing`) :** Envoyer un `updatedAt` différent de `request.time` → `PERMISSION_DENIED`.
10. **Opérateur Mobile Money invalide :** Envoyer `mobileMoneyOperator: "UNKNOWN_PAY"` → `PERMISSION_DENIED`.
11. **Auto-promotion Administrateur :** Écrire dans `/admins/attacker_uid` depuis le client → `PERMISSION_DENIED`.
12. **Mise à jour avec type invalide (`Value Poisoning`) :** Mettre à jour `city` avec un nombre `12345` au lieu d'une chaîne bornée → `PERMISSION_DENIED`.
