import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_MAX_SNAPSHOTS = 100_000;

export class SnapshotStore {
  constructor(filePath, maxSnapshots = DEFAULT_MAX_SNAPSHOTS) {
    this.filePath = filePath;
    this.maxSnapshots = maxSnapshots;
    this.supabaseUrl = process.env.SUPABASE_URL;
    this.supabaseKey = process.env.SUPABASE_KEY;
    this.isSupabase = !!(this.supabaseUrl && this.supabaseKey);
  }

  async readAll() {
    if (this.isSupabase) {
      try {
        let allRows = [];
        let offset = 0;
        const limit = 1000;
        let hasMore = true;

        while (hasMore && allRows.length < this.maxSnapshots) {
          const chunkLimit = Math.min(limit, this.maxSnapshots - allRows.length);
          const url = `${this.supabaseUrl}/rest/v1/hype_snapshots?select=data&order=timestamp.desc&limit=${chunkLimit}&offset=${offset}`;
          const response = await fetch(url, {
            method: 'GET',
            headers: {
              'apikey': this.supabaseKey,
              'Authorization': `Bearer ${this.supabaseKey}`
            }
          });
          if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Supabase read failed at offset ${offset}: ${response.status} ${response.statusText} - ${errText}`);
          }
          const rows = await response.json();
          if (rows.length === 0) {
            hasMore = false;
          } else {
            allRows = allRows.concat(rows);
            offset += rows.length;
            if (rows.length < chunkLimit) {
              hasMore = false;
            }
          }
        }
        // Extracted objects are in descending order from DB. Reverse them to restore ascending order.
        return allRows.map(r => r.data).reverse();
      } catch (error) {
        console.error('Error reading from Supabase, returning empty array:', error);
        return [];
      }
    }

    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (error.code === 'ENOENT') {
        return [];
      }

      throw error;
    }
  }

  async append(snapshot) {
    if (this.isSupabase) {
      try {
        const url = `${this.supabaseUrl}/rest/v1/hype_snapshots`;
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'apikey': this.supabaseKey,
            'Authorization': `Bearer ${this.supabaseKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates'
          },
          body: JSON.stringify({
            timestamp: snapshot.timestamp,
            data: snapshot
          })
        });
        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Supabase write failed: ${response.status} ${response.statusText} - ${errText}`);
        }
        return await this.readAll();
      } catch (error) {
        console.error('Error appending to Supabase:', error);
        return await this.readAll();
      }
    }

    const snapshots = await this.readAll();
    snapshots.push(snapshot);
    const trimmed = snapshots.slice(-this.maxSnapshots);
    await this.writeAll(trimmed);
    return trimmed;
  }

  async writeAll(snapshots) {
    if (this.isSupabase) {
      // Direct bulk writing to Supabase is not strictly needed for minute increments, 
      // but if we ever need it, we can upsert all rows.
      console.warn('writeAll not implemented/needed for Supabase mode (append is used directly).');
      return;
    }

    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true });

    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(snapshots, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, this.filePath);
  }
}

export class AlertsStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.supabaseUrl = process.env.SUPABASE_URL;
    this.supabaseKey = process.env.SUPABASE_KEY;
    this.isSupabase = !!(this.supabaseUrl && this.supabaseKey);
  }

  async readAll() {
    if (this.isSupabase) {
      try {
        const url = `${this.supabaseUrl}/rest/v1/hype_alerts?select=*&order=created_at.desc`;
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'apikey': this.supabaseKey,
            'Authorization': `Bearer ${this.supabaseKey}`
          }
        });
        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Supabase read alerts failed: ${response.status} - ${errText}`);
        }
        return await response.json();
      } catch (error) {
        console.error('Error reading alerts from Supabase, returning empty array:', error);
        return [];
      }
    }

    try {
      const raw = await readFile(this.filePath, 'utf8');
      return JSON.parse(raw);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async save(alert) {
    if (this.isSupabase) {
      try {
        const url = `${this.supabaseUrl}/rest/v1/hype_alerts`;
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'apikey': this.supabaseKey,
            'Authorization': `Bearer ${this.supabaseKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates'
          },
          body: JSON.stringify(alert)
        });
        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Supabase save alert failed: ${response.status} - ${errText}`);
        }
        return true;
      } catch (error) {
        console.error('Error saving alert to Supabase:', error);
        return false;
      }
    }

    const alerts = await this.readAll();
    const existingIndex = alerts.findIndex(a => a.id === alert.id);
    if (existingIndex !== -1) {
      alerts[existingIndex] = alert;
    } else {
      alerts.push(alert);
    }
    await this.writeAll(alerts);
    return true;
  }

  async delete(id) {
    if (this.isSupabase) {
      try {
        const url = `${this.supabaseUrl}/rest/v1/hype_alerts?id=eq.${id}`;
        const response = await fetch(url, {
          method: 'DELETE',
          headers: {
            'apikey': this.supabaseKey,
            'Authorization': `Bearer ${this.supabaseKey}`
          }
        });
        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Supabase delete alert failed: ${response.status} - ${errText}`);
        }
        return true;
      } catch (error) {
        console.error('Error deleting alert from Supabase:', error);
        return false;
      }
    }

    const alerts = await this.readAll();
    const filtered = alerts.filter(a => a.id !== id);
    await this.writeAll(filtered);
    return true;
  }

  async writeAll(alerts) {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(alerts, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, this.filePath);
  }
}

export class ConfigStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.supabaseUrl = process.env.SUPABASE_URL;
    this.supabaseKey = process.env.SUPABASE_KEY;
    this.isSupabase = !!(this.supabaseUrl && this.supabaseKey);
  }

  async get(key) {
    if (this.isSupabase) {
      try {
        const url = `${this.supabaseUrl}/rest/v1/hype_config?key=eq.${key}&select=value`;
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'apikey': this.supabaseKey,
            'Authorization': `Bearer ${this.supabaseKey}`
          }
        });
        if (!response.ok) {
          if (response.status === 404) return null;
          throw new Error(`Supabase get config failed: ${response.status}`);
        }
        const data = await response.json();
        return data[0]?.value ?? null;
      } catch (error) {
        console.error(`Error reading config ${key} from Supabase:`, error);
        return null;
      }
    }

    try {
      const raw = await readFile(this.filePath, 'utf8');
      const data = JSON.parse(raw);
      return data[key] ?? null;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async set(key, value) {
    if (this.isSupabase) {
      try {
        const url = `${this.supabaseUrl}/rest/v1/hype_config`;
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'apikey': this.supabaseKey,
            'Authorization': `Bearer ${this.supabaseKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates'
          },
          body: JSON.stringify({ key, value })
        });
        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Supabase set config failed: ${response.status} - ${errText}`);
        }
        return true;
      } catch (error) {
        console.error(`Error writing config ${key} to Supabase:`, error);
        return false;
      }
    }

    try {
      let data = {};
      try {
        const raw = await readFile(this.filePath, 'utf8');
        data = JSON.parse(raw);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      data[key] = value;
      const directory = path.dirname(this.filePath);
      await mkdir(directory, { recursive: true });
      await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf8');
      return true;
    } catch (error) {
      console.error('Error writing config locally:', error);
      return false;
    }
  }
}
