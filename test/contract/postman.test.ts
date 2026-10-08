import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const dir = join(process.cwd(), 'postman');
const COLLECTION = 'unified-service-scheduler.postman_collection.json';
const ENVIRONMENTS = ['local.postman_environment.json', 'docker-compose.postman_environment.json'];

interface RequestItem {
  name: string;
  request?: { method: string; url?: { raw?: string }; body?: { raw?: string } };
  item?: RequestItem[];
  event?: { listen: string; script?: { exec?: string[] } }[];
}

function readJson(file: string): { [k: string]: unknown } {
  return JSON.parse(readFileSync(join(dir, file), 'utf8')) as { [k: string]: unknown };
}

function collectRequests(items: RequestItem[], out: RequestItem[] = []): RequestItem[] {
  for (const item of items) {
    if (item.request) out.push(item);
    if (item.item) collectRequests(item.item, out);
  }
  return out;
}

function tokens(text: string): string[] {
  return Array.from(text.matchAll(/\{\{([^}]+)\}\}/g), (m) => m[1] as string);
}

const collection = readJson(COLLECTION) as {
  variable?: { key: string }[];
  item?: RequestItem[];
};
const requests = collectRequests(collection.item ?? []);

describe('postman collection', () => {
  it('is valid JSON with the expected requests', () => {
    const names = requests.map((r) => r.name);

    expect(names).toContain('Search slots  (stores the picked slot)');
    expect(names).toContain('Book appointment  (201 HELD)');
    expect(names).toContain('Book the SAME slot again  (409 slot_taken)');
    expect(names).toContain('Confirm appointment  (HELD -> CONFIRMED)');
    expect(names).toContain('Cancel appointment  (-> CANCELLED)');
    expect(names).toContain('Technician calendar');
    expect(names).toContain('Dealership capacity');
    expect(requests.length).toBeGreaterThanOrEqual(13);
  });

  it.each(ENVIRONMENTS)('environment %s is valid JSON with a baseUrl', (file) => {
    const env = readJson(file) as { values?: { key: string; value: string }[] };
    const values = env.values ?? [];

    expect(values.some((v) => v.key === 'baseUrl' && v.value.length > 0)).toBe(true);
  });

  it('only references variables defined in the collection or an environment (or a $dynamic var)', () => {
    const defined = new Set<string>([
      ...(collection.variable ?? []).map((v) => v.key),
      ...(readJson(ENVIRONMENTS[0]) as { values?: { key: string }[] }).values?.map((v) => v.key) ?? [],
    ]);

    const referenced = new Set<string>();
    for (const request of requests) {
      for (const text of [request.request?.url?.raw ?? '', request.request?.body?.raw ?? '']) {
        for (const token of tokens(text)) referenced.add(token);
      }
    }

    const undefinedTokens = [...referenced].filter((t) => !t.startsWith('$') && !defined.has(t));
    expect(undefinedTokens).toEqual([]);
  });

  it('every request asserts something', () => {
    for (const request of requests) {
      const testScript = request.event?.find((e) => e.listen === 'test');
      const exec = testScript?.script?.exec?.join('\n') ?? '';
      expect(exec, `request "${request.name}" has no pm.test assertion`).toContain('pm.test(');
    }
  });
});
