/**
 * Suite de tests de sécurité Firestore ("Dirty Dozen" Payloads) — NNAP KOBO
 * Vérifie que les 12 vecteurs d'attaque définis dans security_spec.md retournent PERMISSION_DENIED.
 */

export const DIRTY_DOZEN_SECURITY_ASSERTIONS = [
  {
    id: 1,
    name: 'Identity Spoofing',
    path: '/users/victim_uid',
    authUid: 'attacker_uid',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'Shadow Field / Password Leak Prevention',
    path: '/users/user_1',
    payloadExtraField: { password: 'plain_password_123' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Underage Registration (< 18 years old)',
    path: '/users/user_1',
    payloadOverride: { isAdultVerified: false },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'Unaccepted Terms & Privacy Policy',
    path: '/users/user_1',
    payloadOverride: { termsAccepted: false },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'Cross-User Profile Read (PII Leak)',
    path: '/users/user_2',
    authUid: 'user_1',
    operation: 'get',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'User Collection Scraping (List Query)',
    path: '/users',
    authUid: 'user_1',
    operation: 'list',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'Denial of Wallet (Oversized String > 120 chars)',
    path: '/users/user_1',
    payloadOverride: { fullName: 'A'.repeat(500) },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'Immortal Field Mutation (createdAt / uid)',
    path: '/users/user_1',
    operation: 'update',
    payloadOverride: { uid: 'different_uid' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'Timestamp Spoofing (updatedAt != request.time)',
    path: '/users/user_1',
    operation: 'update',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'Invalid Mobile Money Operator Enum',
    path: '/users/user_1',
    payloadOverride: { mobileMoneyOperator: 'UNKNOWN_OPERATOR' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'Self-Assigned Admin Privilege Escalation',
    path: '/admins/attacker_uid',
    authUid: 'attacker_uid',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'Value Poisoning on Update (Invalid Type)',
    path: '/users/user_1',
    operation: 'update',
    payloadOverride: { city: 99999 },
    expected: 'PERMISSION_DENIED',
  },
];
