import fs from 'fs';
import path from 'path';
import type { AccessPolicy } from './types.js';

const ACCESS_PATH = path.join(process.cwd(), 'access.json');

const DEFAULT_POLICY: AccessPolicy = {
  allowlist: [123510069],
  pending: [],
  denied: [],
  default_policy: 'pending'
};

export function loadPolicy(): AccessPolicy {
  if (!fs.existsSync(ACCESS_PATH)) {
    savePolicy(DEFAULT_POLICY);
    return DEFAULT_POLICY;
  }
  return JSON.parse(fs.readFileSync(ACCESS_PATH, 'utf-8'));
}

export function savePolicy(policy: AccessPolicy): void {
  fs.writeFileSync(ACCESS_PATH, JSON.stringify(policy, null, 2) + '\n');
}

export function checkAccess(userId: number): 'allowed' | 'pending' | 'denied' {
  const policy = loadPolicy();
  if (policy.allowlist.includes(userId)) return 'allowed';
  if (policy.denied.includes(userId)) return 'denied';
  if (policy.pending.includes(userId)) return 'pending';

  // First contact
  if (policy.default_policy === 'allow') {
    policy.allowlist.push(userId);
    savePolicy(policy);
    return 'allowed';
  }
  if (policy.default_policy === 'deny') {
    policy.denied.push(userId);
    savePolicy(policy);
    return 'denied';
  }

  // default: pending
  policy.pending.push(userId);
  savePolicy(policy);
  return 'pending';
}

export function approveUser(userId: number): boolean {
  const policy = loadPolicy();
  policy.pending = policy.pending.filter(id => id !== userId);
  policy.denied = policy.denied.filter(id => id !== userId);
  if (!policy.allowlist.includes(userId)) {
    policy.allowlist.push(userId);
  }
  savePolicy(policy);
  return true;
}

export function denyUser(userId: number): boolean {
  const policy = loadPolicy();
  policy.pending = policy.pending.filter(id => id !== userId);
  policy.allowlist = policy.allowlist.filter(id => id !== userId);
  if (!policy.denied.includes(userId)) {
    policy.denied.push(userId);
  }
  savePolicy(policy);
  return true;
}
