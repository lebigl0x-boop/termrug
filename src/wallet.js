import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';

/**
 * The trading key never leaves this module as raw bytes. Everything downstream
 * works with the Keypair or the public key, so a key can never reach the API
 * snapshot, an event payload or a log line by accident.
 */
function decodeSecret(secret) {
  const trimmed = secret.trim();
  // Solana CLI keypair files are a JSON array of 64 bytes.
  if (trimmed.startsWith('[')) {
    const bytes = JSON.parse(trimmed);
    if (!Array.isArray(bytes)) throw new Error('expected a byte array');
    return Uint8Array.from(bytes);
  }
  return bs58.decode(trimmed);
}

export function loadTraderWallet(secret = process.env.TRADER_PRIVATE_KEY) {
  if (!secret || !String(secret).trim()) return { keypair: null, publicKey: null, reason: 'TRADER_PRIVATE_KEY is not set.' };
  try {
    const bytes = decodeSecret(String(secret));
    // 64 bytes is the full keypair; 32 is the seed alone.
    const keypair = bytes.length === 32 ? Keypair.fromSeed(bytes) : Keypair.fromSecretKey(bytes);
    return { keypair, publicKey: keypair.publicKey.toBase58(), reason: '' };
  } catch (error) {
    return { keypair: null, publicKey: null, reason: `TRADER_PRIVATE_KEY could not be read: ${error.message}` };
  }
}
