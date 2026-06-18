export async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    if (!response.ok) {
      let errText = '';
      try {
        errText = await response.text();
      } catch (_) {}
      throw new Error(`HTTP ${response.status} ${response.statusText}${errText ? ' - ' + errText : ''}`);
    }
    const data = await response.json();
    return data;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchTextWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    if (!response.ok) {
      let errText = '';
      try {
        errText = await response.text();
      } catch (_) {}
      throw new Error(`HTTP ${response.status} ${response.statusText}${errText ? ' - ' + errText : ''}`);
    }
    const data = await response.text();
    return data;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchVoidWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    if (!response.ok) {
      let errText = '';
      try {
        errText = await response.text();
      } catch (_) {}
      throw new Error(`HTTP ${response.status} ${response.statusText}${errText ? ' - ' + errText : ''}`);
    }
    // consume body stream
    await response.text();
    return true;
  } finally {
    clearTimeout(timeoutId);
  }
}
