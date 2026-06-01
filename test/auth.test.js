import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

// Copy parser and session verification helpers from server.js to test them cryptographically
function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    list[parts.shift().trim()] = decodeURIComponent(parts.join('='));
  });
  return list;
}

function getSessionUser(cookieHeader, botToken) {
  if (!botToken) return null;
  try {
    const cookies = parseCookies(cookieHeader);
    const sessionVal = cookies['tg_session'];
    if (!sessionVal) return null;

    const raw = Buffer.from(sessionVal, 'base64').toString('utf8');
    const { sessionData, signature } = JSON.parse(raw);

    const expectedSignature = crypto
      .createHmac('sha256', botToken)
      .update(sessionData)
      .digest('hex');

    if (signature !== expectedSignature) {
      return null;
    }

    const user = JSON.parse(sessionData);
    return user;
  } catch (err) {
    return null;
  }
}

function verifyTelegramAuth(authData, botToken) {
  const { hash, ...data } = authData;
  const dataCheckArr = [];
  
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && value !== null) {
      dataCheckArr.push(`${key}=${value}`);
    }
  }
  
  dataCheckArr.sort();
  const dataCheckString = dataCheckArr.join('\n');

  const secretKey = crypto.createHash('sha256').update(botToken).digest();
  const computedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  if (computedHash !== hash) {
    return false;
  }

  const age = Math.floor(Date.now() / 1000) - Number(authData.auth_date);
  if (age > 30 * 86400) {
    return false;
  }

  return true;
}

test('Telegram Auth Verification: authenticates valid signature correctly', () => {
  const botToken = '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11';
  
  const authData = {
    id: 987654321,
    first_name: 'John',
    last_name: 'Doe',
    username: 'johndoe',
    photo_url: 'https://t.me/i/userpic/johndoe.jpg',
    auth_date: Math.floor(Date.now() / 1000) - 10 // 10 seconds ago
  };

  // Compute the expected hash using Telegram specification
  const { hash, ...data } = authData;
  const checkArr = Object.entries(data).map(([k, v]) => `${k}=${v}`).sort();
  const checkStr = checkArr.join('\n');
  const secretKey = crypto.createHash('sha256').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(checkStr).digest('hex');

  authData.hash = computedHash;

  // Assert validation passes
  assert.equal(verifyTelegramAuth(authData, botToken), true);

  // Assert validation fails if bot token is incorrect
  assert.equal(verifyTelegramAuth(authData, 'wrong_token'), false);

  // Assert validation fails if data is tampered with
  const tamperedData = { ...authData, username: 'attacker' };
  assert.equal(verifyTelegramAuth(tamperedData, botToken), false);

  // Assert validation fails if auth date is older than 30 days
  const oldData = { ...authData, auth_date: Math.floor(Date.now() / 1000) - 31 * 86400 };
  const oldCheckArr = Object.entries(oldData).filter(([k]) => k !== 'hash').map(([k, v]) => `${k}=${v}`).sort().join('\n');
  oldData.hash = crypto.createHmac('sha256', secretKey).update(oldCheckArr).digest('hex');
  assert.equal(verifyTelegramAuth(oldData, botToken), false);
});

test('Cookie Sessions: signs, parses, and validates session cookie successfully', () => {
  const botToken = 'my_secure_bot_token_secret';
  
  const user = {
    id: 12345,
    username: 'testuser',
    first_name: 'Test'
  };

  // Sign session
  const sessionData = JSON.stringify(user);
  const signature = crypto.createHmac('sha256', botToken).update(sessionData).digest('hex');
  const cookieValue = Buffer.from(JSON.stringify({ sessionData, signature })).toString('base64');
  const cookieHeader = `tg_session=${cookieValue}; Path=/; HttpOnly`;

  // Parse and verify
  const authenticatedUser = getSessionUser(cookieHeader, botToken);
  assert.notEqual(authenticatedUser, null);
  assert.equal(authenticatedUser.id, 12345);
  assert.equal(authenticatedUser.username, 'testuser');

  // Verify failure on tampered cookie signature
  const rawDecoded = JSON.parse(Buffer.from(cookieValue, 'base64').toString('utf8'));
  rawDecoded.signature = 'tampered_signature_value';
  const tamperedValue = Buffer.from(JSON.stringify(rawDecoded)).toString('base64');
  const badCookieHeader = `tg_session=${tamperedValue}; Path=/; HttpOnly`;
  assert.equal(getSessionUser(badCookieHeader, botToken), null);

  // Verify failure on wrong bot token signature verification
  assert.equal(getSessionUser(cookieHeader, 'different_token'), null);
});
