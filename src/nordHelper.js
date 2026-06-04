import { Keypair, PublicKey } from "@solana/web3.js";
import { NordUser, makeWalletSignFn } from "@n1xyz/nord-ts";
import bs58 from "bs58";
import * as ed25519 from "@noble/ed25519";

export function parsePrivateKeyLocal(input) {
  const trimmed = input.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      return new Uint8Array(JSON.parse(trimmed));
    } catch (e) {
      throw new Error('Invalid JSON private key format');
    }
  }
  try {
    return bs58.decode(trimmed);
  } catch (e) {
    if (/^[0-9a-fA-F]+$/.test(trimmed)) {
      return Buffer.from(trimmed, 'hex');
    }
    throw new Error('Unsupported private key encoding. Please use Base58 or JSON array.');
  }
}

export async function createNordUserHelper(nord, walletAddress, privateKeyStr) {
  const trimmedKey = privateKeyStr.trim();
  let isEvm = false;
  let cleanPrivateKey = trimmedKey;
  
  if (trimmedKey.startsWith('0x')) {
    isEvm = true;
    cleanPrivateKey = trimmedKey.slice(2);
  } else if (/^[0-9a-fA-F]{64}$/.test(trimmedKey)) {
    isEvm = true;
  }

  let parsedKey = null;
  if (!isEvm) {
    parsedKey = parsePrivateKeyLocal(trimmedKey);
    
    // Check if it's 32 bytes. If it's 32 bytes, it could be a Solana seed or an EVM private key.
    if (parsedKey.length === 32) {
      if (walletAddress) {
        // Derive Solana public key from it as a Solana seed
        try {
          const derivedSolana = Keypair.fromSeed(parsedKey).publicKey.toBase58();
          if (derivedSolana !== walletAddress) {
            // Derived Solana address doesn't match, so it's likely an EVM private key!
            isEvm = true;
            cleanPrivateKey = Buffer.from(parsedKey).toString('hex');
          }
        } catch (e) {
          isEvm = true;
          cleanPrivateKey = Buffer.from(parsedKey).toString('hex');
        }
      }
    }
  }

  if (isEvm) {
    if (!walletAddress) {
      throw new Error('Wallet address (Solana address mapped to EVM) is required when using an EVM private key.');
    }

    const rawEvmKey = Buffer.from(cleanPrivateKey, 'hex');
    const evmSignRaw = makeWalletSignFn(rawEvmKey);
    const signMessageFn = async (message) => {
      const hexSig = await evmSignRaw(message);
      const cleanHex = hexSig.startsWith("0x") ? hexSig.slice(2) : hexSig;
      return Buffer.from(cleanHex, "hex");
    };

    const sessionKey = Keypair.generate();
    const signSessionFn = async (message) => {
      return await ed25519.signAsync(message, sessionKey.secretKey.slice(0, 32));
    };

    const signTransactionFn = async (tx) => tx;

    return await NordUser.new({
      nord,
      walletPubkey: new PublicKey(walletAddress),
      sessionPubkey: sessionKey.publicKey.toBytes(),
      signMessageFn,
      signSessionFn,
      signTransactionFn
    });
  } else {
    // Solana Keypair (64 bytes or derived from 32 bytes seed)
    let keypair;
    if (parsedKey.length === 32) {
      keypair = Keypair.fromSeed(parsedKey);
    } else if (parsedKey.length === 64) {
      keypair = Keypair.fromSecretKey(parsedKey);
    } else {
      throw new Error(`Invalid private key length: ${parsedKey.length} bytes (expected 32 or 64 bytes)`);
    }

    return NordUser.fromPrivateKey(nord, keypair.secretKey);
  }
}
