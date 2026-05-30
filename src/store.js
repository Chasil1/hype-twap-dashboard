import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_MAX_SNAPSHOTS = 7 * 24 * 60;

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
        const url = `${this.supabaseUrl}/rest/v1/hype_snapshots?select=data&order=timestamp.desc&limit=${this.maxSnapshots}`;
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'apikey': this.supabaseKey,
            'Authorization': `Bearer ${this.supabaseKey}`
          }
        });
        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Supabase read failed: ${response.status} ${response.statusText} - ${errText}`);
        }
        const rows = await response.json();
        // Extracted objects are in descending order from DB. Reverse them to restore ascending order.
        return rows.map(r => r.data).reverse();
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
