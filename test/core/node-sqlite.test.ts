import { DatabaseSync } from 'node:sqlite';

// Core index tests rely on node:sqlite having FTS5 with the tokenizer from design.md, Decision 5.
describe('node:sqlite', () => {
  it('supports fts5 virtual tables', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(
      `CREATE VIRTUAL TABLE search USING fts5(title, body, tokenize="unicode61 remove_diacritics 2")`,
    );
    db.prepare('INSERT INTO search (title, body) VALUES (?, ?)').run('Café notes', 'Some body text');

    const rows = db.prepare(`SELECT title FROM search WHERE search MATCH 'cafe*'`).all();
    db.close();

    expect(rows).toEqual([{ title: 'Café notes' }]);
  });
});
