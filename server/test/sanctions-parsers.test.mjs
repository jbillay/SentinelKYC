// S6 — pure parser unit tests for OFAC XML and UK HMT CSV parsers.
//
// Both parsers are pure: XML/CSV text → JS objects, no DB, no network.
// Fixtures live in server/test/fixtures/.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';

const __dir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const { iterEntries: iterOfac } = require('../services/sanctions/parsers/ofac_xml.js');
const { iterEntries: iterHmt } = require('../services/sanctions/parsers/uk_hmt_csv.js');

function fixture(name) {
  return readFileSync(join(__dir, 'fixtures', name), 'utf8');
}

// ─── OFAC XML parser ──────────────────────────────────────────────────────────

describe('ofac_xml: iterEntries', () => {
  it('yields the expected number of entries (skips no-name entity)', () => {
    const entries = [...iterOfac(fixture('ofac_sample.xml'))];
    expect(entries).toHaveLength(2);
  });

  it('individual entry has correct shape', () => {
    const [ind] = [...iterOfac(fixture('ofac_sample.xml'))];
    expect(ind.list_entry_id).toBe('1234');
    expect(ind.entry_type).toBe('individual');
    expect(ind.primary_name).toBe('John Boris Doe');
    expect(typeof ind.normalized_name).toBe('string');
    expect(ind.normalized_name.length).toBeGreaterThan(0);
  });

  it('individual entry carries dob, nationality and identifiers', () => {
    const [ind] = [...iterOfac(fixture('ofac_sample.xml'))];
    expect(ind.dob).toBe('1970-05-15');
    expect(ind.nationality).toEqual(['Russia']);
    expect(ind.identifiers).toEqual(expect.arrayContaining([
      { type: 'Passport', value: 'AA1234567' },
    ]));
  });

  it('individual entry carries an alias', () => {
    const [ind] = [...iterOfac(fixture('ofac_sample.xml'))];
    expect(ind.aliases).toHaveLength(1);
    expect(ind.aliases[0].name).toBe('Johnny Doe');
    expect(ind.aliases[0].type).toBe('a.k.a.');
  });

  it('individual entry carries programs', () => {
    const [ind] = [...iterOfac(fixture('ofac_sample.xml'))];
    expect(ind.programs).toEqual(['SDN_LIST']);
  });

  it('entity entry has correct shape', () => {
    const entries = [...iterOfac(fixture('ofac_sample.xml'))];
    const ent = entries[1];
    expect(ent.list_entry_id).toBe('5678');
    expect(ent.entry_type).toBe('entity');
    expect(ent.primary_name).toBe('Acme Corp Ltd');
    expect(ent.aliases).toHaveLength(0);
  });

  it('entity identifier (Registration Number) is extracted', () => {
    const entries = [...iterOfac(fixture('ofac_sample.xml'))];
    const ent = entries[1];
    expect(ent.identifiers).toEqual(expect.arrayContaining([
      { type: 'Registration Number', value: 'REG-9999' },
    ]));
  });

  it('raw field is included on each entry', () => {
    for (const e of iterOfac(fixture('ofac_sample.xml'))) {
      expect(e).toHaveProperty('raw');
    }
  });

  it('returns nothing for empty entity list', () => {
    const xml = `<?xml version="1.0"?><sanctionsData><entities></entities></sanctionsData>`;
    expect([...iterOfac(xml)]).toHaveLength(0);
  });

  it('skips entities with no name nodes', () => {
    const xml = `<?xml version="1.0"?><sanctionsData><entities>
      <entity id="X"><generalInfo><entityType>Individual</entityType></generalInfo></entity>
    </entities></sanctionsData>`;
    expect([...iterOfac(xml)]).toHaveLength(0);
  });

  it('handles entity with only alias names (promotes first alias to primary)', () => {
    const xml = `<?xml version="1.0"?><sanctionsData><entities>
      <entity id="999">
        <generalInfo><entityType>Individual</entityType></generalInfo>
        <names>
          <name>
            <isPrimary>false</isPrimary>
            <aliasType>a.k.a.</aliasType>
            <translations>
              <translation>
                <isPrimary>false</isPrimary>
                <script>Latin</script>
                <formattedFullName>Alias Only Person</formattedFullName>
              </translation>
            </translations>
          </name>
        </names>
      </entity>
    </entities></sanctionsData>`;
    const entries = [...iterOfac(xml)];
    expect(entries).toHaveLength(1);
    expect(entries[0].primary_name).toBe('Alias Only Person');
    expect(entries[0].aliases).toHaveLength(0);
  });

  it('entryType individual/entity/unknown maps correctly', () => {
    const xml = `<?xml version="1.0"?><sanctionsData><entities>
      <entity id="1"><generalInfo><entityType>Vessel</entityType></generalInfo>
        <names><name><isPrimary>true</isPrimary><translations>
          <translation><isPrimary>true</isPrimary><script>Latin</script>
            <formattedFullName>MV Enterprise</formattedFullName>
          </translation></translations></name></names>
      </entity>
    </entities></sanctionsData>`;
    const [e] = [...iterOfac(xml)];
    expect(e.entry_type).toBe('entity');
  });
});

// ─── UK HMT CSV parser ────────────────────────────────────────────────────────

describe('uk_hmt_csv: iterEntries', () => {
  it('yields the expected number of groups', () => {
    const entries = [...iterHmt(fixture('hmt_sample.csv'))];
    expect(entries).toHaveLength(2);
  });

  it('individual entry has correct shape', () => {
    const [ind] = [...iterHmt(fixture('hmt_sample.csv'))];
    expect(ind.list_entry_id).toBe('10001');
    expect(ind.entry_type).toBe('individual');
    expect(ind.primary_name).toMatch(/SMITH/);
    expect(typeof ind.normalized_name).toBe('string');
    expect(ind.normalized_name.length).toBeGreaterThan(0);
  });

  it('individual entry carries dob, nationality and passport', () => {
    const [ind] = [...iterHmt(fixture('hmt_sample.csv'))];
    expect(ind.dob).toBe('1975-03-20');
    expect(ind.nationality).toEqual(['British']);
    expect(ind.identifiers).toEqual(expect.arrayContaining([
      { type: 'passport', value: 'AB123456' },
    ]));
  });

  it('individual entry carries an alias', () => {
    const [ind] = [...iterHmt(fixture('hmt_sample.csv'))];
    expect(ind.aliases).toHaveLength(1);
    expect(ind.aliases[0].name).toMatch(/Johnny/);
  });

  it('individual entry carries programs', () => {
    const [ind] = [...iterHmt(fixture('hmt_sample.csv'))];
    expect(ind.programs).toEqual(['Russia']);
  });

  it('entity entry has correct shape', () => {
    const entries = [...iterHmt(fixture('hmt_sample.csv'))];
    const ent = entries[1];
    expect(ent.list_entry_id).toBe('10002');
    expect(ent.entry_type).toBe('entity');
    expect(ent.primary_name).toMatch(/ACME/);
  });

  it('raw field is included on each entry', () => {
    for (const e of iterHmt(fixture('hmt_sample.csv'))) {
      expect(e).toHaveProperty('raw');
    }
  });

  it('returns nothing for empty CSV', () => {
    const csv = 'Group ID,Alias Type,Group Type,Name 1\n';
    expect([...iterHmt(csv)]).toHaveLength(0);
  });

  it('throws when Group ID column is missing', () => {
    const csv = 'Col A,Col B\nval1,val2\n';
    expect(() => [...iterHmt(csv)]).toThrow(/Group ID/);
  });

  it('strips the OFSI banner row when present', () => {
    const csvText = fixture('hmt_sample.csv');
    const withBanner = `Last Updated,15/01/2026\n${csvText}`;
    const entries = [...iterHmt(withBanner)];
    expect(entries).toHaveLength(2);
  });

  it('skips rows with empty Group ID', () => {
    const csv = `Group ID,Alias Type,Group Type,Name 1,Name 2,Name 3,Name 4,Name 5,Name 6
,Primary name,Individual,NO,GROUP,ID,,,,
20001,Primary name,Individual,VALID,PERSON,,,,,
`;
    const entries = [...iterHmt(csv)];
    expect(entries).toHaveLength(1);
    expect(entries[0].list_entry_id).toBe('20001');
  });

  it('handles GroupID header variant', () => {
    const csv = `GroupID,AliasType,GroupType,Name1,Name2,Name3,Name4,Name5,Name6
30001,Primary name,Individual,ALT,HEADERS,,,,
`;
    const entries = [...iterHmt(csv)];
    expect(entries).toHaveLength(1);
    expect(entries[0].list_entry_id).toBe('30001');
  });
});
