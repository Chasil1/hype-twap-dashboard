import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { NordUser } from '@n1xyz/nord-ts';
import { createNordUserHelper } from '../src/nordHelper.js';

// Stub static methods on NordUser so we don't make network calls
const originalNew = NordUser.new;
const originalFromPrivateKey = NordUser.fromPrivateKey;

test('createNordUserHelper rejects an EVM wallet address for 01 Exchange trading', async () => {
  await assert.rejects(
    createNordUserHelper({}, '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', '0x' + '11'.repeat(32)),
    /01 Exchange requires a Solana wallet address/
  );
});

test('createNordUserHelper rejects a Solana private key that does not match the configured wallet address', async () => {
  const configuredAddress = Keypair.generate().publicKey.toBase58();
  const otherKeypair = Keypair.generate();

  await assert.rejects(
    createNordUserHelper({}, configuredAddress, bs58.encode(otherKeypair.secretKey)),
    /does not match the configured wallet address/
  );
});

test('createNordUserHelper creates a Nord user from a matching Solana keypair', async () => {
  const keypair = Keypair.generate();
  let calledFromPrivateKey = false;
  
  NordUser.fromPrivateKey = (nord, secretKey) => {
    calledFromPrivateKey = true;
    assert.deepEqual(secretKey, keypair.secretKey);
    return { publicKey: keypair.publicKey };
  };

  try {
    const user = await createNordUserHelper(
      {},
      keypair.publicKey.toBase58(),
      bs58.encode(keypair.secretKey)
    );
    assert.ok(calledFromPrivateKey);
    assert.equal(user.publicKey.toBase58(), keypair.publicKey.toBase58());
  } finally {
    NordUser.fromPrivateKey = originalFromPrivateKey;
  }
});

test('createNordUserHelper delegates EVM private key signature setup', async () => {
  const solanaWallet = Keypair.generate().publicKey;
  const evmPrivateKey = '0x' + '12'.repeat(32);
  let calledNew = false;

  NordUser.new = async (options) => {
    calledNew = true;
    assert.equal(options.walletPubkey.toBase58(), solanaWallet.toBase58());
    assert.ok(typeof options.signMessageFn === 'function');
    assert.ok(typeof options.signSessionFn === 'function');
    assert.ok(typeof options.signTransactionFn === 'function');
    return { publicKey: solanaWallet };
  };

  try {
    const user = await createNordUserHelper(
      {},
      solanaWallet.toBase58(),
      evmPrivateKey
    );
    assert.ok(calledNew);
    assert.equal(user.publicKey.toBase58(), solanaWallet.toBase58());
  } finally {
    NordUser.new = originalNew;
  }
});
